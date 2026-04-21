/**
 * Terminal Module
 * Manages xterm.js terminal sessions inside panels.
 * Each terminal panel is associated with a panelId (2-4).
 */

// terminalSessions[panelId] = { term, fitAddon, termId, outputListener, exitListener }
const terminalSessions = {};

// Single shared listeners for terminal IPC events (registered once)
let ipcListenersRegistered = false;

function setTerminalHeader(panelId, title = 'Terminal') {
	const $panel = $(`#panel-${panelId}`);
	$panel.find('.terminal-header span').text(title);
}

function ensureIpcListeners() {
	if (ipcListenersRegistered) return;
	ipcListenersRegistered = true;

	window.electronAPI.onTerminalOutput(({ id, data }) => {
		// Route to modal session first
		if (modalSession && modalSession.termId === id) {
			modalSession.term.write(data);
			return;
		}
		for (const session of Object.values(terminalSessions)) {
			if (session.termId === id) {
				session.term.write(data);
				break;
			}
		}
	});

	window.electronAPI.onTerminalExit(({ id }) => {
		if (modalSession && modalSession.termId === id) {
			modalSession.term.write('\r\n\x1b[31m[Process exited]\x1b[0m\r\n');
			modalSession.termId = null;
			return;
		}
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
 * @param {string} title - Header label for the panel terminal
 */
export async function createTerminalPanel(panelId, cwd, title = 'Terminal') {
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
	$panel.find('.panel-header').removeClass('active');
	$panel.find('.panel-toolbar').removeClass('active');
	$panel.find('.panel-terminal-view').show();
	setTerminalHeader(panelId, title);

	// Focus the terminal
	term.focus();

	return { panelId, termId: id };
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
	setTerminalHeader(panelId, 'Terminal');
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

// ─── Terminal Modal ────────────────────────────────────────────────────────────

let modalSession = null;

/**
 * Open the terminal modal and start an xterm session inside it.
 * @param {string} [cwd] - Working directory for the shell (defaults to home dir)
 */
export async function openTerminalModal(cwd) {
	ensureIpcListeners();

	// Destroy any existing modal session first
	await closeTerminalModal();

	const containerEl = document.getElementById('terminal-modal-container');
	if (!containerEl) return;

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

	// Show modal before fitting so dimensions are correct
	const modalEl = document.getElementById('terminal-modal');
	modalEl.style.display = 'flex';

	fitAddon.fit();

	term.onData(data => {
		if (modalSession && modalSession.termId) {
			window.electronAPI.terminalSendInput(modalSession.termId, data);
		}
	});

	const { id } = await window.electronAPI.terminalCreate(cwd || undefined);

	modalSession = { term, fitAddon, termId: id };

	const resizeObserver = new ResizeObserver(() => {
		if (!modalSession) return;
		try {
			modalSession.fitAddon.fit();
			const { cols, rows } = modalSession.term;
			if (modalSession.termId) {
				window.electronAPI.terminalResize(modalSession.termId, cols, rows);
			}
		} catch (_) {}
	});
	resizeObserver.observe(containerEl);
	modalSession.resizeObserver = resizeObserver;

	term.focus();
}

/**
 * Close the terminal modal and destroy its session.
 */
export async function closeTerminalModal() {
	const modalEl = document.getElementById('terminal-modal');
	if (modalEl) modalEl.style.display = 'none';

	if (!modalSession) return;

	if (modalSession.resizeObserver) {
		modalSession.resizeObserver.disconnect();
	}

	if (modalSession.termId) {
		try { await window.electronAPI.terminalDestroy(modalSession.termId); } catch (_) {}
	}

	try { modalSession.term.dispose(); } catch (_) {}

	modalSession = null;
}

/**
 * Snap the modal terminal session into a panel, retaining the live PTY.
 * The xterm DOM tree is moved to the panel container so no reconnection is needed.
 * @param {number} panelId - Target panel (2-4)
 * @param {Function} ensurePanelVisible - Callback that shows the panel and calls
 *   attachPanelEventListeners / updatePanelLayout if needed. Signature: (panelId) => void
 */
export async function snapModalTerminalToPanel(panelId, ensurePanelVisible) {
	if (!modalSession) return;

	const srcContainer = document.getElementById('terminal-modal-container');
	const dstContainer = document.getElementById(`terminal-container-${panelId}`);
	if (!srcContainer || !dstContainer) return;

	// Detach resize observer from modal container
	if (modalSession.resizeObserver) {
		modalSession.resizeObserver.disconnect();
		modalSession.resizeObserver = null;
	}

	// Destroy any existing session in the target panel first (without touching the DOM yet)
	const existing = terminalSessions[panelId];
	if (existing) {
		if (existing.resizeObserver) existing.resizeObserver.disconnect();
		if (existing.termId) {
			try { await window.electronAPI.terminalDestroy(existing.termId); } catch (_) {}
		}
		try { existing.term.dispose(); } catch (_) {}
		delete terminalSessions[panelId];
	}

	// Move xterm DOM children from modal container to panel container
	dstContainer.innerHTML = '';
	while (srcContainer.firstChild) {
		dstContainer.appendChild(srcContainer.firstChild);
	}

	// Transfer session ownership
	const session = modalSession;
	modalSession = null;

	// Re-wire input handler to use the panel slot
	terminalSessions[panelId] = session;

	// Hide modal (session is no longer owned by it)
	const modalEl = document.getElementById('terminal-modal');
	if (modalEl) modalEl.style.display = 'none';

	// Ensure the panel is visible
	if (typeof ensurePanelVisible === 'function') {
		ensurePanelVisible(panelId);
	}

	// Show terminal view in panel
	const $panel = $(`#panel-${panelId}`);
	$panel.find('.panel-landing-page').hide();
	$panel.find('.panel-grid').hide();
	$panel.find('.panel-file-view').hide();
	$panel.find('.panel-header').removeClass('active');
	$panel.find('.panel-toolbar').removeClass('active');
	$panel.find('.panel-terminal-view').css('display', 'flex');
	setTerminalHeader(panelId, 'Terminal');

	// Re-fit and attach new resize observer now that the DOM is in its final location
	const resizeObserver = new ResizeObserver(() => {
		const s = terminalSessions[panelId];
		if (!s) return;
		try {
			s.fitAddon.fit();
			const { cols, rows } = s.term;
			if (s.termId) window.electronAPI.terminalResize(s.termId, cols, rows);
		} catch (_) {}
	});
	resizeObserver.observe(dstContainer);
	terminalSessions[panelId].resizeObserver = resizeObserver;

	// Give the layout a tick to settle before fitting
	setTimeout(() => {
		const s = terminalSessions[panelId];
		if (!s) return;
		try {
			s.fitAddon.fit();
			const { cols, rows } = s.term;
			if (s.termId) window.electronAPI.terminalResize(s.termId, cols, rows);
		} catch (_) {}
		s.term.focus();
	}, 50);
}

/**
 * Rebuild the panel-snap buttons inside the terminal modal header.
 * Call this each time the modal is opened so the button list reflects the
 * current number of visible panels.
 * @param {number} visiblePanels
 * @param {Function} onSnap - Called with panelId when a button is clicked.
 *   Signature: (panelId: number) => void
 */
export function updateTerminalModalPanelButtons(visiblePanels, onSnap) {
	const $btns = $('#terminal-modal-panel-btns').empty();
	const maxPanel = Math.min(visiblePanels + 1, 4);
	for (let p = 2; p <= maxPanel; p++) {
		const targetPanel = p;
		$('<button>')
			.text(`P${targetPanel}`)
			.css({
				padding: '2px 10px',
				background: '#2196F3',
				color: 'white',
				border: 'none',
				borderRadius: '3px',
				cursor: 'pointer',
				fontSize: '12px',
				fontFamily: 'Consolas, monospace'
			})
			.on('click', function () {
				if (typeof onSnap === 'function') onSnap(targetPanel);
			})
			.appendTo($btns);
	}
}

/**
 * Route terminal-modal IPC output to the modal session.
 * Called from ensureIpcListeners via the shared onTerminalOutput handler.
 * @param {string} id
 * @param {string} data
 */
export function routeModalOutput(id, data) {
	if (modalSession && modalSession.termId === id) {
		modalSession.term.write(data);
		return true;
	}
	return false;
}

export function getFallbackTerminalPanelId(visiblePanelCount) {
	const existingTerminalPanelIds = getTerminalPanelIds().sort((left, right) => left - right);
	const nextPanelId = visiblePanelCount + 1;
	if (nextPanelId <= 4) return nextPanelId;
	if (existingTerminalPanelIds.length > 0) return existingTerminalPanelIds[existingTerminalPanelIds.length - 1];
	return Math.max(2, visiblePanelCount);
}
