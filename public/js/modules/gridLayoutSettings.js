/**
 * Grid Layout Settings — matrix modal for the three-layer grid-layout
 * inheritance chain (Global -> Category -> Local).
 *
 * Each layer is a sparse "v2 layer": { version: 2, columns: {field: unit},
 * order?: [fields...], sortData?: [{field, direction}...] }. A column unit
 * ({size, hidden, sizeConfig?}) is set-or-inherited as a whole; `order` and
 * `sortData` are independent units. `sortData: []` is an explicit "no sort"
 * that overrides an inherited sort; an absent key inherits.
 *
 * This module must not import panels.js — all panel/grid access flows through
 * the context object passed to open() (avoids a circular import).
 */

import * as utils from './utils.js';
import { w2tooltip } from './vendor/w2ui.es6.min.js';

const SCOPES = ['global', 'category', 'local'];
const SCOPE_CHIPS = { global: 'G', category: 'C', local: 'L' };
const EDITOR_OVERLAY = 'gls-cell-editor';

/**
 * Resolve the effective layout from the three layers (any may be null).
 * Later layers win per column unit and per order/sort unit. Also reports
 * which layer each piece came from for the Effective column's source chips.
 */
export function resolveEffectiveLayout(global, category, local) {
	const out = {
		columns: {}, columnsSource: {},
		order: undefined, orderSource: null,
		sortData: undefined, sortSource: null
	};
	for (const [name, layer] of [['global', global], ['category', category], ['local', local]]) {
		if (!layer) continue;
		for (const [field, unit] of Object.entries(layer.columns || {})) {
			out.columns[field] = unit;
			out.columnsSource[field] = name;
		}
		if (layer.order !== undefined) { out.order = layer.order; out.orderSource = name; }
		if (layer.sortData !== undefined) { out.sortData = layer.sortData; out.sortSource = name; }
	}
	return out;
}

export function isEmptyLayer(layer) {
	if (!layer) return true;
	const hasColumns = layer.columns && Object.keys(layer.columns).length > 0;
	return !hasColumns && layer.order === undefined && layer.sortData === undefined;
}

// ---------- Modal state ----------

let ctx = null;            // context from panels.js (see open())
let draft = null;          // { global, category, local } — v2 layers, edited in place
let dirty = null;          // { global, category, local } — booleans
let live = null;           // { columns: {field: unit}, order: [fields], sortData: [...] }
let discardArmTimer = null;
let uiInitialized = false;

function modalEl() { return document.getElementById('grid-layout-settings-modal'); }

export function isOpen() {
	const el = modalEl();
	return !!el && el.style.display !== 'none';
}

function emptyLayer() {
	return { version: 2, columns: {} };
}

function cloneLayer(layer) {
	return layer ? structuredClone(layer) : emptyLayer();
}

function isEditorOpen() {
	return !!document.querySelector(`#w2overlay-${EDITOR_OVERLAY}`);
}

function closeEditor() {
	w2tooltip.hide(EDITOR_OVERLAY);
}

/**
 * Escape routing for the renderer's transient-escape chain: close an open
 * cell-editor popover first; otherwise request modal close (dirty-aware).
 * Returns true when the key was consumed.
 */
export function handleEscape() {
	if (!isOpen()) return false;
	if (isEditorOpen()) {
		closeEditor();
		return true;
	}
	requestClose();
	return true;
}

// ---------- Open / close ----------

/**
 * Open the modal for a panel. Context shape:
 *   { panelId, dirPath, categoryName, labels: {field: label},
 *     gridFields: [field...] (current grid order),
 *     serializeColumns() -> [{field,size,hidden,sizeConfig?}] of the live grid,
 *     liveSortData() -> [{field,direction}],
 *     applyResolvedLayout(eff), snapshotSession() }
 */
export async function open(context) {
	ctx = context;
	draft = null;
	dirty = { global: false, category: false, local: false };
	disarmDiscard();
	setError('');

	// Geometry-first: show the shell immediately, fill when the IPC resolves
	document.getElementById('gls-dir-path').textContent = ctx.dirPath;
	document.getElementById('gls-category-name').textContent =
		ctx.categoryName ? `Category: ${ctx.categoryName}` : 'No category';
	document.getElementById('gls-category-header').textContent = 'Category';
	document.getElementById('gls-matrix-body').innerHTML =
		'<tr><td colspan="5" class="gls-loading">Loading layers…</td></tr>';
	document.getElementById('btn-gls-capture-category').disabled = !ctx.categoryName;
	modalEl().style.display = 'block';

	// Snapshot the live grid — the capture source and divergence reference
	const liveColumns = {};
	const liveOrder = [];
	for (const col of ctx.serializeColumns()) {
		const unit = { size: col.size, hidden: !!col.hidden };
		if (col.sizeConfig) unit.sizeConfig = { ...col.sizeConfig };
		liveColumns[col.field] = unit;
		liveOrder.push(col.field);
	}
	live = { columns: liveColumns, order: liveOrder, sortData: ctx.liveSortData() };

	let res;
	try {
		res = await window.electronAPI.getGridLayoutLayers(ctx.dirPath, ctx.categoryName);
	} catch (err) {
		res = { success: false, error: String(err) };
	}
	if (!res?.success) {
		setError('Failed to load layout layers: ' + (res?.error || 'Unknown error'));
		document.getElementById('gls-matrix-body').innerHTML = '';
		return;
	}
	draft = {
		global: cloneLayer(res.layers.global),
		category: cloneLayer(res.layers.category),
		local: cloneLayer(res.layers.local)
	};
	renderMatrix();
}

export function close() {
	closeEditor();
	disarmDiscard();
	modalEl().style.display = 'none';
	ctx = null;
	draft = null;
	live = null;
}

function anyDirty() {
	return dirty && (dirty.global || dirty.category || dirty.local);
}

/**
 * Close with a two-step inline confirm when there are unsaved edits:
 * the first attempt arms the Cancel button ("Discard changes?") for 2.5s,
 * a second attempt within that window discards and closes. No popups.
 */
export function requestClose() {
	if (!anyDirty()) { close(); return; }
	const cancelBtn = document.getElementById('btn-gls-cancel');
	if (cancelBtn.classList.contains('gls-discard-armed')) {
		close();
		return;
	}
	cancelBtn.classList.add('gls-discard-armed');
	cancelBtn.textContent = 'Discard changes?';
	discardArmTimer = setTimeout(disarmDiscard, 2500);
}

function disarmDiscard() {
	if (discardArmTimer) { clearTimeout(discardArmTimer); discardArmTimer = null; }
	const cancelBtn = document.getElementById('btn-gls-cancel');
	if (cancelBtn) {
		cancelBtn.classList.remove('gls-discard-armed');
		cancelBtn.textContent = 'Cancel';
	}
}

function setError(msg) {
	const el = document.getElementById('gls-error');
	if (el) el.textContent = msg || '';
}

function markDirty(scope) {
	dirty[scope] = true;
	disarmDiscard();
	document.getElementById('gls-dirty-hint').style.display = 'inline';
}

// ---------- Save ----------

export async function save() {
	if (!ctx) return;
	if (!anyDirty()) { close(); return; }
	setError('');
	const keys = { global: null, category: ctx.categoryName, local: ctx.dirPath };
	const failures = [];
	for (const scope of SCOPES) {
		if (!dirty[scope]) continue;
		const layer = isEmptyLayer(draft[scope]) ? null : draft[scope];
		let res;
		try {
			res = await window.electronAPI.setGridLayoutLayer(scope, keys[scope], layer);
		} catch (err) {
			res = { success: false, error: String(err) };
		}
		if (res?.success) {
			dirty[scope] = false;
		} else {
			failures.push(`${scope}: ${res?.error || 'saving is unavailable'}`);
		}
	}
	if (failures.length > 0) {
		setError('Failed to save — ' + failures.join('; '));
		return;
	}
	// Apply the new effective layout to the panel and refresh the session
	// snapshot so navigating away/back doesn't resurrect the pre-save state.
	const eff = resolveEffectiveLayout(draft.global, draft.category, draft.local);
	ctx.applyResolvedLayout(eff);
	ctx.snapshotSession();
	close();
}

// ---------- Matrix rendering ----------

function fieldLabel(field) {
	return (ctx.labels && ctx.labels[field]) || field;
}

function summarizeColumnUnit(unit) {
	if (!unit) return '<span class="gls-unset">—</span>';
	const parts = [];
	if (unit.size != null) parts.push(utils.escapeHtml(String(unit.size)));
	if (unit.hidden) parts.push('<span class="gls-tag">hidden</span>');
	if (unit.sizeConfig?.mode) {
		const glyph = { fixed: 'F', scale: 'S', fit: '%' }[unit.sizeConfig.mode] || '?';
		parts.push(`<span class="gls-mode" title="Size mode: ${utils.escapeHtml(unit.sizeConfig.mode)}">${glyph}</span>`);
	}
	return parts.join(' ') || '<span class="gls-unset">—</span>';
}

function summarizeSort(sortData) {
	if (sortData === undefined) return '<span class="gls-unset">—</span>';
	if (sortData.length === 0) return '<span class="gls-tag">no sort</span>';
	return sortData
		.map(s => `${utils.escapeHtml(fieldLabel(s.field))} ${s.direction === 'desc' ? '↓' : '↑'}`)
		.join(', ');
}

function summarizeOrder(order) {
	if (order === undefined) return '<span class="gls-unset">—</span>';
	const full = order.map(f => fieldLabel(f)).join(' → ');
	return `<span class="gls-tag" title="${utils.escapeHtml(full)}">set (${order.length})</span>`;
}

function sourceChip(source) {
	if (!source) return '';
	return ` <span class="gls-chip gls-chip-${source}" title="From ${source} layer">${SCOPE_CHIPS[source]}</span>`;
}

function cellHtml(rowKey, scope, contentHtml, editable) {
	const attrs = editable
		? ` class="gls-cell gls-editable" data-gls-cell data-row="${utils.escapeHtml(rowKey)}" data-scope="${scope}" title="Click to edit"`
		: ' class="gls-cell gls-na"';
	return `<td${attrs}>${contentHtml}</td>`;
}

function renderMatrix() {
	if (!ctx || !draft) return;
	const eff = resolveEffectiveLayout(draft.global, draft.category, draft.local);
	const rows = [];

	// Special rows: Sort, then Column order
	{
		let cells = '';
		for (const scope of SCOPES) {
			if (scope === 'category' && !ctx.categoryName) {
				cells += cellHtml('__sort', scope, '<span class="gls-unset">n/a</span>', false);
			} else {
				cells += cellHtml('__sort', scope, summarizeSort(draft[scope].sortData), true);
			}
		}
		const effHtml = eff.sortData !== undefined
			? summarizeSort(eff.sortData) + sourceChip(eff.sortSource)
			: '<span class="gls-unset">session/default</span>';
		rows.push(`<tr><td class="gls-row-label gls-row-special">Sort</td>${cells}<td class="gls-cell gls-effective">${effHtml}</td></tr>`);
	}
	{
		let cells = '';
		for (const scope of SCOPES) {
			if (scope === 'category' && !ctx.categoryName) {
				cells += cellHtml('__order', scope, '<span class="gls-unset">n/a</span>', false);
			} else {
				cells += cellHtml('__order', scope, summarizeOrder(draft[scope].order), true);
			}
		}
		const effHtml = eff.order !== undefined
			? summarizeOrder(eff.order) + sourceChip(eff.orderSource)
			: '<span class="gls-unset">session/default</span>';
		rows.push(`<tr><td class="gls-row-label gls-row-special">Column order</td>${cells}<td class="gls-cell gls-effective">${effHtml}</td></tr>`);
	}

	// Column rows: live grid order first, then fields only present in stored layers
	const storedOnly = new Set();
	for (const scope of SCOPES) {
		for (const field of Object.keys(draft[scope].columns || {})) {
			if (!live.columns[field]) storedOnly.add(field);
		}
	}
	const allFields = [...live.order, ...storedOnly];

	for (const field of allFields) {
		const isAttr = field.startsWith('attr_');
		const inGrid = !!live.columns[field];
		let cells = '';
		for (const scope of SCOPES) {
			if (scope === 'global' && isAttr) {
				// Attribute columns are category-scoped — meaningless globally
				cells += cellHtml(field, scope, '<span class="gls-unset">n/a</span>', false);
			} else if (scope === 'category' && !ctx.categoryName) {
				cells += cellHtml(field, scope, '<span class="gls-unset">n/a</span>', false);
			} else {
				cells += cellHtml(field, scope, summarizeColumnUnit(draft[scope].columns[field]), true);
			}
		}
		const effUnit = eff.columns[field];
		const effHtml = effUnit
			? summarizeColumnUnit(effUnit) + sourceChip(eff.columnsSource[field])
			: '<span class="gls-unset">session/default</span>';
		const badge = inGrid ? '' : ' <span class="gls-tag gls-stale" title="This field is not in the current grid — stored value can be cleared">not in current grid</span>';
		rows.push(`<tr><td class="gls-row-label">${utils.escapeHtml(fieldLabel(field))}${badge}</td>${cells}<td class="gls-cell gls-effective">${effHtml}</td></tr>`);
	}

	document.getElementById('gls-matrix-body').innerHTML = rows.join('');
	document.getElementById('gls-category-header').textContent =
		ctx.categoryName ? `Category (${ctx.categoryName})` : 'Category';
	document.getElementById('gls-dirty-hint').style.display = anyDirty() ? 'inline' : 'none';
	updateDivergenceBanner(eff);
}

/**
 * Show the divergence banner when the live grid (session state) differs from
 * what the persisted layers would produce — i.e. the user has unsaved
 * session-only tweaks relative to the draft's effective layout.
 */
function updateDivergenceBanner(eff) {
	let diverged = false;
	for (const [field, unit] of Object.entries(eff.columns)) {
		const liveUnit = live.columns[field];
		if (!liveUnit) continue;
		if (String(liveUnit.size) !== String(unit.size) || !!liveUnit.hidden !== !!unit.hidden) {
			diverged = true;
			break;
		}
	}
	if (!diverged && eff.sortData !== undefined) {
		const a = JSON.stringify(live.sortData);
		const b = JSON.stringify(eff.sortData);
		if (a !== b) diverged = true;
	}
	if (!diverged && eff.order !== undefined) {
		const liveSubset = live.order.filter(f => eff.order.includes(f));
		const effSubset = eff.order.filter(f => live.columns[f]);
		if (JSON.stringify(liveSubset) !== JSON.stringify(effSubset)) diverged = true;
	}
	document.getElementById('gls-divergence').style.display = diverged ? 'block' : 'none';
}

// ---------- Capture ----------

function captureIntoLayer(scope) {
	if (!draft) return;
	if (scope === 'category' && !ctx.categoryName) return;
	const columns = {};
	for (const [field, unit] of Object.entries(live.columns)) {
		if (scope === 'global' && field.startsWith('attr_')) continue;
		columns[field] = structuredClone(unit);
	}
	const order = scope === 'global'
		? live.order.filter(f => !f.startsWith('attr_'))
		: [...live.order];
	draft[scope] = {
		version: 2,
		columns,
		order,
		// Explicit capture: an unsorted grid captures as explicit "no sort"
		sortData: live.sortData.map(s => ({ ...s }))
	};
	markDirty(scope);
	renderMatrix();
}

// ---------- Cell editors (anchored popovers) ----------

function openCellEditor(rowKey, scope, anchorEl) {
	closeEditor();
	let html;
	if (rowKey === '__sort') html = buildSortEditorHtml(scope);
	else if (rowKey === '__order') html = buildOrderEditorHtml(scope);
	else html = buildColumnEditorHtml(rowKey, scope);

	w2tooltip.show({
		name: EDITOR_OVERLAY,
		anchor: anchorEl,
		html,
		class: 'gls-editor-overlay',
		position: 'bottom|top',
		align: 'left',
		arrowSize: 10,
		hideOn: ['doc-click'],
		maxWidth: 340,
		onShow: () => setTimeout(() => bindCellEditor(rowKey, scope), 0)
	});
	setTimeout(() => bindCellEditor(rowKey, scope), 0);
}

function scopeTitle(scope) {
	if (scope === 'category') return `Category (${ctx.categoryName})`;
	return scope.charAt(0).toUpperCase() + scope.slice(1);
}

function buildColumnEditorHtml(field, scope) {
	const unit = draft[scope].columns[field];
	// Prefill from the set unit, else from the live grid as a starting point
	const base = unit || live.columns[field] || {};
	const sizePx = parseInt(base.size, 10);
	const cfg = base.sizeConfig || {};
	const inGrid = !!live.columns[field];
	return `
		<div class="gls-editor" data-gls-editor>
			<div class="gls-editor-title">${utils.escapeHtml(fieldLabel(field))} — ${utils.escapeHtml(scopeTitle(scope))}</div>
			<div class="gls-editor-row">
				<label>Width</label>
				<input type="number" min="1" step="1" data-gls-size value="${isNaN(sizePx) ? '' : sizePx}" placeholder="px"> px
			</div>
			<div class="gls-editor-row">
				<label><input type="checkbox" data-gls-hidden ${base.hidden ? 'checked' : ''}> Hidden</label>
			</div>
			<div class="gls-editor-row">
				<label>Size mode</label>
				<select data-gls-mode>
					<option value="" ${!cfg.mode ? 'selected' : ''}>(none)</option>
					<option value="fixed" ${cfg.mode === 'fixed' ? 'selected' : ''}>Fixed</option>
					<option value="scale" ${cfg.mode === 'scale' ? 'selected' : ''}>Scale</option>
					<option value="fit" ${cfg.mode === 'fit' ? 'selected' : ''}>Fit</option>
				</select>
			</div>
			<div class="gls-editor-row">
				<label>Fit %</label>
				<input type="number" min="0" max="100" step="1" data-gls-fit value="${cfg.fitPercent != null ? cfg.fitPercent : ''}" placeholder="—">
				<label>Min</label>
				<input type="number" min="0" step="1" data-gls-min value="${cfg.min != null ? cfg.min : ''}" placeholder="—">
				<label>Max</label>
				<input type="number" min="0" step="1" data-gls-max value="${cfg.max != null ? cfg.max : ''}" placeholder="—">
			</div>
			<div class="gls-editor-error" data-gls-editor-error></div>
			<div class="gls-editor-actions">
				<button data-gls-from-current ${inGrid ? '' : 'disabled title="Field is not in the current grid"'}>Set from current</button>
				<button data-gls-clear ${unit ? '' : 'disabled'}>Clear</button>
				<button data-gls-apply class="gls-primary">Apply</button>
			</div>
		</div>
	`;
}

function buildSortEditorHtml(scope) {
	const sortData = draft[scope].sortData;
	const current = (sortData && sortData.length > 0) ? sortData[0] : null;
	const options = live.order
		.map(f => `<option value="${utils.escapeHtml(f)}" ${current?.field === f ? 'selected' : ''}>${utils.escapeHtml(fieldLabel(f))}</option>`)
		.join('');
	return `
		<div class="gls-editor" data-gls-editor>
			<div class="gls-editor-title">Sort — ${utils.escapeHtml(scopeTitle(scope))}</div>
			<div class="gls-editor-row">
				<select data-gls-sort-field>${options}</select>
				<select data-gls-sort-dir>
					<option value="asc" ${current?.direction !== 'desc' ? 'selected' : ''}>Ascending</option>
					<option value="desc" ${current?.direction === 'desc' ? 'selected' : ''}>Descending</option>
				</select>
				<button data-gls-apply class="gls-primary">Apply</button>
			</div>
			<div class="gls-editor-actions">
				<button data-gls-sort-none>No sort</button>
				<button data-gls-from-current>Set from current</button>
				<button data-gls-clear ${sortData !== undefined ? '' : 'disabled'}>Clear (inherit)</button>
			</div>
		</div>
	`;
}

function buildOrderEditorHtml(scope) {
	const order = draft[scope].order;
	const currentDesc = order !== undefined
		? order.map(f => fieldLabel(f)).join(' → ')
		: 'not set (inherits)';
	return `
		<div class="gls-editor" data-gls-editor>
			<div class="gls-editor-title">Column order — ${utils.escapeHtml(scopeTitle(scope))}</div>
			<div class="gls-editor-note">${utils.escapeHtml(currentDesc)}</div>
			<div class="gls-editor-note gls-editor-hint">To change the order, reorder the live grid columns (drag mode), then capture here.</div>
			<div class="gls-editor-actions">
				<button data-gls-from-current class="gls-primary">Set from current grid order</button>
				<button data-gls-clear ${order !== undefined ? '' : 'disabled'}>Clear (inherit)</button>
			</div>
		</div>
	`;
}

function bindCellEditor(rowKey, scope) {
	const root = document.querySelector(`#w2overlay-${EDITOR_OVERLAY} [data-gls-editor]`);
	if (!root) return;

	function commit() {
		markDirty(scope);
		renderMatrix();
		closeEditor();
	}

	const applyBtn = root.querySelector('[data-gls-apply]');
	const clearBtn = root.querySelector('[data-gls-clear]');
	const fromCurrentBtn = root.querySelector('[data-gls-from-current]');

	if (rowKey === '__sort') {
		applyBtn?.addEventListener('click', () => {
			const field = root.querySelector('[data-gls-sort-field]').value;
			const direction = root.querySelector('[data-gls-sort-dir]').value;
			draft[scope].sortData = [{ field, direction }];
			commit();
		});
		root.querySelector('[data-gls-sort-none]')?.addEventListener('click', () => {
			draft[scope].sortData = [];
			commit();
		});
		fromCurrentBtn?.addEventListener('click', () => {
			draft[scope].sortData = live.sortData.map(s => ({ ...s }));
			commit();
		});
		clearBtn?.addEventListener('click', () => {
			delete draft[scope].sortData;
			commit();
		});
		return;
	}

	if (rowKey === '__order') {
		fromCurrentBtn?.addEventListener('click', () => {
			draft[scope].order = scope === 'global'
				? live.order.filter(f => !f.startsWith('attr_'))
				: [...live.order];
			commit();
		});
		clearBtn?.addEventListener('click', () => {
			delete draft[scope].order;
			commit();
		});
		return;
	}

	// Column-unit editor
	const field = rowKey;
	const sizeInput = root.querySelector('[data-gls-size]');
	const errorEl = root.querySelector('[data-gls-editor-error]');

	function readUnit() {
		const px = parseInt(sizeInput.value, 10);
		if (isNaN(px) || px <= 0) {
			sizeInput.classList.add('gls-input-invalid');
			errorEl.textContent = 'Width must be a positive number of pixels.';
			return null;
		}
		sizeInput.classList.remove('gls-input-invalid');
		errorEl.textContent = '';
		const unit = { size: `${px}px`, hidden: root.querySelector('[data-gls-hidden]').checked };
		const mode = root.querySelector('[data-gls-mode]').value;
		if (mode) {
			const cfg = { mode };
			if (mode === 'fixed') cfg.fixedPx = px;
			const fit = parseInt(root.querySelector('[data-gls-fit]').value, 10);
			if (mode === 'fit' && !isNaN(fit)) cfg.fitPercent = Math.max(0, Math.min(100, fit));
			const min = parseInt(root.querySelector('[data-gls-min]').value, 10);
			const max = parseInt(root.querySelector('[data-gls-max]').value, 10);
			if (!isNaN(min) && min > 0) cfg.min = min;
			if (!isNaN(max) && max > 0) cfg.max = max;
			unit.sizeConfig = cfg;
		}
		return unit;
	}

	sizeInput?.addEventListener('input', () => {
		sizeInput.classList.remove('gls-input-invalid');
		if (errorEl) errorEl.textContent = '';
	});
	sizeInput?.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			applyBtn?.click();
		}
	});

	applyBtn?.addEventListener('click', () => {
		const unit = readUnit();
		if (!unit) return;
		draft[scope].columns[field] = unit;
		commit();
	});
	fromCurrentBtn?.addEventListener('click', () => {
		const liveUnit = live.columns[field];
		if (!liveUnit) return;
		draft[scope].columns[field] = structuredClone(liveUnit);
		commit();
	});
	clearBtn?.addEventListener('click', () => {
		delete draft[scope].columns[field];
		commit();
	});
}

// ---------- Static UI wiring (called once from renderer.js) ----------

export function initUI() {
	if (uiInitialized) return;
	uiInitialized = true;

	const modal = modalEl();
	if (!modal) return;

	document.getElementById('btn-gls-close').addEventListener('click', requestClose);
	document.getElementById('btn-gls-cancel').addEventListener('click', requestClose);
	document.getElementById('btn-gls-save').addEventListener('click', save);
	modal.addEventListener('click', (e) => {
		if (e.target === modal) requestClose();
	});

	modal.querySelectorAll('[data-gls-capture]').forEach(btn => {
		btn.addEventListener('click', () => captureIntoLayer(btn.getAttribute('data-gls-capture')));
	});
	modal.querySelectorAll('[data-gls-clear-layer]').forEach(btn => {
		btn.addEventListener('click', () => {
			const scope = btn.getAttribute('data-gls-clear-layer');
			if (!draft) return;
			if (scope === 'category' && !ctx.categoryName) return;
			draft[scope] = emptyLayer();
			markDirty(scope);
			renderMatrix();
		});
	});

	// Delegated cell clicks
	document.getElementById('gls-matrix-body').addEventListener('click', (e) => {
		const cell = e.target.closest('[data-gls-cell]');
		if (!cell) return;
		e.stopPropagation();
		openCellEditor(cell.getAttribute('data-row'), cell.getAttribute('data-scope'), cell);
	});

	// Enter = Save when no cell editor is open (editors handle their own Enter)
	modal.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && !isEditorOpen() && e.target.tagName !== 'TEXTAREA') {
			e.preventDefault();
			save();
		}
	});
}
