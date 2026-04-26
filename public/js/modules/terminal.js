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

// ─── Terminal Drawer ──────────────────────────────────────────────────────────

let modalSession = null;
let drawerHeight = null;      // stored px height before minimize
let drawerDragState = null;   // true while dragging
let currentCommand = '';      // tracks the last command typed (cleared on Enter)

function _drawerOnMouseMove(e) {
	if (!drawerDragState) return;
	const drawerEl = document.getElementById('terminal-drawer');
	if (!drawerEl) return;

	// Auto-expand if currently minimized
	if (drawerEl.classList.contains('terminal-drawer--minimized')) {
		drawerEl.classList.remove('terminal-drawer--minimized');
		document.getElementById('terminal-drawer-title').textContent = 'Terminal';
	}

	const panelEl = drawerEl.parentElement;
	const panelBottom = panelEl ? panelEl.getBoundingClientRect().bottom : window.innerHeight;
	const newHeight = Math.max(120, panelBottom - e.clientY);
	drawerEl.style.height = newHeight + 'px';
	drawerHeight = newHeight;
}

function _drawerOnMouseUp() {
	drawerDragState = null;
	window.removeEventListener('mousemove', _drawerOnMouseMove);
	window.removeEventListener('mouseup', _drawerOnMouseUp);
}

/**
 * Open the terminal drawer and start an xterm session inside it.
 * @param {string} [cwd] - Working directory for the shell (defaults to home dir)
 * @param {number} [panelId] - Panel to anchor the drawer to (defaults to 1)
 */
export async function openTerminalModal(cwd, panelId = 1) {
	ensureIpcListeners();

	// Destroy any existing drawer session first
	await closeTerminalModal();

	const containerEl = document.getElementById('terminal-drawer-container');
	if (!containerEl) return;

	containerEl.innerHTML = '';
	currentCommand = '';

	const drawerEl = document.getElementById('terminal-drawer');
	if (!drawerEl) return;

	// Move drawer into the calling panel so it is anchored to that panel
	const panelEl = document.getElementById(`panel-${panelId}`);
	if (panelEl && drawerEl.parentElement !== panelEl) {
		panelEl.appendChild(drawerEl);
	}

	// Restore previous height or default to 40vh
	if (drawerHeight !== null) {
		drawerEl.style.height = drawerHeight + 'px';
	} else {
		drawerEl.style.height = '';
	}

	// Ensure not minimized on (re)open
	drawerEl.classList.remove('terminal-drawer--minimized');
	document.getElementById('terminal-drawer-title').textContent = 'Terminal';

	// Show drawer (triggers CSS slide-up)
	drawerEl.style.display = 'flex';
	// Force reflow so transition fires
	drawerEl.getBoundingClientRect();
	drawerEl.classList.add('terminal-drawer--open');

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

	term.onData(data => {
		// Track typed command for the minimized title (Option B)
		if (data === '\r' || data === '\n') {
			currentCommand = '';
		} else if (data === '\x7f' || data === '\b') {
			// Backspace
			currentCommand = currentCommand.slice(0, -1);
		} else if (data.length === 1 && data >= ' ') {
			currentCommand += data;
		}

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

	// ── Panel resize observer — clamp drawer height to avoid top overflow ────
	if (panelEl) {
		const panelResizeObserver = new ResizeObserver(() => {
			const drawerEl2 = document.getElementById('terminal-drawer');
			if (!drawerEl2 || drawerEl2.classList.contains('terminal-drawer--minimized')) return;
			const maxH = panelEl.offsetHeight - 48; // leave room for header bar above
			if (maxH < 120) return;
			const currentH = drawerEl2.offsetHeight;
			if (currentH > maxH) {
				drawerEl2.style.height = maxH + 'px';
				drawerHeight = maxH;
				if (modalSession) {
					try {
						modalSession.fitAddon.fit();
						const { cols, rows } = modalSession.term;
						if (modalSession.termId) {
							window.electronAPI.terminalResize(modalSession.termId, cols, rows);
						}
					} catch (_) {}
				}
			}
		});
		panelResizeObserver.observe(panelEl);
		modalSession.panelResizeObserver = panelResizeObserver;
	}

	// ── Drag-resize handle ────────────────────────────────────────────
	const dragHandle = drawerEl.querySelector('.terminal-drawer-drag-handle');
	$(dragHandle).off('mousedown.drawer').on('mousedown.drawer', function (e) {
		e.preventDefault();
		drawerDragState = true;
		window.addEventListener('mousemove', _drawerOnMouseMove);
		window.addEventListener('mouseup', _drawerOnMouseUp);
	});

	// ── Minimize / Restore toggle ─────────────────────────────────────
	$('#btn-terminal-drawer-toggle').off('click.drawer').on('click.drawer', function () {
		const isMinimized = drawerEl.classList.contains('terminal-drawer--minimized');
		if (isMinimized) {
			// Restore
			drawerEl.classList.remove('terminal-drawer--minimized');
			if (drawerHeight !== null) {
				drawerEl.style.height = drawerHeight + 'px';
			} else {
				drawerEl.style.height = '';
			}
			document.getElementById('terminal-drawer-title').textContent = 'Terminal';
			setTimeout(() => {
				if (modalSession) {
					try {
						modalSession.fitAddon.fit();
						const { cols, rows } = modalSession.term;
						if (modalSession.termId) {
							window.electronAPI.terminalResize(modalSession.termId, cols, rows);
						}
					} catch (_) {}
					modalSession.term.focus();
				}
			}, 50);
		} else {
			// Minimize
			drawerHeight = drawerEl.offsetHeight;
			drawerEl.classList.add('terminal-drawer--minimized');
			drawerEl.style.height = ''; // let height:auto take effect
			document.getElementById('terminal-drawer-title').textContent =
				currentCommand.trim() || 'Terminal';
		}
	});

	// ── Close ─────────────────────────────────────────────────────────
	$('#btn-terminal-drawer-close').off('click.drawer').on('click.drawer', function () {
		closeTerminalModal();
	});

	term.focus();
}

/**
 * Close the terminal drawer and destroy its session.
 */
export async function closeTerminalModal() {
	const drawerEl = document.getElementById('terminal-drawer');
	if (drawerEl) {
		drawerEl.classList.remove('terminal-drawer--open', 'terminal-drawer--minimized');
		drawerEl.style.display = 'none';
		// Return drawer to body so it is not anchored to any panel
		if (drawerEl.parentElement !== document.body) {
			document.body.appendChild(drawerEl);
		}
	}

	// Clean up drag listeners if a drag was in progress
	window.removeEventListener('mousemove', _drawerOnMouseMove);
	window.removeEventListener('mouseup', _drawerOnMouseUp);
	drawerDragState = null;
	currentCommand = '';

	if (!modalSession) return;

	if (modalSession.resizeObserver) {
		modalSession.resizeObserver.disconnect();
	}

	if (modalSession.panelResizeObserver) {
		modalSession.panelResizeObserver.disconnect();
	}

	if (modalSession.termId) {
		try { await window.electronAPI.terminalDestroy(modalSession.termId); } catch (_) {}
	}

	try { modalSession.term.dispose(); } catch (_) {}

	modalSession = null;
}

/**
 * Snap the drawer terminal session into a panel, retaining the live PTY.
 * The xterm DOM tree is moved to the panel container so no reconnection is needed.
 * @param {number} panelId - Target panel (2-4)
 * @param {Function} ensurePanelVisible - Callback that shows the panel and calls
 *   attachPanelEventListeners / updatePanelLayout if needed. Signature: (panelId) => void
 */
export async function snapModalTerminalToPanel(panelId, ensurePanelVisible) {
	if (!modalSession) return;

	const srcContainer = document.getElementById('terminal-drawer-container');
	const dstContainer = document.getElementById(`terminal-container-${panelId}`);
	if (!srcContainer || !dstContainer) return;

	// Detach resize observers from drawer container
	if (modalSession.resizeObserver) {
		modalSession.resizeObserver.disconnect();
		modalSession.resizeObserver = null;
	}

	if (modalSession.panelResizeObserver) {
		modalSession.panelResizeObserver.disconnect();
		modalSession.panelResizeObserver = null;
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

	// Move xterm DOM children from drawer container to panel container
	dstContainer.innerHTML = '';
	while (srcContainer.firstChild) {
		dstContainer.appendChild(srcContainer.firstChild);
	}

	// Transfer session ownership
	const session = modalSession;
	modalSession = null;
	currentCommand = '';

	// Re-wire input handler to use the panel slot
	terminalSessions[panelId] = session;

	// Hide drawer and return it to body
	const drawerEl = document.getElementById('terminal-drawer');
	if (drawerEl) {
		drawerEl.classList.remove('terminal-drawer--open', 'terminal-drawer--minimized');
		drawerEl.style.display = 'none';
		if (drawerEl.parentElement !== document.body) {
			document.body.appendChild(drawerEl);
		}
	}

	// Clean up drag listeners
	window.removeEventListener('mousemove', _drawerOnMouseMove);
	window.removeEventListener('mouseup', _drawerOnMouseUp);
	drawerDragState = null;

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
 * Rebuild the panel-snap buttons inside the terminal drawer header.
 * Call this each time the drawer is opened so the button list reflects the
 * current number of visible panels.
 * @param {number} visiblePanels
 * @param {Function} onSnap - Called with panelId when a button is clicked.
 *   Signature: (panelId: number) => void
 */
export function updateTerminalModalPanelButtons(visiblePanels, onSnap) {
	const $btns = $('#terminal-drawer-panel-btns').empty();
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
