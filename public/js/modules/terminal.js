/**
 * Terminal Module
 * Manages xterm.js terminal sessions inside panels.
 * Each terminal panel is associated with a panelId (2-4).
 */

// terminalSessions[panelId] = { term, fitAddon, termId, outputListener, exitListener }
const terminalSessions = {};

// Single shared listeners for terminal IPC events (registered once)
let ipcListenersRegistered = false;

function ensureIpcListeners() {
	if (ipcListenersRegistered) return;
	ipcListenersRegistered = true;

	window.electronAPI.onTerminalOutput(({ id, data }) => {
		for (const session of Object.values(terminalSessions)) {
			if (session.termId === id) {
				session.term.write(data);
				break;
			}
		}
	});

	window.electronAPI.onTerminalExit(({ id }) => {
		for (const [panelId, session] of Object.entries(terminalSessions)) {
			if (session.termId === id) {
				session.term.write('\r\n\x1b[31m[Process exited]\x1b[0m\r\n');
				session.termId = null;
				break;
			}
		}
	});
}

/**
 * Create and attach an xterm.js terminal to a panel.
 * @param {number} panelId - The panel number (2-4)
 * @param {string} cwd - Working directory for the shell
 */
export async function createTerminalPanel(panelId, cwd) {
	ensureIpcListeners();

	// Destroy any existing session in this panel first
	await destroyTerminalPanel(panelId);

	const containerEl = document.getElementById(`terminal-container-${panelId}`);
	if (!containerEl) {
		console.error(`[TERMINAL] Container element not found for panel ${panelId}`);
		return;
	}

	containerEl.innerHTML = '';

	const term = new window.Terminal({
		fontFamily: 'Consolas, "Courier New", monospace',
		fontSize: 13,
		theme: {
			background: '#1e1e1e',
			foreground: '#d4d4d4',
			cursor: '#d4d4d4',
			selectionBackground: '#264f78'
		},
		scrollback: 1000,
		convertEol: true,
		cursorBlink: true
	});

	const fitAddon = new window.FitAddon.FitAddon();
	const webLinksAddon = new window.WebLinksAddon.WebLinksAddon();

	term.loadAddon(fitAddon);
	term.loadAddon(webLinksAddon);
	term.open(containerEl);
	fitAddon.fit();

	// Wire user input to PTY
	term.onData(data => {
		const session = terminalSessions[panelId];
		if (session && session.termId) {
			window.electronAPI.terminalSendInput(session.termId, data);
		}
	});

	// Create PTY session on backend
	const { id } = await window.electronAPI.terminalCreate(cwd);

	terminalSessions[panelId] = { term, fitAddon, termId: id };

	// Resize observer to fit terminal when panel resizes
	const resizeObserver = new ResizeObserver(() => {
		const session = terminalSessions[panelId];
		if (!session) return;
		try {
			session.fitAddon.fit();
			const { cols, rows } = session.term;
			if (session.termId) {
				window.electronAPI.terminalResize(session.termId, cols, rows);
			}
		} catch (_) {}
	});
	resizeObserver.observe(containerEl);
	terminalSessions[panelId].resizeObserver = resizeObserver;

	// Show the terminal view
	const $panel = $(`#panel-${panelId}`);
	$panel.find('.panel-landing-page').hide();
	$panel.find('.panel-grid').hide();
	$panel.find('.panel-file-view').hide();
	$panel.find('.panel-terminal-view').show();

	// Focus the terminal
	term.focus();
}

/**
 * Destroy the terminal session in a panel and return to the landing page.
 * @param {number} panelId
 */
export async function destroyTerminalPanel(panelId) {
	const session = terminalSessions[panelId];
	if (!session) return;

	if (session.resizeObserver) {
		session.resizeObserver.disconnect();
	}

	if (session.termId) {
		try { await window.electronAPI.terminalDestroy(session.termId); } catch (_) {}
	}

	try { session.term.dispose(); } catch (_) {}

	delete terminalSessions[panelId];

	const $panel = $(`#panel-${panelId}`);
	$panel.find('.panel-terminal-view').hide();
	$panel.find('.panel-landing-page').show();
}

/**
 * Returns true if the given panel has an active terminal session.
 * @param {number} panelId
 */
export function isPanelTerminal(panelId) {
	return !!terminalSessions[panelId];
}

/**
 * Fit the terminal in a panel (call after resize).
 * @param {number} panelId
 */
export function fitTerminal(panelId) {
	const session = terminalSessions[panelId];
	if (!session) return;
	try {
		session.fitAddon.fit();
		const { cols, rows } = session.term;
		if (session.termId) {
			window.electronAPI.terminalResize(session.termId, cols, rows);
		}
	} catch (_) {}
}

/**
 * Return an array of panelIds that currently have terminals.
 */
export function getTerminalPanelIds() {
	return Object.keys(terminalSessions).map(Number);
}
