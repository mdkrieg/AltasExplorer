'use strict';

/**
 * clipboardWatcher.js — main-process OS clipboard change watcher.
 *
 * Provides a focus-independent, event-driven view of the operating-system
 * clipboard so the renderer's status footer stays accurate even while the app
 * is unfocused or running headless (a future tray/background mode), and so
 * remote/guest clipboards (RDP / VMware) are picked up the moment they sync.
 *
 * Backends implement a common interface and are interchangeable via the
 * createClipboardWatcher() factory:
 *
 *   PowerShellClipboardWatcher — one long-lived powershell.exe that registers
 *     AddClipboardFormatListener on a hidden window and streams change events.
 *     Ships now, no compiled dependency. (Windows only.)
 *
 *   NativeAddonClipboardWatcher — experimental prototype using the optional
 *     `clipboard-event` native addon as the change trigger. Not enabled by
 *     default; included to validate that the abstraction can host a native
 *     backend later with zero changes to callers.
 *
 * Normalized event payload (emitted as the 'change' event):
 *   { type: 'files'|'image'|'text'|'empty', data?: string[]|string, seq?: number }
 */

const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const { EventEmitter } = require('events');

let logger;
try { logger = require('./logger'); } catch (_) {
	logger = { info() {}, warn() {}, error() {}, debug() {} };
}

const EMPTY_PAYLOAD = Object.freeze({ type: 'empty' });

/**
 * Normalize a raw payload from a backend into the canonical shape callers
 * expect. Guards against single-element file arrays collapsing to a string and
 * other backend quirks.
 *
 * @param {any} raw
 * @returns {{type:string, data?:any, seq?:number}}
 */
function normalizePayload(raw) {
	if (!raw || typeof raw !== 'object' || !raw.type) return { ...EMPTY_PAYLOAD };
	const out = { type: raw.type };
	if (typeof raw.seq === 'number') out.seq = raw.seq;
	if (raw.type === 'files') {
		const data = Array.isArray(raw.data) ? raw.data : (raw.data != null ? [raw.data] : []);
		const cleaned = data.map(p => String(p)).filter(Boolean);
		if (cleaned.length === 0) return { type: 'empty', ...(out.seq != null ? { seq: out.seq } : {}) };
		out.data = cleaned;
	} else if (raw.type === 'image' || raw.type === 'text') {
		if (raw.data == null || raw.data === '') {
			return { type: 'empty', ...(out.seq != null ? { seq: out.seq } : {}) };
		}
		out.data = raw.data;
	}
	return out;
}

/**
 * Base class: shared event-emitter plumbing and last-known cache.
 */
class ClipboardWatcher extends EventEmitter {
	constructor() {
		super();
		this._last = { ...EMPTY_PAYLOAD };
		this._started = false;
	}

	/** The most recently observed clipboard payload (synchronous). */
	get last() { return this._last; }

	/**
	 * Resolve the most recently observed clipboard payload. Backends that cache
	 * change events (the default) resolve immediately, which lets the paste path
	 * avoid spawning a fresh reader.
	 * @returns {Promise<{type:string, data?:any, seq?:number}>}
	 */
	async readNow() { return this._last; }

	/** Record + emit a normalized change if it differs from the last one. */
	_emitChange(raw) {
		const payload = normalizePayload(raw);
		// Windows fires WM_CLIPBOARDUPDATE multiple times per change; the OS
		// sequence number is identical for the same content, so skip duplicates.
		if (payload.seq != null && this._last && this._last.seq === payload.seq) {
			return;
		}
		this._last = payload;
		this.emit('change', payload);
	}

	// Subclasses override:
	start() { throw new Error('not implemented'); }
	stop() { throw new Error('not implemented'); }
	get isAvailable() { return false; }
}

/**
 * Persistent PowerShell backend (Windows). Spawns clipboard-watcher.ps1 once
 * and consumes its newline-delimited JSON change events.
 */
class PowerShellClipboardWatcher extends ClipboardWatcher {
	constructor(options = {}) {
		super();
		this._scriptPath = options.scriptPath || path.join(__dirname, 'clipboard-watcher.ps1');
		this._proc = null;
		this._rl = null;
		this._restartTimer = null;
		this._restarts = 0;
		this._stopping = false;
		this._maxRestarts = options.maxRestarts != null ? options.maxRestarts : 5;
	}

	get isAvailable() { return process.platform === 'win32'; }

	start() {
		if (this._started || !this.isAvailable) return;
		this._started = true;
		this._stopping = false;
		this._spawn();
	}

	_spawn() {
		try {
			this._proc = spawn('powershell', [
				'-NoProfile', '-NonInteractive', '-Sta',
				'-ExecutionPolicy', 'Bypass',
				'-File', this._scriptPath
			], { windowsHide: true });
		} catch (err) {
			logger.warn('[ClipboardWatcher] spawn failed:', err.message);
			this._scheduleRestart();
			return;
		}

		this._rl = readline.createInterface({ input: this._proc.stdout });
		this._rl.on('line', (line) => {
			const trimmed = line && line.trim();
			if (!trimmed) return;
			let obj;
			try { obj = JSON.parse(trimmed); } catch (_) { return; }
			if (obj && obj.event === 'change') {
				this._restarts = 0; // healthy output resets the backoff
				this._emitChange(obj);
			}
		});

		if (this._proc.stderr) {
			this._proc.stderr.on('data', (buf) => {
				const msg = buf.toString().trim();
				if (msg) logger.warn('[ClipboardWatcher] ps stderr:', msg);
			});
		}

		this._proc.on('error', (err) => {
			logger.warn('[ClipboardWatcher] process error:', err.message);
		});

		this._proc.on('exit', (code, signal) => {
			this._cleanupProc();
			if (this._stopping) return;
			logger.warn(`[ClipboardWatcher] exited (code=${code}, signal=${signal}); will restart`);
			this._scheduleRestart();
		});
	}

	_scheduleRestart() {
		if (this._stopping) return;
		if (this._restarts >= this._maxRestarts) {
			logger.error('[ClipboardWatcher] giving up after repeated failures; falling back to focus poll');
			this.emit('unavailable');
			return;
		}
		const delay = Math.min(1000 * Math.pow(2, this._restarts), 15000);
		this._restarts++;
		this._restartTimer = setTimeout(() => { if (!this._stopping) this._spawn(); }, delay);
	}

	_cleanupProc() {
		if (this._rl) { try { this._rl.close(); } catch (_) {} this._rl = null; }
		this._proc = null;
	}

	stop() {
		this._stopping = true;
		this._started = false;
		if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
		if (this._rl) { try { this._rl.close(); } catch (_) {} this._rl = null; }
		if (this._proc) {
			try { this._proc.kill(); } catch (_) {}
			this._proc = null;
		}
	}
}

/**
 * Experimental native-addon backend. Uses the optional `clipboard-event` module
 * (if installed) purely as a change trigger, then reads the actual contents via
 * the provided reader. Disabled unless explicitly selected; kept thin to prove
 * the abstraction can host an in-process native backend later.
 */
class NativeAddonClipboardWatcher extends ClipboardWatcher {
	/**
	 * @param {object} options
	 * @param {() => Promise<object>} options.reader  reads current clipboard contents
	 */
	constructor(options = {}) {
		super();
		this._reader = typeof options.reader === 'function' ? options.reader : null;
		this._mod = null;
		try { this._mod = require('clipboard-event'); } catch (_) { this._mod = null; }
		this._onChange = () => this._readAndEmit();
	}

	get isAvailable() { return !!this._mod && !!this._reader; }

	async _readAndEmit() {
		try {
			const raw = await this._reader();
			this._emitChange(raw);
		} catch (err) {
			logger.warn('[ClipboardWatcher:native] read failed:', err.message);
		}
	}

	start() {
		if (this._started || !this.isAvailable) return;
		this._started = true;
		this._mod.startListening();
		this._mod.on('change', this._onChange);
		this._readAndEmit(); // seed
	}

	stop() {
		this._started = false;
		if (this._mod) {
			try { this._mod.off('change', this._onChange); } catch (_) {}
			try { this._mod.stopListening(); } catch (_) {}
		}
	}
}

/**
 * No-op backend used on unsupported platforms so callers don't branch.
 */
class NullClipboardWatcher extends ClipboardWatcher {
	get isAvailable() { return false; }
	start() {}
	stop() {}
}

/**
 * Create the appropriate clipboard watcher.
 *
 * @param {object} [options]
 * @param {'powershell'|'native'|'auto'} [options.backend='auto']
 * @param {() => Promise<object>} [options.reader]  contents reader (native backend)
 * @param {string} [options.scriptPath]             override ps1 path (powershell)
 * @returns {ClipboardWatcher}
 */
function createClipboardWatcher(options = {}) {
	const backend = options.backend || process.env.ATLAS_CLIPBOARD_BACKEND || 'auto';

	if (backend === 'native') {
		const w = new NativeAddonClipboardWatcher(options);
		if (w.isAvailable) return w;
		logger.warn('[ClipboardWatcher] native backend unavailable; using powershell');
	}

	if (process.platform === 'win32') {
		return new PowerShellClipboardWatcher(options);
	}

	logger.info('[ClipboardWatcher] no OS watcher for this platform; using null backend');
	return new NullClipboardWatcher();
}

module.exports = {
	createClipboardWatcher,
	ClipboardWatcher,
	PowerShellClipboardWatcher,
	NativeAddonClipboardWatcher,
	NullClipboardWatcher,
	normalizePayload,
};
