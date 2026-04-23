/**
 * Drag-and-drop for the w2ui panel grids.
 *
 * Responsibilities:
 *   - Attach `dragstart` on each grid so a selection can be dragged.
 *   - Attach `dragover` / `dragleave` / `drop` on panel grids, folder rows, the
 *     ".." parent row, and the panel header / path bar.
 *   - Validate drop payloads (no self-drop, no ancestor-drop, no `.`/`..`).
 *   - Pre-flight collisions via IPC and prompt Overwrite / Skip / Rename /
 *     Cancel when the destination already has a same-named entry.
 *   - Dispatch `moveItems` (default) or `copyItems` (Ctrl/Cmd) and refresh
 *     every panel whose `currentPath` touches the source or destination.
 *
 * The in-app payload lives on a custom MIME type so we can distinguish our own
 * drags from OS-level file drops (groundwork for future cross-app support).
 */

import { w2ui, w2alert, w2confirm } from './vendor/w2ui.es6.min.js';

const PAYLOAD_MIME = 'application/x-atlasexplorer-items';

// w2ui renders each row as a <tr index="N"> inside .w2ui-grid-records (main
// scroll area) and .w2ui-grid-frecords (frozen/left columns). Fixed-column
// rows appear in BOTH tables so we match either.
const ROW_SELECTOR = '.w2ui-grid-records tr:not(.w2ui-empty-record), .w2ui-grid-frecords tr:not(.w2ui-empty-record)';

// Drag-leave is noisy when the pointer crosses child elements. A per-target
// counter that tracks enter/leave pairs gives us flicker-free highlighting.
const enterCounters = new WeakMap();

// The panel id that initiated the current drag (set on dragstart, cleared on
// dragend). Lets drop-target handlers suppress same-panel background highlight
// since dragging-within-the-same-panel is a no-op the user shouldn't be
// invited to do. Reading this from dataTransfer during dragenter/dragover is
// blocked by the browser, so we stash it here.
let _activeDragSourcePanelId = null;

// We install a single capturing mousedown listener on the document that kills
// w2ui's drag-to-select-range (marquee) gesture so plain mouse drag is
// exclusively for HTML5 drag-and-drop. Click and Shift/Ctrl multi-select use
// the `click` event and are therefore unaffected.
let _marqueeSuppressorInstalled = false;
function installMarqueeSuppressor() {
	if (_marqueeSuppressorInstalled) return;
	_marqueeSuppressorInstalled = true;
	document.addEventListener('mousedown', (e) => {
		if (e.button !== 0) return;
		if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
		const tr = e.target.closest && e.target.closest(ROW_SELECTOR);
		if (!tr) return;
		if (tr.getAttribute('draggable') !== 'true') return;
		// Stop w2ui's selection-expand binding from seeing this mousedown.
		// The follow-up `click` event still fires, so w2ui's normal row
		// click-selection continues to work.
		e.stopPropagation();
	}, true);
}

/**
 * Public entry point: attach drag-source and drop-target listeners to a panel.
 * Safe to call repeatedly; listeners are namespaced/cleared before rebinding.
 *
 * @param {number|string} panelId
 * @param {object} deps
 * @param {object} deps.panelState
 * @param {(path: string, panelId: number|string, addToHistory?: boolean) => Promise<any>} deps.navigateToDirectory
 */
export function attachDragDropForPanel(panelId, { panelState, navigateToDirectory }) {
	const $panel = jQuery(`#panel-${panelId}`);
	if ($panel.length === 0) return;

	const $grid = $panel.find('.panel-grid');
	const $header = $panel.find('.panel-header');

	// Global: suppress w2ui's marquee drag-to-select so plain drag initiates
	// HTML5 drag-and-drop. (Installed once per page.)
	installMarqueeSuppressor();

	// w2ui doesn't mark rows as draggable, so HTML5 dragstart won't fire. Tag
	// every existing row now and watch for future re-renders.
	ensureRowsDraggable($grid[0]);
	observeRowsForDraggable(panelId, $grid[0]);

	// Also disable the grid's range-select event (belt + suspenders: if a
	// selection-extend somehow still reaches w2ui, cancel it.)
	const grid = panelState[panelId]?.w2uiGrid;
	if (grid) {
		const prev = grid.onSelectionExtend;
		grid.onSelectionExtend = function (e) {
			if (e && typeof e.preventDefault === 'function') e.preventDefault();
			if (typeof prev === 'function') return prev.call(this, e);
		};
	}

	// ---- Drag source: grid rows ----
	$grid.off('dragstart.aedd').on('dragstart.aedd', ROW_SELECTOR, function (ev) {
		const e = ev.originalEvent || ev;
		const grid = panelState[panelId]?.w2uiGrid;
		if (!grid) { e.preventDefault(); return; }

		const record = recordFromRow(this, grid);
		if (!record) { e.preventDefault(); return; }
		if (record.filenameRaw === '.' || record.filenameRaw === '..') {
			// Meta rows are never valid drag sources.
			e.preventDefault();
			return;
		}

		// If the dragged row is not already selected, select just it so the
		// payload matches user intent.
		const selection = grid.getSelection();
		if (!selection.some(r => String(r) === String(record.recid))) {
			grid.selectNone();
			grid.select(record.recid);
		}

		const items = buildPayloadItems(grid);
		if (items.length === 0) { e.preventDefault(); return; }

		e.dataTransfer.effectAllowed = 'copyMove';
		_activeDragSourcePanelId = panelId;
		try {
			e.dataTransfer.setData(PAYLOAD_MIME, JSON.stringify({ sourcePanelId: panelId, items }));
			// Populate text/uri-list so external apps can at least see paths.
			// (Full OS-level drag-out requires main-process webContents.startDrag
			// and is deferred to the cross-app phase.)
			e.dataTransfer.setData('text/uri-list', items.map(it => fileUri(it.path)).join('\r\n'));
			e.dataTransfer.setData('text/plain', items.map(it => it.path).join('\n'));
		} catch (_) { /* some browsers restrict custom MIME - ignore */ }

		// Visual cue on the source rows (both main + frozen tables).
		const sourceRecids = new Set(items.map(it => String(it.recid)));
		$grid.find(ROW_SELECTOR).each(function () {
			const rec = recordFromRow(this, grid);
			if (rec && sourceRecids.has(String(rec.recid))) {
				this.classList.add('dragging-source');
			}
		});
	});

	$grid.off('dragend.aedd').on('dragend.aedd', ROW_SELECTOR, function () {
		$grid.find('tr.dragging-source').removeClass('dragging-source');
		clearDropHighlights($panel);
		_activeDragSourcePanelId = null;
	});

	// ---- Drop target: folder rows + ".." row ----
	$grid.off('dragover.aedd dragenter.aedd dragleave.aedd drop.aedd');

	$grid.on('dragover.aedd', ROW_SELECTOR, function (ev) {
		const target = resolveRowDropTarget(this, panelId, panelState);
		if (!target) return;
		const e = ev.originalEvent || ev;
		e.preventDefault();
		e.stopPropagation();
		setDropEffect(e);
	});

	$grid.on('dragenter.aedd', ROW_SELECTOR, function (ev) {
		const target = resolveRowDropTarget(this, panelId, panelState);
		if (!target) return;
		const e = ev.originalEvent || ev;
		e.preventDefault();
		e.stopPropagation();
		bumpEnterCounter(this);
		this.classList.add('drop-target-folder');
	});

	$grid.on('dragleave.aedd', ROW_SELECTOR, function () {
		if (decrementEnterCounter(this) <= 0) {
			this.classList.remove('drop-target-folder');
		}
	});

	$grid.on('drop.aedd', ROW_SELECTOR, async function (ev) {
		const target = resolveRowDropTarget(this, panelId, panelState);
		if (!target) return;
		const e = ev.originalEvent || ev;
		e.preventDefault();
		e.stopPropagation();
		this.classList.remove('drop-target-folder');
		enterCounters.delete(this);
		await handleDrop(e, target.path, panelId, {
			panelState,
			navigateToDirectory,
			dropContext: { kind: 'folder-row', panelId, targetPath: target.path }
		});
	});

	// ---- Drop target: empty area of panel grid (falls back to currentPath) ----
	$grid.off('dragover.aedd-root dragenter.aedd-root dragleave.aedd-root drop.aedd-root');

	$grid[0] && $grid[0].addEventListener('dragover', (e) => {
		const row = e.target.closest && e.target.closest(ROW_SELECTOR);
		if (row && resolveRowDropTarget(row, panelId, panelState)) return; // row handler wins
		const targetDir = panelState[panelId]?.currentPath;
		if (!targetDir) return;
		e.preventDefault();
		setDropEffect(e);
	}, false);

	$grid[0] && $grid[0].addEventListener('dragenter', (e) => {
		const row = e.target.closest && e.target.closest(ROW_SELECTOR);
		if (row && resolveRowDropTarget(row, panelId, panelState)) return;
		const targetDir = panelState[panelId]?.currentPath;
		if (!targetDir) return;
		e.preventDefault();
		if (_activeDragSourcePanelId === panelId) return; // same-panel: no bg highlight
		bumpEnterCounter($grid[0]);
		$grid[0].classList.add('drop-target-panel');
	}, false);

	$grid[0] && $grid[0].addEventListener('dragleave', () => {
		if (decrementEnterCounter($grid[0]) <= 0) {
			$grid[0].classList.remove('drop-target-panel');
		}
	}, false);

	$grid[0] && $grid[0].addEventListener('drop', async (e) => {
		const row = e.target.closest && e.target.closest(ROW_SELECTOR);
		if (row && resolveRowDropTarget(row, panelId, panelState)) return;
		const targetDir = panelState[panelId]?.currentPath;
		if (!targetDir) return;
		e.preventDefault();
		$grid[0].classList.remove('drop-target-panel');
		enterCounters.delete($grid[0]);
		await handleDrop(e, targetDir, panelId, {
			panelState,
			navigateToDirectory,
			dropContext: { kind: 'panel-grid', panelId, element: $grid[0] }
		});
	}, false);

	// ---- Drop target: panel header / path bar ----
	if ($header.length && $header[0]) {
		const headerEl = $header[0];
		headerEl.addEventListener('dragover', (e) => {
			const targetDir = panelState[panelId]?.currentPath;
			if (!targetDir) return;
			e.preventDefault();
			setDropEffect(e);
		}, false);
		headerEl.addEventListener('dragenter', (e) => {
			const targetDir = panelState[panelId]?.currentPath;
			if (!targetDir) return;
			e.preventDefault();
			if (_activeDragSourcePanelId === panelId) return; // same-panel: no bg highlight
			bumpEnterCounter(headerEl);
			headerEl.classList.add('drop-target-panel');
		}, false);
		headerEl.addEventListener('dragleave', () => {
			if (decrementEnterCounter(headerEl) <= 0) {
				headerEl.classList.remove('drop-target-panel');
			}
		}, false);
		headerEl.addEventListener('drop', async (e) => {
			const targetDir = panelState[panelId]?.currentPath;
			if (!targetDir) return;
			e.preventDefault();
			headerEl.classList.remove('drop-target-panel');
			enterCounters.delete(headerEl);
			await handleDrop(e, targetDir, panelId, {
				panelState,
				navigateToDirectory,
				dropContext: { kind: 'panel-header', panelId, element: headerEl }
			});
		}, false);
	}
}

/**
 * Public entry point: attach drag-source and drop-target listeners to a
 * panel rendered in gallery (tile) mode. Mirrors {@link attachDragDropForPanel}
 * but operates on `.gallery-item` tiles inside `.panel-gallery`.
 *
 * Safe to call repeatedly; listeners are namespaced/cleared before rebinding.
 *
 * @param {number|string} panelId
 * @param {object} deps
 * @param {object} deps.panelState
 * @param {(path: string, panelId: number|string, addToHistory?: boolean) => Promise<any>} deps.navigateToDirectory
 */
export function attachDragDropForGallery(panelId, { panelState, navigateToDirectory }) {
	const $panel = jQuery(`#panel-${panelId}`);
	if ($panel.length === 0) return;
	const $gallery = $panel.find('.panel-gallery');
	if ($gallery.length === 0 || !$gallery[0]) return;
	const galleryEl = $gallery[0];
	const $header = $panel.find('.panel-header');

	// Mark every tile draggable (re-rendered every populateGalleryView call).
	$gallery.find('.gallery-item').attr('draggable', 'true');

	// ---- Drag source: gallery items ----
	$gallery.off('dragstart.aedd').on('dragstart.aedd', '.gallery-item', function (ev) {
		const e = ev.originalEvent || ev;
		const record = galleryRecordFromEl(this, panelId, panelState);
		if (!record) { e.preventDefault(); return; }
		if (record.filenameRaw === '.' || record.filenameRaw === '..') { e.preventDefault(); return; }

		const state = panelState[panelId];
		if (!state) { e.preventDefault(); return; }
		state.gallerySelectedRecids = state.gallerySelectedRecids || new Set();
		if (!state.gallerySelectedRecids.has(record.recid)) {
			state.gallerySelectedRecids = new Set([record.recid]);
			$gallery.find('.gallery-item').removeClass('gallery-item-selected');
			this.classList.add('gallery-item-selected');
		}

		const items = buildGalleryPayloadItems(panelId, panelState);
		if (items.length === 0) { e.preventDefault(); return; }

		e.dataTransfer.effectAllowed = 'copyMove';
		_activeDragSourcePanelId = panelId;
		try {
			e.dataTransfer.setData(PAYLOAD_MIME, JSON.stringify({ sourcePanelId: panelId, items }));
			e.dataTransfer.setData('text/uri-list', items.map(it => fileUri(it.path)).join('\r\n'));
			e.dataTransfer.setData('text/plain', items.map(it => it.path).join('\n'));
		} catch (_) { /* ignore */ }

		const sourceRecids = new Set(items.map(it => String(it.recid)));
		$gallery.find('.gallery-item').each(function () {
			const r = galleryRecordFromEl(this, panelId, panelState);
			if (r && sourceRecids.has(String(r.recid))) this.classList.add('dragging-source');
		});
	});

	$gallery.off('dragend.aedd').on('dragend.aedd', '.gallery-item', function () {
		$gallery.find('.gallery-item.dragging-source').removeClass('dragging-source');
		$gallery.find('.drop-target-folder').removeClass('drop-target-folder');
		galleryEl.classList.remove('drop-target-panel');
		_activeDragSourcePanelId = null;
	});

	// ---- Drop target: folder tiles ----
	$gallery.off('dragover.aedd dragenter.aedd dragleave.aedd drop.aedd');

	$gallery.on('dragover.aedd', '.gallery-item', function (ev) {
		const target = resolveGalleryDropTarget(this, panelId, panelState);
		if (!target) return;
		const e = ev.originalEvent || ev;
		e.preventDefault();
		e.stopPropagation();
		setDropEffect(e);
	});

	$gallery.on('dragenter.aedd', '.gallery-item', function (ev) {
		const target = resolveGalleryDropTarget(this, panelId, panelState);
		if (!target) return;
		const e = ev.originalEvent || ev;
		e.preventDefault();
		e.stopPropagation();
		bumpEnterCounter(this);
		this.classList.add('drop-target-folder');
	});

	$gallery.on('dragleave.aedd', '.gallery-item', function () {
		if (decrementEnterCounter(this) <= 0) {
			this.classList.remove('drop-target-folder');
		}
	});

	$gallery.on('drop.aedd', '.gallery-item', async function (ev) {
		const target = resolveGalleryDropTarget(this, panelId, panelState);
		if (!target) return;
		const e = ev.originalEvent || ev;
		e.preventDefault();
		e.stopPropagation();
		this.classList.remove('drop-target-folder');
		enterCounters.delete(this);
		await handleDrop(e, target.path, panelId, {
			panelState,
			navigateToDirectory,
			dropContext: { kind: 'gallery-tile', panelId, targetPath: target.path }
		});
	});

	// ---- Drop target: empty area of gallery (falls back to currentPath) ----
	galleryEl.addEventListener('dragover', (e) => {
		const tile = e.target.closest && e.target.closest('.gallery-item');
		if (tile && resolveGalleryDropTarget(tile, panelId, panelState)) return;
		const targetDir = panelState[panelId]?.currentPath;
		if (!targetDir) return;
		e.preventDefault();
		setDropEffect(e);
	}, false);

	galleryEl.addEventListener('dragenter', (e) => {
		const tile = e.target.closest && e.target.closest('.gallery-item');
		if (tile && resolveGalleryDropTarget(tile, panelId, panelState)) return;
		const targetDir = panelState[panelId]?.currentPath;
		if (!targetDir) return;
		e.preventDefault();
		if (_activeDragSourcePanelId === panelId) return; // same-panel: no bg highlight
		bumpEnterCounter(galleryEl);
		galleryEl.classList.add('drop-target-panel');
	}, false);

	galleryEl.addEventListener('dragleave', () => {
		if (decrementEnterCounter(galleryEl) <= 0) {
			galleryEl.classList.remove('drop-target-panel');
		}
	}, false);

	galleryEl.addEventListener('drop', async (e) => {
		const tile = e.target.closest && e.target.closest('.gallery-item');
		if (tile && resolveGalleryDropTarget(tile, panelId, panelState)) return;
		const targetDir = panelState[panelId]?.currentPath;
		if (!targetDir) return;
		e.preventDefault();
		galleryEl.classList.remove('drop-target-panel');
		enterCounters.delete(galleryEl);
		await handleDrop(e, targetDir, panelId, {
			panelState,
			navigateToDirectory,
			dropContext: { kind: 'panel-grid', panelId, element: galleryEl }
		});
	}, false);

	// ---- Drop target: panel header / path bar (also flashes panel-grid bg) ----
	if ($header.length && $header[0]) {
		const headerEl = $header[0];
		// Header listeners may already be installed by attachDragDropForPanel
		// when the panel toggled out of grid mode -- our listeners are
		// idempotent because we always preventDefault and add the same class.
		headerEl.addEventListener('dragover', (e) => {
			const targetDir = panelState[panelId]?.currentPath;
			if (!targetDir) return;
			e.preventDefault();
			setDropEffect(e);
		}, false);
		headerEl.addEventListener('dragenter', (e) => {
			const targetDir = panelState[panelId]?.currentPath;
			if (!targetDir) return;
			e.preventDefault();
			if (_activeDragSourcePanelId === panelId) return; // same-panel: no bg highlight
			bumpEnterCounter(headerEl);
			headerEl.classList.add('drop-target-panel');
		}, false);
		headerEl.addEventListener('dragleave', () => {
			if (decrementEnterCounter(headerEl) <= 0) {
				headerEl.classList.remove('drop-target-panel');
			}
		}, false);
		headerEl.addEventListener('drop', async (e) => {
			const targetDir = panelState[panelId]?.currentPath;
			if (!targetDir) return;
			e.preventDefault();
			headerEl.classList.remove('drop-target-panel');
			enterCounters.delete(headerEl);
			await handleDrop(e, targetDir, panelId, {
				panelState,
				navigateToDirectory,
				dropContext: { kind: 'panel-header', panelId, element: headerEl }
			});
		}, false);
	}
}

// ---------- Internal helpers ----------

function ensureRowsDraggable(root) {
	if (!root) return;
	const rows = root.querySelectorAll(ROW_SELECTOR);
	rows.forEach(r => {
		if (r.getAttribute('draggable') !== 'true') r.setAttribute('draggable', 'true');
	});
}

/**
 * Resolve the w2ui record object for a `<tr>` row. w2ui tags each row with
 * an `index` attribute; recid lives in `grid.records[index].recid`.
 */
function recordFromRow(rowEl, grid) {
	if (!rowEl || !grid) return null;
	const idxAttr = rowEl.getAttribute('index');
	if (idxAttr == null) return null;
	const idx = parseInt(idxAttr, 10);
	if (!Number.isFinite(idx)) return null;
	return grid.records[idx] || null;
}

const observers = new Map();
function observeRowsForDraggable(panelId, root) {
	if (!root) return;
	const existing = observers.get(panelId);
	if (existing) existing.disconnect();
	const obs = new MutationObserver(() => ensureRowsDraggable(root));
	obs.observe(root, { childList: true, subtree: true });
	observers.set(panelId, obs);
}

function fileUri(absPath) {
	// Minimal file:// URI for Windows/POSIX. Not used for actual transfers yet.
	const p = absPath.replace(/\\/g, '/');
	return 'file:///' + encodeURI(p.replace(/^\//, ''));
}

function buildPayloadItems(grid) {
	const selected = grid.getSelection();
	const records = selected
		.map(recid => grid.records.find(r => String(r.recid) === String(recid)))
		.filter(Boolean)
		.filter(r => r.filenameRaw !== '.' && r.filenameRaw !== '..')
		.filter(r => r.path);
	return records.map(r => ({
		recid: r.recid,
		path: r.path,
		inode: r.inode,
		dir_id: r.dir_id,
		isFolder: !!r.isFolder,
		filename: r.filenameRaw || r.filename
	}));
}

/**
 * Decide whether a grid row is a legitimate drop target. Returns the target
 * directory path to drop into, or null if the row is a file (invalid).
 */
function resolveRowDropTarget(rowEl, panelId, panelState) {
	const grid = panelState[panelId]?.w2uiGrid;
	if (!grid) return null;
	const record = recordFromRow(rowEl, grid);
	if (!record) return null;
	// ".." row acts as "parent of current dir".
	if (record.filenameRaw === '..') {
		const current = panelState[panelId]?.currentPath;
		if (!current) return null;
		const parent = parentPath(current);
		return parent ? { path: parent, record } : null;
	}
	// Skip "." and non-folders.
	if (record.filenameRaw === '.' || !record.isFolder) return null;
	if (!record.path) return null;
	return { path: record.path, record };
}

function parentPath(p) {
	if (!p) return null;
	const normalized = p.replace(/[\\/]+$/, '');
	const sepIdx = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
	if (sepIdx <= 0) {
		// Root like "C:\" or "/" has no navigable parent.
		return null;
	}
	return normalized.slice(0, sepIdx) || null;
}

function setDropEffect(e) {
	const isCopy = !!(e.ctrlKey || e.metaKey);
	try { e.dataTransfer.dropEffect = isCopy ? 'copy' : 'move'; } catch (_) { /* ignore */ }
}

function bumpEnterCounter(el) {
	const n = (enterCounters.get(el) || 0) + 1;
	enterCounters.set(el, n);
	return n;
}
function decrementEnterCounter(el) {
	const n = (enterCounters.get(el) || 0) - 1;
	if (n <= 0) enterCounters.delete(el);
	else enterCounters.set(el, n);
	return n;
}

function clearDropHighlights($panel) {
	$panel.find('.drop-target-folder').removeClass('drop-target-folder');
	$panel.find('.drop-target-panel').removeClass('drop-target-panel');
}

/**
 * Swap a live hover class (e.g. 'drop-target-folder') for its fade sibling
 * (e.g. 'drop-target-folder-fade') on drop. The CSS animation auto-removes
 * the background/shadow over 5s; we clean the class up when the animation
 * ends so repeated drops restart cleanly.
 */
function triggerDropFade(el, baseClass) {
	if (!el) return;
	el.classList.remove(baseClass);
	const fadeClass = baseClass + '-fade';
	// Force a style recompute so adding the animation class restarts it even
	// if the same element was faded a moment ago.
	el.classList.remove(fadeClass);
	// eslint-disable-next-line no-unused-expressions
	el.offsetWidth;
	el.classList.add(fadeClass);
	const cleanup = () => {
		el.classList.remove(fadeClass);
		el.removeEventListener('animationend', cleanup);
	};
	el.addEventListener('animationend', cleanup);
	// Safety: if the browser misses animationend (e.g. element hidden), remove
	// the class after the animation's duration anyway.
	setTimeout(() => el.classList.remove(fadeClass), 5200);
}

/**
 * Shared drop handler. Parses the payload, validates, prompts on collisions,
 * dispatches IPC, and refreshes affected panels.
 */
async function handleDrop(event, targetDirPath, targetPanelId, { panelState, navigateToDirectory, dropContext }) {
	// Clear live hover-state classes everywhere, but leave any *-fade classes
	// in place so the 5s fade on the actual drop target can play through.
	document.querySelectorAll('.drop-target-folder, .drop-target-panel').forEach(el => {
		el.classList.remove('drop-target-folder');
		el.classList.remove('drop-target-panel');
	});
	document.querySelectorAll('.dragging-source').forEach(el => el.classList.remove('dragging-source'));

	let payload = null;
	try {
		const raw = event.dataTransfer.getData(PAYLOAD_MIME);
		if (raw) payload = JSON.parse(raw);
	} catch (_) { /* ignore */ }

	if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) {
		// External drops are a later phase; ignore for now.
		return;
	}

	// Filter out ./.. just in case, and drop any item whose parent equals the
	// target dir (pure no-op).
	const items = payload.items.filter(it => it.filename !== '.' && it.filename !== '..' && it.path);
	if (items.length === 0) return;

	// Block dropping a folder into itself or a descendant.
	for (const it of items) {
		if (it.isFolder && isAncestorOrSelf(it.path, targetDirPath)) {
			await alertAsync(`Cannot drop "${it.filename}" into itself or one of its subfolders.`);
			return;
		}
	}

	// Determine operation: move (default) or copy (Ctrl/Cmd).
	const isCopy = !!(event.ctrlKey || event.metaKey);

	// Pre-flight collision check.
	let collisions = [];
	try {
		const result = await window.electronAPI.checkCollisions(items, targetDirPath);
		collisions = Array.isArray(result?.collisions) ? result.collisions : [];
	} catch (err) {
		// Non-fatal; backend will still report per-item failures.
		collisions = [];
	}

	let onCollision = 'fail';
	if (collisions.length > 0) {
		const choice = await promptCollisionChoice(collisions, isCopy);
		if (choice === 'cancel' || !choice) return;
		onCollision = choice;
	}

	// Dispatch.
	let result;
	try {
		result = isCopy
			? await window.electronAPI.copyItems(items, targetDirPath, onCollision)
			: await window.electronAPI.moveItems(items, targetDirPath, onCollision);
	} catch (err) {
		w2alert(`Error ${isCopy ? 'copying' : 'moving'} items: ${err?.message || 'Unknown error'}`);
		return;
	}

	// Surface failures (skipped are silent).
	if (Array.isArray(result?.failed) && result.failed.length > 0) {
		w2alert(`Failed to ${isCopy ? 'copy' : 'move'}:\n` +
			result.failed.map(f => `${f.path}: ${f.error}`).join('\n'));
	}

	// Refresh every panel whose currentPath touches source or destination.
	const affected = new Set();
	affected.add(path.resolve(targetDirPath));
	for (const it of items) {
		affected.add(path.resolve(parentPath(it.path) || it.path));
	}
	const ids = Object.keys(panelState || {});
	for (const id of ids) {
		const cp = panelState[id]?.currentPath;
		if (!cp) continue;
		if (affected.has(path.resolve(cp))) {
			try { await navigateToDirectory(cp, id, false); } catch (_) { /* ignore */ }
		}
	}

	// Post-move confirmation: flash the destination so the user can see where
	// the items landed. Done after refresh so we target the live DOM rather
	// than rows that have been replaced by the panel re-render.
	const succeededCount = Array.isArray(result?.succeeded) ? result.succeeded.length : 0;
	if (succeededCount > 0 && dropContext) {
		// Defer to next frame so w2ui has flushed its post-refresh DOM.
		const fade = (attempt = 0) => {
			try {
				if (dropContext.kind === 'folder-row') {
					const row = findRowByPath(dropContext.panelId, dropContext.targetPath);
					if (row) { triggerDropFade(row, 'drop-target-folder'); return; }
					if (attempt < 5) { requestAnimationFrame(() => fade(attempt + 1)); }
				} else if (dropContext.kind === 'gallery-tile') {
					const tile = findGalleryTileByPath(dropContext.panelId, dropContext.targetPath, panelState);
					if (tile) { triggerDropFade(tile, 'drop-target-folder'); return; }
					if (attempt < 5) { requestAnimationFrame(() => fade(attempt + 1)); }
				} else if (dropContext.element && document.body.contains(dropContext.element)) {
					triggerDropFade(dropContext.element, 'drop-target-panel');
				}
			} catch (_) { /* non-fatal */ }
		};
		requestAnimationFrame(() => fade(0));
	}
}

/**
 * Find the live <tr> in a panel whose w2ui record's full path matches the
 * given absolute path. Used after a refresh to re-locate the destination
 * folder row so we can flash it as drop confirmation.
 */
function findRowByPath(panelId, fullPath) {
	const gridName = `grid-panel-${panelId}`;
	const grid = (typeof w2ui !== 'undefined') && w2ui[gridName];
	if (!grid || !Array.isArray(grid.records)) return null;
	const want = path.resolve(fullPath);
	let rec = null;
	for (let i = 0; i < grid.records.length; i++) {
		const r = grid.records[i];
		if (!r) continue;
		const p = r.path || (r.directory && r.filenameRaw ? `${r.directory}/${r.filenameRaw}` : null);
		if (p && path.resolve(p) === want) { rec = r; break; }
	}
	if (!rec) return null;
	// w2ui assigns id="grid_<gridName>_rec_<recid>" to row elements.
	return document.getElementById(`grid_${gridName}_rec_${rec.recid}`)
		|| document.querySelector(`#grid_${gridName}_frec_${rec.recid}`)
		|| null;
}

/**
 * Find the live `.gallery-item` tile in a panel whose record path matches the
 * given absolute path. Used after a refresh to flash the destination tile.
 */
function findGalleryTileByPath(panelId, fullPath, panelState) {
	const want = path.resolve(fullPath);
	const records = panelState?.[panelId]?.galleryRecords || [];
	if (records.length === 0) return null;
	let rec = null;
	for (const r of records) {
		if (r && r.path && path.resolve(r.path) === want) { rec = r; break; }
	}
	if (!rec) return null;
	return document.querySelector(`#panel-${panelId} .panel-gallery .gallery-item[data-recid="${rec.recid}"]`)
		|| null;
}

function galleryRecordFromEl(el, panelId, panelState) {
	if (!el) return null;
	const recid = parseInt(el.getAttribute('data-recid'), 10);
	if (!Number.isFinite(recid)) return null;
	const records = panelState?.[panelId]?.galleryRecords || [];
	return records.find(r => r.recid === recid) || null;
}

function buildGalleryPayloadItems(panelId, panelState) {
	const state = panelState?.[panelId];
	if (!state) return [];
	const records = state.galleryRecords || [];
	const sel = state.gallerySelectedRecids || new Set();
	return records
		.filter(r => sel.has(r.recid))
		.filter(r => r.filenameRaw !== '.' && r.filenameRaw !== '..')
		.filter(r => r.path)
		.map(r => ({
			recid: r.recid,
			path: r.path,
			inode: r.inode,
			dir_id: r.dir_id,
			isFolder: !!r.isFolder,
			filename: r.filenameRaw || r.filename
		}));
}

/**
 * Decide whether a gallery tile is a legitimate drop target. Returns the
 * target directory path to drop into, or null if the tile is a file (invalid).
 */
function resolveGalleryDropTarget(tileEl, panelId, panelState) {
	const record = galleryRecordFromEl(tileEl, panelId, panelState);
	if (!record) return null;
	if (record.filenameRaw === '..') {
		const current = panelState[panelId]?.currentPath;
		if (!current) return null;
		const parent = parentPath(current);
		return parent ? { path: parent, record } : null;
	}
	if (record.filenameRaw === '.' || !record.isFolder) return null;
	if (!record.path) return null;
	return { path: record.path, record };
}

// Lightweight `path.resolve` replacement for the renderer (Node's path isn't
// available in the browser). Lower-cases drive letters on Windows for stable
// comparison.
const path = {
	resolve(p) {
		if (!p) return '';
		let out = String(p).replace(/[\\/]+$/, '');
		if (/^[a-zA-Z]:/.test(out)) out = out.charAt(0).toLowerCase() + out.slice(1);
		return out;
	}
};

function isAncestorOrSelf(ancestor, candidate) {
	const a = path.resolve(ancestor).toLowerCase();
	const c = path.resolve(candidate).toLowerCase();
	if (a === c) return true;
	return c.startsWith(a + '/') || c.startsWith(a + '\\');
}

function alertAsync(msg) {
	return new Promise(resolve => {
		try { w2alert(msg).done(() => resolve()); }
		catch (_) { window.alert(msg); resolve(); }
	});
}

/**
 * Prompt the user with four choices: Overwrite / Skip / Rename / Cancel.
 * Uses w2confirm's yes/no/btn interface with relabeled buttons. Returns the
 * chosen directive string or 'cancel'.
 */
function promptCollisionChoice(collisions, isCopy) {
	const verb = isCopy ? 'copy' : 'move';
	const preview = collisions.slice(0, 5).map(c => `• ${c.filename}`).join('\n');
	const extra = collisions.length > 5 ? `\n(and ${collisions.length - 5} more)` : '';
	const msg = `${collisions.length} item${collisions.length === 1 ? '' : 's'} already exist in the destination:\n\n${preview}${extra}\n\nHow should the ${verb} handle the conflicts?`;

	return new Promise(resolve => {
		// w2confirm only exposes yes/no natively. We render a small custom popup
		// via w2confirm's htmlButtons hook when available; otherwise fall back
		// to a simple prompt.
		try {
			w2confirm({
				title: `Confirm ${verb}`,
				text: msg.replace(/\n/g, '<br>'),
				yes_text: 'Overwrite',
				no_text: 'Cancel',
				btn_yes: { class: 'w2ui-btn-red' },
				callBack: (ans) => {
					// Two-button confirm: Overwrite or Cancel.
					resolve(ans === 'yes' ? 'overwrite' : 'cancel');
				}
			});
			// Inject a Skip and Rename button alongside Yes/No after render.
			setTimeout(() => injectExtraCollisionButtons(resolve), 0);
		} catch (_) {
			const choice = window.prompt(
				`${msg}\n\nType: overwrite, skip, rename, or cancel`,
				'rename'
			);
			resolve((choice || 'cancel').toLowerCase());
		}
	});
}

function injectExtraCollisionButtons(resolve) {
	const popup = document.querySelector('#w2ui-popup .w2ui-popup-buttons');
	if (!popup) return;
	if (popup.querySelector('.aedd-extra-btn')) return;

	const mkBtn = (label, directive) => {
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'w2ui-btn aedd-extra-btn';
		b.textContent = label;
		b.addEventListener('click', () => {
			resolve(directive);
			try { w2ui.w2popup && w2ui.w2popup.close && w2ui.w2popup.close(); } catch (_) { /* ignore */ }
			try { window.w2popup && window.w2popup.close && window.w2popup.close(); } catch (_) { /* ignore */ }
		});
		return b;
	};

	const skipBtn = mkBtn('Skip', 'skip');
	const renameBtn = mkBtn('Rename', 'rename');
	// Insert Skip + Rename between the Yes (Overwrite) and No (Cancel) buttons.
	const yesBtn = popup.querySelector('button.w2ui-btn[name="yes"]') || popup.firstElementChild;
	if (yesBtn && yesBtn.nextSibling) {
		popup.insertBefore(skipBtn, yesBtn.nextSibling);
		popup.insertBefore(renameBtn, yesBtn.nextSibling);
	} else {
		popup.appendChild(renameBtn);
		popup.appendChild(skipBtn);
	}
}
