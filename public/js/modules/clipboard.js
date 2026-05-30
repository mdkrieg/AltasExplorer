/**
 * clipboard.js — Internal and external clipboard operations for file grids.
 *
 * Internal clipboard: cut/copy items between panels within the app.
 * External clipboard: paste files, images, or plain text from the OS.
 *
 * Does NOT write to the OS clipboard for internal operations (paths are
 * tracked in module state only).
 */

import { promptCollisionChoice } from './dragdrop.js';
import { getPanelViewType, activePanelId as _activePanelId } from './panels.js';
import { w2utils } from './vendor/w2ui.es6.min.js';

// ---------------------------------------------------------------------------
// Path normalization (no Node path module available in renderer)
// ---------------------------------------------------------------------------

function normalizePath(p) {
	if (!p) return '';
	let out = String(p).replace(/[\\/]+$/, '');
	if (/^[a-zA-Z]:/.test(out)) out = out.charAt(0).toLowerCase() + out.slice(1);
	return out;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * @type {{ type: null|'copy'|'cut', items: Array<{path:string,filename:string,isFolder:boolean}> }}
 */
export const clipboardState = {
	type: null,
	items: [],
};

// Store pending paste-modal data so modal save handlers can access it.
let _pasteTextData = { text: '', targetDir: '', panelId: null };
let _pasteImageData = { base64: '', targetDir: '', panelId: null };

// Human-readable description of an OS-only clipboard (set by the focus-sync
// listener, cleared on new app copy/cut or when paste consumes it).
let _osClipboardHint = '';

// Guard so initClipboardFocusSync attaches exactly one listener.
let _focusSyncInitialised = false;

// ---------------------------------------------------------------------------
// Footer helpers
// ---------------------------------------------------------------------------

/**
 * Returns a short human-readable description of the current clipboard state,
 * e.g. "Copied: report.pdf" or "Cut: img.png (+2 others)".
 */
export function getClipboardFooterText(panelId = null) {
	// Only the currently focused (destination) panel shows the text.
	if (panelId != null && panelId !== _activePanelId) return '';
	if (!clipboardState.type || clipboardState.items.length === 0) return _osClipboardHint;
	const verb = clipboardState.type === 'cut' ? 'Cut' : 'Copied';
	const first = clipboardState.items[0].filename;
	const extra = clipboardState.items.length > 1 ? ` (+${clipboardState.items.length - 1} others)` : '';
	return `${verb}: ${first}${extra}`;
}

/**
 * Write the current clipboard status text into the footer of the given panel.
 * Works for both grid (w2ui footer) and gallery (our custom footer).
 * Uses setTimeout(0) so the DOM is ready after w2ui rebuilds.
 *
 * @param {number|null} panelId
 */
export function updateClipboardFooter(panelId) {
	if (panelId == null) return;
	const text = getClipboardFooterText(panelId);
	setTimeout(() => {
		const viewType = getPanelViewType(panelId);
		if (viewType === 'grid') {
			const el = document.querySelector(`#grid_grid-panel-${panelId}_footer .w2ui-footer-left`);
			if (el) el.textContent = text;
		} else if (viewType === 'gallery') {
			const el = document.querySelector(`#panel-${panelId} .gallery-footer-left`);
			if (el) el.textContent = text;
		}
	}, 0);
}

// ---------------------------------------------------------------------------
// Set / clear clipboard
// ---------------------------------------------------------------------------

/**
 * Set the clipboard to 'copy' or 'cut' with the given grid records.
 *
 * @param {'copy'|'cut'} type
 * @param {object[]} records  w2ui grid records (must have .path, .filename, .isFolder)
 * @param {number} focusedPanelId
 * @param {object} panelState  module-scoped panel state map
 */
export function setClipboard(type, records, focusedPanelId, panelState) {
	// First clear any previous clipboard styling.
	_stripClipboardClasses(panelState);

	clipboardState.type = type;
	clipboardState.items = records.map(r => ({
		path: r.path,
		filename: r.filenameRaw || r.filename,
		isFolder: !!r.isFolder,
	}));

	// A new app copy/cut supersedes any OS-only hint.
	_osClipboardHint = '';

	// Apply row CSS class across all panels that currently show these paths.
	const cssClass = type === 'cut' ? 'item-cut' : 'item-copied';
	const pathSet = new Set(clipboardState.items.map(i => i.path));
	_applyClassToMatchingRows(pathSet, cssClass, panelState);

	// Write paths to the OS clipboard (async, fire-and-forget) so external
	// apps like Explorer can paste files after a Ctrl+C/X inside the app.
	window.electronAPI.setFileClipboard(clipboardState.items.map(i => i.path)).catch(() => {});

	updateClipboardFooter(focusedPanelId);
}

/**
 * Clear the clipboard state and remove all row styling.
 *
 * @param {object} panelState
 */
export function clearClipboard(panelState, hintText = '') {
	_stripClipboardClasses(panelState);
	clipboardState.type = null;
	clipboardState.items = [];
	_osClipboardHint = hintText;
	// Update footer for all visible panels.
	for (let id = 1; id <= 4; id++) {
		if (panelState[id]) updateClipboardFooter(id);
	}
}

// ---------------------------------------------------------------------------
// Row styling helpers
// ---------------------------------------------------------------------------

function _applyClassToMatchingRows(pathSet, cssClass, panelState) {
	for (const state of Object.values(panelState || {})) {
		const grid = state.w2uiGrid;
		if (!grid || !Array.isArray(grid.records)) continue;
		for (const rec of grid.records) {
			if (pathSet.has(rec.path)) {
				if (!rec.w2ui) rec.w2ui = {};
				// Append without replacing other classes (e.g. auto-label classes).
				const existing = (rec.w2ui.class || '').split(' ').filter(c => c && c !== 'item-cut' && c !== 'item-copied');
				existing.push(cssClass);
				rec.w2ui.class = existing.join(' ');
				grid.refreshRow(rec.recid);
			}
		}
		// Gallery tiles use CSS class on the DOM element directly.
		if (state.galleryRecords) {
			const panelEl = state.w2uiGrid
				? document.getElementById(`panel-${_panelIdForState(state, panelState)}`)
				: null;
			if (panelEl) {
				for (const rec of state.galleryRecords) {
					if (pathSet.has(rec.path)) {
						const tile = panelEl.querySelector(`.gallery-item[data-recid="${rec.recid}"]`);
						if (tile) {
							tile.classList.remove('item-cut', 'item-copied');
							tile.classList.add(cssClass);
						}
					}
				}
			}
		}
	}
}

function _stripClipboardClasses(panelState) {
	const previousPaths = new Set(clipboardState.items.map(i => i.path));
	if (previousPaths.size === 0) return;
	for (const state of Object.values(panelState || {})) {
		const grid = state.w2uiGrid;
		if (grid && Array.isArray(grid.records)) {
			let changed = false;
			for (const rec of grid.records) {
				if (previousPaths.has(rec.path) && rec.w2ui) {
					const updated = (rec.w2ui.class || '').split(' ').filter(c => c !== 'item-cut' && c !== 'item-copied').join(' ');
					if (updated !== rec.w2ui.class) {
						rec.w2ui.class = updated;
						grid.refreshRow(rec.recid);
						changed = true;
					}
				}
			}
		}
		// Gallery tiles
		if (state.galleryRecords) {
			for (const rec of state.galleryRecords) {
				if (previousPaths.has(rec.path)) {
					const tile = document.querySelector(`.gallery-item[data-recid="${rec.recid}"]`);
					if (tile) tile.classList.remove('item-cut', 'item-copied');
				}
			}
		}
	}
}

/** Reverse-lookup panelId from state object. */
function _panelIdForState(targetState, panelState) {
	for (const [id, state] of Object.entries(panelState || {})) {
		if (state === targetState) return id;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Perform paste (internal)
// ---------------------------------------------------------------------------

/**
 * Execute the paste: copy or move clipboard items into targetDir.
 *
 * @param {string} targetDir
 * @param {number} activePanelId
 * @param {object} panelState
 * @param {Function} navigateToDirectory
 */
export async function performPaste(targetDir, activePanelId, panelState, navigateToDirectory) {
	if (!clipboardState.items.length) return;

	const isCopy = clipboardState.type === 'copy';
	const items = clipboardState.items.map(i => ({ path: i.path, filename: i.filename, isFolder: i.isFolder }));

	// Pre-flight collision check.
	let collisions = [];
	try {
		const result = await window.electronAPI.checkCollisions(items, targetDir);
		collisions = Array.isArray(result?.collisions) ? result.collisions : [];
	} catch (_) { /* non-fatal */ }

	let onCollision = 'fail';
	if (collisions.length > 0) {
		const choice = await promptCollisionChoice(collisions, isCopy);
		if (choice === 'cancel' || !choice) return;
		onCollision = choice;
	}

	let result;
	try {
		result = isCopy
			? await window.electronAPI.copyItems(items, targetDir, onCollision)
			: await window.electronAPI.moveItems(items, targetDir, onCollision);
	} catch (err) {
		w2utils.notify(`Error pasting: ${err?.message || 'Unknown error'}`, { error: true, timeout: 3000 });
		return;
	}

	if (Array.isArray(result?.failed) && result.failed.length > 0) {
		const msgs = result.failed.map(f => `${f.path}: ${f.error}`).join('\n');
		w2utils.notify(`Paste failed for ${result.failed.length} item(s)`, { error: true, timeout: 4000 });
		console.error('Paste failures:', msgs);
	}

	// After a cut-paste, clear the clipboard.
	if (!isCopy) {
		clearClipboard(panelState);
	}

	// Refresh panels that show source or destination directories.
	const affected = new Set();
	affected.add(normalizePath(targetDir));
	for (const it of items) {
		const parent = it.path.replace(/[/\\][^/\\]+$/, '');
		if (parent) affected.add(normalizePath(parent));
	}
	const ids = Object.keys(panelState || {});
	for (const id of ids) {
		const cp = panelState[id]?.currentPath;
		if (!cp) continue;
		try {
			if (affected.has(normalizePath(cp))) {
				await navigateToDirectory(cp, parseInt(id), false);
			}
		} catch (_) { /* ignore */ }
	}
}

// ---------------------------------------------------------------------------
// External paste
// ---------------------------------------------------------------------------

/**
 * Unified paste entry-point. Reads the OS clipboard once, then routes:
 *   - OS files matching internal state  → performPaste (honours cut/copy semantics)
 *   - OS files differing from internal  → external file copy
 *   - OS image or text                  → modal
 *   - OS empty + internal has items     → performPaste (race-condition fallback)
 *   - Both empty                        → "Nothing to paste" toast
 *
 * @param {string} targetDir
 * @param {number} activePanelId
 * @param {object} panelState
 * @param {Function} navigateToDirectory
 */
export async function pasteFromAnywhere(targetDir, activePanelId, panelState, navigateToDirectory) {
	let clip = null;
	try { clip = await window.electronAPI.readSystemClipboard(); } catch (_) {}

	if (clip && clip.type === 'files' && Array.isArray(clip.data) && clip.data.length > 0) {
		// If the OS clipboard holds the same paths we wrote on cut/copy, honour
		// the internal cut vs copy distinction.
		if (clipboardState.items.length > 0) {
			const osNorm = clip.data.map(normalizePath).sort();
			const intNorm = clipboardState.items.map(i => normalizePath(i.path)).sort();
			const match = osNorm.length === intNorm.length && osNorm.every((p, idx) => p === intNorm[idx]);
			if (match) return await performPaste(targetDir, activePanelId, panelState, navigateToDirectory);
		}
		// Different files in OS clipboard (e.g. copied from Explorer) — treat as external.
		return await handleExternalPaste(targetDir, activePanelId, panelState, navigateToDirectory, clip);
	}

	if (clip && (clip.type === 'image' || clip.type === 'text')) {
		return await handleExternalPaste(targetDir, activePanelId, panelState, navigateToDirectory, clip);
	}

	// OS clipboard empty/unreadable — fall back to internal state in case the
	// async PowerShell write from setClipboard hasn't landed yet.
	if (clipboardState.items.length > 0) {
		return await performPaste(targetDir, activePanelId, panelState, navigateToDirectory);
	}

	w2utils.notify('Nothing to paste', { timeout: 2000 });
}

/**
 * Read the OS clipboard and handle accordingly:
 *   - files  → copy into targetDir (with collision prompt)
 *   - image  → show paste-image modal
 *   - text   → show paste-text modal
 *   - empty  → toast
 *
 * @param {string} targetDir
 * @param {number} activePanelId
 * @param {object} panelState
 * @param {Function} navigateToDirectory
 * @param {object|null} preReadClip  optional already-read clipboard result
 */
export async function handleExternalPaste(targetDir, activePanelId, panelState, navigateToDirectory, preReadClip = null) {
	let clip = preReadClip;
	if (!clip) {
		try {
			clip = await window.electronAPI.readSystemClipboard();
		} catch (err) {
			console.error('readSystemClipboard failed:', err);
			return;
		}
	}

	if (!clip || clip.type === 'empty') {
		w2utils.notify('Nothing to paste', { timeout: 2000 });
		return;
	}

	if (clip.type === 'files') {
		const items = clip.data.map(p => ({
			path: p,
			filename: p.replace(/.*[/\\]/, ''),
			isFolder: false, // will be determined by the backend
		}));

		let collisions = [];
		try {
			const r = await window.electronAPI.checkCollisions(items, targetDir);
			collisions = Array.isArray(r?.collisions) ? r.collisions : [];
		} catch (_) { /* non-fatal */ }

		let onCollision = 'fail';
		if (collisions.length > 0) {
			const choice = await promptCollisionChoice(collisions, true);
			if (choice === 'cancel' || !choice) return;
			onCollision = choice;
		}

		let result;
		try {
			result = await window.electronAPI.copyItems(items, targetDir, onCollision);
		} catch (err) {
			w2utils.notify(`Error pasting files: ${err?.message || 'Unknown error'}`, { error: true, timeout: 3000 });
			return;
		}
		if (Array.isArray(result?.failed) && result.failed.length > 0) {
			w2utils.notify(`Paste failed for ${result.failed.length} item(s)`, { error: true, timeout: 4000 });
		}
		// Refresh destination panel.
		const ids = Object.keys(panelState || {});
		for (const id of ids) {
			const cp = panelState[id]?.currentPath;
			if (!cp) continue;
			try {
				if (normalizePath(cp) === normalizePath(targetDir)) {
					await navigateToDirectory(cp, parseInt(id), false);
				}
			} catch (_) { /* ignore */ }
		}
	} else if (clip.type === 'image') {
		showPasteImageModal(clip.data, targetDir, activePanelId, panelState, navigateToDirectory);
	} else if (clip.type === 'text') {
		showPasteTextModal(clip.data, targetDir, activePanelId, panelState, navigateToDirectory);
	}
}

// ---------------------------------------------------------------------------
// Paste-text modal
// ---------------------------------------------------------------------------

function showPasteTextModal(text, targetDir, panelId, panelState, navigateToDirectory) {
	_pasteTextData = { text, targetDir, panelId, panelState, navigateToDirectory };

	const pre = document.getElementById('paste-text-content');
	if (pre) pre.textContent = text;

	const input = document.getElementById('paste-text-filename');
	if (input) {
		input.value = 'pasted-text';
		// Clear previous error.
		const err = document.getElementById('paste-text-error');
		if (err) err.textContent = '';
	}

	const modal = document.getElementById('paste-text-modal');
	if (modal) {
		modal.style.display = 'block';
		if (input) {
			input.focus();
			input.select();
		}
	}
}

export function closePasteTextModal() {
	const modal = document.getElementById('paste-text-modal');
	if (modal) modal.style.display = 'none';
}

async function _savePasteText() {
	const input = document.getElementById('paste-text-filename');
	const errorEl = document.getElementById('paste-text-error');
	const filename = (input?.value || '').trim();

	if (!filename) {
		if (errorEl) errorEl.textContent = 'Please enter a file name.';
		if (input) input.focus();
		return;
	}
	if (/[/\\:*?"<>|]/.test(filename)) {
		if (errorEl) errorEl.textContent = 'File name contains invalid characters.';
		if (input) input.focus();
		return;
	}

	const { text, targetDir, panelId, panelState, navigateToDirectory } = _pasteTextData;
	const sep = targetDir.includes('/') ? '/' : '\\';
	const filePath = targetDir.replace(/[/\\]+$/, '') + sep + filename + '.txt';

	try {
		await window.electronAPI.writeFileContent(filePath, text);
	} catch (err) {
		if (errorEl) errorEl.textContent = `Save failed: ${err?.message || 'Unknown error'}`;
		return;
	}

	closePasteTextModal();
	w2utils.notify(`Saved ${filename}.txt`, { success: true, timeout: 2500 });

	// Refresh the destination panel.
	if (panelState && navigateToDirectory) {
		const ids = Object.keys(panelState);
		for (const id of ids) {
			const cp = panelState[id]?.currentPath;
			if (!cp) continue;
			try {
				if (normalizePath(cp) === normalizePath(targetDir)) {
					await navigateToDirectory(cp, parseInt(id), false);
				}
			} catch (_) { /* ignore */ }
		}
	}
}

// ---------------------------------------------------------------------------
// Paste-image modal
// ---------------------------------------------------------------------------

function showPasteImageModal(base64, targetDir, panelId, panelState, navigateToDirectory) {
	_pasteImageData = { base64, targetDir, panelId, panelState, navigateToDirectory };

	const img = document.getElementById('paste-image-preview');
	if (img) img.src = `data:image/png;base64,${base64}`;

	const input = document.getElementById('paste-image-filename');
	if (input) {
		input.value = 'pasted-image';
		const err = document.getElementById('paste-image-error');
		if (err) err.textContent = '';
	}

	const modal = document.getElementById('paste-image-modal');
	if (modal) {
		modal.style.display = 'block';
		if (input) {
			input.focus();
			input.select();
		}
	}
}

export function closePasteImageModal() {
	const modal = document.getElementById('paste-image-modal');
	if (modal) modal.style.display = 'none';
}

async function _savePasteImage() {
	const input = document.getElementById('paste-image-filename');
	const errorEl = document.getElementById('paste-image-error');
	const filename = (input?.value || '').trim();

	if (!filename) {
		if (errorEl) errorEl.textContent = 'Please enter a file name.';
		if (input) input.focus();
		return;
	}
	if (/[/\\:*?"<>|]/.test(filename)) {
		if (errorEl) errorEl.textContent = 'File name contains invalid characters.';
		if (input) input.focus();
		return;
	}

	const { base64, targetDir, panelState, navigateToDirectory } = _pasteImageData;

	let result;
	try {
		result = await window.electronAPI.saveImageToDir({ dir: targetDir, filename, base64 });
	} catch (err) {
		if (errorEl) errorEl.textContent = `Save failed: ${err?.message || 'Unknown error'}`;
		return;
	}
	if (!result || !result.success) {
		if (errorEl) errorEl.textContent = `Save failed: ${result?.error || 'Unknown error'}`;
		return;
	}

	closePasteImageModal();
	w2utils.notify(`Saved ${filename}.png`, { success: true, timeout: 2500 });

	if (panelState && navigateToDirectory) {
		const ids = Object.keys(panelState);
		for (const id of ids) {
			const cp = panelState[id]?.currentPath;
			if (!cp) continue;
			try {
				if (normalizePath(cp) === normalizePath(targetDir)) {
					await navigateToDirectory(cp, parseInt(id), false);
				}
			} catch (_) { /* ignore */ }
		}
	}
}

// ---------------------------------------------------------------------------
// Re-apply helpers
// ---------------------------------------------------------------------------

/**
 * Re-apply item-cut / item-copied CSS classes to the records of a single panel
 * after the grid is re-populated (e.g. after navigation). The clipboard state
 * is still correct; only the freshly-loaded record objects lack the w2ui.class
 * flag because they are brand-new objects.
 *
 * @param {number} panelId
 * @param {object} panelState
 */
export function reapplyClipboardClasses(panelId, panelState) {
	if (!clipboardState.type || clipboardState.items.length === 0) return;
	const pathSet = new Set(clipboardState.items.map(i => i.path));
	const cssClass = clipboardState.type === 'cut' ? 'item-cut' : 'item-copied';
	const state = panelState[panelId];
	if (!state) return;
	const grid = state.w2uiGrid;
	if (!grid || !Array.isArray(grid.records)) return;
	for (const rec of grid.records) {
		if (pathSet.has(rec.path)) {
			if (!rec.w2ui) rec.w2ui = {};
			const existing = (rec.w2ui.class || '').split(' ').filter(c => c && c !== 'item-cut' && c !== 'item-copied');
			existing.push(cssClass);
			rec.w2ui.class = existing.join(' ');
			grid.refreshRow(rec.recid);
		}
	}
}

// ---------------------------------------------------------------------------
// Init (called once from renderer.js)
// ---------------------------------------------------------------------------

/**
 * Build a short human-readable hint describing what the OS clipboard holds.
 *
 * @param {{type:string,data?:any}|null} clip  normalized clipboard payload
 * @returns {string}  e.g. "2 files in clipboard (external)", or '' when empty
 */
function _hintForClip(clip) {
	if (!clip || clip.type === 'empty') return '';
	if (clip.type === 'files' && Array.isArray(clip.data)) {
		const n = clip.data.length;
		return n === 1 ? '1 file in clipboard (external)' : `${n} files in clipboard (external)`;
	}
	if (clip.type === 'image') return 'Image in clipboard (external)';
	if (clip.type === 'text') return 'Text in clipboard (external)';
	return '';
}

/**
 * Reconcile a freshly-observed OS clipboard payload against internal state and
 * refresh the panel footers. This is the single source of truth used by both
 * the window-focus poll and the (future) event-driven `clipboard-changed` IPC.
 *
 * Rules:
 *   - Internal items present and OS still holds the same files → no-op (in sync).
 *   - Internal items present and OS is empty → keep internal state. This guards
 *     the ~200ms self-write window after setClipboard() where the OS write may
 *     still be in flight; we must not falsely clear internal cut/copy state.
 *   - Internal items present and OS holds something different → internal state
 *     is stale: clear it and show the OS hint.
 *   - No internal items → mirror whatever the OS holds (including empty, which
 *     clears any stale hint) into the footer.
 *
 * @param {{type:string,data?:any}|null} clip
 * @param {object} panelState
 */
export function handleClipboardChanged(clip, panelState) {
	const hintText = _hintForClip(clip);
	const isEmpty = !clip || clip.type === 'empty';

	if (clipboardState.items.length > 0) {
		// Internal clipboard is non-empty. Check whether the OS still holds the
		// same files we wrote (setClipboard writes to OS via PowerShell).
		if (clip && clip.type === 'files' && Array.isArray(clip.data)) {
			const osNorm = clip.data.map(normalizePath).sort();
			const intNorm = clipboardState.items.map(i => normalizePath(i.path)).sort();
			const match = osNorm.length === intNorm.length && osNorm.every((p, idx) => p === intNorm[idx]);
			if (match) return; // Still in sync — nothing to do.
		}
		// OS empty: likely the self-write race — keep internal state untouched.
		if (isEmpty) return;
		// OS has something different: internal clipboard is stale. Clear it and
		// show the OS hint in the footers.
		clearClipboard(panelState, hintText);
		return;
	}

	// No internal state: mirror whatever the OS holds (empty clears stale hint).
	_osClipboardHint = hintText;
	for (let id = 1; id <= 4; id++) {
		if (panelState[id]) updateClipboardFooter(id);
	}
}

// Concurrency guard for the focus poll: avoid overlapping PowerShell reads when
// rapid focus events fire. A trailing read is coalesced into a single re-run.
let _osReadInFlight = false;
let _osReadPending = false;

async function _pollOsClipboard(panelState) {
	if (_osReadInFlight) { _osReadPending = true; return; }
	_osReadInFlight = true;
	try {
		let clip = null;
		try { clip = await window.electronAPI.readSystemClipboard(); } catch (_) {}
		handleClipboardChanged(clip, panelState);
	} finally {
		_osReadInFlight = false;
		if (_osReadPending) {
			_osReadPending = false;
			// Re-run once to capture the latest state observed during the read.
			_pollOsClipboard(panelState);
		}
	}
}

/**
 * Attach a window-focus listener that reads the OS clipboard once each time
 * the app regains focus. If the internal clipboard is stale (the user copied
 * something else outside the app), internal state is cleared and the footer
 * is updated to reflect what the OS actually holds.
 *
 * Safe to call multiple times — only the first call attaches the listener.
 *
 * @param {object} panelState  module-scoped panel state map (passed by reference)
 */
export function initClipboardFocusSync(panelState) {
	if (_focusSyncInitialised) return;
	_focusSyncInitialised = true;

	// Event-driven path (preferred): the main process pushes 'clipboard-changed'
	// whenever the OS clipboard updates — works while focused AND headless.
	if (window.electronAPI && typeof window.electronAPI.onClipboardChanged === 'function') {
		window.electronAPI.onClipboardChanged((clip) => handleClipboardChanged(clip, panelState));
	}

	// Focus poll (fallback + initial seed): covers environments where the
	// watcher is unavailable and reconciles state when the window regains focus.
	window.addEventListener('focus', () => { _pollOsClipboard(panelState); });
}

/**
 * Wire up the paste modal buttons. Call this after the DOM is ready.
 */
export function initPasteModals() {
	// --- Paste Text ---
	document.getElementById('btn-paste-text-save')?.addEventListener('click', () => _savePasteText());
	document.getElementById('btn-paste-text-cancel')?.addEventListener('click', () => closePasteTextModal());
	document.getElementById('btn-paste-text-close')?.addEventListener('click', () => closePasteTextModal());

	const textInput = document.getElementById('paste-text-filename');
	if (textInput) {
		textInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') { e.preventDefault(); _savePasteText(); }
			if (e.key === 'Escape') { e.preventDefault(); closePasteTextModal(); }
		});
	}

	// --- Paste Image ---
	document.getElementById('btn-paste-image-save')?.addEventListener('click', () => _savePasteImage());
	document.getElementById('btn-paste-image-cancel')?.addEventListener('click', () => closePasteImageModal());
	document.getElementById('btn-paste-image-close')?.addEventListener('click', () => closePasteImageModal());

	const imageInput = document.getElementById('paste-image-filename');
	if (imageInput) {
		imageInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') { e.preventDefault(); _savePasteImage(); }
			if (e.key === 'Escape') { e.preventDefault(); closePasteImageModal(); }
		});
	}
}
