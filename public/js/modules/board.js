/**
 * Board View
 *
 * A spatial view of one directory: the user places files where they want them and
 * the arrangement persists. Unlike List and Gallery, position carries meaning the
 * filesystem cannot express, so the layout is user intent rather than derived state.
 *
 * Storage is SQLite (`dir_boards` and friends), NOT a flat sidecar. Two flat-file
 * approaches were implemented in planning and rejected; see
 * agent-docs/DECISIONS.md#board-storage before proposing atlas.json again.
 *
 * Three invariants hold this module together. Breaking any of them breaks the view:
 *
 *  1. NO OVERLAP, guaranteed structurally rather than by validation. Cards never
 *     grow to fit content; every content region is a bounded box the user sized.
 *     Collisions are prevented during the gesture by clamping, not repaired after.
 *     See agent-docs/DECISIONS.md#board-no-overlap.
 *  2. MODE CONTRACT. Edit mode is geometry-only; view mode is content-only. There
 *     is no interaction that exists in both. This is what makes it safe to click
 *     around a board you spent effort arranging.
 *     See agent-docs/DECISIONS.md#board-mode-contract.
 *  3. NOTHING IS AUTO-PLACED. Files without coordinates go to the tray and must be
 *     dragged out. There is no correct default position, and guessing one litters
 *     an arrangement the user curated.
 */

import * as utils from './utils.js';
import { panelState } from '../renderer.js';
import {
	DEFAULT_GRID_SIZE,
	DEFAULT_ITEM_W,
	DEFAULT_ITEM_H,
	snapToGrid,
	sweepAxis,
	clampMove,
	rectsOverlap,
	reconcileBoardItems,
} from './boardGeometry.js';

// Re-exported so existing callers keep reaching the geometry through board.js
// while tests import the leaf module directly.
export { snapToGrid, sweepAxis, clampMove, rectsOverlap, reconcileBoardItems };

/** Persist this long after the last geometry change. */
const SAVE_DEBOUNCE_MS = 400;

/**
 * Which panel currently holds edit rights, and for which directory.
 *
 * Module-level rather than per-panel because the constraint is global: two panels
 * showing the SAME directory would otherwise write conflicting snapshots over each
 * other (saves are wholesale replaces). Scoping the lock to one panel at a time is
 * simpler than reconciling concurrent boards, and multi-panel board editing is not
 * a use case anyone asked for.
 * @type {{panelId:number, dirPath:string}|null}
 */
let boardEditLock = null;

/** @type {Map<number, object>} panelId -> live board session */
const boardSessions = new Map();

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

function getSession(panelId) {
	return boardSessions.get(panelId) || null;
}

/**
 * True when this panel may make geometry changes right now.
 * @param {number} panelId
 * @returns {boolean}
 */
export function isEditMode(panelId) {
	const session = getSession(panelId);
	return !!session && boardEditLock?.panelId === panelId && boardEditLock?.dirPath === session.dirPath;
}

/**
 * Release the edit lock if this panel holds it, flushing any pending write first.
 * Called on view switch, navigation, panel close, and app quit — a lock that
 * outlives its board would strand every other panel.
 * @param {number} panelId
 */
export function releaseEditLock(panelId) {
	if (boardEditLock?.panelId !== panelId) return;
	flushPendingSave(panelId);
	boardEditLock = null;
}

/**
 * Tear down a panel's board session. Safe to call when no board is active.
 * @param {number} panelId
 */
export function disposeBoard(panelId) {
	releaseEditLock(panelId);
	flushPendingSave(panelId);
	boardSessions.delete(panelId);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function snapshotOf(session) {
	return {
		gridSize: session.gridSize,
		tray: session.tray,
		// Orphaned rows are written back untouched so a file that reappears later
		// (remounted drive, restored backup) finds its position waiting.
		items: [
			...session.items.map(it => ({
				filename: it.filename,
				inode: it.inode ?? null,
				x: it.x, y: it.y, w: it.w, h: it.h,
				groupId: it.groupId ?? null,
				levels: it.levels || []
			})),
			...session.orphanedItems
		],
		groups: session.groups,
		annotations: session.annotations
	};
}

function scheduleSave(panelId) {
	const session = getSession(panelId);
	if (!session) return;
	clearTimeout(session.saveTimer);
	session.saveTimer = setTimeout(() => persistBoard(panelId), SAVE_DEBOUNCE_MS);
}

function flushPendingSave(panelId) {
	const session = getSession(panelId);
	if (!session?.saveTimer) return;
	clearTimeout(session.saveTimer);
	session.saveTimer = null;
	persistBoard(panelId);
}

async function persistBoard(panelId) {
	const session = getSession(panelId);
	if (!session) return;
	session.saveTimer = null;
	try {
		await window.electronAPI.saveDirBoard(session.dirPath, snapshotOf(session));
	} catch (err) {
		console.warn('[board] save failed for', session.dirPath, err);
	}
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/**
 * Render a directory as a board.
 *
 * Geometry-first: coordinates come from the DB before any thumbnail resolves, so
 * every card is at its final position and size on first paint. Thumbnails fill in
 * afterwards without moving anything.
 *
 * @param {object[]} records   display records (from panels.buildViewRecords)
 * @param {number} panelId
 * @param {string} dirPath
 * @param {object} deps  host callbacks — see panels.js call site
 */
export async function renderBoard(records, panelId, dirPath, deps) {
	// Dot entries are navigation affordances, not directory contents; placing '.'
	// or '..' on a board would let a user arrange something that is not there.
	const placeable = records.filter(r => r.filenameRaw !== '.' && r.filenameRaw !== '..');

	let stored = null;
	try {
		const result = await window.electronAPI.getDirBoard(dirPath);
		if (result?.success) stored = result.board;
	} catch (err) {
		console.warn('[board] load failed for', dirPath, err);
	}

	const { placed, unplaced, orphanedItems } =
		reconcileBoardItems(stored?.items || [], placeable);

	const previous = getSession(panelId);
	if (previous && previous.dirPath !== dirPath) disposeBoard(panelId);

	const session = {
		panelId,
		dirPath,
		deps,
		gridSize: stored?.gridSize || DEFAULT_GRID_SIZE,
		tray: normalizeTray(stored?.tray),
		items: placed.map(({ record, item }) => ({
			filename: record.filenameRaw,
			inode: record.inode ?? null,
			x: item.x, y: item.y,
			w: item.w || DEFAULT_ITEM_W,
			h: item.h || DEFAULT_ITEM_H,
			groupId: item.groupId ?? null,
			levels: item.levels || [],
			record
		})),
		trayRecords: unplaced,
		orphanedItems,
		groups: stored?.groups || [],
		annotations: stored?.annotations || [],
		selected: new Set(),
		saveTimer: null
	};
	boardSessions.set(panelId, session);

	// A board is per-directory. Leaving one must not leave its lock behind.
	if (boardEditLock && boardEditLock.panelId === panelId && boardEditLock.dirPath !== dirPath) {
		boardEditLock = null;
	}

	paintBoard(panelId);
}

function normalizeTray(tray) {
	return {
		dock: tray?.dock || 'right',
		collapsed: !!tray?.collapsed,
		x: tray?.x ?? 0,
		y: tray?.y ?? 0,
		w: tray?.w ?? 14,
		h: tray?.h ?? 20
	};
}

function paintBoard(panelId) {
	const session = getSession(panelId);
	if (!session) return;
	const $board = $(`#panel-${panelId} .panel-board`);
	if (!$board.length) return;

	const editing = isEditMode(panelId);
	const lockedElsewhere = !!boardEditLock && boardEditLock.panelId !== panelId;

	$board.empty();
	$board.toggleClass('board-edit-mode', editing);

	const $canvas = $('<div class="board-canvas"></div>');
	for (const item of session.items) {
		$canvas.append(buildCardEl(session, item));
	}
	$board.append($canvas);
	$board.append(buildTrayEl(session));
	$board.append(buildFooterEl(session, editing, lockedElsewhere));

	attachBoardEvents(panelId, $board);
}

function buildCardEl(session, item) {
	const g = session.gridSize;
	const record = item.record;
	const selected = session.selected.has(record.recid);

	const $card = $(`
		<div class="board-card${selected ? ' is-selected' : ''}" data-recid="${record.recid}"
			data-filename="${utils.escapeHtml(record.filenameRaw)}">
			<div class="board-card-icon-wrap">
				<img class="board-card-icon" src="${utils.escapeHtml(record.icon)}" alt="">
			</div>
			<div class="board-card-name">${record.filename}</div>
			<div class="board-card-handle board-card-handle-e" data-resize="e"></div>
			<div class="board-card-handle board-card-handle-s" data-resize="s"></div>
			<div class="board-card-handle board-card-handle-se" data-resize="se"></div>
		</div>
	`);
	$card.css({
		left: item.x * g, top: item.y * g,
		width: item.w * g, height: item.h * g
	});
	return $card;
}

function buildTrayEl(session) {
	const tray = session.tray;
	const g = session.gridSize;
	const count = session.trayRecords.length;

	const $tray = $(`
		<div class="board-tray board-tray-dock-${tray.dock}${tray.collapsed ? ' is-collapsed' : ''}">
			<div class="board-tray-header">
				<button type="button" class="board-tray-toggle" title="${tray.collapsed ? 'Expand tray' : 'Collapse tray'}">
					${tray.collapsed ? '&#9656;' : '&#9662;'}
				</button>
				<span class="board-tray-title">Unplaced</span>
				<span class="panel-tb-badge">${count}</span>
			</div>
			<div class="board-tray-body"></div>
		</div>
	`);

	const $body = $tray.find('.board-tray-body');
	if (count === 0) {
		$body.append('<div class="board-tray-empty">Everything is placed.</div>');
	}
	for (const record of session.trayRecords) {
		$body.append(`
			<div class="board-tray-item" data-recid="${record.recid}"
				data-filename="${utils.escapeHtml(record.filenameRaw)}" title="${utils.escapeHtml(record.filenameRaw)}">
				<img class="board-tray-item-icon" src="${utils.escapeHtml(record.icon)}" alt="">
				<span class="board-tray-item-name">${record.filename}</span>
			</div>
		`);
	}

	// Free-placed trays participate in the canvas coordinate space; docked ones
	// overlay an edge and deliberately do NOT shrink the canvas, so board
	// coordinates never shift when the dock changes.
	// See agent-docs/DECISIONS.md#board-tray-overlay.
	if (tray.dock === 'free') {
		$tray.css({ left: tray.x * g, top: tray.y * g, width: tray.w * g, height: tray.h * g });
	} else if (tray.dock === 'left' || tray.dock === 'right') {
		$tray.css({ width: tray.w * g });
	} else {
		$tray.css({ height: tray.h * g });
	}

	return $tray;
}

function buildFooterEl(session, editing, lockedElsewhere) {
	const orphanCount = session.orphanedItems.length;
	// Inline denial, never a dialog: the user asked for edit mode, and interrupting
	// them with a popup to say "no" would be a worse answer than a disabled button
	// that names the panel responsible.
	const lockNote = lockedElsewhere
		? ` title="Panel ${boardEditLock.panelId} is editing a board"`
		: '';
	return $(`
		<div class="board-footer">
			<button type="button" class="board-edit-btn${editing ? ' is-active' : ''}"
				${lockedElsewhere ? 'disabled' : ''}${lockNote}>
				${editing ? 'Done' : 'Edit Layout'}
			</button>
			${lockedElsewhere ? `<span class="board-footer-note">Edit mode is held by panel ${boardEditLock.panelId}</span>` : ''}
			${orphanCount ? `<span class="board-footer-note board-footer-attention" title="${orphanCount} saved position${orphanCount > 1 ? 's' : ''} no longer match a file here">&#9888; ${orphanCount} unmatched</span>` : ''}
		</div>
	`);
}

// ---------------------------------------------------------------------------
// Interaction
//
// Every handler below opens by checking the mode. That repetition is deliberate:
// the mode contract is the safety property of this view, and centralising the
// check somewhere clever would make it easy to add a handler that forgets it.
// ---------------------------------------------------------------------------

function attachBoardEvents(panelId, $board) {
	const session = getSession(panelId);
	if (!session) return;
	const { deps } = session;

	$board.off('.board');

	$board.on('click.board', '.board-edit-btn', function () {
		if (this.disabled) return;
		toggleEditMode(panelId);
	});

	$board.on('click.board', '.board-tray-toggle', function () {
		session.tray.collapsed = !session.tray.collapsed;
		scheduleSave(panelId);
		paintBoard(panelId);
	});

	// --- View mode: content interactions ---

	$board.on('click.board', '.board-card', function (e) {
		if (isEditMode(panelId)) return;
		deps.setActivePanelId(panelId);
		const recid = parseInt(this.getAttribute('data-recid'), 10);
		if (e.ctrlKey || e.metaKey) {
			if (session.selected.has(recid)) session.selected.delete(recid);
			else session.selected.add(recid);
		} else {
			session.selected = new Set([recid]);
		}
		refreshSelectionVisuals($board, session);
		const record = findRecord(session, recid);
		if (record) deps.updateSelectedItemFromRecord(record, panelId);
	});

	$board.on('dblclick.board', '.board-card, .board-tray-item', function () {
		if (isEditMode(panelId)) return;
		deps.setActivePanelId(panelId);
		const recid = parseInt(this.getAttribute('data-recid'), 10);
		const record = findRecord(session, recid);
		if (record) deps.openRecord(record, panelId);
	});

	$board.on('contextmenu.board', '.board-card, .board-tray-item', function (e) {
		if (isEditMode(panelId)) return;
		e.preventDefault();
		deps.setActivePanelId(panelId);
		const recid = parseInt(this.getAttribute('data-recid'), 10);
		const record = findRecord(session, recid);
		if (!record) return;
		if (!session.selected.has(recid)) {
			session.selected = new Set([recid]);
			refreshSelectionVisuals($board, session);
		}
		const records = [...session.selected].map(id => findRecord(session, id)).filter(Boolean);
		deps.showRecordContextMenu(records.length ? records : [record], e.clientX, e.clientY, panelId);
	});

	// --- Edit mode: geometry interactions ---

	$board.on('mousedown.board', '.board-card-handle', function (e) {
		if (!isEditMode(panelId)) return;
		e.preventDefault();
		e.stopPropagation();
		beginResize(panelId, $(this).closest('.board-card'), this.getAttribute('data-resize'), e);
	});

	$board.on('mousedown.board', '.board-card', function (e) {
		if (!isEditMode(panelId)) return;
		if (e.button !== 0) return;
		e.preventDefault();
		beginMove(panelId, $(this), e);
	});

	$board.on('mousedown.board', '.board-tray-item', function (e) {
		if (!isEditMode(panelId)) return;
		if (e.button !== 0) return;
		e.preventDefault();
		beginPlaceFromTray(panelId, $(this), e);
	});
}

function findRecord(session, recid) {
	const item = session.items.find(i => i.record.recid === recid);
	if (item) return item.record;
	return session.trayRecords.find(r => r.recid === recid) || null;
}

function refreshSelectionVisuals($board, session) {
	$board.find('.board-card').each(function () {
		const recid = parseInt(this.getAttribute('data-recid'), 10);
		this.classList.toggle('is-selected', session.selected.has(recid));
	});
}

function toggleEditMode(panelId) {
	const session = getSession(panelId);
	if (!session) return;

	if (isEditMode(panelId)) {
		releaseEditLock(panelId);
	} else {
		if (boardEditLock && boardEditLock.panelId !== panelId) return; // denied; button is already disabled
		boardEditLock = { panelId, dirPath: session.dirPath };
		// Selection is a view-mode concept. Carrying it into edit mode would imply
		// geometry operations act on it, which they do not (yet).
		session.selected = new Set();
	}
	paintBoard(panelId);
}

/** Obstruction rects for a drag, excluding the item being dragged. */
function obstructionsFor(session, excludeFilename) {
	return session.items
		.filter(i => i.filename !== excludeFilename)
		.map(i => ({ x: i.x, y: i.y, w: i.w, h: i.h }));
}

function beginMove(panelId, $card, downEvent) {
	const session = getSession(panelId);
	const filename = $card.attr('data-filename');
	const item = session.items.find(i => i.filename === filename);
	if (!item) return;

	const g = session.gridSize;
	const startX = downEvent.clientX;
	const startY = downEvent.clientY;
	const origin = { x: item.x, y: item.y, w: item.w, h: item.h };
	const others = obstructionsFor(session, filename);

	$card.addClass('is-dragging');

	const onMove = (e) => {
		const targetX = origin.x + snapToGrid(e.clientX - startX, g);
		const targetY = origin.y + snapToGrid(e.clientY - startY, g);
		const next = clampMove(origin, targetX, targetY, others);
		item.x = next.x;
		item.y = next.y;
		$card.css({ left: item.x * g, top: item.y * g });
	};

	const onUp = () => {
		document.removeEventListener('mousemove', onMove);
		document.removeEventListener('mouseup', onUp);
		$card.removeClass('is-dragging');
		if (item.x !== origin.x || item.y !== origin.y) scheduleSave(panelId);
	};

	document.addEventListener('mousemove', onMove);
	document.addEventListener('mouseup', onUp);
}

function beginResize(panelId, $card, direction, downEvent) {
	const session = getSession(panelId);
	const filename = $card.attr('data-filename');
	const item = session.items.find(i => i.filename === filename);
	if (!item) return;

	const g = session.gridSize;
	const startX = downEvent.clientX;
	const startY = downEvent.clientY;
	const origin = { x: item.x, y: item.y, w: item.w, h: item.h };
	const others = obstructionsFor(session, filename);

	const onMove = (e) => {
		let w = origin.w;
		let h = origin.h;
		if (direction.includes('e')) w = Math.max(1, origin.w + snapToGrid(e.clientX - startX, g));
		if (direction.includes('s')) h = Math.max(1, origin.h + snapToGrid(e.clientY - startY, g));

		// Growing into a neighbour is the same violation as moving into one, so it
		// is clamped the same way rather than allowed and repaired.
		const candidate = { x: origin.x, y: origin.y, w, h };
		for (const o of others) {
			if (!rectsOverlap(candidate, o)) continue;
			if (direction.includes('e') && o.x >= origin.x + origin.w) {
				candidate.w = Math.min(candidate.w, o.x - origin.x);
			}
			if (direction.includes('s') && o.y >= origin.y + origin.h) {
				candidate.h = Math.min(candidate.h, o.y - origin.y);
			}
		}
		item.w = Math.max(1, candidate.w);
		item.h = Math.max(1, candidate.h);
		$card.css({ width: item.w * g, height: item.h * g });
	};

	const onUp = () => {
		document.removeEventListener('mousemove', onMove);
		document.removeEventListener('mouseup', onUp);
		if (item.w !== origin.w || item.h !== origin.h) scheduleSave(panelId);
	};

	document.addEventListener('mousemove', onMove);
	document.addEventListener('mouseup', onUp);
}

/**
 * Drag a file out of the tray onto the canvas.
 *
 * Placement only happens on drop over the canvas — a drag that ends inside the
 * tray is a no-op, so an accidental grab cannot scatter files onto the board.
 */
function beginPlaceFromTray(panelId, $trayItem, downEvent) {
	const session = getSession(panelId);
	const recid = parseInt($trayItem.attr('data-recid'), 10);
	const record = session.trayRecords.find(r => r.recid === recid);
	if (!record) return;

	const g = session.gridSize;
	const $board = $(`#panel-${panelId} .panel-board`);
	const $ghost = $('<div class="board-drag-ghost"></div>')
		.css({ width: DEFAULT_ITEM_W * g, height: DEFAULT_ITEM_H * g })
		.appendTo($board);

	const boardRect = $board[0].getBoundingClientRect();
	let dropped = null;

	const onMove = (e) => {
		const px = e.clientX - boardRect.left - (DEFAULT_ITEM_W * g) / 2;
		const py = e.clientY - boardRect.top - (DEFAULT_ITEM_H * g) / 2;
		const target = {
			x: Math.max(0, snapToGrid(px, g)),
			y: Math.max(0, snapToGrid(py, g)),
			w: DEFAULT_ITEM_W, h: DEFAULT_ITEM_H
		};
		const next = clampMove({ x: 0, y: 0, w: DEFAULT_ITEM_W, h: DEFAULT_ITEM_H },
			target.x, target.y, obstructionsFor(session, null));
		dropped = next;
		$ghost.css({ left: next.x * g, top: next.y * g });
	};

	const onUp = (e) => {
		document.removeEventListener('mousemove', onMove);
		document.removeEventListener('mouseup', onUp);
		$ghost.remove();

		const overTray = !!e.target.closest?.('.board-tray');
		if (!dropped || overTray) return;

		session.items.push({
			filename: record.filenameRaw,
			inode: record.inode ?? null,
			x: dropped.x, y: dropped.y, w: DEFAULT_ITEM_W, h: DEFAULT_ITEM_H,
			groupId: null, levels: [], record
		});
		session.trayRecords = session.trayRecords.filter(r => r.recid !== recid);
		scheduleSave(panelId);
		paintBoard(panelId);
	};

	document.addEventListener('mousemove', onMove);
	document.addEventListener('mouseup', onUp);
	onMove(downEvent);
}

/**
 * Entry point used by panels.js when a panel resolves to the board view.
 * @param {object[]} records
 * @param {number} panelId
 * @param {string} dirPath
 * @param {object} deps
 */
export async function populateBoardView(records, panelId, dirPath, deps) {
	await renderBoard(records, panelId, dirPath, deps);
}
