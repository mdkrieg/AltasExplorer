/**
 * Auto Labels Module
 * Manages the suggestions modal for auto-labelling rules.
 */

import { panelState } from '../renderer.js';
import { w2grid, w2ui } from './vendor/w2ui.es6.min.js';

let _currentPanelId = null;
let _iconCache = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function openAutoLabelsModal(panelId) {
	_currentPanelId = panelId;
	const state = panelState[panelId];
	const suggestions = (state && state.autoLabelSuggestions) || [];

	$('#auto-labels-modal').css('display', 'flex');
	await buildSuggestionsGrid(suggestions);

	$('#btn-al-modal-close').off('click.alModal').on('click.alModal', hideAutoLabelsModal);
	$('#btn-al-apply').off('click.alModal').on('click.alModal', applySelectedSuggestions);
	$('#btn-al-select-all').off('click.alModal').on('click.alModal', function () {
		const grid = w2ui['auto-labels-suggestions-grid'];
		if (grid) { grid.selectAll(); setTimeout(updateConflictWarning, 0); }
	});
	$('#btn-al-select-none').off('click.alModal').on('click.alModal', function () {
		const grid = w2ui['auto-labels-suggestions-grid'];
		if (grid) { grid.selectNone(); setTimeout(updateConflictWarning, 0); }
	});
}

export function hideAutoLabelsModal() {
	$('#auto-labels-modal').hide();
	const gridName = 'auto-labels-suggestions-grid';
	if (w2ui[gridName]) w2ui[gridName].destroy();
	_currentPanelId = null;
}

/**
 * Gathers grid records from a panel, calls evaluateAutoLabels, and stores
 * the result in panelState so renderPanelToolbar can show the badge.
 */
export async function refreshAutoLabelCountAndSuggestions(panelId) {
	const state = panelState[panelId];
	if (!state) return;

	const grid = state.w2uiGrid;
	const items = grid
		? (grid.records || [])
			.filter(r => r.path)
			.map(r => ({
				path: r.path,
				inode: r.inode,
				dirId: r.dir_id,
				isDirectory: !!r.isFolder
			}))
		: [];

	if (items.length === 0) {
		state.autoLabelCount = 0;
		state.autoLabelSuggestions = [];
		return;
	}

	try {
		const result = await window.electronAPI.evaluateAutoLabels(items);
		const suggestions = (result && result.suggestions) || [];
		state.autoLabelCount = suggestions.length;
		state.autoLabelSuggestions = suggestions;
	} catch (err) {
		console.error('Failed to evaluate auto labels:', err);
		state.autoLabelCount = 0;
		state.autoLabelSuggestions = [];
	}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function buildSuggestionsGrid(suggestions) {
	const gridName = 'auto-labels-suggestions-grid';
	if (w2ui[gridName]) w2ui[gridName].destroy();

	// Pre-fetch category/tag data for rendering the Effect column
	const [catsData, tagsData] = await Promise.all([
		window.electronAPI.loadCategories().catch(() => ({})),
		window.electronAPI.getTagsList().catch(() => [])
	]);
	const catsMap = catsData || {};
	const tagsMap = {};
	(tagsData || []).forEach(t => { tagsMap[t.name] = t; });

	const records = [];
	for (let i = 0; i < suggestions.length; i++) {
		const s = suggestions[i];
		let effectHtml = '';
		let effectSort = '';

		if (s.applyType === 'category') {
			const cat = catsMap[s.applyValue] || null;
			if (cat) {
				const iconUrl = await getCachedIconUrl(cat.bgColor, cat.textColor, null);
				effectHtml = `<span style="display:inline-flex;align-items:center;gap:4px;"><img src="${iconUrl}" style="width:18px;height:18px;object-fit:contain;flex-shrink:0;">${escHtml(s.applyValue)}</span>`;
			} else {
				effectHtml = `<span style="display:inline-flex;align-items:center;gap:4px;">&#128193;${escHtml(s.applyValue)}</span>`;
			}
			effectSort = `cat:${s.applyValue}`;
		} else {
			const tag = tagsMap[s.applyValue] || null;
			if (tag) {
				const tagIconUrl = await window.electronAPI.generateTagIcon(tag.bgColor, tag.textColor).catch(() => null);
				const tagIconHtml = tagIconUrl ? `<img src="${tagIconUrl}" style="width:16px;height:16px;object-fit:contain;flex-shrink:0;">` : '';
				effectHtml = `<span style="display:inline-flex;align-items:center;gap:4px;">${tagIconHtml}${escHtml(s.applyValue)}</span>`;
			} else {
				effectHtml = `<span style="display:inline-flex;align-items:center;gap:4px;">${escHtml(s.applyValue)}</span>`;
			}
			effectSort = `tag:${s.applyValue}`;
		}

		// Build info tooltip text (one pattern per line)
		const patternLines = (s.patternResults || []).map(p => {
			const check = p.matched ? '\u2705' : '\u274c';
			const req = p.required ? ' (required)' : '';
			return `${check} ${p.description}${req}`;
		});
		const infoTitle = patternLines.join('\n');
		const infoHtml = `<img src="assets/icons/comment-info.svg" style="width:14px;height:14px;cursor:default;vertical-align:middle;" title="${escHtml(infoTitle)}">`;

		records.push({
			recid: i,
			effectSort,
			effect: effectHtml,
			id: s.ruleId || '',
			name: s.ruleName || '',
			info: infoHtml,
			description: s.ruleDescription || '',
			_suggestion: s,
			w2ui: { class: '' }
		});
	}

	const grid = new w2grid({
		name: gridName,
		show: { header: false, toolbar: false, footer: false, selectColumn: true },
		multiSelect: true,
		columns: [
			{ field: 'effectSort', text: '', hidden: true, size: '0px' },
			{
				field: 'effect', text: 'Effect', size: '110px', resizable: true, sortable: false,
				render: record => record.effect || ''
			},
			{ field: 'id', text: 'ID', size: '240px', resizable: true, sortable: true },
			{ field: 'name', text: 'Name', size: '180px', resizable: true, sortable: true },
			{
				field: 'info', text: '', size: '30px', resizable: false, sortable: false,
				render: record => record.info || ''
			},
			{ field: 'description', text: 'Description', size: '100%', resizable: true, sortable: true }
		],
		records,
		onSelect: function () { setTimeout(updateConflictWarning, 0); },
		onUnselect: function () { setTimeout(updateConflictWarning, 0); }
	});

	grid.render('#auto-labels-suggestions-grid');

	// Space key: toggle selection of focused row(s)
	const container = document.getElementById(gridName);
	if (container) {
		container.addEventListener('keydown', function (e) {
			if (e.key !== ' ') return;
			e.preventDefault();
			const g = w2ui[gridName];
			if (!g) return;
			const sel = g.getSelection();
			if (sel.length === 0) return;
			const allSelected = sel.every(recid => g.getSelection().includes(recid));
			if (allSelected) {
				sel.forEach(recid => g.unselect(recid));
			} else {
				sel.forEach(recid => g.select(recid));
			}
			setTimeout(updateConflictWarning, 0);
		});
	}
}

function updateConflictWarning() {
	const gridName = 'auto-labels-suggestions-grid';
	const grid = w2ui[gridName];
	if (!grid) return;

	const selectedIds = grid.getSelection();

	// Map: dir path → Set of category applyValues from selected suggestions
	const dirCategoryMap = new Map();
	for (const recid of selectedIds) {
		const rec = grid.get(recid);
		if (!rec) continue;
		const s = rec._suggestion;
		if (!s || s.applyType !== 'category') continue;
		for (const item of (s.matchedItems || [])) {
			const dirPath = item.isDirectory
				? item.path
				: item.path.replace(/[/\\][^/\\]+$/, '');
			if (!dirCategoryMap.has(dirPath)) dirCategoryMap.set(dirPath, new Set());
			dirCategoryMap.get(dirPath).add(s.applyValue);
		}
	}

	let hasConflict = false;
	for (const catSet of dirCategoryMap.values()) {
		if (catSet.size > 1) { hasConflict = true; break; }
	}

	$('#al-conflict-warning').css('display', hasConflict ? 'inline' : 'none');

	// Update per-row conflict classes
	let needRefresh = false;
	for (const rec of grid.records) {
		const s = rec._suggestion;
		const isSelected = selectedIds.includes(rec.recid);
		let rowConflict = false;
		if (isSelected && s && s.applyType === 'category') {
			for (const item of (s.matchedItems || [])) {
				const dirPath = item.isDirectory
					? item.path
					: item.path.replace(/[/\\][^/\\]+$/, '');
				if ((dirCategoryMap.get(dirPath) || new Set()).size > 1) {
					rowConflict = true; break;
				}
			}
		}
		const newClass = rowConflict ? 'al-conflict-row' : '';
		if (!rec.w2ui) rec.w2ui = {};
		if (rec.w2ui.class !== newClass) {
			rec.w2ui.class = newClass;
			needRefresh = true;
		}
	}
	if (needRefresh) grid.refresh();
}

async function applySelectedSuggestions() {
	const gridName = 'auto-labels-suggestions-grid';
	const grid = w2ui[gridName];
	if (!grid) return;

	const selectedIds = grid.getSelection();
	if (selectedIds.length === 0) return;

	if ($('#al-conflict-warning').is(':visible')) {
		return; // Block apply when conflicts exist
	}

	const checkedSuggestions = selectedIds
		.map(recid => grid.get(recid))
		.filter(Boolean)
		.map(r => r._suggestion);

	try {
		await window.electronAPI.applyAutoLabelSuggestions(checkedSuggestions);
	} catch (err) {
		console.error('Failed to apply auto-label suggestions:', err);
	}

	// Re-evaluate and rebuild the grid
	const panelId = _currentPanelId;
	if (panelId) {
		await refreshAutoLabelCountAndSuggestions(panelId);
		const state = panelState[panelId];
		const newSuggestions = (state && state.autoLabelSuggestions) || [];
		await buildSuggestionsGrid(newSuggestions);

		// Re-render toolbar to update badge count
		// Defer import to avoid top-level circular dependency issues
		const panelsModule = await import('./panels.js');
		panelsModule.renderPanelToolbar(panelId);
	}
}

async function getCachedIconUrl(bgColor, textColor, initials) {
	const key = `${bgColor}:${textColor}:${initials}`;
	if (_iconCache.has(key)) return _iconCache.get(key);
	const url = await window.electronAPI.generateFolderIcon(bgColor, textColor, initials || null);
	_iconCache.set(key, url);
	return url;
}

function escHtml(str) {
	if (!str) return '';
	return String(str)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
