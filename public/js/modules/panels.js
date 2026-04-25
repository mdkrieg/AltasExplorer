/**
 * Panels Module
 * Handles panel state, grid management, navigation, layout, and item properties.
 */

import * as sidebar from './sidebar.js';
import * as utils from './utils.js';
import * as terminal from './terminal.js';
import { attachDragDropForPanel, attachDragDropForGallery } from './dragdrop.js';
import { w2grid, w2ui, w2confirm, w2alert, w2field, w2tooltip } from './vendor/w2ui.es6.min.js';
import * as autoLabels from './auto-labels.js';
import {
	panelState,
	selectedItemState,
	w2layoutInstance,
	MISSING_DIRECTORY_LABEL,
	fileEditMode,
	setFileEditMode,
	syncRendererActivePanelId,
	monacoEditor,
	showSettingsModal,
	updateAlertBadge,
	generateW2UIContextMenu,
	showCustomContextMenu,
	openNotesModal,
	openHistoryModal,
	showFileView,
	hideFileView,
	toggleFileEditMode,
	openImageViewerModal,
	buildCompleteFileState,
	formatHistoryData,
	formatFileContent,
	openTodoModal,
	setSidebarFocus
} from '../renderer.js';

export let activePanelId = 1;
export let allCategories = {};
export let allTags = [];
export let allFileTypes = [];
export let currentLayout = 1;
export let visiblePanels = 1;
export let unacknowledgedAlertCount = 0;
export let panel1SelectedDirectoryPath = null;
export let panel1SelectedDirectoryName = null;
export let gridFocusedPanelId = null;
const closedPanelStack = [];
const selectionAnchorRecids = {};
export let panelDividerState = {
	verticalPixels: 400,
	horizontalPixels: 300,
	isResizingVertical: false,
	isResizingHorizontal: false,
	minPanelWidth: 200,
	minPanelHeight: 100,
};
const labelIconCache = new Map();
const INITIAL_LABEL_SUGGESTION_COUNT = 4;
const LABEL_SUGGESTION_INCREMENT = 3;
let createTagModalState = {
	panelId: null,
	addHandler: null,
	afterCreate: null
};
let tagConfigModalState = {
	record: null,
	panelId: null,
	tags: [],
	uiState: createDefaultLabelsUiState()
};

function createDefaultLabelsUiState() {
	return {
		inputValue: '',
		visibleSuggestionCount: INITIAL_LABEL_SUGGESTION_COUNT,
		selectedSuggestionIndex: -1,
		isInputFocused: false,
		isSuggestionOpen: false,
		isCategoryMenuOpen: false
	};
}

function ensureLabelsUiState(panelId) {
	if (!panelState[panelId].labelsUiState) {
		panelState[panelId].labelsUiState = createDefaultLabelsUiState();
	}
	return panelState[panelId].labelsUiState;
}

function resetLabelsUiState(panelId) {
	if (!panelState[panelId]) return;
	panelState[panelId].labelsUiState = createDefaultLabelsUiState();
}

function resetAllLabelsUiState() {
	for (let panelId = 2; panelId <= 4; panelId++) {
		resetLabelsUiState(panelId);
	}
}

function createDefaultFilterValues() {
	return {
		filename: '',
		type: '',
		tags: '',
		perms: '',
		sizeMinKb: '',
		sizeMaxKb: '',
		modifiedFrom: '',
		modifiedTo: '',
		createdFrom: '',
		createdTo: '',
		notes: '',
		todo: '',
		checksum: '',
		attributes: {}
	};
}

function getPanelFilterMenuName(panelId) {
	return `grid-filter-menu-${panelId}`;
}

function hidePanelFilterMenu(panelId) {
	w2tooltip.hide(getPanelFilterMenuName(panelId));
	if (panelState[panelId]) {
		panelState[panelId].reopenFilterMenuField = null;
		panelState[panelId].filterMenuField = null;
	}
}

function getFilterAttributeColumns(panelId) {
	const state = panelState[panelId];
	if (!state) return [];
	return state.currentAttrColumns || (state.currentCategory && state.currentCategory.attributes) || [];
}

function syncFilterAttributeValues(panelId) {
	const state = panelState[panelId];
	if (!state) return;
	if (!state.filterValues) state.filterValues = createDefaultFilterValues();
	if (!state.filterValues.attributes || typeof state.filterValues.attributes !== 'object') {
		state.filterValues.attributes = {};
	}
	const next = {};
	for (const attrName of getFilterAttributeColumns(panelId)) {
		next[attrName] = state.filterValues.attributes[attrName] || '';
	}
	state.filterValues.attributes = next;
}

function ensureFilterState(panelId) {
	const state = panelState[panelId];
	if (!state) return null;
	if (typeof state.filterVisible !== 'boolean') state.filterVisible = false;
	if (!state.filterValues) state.filterValues = createDefaultFilterValues();
	if (typeof state.filterMenuField === 'undefined') state.filterMenuField = null;
	if (!Array.isArray(state.sourceRecords)) state.sourceRecords = [];
	syncFilterAttributeValues(panelId);
	return state;
}

function resetFilterState(panelId) {
	const state = panelState[panelId];
	if (!state) return;
	state.filterVisible = false;
	state.filterValues = createDefaultFilterValues();
	state.filterMenuField = null;
	state.sourceRecords = [];
	if (state.w2uiGrid) {
		state.w2uiGrid.searchReset();
	}
	hidePanelFilterMenu(panelId);
}

function parseNumericFilterValue(value) {
	if (value === '' || value === null || value === undefined) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function parseFilterDateValue(value, endOfDay = false) {
	if (!value) return null;
	const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`);
	const timestamp = date.getTime();
	return Number.isFinite(timestamp) ? timestamp : null;
}

function getTagFilterText(tagsJson) {
	return parseTagNames(tagsJson).join(' ');
}

function getRecordTextValue(record, key) {
	const value = record[key];
	if (value === null || value === undefined) return '';
	return String(value).trim().toLowerCase();
}

function matchesTextFilter(record, key, filterValue) {
	const normalizedFilter = String(filterValue || '').trim().toLowerCase();
	if (!normalizedFilter) return true;
	return getRecordTextValue(record, key).includes(normalizedFilter);
}

function matchesYesNoFilter(isPresent, filterValue) {
	if (!filterValue) return true;
	if (filterValue === 'yes') return !!isPresent;
	if (filterValue === 'no') return !isPresent;
	return true;
}

function hasTodoItems(record) {
	return !!(record?.todo && Number(record.todo.total) > 0);
}

function hasChecksumValue(record) {
	return String(record?.checksumValue || '').trim() !== '';
}

function matchesSizeFilter(record, values) {
	const minKb = parseNumericFilterValue(values.sizeMinKb);
	const maxKb = parseNumericFilterValue(values.sizeMaxKb);
	if (minKb === null && maxKb === null) return true;
	if (!Number.isFinite(record.sizeBytes)) return false;
	if (minKb !== null && record.sizeBytes < minKb * 1024) return false;
	if (maxKb !== null && record.sizeBytes > maxKb * 1024) return false;
	return true;
}

function matchesDateFilter(timestamp, fromValue, toValue) {
	const from = parseFilterDateValue(fromValue, false);
	const to = parseFilterDateValue(toValue, true);
	if (from === null && to === null) return true;
	if (!Number.isFinite(timestamp)) return false;
	if (from !== null && timestamp < from) return false;
	if (to !== null && timestamp > to) return false;
	return true;
}

function hasActiveFilterValues(panelId) {
	const state = ensureFilterState(panelId);
	if (!state) return false;
	const values = state.filterValues;
	if (!values) return false;
	if (values.filename || values.type || values.tags || values.perms || values.sizeMinKb || values.sizeMaxKb || values.modifiedFrom || values.modifiedTo || values.createdFrom || values.createdTo || values.notes || values.todo || values.checksum) {
		return true;
	}
	return Object.values(values.attributes || {}).some(value => String(value || '').trim() !== '');
}

function isFilterFieldActive(panelId, field) {
	const state = ensureFilterState(panelId);
	if (!state) return false;
	const values = state.filterValues;
	if (!values) return false;
	if (field === 'filename') return String(values.filename || '').trim() !== '';
	if (field === 'type') return String(values.type || '').trim() !== '';
	if (field === 'tags') return String(values.tags || '').trim() !== '';
	if (field === 'perms') return String(values.perms || '').trim() !== '';
	if (field === 'size') return String(values.sizeMinKb || '').trim() !== '' || String(values.sizeMaxKb || '').trim() !== '';
	if (field === 'modified') return String(values.modifiedFrom || '').trim() !== '' || String(values.modifiedTo || '').trim() !== '';
	if (field === 'dateCreated') return String(values.createdFrom || '').trim() !== '' || String(values.createdTo || '').trim() !== '';
	if (field === 'notes') return String(values.notes || '').trim() !== '';
	if (field === 'todo') return String(values.todo || '').trim() !== '';
	if (field === 'checksum') return String(values.checksum || '').trim() !== '';
	if (field.startsWith('attr_')) {
		const attrName = field.substring(5);
		return String(values.attributes?.[attrName] || '').trim() !== '';
	}
	return false;
}

function getColumnFilterConfig(panelId, field) {
	const state = ensureFilterState(panelId);
	if (!state) return null;
	const attrDefinitions = state.currentAttrDefinitions || {};
	const baseConfigs = {
		filename: { label: 'Name', kind: 'text', key: 'filename', placeholder: 'contains' },
		type: { label: 'Type', kind: 'text', key: 'type', placeholder: 'contains' },
		tags: { label: 'Tags', kind: 'text', key: 'tags', placeholder: 'contains' },
		perms: { label: 'Perms', kind: 'text', key: 'perms', placeholder: 'contains' },
		size: { label: 'Size', kind: 'range-number', minKey: 'sizeMinKb', maxKey: 'sizeMaxKb', unit: 'KB' },
		modified: { label: 'Modified', kind: 'range-date', minKey: 'modifiedFrom', maxKey: 'modifiedTo' },
		dateCreated: { label: 'Date Created', kind: 'range-date', minKey: 'createdFrom', maxKey: 'createdTo' },
		notes: { label: 'Notes', kind: 'yes-no', key: 'notes' },
		todo: { label: 'TODO', kind: 'yes-no', key: 'todo' },
		checksum: { label: 'Checksum', kind: 'yes-no', key: 'checksum' }
	};
	if (baseConfigs[field]) return baseConfigs[field];
	if (field.startsWith('attr_')) {
		const attrName = field.substring(5);
		return {
			label: attrDefinitions[attrName]?.name || attrName,
			kind: 'text-attr',
			attrName,
			placeholder: 'contains'
		};
	}
	return null;
}

function isColumnFilterable(panelId, field) {
	return !!getColumnFilterConfig(panelId, field);
}

function getFilterButtonTitle(panelId, field) {
	const config = getColumnFilterConfig(panelId, field);
	return config ? `Filter ${config.label}` : '';
}

function getHeaderFilterButtonHtml(panelId, field) {
	if (!isColumnFilterable(panelId, field)) return '';
	const state = ensureFilterState(panelId);
	const isActive = isFilterFieldActive(panelId, field);
	const isOpen = state?.filterMenuField === field;
	return `<button type="button" class="grid-header-filter-btn${isActive ? ' is-active' : ''}${isOpen ? ' is-open' : ''}" data-panel-id="${panelId}" data-filter-menu-field="${field}" title="${utils.escapeHtml(getFilterButtonTitle(panelId, field))}">
		<img src="assets/icons/filter.svg">
	</button>`;
}

function getColumnHeaderText(panelId, field, label) {
	const buttonHtml = isColumnFilterable(panelId, field) ? getHeaderFilterButtonHtml(panelId, field) : '';
	return `<div class="grid-header-filter${buttonHtml ? '' : ' is-static'}"><span class="grid-header-filter-label">${utils.escapeHtml(label || '')}</span>${buttonHtml}</div>`;
}

function refreshFilterHeaderButtons(panelId) {
	const state = ensureFilterState(panelId);
	if (!state) return;
	const container = document.getElementById(`grid_grid-panel-${panelId}_columns`);
	if (!container) return;
	container.querySelectorAll('.grid-header-filter-btn').forEach(button => {
		const field = button.getAttribute('data-filter-menu-field');
		button.classList.toggle('is-active', isFilterFieldActive(panelId, field));
		button.classList.toggle('is-open', state.filterMenuField === field);
		button.title = getFilterButtonTitle(panelId, field);
		if (button.dataset.filterBound !== 'true') {
			button.addEventListener('mousedown', (event) => {
				event.preventDefault();
				event.stopPropagation();
			});
			button.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				openColumnFilterMenu(panelId, button.getAttribute('data-filter-menu-field'), button);
			});
			button.dataset.filterBound = 'true';
		}
	});
}

function updateGridColumnHeadersFromFilterState(panelId) {
	const state = ensureFilterState(panelId);
	const grid = state?.w2uiGrid;
	if (!state || !grid) return;

	grid.columns.forEach(column => {
		if (Object.prototype.hasOwnProperty.call(column, 'headerLabel')) {
			column.text = getColumnHeaderText(panelId, column.field, column.headerLabel);
		}
	});
}

function buildColumnFilterMenuHtml(panelId, field) {
	const state = ensureFilterState(panelId);
	const config = getColumnFilterConfig(panelId, field);
	if (!state || !config) return '<div class="grid-filter-menu"></div>';
	const values = state.filterValues;
	const active = isFilterFieldActive(panelId, field);
	let bodyHtml = '';
	if (config.kind === 'text') {
		bodyHtml = `
			<label class="grid-filter-menu-field">
				<span>${utils.escapeHtml(config.label)} contains</span>
				<input type="text" data-filter-popup-field="${field}" value="${utils.escapeHtml(values[config.key] || '')}" placeholder="${utils.escapeHtml(config.placeholder)}">
			</label>
		`;
	}
	if (config.kind === 'text-attr') {
		bodyHtml = `
			<label class="grid-filter-menu-field">
				<span>${utils.escapeHtml(config.label)} contains</span>
				<input type="text" data-filter-popup-field="${field}" data-filter-popup-attr="${encodeURIComponent(config.attrName)}" value="${utils.escapeHtml(values.attributes?.[config.attrName] || '')}" placeholder="${utils.escapeHtml(config.placeholder)}">
			</label>
		`;
	}
	if (config.kind === 'range-number') {
		bodyHtml = `
			<div class="grid-filter-menu-range">
				<label class="grid-filter-menu-field">
					<span>Min ${utils.escapeHtml(config.unit)}</span>
					<input type="number" min="0" step="1" data-filter-popup-field="${field}" data-filter-popup-key="${config.minKey}" value="${utils.escapeHtml(values[config.minKey] || '')}" placeholder="0">
				</label>
				<label class="grid-filter-menu-field">
					<span>Max ${utils.escapeHtml(config.unit)}</span>
					<input type="number" min="0" step="1" data-filter-popup-field="${field}" data-filter-popup-key="${config.maxKey}" value="${utils.escapeHtml(values[config.maxKey] || '')}" placeholder="0">
				</label>
			</div>
		`;
	}
	if (config.kind === 'range-date') {
		bodyHtml = `
			<div class="grid-filter-menu-range">
				<label class="grid-filter-menu-field">
					<span>From</span>
					<input type="date" data-filter-popup-field="${field}" data-filter-popup-key="${config.minKey}" value="${utils.escapeHtml(values[config.minKey] || '')}">
				</label>
				<label class="grid-filter-menu-field">
					<span>To</span>
					<input type="date" data-filter-popup-field="${field}" data-filter-popup-key="${config.maxKey}" value="${utils.escapeHtml(values[config.maxKey] || '')}">
				</label>
			</div>
		`;
	}
	if (config.kind === 'yes-no') {
		bodyHtml = `
			<label class="grid-filter-menu-field">
				<span>${utils.escapeHtml(config.label)} is</span>
				<select data-filter-popup-field="${field}" data-filter-popup-key="${config.key}">
					<option value="" ${!values[config.key] ? 'selected' : ''}>Any</option>
					<option value="yes" ${values[config.key] === 'yes' ? 'selected' : ''}>Yes</option>
					<option value="no" ${values[config.key] === 'no' ? 'selected' : ''}>No</option>
				</select>
			</label>
		`;
	}
	return `
		<div class="grid-filter-menu" data-panel-id="${panelId}" data-filter-menu-field="${field}">
			<div class="grid-filter-menu-title">${utils.escapeHtml(config.label)} Filter</div>
			${bodyHtml}
			<div class="grid-filter-menu-actions">
				<button type="button" class="grid-filter-menu-btn" data-filter-menu-action="clear-field" data-panel-id="${panelId}" data-filter-menu-field="${field}" ${active ? '' : 'disabled'}>Clear</button>
				<button type="button" class="grid-filter-menu-btn" data-filter-menu-action="clear-all" data-panel-id="${panelId}" ${hasActiveFilterValues(panelId) ? '' : 'disabled'}>Clear All</button>
			</div>
		</div>
	`;
}

function captureFilterMenuFocusState(panelId) {
	const overlayEl = document.querySelector(`#w2overlay-${getPanelFilterMenuName(panelId)}`);
	if (!overlayEl) return null;
	const activeEl = document.activeElement;
	if (!activeEl || !overlayEl.contains(activeEl)) return null;
	return {
		field: activeEl.getAttribute('data-filter-popup-field') || null,
		key: activeEl.getAttribute('data-filter-popup-key') || null,
		attr: activeEl.getAttribute('data-filter-popup-attr') || null,
		tagName: activeEl.tagName || null,
		selectionStart: typeof activeEl.selectionStart === 'number' ? activeEl.selectionStart : null,
		selectionEnd: typeof activeEl.selectionEnd === 'number' ? activeEl.selectionEnd : null
	};
}

function restoreFilterMenuFocusState(panelId, focusState) {
	if (!focusState) return;
	const overlayEl = document.querySelector(`#w2overlay-${getPanelFilterMenuName(panelId)}`);
	if (!overlayEl) return;
	let selector = `[data-filter-popup-field="${focusState.field}"]`;
	if (focusState.key) {
		selector += `[data-filter-popup-key="${focusState.key}"]`;
		}
	if (focusState.attr) {
		selector += `[data-filter-popup-attr="${focusState.attr}"]`;
	}
	const input = overlayEl.querySelector(selector) || overlayEl.querySelector('input, select');
	if (!input) return;
	input.focus();
	if (focusState.selectionStart !== null && focusState.selectionEnd !== null && typeof input.setSelectionRange === 'function') {
		input.setSelectionRange(focusState.selectionStart, focusState.selectionEnd);
	}
}

function focusFirstFilterMenuInput(panelId) {
	const overlayEl = document.querySelector(`#w2overlay-${getPanelFilterMenuName(panelId)}`);
	if (!overlayEl) return;
	const firstInput = overlayEl.querySelector('input, select');
	if (!firstInput) return;
	firstInput.focus();
	if (typeof firstInput.select === 'function' && firstInput.type !== 'date' && firstInput.type !== 'number') {
		firstInput.select();
	}
}

function initColumnFilterMenuControls(panelId) {
	const overlayEl = document.querySelector(`#w2overlay-${getPanelFilterMenuName(panelId)}`);
	if (!overlayEl) return;
	if (overlayEl.dataset.filterMenuInitialized !== 'true') {
		overlayEl.addEventListener('mousedown', (event) => {
			event.stopPropagation();
		});
		overlayEl.addEventListener('click', (event) => {
			event.stopPropagation();
		});
		overlayEl.dataset.filterMenuInitialized = 'true';
	}
	overlayEl.querySelectorAll('[data-filter-menu-action]').forEach(button => {
		if (button.dataset.filterActionBound === 'true') return;
		button.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			const action = button.getAttribute('data-filter-menu-action');
			const field = button.getAttribute('data-filter-menu-field');
			if (action === 'clear-field' && field) {
				clearFilterField(panelId, field);
			}
			if (action === 'clear-all') {
				clearPanelFilterInputs(panelId);
			}
		});
		button.dataset.filterActionBound = 'true';
	});
	overlayEl.querySelectorAll('[data-filter-popup-field]').forEach(input => {
		if (input.dataset.filterKeyboardBound === 'true') return;
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				event.stopPropagation();
				hidePanelFilterMenu(panelId);
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				const field = input.getAttribute('data-filter-popup-field');
				if (!field) return;
				clearFilterField(panelId, field, { reopenMenu: false });
				hidePanelFilterMenu(panelId);
			}
		});
		input.dataset.filterKeyboardBound = 'true';
	});
}

function refreshOpenFilterMenu(panelId) {
	const state = ensureFilterState(panelId);
	if (!state?.filterMenuField) {
		refreshFilterHeaderButtons(panelId);
		return;
	}
	const field = state.filterMenuField;
	const button = document.querySelector(`#grid_grid-panel-${panelId}_columns .grid-header-filter-btn[data-filter-menu-field="${field}"]`);
	const overlayName = getPanelFilterMenuName(panelId);
	const overlay = w2tooltip.get(overlayName);
	const focusState = captureFilterMenuFocusState(panelId);
	if (!button) {
		refreshFilterHeaderButtons(panelId);
		return;
	}
	if (overlay?.displayed) {
		overlay.anchor = button;
		w2tooltip.update(overlayName, buildColumnFilterMenuHtml(panelId, field));
		setTimeout(() => {
			initColumnFilterMenuControls(panelId);
			restoreFilterMenuFocusState(panelId, focusState);
		}, 0);
	} else {
		openColumnFilterMenu(panelId, field, button);
		return;
	}
	refreshFilterHeaderButtons(panelId);
}

function openColumnFilterMenu(panelId, field, anchorEl) {
	const state = ensureFilterState(panelId);
	if (!state || !anchorEl || !isColumnFilterable(panelId, field)) return;
	state.filterMenuField = field;
	w2tooltip.show({
		name: getPanelFilterMenuName(panelId),
		anchor: anchorEl,
		html: buildColumnFilterMenuHtml(panelId, field),
		class: 'grid-filter-overlay',
		position: 'bottom|top',
		align: 'left',
		arrowSize: 10,
		hideOn: ['doc-click'],
		maxWidth: 360,
		onShow: () => {
			setTimeout(() => {
				initColumnFilterMenuControls(panelId);
				focusFirstFilterMenuInput(panelId);
			}, 0);
		},
		onUpdate: () => {
			setTimeout(() => {
				initColumnFilterMenuControls(panelId);
			}, 0);
		},
		onHide: () => {
			if (panelState[panelId]) {
				if (panelState[panelId].reopenFilterMenuField === field) {
					return;
				}
				panelState[panelId].filterMenuField = null;
			}
			refreshFilterHeaderButtons(panelId);
		}
	});
	refreshFilterHeaderButtons(panelId);
	setTimeout(() => {
		initColumnFilterMenuControls(panelId);
		focusFirstFilterMenuInput(panelId);
	}, 0);
}

function clearFilterField(panelId, field, options = {}) {
	const state = ensureFilterState(panelId);
	if (!state) return;
	const { reopenMenu = true } = options;
	if (!reopenMenu) {
		state.reopenFilterMenuField = null;
		state.filterMenuField = null;
	}
	if (field === 'filename') state.filterValues.filename = '';
	if (field === 'type') state.filterValues.type = '';
	if (field === 'tags') state.filterValues.tags = '';
	if (field === 'perms') state.filterValues.perms = '';
	if (field === 'size') {
		state.filterValues.sizeMinKb = '';
		state.filterValues.sizeMaxKb = '';
	}
	if (field === 'modified') {
		state.filterValues.modifiedFrom = '';
		state.filterValues.modifiedTo = '';
	}
	if (field === 'dateCreated') {
		state.filterValues.createdFrom = '';
		state.filterValues.createdTo = '';
	}
	if (field === 'notes') state.filterValues.notes = '';
	if (field === 'todo') state.filterValues.todo = '';
	if (field === 'checksum') state.filterValues.checksum = '';
	if (field.startsWith('attr_')) {
		state.filterValues.attributes[field.substring(5)] = '';
	}
	applyPanelFilters(panelId, { reopenMenu });
}

function recordMatchesFilters(record, values) {
	if (!matchesTextFilter(record, 'filenameText', values.filename)) return false;
	if (!matchesTextFilter(record, 'typeRaw', values.type)) return false;
	if (!matchesTextFilter(record, 'tagsText', values.tags)) return false;
	if (!matchesTextFilter(record, 'permsText', values.perms)) return false;
	if (!matchesSizeFilter(record, values)) return false;
	if (!matchesDateFilter(record.modifiedTimestamp, values.modifiedFrom, values.modifiedTo)) return false;
	if (!matchesDateFilter(record.dateCreatedTimestamp, values.createdFrom, values.createdTo)) return false;
	if (!matchesYesNoFilter(record.hasNotes, values.notes)) return false;
	if (!matchesYesNoFilter(hasTodoItems(record), values.todo)) return false;
	if (!matchesYesNoFilter(hasChecksumValue(record), values.checksum)) return false;
	for (const [attrName, attrValue] of Object.entries(values.attributes || {})) {
		if (!matchesTextFilter(record, `attr_${attrName}`, attrValue)) {
			return false;
		}
	}
	return true;
}

function applyPanelFilters(panelId, options = {}) {
	const state = ensureFilterState(panelId);
	const grid = state?.w2uiGrid;
	if (!state || !grid) return;
	const { reopenMenu = true } = options;
	const reopenField = reopenMenu ? state.filterMenuField : null;
	state.reopenFilterMenuField = reopenField || null;
	const selectedRecids = typeof grid.getSelection === 'function' ? grid.getSelection() : [];
	let records = state.sourceRecords;
	if (hasActiveFilterValues(panelId)) {
		records = state.sourceRecords.filter(record => recordMatchesFilters(record, state.filterValues));
	}
	state.filterVisible = hasActiveFilterValues(panelId);
	grid.records = records;
	grid.total = records.length;
	updateGridColumnHeadersFromFilterState(panelId);
	grid.refresh();
	const visibleRecids = new Set(records.map(record => record.recid));
	const visibleSelection = selectedRecids.filter(recid => visibleRecids.has(recid));
	if (typeof grid.selectNone === 'function') {
		grid.selectNone();
	}
	if (visibleSelection.length > 0 && typeof grid.select === 'function') {
		grid.select(...visibleSelection);
	}
	if (reopenField) {
		state.filterMenuField = reopenField;
	} else if (!reopenMenu) {
		state.filterMenuField = null;
	}
	refreshOpenFilterMenu(panelId);
	state.reopenFilterMenuField = null;
	grid.resize();
}

function setPanelSourceRecords(panelId, records) {
	const state = ensureFilterState(panelId);
	if (!state) return;
	state.sourceRecords = Array.isArray(records) ? records : [];
	applyPanelFilters(panelId);
}

function appendPanelSourceRecords(panelId, records) {
	if (!records || records.length === 0) return;
	const state = ensureFilterState(panelId);
	if (!state) return;
	state.sourceRecords.push(...records);
	if (state.filterVisible) {
		applyPanelFilters(panelId);
		return;
	}
	const grid = state.w2uiGrid;
	if (!grid) return;
	grid.add(records);
	refreshFilterHeaderButtons(panelId);
}

function clearPanelFilterInputs(panelId) {
	const state = ensureFilterState(panelId);
	if (!state) return;
	state.filterValues = createDefaultFilterValues();
	syncFilterAttributeValues(panelId);
	applyPanelFilters(panelId);
}
function bindGridFilterControls(panelId) {
	const selector = `#w2overlay-${getPanelFilterMenuName(panelId)} [data-filter-popup-field]`;
	$(document)
		.off(`input.grid-filter-popup-${panelId}`, selector)
		.off(`change.grid-filter-popup-${panelId}`, selector)
		.on(`input.grid-filter-popup-${panelId} change.grid-filter-popup-${panelId}`, selector, function () {
			const state = ensureFilterState(panelId);
			if (!state) return;
			const key = this.dataset.filterPopupKey;
			const attrName = this.dataset.filterPopupAttr ? decodeURIComponent(this.dataset.filterPopupAttr) : null;
			if (attrName) {
				state.filterValues.attributes[attrName] = this.value;
			} else if (key) {
				state.filterValues[key] = this.value;
			} else if (this.dataset.filterPopupField) {
				state.filterValues[this.dataset.filterPopupField] = this.value;
			}
			applyPanelFilters(panelId);
		});
}

function updateSelectedItemFromRecord(record, panelId) {
	const nextPath = record ? record.path : null;
	const nextFilename = record ? (record.filenameRaw || record.filename) : null;
	const changed = selectedItemState.path !== nextPath || selectedItemState.panelId !== panelId;

	Object.assign(selectedItemState, {
		path: nextPath,
		filename: nextFilename,
		isDirectory: record ? (record.isFolder || false) : false,
		inode: record ? (record.inode || null) : null,
		dir_id: record ? (record.dir_id || null) : null,
		record: record || null,
		panelId
	});

	setActivePanelId(panelId);
	for (let pid = 2; pid <= 4; pid++) {
		if (panelState[pid]) {
			panelState[pid].attrEditMode = false;
			panelState[pid].notesEditMode = false;
		}
	}

	if (changed) {
		resetAllLabelsUiState();
		hideCreateTagModal();
		hideTagConfigModal();
	}

	refreshItemPropertiesInAllPanels();
}

export function setVisiblePanels(value) {
	visiblePanels = value;
	syncAddPanelButtonState();
}

export function setUnacknowledgedAlertCount(value) {
	unacknowledgedAlertCount = value;
}

export function resetAlertCount() {
	unacknowledgedAlertCount = 0;
}


function getPanelGrid(panelId) {
	return panelState[panelId]?.w2uiGrid || null;
}

function getPanelGridName(panelId) {
	const grid = getPanelGrid(panelId);
	return grid?.name || `grid-panel-${panelId}`;
}

function getPanelGridHeaderElement(panelId) {
	return document.getElementById(`grid_${getPanelGridName(panelId)}_header`);
}

function getPanelHeaderElement(panelId) {
	return document.querySelector(`#panel-${panelId} .panel-header`);
}

function syncAddPanelButtonState() {
	const button = document.getElementById('btn-sidebar-add-panel');
	if (!button) return;
	const canAddPanel = visiblePanels < 4;
	button.disabled = !canAddPanel;
	button.title = canAddPanel ? 'Add panel' : 'Maximum panels open';
}

function darkenRgb(rgbStr, amount = 30) {
	const match = rgbStr && rgbStr.match(/rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)/);
	if (!match) return rgbStr;
	const r = Math.max(0, parseInt(match[1]) - amount);
	const g = Math.max(0, parseInt(match[2]) - amount);
	const b = Math.max(0, parseInt(match[3]) - amount);
	return `rgb(${r}, ${g}, ${b})`;
}

function buildGridHeaderHtml(panelId, path, category) {
	const safePath = utils.escapeHtml(path || '');
	const buttonsHtml = panelId === 1
		? ''
		: '<button class="btn-panel-remove" title="Close panel">X</button>';

	const borderColor = category?.bgColor ? darkenRgb(category.bgColor) : '';
	const contentStyle = borderColor ? ` style="border-bottom-color: ${borderColor};"` : '';

	return `
		<div class="panel-header-content"${contentStyle}>
			<span class="panel-path">${safePath}</span>
			<input class="panel-path-input" type="text" value="${safePath}">
			<div class="panel-header-buttons">
				${buttonsHtml}
			</div>
		</div>
	`;

}

function updateGridHeader(panelId, path = panelState[panelId]?.currentPath || '') {
	const category = panelState[panelId]?.currentCategory;
	const headerHtml = buildGridHeaderHtml(panelId, path, category);
	const grid = getPanelGrid(panelId);
	if (grid) {
		grid.header = headerHtml;
	}

	const headerEl = getPanelGridHeaderElement(panelId);
	if (!headerEl) return;
	headerEl.innerHTML = headerHtml;
	attachGridHeaderEventListeners(panelId);
}

function attachGridHeaderEventListeners(panelId) {
	const headerEl = getPanelGridHeaderElement(panelId);
	if (!headerEl) return;
	const $header = $(headerEl);

	$header.find('.panel-path').off('click').on('click', function () {
		const $path = $(this);
		const $input = $header.find('.panel-path-input');
		$path.hide();
		$input.show().select().focus();
	});

	$header.find('.panel-path-input').off('keydown blur').on('keydown', function (e) {
		if (e.key === 'Enter') {
			e.preventDefault();
			const newPath = $(this).val().trim();
			const $path = $header.find('.panel-path');
			const $input = $(this);
			$input.hide();
			$path.show();
			if (newPath && newPath !== panelState[panelId].currentPath) {
				navigateToDirectory(newPath, panelId);
			}
		} else if (e.key === 'Escape') {
			e.preventDefault();
			$(this).hide();
			$header.find('.panel-path').show();
		}
	}).on('blur', function () {
		$(this).hide();
		$header.find('.panel-path').show();
	});

	$header.find('.btn-panel-refresh').off('click').on('click', async function () {
		setActivePanelId(panelId);
		await navigateToDirectory(panelState[panelId].currentPath, panelId);
	});

	if (panelId === 1) {
		$header.find('.btn-panel-settings').off('click').on('click', function () {
			setActivePanelId(panelId);
			showSettingsModal();
		});
	}

	if (panelId > 1) {
		$header.find('.btn-panel-remove').off('click').on('click', function () {
			removePanel(panelId);
		});
	}
}

function updatePanelHeader(panelId, path = panelState[panelId]?.currentPath || '') {
	const headerEl = getPanelHeaderElement(panelId);
	if (!headerEl) return;
	const category = panelState[panelId]?.currentCategory;
	const headerHtml = buildGridHeaderHtml(panelId, path, category);
	headerEl.innerHTML = headerHtml;
	headerEl.classList.add('active');
	if (category?.bgColor) {
		headerEl.style.background = category.bgColor;
		headerEl.style.borderBottomColor = category.textColor || darkenRgb(category.bgColor);
	} else {
		headerEl.style.background = '';
		headerEl.style.borderBottomColor = '';
	}
	attachPanelHeaderEventListeners(panelId);
}

function attachPanelHeaderEventListeners(panelId) {
	const headerEl = getPanelHeaderElement(panelId);
	if (!headerEl) return;
	const $header = $(headerEl);

	$header.find('.panel-path').off('click').on('click', function () {
		const $path = $(this);
		const $input = $header.find('.panel-path-input');
		$path.hide();
		$input.show().select().focus();
	});

	$header.find('.panel-path-input').off('keydown blur').on('keydown', function (e) {
		if (e.key === 'Enter') {
			e.preventDefault();
			const newPath = $(this).val().trim();
			const $path = $header.find('.panel-path');
			const $input = $(this);
			$input.hide();
			$path.show();
			if (newPath && newPath !== panelState[panelId].currentPath) {
				navigateToDirectory(newPath, panelId);
			}
		} else if (e.key === 'Escape') {
			e.preventDefault();
			$(this).hide();
			$header.find('.panel-path').show();
		}
	}).on('blur', function () {
		$(this).hide();
		$header.find('.panel-path').show();
	});

	$header.find('.btn-panel-refresh').off('click').on('click', async function () {
		setActivePanelId(panelId);
		await navigateToDirectory(panelState[panelId].currentPath, panelId);
	});

	if (panelId === 1) {
		$header.find('.btn-panel-settings').off('click').on('click', function () {
			setActivePanelId(panelId);
			showSettingsModal();
		});
	}

	if (panelId > 1) {
		$header.find('.btn-panel-remove').off('click').on('click', function () {
			removePanel(panelId);
		});
	}
}

// ---------- Virtual view URI helpers ----------
//
// On Windows, `?` is not a legal character in filesystem paths, so we use it
// as a separator between the real basePath and virtual query params.
//
// Format:  C:\Some\Path?orphans&trash
// Parsing: split on the FIRST `?` only.

/**
 * Parse a nav URI into `{ basePath, params }`.
 * `params` is a Set<string> (e.g. Set(['orphans', 'trash'])).
 * @param {string} input
 * @returns {{ basePath: string, params: Set<string> }}
 */
function parseNavUri(input) {
	const idx = input.indexOf('?');
	if (idx === -1) return { basePath: input, params: new Set() };
	const basePath = input.slice(0, idx);
	const params = new Set(
		input.slice(idx + 1).split('&').map(p => p.trim().toLowerCase()).filter(Boolean)
	);
	return { basePath, params };
}

/**
 * Build a nav URI from a basePath and a Set or array of param strings.
 * Returns plain basePath when params is empty.
 * @param {string} basePath
 * @param {Set<string>|string[]} params
 * @returns {string}
 */
function buildNavUri(basePath, params) {
	const arr = params instanceof Set ? [...params] : (params || []);
	if (arr.length === 0) return basePath;
	return basePath + '?' + arr.join('&');
}

/**
 * Toggle a single param on/off in a Set, returning the new Set.
 * @param {Set<string>} current
 * @param {string} param
 * @returns {Set<string>}
 */
function toggleNavParam(current, param) {
	const next = new Set(current);
	if (next.has(param)) next.delete(param);
	else next.add(param);
	return next;
}

function getPanelToolbarElement(panelId) {
	return document.querySelector(`#panel-${panelId} .panel-toolbar`);
}

export function renderPanelToolbar(panelId, mode = 'detail') {
	const container = getPanelToolbarElement(panelId);
	if (!container) return;
	const showDepth = mode !== 'gallery';
	const depth = panelState[panelId]?.depth || 0;
	const searchValue = panelState[panelId]?.toolbarSearch || '';
	const state = panelState[panelId] || {};
	const orphanCount = state.orphanCount || 0;
	const trashCount  = state.trashCount  || 0;
	const alCount     = state.autoLabelCount || 0;
	const navParams   = state.currentNavParams || new Set();
	const orphanActive = navParams.has('orphans');
	const trashActive  = navParams.has('trash');

	container.innerHTML = `
		<button class="panel-tb-btn" data-action="back" title="Back">
			<span class="w2ui-icon icon-navigate-back"></span>
		</button>
		<button class="panel-tb-btn" data-action="up" title="Parent">
			<span class="w2ui-icon icon-navigate-up"></span>
		</button>
		<button class="panel-tb-btn" data-action="refresh" title="Refresh">
			<span class="w2ui-icon w2ui-icon-reload"></span>
		</button>
		<span class="panel-tb-break"></span>
		<input type="text" class="panel-tb-search" placeholder="Search filename" value="${utils.escapeHtml(searchValue)}">
		${showDepth ? `
			<span class="panel-tb-break"></span>
			<div class="panel-tb-depth">
				<label>Depth</label>
				<input id="depth-input-${panelId}" type="number" min="0" max="99" value="${depth}">
			</div>
		` : ''}
		<span class="panel-tb-break"></span>
		<button class="panel-tb-btn panel-tb-virtual-btn${orphanActive ? ' is-active' : ''}" data-action="toggle-orphans" title="Orphaned files/dirs${orphanCount ? ` (${orphanCount})` : ''}">
			Orphans${orphanCount ? `<span class="panel-tb-badge">${orphanCount}</span>` : ''}
		</button>
		<button class="panel-tb-btn panel-tb-virtual-btn${trashActive ? ' is-active' : ''}" data-action="toggle-trash" title="Deleted files/dirs${trashCount ? ` (${trashCount})` : ''}">
			Trash${trashCount ? `<span class="panel-tb-badge">${trashCount}</span>` : ''}
		</button>
		<span class="panel-tb-break"></span>
		<button id="btn-toolbar-terminal-${panelId}" class="panel-tb-btn" title="Terminal">
			<img src="assets/icons/terminal.svg" style="width: 16px; height: 16px; pointer-events: none;">
		</button>
		<button id="btn-toolbar-save-${panelId}" class="panel-tb-btn" title="Save">
			<img src="assets/icons/save.svg" style="width: 16px; height: 16px; pointer-events: none;">
		</button>
		<button id="btn-toolbar-autolabel-${panelId}" class="panel-tb-btn" title="Suggested Labels${alCount ? ` (${alCount})` : ''}" style="position:relative;">
			<img src="assets/icons/tag.svg" style="width: 16px; height: 16px; pointer-events: none;">
			${alCount ? `<span class="panel-tb-badge">${alCount}</span>` : ''}
		</button>
		<div class="panel-tb-scan">
			<button id="btn-stop-scan-${panelId}" class="panel-tb-stop-scan" style="display:none;" title="Stop the current scan">&#9632; Stop</button>
			<span id="scan-status-${panelId}" class="panel-tb-scan-status" style="display:none;">Scanning…</span>
		</div>
	`;
	container.style.display = '';
	container.classList.add('active');
	attachPanelToolbarEventListeners(panelId);
}

export function hidePanelToolbar(panelId) {
	const container = getPanelToolbarElement(panelId);
	if (!container) return;
	container.classList.remove('active');
}

function attachPanelToolbarEventListeners(panelId) {
	const $tb = $(`#panel-${panelId} .panel-toolbar`);

	$tb.find('[data-action="back"]').off('click').on('click', function () {
		setActivePanelId(panelId);
		navigateBack();
	});

	$tb.find('[data-action="up"]').off('click').on('click', function () {
		navigateToParent(panelId);
	});

	$tb.find('[data-action="refresh"]').off('click').on('click', function () {
		setActivePanelId(panelId);
		if (panelState[panelId]?.currentPath) {
			navigateToDirectory(panelState[panelId].currentPath, panelId);
		}
	});

	$tb.find('[data-action="toggle-orphans"]').off('click').on('click', function () {
		setActivePanelId(panelId);
		const state = panelState[panelId];
		if (!state?.currentBasePath) return;
		const newParams = toggleNavParam(state.currentNavParams || new Set(), 'orphans');
		navigateToDirectory(buildNavUri(state.currentBasePath, newParams), panelId);
	});

	$tb.find('[data-action="toggle-trash"]').off('click').on('click', function () {
		setActivePanelId(panelId);
		const state = panelState[panelId];
		if (!state?.currentBasePath) return;
		const newParams = toggleNavParam(state.currentNavParams || new Set(), 'trash');
		navigateToDirectory(buildNavUri(state.currentBasePath, newParams), panelId);
	});

	$tb.find('.panel-tb-search').off('keydown blur').on('keydown', function (e) {
		if (e.key === 'Enter') {
			e.preventDefault();
			applyPanelToolbarSearch(panelId, this.value);
			this.blur();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			this.value = panelState[panelId].toolbarSearch || '';
			this.blur();
		}
	}).on('blur', function () {
		this.value = panelState[panelId].toolbarSearch || '';
	});

	$(`#btn-toolbar-save-${panelId}`).off('click').on('click', function (e) {
		e.stopPropagation();
		showSaveButtonMenu(panelId, this);
	});

	$(`#btn-toolbar-autolabel-${panelId}`).off('click').on('click', function () {
		autoLabels.openAutoLabelsModal(panelId);
	});
}

export function applyPanelToolbarSearch(panelId, value) {
	const state = panelState[panelId];
	if (!state) return;
	const query = String(value || '').trim();
	state.toolbarSearch = query;
	const grid = state.w2uiGrid;
	if (grid) {
		if (query) {
			grid.search('filename', query);
		} else {
			grid.searchReset();
		}
	}
	filterGalleryByName(panelId, query);
}

function filterGalleryByName(panelId, value) {
	const $gallery = $(`#panel-${panelId} .panel-gallery`);
	if ($gallery.length === 0) return;
	const q = String(value || '').trim().toLowerCase();
	$gallery.find('.gallery-item').each(function () {
		const name = ($(this).find('.gallery-item-name').text() || '').toLowerCase();
		this.style.display = (!q || name.includes(q)) ? '' : 'none';
	});
}

function getRelativePathFromRoot(rootPath, entryPath) {
	const root = rootPath.endsWith('\\') ? rootPath.slice(0, -1) : rootPath;
	if (entryPath.toLowerCase() === root.toLowerCase()) return '.';
	if (entryPath.toLowerCase().startsWith(root.toLowerCase() + '\\')) {
		return entryPath.substring(root.length + 1);
	}
	return entryPath;
}

function stopScan(panelId) {
	panelState[panelId].scanCancelled = true;
}

function setScanIndicator(panelId, scanning) {
	const stopBtn = document.getElementById(`btn-stop-scan-${panelId}`);
	const statusEl = document.getElementById(`scan-status-${panelId}`);
	if (stopBtn) stopBtn.style.display = scanning ? 'inline-block' : 'none';
	if (statusEl) statusEl.style.display = scanning ? 'inline' : 'none';
}

export function renderTagBadges(tagsJson, tagDefs) {
	const names = parseTagNames(tagsJson);
	if (names.length === 0) return '';
	const badges = names.map(name => {
		const def = tagDefs[name];
		const bg = def ? def.bgColor : '#888';
		const fg = def ? def.textColor : '#fff';
		return `<span class="tag-badge" style="background:${bg};color:${fg}">${name}</span>`;
	});
	return `<div class="tag-badge-container">${badges.join('')}</div>`;
}

function parseTagNames(tagsJson) {
	if (!tagsJson) return [];
	if (Array.isArray(tagsJson)) return tagsJson.filter(Boolean);
	try {
		const names = JSON.parse(tagsJson);
		return Array.isArray(names) ? names.filter(Boolean) : [];
	} catch {
		return [];
	}
}

function hexToRgbValue(hex) {
	if (!hex) return 'rgb(0, 0, 0)';
	if (hex.startsWith('rgb')) return hex;
	const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
	if (!result) return 'rgb(0, 0, 0)';
	return `rgb(${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)})`;
}

function getTagDefinitionMap() {
	return Object.fromEntries(allTags.map(tag => [tag.name, tag]));
}

function getCanonicalTagDefinition(name) {
	const normalizedName = String(name || '').trim().toLowerCase();
	if (!normalizedName) return null;
	return allTags.find(tag => tag.name.toLowerCase() === normalizedName) || null;
}

function isAssignedTag(assignedTagNames, tagName) {
	return assignedTagNames.some(name => String(name).toLowerCase() === String(tagName).toLowerCase());
}

function sortTagsForSuggestions(query) {
	const normalizedQuery = String(query || '').trim().toLowerCase();
	return [...allTags].sort((left, right) => {
		const leftName = left.name.toLowerCase();
		const rightName = right.name.toLowerCase();
		const leftRank = normalizedQuery
			? (leftName === normalizedQuery ? 0 : leftName.startsWith(normalizedQuery) ? 1 : leftName.includes(normalizedQuery) ? 2 : 3)
			: 3;
		const rightRank = normalizedQuery
			? (rightName === normalizedQuery ? 0 : rightName.startsWith(normalizedQuery) ? 1 : rightName.includes(normalizedQuery) ? 2 : 3)
			: 3;
		if (leftRank !== rightRank) return leftRank - rightRank;
		return left.name.localeCompare(right.name);
	});
}

function getTagSuggestions(uiState, assignedTagNames) {
	const normalizedQuery = String(uiState.inputValue || '').trim().toLowerCase();
	const matchingTags = sortTagsForSuggestions(normalizedQuery).filter(tag => {
		if (!normalizedQuery) return true;
		return tag.name.toLowerCase().includes(normalizedQuery);
	});

	if (matchingTags.length <= uiState.visibleSuggestionCount) {
		return matchingTags.map(tag => ({
			kind: 'tag',
			tag,
			disabled: isAssignedTag(assignedTagNames, tag.name)
		}));
	}

	const visibleTags = matchingTags.slice(0, Math.max(uiState.visibleSuggestionCount - 1, 0));
	const hiddenCount = matchingTags.length - visibleTags.length;
	return [
		...visibleTags.map(tag => ({
			kind: 'tag',
			tag,
			disabled: isAssignedTag(assignedTagNames, tag.name)
		})),
		{
			kind: 'more',
			hiddenCount
		}
	];
}

function getTagAction(uiState, assignedTagNames, options = {}) {
	const allowCreate = options.allowCreate !== false;
	const inputValue = String(uiState.inputValue || '').trim();
	if (!inputValue) {
		return { label: 'Add', kind: 'add', disabled: true };
	}

	const existingTag = getCanonicalTagDefinition(inputValue);
	if (existingTag) {
		return {
			label: 'Add',
			kind: 'add',
			tagName: existingTag.name,
			disabled: isAssignedTag(assignedTagNames, existingTag.name)
		};
	}

	if (!allowCreate) {
		return {
			label: 'Add',
			kind: 'add',
			tagName: inputValue,
			disabled: true
		};
	}

	return {
		label: 'Create',
		kind: 'create',
		tagName: inputValue,
		disabled: false
	};
}

async function getCategoryIconUrl(category, initials = null) {
	if (!category) return '';
	const cacheKey = `${category.name || ''}:${category.bgColor}:${category.textColor}:${initials || ''}`;
	if (labelIconCache.has(cacheKey)) {
		return labelIconCache.get(cacheKey);
	}
	const iconUrl = await window.electronAPI.generateFolderIcon(category.bgColor, category.textColor, initials || null);
	labelIconCache.set(cacheKey, iconUrl);
	return iconUrl;
}

function getCategoryDefinitionByName(name) {
	if (!name) return allCategories.Default || Object.values(allCategories)[0] || null;
	if (allCategories[name]) return allCategories[name];
	return Object.values(allCategories).find(category => category.name === name) || allCategories.Default || null;
}

function getDirectoryCategoryDetailText(stats) {
	if (stats.isForcedCategory) {
		return 'Forced manual assignment';
	}

	if (stats.isAutoAssignedCategory && stats.inheritedFromCategoryName) {
		return `Auto-assigned from ${stats.inheritedFromCategoryName}`;
	}

	if (stats.categoryName && stats.categoryName !== 'Default') {
		return 'Resolved automatically';
	}

	return 'No forced category';
}

function renderTagChip(tagName, definition) {
	const safeName = utils.escapeHtml(tagName);
	const encodedName = encodeURIComponent(tagName);
	const background = definition ? definition.bgColor : '#777';
	const textColor = definition ? definition.textColor : '#fff';
	return `
		<span class="item-props-tag-chip" style="background:${background};color:${textColor}">
			<span class="item-props-tag-chip-label">${safeName}</span>
			<button class="btn-item-props-remove-tag" data-tag-name="${encodedName}" title="Remove tag">&times;</button>
		</span>
	`;
}

function syncTagUiState(uiState, assignedTagNames) {
	const suggestions = getTagSuggestions(uiState, assignedTagNames);
	if (uiState.selectedSuggestionIndex >= suggestions.length) {
		uiState.selectedSuggestionIndex = suggestions.length - 1;
	}
	if (!uiState.isSuggestionOpen || suggestions.length === 0) {
		uiState.selectedSuggestionIndex = -1;
	}
	return suggestions;
}

function renderTagEditorMarkup(uiState, assignedTagNames, options = {}) {
	const tagDefs = getTagDefinitionMap();
	const suggestions = syncTagUiState(uiState, assignedTagNames);
	const tagAction = getTagAction(uiState, assignedTagNames, options);
	const inputPlaceholder = options.placeholder || 'Add or create a tag';
	const helperText = options.helperText
		? `<div class="item-props-tag-helper">${utils.escapeHtml(options.helperText)}</div>`
		: '';
	const currentTagsHtml = assignedTagNames.length > 0
		? assignedTagNames.map(tagName => renderTagChip(tagName, tagDefs[tagName])).join('')
		: '<span class="item-props-label-empty">No tags assigned</span>';

	const suggestionsHtml = uiState.isSuggestionOpen && suggestions.length > 0
		? `
			<div class="item-props-tag-suggestions">
				${suggestions.map((item, index) => {
					const selectedClass = uiState.selectedSuggestionIndex === index ? ' is-selected' : '';
					if (item.kind === 'more') {
						return `<div class="item-props-tag-suggestion item-props-tag-suggestion-more${selectedClass}" data-kind="more" data-index="${index}">(+${item.hiddenCount} more)</div>`;
					}
					const disabledClass = item.disabled ? ' is-disabled' : '';
					const tagName = utils.escapeHtml(item.tag.name);
					return `
						<div class="item-props-tag-suggestion${selectedClass}${disabledClass}" data-kind="tag" data-index="${index}" data-tag-name="${tagName}">
							<span class="tag-badge" style="background:${item.tag.bgColor};color:${item.tag.textColor}">${tagName}</span>
						</div>
					`;
				}).join('')}
			</div>
		`
		: '';

	return `
		<div class="item-props-current-tags">${currentTagsHtml}</div>
		${helperText}
		<div class="item-props-tag-editor">
			<div class="item-props-tag-input-shell${uiState.isInputFocused && uiState.selectedSuggestionIndex === -1 ? ' is-selected' : ''}">
				<input class="item-props-tag-input" type="text" value="${utils.escapeHtml(uiState.inputValue)}" placeholder="${utils.escapeHtml(inputPlaceholder)}">
				${suggestionsHtml}
			</div>
			<button class="btn-item-props-tag-action" type="button" ${tagAction.disabled ? 'disabled' : ''}>${tagAction.label}</button>
		</div>
	`;
}

async function renderLabelsSection(panelId, stats, options = {}) {
	const $panel = $(`#panel-${panelId}`);
	const $container = $panel.find('.item-props-labels-content');
	if ($container.length === 0) return;

	const uiState = ensureLabelsUiState(panelId);
	const assignedTagNames = Array.isArray(stats.tags) ? stats.tags : [];
	const tagEditorHtml = renderTagEditorMarkup(uiState, assignedTagNames);

	const currentCategory = getCategoryDefinitionByName(stats.categoryName) || {
		name: stats.categoryName || 'Default',
		bgColor: 'rgb(175, 175, 175)',
		textColor: 'rgb(51, 51, 51)'
	};
	const isForcedCategory = Boolean(stats.isForcedCategory);
	const showCategoryMenu = stats.isDirectory && isForcedCategory && uiState.isCategoryMenuOpen;
	const currentIcon = await getCategoryIconUrl(currentCategory, stats.isDirectory ? (selectedItemState.record?.initials || null) : null);
	const sortedCategories = Object.values(allCategories).sort((left, right) => left.name.localeCompare(right.name));
	const categoryEntries = await Promise.all(sortedCategories.map(async category => ({
		category,
		iconUrl: await getCategoryIconUrl(category)
	})));
	const categoryControlHtml = stats.isDirectory
		? `
			<div class="item-props-category-with-force">
				<div class="item-props-category-picker">
					<button class="item-props-category-trigger${showCategoryMenu ? ' is-open' : ''}" type="button" ${isForcedCategory ? '' : 'disabled'}>
						<img src="${currentIcon}" alt="" class="item-props-category-icon">
						<span>${utils.escapeHtml(currentCategory.name)}</span>
					</button>
					${showCategoryMenu ? `
						<div class="item-props-category-menu">
						${categoryEntries.map(({ category, iconUrl }) => `
							<div class="item-props-category-option${category.name === currentCategory.name ? ' is-selected' : ''}" data-category-name="${encodeURIComponent(category.name)}">
								<img src="${iconUrl}" alt="" class="item-props-category-icon">
								<span>${utils.escapeHtml(category.name)}</span>
							</div>
						`).join('')}
						</div>
				` : ''}
				</div>
				<label class="item-props-category-force">
					<input class="item-props-category-force-toggle" type="checkbox" ${isForcedCategory ? 'checked' : ''} ${stats.canForceCategory === false ? 'disabled' : ''}>
					<span>Force</span>
				</label>
			</div>
			<div class="item-props-category-detail">${utils.escapeHtml(getDirectoryCategoryDetailText(stats))}</div>
		`
		: `
			<div class="item-props-category-readonly">
				<img src="${currentIcon}" alt="" class="item-props-category-icon">
				<span>${utils.escapeHtml(currentCategory.name)}</span>
				<span class="item-props-category-note">From parent directory</span>
			</div>
		`;

	// Build initials and display name controls for directories
	let initialsGroupHtml = '';
	let displayNameGroupHtml = '';
	if (stats.isDirectory && selectedItemState.path) {
		const dirLabels = await window.electronAPI.getDirectoryLabels(selectedItemState.path);
		if (dirLabels) {
			const ini = dirLabels.initials || '';
			const iniInherit = dirLabels.initialsInherit;
			const iniForce = dirLabels.initialsForce;
			const iniIsInherited = dirLabels.initialsIsInherited;
			const iniResolved = dirLabels.resolvedInitials || '';
			const iniDisabled = iniIsInherited && !iniForce;
			const iniDetailText = iniIsInherited
				? `Inherited from ${dirLabels.displayNameSourceDir ? dirLabels.displayNameSourceDir.split(/[\\/]/).filter(Boolean).pop() : 'parent'}`
				: '';

			initialsGroupHtml = `
				<div class="item-props-label-group">
					<div class="item-props-label-group-title">Initials</div>
					<div class="item-props-label-group-value">
						<div class="item-props-label-inline-row">
							<input
								class="item-props-initials-input"
								type="text"
								maxlength="2"
								value="${utils.escapeHtml(iniDisabled ? iniResolved : ini)}"
								placeholder="AB"
								${iniDisabled ? 'disabled' : ''}
								style="width:40px;text-align:center;text-transform:uppercase;font-weight:bold;"
							>
							<label class="item-props-label-flag">
								<input class="item-props-initials-inherit-toggle" type="checkbox" ${iniInherit ? 'checked' : ''}>
								<span>Inheritable</span>
							</label>
							${iniIsInherited ? `
							<label class="item-props-label-flag">
								<input class="item-props-initials-force-toggle" type="checkbox" ${iniForce ? 'checked' : ''}>
								<span>Force</span>
							</label>` : ''}
						</div>
						${iniIsInherited && !iniForce ? `<div class="item-props-label-detail">${utils.escapeHtml(iniDetailText)}</div>` : ''}
					</div>
				</div>
			`;

			const dn = dirLabels.displayName || '';
			const dnInherit = dirLabels.displayNameInherit;
			const dnForce = dirLabels.displayNameForce;
			const dnIsInherited = dirLabels.displayNameIsInherited;
			const dnResolved = dirLabels.resolvedDisplayName || '';
			const dnDisabled = dnIsInherited && !dnForce;
			const dnDetailText = dnIsInherited && dirLabels.displayNameSourceDir
				? `Inherited from ${dirLabels.displayNameSourceDir.split(/[\\/]/).filter(Boolean).pop()}`
				: '';

			displayNameGroupHtml = `
				<div class="item-props-label-group">
					<div class="item-props-label-group-title">Display Name</div>
					<div class="item-props-label-group-value">
						<div class="item-props-label-inline-row">
							<input
								class="item-props-display-name-input"
								type="text"
								value="${utils.escapeHtml(dnDisabled ? dnResolved : dn)}"
								placeholder="Custom name"
								${dnDisabled ? 'disabled' : ''}
								style="flex:1;min-width:80px;"
							>
							<label class="item-props-label-flag">
								<input class="item-props-display-name-inherit-toggle" type="checkbox" ${dnInherit ? 'checked' : ''}>
								<span>Inheritable</span>
							</label>
							${dnIsInherited ? `
							<label class="item-props-label-flag">
								<input class="item-props-display-name-force-toggle" type="checkbox" ${dnForce ? 'checked' : ''}>
								<span>Force</span>
							</label>` : ''}
						</div>
						${dnIsInherited && !dnForce ? `<div class="item-props-label-detail">${utils.escapeHtml(dnDetailText)}</div>` : ''}
					</div>
				</div>
			`;
		}
	}

	$container.html(`
		<div class="item-props-label-group">
			<div class="item-props-label-group-title">Tags</div>
			<div class="item-props-label-group-value">
				${tagEditorHtml}
			</div>
		</div>
		<div class="item-props-label-group">
			<div class="item-props-label-group-title">Category</div>
			<div class="item-props-label-group-value">
				${categoryControlHtml}
			</div>
		</div>
		${initialsGroupHtml}
		${displayNameGroupHtml}
	`);

	if (options.restoreFocus) {
		const input = $panel.find('.item-props-tag-input').get(0);
		if (input) {
			input.focus();
			const valueLength = input.value.length;
			input.setSelectionRange(valueLength, valueLength);
		}
	}
}

async function rerenderLabelsSection(panelId, options = {}) {
	const stats = panelState[panelId].currentItemStats;
	if (!stats) return;
	await renderLabelsSection(panelId, stats, options);
}

function getSelectedGridRecord() {
	const sourcePanelId = selectedItemState.panelId;
	if (!sourcePanelId) return { grid: null, record: null };
	return {
		grid: panelState[sourcePanelId]?.w2uiGrid || null,
		record: selectedItemState.record || null
	};
}

function syncRecordTags(record, tagNames) {
	if (!record || !record.path) return;
	const tagDefs = getTagDefinitionMap();
	const tagsRaw = tagNames.length > 0 ? JSON.stringify(tagNames) : null;
	record.tagsRaw = tagsRaw;
	record.tags = renderTagBadges(tagsRaw, tagDefs);
	record.tagsText = getTagFilterText(tagsRaw);

	if (selectedItemState.record && selectedItemState.record.path === record.path && selectedItemState.record.isFolder === record.isFolder) {
		selectedItemState.record.tagsRaw = tagsRaw;
		selectedItemState.record.tags = record.tags;
	}

	for (const [panelKey, state] of Object.entries(panelState)) {
		const grid = state.w2uiGrid;
		if (Array.isArray(state.sourceRecords)) {
			const cachedRecord = state.sourceRecords.find(candidate => candidate.path === record.path && candidate.isFolder === record.isFolder);
			if (cachedRecord) {
				cachedRecord.tagsRaw = tagsRaw;
				cachedRecord.tags = renderTagBadges(tagsRaw, tagDefs);
				cachedRecord.tagsText = getTagFilterText(tagsRaw);
			}
		}
		if (!grid || !Array.isArray(grid.records)) continue;
		const gridRecord = grid.records.find(candidate => candidate.path === record.path && candidate.isFolder === record.isFolder);
		if (!gridRecord) continue;
		gridRecord.tagsRaw = tagsRaw;
		gridRecord.tags = renderTagBadges(tagsRaw, tagDefs);
		gridRecord.tagsText = getTagFilterText(tagsRaw);
		grid.refreshRow(gridRecord.recid);
		if (state.filterVisible) {
			applyPanelFilters(Number(panelKey));
		}
	}
}

function syncSelectedRecordTags(tagNames) {
	const { record } = getSelectedGridRecord();
	if (!record) return;
	syncRecordTags(record, tagNames);
}

async function refreshAllVisiblePropertyPanels() {
	for (let panelId = 2; panelId <= 4; panelId++) {
		if ($(`#panel-${panelId}`).is(':visible') && getPanelViewType(panelId) === 'properties') {
			await updateItemPropertiesPage(panelId);
		}
	}
}

async function addTagToCurrentItem(panelId, tagName) {
	const tagDefinition = getCanonicalTagDefinition(tagName);
	if (!tagDefinition || !selectedItemState.path) return;
	const assignedTagNames = Array.isArray(panelState[panelId].currentItemStats?.tags)
		? panelState[panelId].currentItemStats.tags
		: [];
	if (isAssignedTag(assignedTagNames, tagDefinition.name)) return;

	const result = await window.electronAPI.addTagToItem({
		path: selectedItemState.path,
		tagName: tagDefinition.name,
		isDirectory: selectedItemState.isDirectory,
		inode: selectedItemState.inode,
		dir_id: selectedItemState.dir_id
	});
	if (!result || result.success === false) {
		throw new Error(result?.error || 'Unable to add tag');
	}

	const nextTags = [...assignedTagNames, tagDefinition.name];
	panelState[panelId].currentItemStats.tags = nextTags;
	const uiState = ensureLabelsUiState(panelId);
	uiState.inputValue = '';
	uiState.visibleSuggestionCount = INITIAL_LABEL_SUGGESTION_COUNT;
	uiState.selectedSuggestionIndex = -1;
	uiState.isSuggestionOpen = false;
	syncSelectedRecordTags(nextTags);
	await refreshAllVisiblePropertyPanels();
}

function getTagConfigTargetLabel() {
	const record = tagConfigModalState.record;
	if (!record) return 'Item';
	const title = record.filenameRaw || record.filename || 'Item';
	return record.isFolder ? `${title} (directory)` : title;
}

async function renderTagConfigModal(options = {}) {
	if (!tagConfigModalState.record) return;
	$('#item-tags-modal-title').text(`Tags — ${getTagConfigTargetLabel()}`);
	$('#item-tags-modal-content').html(renderTagEditorMarkup(tagConfigModalState.uiState, tagConfigModalState.tags, {
		allowCreate: false,
		placeholder: 'Add existing tag',
		helperText: 'Assign existing tags here. Create new tags from Item Properties or Label Manager.'
	}));
	if (options.restoreFocus) {
		const input = $('#item-tags-modal-content').find('.item-props-tag-input').get(0);
		if (input) {
			input.focus();
			const valueLength = input.value.length;
			input.setSelectionRange(valueLength, valueLength);
		}
	}
}

async function rerenderTagConfigModal(options = {}) {
	if (!tagConfigModalState.record) return;
	await renderTagConfigModal(options);
}

async function addTagToTagModalItem(tagName) {
	const record = tagConfigModalState.record;
	const tagDefinition = getCanonicalTagDefinition(tagName);
	if (!record || !tagDefinition) return;
	if (isAssignedTag(tagConfigModalState.tags, tagDefinition.name)) return;

	const result = await window.electronAPI.addTagToItem({
		path: record.path,
		tagName: tagDefinition.name,
		isDirectory: record.isFolder,
		inode: record.inode,
		dir_id: record.dir_id
	});
	if (!result || result.success === false) {
		throw new Error(result?.error || 'Unable to add tag');
	}

	tagConfigModalState.tags = [...tagConfigModalState.tags, tagDefinition.name];
	tagConfigModalState.uiState.inputValue = '';
	tagConfigModalState.uiState.visibleSuggestionCount = INITIAL_LABEL_SUGGESTION_COUNT;
	tagConfigModalState.uiState.selectedSuggestionIndex = -1;
	tagConfigModalState.uiState.isSuggestionOpen = false;
	syncRecordTags(record, tagConfigModalState.tags);
	if (selectedItemState.path === record.path) {
		await refreshAllVisiblePropertyPanels();
	}
	await rerenderTagConfigModal({ restoreFocus: true });
}

async function removeTagFromTagModalItem(tagName) {
	const record = tagConfigModalState.record;
	if (!record) return;
	const result = await window.electronAPI.removeTagFromItem({
		path: record.path,
		tagName,
		isDirectory: record.isFolder,
		inode: record.inode,
		dir_id: record.dir_id
	});
	if (!result || result.success === false) {
		throw new Error(result?.error || 'Unable to remove tag');
	}

	tagConfigModalState.tags = tagConfigModalState.tags.filter(name => name !== tagName);
	syncRecordTags(record, tagConfigModalState.tags);
	if (selectedItemState.path === record.path) {
		await refreshAllVisiblePropertyPanels();
	}
	await rerenderTagConfigModal();
}

async function runPrimaryTagActionForTagModal() {
	const action = getTagAction(tagConfigModalState.uiState, tagConfigModalState.tags, { allowCreate: false });
	if (action.disabled) return;
	await addTagToTagModalItem(action.tagName);
}

async function activateTagSuggestionForTagModal(suggestionIndex) {
	const suggestions = getTagSuggestions(tagConfigModalState.uiState, tagConfigModalState.tags);
	const item = suggestions[suggestionIndex];
	if (!item) return;

	if (item.kind === 'more') {
		tagConfigModalState.uiState.visibleSuggestionCount += LABEL_SUGGESTION_INCREMENT;
		tagConfigModalState.uiState.isSuggestionOpen = true;
		tagConfigModalState.uiState.selectedSuggestionIndex = Math.min(suggestionIndex, getTagSuggestions(tagConfigModalState.uiState, tagConfigModalState.tags).length - 1);
		await rerenderTagConfigModal({ restoreFocus: true });
		return;
	}

	if (item.disabled) return;
	await addTagToTagModalItem(item.tag.name);
}

export async function openTagConfigModal(record, panelId) {
	if (!record) return;
	tagConfigModalState.record = record;
	tagConfigModalState.panelId = panelId;
	tagConfigModalState.tags = parseTagNames(record.tagsRaw);
	tagConfigModalState.uiState = createDefaultLabelsUiState();

	$('#item-tags-modal').css('display', 'flex');
	await renderTagConfigModal({ restoreFocus: true });

	$('#btn-item-tags-close')
		.off('click.itemTagsModal')
		.on('click.itemTagsModal', function () {
			hideTagConfigModal();
		});

	$('#item-tags-modal')
		.off('mousedown.itemTagsOverlay')
		.on('mousedown.itemTagsOverlay', function (event) {
			if (event.target === this) {
				hideTagConfigModal();
			}
		});

	const $content = $('#item-tags-modal-content');
	$content.off('mousedown.tagDismiss').on('mousedown.tagDismiss', function (event) {
		if (!$(event.target).closest('.item-props-tag-editor').length && tagConfigModalState.uiState.isSuggestionOpen) {
			tagConfigModalState.uiState.isSuggestionOpen = false;
			tagConfigModalState.uiState.isInputFocused = false;
			tagConfigModalState.uiState.selectedSuggestionIndex = -1;
			rerenderTagConfigModal();
		}
	});

	$content.off('input.tagEditor').on('input.tagEditor', '.item-props-tag-input', async function () {
		tagConfigModalState.uiState.inputValue = $(this).val();
		tagConfigModalState.uiState.visibleSuggestionCount = INITIAL_LABEL_SUGGESTION_COUNT;
		tagConfigModalState.uiState.selectedSuggestionIndex = -1;
		tagConfigModalState.uiState.isInputFocused = true;
		tagConfigModalState.uiState.isSuggestionOpen = true;
		await rerenderTagConfigModal({ restoreFocus: true });
	});

	$content.off('focus.tagEditor').on('focus.tagEditor', '.item-props-tag-input', async function () {
		const currentValue = $(this).val();
		if (
			tagConfigModalState.uiState.isInputFocused &&
			tagConfigModalState.uiState.isSuggestionOpen &&
			tagConfigModalState.uiState.selectedSuggestionIndex === -1 &&
			tagConfigModalState.uiState.inputValue === currentValue
		) {
			return;
		}
		tagConfigModalState.uiState.inputValue = currentValue;
		tagConfigModalState.uiState.isInputFocused = true;
		tagConfigModalState.uiState.isSuggestionOpen = true;
		tagConfigModalState.uiState.selectedSuggestionIndex = -1;
		await rerenderTagConfigModal({ restoreFocus: true });
	});

	$content.off('blur.tagEditor').on('blur.tagEditor', '.item-props-tag-input', function () {
		setTimeout(() => {
			const editorHasFocus = $('#item-tags-modal-content').find('.item-props-tag-editor').find(document.activeElement).length > 0;
			if (!editorHasFocus) {
				tagConfigModalState.uiState.isInputFocused = false;
				tagConfigModalState.uiState.isSuggestionOpen = false;
				tagConfigModalState.uiState.selectedSuggestionIndex = -1;
				rerenderTagConfigModal();
			}
		}, 0);
	});

	$content.off('keydown.tagEditor').on('keydown.tagEditor', '.item-props-tag-input', async function (event) {
		const suggestions = getTagSuggestions(tagConfigModalState.uiState, tagConfigModalState.tags);

		if (event.key === 'ArrowDown') {
			event.preventDefault();
			tagConfigModalState.uiState.isSuggestionOpen = true;
			tagConfigModalState.uiState.selectedSuggestionIndex = Math.min(tagConfigModalState.uiState.selectedSuggestionIndex + 1, suggestions.length - 1);
			await rerenderTagConfigModal({ restoreFocus: true });
			return;
		}

		if (event.key === 'ArrowUp') {
			event.preventDefault();
			tagConfigModalState.uiState.selectedSuggestionIndex = Math.max(tagConfigModalState.uiState.selectedSuggestionIndex - 1, -1);
			tagConfigModalState.uiState.isSuggestionOpen = true;
			await rerenderTagConfigModal({ restoreFocus: true });
			return;
		}

		if (event.key === 'Enter') {
			event.preventDefault();
			try {
				if (tagConfigModalState.uiState.selectedSuggestionIndex >= 0) {
					await activateTagSuggestionForTagModal(tagConfigModalState.uiState.selectedSuggestionIndex);
					return;
				}
				await runPrimaryTagActionForTagModal();
			} catch (err) {
				w2alert('Error updating tags: ' + err.message);
			}
			return;
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			tagConfigModalState.uiState.isSuggestionOpen = false;
			tagConfigModalState.uiState.selectedSuggestionIndex = -1;
			await rerenderTagConfigModal({ restoreFocus: true });
		}
	});

	$content.off('mousedown.tagAction').on('mousedown.tagAction', '.btn-item-props-tag-action', async function (event) {
		event.preventDefault();
		try {
			await runPrimaryTagActionForTagModal();
		} catch (err) {
			w2alert('Error updating tags: ' + err.message);
		}
	});

	$content.off('mousedown.tagSuggestion').on('mousedown.tagSuggestion', '.item-props-tag-suggestion', async function (event) {
		event.preventDefault();
		const index = Number($(this).attr('data-index'));
		if (Number.isNaN(index)) return;
		try {
			await activateTagSuggestionForTagModal(index);
		} catch (err) {
			w2alert('Error updating tags: ' + err.message);
		}
	});

	$content.off('click.removeTag').on('click.removeTag', '.btn-item-props-remove-tag', async function (event) {
		event.preventDefault();
		event.stopPropagation();
		const tagName = decodeURIComponent($(this).attr('data-tag-name') || '');
		if (!tagName) return;
		try {
			await removeTagFromTagModalItem(tagName);
		} catch (err) {
			w2alert('Error removing tag: ' + err.message);
		}
	});
}

export function hideTagConfigModal() {
	tagConfigModalState.record = null;
	tagConfigModalState.panelId = null;
	tagConfigModalState.tags = [];
	tagConfigModalState.uiState = createDefaultLabelsUiState();
	$('#item-tags-modal').hide();
	$('#item-tags-modal-content').empty();
}

async function runPrimaryTagAction(panelId) {
	const uiState = ensureLabelsUiState(panelId);
	const assignedTagNames = Array.isArray(panelState[panelId].currentItemStats?.tags)
		? panelState[panelId].currentItemStats.tags
		: [];
	const action = getTagAction(uiState, assignedTagNames);
	if (action.disabled) return;
	if (action.kind === 'add') {
		await addTagToCurrentItem(panelId, action.tagName);
		return;
	}
	uiState.isSuggestionOpen = false;
	uiState.isInputFocused = false;
	uiState.selectedSuggestionIndex = -1;
	await openCreateTagModal(panelId, action.tagName);
}

async function activateTagSuggestion(panelId, suggestionIndex) {
	const uiState = ensureLabelsUiState(panelId);
	const assignedTagNames = Array.isArray(panelState[panelId].currentItemStats?.tags)
		? panelState[panelId].currentItemStats.tags
		: [];
	const suggestions = getTagSuggestions(uiState, assignedTagNames);
	const item = suggestions[suggestionIndex];
	if (!item) return;

	if (item.kind === 'more') {
		uiState.visibleSuggestionCount += LABEL_SUGGESTION_INCREMENT;
		uiState.isSuggestionOpen = true;
		uiState.selectedSuggestionIndex = Math.min(suggestionIndex, getTagSuggestions(uiState, assignedTagNames).length - 1);
		await rerenderLabelsSection(panelId, { restoreFocus: true });
		return;
	}

	if (item.disabled) return;
	await addTagToCurrentItem(panelId, item.tag.name);
}

async function removeTagFromCurrentItem(panelId, tagName) {
	if (!selectedItemState.path) return;
	const result = await window.electronAPI.removeTagFromItem({
		path: selectedItemState.path,
		tagName,
		isDirectory: selectedItemState.isDirectory,
		inode: selectedItemState.inode,
		dir_id: selectedItemState.dir_id
	});
	if (!result || result.success === false) {
		throw new Error(result?.error || 'Unable to remove tag');
	}

	const currentTags = Array.isArray(panelState[panelId].currentItemStats?.tags)
		? panelState[panelId].currentItemStats.tags
		: [];
	const nextTags = currentTags.filter(name => name !== tagName);
	panelState[panelId].currentItemStats.tags = nextTags;
	syncSelectedRecordTags(nextTags);
	await refreshAllVisiblePropertyPanels();
}

async function updateSelectedDirectoryCategory(categoryName) {
	const { grid, record } = getSelectedGridRecord();
	if (!record) return;
	record.type = categoryName;
	const category = getCategoryDefinitionByName(categoryName);
	if (record.isFolder && category) {
		const iconUrl = await getCategoryIconUrl(category, record.initials || null);
		const className = getRowClassName(record.changeState);
		record.icon = className
			? `<div class="${className}"><img src="${iconUrl}" style="width: 20px; height: 20px; object-fit: contain; cursor: pointer;" title="Click to set initials"></div>`
			: `<img src="${iconUrl}" style="width: 20px; height: 20px; object-fit: contain; cursor: pointer;" title="Click to set initials">`;
	}
	if (grid && record.recid) {
		grid.refreshRow(record.recid);
	}
}

async function refreshCategoryAfterLabelsUpdate(panelId) {
	await refreshAllVisiblePropertyPanels();
	const refreshedStats = panelState[panelId].currentItemStats;
	if (refreshedStats) {
		await updateSelectedDirectoryCategory(refreshedStats.categoryName);
	}
}

/**
 * Build the window title string for Panel 1 based on settings.
 * @param {string} dirPath  - The current (normalized, forward-slash) directory path
 * @param {object|null} labels - Object with resolvedDisplayName, displayNameIsInherited, displayNameSourceDir
 * @param {object} settings - App settings with title_default_format and title_display_name_format
 */
function buildWindowTitle(dirPath, labels, settings) {
	const normalizedPath = (dirPath || '').replace(/\\/g, '/');
	const parts = normalizedPath.split('/').filter(Boolean);
	const folderBasename = parts[parts.length - 1] || dirPath;
	const defaultFmt = (settings && settings.title_default_format) || 'folder-name';
	const dnFmt = (settings && settings.title_display_name_format) || 'name-relative-path';

	const resolvedDisplayName = labels && labels.resolvedDisplayName;

	// Helper: build default-format title (no display name path)
	function defaultTitle() {
		if (defaultFmt === 'full-path') {
			return normalizedPath.replace(/\//g, '\\');
		}
		if (defaultFmt === 'full-path-reversed') {
			return [...parts].reverse().join('|');
		}
		return folderBasename;
	}

	if (!resolvedDisplayName) {
		return defaultTitle();
	}

	// Helper: reverse a backslash-separated path string into pipe-separated
	function reversePath(pathStr) {
		return pathStr.split('\\').filter(Boolean).reverse().join('|');
	}

	if (dnFmt === 'name-only') {
		return resolvedDisplayName;
	}

	if (dnFmt === 'name-folder') {
		return `${resolvedDisplayName} (${folderBasename})`;
	}

	if (dnFmt === 'name-full-path') {
		return `${resolvedDisplayName} (${normalizedPath.replace(/\//g, '\\')})`;
	}

	if (dnFmt === 'name-full-path-reversed') {
		return `${resolvedDisplayName} (${[...parts].reverse().join('|')})`;
	}

	// name-relative-path and name-relative-path-reversed — need source dir for inherited names
	const isInherited = labels.displayNameIsInherited && labels.displayNameSourceDir;

	if (dnFmt === 'name-relative-path') {
		if (isInherited) {
			const srcParts = labels.displayNameSourceDir.replace(/\\/g, '/').split('/').filter(Boolean);
			const sourceBasename = srcParts[srcParts.length - 1] || labels.displayNameSourceDir;
			const relative = parts.slice(srcParts.length).join('\\');
			return relative
				? `${resolvedDisplayName} (${sourceBasename}\\${relative})`
				: `${resolvedDisplayName} (${sourceBasename})`;
		}
		return `${resolvedDisplayName} (${folderBasename})`;
	}

	if (dnFmt === 'name-relative-path-reversed') {
		if (isInherited) {
			const srcParts = labels.displayNameSourceDir.replace(/\\/g, '/').split('/').filter(Boolean);
			const sourceBasename = srcParts[srcParts.length - 1] || labels.displayNameSourceDir;
			const relParts = parts.slice(srcParts.length);
			const combined = [sourceBasename, ...relParts];
			const reversed = [...combined].reverse().join('|');
			return `${resolvedDisplayName} (${reversed})`;
		}
		return `${resolvedDisplayName} (${folderBasename})`;
	}

	// Fallback
	return `${resolvedDisplayName} (${folderBasename})`;
}

export async function maybeRefreshPanel1TitleAndIcon() {
	const panel1Path = panelState[1]?.currentPath;
	if (!panel1Path) return;
	const category = await window.electronAPI.getCategoryForDirectory(panel1Path);
	if (!category) return;
	const labels = await window.electronAPI.getDirectoryLabels(panel1Path);
	const resolvedInitials = labels ? labels.resolvedInitials : null;
	await window.electronAPI.updateWindowIcon(category.name, resolvedInitials);
	const settings = await window.electronAPI.getSettings();
	const windowTitle = buildWindowTitle(panel1Path, labels, settings);
	await window.electronAPI.setWindowTitle(windowTitle);
}

async function assignCategoryFromLabels(panelId, categoryName, force = true) {
	if (!selectedItemState.isDirectory || !selectedItemState.path) return;
	const result = await window.electronAPI.assignCategoryToDirectory(selectedItemState.path, categoryName, force);
	if (!result || result.success === false) {
		throw new Error(result?.error || 'Unable to assign category');
	}
	const uiState = ensureLabelsUiState(panelId);
	uiState.isCategoryMenuOpen = false;
	await refreshCategoryAfterLabelsUpdate(panelId);
}

async function clearForcedCategoryFromLabels(panelId) {
	if (!selectedItemState.isDirectory || !selectedItemState.path) return;
	const result = await window.electronAPI.removeDirectoryAssignment(selectedItemState.path);
	if (!result || result.success === false) {
		throw new Error(result?.error || 'Unable to clear category assignment');
	}
	const uiState = ensureLabelsUiState(panelId);
	uiState.isCategoryMenuOpen = false;
	await refreshCategoryAfterLabelsUpdate(panelId);
}

function showCreateTagError(message) {
	const $error = $('#item-tag-create-error');
	if (!message) {
		$error.hide().text('');
		return;
	}
	$error.text(message).show();
}

async function submitCreateTagModal(shouldAdd) {
	const panelId = createTagModalState.panelId;
	const addHandler = createTagModalState.addHandler;
	const afterCreate = createTagModalState.afterCreate;
	const name = ($('#item-tag-create-name').val() || '').trim();
	const bgColor = $('#item-tag-create-bgColor').val();
	const textColor = $('#item-tag-create-textColor').val();
	const description = ($('#item-tag-create-description').val() || '').trim();

	if (!name) {
		showCreateTagError('Please enter a tag name.');
		return;
	}
	if (getCanonicalTagDefinition(name)) {
		showCreateTagError('That tag already exists.');
		return;
	}

	try {
		await window.electronAPI.saveTag({
			name,
			bgColor: hexToRgbValue(bgColor),
			textColor: hexToRgbValue(textColor),
			description
		});
		await loadTagsList();
		hideCreateTagModal();
		if (shouldAdd) {
			if (typeof addHandler === 'function') {
				await addHandler(name);
			} else if (panelId) {
				await addTagToCurrentItem(panelId, name);
			}
		} else {
			if (typeof afterCreate === 'function') {
				await afterCreate();
			} else {
				await refreshAllVisiblePropertyPanels();
			}
		}
	} catch (err) {
		showCreateTagError(err.message || 'Unable to create tag.');
	}
}

async function openCreateTagModal(panelId, initialName, options = {}) {
	createTagModalState.panelId = panelId;
	createTagModalState.addHandler = options.addHandler || null;
	createTagModalState.afterCreate = options.afterCreate || null;
	$('#item-tag-create-name').val(initialName || '');
	utils.enforceTagNameInput(document.getElementById('item-tag-create-name'));

	// Set color pickers (w2field stores without #)
	document.getElementById('item-tag-create-bgColor').value = 'efe4b0';
	document.getElementById('item-tag-create-textColor').value = '000000';
	document.getElementById('item-tag-create-bgColor')._w2field?.refresh?.();
	document.getElementById('item-tag-create-textColor')._w2field?.refresh?.();

	$('#item-tag-create-description').val('');
	showCreateTagError('');
	$('#item-tag-create-modal').show();

	// Initialize color pickers if not already done
	const bgEl = document.getElementById('item-tag-create-bgColor');
	const textEl = document.getElementById('item-tag-create-textColor');
	if (bgEl && !bgEl._w2field) {
		new w2field('color', { el: bgEl });
		new w2field('color', { el: textEl });
	}

	$('#btn-item-tag-create-close, #btn-item-tag-create-cancel')
		.off('click.itemTagCreate')
		.on('click.itemTagCreate', function () {
			hideCreateTagModal();
		});

	$('#btn-item-tag-create-submit')
		.off('click.itemTagCreate')
		.on('click.itemTagCreate', async function () {
			await submitCreateTagModal(false);
		});

	$('#btn-item-tag-create-submit-add')
		.off('click.itemTagCreate')
		.on('click.itemTagCreate', async function () {
			await submitCreateTagModal(true);
		});

	$('#item-tag-create-modal')
		.off('click.itemTagCreateOverlay')
		.on('click.itemTagCreateOverlay', function (event) {
			if (event.target === this) {
				hideCreateTagModal();
			}
		});

	$('#item-tag-create-form input')
		.off('keydown.itemTagCreate')
		.on('keydown.itemTagCreate', async function (event) {
			if (event.key === 'Enter') {
				event.preventDefault();
				await submitCreateTagModal(false);
			}
		});

	setTimeout(() => {
		const input = document.getElementById('item-tag-create-name');
		if (input) {
			input.focus();
			input.select();
		}
	}, 0);
}

export function hideCreateTagModal() {
	createTagModalState.panelId = null;
	createTagModalState.addHandler = null;
	createTagModalState.afterCreate = null;
	showCreateTagError('');
	$('#item-tag-create-modal').hide();
}

export function handleTransientEscape() {
	// Exit column reorder mode first if active on any panel
	for (let panelId = 1; panelId <= 4; panelId++) {
		if (panelState[panelId]?.columnReorderMode) {
			setColumnReorderMode(panelId, false);
			return true;
		}
	}

	if ($('#item-tag-create-modal').is(':visible')) {
		hideCreateTagModal();
		return true;
	}

	if ($('#item-tags-modal').is(':visible')) {
		hideTagConfigModal();
		return true;
	}

	let handled = false;
	for (let panelId = 2; panelId <= 4; panelId++) {
		const uiState = panelState[panelId]?.labelsUiState;
		if (!uiState) continue;
		if (uiState.isCategoryMenuOpen || uiState.isSuggestionOpen) {
			uiState.isCategoryMenuOpen = false;
			uiState.isSuggestionOpen = false;
			uiState.isInputFocused = false;
			uiState.selectedSuggestionIndex = -1;
			rerenderLabelsSection(panelId);
			handled = true;
		}
	}
	return handled;
}

async function buildGridRecords(entries, panelId, iconCache, categoryCache, tagDefs = {}) {
	const state = panelState[panelId];
	const records = [];

	function applyClass(content, className) {
		if (!className) return content;
		return `<div class="${className}">${content}</div>`;
	}

	const folders = entries.filter(e => e.isDirectory);
	const files = entries.filter(e => !e.isDirectory);

	for (const folder of folders) {
		let iconUrl;
		let cat;
		if (folder.changeState === 'moved') {
			iconUrl = 'assets/folder-moved.svg';
		} else {
			cat = categoryCache.get(folder.path);
			if (!cat) {
				cat = await window.electronAPI.getCategoryForDirectory(folder.path);
				categoryCache.set(folder.path, cat);
			}
			const iconKey = `${cat.bgColor}:${cat.textColor}:${folder.initials || ''}`;
			iconUrl = iconCache.get(iconKey);
			if (!iconUrl) {
				iconUrl = await window.electronAPI.generateFolderIcon(cat.bgColor, cat.textColor, folder.initials || null);
				iconCache.set(iconKey, iconUrl);
			}
		}

		const className = getRowClassName(folder.changeState);
		const permsText = formatPerms(folder.perms);
		records.push({
			recid: state.recidCounter++,
			icon: applyClass(`<img src="${iconUrl}" style="width: 20px; height: 20px; object-fit: contain; cursor: pointer;" title="Click to set initials">`, className),
			filename: applyClass(folder.displayFilename || folder.filename, className),
			filenameRaw: folder.filename,
			size: applyClass('-', className),
			dateModified: applyClass(new Date(folder.dateModified).toLocaleString(), className),
			modified: -new Date(folder.dateModified).getTime(),
			perms: applyClass(getPermsCell(folder), className),
			permsText,
			checksum: applyClass('—', className),
			checksumValue: null,
			tags: renderTagBadges(folder.tags || null, tagDefs),
			tagsRaw: folder.tags || null,
			type: applyClass(folder.changeState === 'moved' ? '' : (cat ? cat.name || '' : ''), className),
			isFolder: true,
			path: folder.path,
			changeState: folder.changeState,
			inode: folder.inode,
			initials: folder.initials || null,
			dir_id: folder.dir_id || null,
			orphan_id: folder.orphan_id || null,
			orphan_type: folder.orphan_id ? 'dir' : null,
			new_dir_id: folder.new_dir_id || null,
			hasNotes: folder.hasNotes || false,
			todo: folder.todoCounts || null
		});
	}

	for (const file of files) {
		const className = getRowClassName(file.changeState);

		if (file.changeState === 'permError') {
			const iconSvg = '<img src="assets/icons/file-question.png" style="width: 20px; height: 20px; object-fit: contain;">';
			const permsText = formatPerms(file.perms);
			records.push({
				recid: state.recidCounter++,
				icon: applyClass(iconSvg, className),
				filename: applyClass(file.displayFilename || file.filename, className),
				filenameRaw: file.filename,
				size: applyClass('—', className),
				dateModified: applyClass('—', className),
				modified: null,
				dateModifiedRaw: null,
				dateCreated: '—',
				dateCreatedRaw: null,
				perms: applyClass(getPermsCell(file), className),
				permsText,
				checksum: applyClass('—', className),
				checksumStatus: null,
				checksumValue: null,
				tags: '',
				tagsRaw: null,
				type: applyClass('', className),
				isFolder: false,
				path: file.path,
				changeState: 'permError',
				inode: file.inode,
				dir_id: file.dir_id || null,
				orphan_id: null,
				orphan_type: null,
				new_dir_id: null,
				hasNotes: file.hasNotes || false,
				todo: file.todoCounts || null
			});
			continue;
		}

		const dateModifiedContent = getDateModifiedCell(file, file.changeState);
		const checksumCell = getChecksumCell(file, file.changeState);
		const matchedFt = matchFileType(file.filename);
		const ftIconFile = (matchedFt && matchedFt.icon) ? matchedFt.icon : 'user-file.png';
		const ftType = matchedFt ? matchedFt.type : '';
		const permsText = formatPerms(file.perms);
		const iconSvg = file.changeState === 'moved'
			? '<img src="assets/icons/file-moved.svg" style="width: 20px; height: 20px; object-fit: contain;">'
			: `<img src="assets/icons/${ftIconFile}" style="width: 20px; height: 20px; object-fit: contain;">`;

		records.push({
			recid: state.recidCounter++,
			icon: applyClass(iconSvg, className),
			filename: applyClass(file.displayFilename || file.filename, className),
			filenameRaw: file.filename,
			size: applyClass(utils.formatBytes(file.size), className),
			dateModified: dateModifiedContent,
			modified: -new Date(file.dateModified).getTime(),
			dateModifiedRaw: file.dateModified,
			dateCreated: file.dateCreated ? new Date(file.dateCreated).toLocaleDateString() : '-',
			dateCreatedRaw: file.dateCreated,
			perms: applyClass(getPermsCell(file), className),
			permsText,
			checksum: checksumCell,
			checksumStatus: file.checksumStatus || null,
			checksumValue: file.checksumValue || null,
			tags: renderTagBadges(file.tags || null, tagDefs),
			tagsRaw: file.tags || null,
			type: applyClass(file.changeState === 'moved' ? '' : ftType, className),
			isFolder: false,
			path: file.path,
			changeState: file.changeState,
			inode: file.inode,
			dir_id: file.dir_id || null,
			orphan_id: file.orphan_id || null,
			orphan_type: file.orphan_id ? 'file' : null,
			new_dir_id: file.new_dir_id || null,
			hasNotes: file.hasNotes || false,
			todo: file.todoCounts || null
		});

		if (file.attributes) {
			let attrObj = {};
			try { attrObj = typeof file.attributes === 'string' ? JSON.parse(file.attributes) : file.attributes; } catch (_) { }
			const lastRecord = records[records.length - 1];
			for (const [key, value] of Object.entries(attrObj)) {
				lastRecord[`attr_${key}`] = value !== null && value !== undefined ? String(value) : '';
			}
		}
	}

	return records;
}

function addRecordsToGrid(records, panelId) {
	if (!records || records.length === 0) return;
	appendPanelSourceRecords(panelId, records);
}

async function processPendingDirs(panelId, rootPath, iconCache, categoryCache, token, tagDefs = {}, hideDotDotDirectory = false, showFolderNameWithDotEntries = false) {
	const state = panelState[panelId];
	while (state.pendingDirs.length > 0 && !state.scanCancelled && state.scanToken === token) {
		const { path: dirPath, maxDepth, currentDepth } = state.pendingDirs.shift();
		const scanResult = await window.electronAPI.scanDirectoryWithComparison(dirPath, false);
		if (state.scanCancelled || state.scanToken !== token) break;
		if (!scanResult.success) continue;
		if (scanResult.alertsCreated) {
			unacknowledgedAlertCount += scanResult.alertsCreated;
			updateAlertBadge();
		}

		const rawEntries = scanResult.entries || [];
		let entries = rawEntries
			.filter(e => e.filename !== '.' && e.changeState !== 'orphan' && e.changeState !== 'moved')
			.map(e => ({ ...e, displayFilename: getRelativePathFromRoot(rootPath, e.path) }));

		if (!hideDotDotDirectory && state.scanToken === token) {
			const parentMetadata = await window.electronAPI.getParentDirectoryMetadata(dirPath);
			if (parentMetadata) {
				const dotIndex = entries.findIndex(e => e.filename === '.');
				const insertIndex = dotIndex >= 0 ? dotIndex + 1 : 0;
				let parentDisplayFilename = '..';
				if (showFolderNameWithDotEntries && parentMetadata.path) {
					const parentFolderName = parentMetadata.path.split(/[\\\/]/).filter(p => p).pop() || parentMetadata.path;
					parentDisplayFilename = `.. (${parentFolderName})`;
				}
				entries.splice(insertIndex, 0, {
					...parentMetadata,
					displayFilename: parentDisplayFilename
				});
			}
		}

		const records = await buildGridRecords(entries, panelId, iconCache, categoryCache, tagDefs);
		if (state.scanCancelled || state.scanToken !== token) break;
		addRecordsToGrid(records, panelId);

		if (currentDepth < maxDepth) {
			const subdirs = rawEntries.filter(e => e.isDirectory && e.filename !== '.' && e.changeState !== 'orphan' && e.changeState !== 'moved');
			for (const subdir of subdirs) {
				state.pendingDirs.push({ path: subdir.path, maxDepth, currentDepth: currentDepth + 1 });
			}
		}
	}
}

async function resumeScan(panelId) {
	const state = panelState[panelId];
	if (state.scanInProgress || !state.pendingDirs || state.pendingDirs.length === 0) return;

	state.scanCancelled = false;
	state.scanInProgress = true;
	state.scanToken = (state.scanToken + 1) % 1000000;
	const token = state.scanToken;

	setScanIndicator(panelId, true);
	const [settings, tagDefs] = await Promise.all([
		window.electronAPI.getSettings(),
		window.electronAPI.loadTags()
	]);
	const hideDotDotDirectory = settings.hide_dot_dot_directory || false;
	const iconCache = new Map();
	const categoryCache = new Map();
	await processPendingDirs(panelId, state.currentPath, iconCache, categoryCache, token, tagDefs, hideDotDotDirectory);

	if (state.scanToken === token) {
		state.scanInProgress = false;
		setScanIndicator(panelId, false);
	}
}

async function scanDirectoryTreeStreaming(rootPath, maxDepth, panelId) {
	const state = panelState[panelId];
	state.scanCancelled = true;
	state.pendingDirs = [];
	state.scanToken = (state.scanToken + 1) % 1000000;
	const token = state.scanToken;
	state.scanCancelled = false;
	state.scanInProgress = true;
	state.recidCounter = 1;
	setScanIndicator(panelId, true);

	const [settings, tagDefs] = await Promise.all([
		window.electronAPI.getSettings(),
		window.electronAPI.loadTags()
	]);
	const hideDotDirectory = settings.hide_dot_directory || false;
	const hideDotDotDirectory = settings.hide_dot_dot_directory || false;
	const showFolderNameWithDotEntries = settings.show_folder_name_with_dot_entries || false;
	const iconCache = new Map();
	const categoryCache = new Map();
	const grid = state.w2uiGrid;
	if (grid) grid.clear();

	const rootScan = await window.electronAPI.scanDirectoryWithComparison(rootPath, true);
	if (!rootScan.success || state.scanToken !== token) {
		if (state.scanToken === token) {
			state.scanInProgress = false;
			setScanIndicator(panelId, false);
		}
		return;
	}
	if (rootScan.alertsCreated) {
		unacknowledgedAlertCount += rootScan.alertsCreated;
		updateAlertBadge();
	}

	const rootRaw = rootScan.entries || [];
	const currentFolderName = rootPath.split(/[\\\/]/).filter(p => p).pop() || rootPath;
	let rootEntries = rootRaw
		.filter(e => e.changeState !== 'orphan' && e.changeState !== 'moved')
		.filter(e => !hideDotDirectory || e.filename !== '.')
		.map(e => {
			let displayFilename = getRelativePathFromRoot(rootPath, e.path);
			if (showFolderNameWithDotEntries && e.filename === '.') {
				displayFilename = `. (${currentFolderName})`;
			}
			return { ...e, displayFilename };
		});

	if (!hideDotDotDirectory && state.scanToken === token) {
		const parentMetadata = await window.electronAPI.getParentDirectoryMetadata(rootPath);
		if (parentMetadata) {
			const dotIndex = rootEntries.findIndex(e => e.filename === '.');
			const insertIndex = dotIndex >= 0 ? dotIndex + 1 : 0;
			let parentDisplayFilename = '..';
			if (showFolderNameWithDotEntries && parentMetadata.path) {
				const parentFolderName = parentMetadata.path.split(/[\\\/]/).filter(p => p).pop() || parentMetadata.path;
				parentDisplayFilename = `.. (${parentFolderName})`;
			}
			rootEntries.splice(insertIndex, 0, {
				...parentMetadata,
				displayFilename: parentDisplayFilename
			});
		}
	}

	const rootRecords = await buildGridRecords(rootEntries, panelId, iconCache, categoryCache, tagDefs);
	if (state.scanToken === token) addRecordsToGrid(rootRecords, panelId);

	if (maxDepth > 0 && state.scanToken === token) {
		const subdirs = rootRaw.filter(e => e.isDirectory && e.filename !== '.' && e.changeState !== 'orphan' && e.changeState !== 'moved');
		for (const subdir of subdirs) {
			state.pendingDirs.push({ path: subdir.path, maxDepth, currentDepth: 1 });
		}
		await processPendingDirs(panelId, rootPath, iconCache, categoryCache, token, tagDefs, hideDotDotDirectory, showFolderNameWithDotEntries);
	}

	if (state.scanToken === token) {
		state.scanInProgress = false;
		setScanIndicator(panelId, false);
	}
}

/**
 * Refresh the toolbar badge counts (Orphans / Trash) for a panel without
 * triggering a full directory re-scan.  Called after in-place operations
 * like deletion so the counts stay accurate on the current view.
 */
async function refreshBadgeCounts(panelId) {
	const state = panelState[panelId];
	const basePath = state?.currentBasePath || state?.currentPath;
	if (!basePath) return;
	try {
		const depth = state.depth || 1;
		const result = await window.electronAPI.getBadgeCounts(basePath, depth);
		if (!result?.success) return;
		state.orphanCount = result.orphanCount ?? 0;
		state.trashCount  = result.trashCount  ?? 0;
		const mode = state.currentCategory?.displayMode === 'gallery' ? 'gallery' : 'detail';
		renderPanelToolbar(panelId, mode);
	} catch (err) {
		console.warn('[refreshBadgeCounts] failed:', err);
	}
}

/**
 * Switch a panel to item-properties view for a specific file path.
 * Assumes navigateToDirectory has already updated state.currentPath and history.
 */
async function showItemPropertiesForPath(filePath, panelId, fileStats) {
	const filename = filePath.includes('\\') ? filePath.substring(filePath.lastIndexOf('\\') + 1) : filePath;
	const parentDir = filePath.includes('\\') ? filePath.substring(0, filePath.lastIndexOf('\\')) : filePath;

	const parentCategory = await window.electronAPI.getCategoryForDirectory(parentDir);
	panelState[panelId].currentCategory = parentCategory;

	// Update selected item state so updateItemPropertiesPage knows what to show
	Object.assign(selectedItemState, {
		path: filePath,
		filename,
		isDirectory: false,
		panelId,
		inode: fileStats.inode || null,
		dir_id: fileStats.dir_id || null,
		record: null
	});

	const $panel = $(`#panel-${panelId}`);
	$panel.find('.panel-grid').hide();
	$panel.find('.panel-gallery').removeClass('active');
	$panel.find('.panel-file-view').hide();
	$panel.find('.panel-landing-page').show();

	hidePanelToolbar(panelId);
	await updateItemPropertiesPage(panelId);
}

export async function navigateToDirectory(dirPath, panelId = activePanelId, addToHistory = true) {
	try {
		if (!dirPath || typeof dirPath !== 'string') {
			throw new Error('Path must be a non-empty string');
		}
		const rawInput = dirPath.trim();
		if (!rawInput) {
			throw new Error('Path cannot be empty');
		}

		// Parse virtual-view URI params (e.g. "C:\Foo?orphans&trash")
		const { basePath: parsedBase, params: navParams } = parseNavUri(rawInput);
		const isVirtualView = navParams.size > 0;

		let normalizedPath = parsedBase;
		if (normalizedPath.length === 2 && normalizedPath[1] === ':') {
			normalizedPath += '\\';
		}

		const state = panelState[panelId];
		ensureFilterState(panelId);
		if (state.scanInProgress) {
			state.scanCancelled = true;
			state.pendingDirs = [];
		}

		// Store URI metadata — basePath + params. currentPath always reflects
		// the filesystem basePath so that Up/Back still work correctly.
		const previousPath = state.currentPath;
		state.currentPath = normalizedPath;
		state.currentBasePath = normalizedPath;
		state.currentNavParams = navParams;

		if (normalizedPath !== previousPath) {
			resetFilterState(panelId);
		}
		if (normalizedPath !== previousPath) {
			state.depth = 0;
			const depthInput = document.getElementById(`depth-input-${panelId}`);
			if (depthInput) depthInput.value = 0;
		}
		if (addToHistory) {
			state.navigationHistory = state.navigationHistory.slice(0, state.navigationIndex + 1);
			// Store the full URI (including params) in history so Back restores virtual view
			state.navigationHistory.push(rawInput);
			state.navigationIndex = state.navigationHistory.length - 1;
		}
		if (panelId === 1) sidebar.updateSidebarSelection(normalizedPath);

		if (isVirtualView) {
			// ---- Virtual view branch ----
			// We don't need isDirectory check — the dir must be in the DB
			// already (it's a known base path). If it isn't, getVirtualView
			// will return success:false and we'll show the error below.
			setPanelPathValidity(panelId, true);
			const depth = state.depth || 0;
			const viewResult = await window.electronAPI.getVirtualView(normalizedPath, [...navParams], depth || 1);
			if (!viewResult.success) {
				throw new Error(viewResult.error || 'Failed to load virtual view');
			}

			// Update badge counts
			state.orphanCount = viewResult.orphanCount ?? 0;
			state.trashCount  = viewResult.trashCount  ?? 0;

			const category = await window.electronAPI.getCategoryForDirectory(normalizedPath);
			const prevCategory = state.currentCategory;
			state.currentCategory = category;
			const prevAttrs = JSON.stringify((prevCategory && prevCategory.attributes) || []);
			const newAttrs = JSON.stringify((category && category.attributes) || []);
			if (prevAttrs !== newAttrs) {
				await initializeGridForPanel(panelId);
			}

			const entries = viewResult.entries || [];

			const $panel = $(`#panel-${panelId}`);
			$panel.find('.panel-landing-page').hide();
			$panel.find('.panel-gallery').removeClass('active');
			$panel.find('.panel-grid').show();
			renderPanelToolbar(panelId, 'detail');

			await populateFileGrid(entries, category, panelId);
			updatePanelHeader(panelId, normalizedPath);

			const gridToResize = panelState[panelId].w2uiGrid;
			if (gridToResize) {
				requestAnimationFrame(() => { gridToResize.resize(); });
			}

			panelState[panelId].hasBeenViewed = true;
			autoLabels.refreshAutoLabelCountAndSuggestions(panelId).then(() => renderPanelToolbar(panelId, 'detail')).catch(() => {});
			// Update LOCAL FAVORITES with any shortcuts in this directory
			sidebar.updateLocalFavoritesForPanel(panelId, normalizedPath);
			return;
		}

		// ---- Normal (filesystem) navigation branch ----

		const directoryExists = await window.electronAPI.isDirectory(normalizedPath);
		if (!directoryExists) {
			// Check if the path is a file — if so, show item properties (panels 2-4 only)
			const hasItemPropsView = $(`#panel-${panelId} .panel-landing-page`).length > 0;
			if (hasItemPropsView) {
				const fileStats = await window.electronAPI.getItemStats(normalizedPath);
				if (fileStats && fileStats.success && !fileStats.isDirectory) {
					await showItemPropertiesForPath(normalizedPath, panelId, fileStats);
					return;
				}
			}

			state.currentCategory = null;
			setPanelPathValidity(panelId, false);
			// Show grid (not gallery) for missing directory placeholder
			const $panelMissing = $(`#panel-${panelId}`);
			$panelMissing.find('.panel-landing-page').hide();
			$panelMissing.find('.panel-gallery').removeClass('active');
			$panelMissing.find('.panel-grid').show();
			showMissingDirectoryRecord(panelId);
			updatePanelHeader(panelId, normalizedPath);
			renderPanelToolbar(panelId, 'detail');
			return;
		}

		setPanelPathValidity(panelId, true);
		const scanResult = await window.electronAPI.scanDirectoryWithComparison(normalizedPath);
		if (!scanResult.success) {
			throw new Error(scanResult.error || 'Failed to scan directory');
		}
		if (scanResult.alertsCreated) {
			unacknowledgedAlertCount += scanResult.alertsCreated;
			updateAlertBadge();
		}

		// Update badge counts from scan result
		state.orphanCount = scanResult.orphanCount ?? 0;
		state.trashCount  = scanResult.trashCount  ?? 0;

		const category = await window.electronAPI.getCategoryForDirectory(normalizedPath);
		const prevCategory = state.currentCategory;
		state.currentCategory = category;
		const prevAttrs = JSON.stringify((prevCategory && prevCategory.attributes) || []);
		const newAttrs = JSON.stringify((category && category.attributes) || []);
		if (prevAttrs !== newAttrs) {
			await initializeGridForPanel(panelId);
		}

		if (panelId === 1 && category) {
			const dotEntry = (scanResult.entries || []).find(e => e.filename === '.' && e.isDirectory);
			const currentDirInitials = dotEntry ? (dotEntry.resolvedInitials || dotEntry.initials || null) : null;
			await window.electronAPI.updateWindowIcon(category.name, currentDirInitials);

			// Build window title from resolved display name (if any)
			const settings = await window.electronAPI.getSettings();
			const windowTitle = buildWindowTitle(normalizedPath, dotEntry || null, settings);
			await window.electronAPI.setWindowTitle(windowTitle);
		}

		// Orphan and moved entries are surfaced in the ?orphans virtual view.
		// The normal grid only shows real (unchanged / changed / new) filesystem entries.
		const entries = (scanResult.success ? scanResult.entries : [])
			.filter(e => e.changeState !== 'orphan' && e.changeState !== 'moved');
		const depth = panelState[panelId].depth || 0;
		const isGallery = category && category.displayMode === 'gallery';

		// Show the appropriate view container
		const $panel = $(`#panel-${panelId}`);
		$panel.find('.panel-landing-page').hide();
		if (isGallery) {
			$panel.find('.panel-grid').hide();
			$panel.find('.panel-gallery').addClass('active');
		} else {
			$panel.find('.panel-gallery').removeClass('active');
			$panel.find('.panel-grid').show();
		}
		renderPanelToolbar(panelId, isGallery ? 'gallery' : 'detail');

		if (isGallery) {
			await populateGalleryView(entries, category, panelId);
		} else if (depth > 0) {
			await scanDirectoryTreeStreaming(normalizedPath, depth, panelId);
		} else {
			await populateFileGrid(entries, category, panelId);
		}

		// Apply per-directory saved grid layout (columns, sort) for grid views.
		// Session layout (in-memory, from this run) takes priority over the DB layout.
		if (!isGallery && depth === 0) {
			const sessionLayout = (panelState[panelId].sessionDirLayouts || {})[normalizedPath];
			if (sessionLayout) {
				applySessionDirLayout(panelId, sessionLayout);
			} else {
				await applyDirGridLayoutIfExists(panelId, normalizedPath);
			}
		}

		if (panelState[panelId].toolbarSearch) {
			applyPanelToolbarSearch(panelId, panelState[panelId].toolbarSearch);
		}

		updatePanelHeader(panelId, normalizedPath);
		const gridToResize = panelState[panelId].w2uiGrid;
		if (gridToResize) {
			requestAnimationFrame(() => {
				gridToResize.resize();
			});
		}

		panelState[panelId].hasBeenViewed = true;
		window.electronAPI.registerWatchedPath(panelId, normalizedPath);
		autoLabels.refreshAutoLabelCountAndSuggestions(panelId).then(() => {
			const mode = panelState[panelId]?.currentCategory?.displayMode === 'gallery' ? 'gallery' : 'detail';
			renderPanelToolbar(panelId, mode);
		}).catch(() => {});
		// Update LOCAL FAVORITES with any shortcuts in this directory
		sidebar.updateLocalFavoritesForPanel(panelId, normalizedPath);

		if (category && category.enableChecksum) {
			const grid = panelState[panelId].w2uiGrid;
			if (grid) {
				const filesToChecksum = grid.records.filter(r => !r.isFolder && r.changeState === 'checksumPending');
				if (filesToChecksum.length > 0) {
					const queueIdle = !state.checksumQueue || state.checksumCancelled || state.checksumQueueIndex >= state.checksumQueue.length;
					if (queueIdle) {
						startChecksumQueue(filesToChecksum, panelId, dirPath);
					}
				}
			}
		}
	} catch (err) {
		console.error('Error navigating to directory:', err);
		alert('Error accessing directory: ' + err.message);
	}
}

function setPanelPathValidity(panelId, isValid) {
	const headerEl = getPanelHeaderElement(panelId);
	const $path = headerEl ? $(headerEl).find('.panel-path') : $(`#panel-${panelId} .panel-path`);
	if (isValid) {
		$path.css('color', '');
	} else {
		$path.css('color', '#c62828');
	}
}

function showMissingDirectoryRecord(panelId) {
	const grid = panelState[panelId].w2uiGrid;
	if (!grid) return;
	panelState[panelId].sourceRecords = [];
	grid.records = [{
		recid: 1,
		icon: '-',
		filename: MISSING_DIRECTORY_LABEL,
		size: '-',
		dateModified: '-',
		modified: null,
		checksum: '-',
		isFolder: false,
		path: '',
		changeState: 'missing'
	}];
	grid.refresh();
}

export async function initializeAllGrids() {
	for (let panelId = 1; panelId <= 4; panelId++) {
		await initializeGridForPanel(panelId);
	}
}

async function initializeGridForPanel(panelId) {
	const gridName = `grid-panel-${panelId}`;
	hidePanelFilterMenu(panelId);

	if (w2ui && w2ui[gridName]) {
		w2ui[gridName].destroy();
	}

	const recordHeight = await getRecordHeight();
	const state = panelState[panelId];
	const columns = [
		{ field: 'icon', headerLabel: '', text: getColumnHeaderText(panelId, 'icon', ''), size: '30px', resizable: false, sortable: false, hideable: false },
		{ field: 'filename', headerLabel: 'Name', text: getColumnHeaderText(panelId, 'filename', 'Name'), size: '50%', resizable: true, sortable: true, hideable: false },
		{ field: 'type', headerLabel: 'Type', text: getColumnHeaderText(panelId, 'type', 'Type'), size: '80px', resizable: true, sortable: true },
		{ field: 'size', headerLabel: 'Size', text: getColumnHeaderText(panelId, 'size', 'Size'), size: '60px', resizable: true, sortable: true, align: 'right' },
		{ field: 'dateModified', headerLabel: 'Date Modified', text: getColumnHeaderText(panelId, 'dateModified', 'Date Modified'), size: '150px', resizable: true, sortable: true, hidden: true },
		{
			field: 'modified', headerLabel: 'Modified', text: getColumnHeaderText(panelId, 'modified', 'Modified'), size: '70px', resizable: true, sortable: true, render: (record) => {
				if (!record.modified) return '-';
				const ts = -record.modified;
				const fullDate = new Date(ts).toLocaleString();
				const ago = formatTimeAgo(ts);
				return `<span title="${fullDate}" style="cursor: help;">${ago}</span>`;
			}
		},
		{ field: 'dateCreated', headerLabel: 'Date Created', text: getColumnHeaderText(panelId, 'dateCreated', 'Date Created'), size: '150px', resizable: true, sortable: true, hidden: !state.showDateCreated },
		{ field: 'perms', headerLabel: 'Perms', text: getColumnHeaderText(panelId, 'perms', 'Perms'), size: '48px', resizable: true, sortable: true },
		{ field: 'checksum', headerLabel: 'Checksum', text: getColumnHeaderText(panelId, 'checksum', 'Checksum'), size: '70px', resizable: true, sortable: false },
		{
			field: 'tags', headerLabel: 'Tags', text: getColumnHeaderText(panelId, 'tags', 'Tags'), size: '190px', resizable: true, sortable: false, render: (record) => {
				// return `<div class="grid-tags-cell">${record.tags || '<span class="grid-tags-empty"></span>'}<button class="grid-tags-add-btn" title="Configure tags" data-tag-config-trigger="true"><svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M12.146.854a.5.5 0 0 1 .708 0l2.292 2.292a.5.5 0 0 1 0 .708L5.854 13.146a.5.5 0 0 1-.22.128l-3.5 1.167a.5.5 0 0 1-.632-.632l1.167-3.5a.5.5 0 0 1 .128-.22L12.146.854zM11.5 2.707 13.293 4.5 14.293 3.5 12.5 1.707 11.5 2.707zM12.586 5.207 10.793 3.414 4 10.207V10.5h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.793-6.793z"/></svg></button></div>`;
				return `<div class="grid-tags-cell">${record.tags || '<span class="grid-tags-empty"></span>'}<button class="grid-tags-add-btn" title="Configure tags" data-tag-config-trigger="true"><img src="assets/icons/edit.svg" width="16" height="16"></button></div>`;
			}
		},
		{
			field: 'notes', headerLabel: 'Notes', text: getColumnHeaderText(panelId, 'notes', 'Notes'), size: '32px', resizable: false, sortable: false, render: (record) => {
				return record.hasNotes
					? `<span class="notes-cell-icon notes-cell-icon-view" title="Open Notes" data-notes-icon="true"><img src="assets/icons/note-book-icon.svg"></span>`
					: '<span class="notes-cell-icon notes-cell-icon-add" title="Add Notes" data-notes-icon="true"><img src="assets/icons/add-notes.png"></span>';
			}
		},
		{
			field: 'todo', headerLabel: 'TODO', text: getColumnHeaderText(panelId, 'todo', 'TODO'), size: '60px', resizable: true, sortable: false, render: (record) => {
				if (!record.todo || record.todo.total === 0) return '';
				const { completed, total } = record.todo;
				const cls = completed === total ? 'todo-count todo-count-complete' : 'todo-count todo-count-partial';
				return `<span class="${cls}" style="cursor:pointer;" data-todo-cell="true">${completed}/${total}</span>`;
			}
		}
	];

	const attrCols = state.currentAttrColumns || (state.currentCategory && state.currentCategory.attributes) || [];
	for (const attrName of attrCols) {
		columns.push({
			field: `attr_${attrName}`,
			headerLabel: attrName,
			text: getColumnHeaderText(panelId, `attr_${attrName}`, attrName),
			size: '100px',
			resizable: true,
			sortable: true,
			render: (record) => renderGridAttributeCell(record, attrName, state.currentAttrDefinitions?.[attrName])
		});
	}

	w2ui[gridName] = new w2grid({
		name: gridName,
		reorderColumns: false,
		recordHeight: recordHeight,
		show: {
			header: false,
			toolbar: false,
			footer: true,
			skipRecords: false,
			saveRestoreState: false
		},
	    multiSelect: true,
	    multiSearch: false,
	    advanceOnEdit: false,
		searches:[
			{ field: 'filename', caption: 'Filename', type: 'text' },
		],
		columns,
		records: [],
		contextMenu: [],
		onClick: function (event) {
			gridFocusedPanelId = panelId;
			const originalTarget = event.detail.originalEvent?.target;

			if (originalTarget && originalTarget.closest && originalTarget.closest('[data-copy-value]')) {
				event.preventDefault();
				event.stopPropagation();
				const copyButton = originalTarget.closest('[data-copy-value]');
				const encodedValue = copyButton.getAttribute('data-copy-value');
				const copyValue = decodeCopyValue(encodedValue);
				copyValueToClipboard(copyValue, copyButton);
				return;
			}

			if (originalTarget && originalTarget.closest && originalTarget.closest('[data-tag-config-trigger="true"]')) {
				event.preventDefault();
				event.stopPropagation();
				if (event.detail.recid) {
					const record = this.records.find(r => r.recid === event.detail.recid);
					if (record) {
						updateSelectedItemFromRecord(record, panelId);
						openTagConfigModal(record, panelId);
						return;
					}
				}
			}

			if (originalTarget && originalTarget.closest && originalTarget.closest('[data-attr-edit-trigger="true"]')) {
				event.preventDefault();
				event.stopPropagation();
				if (event.detail.recid) {
					const record = this.records.find(r => r.recid === event.detail.recid);
					if (record) {
						const btn = originalTarget.closest('[data-attr-edit-trigger="true"]');
						const attrName = btn.getAttribute('data-attr-name');
						const attrDefinition = panelState[panelId].currentAttrDefinitions?.[attrName];
						// Don't allow editing if this attribute doesn't apply to this record type
						const appliesTo = (attrDefinition?.appliesTo || 'both').toLowerCase();
						if ((appliesTo === 'directory' && !record.isFolder) ||
							(appliesTo === 'files' && record.isFolder)) return;
						const grid = panelState[panelId].w2uiGrid;
						const colIndex = grid ? grid.columns.findIndex(c => c.field === `attr_${attrName}`) : -1;
						if (!grid || colIndex === -1) return;
						// Normalize yes-no to string so the list picker highlights the current value
						const attrType = (attrDefinition?.type || 'string').toLowerCase();
						if (attrType === 'yes-no') {
							const raw = record[`attr_${attrName}`];
							if (raw !== null && raw !== undefined && raw !== '') {
								record[`attr_${attrName}`] = (raw === true || raw === 'true' || raw === 'Yes') ? 'Yes' : 'No';
							}
						}
						grid.columns[colIndex].editable = getAttrEditableConfig(attrDefinition);
						grid.editField(record.recid, colIndex);
						return;
					}
				}
			}
			
			// Handle notes icon click to open modal
			if (event.detail.originalEvent && event.detail.originalEvent.target &&
				event.detail.originalEvent.target.dataset &&
				event.detail.originalEvent.target.dataset.notesIcon) {
				event.preventDefault();
				event.stopPropagation();
				if (event.detail.recid) {
					const record = this.records.find(r => r.recid === event.detail.recid);
					if (record) {
						openNotesModal(record);
						return;
					}
				}
			}
			
			if (panelId === 1 && event.detail.recid) {
				const record = this.records.find(r => r.recid === event.detail.recid);
				if (record) {
					if (record.isFolder) {
						handlePanel1DirectorySelection(record.path, record.filenameRaw || record.filename);
					} else {
						panel1SelectedDirectoryPath = null;
						panel1SelectedDirectoryName = null;
						updatePanelSelectButtons();
					}
				}
			}

			if (event.detail.recid) {
				const record = this.records.find(r => r.recid === event.detail.recid);
				if (record && getPanelViewType(panelId) !== 'properties') {
					updateSelectedItemFromRecord(record, panelId);
				}
			}

			if (event.detail.column === 0 && event.detail.recid) {
				const record = this.records.find(r => r.recid === event.detail.recid);
				if (record && record.isFolder && record.changeState !== 'moved') {
					openInitialsEditor(record, panelId);
					event.preventDefault();
					return;
				}
			}

			if (event.detail.recid) {
				const col = this.columns[event.detail.column];
				if (col && col.field === 'todo') {
					const record = this.records.find(r => r.recid === event.detail.recid);
					if (record && record.todo && record.todo.total > 0) {
						openTodoModal(record, panelId);
						event.preventDefault();
						return;
					}
				}
			}

			if (panelId > 1 && panelState[panelId].selectMode && event.detail.recid) {
				const record = this.records.find(r => r.recid === event.detail.recid);
				if (record && record.isFolder) {
					setActivePanelId(panelId);
					navigateToDirectory(record.path, panelId);
				}
			}
		},
		onDblClick: function (event) {
			const record = this.records.find(r => r.recid === event.detail.recid);
			if (record && record.isFolder) {
				// When double-clicking an orphaned folder from within a virtual
				// view, carry the orphan param into the child navigation so the
				// user can browse the subtree while staying in orphan-view mode.
				const state = panelState[panelId];
				const isOrphan = record.changeState === 'orphan' || record.changeState === 'moved';
				if (isOrphan && state?.currentNavParams?.size > 0) {
					const inheritedParams = new Set([...state.currentNavParams].filter(p => p === 'orphans'));
					navigateToDirectory(buildNavUri(record.path, inheritedParams), panelId);
				} else {
					navigateToDirectory(record.path, panelId);
				}
				return;
			}

			if (record && !record.isFolder) {
				// .aly files open the layout confirm modal
				if (record.path && record.path.toLowerCase().endsWith('.aly')) {
					openAlyLayoutModal(record.path);
					return;
				}

				let hasPropertiesPanel = false;
				for (let i = 2; i <= visiblePanels; i++) {
					if (getPanelViewType(i) === 'properties') {
						hasPropertiesPanel = true;
						break;
					}
				}
				if (!hasPropertiesPanel && visiblePanels < 4) {
					visiblePanels++;
					const newPanelId = visiblePanels;
					$(`#panel-${newPanelId}`).show();
					attachPanelEventListeners(newPanelId);
					updatePanelLayout();
					setTimeout(() => updateItemPropertiesPage(newPanelId), 150);
				}
			}
		},
		onContextMenu: async function (event) {
			if (event.detail.recid) {
				event.preventDefault();
				setActivePanelId(panelId);
				const selectedRecIds = this.getSelection();
				const selectedRecords = selectedRecIds.map(recid => this.records.find(r => r.recid === recid));
				if (selectedRecords.length === 0) return;
				const menuItems = await generateW2UIContextMenu(selectedRecords, visiblePanels);
				const origEvent = event.detail.originalEvent;
				showCustomContextMenu(menuItems, origEvent.clientX, origEvent.clientY, panelId);
			}
		},
		onColumnContextMenu: function (event) {
			event.preventDefault();
			const origEvent = event.detail.originalEvent;
			if (origEvent) origEvent.preventDefault();
			const field = event.detail.field;
			// Icon column: end reorder mode, no menu
			if (field === 'icon') {
				setColumnReorderMode(panelId, false);
				return;
			}
			showColumnContextMenuForPanel(panelId, field, origEvent);
		},
		onColumnDragEnd: function (event) {
			const grid = this;
			const previousOnComplete = event.onComplete;
			event.onComplete = () => {
				if (typeof previousOnComplete === 'function') previousOnComplete.call(grid, event);
				snapshotSessionDirLayout(panelId);
			};
		},
		onColumnOnOff: function (event) {
			if (event.detail.field === 'dateCreated') {
				const col = this.getColumn('dateCreated');
				panelState[panelId].showDateCreated = !!col.hidden;
			}
		},
		onReload: function (event) {
			event.preventDefault();
			setActivePanelId(panelId);
			const stateForReload = panelState[panelId];
			if (!stateForReload.scanInProgress && stateForReload.pendingDirs && stateForReload.pendingDirs.length > 0) {
				resumeScan(panelId);
			} else {
				navigateToDirectory(stateForReload.currentPath, panelId);
			}
		},
		onRefresh: function (event) {
			const previousOnComplete = event.onComplete;
			event.onComplete = () => {
				if (typeof previousOnComplete === 'function') {
					previousOnComplete.call(this, event);
				}
				refreshFilterHeaderButtons(panelId);
			};
		},
		onSort: function (event) {
			const grid = this;
			const previousOnComplete = event.onComplete;
			event.onComplete = () => {
				if (typeof previousOnComplete === 'function') {
					previousOnComplete.call(grid, event);
				}
				repositionMetaDirs(grid, panelId);
				snapshotSessionDirLayout(panelId);
			};
		},
		onColumnResize: function (event) {
			const grid = this;
			const previousOnComplete = event.onComplete;
			event.onComplete = () => {
				if (typeof previousOnComplete === 'function') {
					previousOnComplete.call(grid, event);
				}
				snapshotSessionDirLayout(panelId);
			};
		},
		onChange: function (event) {
			// event.detail has `column` (index), not `field` — derive field from column index
			const colIndex = event.detail?.column;
			if (colIndex == null) return;
			const field = this.columns[colIndex]?.field;
			if (!field || !field.startsWith('attr_')) return;
			const grid = this;
			event.onComplete = async () => {
				const record = grid.records.find(r => r.recid === event.detail.recid);
				if (!record) return;
				// event.detail.value is { new, previous, original } — extract .new
				// For list type, .new is {id, text}; normalize to just the id string
				let newValue = event.detail.value?.new ?? event.detail.value;
				if (newValue !== null && typeof newValue === 'object' && 'id' in newValue) {
					newValue = newValue.id;
				}
				// Trim whitespace; convert empty string to null so DB removes the key
				if (typeof newValue === 'string') {
					newValue = newValue.trim();
					if (newValue === '') newValue = null;
				}
				// Write normalized value directly to the record
				record[field] = newValue;
				// Clear w2ui change tracking so editDone removes w2ui-changed class
				// and re-renders the cell via our custom render function
				if (record.w2ui?.changes) {
					delete record.w2ui.changes[field];
					if (Object.keys(record.w2ui.changes).length === 0) delete record.w2ui.changes;
				}
				// Remove editable to prevent unintended double-click editing
				if (colIndex !== -1) delete grid.columns[colIndex].editable;
				// Persist
				const attrName = field.substring(5);
				const inode = record.inode;
				const dirId = record.dir_id;
				if (!inode || !dirId) return;
				try {
					await window.electronAPI.setFileAttributes(inode, dirId, { [attrName]: newValue });
				} catch (err) {
					w2alert('Error saving attribute: ' + err.message);
				}
			};
		},
		onDelete: async function(edata) {
			const grid = this;
			const selected = grid.getSelection();
			const allRecords = selected.map(recid => grid.records.find(r => r.recid === recid)).filter(Boolean);

			// Strip meta-directory entries (./ and ../) — they must never be deleted
			const records = allRecords.filter(r => r.filenameRaw !== '.' && r.filenameRaw !== '..');

			if (!edata.detail.force) {
				// Pre-confirm phase: if only meta-dirs were selected, suppress the dialog entirely
				if (records.length === 0) {
					edata.preventDefault();
					return;
				}
				// Narrow the selection before the confirm dialog appears
				if (records.length !== allRecords.length) {
					grid.selectNone();
					grid.select(...records.map(r => r.recid));
				}
				return; // let w2ui show the confirm dialog for the filtered selection
			}

			edata.preventDefault(); // cancel default grid removal; we handle it manually
			if (records.length === 0) return;

			const items = records
				.filter(r => r.path)
				.map(r => ({ path: r.path, inode: r.inode, dir_id: r.dir_id, isFolder: !!r.isFolder }));
			if (items.length === 0) return;
			try {
				const { succeeded, failed } = await window.electronAPI.deleteItems(items);
				const succeededSet = new Set(succeeded);
				const recidsToRemove = records.filter(r => succeededSet.has(r.path)).map(r => r.recid);
				if (recidsToRemove.length > 0) grid.remove(...recidsToRemove);
				// Refresh toolbar badge counts so Orphans/Trash reflect the deletion immediately
				if (recidsToRemove.length > 0) refreshBadgeCounts(panelId).catch(() => {});
				if (failed.length > 0) {
					w2alert('Failed to delete:\n' + failed.map(f => `${f.path}: ${f.error}`).join('\n'));
				}
			} catch (err) {
				w2alert('Error deleting items: ' + (err.message || 'Unknown error'));
			}
		}
	});
	panelState[panelId].w2uiGrid = w2ui[gridName];

	const $gridContainer = $(`#panel-${panelId} .panel-grid`);
	w2ui[gridName].render($gridContainer[0]);

	// Wire drag-and-drop (move default, Ctrl = copy) for this panel.
	try {
		attachDragDropForPanel(panelId, { panelState, navigateToDirectory });
	} catch (err) {
		console.warn('attachDragDropForPanel failed for panel', panelId, err);
	}

	$(document).off(`click.stop-scan-${panelId}`, `#btn-stop-scan-${panelId}`)
		.on(`click.stop-scan-${panelId}`, `#btn-stop-scan-${panelId}`, function () {
			stopScan(panelId);
		});

	$(document).off('change.depth', `#depth-input-${panelId}`)
		.on('change.depth', `#depth-input-${panelId}`, function () {
			let val = parseInt($(this).val(), 10);
			if (isNaN(val) || val < 0) val = 0;
			if (val > 99) val = 99;
			$(this).val(val);
			panelState[panelId].depth = val;
			if (panelState[panelId].currentPath) {
				navigateToDirectory(panelState[panelId].currentPath, panelId, false);
			}
		});

	$(document).off(`click.toolbar-terminal-${panelId}`, `#btn-toolbar-terminal-${panelId}`)
		.on(`click.toolbar-terminal-${panelId}`, `#btn-toolbar-terminal-${panelId}`, function () {
			const cwd = panelState[panelId]?.currentPath;
			terminal.openTerminalModal(cwd);
		});

	bindGridFilterControls(panelId);
	refreshFilterHeaderButtons(panelId);

	updatePanelHeader(panelId, panelState[panelId].currentPath || 'Loading...');

	// Apply column overrides from layout restore if present
	applyColumnOverrides(panelId);
}

/**
 * After a localSort(), move isMetaDir records to the top (asc) or bottom (desc)
 * of grid.records when pin_meta_dirs is enabled. Callers must call grid.refresh()
 * themselves if needed (onSort onComplete does not require an extra refresh).
 */
function repositionMetaDirs(grid, panelId) {
	if (!panelState[panelId]?.pinMetaDirs) return;
	if (!grid.sortData || grid.sortData.length === 0) return;
	const metaRecs = grid.records.filter(r => r.isMetaDir);
	if (metaRecs.length === 0) return;
	const otherRecs = grid.records.filter(r => !r.isMetaDir);
	const direction = grid.sortData[0].direction;
	grid.records = direction === 'asc' ? [...metaRecs, ...otherRecs] : [...otherRecs, ...metaRecs];
}

/**
 * Snapshot the current grid sort + column state into the session-level per-directory
 * layout cache so it can be restored when the user navigates back to this directory.
 */
function snapshotSessionDirLayout(panelId) {
	const state = panelState[panelId];
	if (!state || !state.currentPath || !state.w2uiGrid) return;
	const grid = state.w2uiGrid;
	if (!state.sessionDirLayouts) state.sessionDirLayouts = {};
	state.sessionDirLayouts[state.currentPath] = {
		sortData: grid.sortData ? grid.sortData.map(s => ({ ...s })) : [],
		columns: grid.columns.map(c => ({ field: c.field, size: c.size, hidden: !!c.hidden }))
	};
}

/**
 * Enable or disable column reorder drag mode for a panel.
 * When active, w2ui renders column headers with a draggable handle and a blue outline (CSS).
 */
function setColumnReorderMode(panelId, active) {
	const state = panelState[panelId];
	const grid = state?.w2uiGrid;
	if (!grid) return;
	state.columnReorderMode = active;
	grid.reorderColumns = active;
	grid.refresh();
}

/**
 * Apply the "Default" column layout for a panel:
 * If a per-directory layout was previously saved with "Remember grid layout", apply it.
 * Otherwise, reset all columns to factory visibility and order.
 */
async function applyDefaultColumnLayout(panelId) {
	const state = panelState[panelId];
	const grid = state?.w2uiGrid;
	if (!grid || !state.currentPath) return;

	const result = await window.electronAPI.getDirGridLayout(state.currentPath);
	if (result?.success && result.layout?.columns?.length > 0) {
		// A saved layout exists — apply it
		const currentFields = new Set(grid.columns.map(c => c.field));
		const validColumns = result.layout.columns.filter(c => currentFields.has(c.field));
		if (validColumns.length > 0) {
			panelState[panelId].columnOverrides = validColumns;
			applyColumnOverrides(panelId);
		}
		if (result.layout.sortData?.length > 0) {
			grid.sortData = result.layout.sortData;
			grid.localSort();
			repositionMetaDirs(grid, panelId);
			grid.refresh();
		}
	} else {
		// No saved layout — reset to factory defaults
		const FACTORY_ORDER = ['icon', 'filename', 'type', 'size', 'dateModified', 'modified',
			'dateCreated', 'perms', 'checksum', 'tags', 'notes', 'todo'];
		// Reorder columns: factory columns first (in order), then any attr_ columns
		const attrCols = grid.columns.filter(c => c.field.startsWith('attr_'));
		const standardCols = FACTORY_ORDER
			.map(f => grid.columns.find(c => c.field === f))
			.filter(Boolean);
		grid.columns = [...standardCols, ...attrCols];
		// Reset hidden state to factory defaults
		grid.columns.forEach(col => {
			if (col.field === 'dateModified') col.hidden = true;
			else if (col.field === 'dateCreated') col.hidden = !state.showDateCreated;
			else col.hidden = false;
		});
		grid.refresh();
	}
	snapshotSessionDirLayout(panelId);
}

/**
 * Show the custom column header context menu for the given column field.
 */
function showColumnContextMenuForPanel(panelId, field, mouseEvent) {
	const state = panelState[panelId];
	const grid = state?.w2uiGrid;
	if (!grid || !mouseEvent) return;

	const col = grid.columns.find(c => c.field === field);
	if (!col) return;
	const col_ind = grid.columns.indexOf(col);

	const items = [];

	// Filter
	if (isColumnFilterable(panelId, field)) {
		items.push({
			text: 'Filter',
			onClick: () => {
				const headerEl = grid.box?.querySelector(`td.w2ui-head[col="${col_ind}"]`);
				const filterBtn = headerEl?.querySelector('.grid-header-filter-btn');
				const anchorEl = filterBtn || headerEl;
				if (anchorEl) {
					openColumnFilterMenu(panelId, field, anchorEl);
				}
			}
		});
		items.push({ text: '--' });
	}

	// Sort
	if (col.sortable !== false) {
		items.push({
			text: 'Sort Ascending',
			onClick: () => {
				grid.sortData = [{ field, direction: 'asc' }];
				grid.localSort();
				repositionMetaDirs(grid, panelId);
				grid.refresh();
				snapshotSessionDirLayout(panelId);
			}
		});
		items.push({
			text: 'Sort Descending',
			onClick: () => {
				grid.sortData = [{ field, direction: 'desc' }];
				grid.localSort();
				repositionMetaDirs(grid, panelId);
				grid.refresh();
				snapshotSessionDirLayout(panelId);
			}
		});
		items.push({ text: '--' });
	}

	// Hide (not for the filename column)
	if (field !== 'filename') {
		items.push({
			text: 'Hide',
			onClick: () => {
				col.hidden = true;
				if (field === 'dateCreated') state.showDateCreated = false;
				grid.refresh();
				snapshotSessionDirLayout(panelId);
			}
		});
	}

	// Show submenu
	const hiddenCols = grid.columns.filter(c => c.hidden && c.field !== 'icon');
	const showSubItems = [
		{
			text: 'Default',
			onClick: () => applyDefaultColumnLayout(panelId)
		}
	];
	for (const hiddenCol of hiddenCols) {
		const label = hiddenCol.headerLabel || hiddenCol.field;
		showSubItems.push({
			text: label,
			onClick: () => {
				hiddenCol.hidden = false;
				if (hiddenCol.field === 'dateCreated') state.showDateCreated = true;
				grid.refresh();
				snapshotSessionDirLayout(panelId);
			}
		});
	}
	items.push({ text: 'Show', items: showSubItems });

	items.push({ text: '--' });

	// Reorder Columns toggle
	const reorderActive = !!state.columnReorderMode;
	items.push({
		text: 'Reorder Columns',
		iconHtml: reorderActive ? '<span style="font-size:12px;line-height:1;">✓</span>' : '',
		onClick: () => setColumnReorderMode(panelId, !reorderActive)
	});

	showCustomContextMenu(items, mouseEvent.clientX, mouseEvent.clientY, panelId);
}

async function populateFileGrid(entries, currentDirCategory, panelId = activePanelId) {
	const state = panelState[panelId];
	const [settings, tagDefs, attributeDefs] = await Promise.all([
		window.electronAPI.getSettings(),
		window.electronAPI.loadTags(),
		window.electronAPI.getAttributesList()
	]);
	state.currentAttrDefinitions = Object.fromEntries((attributeDefs || []).map(attr => [attr.name, attr]));
	const globalAttrNames = (attributeDefs || []).filter(attr => attr.global).map(attr => attr.name);
	const hideDotDirectory = settings.hide_dot_directory || false;
	const hideDotDotDirectory = settings.hide_dot_dot_directory || false;
	const showFolderNameWithDotEntries = settings.show_folder_name_with_dot_entries || false;
	const pinMetaDirs = settings.pin_meta_dirs || false;
	state.pinMetaDirs = pinMetaDirs;
	const currentFolderName = state.currentPath.split(/[\\\/]/).filter(p => p).pop() || state.currentPath;

	let filteredEntries = entries;
	if (hideDotDirectory) {
		filteredEntries = entries.filter(e => e.filename !== '.');
	} else if (showFolderNameWithDotEntries) {
		filteredEntries = filteredEntries.map(e => {
			if (e.filename === '.') {
				return { ...e, displayFilename: `. (${currentFolderName})` };
			}
			return e;
		});
	}

	if (!hideDotDotDirectory && state.currentPath) {
		const parentMetadata = await window.electronAPI.getParentDirectoryMetadata(state.currentPath);
		if (parentMetadata) {
			const dotIndex = filteredEntries.findIndex(e => e.filename === '.');
			const insertIndex = dotIndex >= 0 ? dotIndex + 1 : 0;
			let parentDisplayFilename = '..';
			if (showFolderNameWithDotEntries && parentMetadata.path) {
				const parentFolderName = parentMetadata.path.split(/[\\\/]/).filter(p => p).pop() || parentMetadata.path;
				parentDisplayFilename = `.. (${parentFolderName})`;
			}
			filteredEntries.splice(insertIndex, 0, {
				...parentMetadata,
				displayFilename: parentDisplayFilename
			});
		}
	}

	const folders = filteredEntries.filter(e => e.isDirectory);
	const files = filteredEntries.filter(e => !e.isDirectory);
	const records = [];
	let recordId = 1;

	function applyClass(content, className) {
		if (!className) return content;
		return `<div class="${className}">${content}</div>`;
	}

	const attrColSet = new Set();
	// Always include global attributes
	for (const name of globalAttrNames) attrColSet.add(name);
	if (state.currentCategory && state.currentCategory.attributes) {
		for (const attr of state.currentCategory.attributes) attrColSet.add(attr);
	}

	for (const folder of folders) {
		let iconUrl;
		let category = null;
		if (folder.changeState === 'moved') {
			iconUrl = 'assets/folder-moved.svg';
		} else {
			category = await window.electronAPI.getCategoryForDirectory(folder.path);
			const iconInitials = folder.resolvedInitials || folder.initials || null;
			iconUrl = await window.electronAPI.generateFolderIcon(category.bgColor, category.textColor, iconInitials);
			if (category && category.attributes) {
				for (const attr of category.attributes) attrColSet.add(attr);
			}
			// (global attrs already added above)
		}

		// Build display filename: show direct (non-inherited) display name prefix
		let gridFilename = folder.displayFilename || folder.filename;
		if (folder.displayName && !folder.displayNameIsInherited) {
			if (folder.filename === '.') {
				gridFilename = `. [${folder.displayName}] (${folder.filename})`;
			} else if (folder.filename === '..') {
				gridFilename = `.. [${folder.displayName}] (${folder.filename})`;
			} else {
				gridFilename = `[${folder.displayName}] ${folder.filename}`;
			}
		}

		const className = getRowClassName(folder.changeState);
		const permsText = formatPerms(folder.perms);
		records.push({
			recid: recordId++,
			icon: applyClass(`<img src="${iconUrl}" style="width: 20px; height: 20px; object-fit: contain; cursor: pointer;" title="Click to set initials">`, className),
			filename: applyClass(gridFilename, className),
			filenameRaw: folder.filename,
			filenameText: gridFilename,
			type: applyClass(folder.changeState === 'moved' ? '' : (category ? category.name || '' : ''), className),
			typeRaw: folder.changeState === 'moved' ? '' : (category ? category.name || '' : ''),
			size: applyClass('-', className),
			sizeBytes: null,
			dateModified: applyClass(new Date(folder.dateModified).toLocaleString(), className),
			modified: -new Date(folder.dateModified).getTime(),
			modifiedTimestamp: new Date(folder.dateModified).getTime(),
			dateModifiedRaw: folder.dateModified,
			dateCreated: '-',
			dateCreatedRaw: null,
			dateCreatedTimestamp: null,
			perms: applyClass(getPermsCell(folder), className),
			permsText,
			checksum: applyClass('—', className),
			checksumValue: null,
			tags: renderTagBadges(folder.tags || null, tagDefs),
			tagsRaw: folder.tags || null,
			tagsText: getTagFilterText(folder.tags || null),
			isFolder: true,
			isMetaDir: folder.filename === '.' || folder.filename === '..',
			path: folder.path,
			changeState: folder.changeState,
			inode: folder.inode,
			initials: folder.initials || null,
			dir_id: folder.dir_id || null,
			orphan_id: folder.orphan_id || null,
			orphan_type: folder.orphan_id ? 'dir' : null,
			new_dir_id: folder.new_dir_id || null,
			hasNotes: folder.hasNotes || false,
			todo: folder.todoCounts || null
		});

		if (folder.attributes) {
			let attrObj = {};
			try { attrObj = typeof folder.attributes === 'string' ? JSON.parse(folder.attributes) : folder.attributes; } catch (_) { }
			const lastRecord = records[records.length - 1];
			for (const [key, value] of Object.entries(attrObj)) {
				lastRecord[`attr_${key}`] = value !== null && value !== undefined ? String(value) : '';
			}
		}
	}

	for (const file of files) {
		const className = getRowClassName(file.changeState);
		if (file.changeState === 'permError') {
			const iconSvg = '<img src="assets/icons/file-question.png" style="width: 20px; height: 20px; object-fit: contain;">';
			const permsText = formatPerms(file.perms);
			records.push({
				recid: recordId++,
				icon: applyClass(iconSvg, className),
				filename: applyClass(file.displayFilename || file.filename, className),
				filenameRaw: file.filename,
				filenameText: file.displayFilename || file.filename,
				type: applyClass('', className),
				typeRaw: '',
				size: applyClass('—', className),
				sizeBytes: null,
				dateModified: applyClass('—', className),
				modified: null,
				modifiedTimestamp: null,
				dateModifiedRaw: null,
				dateCreated: '—',
				dateCreatedRaw: null,
				dateCreatedTimestamp: null,
				perms: applyClass(getPermsCell(file), className),
				permsText,
				checksum: applyClass('—', className),
				checksumStatus: null,
				checksumValue: null,
				tags: '',
				tagsRaw: null,
				tagsText: '',
				isFolder: false,
				path: file.path,
				changeState: 'permError',
				inode: file.inode,
				dir_id: file.dir_id || null,
				orphan_id: null,
				orphan_type: null,
				new_dir_id: null,
				hasNotes: file.hasNotes || false,
				todo: file.todoCounts || null
			});
			continue;
		}

		const dateModifiedContent = getDateModifiedCell(file, file.changeState);
		const checksumCell = getChecksumCell(file, file.changeState);
		const matchedFt = matchFileType(file.filename);
		const ftIconFile = (matchedFt && matchedFt.icon) ? matchedFt.icon : 'user-file.png';
		const ftType = matchedFt ? matchedFt.type : '';
		const permsText = formatPerms(file.perms);
		const iconSvg = file.changeState === 'moved'
			? '<img src="assets/icons/file-moved.svg" style="width: 20px; height: 20px; object-fit: contain;">'
			: `<img src="assets/icons/${ftIconFile}" style="width: 20px; height: 20px; object-fit: contain;">`;

		records.push({
			recid: recordId++,
			icon: applyClass(iconSvg, className),
			filename: applyClass(file.displayFilename || file.filename, className),
			filenameRaw: file.filename,
			filenameText: file.displayFilename || file.filename,
			type: applyClass(file.changeState === 'moved' ? '' : ftType, className),
			typeRaw: file.changeState === 'moved' ? '' : ftType,
			size: applyClass(utils.formatBytes(file.size), className),
			sizeBytes: Number.isFinite(file.size) ? file.size : null,
			dateModified: dateModifiedContent,
			modified: -new Date(file.dateModified).getTime(),
			modifiedTimestamp: new Date(file.dateModified).getTime(),
			dateModifiedRaw: file.dateModified,
			dateCreated: file.dateCreated ? new Date(file.dateCreated).toLocaleDateString() : '-',
			dateCreatedRaw: file.dateCreated,
			dateCreatedTimestamp: file.dateCreated ? new Date(file.dateCreated).getTime() : null,
			perms: applyClass(getPermsCell(file), className),
			permsText,
			checksum: checksumCell,
			checksumStatus: file.checksumStatus || null,
			checksumValue: file.checksumValue || null,
			tags: renderTagBadges(file.tags || null, tagDefs),
			tagsRaw: file.tags || null,
			tagsText: getTagFilterText(file.tags || null),
			isFolder: false,
			path: file.path,
			changeState: file.changeState,
			inode: file.inode,
			dir_id: file.dir_id || null,
			orphan_id: file.orphan_id || null,
			orphan_type: file.orphan_id ? 'file' : null,
			new_dir_id: file.new_dir_id || null,
			hasNotes: file.hasNotes || false,
			todo: file.todoCounts || null
		});

		if (file.attributes) {
			let attrObj = {};
			try { attrObj = typeof file.attributes === 'string' ? JSON.parse(file.attributes) : file.attributes; } catch (_) { }
			const lastRecord = records[records.length - 1];
			for (const [key, value] of Object.entries(attrObj)) {
				lastRecord[`attr_${key}`] = value !== null && value !== undefined ? String(value) : '';
			}
		}
	}

	const newAttrCols = [...attrColSet].sort();
	if (JSON.stringify(newAttrCols) !== JSON.stringify(state.currentAttrColumns || [])) {
		state.currentAttrColumns = newAttrCols;
		await initializeGridForPanel(panelId);
	}

	const grid = state.w2uiGrid;
	if (grid) {
		setPanelSourceRecords(panelId, records);
	}
}

async function populateGalleryView(entries, currentDirCategory, panelId = activePanelId) {
	const state = panelState[panelId];
	const [settings, tagDefs] = await Promise.all([
		window.electronAPI.getSettings(),
		window.electronAPI.loadTags()
	]);

	const hideDotDirectory = settings.hide_dot_directory || false;
	const hideDotDotDirectory = settings.hide_dot_dot_directory || false;
	const showFolderNameWithDotEntries = settings.show_folder_name_with_dot_entries || false;
	const currentFolderName = state.currentPath.split(/[\\\/]/).filter(p => p).pop() || state.currentPath;

	let filteredEntries = entries;
	if (hideDotDirectory) {
		filteredEntries = entries.filter(e => e.filename !== '.');
	} else if (showFolderNameWithDotEntries) {
		filteredEntries = filteredEntries.map(e => {
			if (e.filename === '.') return { ...e, displayFilename: `. (${currentFolderName})` };
			return e;
		});
	}

	if (!hideDotDotDirectory && state.currentPath) {
		const parentMetadata = await window.electronAPI.getParentDirectoryMetadata(state.currentPath);
		if (parentMetadata) {
			const dotIndex = filteredEntries.findIndex(e => e.filename === '.');
			const insertIndex = dotIndex >= 0 ? dotIndex + 1 : 0;
			let parentDisplayFilename = '..';
			if (showFolderNameWithDotEntries && parentMetadata.path) {
				const parentFolderName = parentMetadata.path.split(/[\\\/]/).filter(p => p).pop() || parentMetadata.path;
				parentDisplayFilename = `.. (${parentFolderName})`;
			}
			filteredEntries = [...filteredEntries];
			filteredEntries.splice(insertIndex, 0, { ...parentMetadata, displayFilename: parentDisplayFilename });
		}
	}

	const folders = filteredEntries.filter(e => e.isDirectory);
	const files = filteredEntries.filter(e => !e.isDirectory);

	const galleryRecords = [];
	let recordId = 1;

	// Build folder records
	for (const folder of folders) {
		let category = folder.filename === '.' ? currentDirCategory : null;
		let iconUrl = '';
		if (folder.filename !== '.' && folder.changeState !== 'moved') {
			try {
				category = await window.electronAPI.getCategoryForDirectory(folder.path) || category;
			} catch (_) {}
		}
		if (!category && folder.filename !== '..') {
			category = currentDirCategory;
		}
		if (category) {
			const iconInitials = folder.resolvedInitials || folder.initials || null;
			iconUrl = await window.electronAPI.generateFolderIcon(category.bgColor, category.textColor, iconInitials);
		} else {
			iconUrl = 'assets/icons/folder-icon.png';
		}
		// Build display filename with direct (non-inherited) display name
		let galleryFilename = folder.displayFilename || folder.filename;
		if (folder.displayName && !folder.displayNameIsInherited) {
			if (folder.filename === '.') {
				galleryFilename = `. [${folder.displayName}] (${folder.filename})`;
			} else if (folder.filename === '..') {
				galleryFilename = `.. [${folder.displayName}] (${folder.filename})`;
			} else {
				galleryFilename = `[${folder.displayName}] ${folder.filename}`;
			}
		}
		galleryRecords.push({
			recid: recordId++,
			icon: iconUrl,
			filename: galleryFilename,
			filenameRaw: folder.filename,
			path: folder.path,
			isFolder: true,
			changeState: folder.changeState || 'same',
			tags: folder.tags || null,
			inode: folder.inode,
			dir_id: folder.dir_id || null,
			orphan_id: folder.orphan_id || null
		});
	}

	// Build file records
	const IMAGE_EXTS = new Set(['jpg','jpeg','png','gif','webp','bmp','tiff','tif','avif','heic','heif','svg']);
	const VIDEO_EXTS = new Set(['mp4','mov','avi','mkv','webm','m4v','mpg','mpeg','wmv','flv']);
	for (const file of files) {
		const matchedFt = matchFileType(file.filename);
		const ftIconFile = (matchedFt && matchedFt.icon) ? matchedFt.icon : 'user-file.png';
		const iconUrl = file.changeState === 'moved'
			? 'assets/icons/file-moved.svg'
			: `assets/icons/${ftIconFile}`;
		const ext = file.filename.toLowerCase().split('.').pop();
		const isImageType = (matchedFt && matchedFt.type === 'Image') || IMAGE_EXTS.has(ext);
		const isVideoType = (matchedFt && matchedFt.type === 'Video') || VIDEO_EXTS.has(ext);
		const thumbnailType = file.changeState === 'moved' ? 'icon'
			: isImageType ? 'image' : isVideoType ? 'video' : 'icon';
		galleryRecords.push({
			recid: recordId++,
			icon: iconUrl,
			filename: file.displayFilename || file.filename,
			filenameRaw: file.filename,
			path: file.path,
			isFolder: false,
			changeState: file.changeState || 'same',
			tags: file.tags || null,
			inode: file.inode,
			dir_id: file.dir_id || null,
			orphan_id: file.orphan_id || null,
			thumbnailType
		});
	}

	state.galleryRecords = galleryRecords;
	state.gallerySelectedRecids = new Set();

	renderGallery(panelId, tagDefs);
	try {
		attachDragDropForGallery(panelId, { panelState, navigateToDirectory });
	} catch (err) {
		console.warn('attachDragDropForGallery failed for panel', panelId, err);
	}
}

function renderGallery(panelId, tagDefs) {
	const state = panelState[panelId];
	const records = state.galleryRecords || [];
	const selected = state.gallerySelectedRecids || new Set();

	const $gallery = $(`#panel-${panelId} .panel-gallery`);
	$gallery.empty();

	for (const record of records) {
		const isSelected = selected.has(record.recid);
		const tagBadgesHtml = record.tags ? renderTagBadges(record.tags, tagDefs) : '';

		let thumbHtml;
		const thumbType = record.thumbnailType || 'icon';
		if (thumbType === 'image') {
			const fileUrl = 'file:///' + record.path.replace(/\\/g, '/');
			thumbHtml = `<img class="gallery-thumb" src="${fileUrl}" alt="" loading="lazy">`;
		} else if (thumbType === 'video') {
			thumbHtml = `<img class="gallery-thumb" data-video-path="${utils.escapeHtml(record.path)}" data-icon="${utils.escapeHtml(record.icon)}" alt="">`;
		} else {
			thumbHtml = `<img class="gallery-item-icon" src="${record.icon}" alt="">`;
		}

		const $item = $(`
			<div class="gallery-item${isSelected ? ' gallery-item-selected' : ''}"
				data-recid="${record.recid}">
				${thumbHtml}
				<div class="gallery-item-name">${record.filename}</div>
				${tagBadgesHtml ? `<div class="gallery-item-tags">${tagBadgesHtml}</div>` : ''}
			</div>
		`);
		$gallery.append($item);
	}

	// Lazy-load video thumbnails via IPC (ffmpeg frame extraction)
	const videoThumbEls = $gallery[0].querySelectorAll('.gallery-thumb[data-video-path]');
	if (videoThumbEls.length > 0) {
		const videoThumbObserver = new IntersectionObserver((entries, obs) => {
			entries.forEach(entry => {
				if (!entry.isIntersecting) return;
				const img = entry.target;
				if (img.src) return; // already loaded
				obs.unobserve(img);

				const filePath = img.dataset.videoPath;
				window.electronAPI.getVideoThumbnail(filePath).then(result => {
					if (result.success && result.dataUrl) {
						img.src = result.dataUrl;
					} else {
						// Fallback to file-type icon if ffmpeg extraction fails
						img.classList.replace('gallery-thumb', 'gallery-item-icon');
						img.src = img.dataset.icon;
					}
				}).catch(() => {
					img.classList.replace('gallery-thumb', 'gallery-item-icon');
					img.src = img.dataset.icon;
				});
			});
		}, { root: $gallery[0], rootMargin: '100px' });
		videoThumbEls.forEach(img => videoThumbObserver.observe(img));
	}

	// Bind gallery events
	$gallery.off('click.gallery dblclick.gallery contextmenu.gallery keydown.gallery mousedown.gallery');

	// Make the gallery container focusable so it can receive keyboard events
	// (Shift+Arrow multi-select). tabindex=-1 keeps it out of tab order but
	// allows programmatic focus.
	if ($gallery.attr('tabindex') == null) $gallery.attr('tabindex', '-1');

	$gallery.on('mousedown.gallery', '.gallery-item', function () {
		// Focus the gallery so subsequent arrow keys are received here
		// instead of bubbling to other handlers.
		try { $gallery[0].focus({ preventScroll: true }); } catch (_) { $gallery[0].focus(); }
	});

	$gallery.on('click.gallery', '.gallery-item', function (e) {
		setActivePanelId(panelId);
		gridFocusedPanelId = panelId;
		const recid = parseInt($(this).data('recid'), 10);
		const records = state.galleryRecords || [];
		const record = records.find(r => r.recid === recid);
		if (!record) return;
		state.gallerySelectedRecids = state.gallerySelectedRecids || new Set();

		if (e.shiftKey && state.galleryAnchorRecid != null) {
			state.gallerySelectedRecids = new Set(galleryRecidsBetween(records, state.galleryAnchorRecid, recid));
			state.galleryFocusRecid = recid;
		} else if (e.ctrlKey || e.metaKey) {
			if (state.gallerySelectedRecids.has(recid)) {
				state.gallerySelectedRecids.delete(recid);
			} else {
				state.gallerySelectedRecids.add(recid);
			}
			state.galleryAnchorRecid = recid;
			state.galleryFocusRecid = recid;
		} else {
			state.gallerySelectedRecids = new Set([recid]);
			state.galleryAnchorRecid = recid;
			state.galleryFocusRecid = recid;
		}

		refreshGallerySelectionVisuals($gallery, state);
		if (getPanelViewType(panelId) !== 'properties') {
			updateSelectedItemFromRecord(record, panelId);
		}
	});

	$gallery.on('keydown.gallery', function (e) {
		if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
		const records = state.galleryRecords || [];
		if (records.length === 0) return;
		state.gallerySelectedRecids = state.gallerySelectedRecids || new Set();
		// Pick a starting focus if none yet -- prefer the existing single
		// selection, else the first selected item, else the first record.
		if (state.galleryFocusRecid == null) {
			state.galleryFocusRecid = state.gallerySelectedRecids.size > 0
				? [...state.gallerySelectedRecids][0]
				: records[0].recid;
		}
		if (state.galleryAnchorRecid == null) state.galleryAnchorRecid = state.galleryFocusRecid;

		let nextRecid = state.galleryFocusRecid;
		if (e.key === 'ArrowLeft') {
			nextRecid = neighborRecidLinear(records, state.galleryFocusRecid, -1);
		} else if (e.key === 'ArrowRight') {
			nextRecid = neighborRecidLinear(records, state.galleryFocusRecid, +1);
		} else if (e.key === 'ArrowUp') {
			nextRecid = neighborRecidGeometric($gallery, state.galleryFocusRecid, 'up') || state.galleryFocusRecid;
		} else if (e.key === 'ArrowDown') {
			nextRecid = neighborRecidGeometric($gallery, state.galleryFocusRecid, 'down') || state.galleryFocusRecid;
		} else if (e.key === 'Home') {
			nextRecid = records[0].recid;
		} else if (e.key === 'End') {
			nextRecid = records[records.length - 1].recid;
		}
		if (nextRecid == null) return;
		e.preventDefault();
		e.stopPropagation();

		if (e.shiftKey) {
			state.gallerySelectedRecids = new Set(galleryRecidsBetween(records, state.galleryAnchorRecid, nextRecid));
		} else {
			state.gallerySelectedRecids = new Set([nextRecid]);
			state.galleryAnchorRecid = nextRecid;
		}
		state.galleryFocusRecid = nextRecid;
		refreshGallerySelectionVisuals($gallery, state);

		// Keep the focused tile in view.
		const focusedTile = $gallery.find(`.gallery-item[data-recid="${nextRecid}"]`)[0];
		if (focusedTile && typeof focusedTile.scrollIntoView === 'function') {
			focusedTile.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		}

		const focusedRecord = records.find(r => r.recid === nextRecid);
		if (focusedRecord && getPanelViewType(panelId) !== 'properties') {
			updateSelectedItemFromRecord(focusedRecord, panelId);
		}
	});

	$gallery.on('dblclick.gallery', '.gallery-item', function () {
		setActivePanelId(panelId);
		const recid = parseInt($(this).data('recid'), 10);
		const record = (state.galleryRecords || []).find(r => r.recid === recid);
		if (!record) return;
		if (record.isFolder && record.changeState !== 'moved') {
			navigateToDirectory(record.path, panelId);
		}
	});

	$gallery.on('contextmenu.gallery', '.gallery-item', async function (e) {
		e.preventDefault();
		setActivePanelId(panelId);
		const recid = parseInt($(this).data('recid'), 10);
		if (!state.gallerySelectedRecids.has(recid)) {
			state.gallerySelectedRecids = new Set([recid]);
			$gallery.find('.gallery-item').removeClass('gallery-item-selected');
			$(this).addClass('gallery-item-selected');
		}
		const selectedRecords = [...state.gallerySelectedRecids].map(id =>
			(state.galleryRecords || []).find(r => r.recid === id)
		).filter(Boolean);
		if (selectedRecords.length === 0) return;
		const menuItems = await generateW2UIContextMenu(selectedRecords, visiblePanels);
		showCustomContextMenu(menuItems, e.clientX, e.clientY, panelId);
	});
}

// ---- Gallery selection helpers ----

function refreshGallerySelectionVisuals($gallery, state) {
	const sel = state.gallerySelectedRecids || new Set();
	$gallery.find('.gallery-item').each(function () {
		const rid = parseInt(this.getAttribute('data-recid'), 10);
		this.classList.toggle('gallery-item-selected', sel.has(rid));
	});
}

function galleryRecidsBetween(records, anchorRecid, focusRecid) {
	const ia = records.findIndex(r => r.recid === anchorRecid);
	const ib = records.findIndex(r => r.recid === focusRecid);
	if (ia < 0 || ib < 0) return [focusRecid].filter(v => v != null);
	const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia];
	return records.slice(lo, hi + 1).map(r => r.recid);
}

function neighborRecidLinear(records, currentRecid, delta) {
	const idx = records.findIndex(r => r.recid === currentRecid);
	if (idx < 0) return records[0]?.recid ?? null;
	const next = Math.max(0, Math.min(records.length - 1, idx + delta));
	return records[next]?.recid ?? null;
}

/**
 * Find the recid of the tile visually above/below the current one in a
 * wrapped flex/grid layout. Picks the candidate in the next row whose
 * horizontal center is closest to the current tile's center.
 */
function neighborRecidGeometric($gallery, currentRecid, direction) {
	const tiles = $gallery.find('.gallery-item').toArray();
	const cur = tiles.find(t => parseInt(t.getAttribute('data-recid'), 10) === currentRecid);
	if (!cur) return null;
	const curRect = cur.getBoundingClientRect();
	const curMidX = curRect.left + curRect.width / 2;
	const sameRowEpsilon = Math.max(2, curRect.height * 0.25);
	let best = null;
	let bestDx = Infinity;
	let bestDy = Infinity;
	for (const t of tiles) {
		if (t === cur) continue;
		const r = t.getBoundingClientRect();
		const dy = (r.top + r.height / 2) - (curRect.top + curRect.height / 2);
		if (direction === 'up' && dy >= -sameRowEpsilon) continue;
		if (direction === 'down' && dy <= sameRowEpsilon) continue;
		const absDy = Math.abs(dy);
		const dx = Math.abs((r.left + r.width / 2) - curMidX);
		// Prefer the nearest row first, then nearest column within that row.
		if (absDy < bestDy - 1) {
			best = t; bestDy = absDy; bestDx = dx;
		} else if (Math.abs(absDy - bestDy) <= 1 && dx < bestDx) {
			best = t; bestDy = absDy; bestDx = dx;
		}
	}
	if (!best) return null;
	const rid = parseInt(best.getAttribute('data-recid'), 10);
	return Number.isFinite(rid) ? rid : null;
}

function getAttrEditableConfig(attrDefinition) {
	const type = (attrDefinition?.type || 'string').toLowerCase();
	if (type === 'yes-no') {
		return { type: 'list', items: [{ id: '', text: '(none)' }, { id: 'Yes', text: 'Yes' }, { id: 'No', text: 'No' }], showAll: true, openOnFocus: true };
	}
	if (type === 'selectable' && attrDefinition?.options?.length > 0) {
		return { type: 'list', items: [{ id: '', text: '(none)' }, ...attrDefinition.options.map(o => ({ id: o, text: o }))], showAll: true, openOnFocus: true };
	}
	if (type === 'rating') {
		return { type: 'list', items: [{ id: '', text: '(none)' }, { id: '1', text: '★' }, { id: '2', text: '★★' }, { id: '3', text: '★★★' }, { id: '4', text: '★★★★' }, { id: '5', text: '★★★★★' }], showAll: true, openOnFocus: true };
	}
	if (type === 'numeric') {
		return { type: 'float' };
	}
	return { type: 'text' };
}

function openInitialsEditor(record, panelId) {
	const existing = document.getElementById('initials-editor-popup');
	if (existing) existing.remove();

	const grid = panelState[panelId].w2uiGrid;
	if (!grid) return;
	const gridName = `grid-panel-${panelId}`;
	const rowEl = document.querySelector(`#grid_${gridName}_rec_${record.recid}`);
	if (!rowEl) return;
	const iconCell = rowEl.querySelector('td:first-child');
	if (!iconCell) return;

	const rect = iconCell.getBoundingClientRect();
	const popup = document.createElement('div');
	popup.id = 'initials-editor-popup';
	popup.style.cssText = `
		position: fixed;
		left: ${rect.left}px;
		top: ${rect.bottom + 2}px;
		background: #fff;
		border: 1px solid #2196F3;
		border-radius: 4px;
		padding: 4px 6px;
		box-shadow: 0 2px 8px rgba(0,0,0,0.2);
		z-index: 9999;
		display: flex;
		align-items: center;
		gap: 4px;
	`;

	const input = document.createElement('input');
	input.type = 'text';
	input.maxLength = 2;
	input.value = record.initials || '';
	input.placeholder = 'AB';
	input.style.cssText = 'width: 36px; font-size: 13px; font-weight: bold; text-align: center; text-transform: uppercase; border: none; outline: none; padding: 2px;';

	const confirmBtn = document.createElement('button');
	confirmBtn.textContent = '✓';
	confirmBtn.title = 'Save initials';
	confirmBtn.style.cssText = 'padding: 2px 6px; cursor: pointer; background: #2196F3; color: white; border: none; border-radius: 3px; font-size: 12px;';

	const clearBtn = document.createElement('button');
	clearBtn.textContent = '✕';
	clearBtn.title = 'Clear initials';
	clearBtn.style.cssText = 'padding: 2px 6px; cursor: pointer; background: #f0f0f0; border: 1px solid #ccc; border-radius: 3px; font-size: 12px;';

	popup.appendChild(input);
	popup.appendChild(confirmBtn);
	popup.appendChild(clearBtn);
	document.body.appendChild(popup);
	input.focus();
	input.select();

	async function applyInitials(value) {
		popup.remove();
		const newInitials = value ? value.trim().slice(0, 2).toUpperCase() : null;
		await window.electronAPI.saveDirectoryInitials(record.path, newInitials);
		record.initials = newInitials;
		const category = await window.electronAPI.getCategoryForDirectory(record.path);
		const iconUrl = await window.electronAPI.generateFolderIcon(category.bgColor, category.textColor, newInitials);
		const className = getRowClassName(record.changeState);
		record.icon = className
			? `<div class="${className}"><img src="${iconUrl}" style="width: 20px; height: 20px; object-fit: contain; cursor: pointer;" title="Click to set initials"></div>`
			: `<img src="${iconUrl}" style="width: 20px; height: 20px; object-fit: contain; cursor: pointer;" title="Click to set initials">`;
		grid.refreshCell(record.recid, 'icon');
		await sidebar.refreshFavoritesSidebar();
	}

	confirmBtn.addEventListener('click', () => applyInitials(input.value));
	clearBtn.addEventListener('click', () => applyInitials(''));

	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') applyInitials(input.value);
		if (e.key === 'Escape') popup.remove();
		input.value = input.value.toUpperCase();
	});
	input.addEventListener('input', () => { input.value = input.value.toUpperCase(); });

	setTimeout(() => {
		document.addEventListener('mousedown', function outsideClick(e) {
			if (!popup.contains(e.target)) {
				popup.remove();
				document.removeEventListener('mousedown', outsideClick);
			}
		});
	}, 0);
}

function getRowClassName(changeState) {
	switch (changeState) {
		case 'new':
			return 'file-new';
		case 'dateModified':
			return 'file-date-modified';
		case 'checksumChanged':
			return 'file-checksum-changed';
		case 'orphan':
			return 'file-orphan';
		case 'moved':
			return 'file-moved';
		case 'permError':
			return 'file-perm-error';
		case 'deleted':
			return 'file-deleted';
		default:
			return '';
	}
}

function formatPerms(perms) {
	if (!perms) return '?';
	if (perms.read && perms.write) return 'rw';
	if (perms.read) return 'r';
	if (perms.write) return 'w';
	return '--';
}

function getPermsCell(entry) {
	const permsText = formatPerms(entry.perms);
	const modeText = (entry.mode === null || entry.mode === undefined) ? 'mode: unknown' : `mode: ${entry.mode}`;
	return `<span title="${modeText}" style="cursor: help;">${permsText}</span>`;
}

function formatTimeAgo(timestamp) {
	if (!timestamp) return '-';
	const diffMs = Date.now() - new Date(timestamp).getTime();
	if (isNaN(diffMs) || diffMs < 0) return '-';
	const diffSec = Math.floor(diffMs / 1000);
	if (diffSec < 60) return `${diffSec}s`;
	const diffMin = Math.floor(diffSec / 60);
	if (diffMin < 60) return `${diffMin}m`;
	const diffHr = Math.floor(diffMin / 60);
	if (diffHr < 24) return `${diffHr}h`;
	const diffDay = Math.floor(diffHr / 24);
	if (diffDay < 365) return `${diffDay}d`;
	const years = Math.floor(diffDay / 365);
	const remainingDays = diffDay - years * 365;
	return remainingDays > 0 ? `${years}y${remainingDays}d` : `${years}y`;
}

function decodeCopyValue(encodedValue) {
	if (!encodedValue) return '';
	try {
		return decodeURIComponent(encodedValue);
	} catch (_) {
		return encodedValue;
	}
}

function renderCopyValueButton(value, extraClass = '') {
	if (value === null || value === undefined || value === '') return '';
	const encodedValue = encodeURIComponent(String(value));
	return `<button class="btn-copy-value${extraClass}" data-copy-value="${encodedValue}" title="Copy"><img src="assets/icons/copy.svg" width="16" height="16"></button>`;
}

function showCopySuccessTooltip(anchor) {
	if (!anchor) return;
	w2tooltip.show({
		name: 'copy-success-tooltip',
		anchor,
		html: 'Copied',
		position: 'top|bottom',
		offsetY: -2,
		hideOn: ['doc-click']
	});
	if (anchor._copyTooltipTimer) {
		clearTimeout(anchor._copyTooltipTimer);
	}
	anchor._copyTooltipTimer = setTimeout(() => {
		w2tooltip.hide('copy-success-tooltip');
		anchor._copyTooltipTimer = null;
	}, 900);
}

async function copyValueToClipboard(value, anchor) {
	if (!value) return;
	try {
		await navigator.clipboard.writeText(value);
		showCopySuccessTooltip(anchor);
	} catch (_) {
		// Ignore clipboard failures to preserve current behavior.
	}
}

function renderStarsHtml(value, interactive) {
	const rating = Math.max(0, Math.min(5, parseInt(value, 10) || 0));
	let stars = '';
	for (let i = 1; i <= 5; i++) {
		const filled = i <= rating ? ' filled' : '';
		stars += `<span class="star${filled}" data-value="${i}">${i <= rating ? '★' : '☆'}</span>`;
	}
	if (interactive) {
		return `<div class="rating-picker"><input type="hidden" class="rating-value" value="${rating}">${stars}</div>`;
	}
	return `<div class="rating-display-stars">${stars}</div>`;
}

function formatCustomAttributeValue(value, type) {
	if (value === null || value === undefined || value === '') return '';
	if ((type || '').toLowerCase() === 'yes-no') {
		if (value === true || value === 'true' || value === 'Yes') return 'Yes';
		if (value === false || value === 'false' || value === 'No') return 'No';
	}
	if ((type || '').toLowerCase() === 'rating') {
		const n = parseInt(value, 10);
		return n >= 1 && n <= 5 ? `${n}/5` : '';
	}
	return String(value);
}

function renderGridAttributeCell(record, attrName, attrDefinition) {
	// Determine whether this attribute applies to this record type
	const appliesTo = (attrDefinition?.appliesTo || 'both').toLowerCase();
	const notApplicable =
		(appliesTo === 'directory' && !record.isFolder) ||
		(appliesTo === 'files' && record.isFolder);
	if (notApplicable) {
		return '<div class="grid-attr-copy-cell grid-attr-na"><span class="grid-attr-copy-text grid-attr-na-text">---</span></div>';
	}
	const rawValue = record[`attr_${attrName}`];
	const safeAttrName = utils.escapeHtml(attrName);
	const editBtn = `<button class="btn-attr-edit" data-attr-edit-trigger="true" data-attr-name="${safeAttrName}" title="Edit"><img src="assets/icons/edit.svg" width="16" height="16"></button>`;

	if ((attrDefinition?.type || '').toLowerCase() === 'rating') {
		const starsHtml = renderStarsHtml(rawValue, false);
		return `<div class="grid-attr-copy-cell">${starsHtml}${editBtn}</div>`;
	}

	const displayValue = formatCustomAttributeValue(rawValue, attrDefinition?.type);
	if (!displayValue) {
		return `<div class="grid-attr-copy-cell"><span class="grid-attr-copy-text"></span>${editBtn}</div>`;
	}
	const safeValue = utils.escapeHtml(displayValue);
	return `<div class="grid-attr-copy-cell" title="${safeValue}"><span class="grid-attr-copy-text">${safeValue}</span>${editBtn}${renderCopyValueButton(displayValue, ' grid-copy-value-btn')}</div>`;
}

function getDateModifiedCell(file, changeState) {
	const dateStr = new Date(file.dateModified).toLocaleString();
	if (changeState === 'new') return `<div class="file-new">${dateStr}</div>`;
	if (changeState === 'dateModified') return `<div class="file-date-modified">${dateStr}</div>`;
	if (changeState === 'checksumPending') return '<div class="file-checksum-pending">Pending...</div>';
	if (changeState === 'checksumChanged') return `<div class="file-checksum-changed">${dateStr}</div>`;
	return dateStr;
}

function getChecksumCell(file, changeState) {
	if (file.isFolder) return '—';
	if (changeState === 'checksumPending') {
		return '<div class="file-checksum-pending"><span style="animation: spin 1s linear infinite;">⟳</span> Pending</div>';
	}
	if (file.checksumValue) {
		const shortHash = file.checksumValue.substring(0, 12) + '...';
		return `<span title="${file.checksumValue}" style="cursor: help;">${shortHash}</span>`;
	}
	return '—';
}

async function acknowledgeFileModification(inode, panelId) {
	try {
		const state = panelState[panelId];
		const currentPath = state.currentPath;
		const grid = state.w2uiGrid;
		const record = grid.records.find(r => r.inode === inode);
		if (!record) return;

		const result = await window.electronAPI.updateFileModificationDate(currentPath, inode, record.dateModifiedRaw);
		if (result.success) {
			record.changeState = 'unchanged';
			record.dateModified = new Date(record.dateModifiedRaw).toLocaleDateString();
			record.modified = -new Date(record.dateModifiedRaw).getTime();
			grid.refresh();
		} else {
			alert('Error: ' + result.error);
		}
	} catch (err) {
		alert('Error acknowledging modification: ' + err.message);
	}
}

async function startChecksumQueue(filesToChecksum, panelId, dirPath) {
	const state = panelState[panelId];
	state.checksumQueue = filesToChecksum;
	state.checksumQueueIndex = 0;
	state.checksumCancelled = false;
	while (state.checksumQueueIndex < state.checksumQueue.length && !state.checksumCancelled) {
		const file = state.checksumQueue[state.checksumQueueIndex];
		await calculateChecksumForFile(file, panelId, dirPath);
		state.checksumQueueIndex++;
	}
}

async function calculateChecksumForFile(record, panelId, dirPath) {
	try {
		const result = await window.electronAPI.calculateFileChecksum(record.path, record.inode, record.dir_id);
		if (result.success) {
			record.checksumStatus = 'calculated';
			record.checksumValue = result.checksum;
			const shortHash = result.checksum ? result.checksum.substring(0, 12) + '...' : '—';
			record.checksum = `<span title="${result.checksum || ''}" style="cursor: help;">${shortHash}</span>`;
			if (result.changed && result.hadPreviousChecksum) {
				record.changeState = 'checksumChanged';
			}
			if (result.notificationCreated) {
				unacknowledgedAlertCount++;
				updateAlertBadge();
			}
			record.dateModified = new Date(record.dateModifiedRaw).toLocaleDateString();
			record.modified = -new Date(record.dateModifiedRaw).getTime();
		} else {
			record.checksumStatus = 'error';
			record.checksum = '<span style="color: #f00;">Error</span>';
		}

		const grid = panelState[panelId].w2uiGrid;
		if (grid) grid.refresh();
	} catch (err) {
		record.checksumStatus = 'error';
		record.checksum = '<span style="color: #f00;">Error</span>';
		const grid = panelState[panelId].w2uiGrid;
		if (grid) grid.refresh();
	}
}

function cancelChecksumQueue(panelId) {
	const state = panelState[panelId];
	if (state.checksumQueue) {
		state.checksumCancelled = true;
	}
}

export async function loadCategories() {
	try {
		allCategories = await window.electronAPI.loadCategories();
	} catch (err) {
		console.error('Error loading categories:', err);
	}
}

export async function loadTagsList() {
	try {
		allTags = await window.electronAPI.getTagsList();
	} catch (err) {
		console.error('Error loading tags list:', err);
		allTags = [];
	}
}

export async function loadFileTypes() {
	try {
		allFileTypes = await window.electronAPI.getFileTypes();
	} catch (err) {
		console.error('Error loading file types:', err);
		allFileTypes = [];
	}
}

export function matchFileType(filename) {
	const lower = filename.toLowerCase();
	for (const ft of allFileTypes) {
		const pat = ft.pattern.toLowerCase();
		if (pat === lower) return ft;
		if (pat.startsWith('*.') && lower.endsWith(pat.slice(1))) return ft;
	}
	return null;
}

export function setActivePanelId(panelId) {
	if (panelId >= 1 && panelId <= 4) {
		activePanelId = panelId;
		syncRendererActivePanelId(panelId);
		setSidebarFocus(false);
		for (let i = 1; i <= 4; i++) {
			$(`#panel-${i} .panel-number`).removeClass('panel-number-selected');
			$(`#panel-${i}`).removeClass('panel-active');
		}
		$(`#panel-${panelId} .panel-number`).addClass('panel-number-selected');
		$(`#panel-${panelId}`).addClass('panel-active');
		refreshItemPropertiesInAllPanels();
	}
}

export function focusSearchBarWithChar(panelId, char) {
	const state = panelState[panelId];
	if (!state) return;
	const toolbar = getPanelToolbarElement(panelId);
	if (!toolbar) return;
	const input = toolbar.querySelector('.panel-tb-search');
	if (!input) return;
	input.value = char;
	input.focus();
	input.setSelectionRange(char.length, char.length);
}

export function setGridFocusedPanelId(panelId) {
	gridFocusedPanelId = panelId;
}

export function getPanelViewType(panelId) {
	const $panel = $(`#panel-${panelId}`);
	if ($panel.find('.panel-file-view').is(':visible')) return 'file';
	if ($panel.find('.panel-gallery').hasClass('active')) return 'gallery';
	if ($panel.find('.panel-grid').is(':visible')) return 'grid';
	return 'properties';
}

export function refreshItemPropertiesInAllPanels() {
	for (let i = 2; i <= 4; i++) {
		if (panelState[i].attrEditMode || panelState[i].notesEditMode) continue;
		if ($(`#panel-${i}`).is(':visible') && getPanelViewType(i) === 'properties') {
			updateItemPropertiesPage(i);
		}
	}
}

export function navigateBack() {
	const state = panelState[activePanelId];
	if (state.navigationIndex > 0) {
		state.navigationIndex--;
		navigateToDirectory(state.navigationHistory[state.navigationIndex], activePanelId, false);
	}
}

export function navigateToParent(panelId) {
	setActivePanelId(panelId);
	const state = panelState[panelId];
	if (state.currentPath && state.currentPath.length > 3) {
		const parentPath = state.currentPath.substring(0, state.currentPath.lastIndexOf('\\'));
		if (parentPath.length >= 2) {
			navigateToDirectory(parentPath, panelId);
		}
	}
}

export function navigateForward() {
	const state = panelState[activePanelId];
	if (state.navigationIndex < state.navigationHistory.length - 1) {
		state.navigationIndex++;
		navigateToDirectory(state.navigationHistory[state.navigationIndex], activePanelId, false);
	}
}

export function activatePathEditMode(panelId) {
	const headerEl = getPanelHeaderElement(panelId);
	const $header = headerEl ? $(headerEl) : $(`#panel-${panelId} .panel-header`);
	const $pathDisplay = $header.find('.panel-path');
	const $pathInput = $header.find('.panel-path-input');
	const currentPath = panelState[panelId].currentPath;
	$pathDisplay.hide();
	$header.addClass('path-input-editing');
	$pathInput.val(currentPath).show().select().focus();
}

export async function deactivatePathEditMode(panelId, navigateToNewPath = false, newPath = '') {
	const headerEl = getPanelHeaderElement(panelId);
	const $header = headerEl ? $(headerEl) : $(`#panel-${panelId} .panel-header`);
	const $pathDisplay = $header.find('.panel-path');
	const $pathInput = $header.find('.panel-path-input');
	$pathInput.hide();
	$header.removeClass('path-input-editing');
	$pathDisplay.show();
	if (navigateToNewPath && newPath && newPath !== panelState[panelId].currentPath) {
		await navigateToDirectory(newPath, panelId);
	}
}

export async function switchLayout(layoutNumber) {
	currentLayout = layoutNumber;
	const $container = $('#panel-container');
	$container.removeClass('layout-1 layout-2 layout-3 layout-4');
	$container.addClass(`layout-${layoutNumber}`);
	setTimeout(() => {
		for (let panelId = 1; panelId <= 4; panelId++) {
			const grid = panelState[panelId].w2uiGrid;
			if (grid) grid.resize();
		}
		setupDividers();
		setupBadgeDragHandles();
	}, 150);
}

export function initializeDividers() {
	panelDividerState.verticalPixels = parseFloat(localStorage.getItem('panelDividerVertical') || '400');
	panelDividerState.horizontalPixels = parseFloat(localStorage.getItem('panelDividerHorizontal') || '300');
	setTimeout(() => {
		setupDividers();
	}, 150);

	$(window).on('resize.panelDivider', () => {
		setupDividers();
	});

	if (w2layoutInstance) {
		w2layoutInstance.on('resize', () => {
			setupDividers();
			for (let panelId = 1; panelId <= 4; panelId++) {
				const grid = panelState[panelId].w2uiGrid;
				if (grid) grid.resize();
			}
		});
	}
}

function setupDividers() {
	const layout = currentLayout;
	const $verticalDivider = $('#panel-divider-vertical');
	const $horizontalDivider = $('#panel-divider-horizontal');
	const $container = $('#panel-container');
	const hasVerticalDivider = layout >= 2;
	const hasHorizontalDivider = layout >= 3;

	if (hasVerticalDivider) {
		$verticalDivider.css('display', 'block');
		updateGridColumns();
		positionVerticalDivider();
	} else {
		$verticalDivider.css('display', 'none');
		$container.css('grid-template-columns', '1fr');
	}

	if (hasHorizontalDivider) {
		$horizontalDivider.css('display', 'block');
		updateGridRows();
		positionHorizontalDivider();
	} else {
		$horizontalDivider.css('display', 'none');
		$container.css('grid-template-rows', '1fr');
	}
}

function positionVerticalDivider() {
	const $container = $('#panel-container');
	const $divider = $('#panel-divider-vertical');
	const containerWidth = $container.width();
	const containerHeight = $container.height();
	if (containerWidth === 0 || containerHeight === 0) return;

	const dividerX = panelDividerState.verticalPixels;
	$divider.css({
		left: (dividerX - 2) + 'px',
		top: 0,
		height: containerHeight + 'px',
		display: 'block'
	});

	$divider.off('mousedown.panelResize');
	$divider.on('mousedown.panelResize', function (e) {
		e.preventDefault();
		e.stopPropagation();
		panelDividerState.isResizingVertical = true;
		$divider.addClass('dragging');

		const startX = e.pageX;
		const startPixels = panelDividerState.verticalPixels;

		$(document).on('mousemove.panelResizeVertical', function (moveEvent) {
			const deltaX = moveEvent.pageX - startX;
			const newPixels = startPixels + deltaX;
			const maxPixels = containerWidth - panelDividerState.minPanelWidth;
			const constrainedPixels = Math.max(panelDividerState.minPanelWidth, Math.min(maxPixels, newPixels));
			panelDividerState.verticalPixels = constrainedPixels;
			updateGridColumns();
			positionVerticalDivider();
			if (currentLayout === 3) positionHorizontalDivider();
		});

		$(document).on('mouseup.panelResizeVertical', function () {
			$(document).off('mousemove.panelResizeVertical mouseup.panelResizeVertical');
			panelDividerState.isResizingVertical = false;
			$divider.removeClass('dragging');
			localStorage.setItem('panelDividerVertical', panelDividerState.verticalPixels);
			for (let panelId = 1; panelId <= 4; panelId++) {
				const grid = panelState[panelId].w2uiGrid;
				if (grid) grid.resize();
			}
		});
	});
}

function positionHorizontalDivider() {
	const $container = $('#panel-container');
	const $divider = $('#panel-divider-horizontal');
	const containerWidth = $container.width();
	const containerHeight = $container.height();
	if (containerWidth === 0 || containerHeight === 0) return;

	const dividerY = panelDividerState.horizontalPixels;
		let dividerLeft = 0;
		let dividerWidth = containerWidth;
	if (currentLayout === 3) {
		dividerLeft = panelDividerState.verticalPixels;
		dividerWidth = containerWidth - panelDividerState.verticalPixels;
	}

	$divider.css({
		left: dividerLeft + 'px',
		top: (dividerY - 2) + 'px',
		width: dividerWidth + 'px',
		display: 'block'
	});

	$divider.off('mousedown.panelResize');
	$divider.on('mousedown.panelResize', function (e) {
		e.preventDefault();
		e.stopPropagation();
		panelDividerState.isResizingHorizontal = true;
		$divider.addClass('dragging');

		const startY = e.pageY;
		const startPixels = panelDividerState.horizontalPixels;

		$(document).on('mousemove.panelResizeHorizontal', function (moveEvent) {
			const deltaY = moveEvent.pageY - startY;
			const newPixels = startPixels + deltaY;
			const maxPixels = containerHeight - panelDividerState.minPanelHeight;
			const constrainedPixels = Math.max(panelDividerState.minPanelHeight, Math.min(maxPixels, newPixels));
			panelDividerState.horizontalPixels = constrainedPixels;
			updateGridRows();
			positionHorizontalDivider();
		});

		$(document).on('mouseup.panelResizeHorizontal', function () {
			$(document).off('mousemove.panelResizeHorizontal mouseup.panelResizeHorizontal');
			panelDividerState.isResizingHorizontal = false;
			$divider.removeClass('dragging');
			localStorage.setItem('panelDividerHorizontal', panelDividerState.horizontalPixels);
			for (let panelId = 1; panelId <= 4; panelId++) {
				const grid = panelState[panelId].w2uiGrid;
				if (grid) grid.resize();
			}
		});
	});
}

function updateGridColumns() {
	const leftWidth = panelDividerState.verticalPixels;
	$('#panel-container').css('grid-template-columns', `${leftWidth}px 1fr`);
}

function updateGridRows() {
	const topHeight = panelDividerState.horizontalPixels;
	$('#panel-container').css('grid-template-rows', `${topHeight}px 1fr`);
}

function setupBadgeDragHandles() {
	$('.panel-number').off('mousedown.badgeDrag');
	$('.panel-number').on('mousedown.badgeDrag', function (e) {
		e.preventDefault();
		const panelId = parseInt($(this).text());
		const $panel = $(`#panel-${panelId}`);
		if (!$panel.is(':visible')) return;
		const layout = currentLayout;
		if (layout === 1) {
			if (panelId === 1) startBadgeDragSidebar(e);
		} else if (layout === 2) {
			if (panelId === 1) startBadgeDragSidebar(e);
			else startBadgeDragVertical(e);
		} else if (layout === 3) {
			if (panelId === 1) startBadgeDragSidebar(e);
			else if (panelId === 2) startBadgeDragVertical(e);
			else if (panelId === 3) startBadgeDragBoth(e, 'vertical-and-horizontal');
		} else if (layout === 4) {
			if (panelId === 1) startBadgeDragSidebar(e);
			else if (panelId === 2) startBadgeDragVertical(e);
			else if (panelId === 3) startBadgeDragBoth(e, 'vertical-and-horizontal');
			else if (panelId === 4) startBadgeDragBoth(e, 'sidebar-and-horizontal');
		}
	});
}

function startBadgeDragSidebar(e) {
	const startX = e.pageX;
	const startSidebarWidth = w2layoutInstance.get('left').size;
	$('body').css('cursor', 'ew-resize');
	$(document).on('mousemove.badgeDragSidebar', function (moveEvent) {
		const deltaX = moveEvent.pageX - startX;
		const newWidth = startSidebarWidth + deltaX;
		sidebar.applySidebarDragWidth(newWidth);
	});
	$(document).on('mouseup.badgeDragSidebar', function () {
		$(document).off('mousemove.badgeDragSidebar mouseup.badgeDragSidebar');
		$('body').css('cursor', 'default');
	});
}

function startBadgeDragVertical(e) {
	const $container = $('#panel-container');
	const containerWidth = $container.width();
	const startX = e.pageX;
	const startPixels = panelDividerState.verticalPixels;
	$('body').css('cursor', 'ew-resize');
	$(document).on('mousemove.badgeDragVertical', function (moveEvent) {
		const deltaX = moveEvent.pageX - startX;
		const newPixels = startPixels + deltaX;
		const maxPixels = containerWidth - panelDividerState.minPanelWidth;
		const constrainedPixels = Math.max(panelDividerState.minPanelWidth, Math.min(maxPixels, newPixels));
		panelDividerState.verticalPixels = constrainedPixels;
		updateGridColumns();
		positionVerticalDivider();
		if (currentLayout === 3) positionHorizontalDivider();
	});
	$(document).on('mouseup.badgeDragVertical', function () {
		$(document).off('mousemove.badgeDragVertical mouseup.badgeDragVertical');
		$('body').css('cursor', 'default');
		localStorage.setItem('panelDividerVertical', panelDividerState.verticalPixels);
		for (let panelId = 1; panelId <= 4; panelId++) {
			const grid = panelState[panelId].w2uiGrid;
			if (grid) grid.resize();
		}
		positionVerticalDivider();
		if (currentLayout === 3) positionHorizontalDivider();
	});
}

function startBadgeDragBoth(e, dragMode) {
	const $container = $('#panel-container');
	const containerWidth = $container.width();
	const containerHeight = $container.height();
	const startX = e.pageX;
	const startY = e.pageY;
	const startVerticalPixels = panelDividerState.verticalPixels;
	const startHorizontalPixels = panelDividerState.horizontalPixels;
	const startSidebarWidth = dragMode === 'sidebar-and-horizontal' ? w2layoutInstance.get('left').size : null;
	$('body').css('cursor', 'all-scroll');
	$(document).on('mousemove.badgeDragBoth', function (moveEvent) {
		const deltaX = moveEvent.pageX - startX;
		const deltaY = moveEvent.pageY - startY;
		if (dragMode === 'vertical-and-horizontal') {
			const newVPixels = startVerticalPixels + deltaX;
			const maxVPixels = containerWidth - panelDividerState.minPanelWidth;
			panelDividerState.verticalPixels = Math.max(panelDividerState.minPanelWidth, Math.min(maxVPixels, newVPixels));
			updateGridColumns();
			positionVerticalDivider();
			if (currentLayout === 3) positionHorizontalDivider();
		} else if (dragMode === 'sidebar-and-horizontal') {
			const newSidebarWidth = startSidebarWidth + deltaX;
			sidebar.applySidebarDragWidth(newSidebarWidth);
		}

		const newHPixels = startHorizontalPixels + deltaY;
		const maxHPixels = containerHeight - panelDividerState.minPanelHeight;
		panelDividerState.horizontalPixels = Math.max(panelDividerState.minPanelHeight, Math.min(maxHPixels, newHPixels));
		updateGridRows();
		positionHorizontalDivider();
		for (let panelId = 1; panelId <= 4; panelId++) {
			const grid = panelState[panelId].w2uiGrid;
			if (grid) grid.resize();
		}
	});
	$(document).on('mouseup.badgeDragBoth', function () {
		$(document).off('mousemove.badgeDragBoth mouseup.badgeDragBoth');
		$('body').css('cursor', 'default');
		localStorage.setItem('panelDividerVertical', panelDividerState.verticalPixels);
		localStorage.setItem('panelDividerHorizontal', panelDividerState.horizontalPixels);
		for (let panelId = 1; panelId <= 4; panelId++) {
			const grid = panelState[panelId].w2uiGrid;
			if (grid) grid.resize();
		}
		positionVerticalDivider();
		positionHorizontalDivider();
	});
}

export function showLayoutModal() {
	$('#layout-modal').show();
}

export function hideLayoutModal() {
	$('#layout-modal').hide();
}

export function toggleSelectMode(panelId) {
	const state = panelState[panelId];
	state.selectMode = !state.selectMode;
	const $selectBtn = $(`#panel-${panelId} .btn-panel-select`);
	if (state.selectMode) {
		$selectBtn.addClass('panel-select-active');
		$(`#panel-${panelId} .panel-landing-page`).hide();
		$(`#panel-${panelId} .panel-grid`).show();
		renderPanelToolbar(panelId, 'detail');
		const grid = panelState[panelId].w2uiGrid;
		if (grid) grid.resize();
	} else {
		$selectBtn.removeClass('panel-select-active');
		$(`#panel-${panelId} .panel-landing-page`).show();
		$(`#panel-${panelId} .panel-grid`).hide();
		hidePanelToolbar(panelId);
	}
}

function updatePanelSelectButtons() {
	for (let panelId = 2; panelId <= 4; panelId++) {
		const $selectBtn = $(`#panel-${panelId} .btn-panel-select`);
		if (panel1SelectedDirectoryPath && panel1SelectedDirectoryName) {
			$selectBtn.prop('disabled', false);
			$selectBtn.text(panel1SelectedDirectoryName);
			$selectBtn.css('background-color', '');
			$selectBtn.css('color', '');
			$selectBtn.css('cursor', 'pointer');
		} else {
			$selectBtn.prop('disabled', true);
			$selectBtn.text('Select directory');
			$selectBtn.css('background-color', '#ccc');
			$selectBtn.css('color', '#666');
			$selectBtn.css('cursor', 'not-allowed');
		}
	}
}

function handlePanel1DirectorySelection(dirPath, dirName) {
	panel1SelectedDirectoryPath = dirPath;
	panel1SelectedDirectoryName = dirName;
	updatePanelSelectButtons();
}

export function updatePanelLayout() {
	const $container = $('#panel-container');
	$container.removeClass('layout-1 layout-2 layout-3 layout-4').addClass(`layout-${visiblePanels}`);
	currentLayout = visiblePanels;
	syncAddPanelButtonState();
	setTimeout(() => {
		setupDividers();
		setupBadgeDragHandles();
	}, 100);
}

export function addPanel() {
	if (visiblePanels >= 4) {
		return null;
	}

	visiblePanels++;
	const newPanelId = visiblePanels;
	$(`#panel-${newPanelId}`).show();
	attachPanelEventListeners(newPanelId);
	updatePanelLayout();
	return newPanelId;
}

export function removePanel(panelId) {
	if (visiblePanels === 1) {
		alert('Cannot remove the last panel');
		return;
	}

	// Clean up terminal session if present
	if (terminal.isPanelTerminal(panelId)) {
		terminal.destroyTerminalPanel(panelId);
	}

	const stateToSave = panelState[panelId];
	closedPanelStack.push({
		currentPath: stateToSave ? (stateToSave.currentPath || '') : '',
		navigationHistory: stateToSave ? [...(stateToSave.navigationHistory || [])] : [],
		navigationIndex: stateToSave && stateToSave.navigationIndex !== undefined ? stateToSave.navigationIndex : -1,
		depth: stateToSave ? (stateToSave.depth || 0) : 0
	});

	$(`#panel-${panelId}`).hide();
	clearPanelState(panelId);
	for (let i = panelId; i < visiblePanels; i++) {
		shiftPanelDown(i);
	}
	visiblePanels--;
	setActivePanelId(1);
	updatePanelLayout();

	// Rebuild LOCAL FAVORITES now that panel layout has changed
	const panelPaths = {};
	for (let i = 1; i <= visiblePanels; i++) {
		if (panelState[i]?.currentPath) panelPaths[i] = panelState[i].currentPath;
	}
	sidebar.rebuildLocalFavorites(panelPaths);
}

function shiftPanelDown(panelId) {
	const nextPanelId = panelId + 1;
	panelState[panelId] = { ...panelState[nextPanelId] };
	const $currentGrid = $(`#panel-${panelId} .panel-grid`);
	if (panelState[panelId].w2uiGrid) {
		panelState[panelId].w2uiGrid.render($currentGrid[0]);
		updatePanelHeader(panelId, panelState[panelId].currentPath || 'Loading...');
	}
}

function clearPanelState(panelId) {
	hidePanelFilterMenu(panelId);
	panelState[panelId] = {
		currentPath: '',
		w2uiGrid: null,
		navigationHistory: [],
		navigationIndex: -1,
		currentCategory: null,
		selectMode: false,
		checksumQueue: null,
		checksumQueueIndex: 0,
		checksumCancelled: false,
		showDateCreated: false,
		hasBeenViewed: false,
		attrEditMode: false,
		notesEditMode: false,
		notesMonacoEditor: null,
		notesFilePath: null,
		sectionCollapseState: null,
		currentItemOpenWith: null,
		labelsUiState: null,
		currentItemStats: null,
		filterVisible: false,
		filterValues: null,
		filterMenuField: null,
		sourceRecords: [],
		currentAttrColumns: [],
		currentAttrDefinitions: {},
		galleryRecords: [],
		gallerySelectedRecids: new Set(),
		autoLabelCount: 0,
		autoLabelSuggestions: []
	};

	window.electronAPI.unregisterWatchedPath(panelId);
	const $panel = $(`#panel-${panelId}`);
	setPanelPathValidity(panelId, true);
	$panel.find('.panel-header').removeClass('active');
	$panel.find('.panel-landing-page').show();
	$panel.find('.panel-grid').hide();
	$panel.find('.panel-gallery').removeClass('active');
	$panel.find('.panel-file-view').hide();
	hidePanelToolbar(panelId);
}

export async function closeActivePanel() {
	if (fileEditMode) {
		if (monacoEditor) {
			const content = monacoEditor.getValue();
			w2confirm({
				msg: 'Notes are being edited.<br><br>Click "Save & Close" to save and close, or "Keep Editing" to continue.',
				title: 'Unsaved Notes',
				width: 420,
				height: 200,
				btn_yes: { text: 'Save & Close', class: '', style: '' },
				btn_no: { text: 'Keep Editing', class: '', style: '' }
			}).yes(async () => {
				const filePath = panelState[1].currentPath + '\\notes.txt';
				try {
					await window.electronAPI.writeFileContent(filePath, content);
					const settings = await window.electronAPI.getSettings();
					const fileFormat = settings.file_format || 'Markdown';
					const $fileView = $(`#panel-${activePanelId} .panel-file-view`);
					const $fileContentView = $fileView.find('.file-content-view');
					const $fileEditorContainer = $fileView.find('.file-editor-container');
					const $editBtn = $fileView.find('.btn-file-edit');
					const $saveBtn = $fileView.find('.btn-file-save');
					if (fileFormat === 'Markdown') {
						const htmlContent = await window.electronAPI.renderMarkdown(content);
						$fileContentView.html(htmlContent);
					} else {
						const htmlContent = formatFileContent(content, fileFormat);
						$fileContentView.html(htmlContent);
					}
					$fileEditorContainer.hide();
					$fileContentView.show();
					$editBtn.show().text('Edit').css('background', '#2196F3');
					$saveBtn.hide();
					setFileEditMode(false);
					proceedWithPanelClose();
				} catch (err) {
					alert('Error saving notes: ' + err.message);
				}
			});
		}
		return;
	}

	if (visiblePanels === 1) {
		w2confirm({
			msg: 'Close the application?<br><br>Click "Close" to exit, or "Cancel" to keep the app open.',
			title: 'Confirm Close',
			width: 400,
			height: 180,
			btn_yes: { text: 'Close', class: '', style: '' },
			btn_no: { text: 'Cancel', class: '', style: '' }
		}).yes(async () => {
			await window.electronAPI.closeWindow();
		});
		return;
	}

	proceedWithPanelClose();
}

export async function handleCloseRequest() {
	if (fileEditMode) {
		if (monacoEditor) {
			w2confirm({
				msg: 'Notes are being edited<br><br>"Exit Anyway" to close WITHOUT saving, or<br>"Cancel" to keep the app open.',
				title: 'WARNING - Unsaved Notes',
				width: 450,
				height: 220,
				btn_yes: { text: 'Exit Anyway', class: '', style: '', onClick: null },
				btn_no: { text: 'Cancel', class: '', style: '', onClick: null }
			}).yes(async () => {
				window.electronAPI.allowClose();
			});
		}
		return;
	}
	window.electronAPI.allowClose();
}

function proceedWithPanelClose() {
	const targetPanelId = (activePanelId === 1 && visiblePanels > 1) ? visiblePanels : activePanelId;
	removePanel(targetPanelId);
}

export function attachPanelEventListeners(panelId) {
	const $panel = $(`#panel-${panelId}`);

	$panel.off('click.panelActive').on('click.panelActive', function (e) {
		const interactiveSel = 'button, input, select, textarea, label, a';
		if (!$(e.target).is(interactiveSel) && !$(e.target).closest(interactiveSel).length) {
			setActivePanelId(panelId);
		}
	});

	if (panelId === 0 || panelId > 1) {
		$panel.find('.btn-panel-select').off('click').on('click', function () {
			setActivePanelId(panelId);
			if (panel1SelectedDirectoryPath) {
				navigateToDirectory(panel1SelectedDirectoryPath, panelId);
				$panel.find('.panel-landing-page').hide();
				$panel.find('.panel-grid').show();
				const grid = panelState[panelId].w2uiGrid;
				if (grid) grid.resize();
			}
		});

		$panel.find('.btn-panel-file').off('click').on('click', async function () {
			await showFileView(panelId);
		});

		$panel.find('.btn-file-edit').off('click').on('click', async function () {
			await toggleFileEditMode(panelId);
		});

		$panel.find('.btn-file-save').off('click').on('click', async function () {
			await toggleFileEditMode(panelId);
		});

		$panel.find('.btn-file-back').off('click').on('click', function () {
			hideFileView(panelId);
		});

		$panel.find('.btn-panel-remove').off('click').on('click', function () {
			removePanel(panelId);
		});

		$panel.find('.btn-panel-remove-overlay').off('click').on('click', function () {
			removePanel(panelId);
		});

		$panel.find('.btn-terminal-close').off('click').on('click', async function () {
			removePanel(panelId);
		});

		$panel.find('.item-props-icon').off('click').on('click', async function () {
			if (!$(this).hasClass('clickable')) return;
			const openWith = panelState[panelId].currentItemOpenWith;
			if (!openWith || openWith === 'none') return;
			if (openWith === 'os-default') {
				await window.electronAPI.openInDefaultApp(selectedItemState.path);
			} else if (openWith === 'item-properties') {
				if (selectedItemState.record) await showItemPropsModal(selectedItemState.record, panelId);
			} else if (openWith === 'image-viewer') {
				openImageViewerModal(selectedItemState.path);
			} else if (openWith === 'builtin-editor') {
				showFileView(panelId, selectedItemState.path);
			}
		});

		$panel.find('.item-properties-content').off('click.sectionHeader').on('click.sectionHeader', '.item-props-section-header', function (e) {
			if ($(e.target).is('button') && !$(e.target).hasClass('btn-section-toggle')) return;
			const section = $(this).attr('data-section');
			if (!section || !panelState[panelId].sectionCollapseState) return;
			const collapsed = !panelState[panelId].sectionCollapseState[section];
			panelState[panelId].sectionCollapseState[section] = collapsed;
			const body = $(this).parent().find('.item-props-section-body');
			body.toggle(!collapsed);
			$(this).find('.btn-section-toggle').html(collapsed ? '&#9656;' : '&#9662;');
		});

		$panel.find('.item-properties-content').off('click.copyValue').on('click.copyValue', '.btn-copy-value', function (e) {
			e.stopPropagation();
			const val = decodeCopyValue($(this).attr('data-copy-value'));
			copyValueToClipboard(val, this);
		});

		$panel.find('.item-properties-content').off('mousedown.labelDismiss').on('mousedown.labelDismiss', function (event) {
			const uiState = ensureLabelsUiState(panelId);
			let shouldRerender = false;
			if (!$(event.target).closest('.item-props-tag-editor').length && uiState.isSuggestionOpen) {
				uiState.isSuggestionOpen = false;
				uiState.isInputFocused = false;
				uiState.selectedSuggestionIndex = -1;
				shouldRerender = true;
			}
			if (!$(event.target).closest('.item-props-category-picker').length && uiState.isCategoryMenuOpen) {
				uiState.isCategoryMenuOpen = false;
				shouldRerender = true;
			}
			if (shouldRerender) {
				rerenderLabelsSection(panelId);
			}
		});

		$panel.find('.item-properties-content').off('input.labelTags').on('input.labelTags', '.item-props-tag-input', async function () {
			const uiState = ensureLabelsUiState(panelId);
			uiState.inputValue = $(this).val();
			uiState.visibleSuggestionCount = INITIAL_LABEL_SUGGESTION_COUNT;
			uiState.selectedSuggestionIndex = -1;
			uiState.isInputFocused = true;
			uiState.isSuggestionOpen = true;
			uiState.isCategoryMenuOpen = false;
			await rerenderLabelsSection(panelId, { restoreFocus: true });
		});

		$panel.find('.item-properties-content').off('focus.labelTags').on('focus.labelTags', '.item-props-tag-input', async function () {
			const uiState = ensureLabelsUiState(panelId);
			const currentValue = $(this).val();
			if (
				uiState.isInputFocused &&
				uiState.isSuggestionOpen &&
				uiState.selectedSuggestionIndex === -1 &&
				uiState.inputValue === currentValue &&
				!uiState.isCategoryMenuOpen
			) {
				return;
			}
			uiState.inputValue = $(this).val();
			uiState.isInputFocused = true;
			uiState.isSuggestionOpen = true;
			uiState.isCategoryMenuOpen = false;
			uiState.selectedSuggestionIndex = -1;
			await rerenderLabelsSection(panelId, { restoreFocus: true });
		});

		$panel.find('.item-properties-content').off('blur.labelTags').on('blur.labelTags', '.item-props-tag-input', function () {
			setTimeout(() => {
				const uiState = ensureLabelsUiState(panelId);
				const editorHasFocus = $panel.find('.item-props-tag-editor').find(document.activeElement).length > 0;
				if (!editorHasFocus) {
					uiState.isInputFocused = false;
					uiState.isSuggestionOpen = false;
					uiState.selectedSuggestionIndex = -1;
					rerenderLabelsSection(panelId);
				}
			}, 0);
		});

		$panel.find('.item-properties-content').off('keydown.labelTags').on('keydown.labelTags', '.item-props-tag-input', async function (event) {
			const uiState = ensureLabelsUiState(panelId);
			const assignedTagNames = Array.isArray(panelState[panelId].currentItemStats?.tags)
				? panelState[panelId].currentItemStats.tags
				: [];
			const suggestions = getTagSuggestions(uiState, assignedTagNames);

			if (event.key === 'ArrowDown') {
				event.preventDefault();
				uiState.isSuggestionOpen = true;
				uiState.selectedSuggestionIndex = Math.min(uiState.selectedSuggestionIndex + 1, suggestions.length - 1);
				await rerenderLabelsSection(panelId, { restoreFocus: true });
				return;
			}

			if (event.key === 'ArrowUp') {
				event.preventDefault();
				uiState.selectedSuggestionIndex = Math.max(uiState.selectedSuggestionIndex - 1, -1);
				uiState.isSuggestionOpen = true;
				await rerenderLabelsSection(panelId, { restoreFocus: true });
				return;
			}

			if (event.key === 'Enter') {
				event.preventDefault();
				try {
					if (uiState.selectedSuggestionIndex >= 0) {
						await activateTagSuggestion(panelId, uiState.selectedSuggestionIndex);
						return;
					}
					await runPrimaryTagAction(panelId);
				} catch (err) {
					w2alert('Error updating tags: ' + err.message);
				}
				return;
			}

			if (event.key === 'Escape') {
				event.preventDefault();
				uiState.isSuggestionOpen = false;
				uiState.selectedSuggestionIndex = -1;
				await rerenderLabelsSection(panelId, { restoreFocus: true });
			}
		});

		$panel.find('.item-properties-content').off('mousedown.labelTagAction').on('mousedown.labelTagAction', '.btn-item-props-tag-action', async function (event) {
			event.preventDefault();
			try {
				await runPrimaryTagAction(panelId);
			} catch (err) {
				w2alert('Error updating tags: ' + err.message);
			}
		});

		$panel.find('.item-properties-content').off('mousedown.labelSuggestion').on('mousedown.labelSuggestion', '.item-props-tag-suggestion', async function (event) {
			event.preventDefault();
			const index = Number($(this).attr('data-index'));
			if (Number.isNaN(index)) return;
			try {
				await activateTagSuggestion(panelId, index);
			} catch (err) {
				w2alert('Error updating tags: ' + err.message);
			}
		});

		$panel.find('.item-properties-content').off('click.removeTag').on('click.removeTag', '.btn-item-props-remove-tag', async function (event) {
			event.preventDefault();
			event.stopPropagation();
			const tagName = decodeURIComponent($(this).attr('data-tag-name') || '');
			if (!tagName) return;
			try {
				await removeTagFromCurrentItem(panelId, tagName);
			} catch (err) {
				w2alert('Error removing tag: ' + err.message);
			}
		});

		$panel.find('.item-properties-content').off('mousedown.categoryToggle').on('mousedown.categoryToggle', '.item-props-category-trigger', async function (event) {
			event.preventDefault();
			const uiState = ensureLabelsUiState(panelId);
			uiState.isCategoryMenuOpen = !uiState.isCategoryMenuOpen;
			uiState.isSuggestionOpen = false;
			uiState.selectedSuggestionIndex = -1;
			await rerenderLabelsSection(panelId);
		});

		$panel.find('.item-properties-content').off('mousedown.categoryOption').on('mousedown.categoryOption', '.item-props-category-option', async function (event) {
			event.preventDefault();
			const categoryName = decodeURIComponent($(this).attr('data-category-name') || '');
			if (!categoryName) return;
			try {
				await assignCategoryFromLabels(panelId, categoryName, true);
			} catch (err) {
				w2alert('Error assigning category: ' + err.message);
			}
		});

		$panel.find('.item-properties-content').off('change.categoryForce').on('change.categoryForce', '.item-props-category-force-toggle', async function () {
			const shouldForce = $(this).is(':checked');
			try {
				if (shouldForce) {
					const currentCategoryName = panelState[panelId].currentItemStats?.categoryName || 'Default';
					await assignCategoryFromLabels(panelId, currentCategoryName, true);
				} else {
					await clearForcedCategoryFromLabels(panelId);
				}
			} catch (err) {
				w2alert('Error updating category force: ' + err.message);
			}
		});

		// --- Initials handlers ---
		let initialsDebounceTimer = null;
		$panel.find('.item-properties-content').off('input.initialsInput').on('input.initialsInput', '.item-props-initials-input', function () {
			this.value = this.value.toUpperCase().slice(0, 2);
			const val = this.value;
			clearTimeout(initialsDebounceTimer);
			initialsDebounceTimer = setTimeout(async () => {
				if (!selectedItemState.isDirectory || !selectedItemState.path) return;
				try {
					await window.electronAPI.saveDirectoryLabels(selectedItemState.path, { initials: val || null, initialsForce: val ? 1 : 0 });
					await rerenderLabelsSection(panelId);
					await maybeRefreshPanel1TitleAndIcon();
				} catch (err) {
					w2alert('Error saving initials: ' + err.message);
				}
			}, 400);
		});

		$panel.find('.item-properties-content').off('change.initialsInherit').on('change.initialsInherit', '.item-props-initials-inherit-toggle', async function () {
			if (!selectedItemState.isDirectory || !selectedItemState.path) return;
			try {
				await window.electronAPI.saveDirectoryLabels(selectedItemState.path, { initialsInherit: $(this).is(':checked') ? 1 : 0 });
				await rerenderLabelsSection(panelId);
				await maybeRefreshPanel1TitleAndIcon();
			} catch (err) {
				w2alert('Error saving initials inherit: ' + err.message);
			}
		});

		$panel.find('.item-properties-content').off('change.initialsForce').on('change.initialsForce', '.item-props-initials-force-toggle', async function () {
			if (!selectedItemState.isDirectory || !selectedItemState.path) return;
			const isForced = $(this).is(':checked');
			try {
				if (!isForced) {
					// Unchecking force: clear the stored initials + force flag so inherited value takes over
					await window.electronAPI.saveDirectoryLabels(selectedItemState.path, { initials: null, initialsForce: 0 });
				} else {
					await window.electronAPI.saveDirectoryLabels(selectedItemState.path, { initialsForce: 1 });
				}
				await rerenderLabelsSection(panelId);
				await maybeRefreshPanel1TitleAndIcon();
			} catch (err) {
				w2alert('Error updating initials force: ' + err.message);
			}
		});

		// --- Display Name handlers ---
		let displayNameDebounceTimer = null;
		$panel.find('.item-properties-content').off('input.displayNameInput').on('input.displayNameInput', '.item-props-display-name-input', function () {
			const val = this.value;
			clearTimeout(displayNameDebounceTimer);
			displayNameDebounceTimer = setTimeout(async () => {
				if (!selectedItemState.isDirectory || !selectedItemState.path) return;
				try {
					await window.electronAPI.saveDirectoryLabels(selectedItemState.path, { displayName: val || null, displayNameForce: val ? 1 : 0 });
					await rerenderLabelsSection(panelId);
					await maybeRefreshPanel1TitleAndIcon();
				} catch (err) {
					w2alert('Error saving display name: ' + err.message);
				}
			}, 400);
		});

		$panel.find('.item-properties-content').off('change.displayNameInherit').on('change.displayNameInherit', '.item-props-display-name-inherit-toggle', async function () {
			if (!selectedItemState.isDirectory || !selectedItemState.path) return;
			try {
				await window.electronAPI.saveDirectoryLabels(selectedItemState.path, { displayNameInherit: $(this).is(':checked') ? 1 : 0 });
				await rerenderLabelsSection(panelId);
				await maybeRefreshPanel1TitleAndIcon();
			} catch (err) {
				w2alert('Error saving display name inherit: ' + err.message);
			}
		});

		$panel.find('.item-properties-content').off('change.displayNameForce').on('change.displayNameForce', '.item-props-display-name-force-toggle', async function () {
			if (!selectedItemState.isDirectory || !selectedItemState.path) return;
			const isForced = $(this).is(':checked');
			try {
				if (!isForced) {
					await window.electronAPI.saveDirectoryLabels(selectedItemState.path, { displayName: null, displayNameForce: 0 });
				} else {
					await window.electronAPI.saveDirectoryLabels(selectedItemState.path, { displayNameForce: 1 });
				}
				await rerenderLabelsSection(panelId);
				await maybeRefreshPanel1TitleAndIcon();
			} catch (err) {
				w2alert('Error updating display name force: ' + err.message);
			}
		});

		$panel.find('.btn-attrs-edit').off('click').on('click', function () {
			panelState[panelId].attrEditMode = true;
			updateItemPropertiesPage(panelId);
		});

		$panel.find('.btn-attrs-cancel').off('click').on('click', function () {
			panelState[panelId].attrEditMode = false;
			updateItemPropertiesPage(panelId);
		});

		$panel.find('.btn-attrs-save').off('click').on('click', async function () {
			const inode = panelState[panelId].itemInode || selectedItemState.inode;
			const dirId = panelState[panelId].itemDirId || selectedItemState.dir_id;
			if (!inode || !dirId) {
				w2alert('Cannot save: item is not yet indexed. Please scan the directory first.');
				return;
			}
			const attrs = {};
			$panel.find('.item-props-attributes .attr-row').each(function () {
				const name = $(this).data('attr-name');
				const type = ($(this).data('attr-type') || '').toLowerCase();
				if (!name) return;
				if (type === 'yes-no') {
					attrs[name] = $(this).find('select').val();
				} else if (type === 'rating') {
					attrs[name] = $(this).find('.rating-value').val();
				} else {
					attrs[name] = $(this).find('input, select').val();
				}
			});
			try {
				await window.electronAPI.setFileAttributes(inode, dirId, attrs);
				panelState[panelId].attrEditMode = false;
				updateItemPropertiesPage(panelId);
			} catch (err) {
				w2alert('Error saving attributes: ' + err.message);
			}
		});

		$panel.find('.btn-notes-edit-item').off('click').on('click', async function () {
			const notesFilePath = panelState[panelId].notesFilePath;
			const notesSectionKey = panelState[panelId].notesSectionKey;
			if (!notesFilePath) return;

			let rawFile = '';
			try { rawFile = await window.electronAPI.readFileContent(notesFilePath) || ''; } catch (_) { }
			const sections = await window.electronAPI.invoke('parse-notes-file', rawFile);
			const sectionContent = sections[notesSectionKey] || '';

			panelState[panelId].notesEditMode = true;
			const $notesSection = $panel.find('.item-props-notes-section');
			$notesSection.find('.btn-notes-edit-item').hide();
			$notesSection.find('.btn-notes-save-item').show();
			$notesSection.find('.btn-notes-cancel-item').show();
			$panel.find('.item-props-notes').hide();
			const $editorContainer = $panel.find('.item-props-notes-editor').show();

			if (!panelState[panelId].notesMonacoEditor) {
				panelState[panelId].notesMonacoEditor = monaco.editor.create($editorContainer[0], {
					value: sectionContent,
					language: 'markdown',
					theme: 'vs',
					wordWrap: 'on',
					lineNumbers: 'off',
					minimap: { enabled: false },
					scrollBeyondLastLine: false,
					automaticLayout: true,
					fontSize: 12,
					fontFamily: 'Consolas, "Courier New", monospace'
				});
			} else {
				panelState[panelId].notesMonacoEditor.setValue(sectionContent);
				panelState[panelId].notesMonacoEditor.layout();
			}
			panelState[panelId].notesMonacoEditor.focus();
		});

		$panel.find('.btn-notes-save-item').off('click').on('click', async function () {
			const notesFilePath = panelState[panelId].notesFilePath;
			const notesSectionKey = panelState[panelId].notesSectionKey;
			if (!notesFilePath) return;
			const editor = panelState[panelId].notesMonacoEditor;
			const sectionContent = editor ? editor.getValue() : '';
			try {
				let existingContent = '';
				try { existingContent = await window.electronAPI.readFileContent(notesFilePath) || ''; } catch (_) { }
				const newFullContent = await window.electronAPI.invoke('write-notes-section', {
					existingContent,
					sectionKey: notesSectionKey,
					newContent: sectionContent
				});
				await window.electronAPI.writeFileContent(notesFilePath, newFullContent);
			} catch (err) {
				w2alert('Error saving notes: ' + err.message);
				return;
			}
			panelState[panelId].notesEditMode = false;
			updateItemPropertiesPage(panelId);
		});

		$panel.find('.btn-notes-cancel-item').off('click').on('click', function () {
			panelState[panelId].notesEditMode = false;
			const $notesSection = $panel.find('.item-props-notes-section');
			$notesSection.find('.btn-notes-edit-item').show();
			$notesSection.find('.btn-notes-save-item').hide();
			$notesSection.find('.btn-notes-cancel-item').hide();
			$panel.find('.item-props-notes-editor').hide();
			$panel.find('.item-props-notes').show();
		});

		$panel.find('.item-properties-content').off('click.openHistoryModal').on('click.openHistoryModal', '.btn-open-history-modal', async function (e) {
			e.stopPropagation();
			const record = selectedItemState.record;
			if (!record) return;
			if (panelId === 0) {
				hideItemPropsModal();
			}
			try {
				await openHistoryModal(record);
			} catch (err) {
				w2alert('Error opening history: ' + err.message);
			}
		});

	}
}

export function applyRecordHeightToAllGrids(recordHeight) {
	for (let panelId = 1; panelId <= 4; panelId++) {
		const grid = panelState[panelId].w2uiGrid;
		if (grid) {
			grid.recordHeight = recordHeight;
			if (typeof grid.refresh === 'function') {
				grid.refresh();
			}
			const currentPath = panelState[panelId].currentPath;
			if (currentPath) {
				updatePanelHeader(panelId, currentPath);
			}
		}
	}
}

export async function getRecordHeight() {
	const settings = await window.electronAPI.getSettings();
	return settings.record_height || 30;
}

export async function updateItemPropertiesPage(panelId) {
	const $panel = $(`#panel-${panelId}`);
	const $placeholder = $panel.find('.item-properties-placeholder');
	const $content = $panel.find('.item-properties-content');

	if (!selectedItemState.path) {
		panelState[panelId].currentItemStats = null;
		$content.hide();
		$placeholder.show();
		getPanelHeaderElement(panelId)?.classList.remove('active');
		return;
	}

	try {
		const stats = await window.electronAPI.getItemStats(selectedItemState.path);
		if (!stats || !stats.success) {
			panelState[panelId].currentItemStats = null;
			$content.hide();
			$placeholder.show();
			getPanelHeaderElement(panelId)?.classList.remove('active');
			return;
		}

		// Show panel header with item's full path, styled with parent directory's category
		if (panelId !== 0) {
			const parentDir = selectedItemState.path.includes('\\')
				? selectedItemState.path.substring(0, selectedItemState.path.lastIndexOf('\\'))
				: selectedItemState.path;
			const parentCategory = await window.electronAPI.getCategoryForDirectory(parentDir);
			panelState[panelId].currentCategory = parentCategory;
			updatePanelHeader(panelId, selectedItemState.path);
		}

		panelState[panelId].itemInode = stats.inode;
		panelState[panelId].itemDirId = stats.dir_id;
		panelState[panelId].currentItemStats = stats;

		if (!panelState[panelId].sectionCollapseState) {
			panelState[panelId].sectionCollapseState = {
				preview: false, information: false, exif: false, attributes: false, notes: false, history: false
			};
		}

		function applyCollapseState(section, $sectionEl) {
			const collapsed = panelState[panelId].sectionCollapseState[section];
			$sectionEl.find('.item-props-section-body').toggle(!collapsed);
			$sectionEl.find(`.btn-section-toggle[data-section="${section}"]`).html(collapsed ? '&#9656;' : '&#9662;');
		}

		const openWith = stats.openWith || null;
		panelState[panelId].currentItemOpenWith = openWith;

		const iconHtml = stats.isDirectory
			? `<img src="assets/icons/folder.png" style="width:24px;height:24px;object-fit:contain;" onerror="this.src='assets/icons/user-file.png'">`
			: `<img src="assets/icons/${stats.ftIcon || 'user-file.png'}" style="width:24px;height:24px;object-fit:contain;">`;
		const $icon = $panel.find('.item-props-icon').html(iconHtml);
		if (!stats.isDirectory && openWith && openWith !== 'none') {
			$icon.addClass('clickable');
		} else {
			$icon.removeClass('clickable');
		}
		$panel.find('.item-props-filename').text(stats.filename || selectedItemState.filename || '');
		await renderLabelsSection(panelId, stats);

		const $previewSection = $panel.find('.item-props-preview-section');
		if (!stats.isDirectory && stats.fileType === 'Image') {
			const imgPath = stats.path.replace(/\\/g, '/');
			$panel.find('.item-preview-img').attr('src', `file:///${imgPath}`).show();
			$panel.find('.item-preview-unavailable').hide();
		} else {
			$panel.find('.item-preview-img').hide();
			$panel.find('.item-preview-unavailable').show();
		}
		$previewSection.css('display', 'flex');
		applyCollapseState('preview', $previewSection);

		const $infoSection = $panel.find('.item-props-information-section');
		$infoSection.css('display', 'flex');
		applyCollapseState('information', $infoSection);

		// EXIF section — dynamically injected for Image files, removed otherwise
		$panel.find('.item-props-exif-section').remove();
		if (!stats.isDirectory && stats.fileType === 'Image') {
			const $exifSection = $(`
				<div class="item-props-exif-section" style="display: flex; flex-direction: column; gap: 0;">
					<div class="item-props-section-header" data-section="exif" style="display: flex; align-items: center; gap: 6px; border-top: 1px solid #eee; padding-top: 8px; cursor: pointer;">
						<button class="btn-section-toggle" data-section="exif">&#9662;</button>
						<span style="font-weight: bold; font-size: 12px; color: #444; flex: 1;">Image Metadata</span>
					</div>
					<div class="item-props-section-body item-props-exif-body" style="padding-top: 6px;">
						<div class="item-props-exif-rows" style="display: flex; flex-direction: column; gap: 5px; font-size: 12px;">
							<span style="color: #aaa; font-size: 12px; font-style: italic;">Loading…</span>
						</div>
					</div>
				</div>
			`);
			$infoSection.after($exifSection);
			applyCollapseState('exif', $exifSection);

			// Async populate — fires after the synchronous render completes
			window.electronAPI.getExifData(stats.path).then(result => {
				const $rows = $exifSection.find('.item-props-exif-rows').empty();
				if (!result || !result.success || !result.exif) {
					$rows.append('<span style="color: #aaa; font-size: 12px; font-style: italic;">No EXIF data available</span>');
					return;
				}
				const exif = result.exif;
				const EXIF_LABELS = {
					width:            'Width',
					height:           'Height',
					format:           'Format',
					colorSpace:       'Color Space',
					channels:         'Channels',
					density:          'Density',
					hasIccProfile:    'ICC Profile',
					orientation:      'Orientation',
					make:             'Camera Make',
					model:            'Camera Model',
					software:         'Software',
					artist:           'Artist',
					copyright:        'Copyright',
					dateTime:         'Date/Time',
					dateTimeOriginal: 'Date Taken',
					exposureTime:     'Exposure',
					fNumber:          'F-Number',
					iso:              'ISO',
					focalLength:      'Focal Length',
					flash:            'Flash',
					exposureProgram:  'Exposure Program',
					whiteBalance:     'White Balance',
					gpsLatitude:      'GPS Latitude',
					gpsLongitude:     'GPS Longitude',
					gpsLatRef:        'GPS Lat Ref',
					gpsLonRef:        'GPS Lon Ref',
					gpsAltitude:      'GPS Altitude',
				};
				for (const [key, label] of Object.entries(EXIF_LABELS)) {
					if (exif[key] === undefined || exif[key] === null) continue;
					const safeValue = utils.escapeHtml(String(exif[key]));
					$rows.append(`<div class="stat-row"><span class="stat-label">${label}</span><span class="stat-value stat-value-wrap">${safeValue}</span></div>`);
				}
				if ($rows.children().length === 0) {
					$rows.append('<span style="color: #aaa; font-size: 12px; font-style: italic;">No EXIF data available</span>');
				}
			}).catch(() => {
				$exifSection.find('.item-props-exif-rows').html('<span style="color: #aaa; font-size: 12px; font-style: italic;">Could not read metadata</span>');
			});
		}

		const $stats = $panel.find('.item-props-stats').empty();
		function statRow(label, value, extraHtml) {
			const safeLabel = utils.escapeHtml(String(label || ''));
			const safeValue = utils.escapeHtml(String(value || ''));
			return `<div class="stat-row"><span class="stat-label">${safeLabel}</span><span class="stat-value stat-value-wrap">${safeValue}${extraHtml || ''}</span></div>`;
		}
		function copyBtn(value) {
			return renderCopyValueButton(value, ' item-props-copy-btn');
		}

		const filenameVal = stats.filename || '';
		$stats.append(statRow('Name', filenameVal, copyBtn(filenameVal)));
		const fullPath = stats.path || '';
		$stats.append(statRow('Full Path', fullPath, copyBtn(fullPath)));
		$stats.append(statRow('Type', stats.isDirectory ? 'Folder' : (stats.fileType || 'File')));
		if (!stats.isDirectory) {
			$stats.append(statRow('Size', utils.formatBytes(stats.size || 0)));
		}
		$stats.append(statRow('Date Modified', stats.dateModified ? new Date(stats.dateModified).toLocaleString() : '-'));
		$stats.append(statRow('Date Created', stats.dateCreated ? new Date(stats.dateCreated).toLocaleString() : '-'));
		if (!stats.isDirectory) {
			const checksumDisplay = stats.checksumValue
				? `<span class="stat-value" title="${stats.checksumValue}">${stats.checksumValue.substring(0, 16)}…</span>`
				: '<span style="color:#999;">Not calculated</span>';
			const calcBtn = `<button class="btn-checksum-calc" data-panel="${panelId}">Calculate Now</button>`;
			$stats.append(`<div class="stat-row"><span class="stat-label">Checksum</span>${checksumDisplay}${calcBtn}</div>`);
		}

		const $attrSection = $panel.find('.item-props-attributes-section');
		if (stats.categoryAttributes && stats.categoryAttributes.length > 0) {
			$attrSection.css('display', 'flex');
			applyCollapseState('attributes', $attrSection);
			const $attrContainer = $panel.find('.item-props-attributes').empty();
			const currentAttrs = stats.attributes || {};
			const editMode = panelState[panelId].attrEditMode || false;

			$attrSection.find('.btn-attrs-edit').toggle(!editMode);
			$attrSection.find('.btn-attrs-save').toggle(editMode);
			$attrSection.find('.btn-attrs-cancel').toggle(editMode);

			stats.categoryAttributes.forEach(attr => {
				const val = currentAttrs[attr.name] !== undefined ? currentAttrs[attr.name] : (attr.default || '');
				const type = (attr.type || '').toLowerCase();
				let controlHtml;
				if (editMode) {
					if (type === 'yes-no') {
						const yesSelected = (val === true || val === 'true' || val === 'Yes') ? 'selected' : '';
						const noSelected = (val === false || val === 'false' || val === 'No') ? 'selected' : '';
						controlHtml = `<select><option value="">--</option><option value="Yes" ${yesSelected}>Yes</option><option value="No" ${noSelected}>No</option></select>`;
					} else if (type === 'selectable' && attr.options && attr.options.length > 0) {
						const opts = attr.options.map(option => `<option value="${option}" ${String(val) === String(option) ? 'selected' : ''}>${option}</option>`).join('');
						controlHtml = `<select><option value="">--</option>${opts}</select>`;
					} else if (type === 'rating') {
						controlHtml = renderStarsHtml(val, true);
					} else if (type === 'numeric') {
						controlHtml = `<input type="number" value="${val}">`;
					} else {
						controlHtml = `<input type="text" value="${String(val)}">`;
					}
				} else {
					if (type === 'rating') {
						const copyHtml = attr.copyable ? renderCopyValueButton(formatCustomAttributeValue(val, attr.type), ' item-props-copy-btn') : '';
						controlHtml = `<div class="attr-value-with-copy">${renderStarsHtml(val, false)}${copyHtml}</div>`;
					} else {
						const displayValue = formatCustomAttributeValue(val, attr.type);
						const safeDisplayValue = utils.escapeHtml(displayValue);
						const copyHtml = attr.copyable ? renderCopyValueButton(displayValue, ' item-props-copy-btn') : '';
						controlHtml = `<div class="attr-value-with-copy"><span>${safeDisplayValue}</span>${copyHtml}</div>`;
					}
				}
				const $row = $(`<div class="attr-row" data-attr-name="${attr.name}" data-attr-type="${attr.type}"><label>${attr.name}</label>${controlHtml}</div>`);
				$attrContainer.append($row);
			});

			// Star rating interaction for edit mode
			if (editMode) {
				$attrContainer.off('click.rating mouseenter.rating mouseleave.rating');
				$attrContainer.on('click.rating', '.rating-picker .star', function () {
					const $picker = $(this).closest('.rating-picker');
					const $hidden = $picker.find('.rating-value');
					const clicked = parseInt($(this).data('value'), 10);
					const current = parseInt($hidden.val(), 10) || 0;
					const newVal = clicked === current ? 0 : clicked;
					$hidden.val(newVal);
					$picker.find('.star').each(function (i) {
						const filled = i < newVal;
						$(this).toggleClass('filled', filled).text(filled ? '★' : '☆');
					});
				});
				$attrContainer.on('mouseenter.rating', '.rating-picker .star', function () {
					const $picker = $(this).closest('.rating-picker');
					const hoverVal = parseInt($(this).data('value'), 10);
					$picker.find('.star').each(function (i) {
						$(this).toggleClass('hover', i < hoverVal);
					});
				});
				$attrContainer.on('mouseleave.rating', '.rating-picker', function () {
					$(this).find('.star').removeClass('hover');
				});
			}
		} else {
			$attrSection.hide();
		}

		const notesSep = stats.path.includes('\\') ? '\\' : '/';
		let notesFilePath;
		let notesSectionKey;
		if (stats.isDirectory) {
			notesFilePath = stats.path + notesSep + 'notes.txt';
			notesSectionKey = '__dir__';
		} else {
			const lastSep = stats.path.lastIndexOf(notesSep);
			notesFilePath = stats.path.substring(0, lastSep) + notesSep + 'notes.txt';
			notesSectionKey = stats.filename;
		}
		panelState[panelId].notesFilePath = notesFilePath;
		panelState[panelId].notesSectionKey = notesSectionKey;
		const notesEditMode = panelState[panelId].notesEditMode || false;
		const $notesSection = $panel.find('.item-props-notes-section');
		$notesSection.css('display', 'flex');
		applyCollapseState('notes', $notesSection);
		$notesSection.find('.btn-notes-edit-item').toggle(!notesEditMode);
		$notesSection.find('.btn-notes-save-item').toggle(notesEditMode);
		$notesSection.find('.btn-notes-cancel-item').toggle(notesEditMode);
		$panel.find('.item-props-notes').toggle(!notesEditMode);
		$panel.find('.item-props-notes-editor').toggle(notesEditMode);

		if (!notesEditMode) {
			const $notes = $panel.find('.item-props-notes').empty();
			try {
				const rawFile = await window.electronAPI.readFileContent(notesFilePath);
				const sections = await window.electronAPI.invoke('parse-notes-file', rawFile || '');
				const sectionContent = sections[notesSectionKey] || '';
				if (sectionContent.trim()) {
					const settings = await window.electronAPI.getSettings();
					const fmt = settings.file_format || 'Markdown';
					if (fmt === 'Markdown') {
						const htmlContent = await window.electronAPI.renderMarkdown(sectionContent);
						$notes.html(htmlContent);
					} else if (fmt === 'HTML') {
						$notes.html(sectionContent);
					} else {
						$notes.text(sectionContent);
					}
				} else {
					$notes.html('<span style="color:#bbb;font-size:12px;">No notes</span>');
				}
			} catch (_) {
				$notes.html('<span style="color:#bbb;font-size:12px;">No notes</span>');
			}
		} else if (panelState[panelId].notesMonacoEditor) {
			panelState[panelId].notesMonacoEditor.layout();
		}

		const $historySection = $panel.find('.item-props-history-section');
		$historySection.css('display', 'flex');
		applyCollapseState('history', $historySection);
		const $historyTable = $panel.find('.item-props-history-table').empty();
		try {
			const historyResult = await window.electronAPI.getItemHistory({
				isDirectory: !!stats.isDirectory,
				inode: stats.inode,
				dirId: stats.dir_id || null
			});
			if (historyResult && historyResult.success && historyResult.data && historyResult.data.length > 0) {
				const completeState = buildCompleteFileState(historyResult.data, selectedItemState.record);
				const historyRows = formatHistoryData(historyResult.data, completeState);
				if (historyRows.length > 0) {
					let tableHtml = '<table class="history-table"><thead><tr><th>Detected At</th><th>Change</th><th>Path</th></tr></thead><tbody>';
					historyRows.forEach(row => {
						tableHtml += `<tr><td>${row.detectedAt || ''}</td><td>${row.changeValue || ''}</td><td>${row.path || ''}</td></tr>`;
					});
					tableHtml += '</tbody></table>';
					$historyTable.html(tableHtml);
				} else {
					$historyTable.html('<span style="color:#bbb;font-size:12px;">No history</span>');
				}
			} else {
				$historyTable.html('<span style="color:#bbb;font-size:12px;">No history</span>');
			}
		} catch (_) {
			$historyTable.html('<span style="color:#bbb;font-size:12px;">No history</span>');
		}

		$panel.find('.btn-checksum-calc').off('click').on('click', async function () {
			if (!selectedItemState.path || !selectedItemState.inode || !selectedItemState.dir_id) return;
			$(this).prop('disabled', true).text('Calculating…');
			try {
				await window.electronAPI.calculateFileChecksum(selectedItemState.path, selectedItemState.inode, selectedItemState.dir_id);
				updateItemPropertiesPage(panelId);
			} catch (err) {
				console.error('Checksum error:', err);
				$(this).prop('disabled', false).text('Calculate Now');
			}
		});

		$placeholder.hide();
		$content.css('display', 'flex').show();
	} catch (err) {
		console.error('Error updating item properties:', err);
		panelState[panelId].currentItemStats = null;
		$content.hide();
		$placeholder.show();
		getPanelHeaderElement(panelId)?.classList.remove('active');
	}
}

export function gridNavigate(direction, isShift, targetPanelId) {
	const panelId = targetPanelId !== undefined ? targetPanelId : gridFocusedPanelId;
	if (panelId === null || panelId === undefined) return;
	gridFocusedPanelId = panelId;
	const grid = panelState[panelId].w2uiGrid;
	if (!grid || !grid.records || grid.records.length === 0) return;

	// Use grid.records (full list in display order) rather than DOM tr[recid] queries.
	// DOM queries only cover visible rows when virtual scrolling is active, causing the
	// selected recid to drop out of the list when it scrolls off-screen — making indexOf
	// return -1 and newIndex snap back to 0 (the wrap-around bug).
	const allRecids = grid.records.map(r => r.recid);
	if (allRecids.length === 0) return;

	const selected = grid.getSelection();

	if (!isShift) {
		let currentIndex = -1;
		if (selected.length > 0) {
			currentIndex = allRecids.indexOf(selected[selected.length - 1]);
		}
		let newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
		newIndex = Math.max(0, Math.min(allRecids.length - 1, newIndex));
		const newRecid = allRecids[newIndex];
		grid.selectNone();
		grid.select(newRecid);
		if (typeof grid.scrollIntoView === 'function') grid.scrollIntoView(newRecid);
		selectionAnchorRecids[panelId] = newRecid;

		const record = grid.records.find(r => r.recid === newRecid);
		if (record && getPanelViewType(panelId) !== 'properties') {
			updateSelectedItemFromRecord(record, panelId);
		}
	} else {
		let anchorIndex = selectionAnchorRecids[panelId] !== undefined && selectionAnchorRecids[panelId] !== null
			? allRecids.indexOf(selectionAnchorRecids[panelId])
			: -1;
		if (anchorIndex === -1) {
			anchorIndex = selected.length > 0 ? allRecids.indexOf(selected[0]) : 0;
			if (anchorIndex === -1) anchorIndex = 0;
			selectionAnchorRecids[panelId] = allRecids[anchorIndex];
		}

		const selectedIndices = selected.map(r => allRecids.indexOf(r)).filter(i => i !== -1);
		let cursorIndex = anchorIndex;
		if (selectedIndices.length > 0) {
			const minIdx = Math.min(...selectedIndices);
			const maxIdx = Math.max(...selectedIndices);
			cursorIndex = anchorIndex === minIdx ? maxIdx : minIdx;
		}

		let newCursorIndex = direction === 'up' ? cursorIndex - 1 : cursorIndex + 1;
		newCursorIndex = Math.max(0, Math.min(allRecids.length - 1, newCursorIndex));

		const startIdx = Math.min(anchorIndex, newCursorIndex);
		const endIdx = Math.max(anchorIndex, newCursorIndex);
		grid.selectNone();
		for (let i = startIdx; i <= endIdx; i++) {
			grid.select(allRecids[i]);
		}
		if (typeof grid.scrollIntoView === 'function') grid.scrollIntoView(allRecids[newCursorIndex]);
	}
}

export function galleryNavigate(direction, panelId) {
	const targetPanelId = panelId !== undefined ? panelId : gridFocusedPanelId;
	if (targetPanelId === null || targetPanelId === undefined) return;
	gridFocusedPanelId = targetPanelId;

	const state = panelState[targetPanelId];
	if (!state) return;

	const $gallery = $(`#panel-${targetPanelId} .panel-gallery`);
	const items = $gallery.find('.gallery-item').toArray();
	if (!items.length) return;

	const selectedRecid = state.gallerySelectedRecids && state.gallerySelectedRecids.size > 0
		? [...state.gallerySelectedRecids][0]
		: null;
	const currentIdx = selectedRecid !== null
		? items.findIndex(el => parseInt(el.dataset.recid, 10) === selectedRecid)
		: -1;

	let newIdx;

	if (currentIdx === -1) {
		// Nothing selected — select the first item regardless of direction
		newIdx = 0;
	} else if (direction === 'left') {
		if (currentIdx === 0) return;
		newIdx = currentIdx - 1;
	} else if (direction === 'right') {
		if (currentIdx === items.length - 1) return;
		newIdx = currentIdx + 1;
	} else {
		// up / down: use rendered positions to find the nearest item in the adjacent row
		const currentEl = items[currentIdx];
		const curTop = currentEl.offsetTop;
		const curCenterX = currentEl.getBoundingClientRect().left + currentEl.getBoundingClientRect().width / 2;

		const candidates = items.filter(el =>
			direction === 'up' ? el.offsetTop < curTop : el.offsetTop > curTop
		);
		if (!candidates.length) return; // already on first or last row

		const targetRowTop = direction === 'up'
			? Math.max(...candidates.map(el => el.offsetTop))
			: Math.min(...candidates.map(el => el.offsetTop));

		const rowItems = candidates.filter(el => el.offsetTop === targetRowTop);
		const bestEl = rowItems.reduce((best, el) => {
			const elCenterX = el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2;
			const bestCenterX = best.getBoundingClientRect().left + best.getBoundingClientRect().width / 2;
			return Math.abs(elCenterX - curCenterX) < Math.abs(bestCenterX - curCenterX) ? el : best;
		});
		newIdx = items.indexOf(bestEl);
	}

	if (newIdx === currentIdx) return;

	const newEl = items[newIdx];
	const newRecid = parseInt(newEl.dataset.recid, 10);
	state.gallerySelectedRecids = new Set([newRecid]);

	$gallery.find('.gallery-item').removeClass('gallery-item-selected');
	$(newEl).addClass('gallery-item-selected');
	newEl.scrollIntoView({ block: 'nearest' });

	const record = (state.galleryRecords || []).find(r => r.recid === newRecid);
	if (record && getPanelViewType(targetPanelId) !== 'properties') {
		updateSelectedItemFromRecord(record, targetPanelId);
	}
}

export async function openSelectedItem(panelId) {
	const grid = panelState[panelId].w2uiGrid;
	if (!grid) return;
	const selected = grid.getSelection();
	if (selected.length === 0) return;
	const recid = selected[0];
	const record = grid.records.find(r => r.recid === recid);
	if (!record) return;

	if (record.isFolder) {
		if (visiblePanels >= 4) {
			// All panels in use — navigate in current panel
			navigateToDirectory(record.path, panelId);
			return;
		}
		visiblePanels++;
		const newPanelId = visiblePanels;
		$(`#panel-${newPanelId}`).show();
		attachPanelEventListeners(newPanelId);
		updatePanelLayout();
		await initializeGridForPanel(newPanelId);
		$(`#panel-${newPanelId} .panel-landing-page`).hide();
		$(`#panel-${newPanelId} .panel-grid`).show();
		await navigateToDirectory(record.path, newPanelId);
		const newGrid = panelState[newPanelId].w2uiGrid;
		if (newGrid && newGrid.resize) newGrid.resize();
		return;
	}

	let hasPropertiesPanel = false;
	for (let i = 2; i <= visiblePanels; i++) {
		if (getPanelViewType(i) === 'properties') {
			hasPropertiesPanel = true;
			break;
		}
	}
	if (!hasPropertiesPanel && visiblePanels < 4) {
		visiblePanels++;
		const newPanelId = visiblePanels;
		$(`#panel-${newPanelId}`).show();
		attachPanelEventListeners(newPanelId);
		updatePanelLayout();
		setTimeout(() => updateItemPropertiesPage(newPanelId), 150);
	}
}

/**
 * Shows the Item Properties modal for a file record.
 * Displays buttons to open the properties in panel 2 through min(visiblePanels+1, 4).
 */
export async function showItemPropsModal(record, sourcePanelId) {
	Object.assign(selectedItemState, {
		path: record.path,
		filename: record.filenameRaw || record.filename,
		isDirectory: false,
		inode: record.inode,
		dir_id: record.dir_id,
		record: record,
		panelId: sourcePanelId
	});
	panelState[0].attrEditMode = false;
	panelState[0].notesEditMode = false;

	const $btns = $('#item-props-modal-panel-btns').empty();
	const maxPanel = Math.min(visiblePanels + 1, 4);
	for (let p = 2; p <= maxPanel; p++) {
		const targetPanel = p;
		$('<button>')
			// Open in Panel X
			.text(`P${targetPanel}`)
			.css({
				padding: '4px 10px',
				background: '#2196F3',
				color: 'white',
				border: 'none',
				borderRadius: '4px',
				cursor: 'pointer',
				fontSize: '12px'
			})
			.on('click', function () {
				hideItemPropsModal();
				openItemPropsInPanel(targetPanel);
			})
			.appendTo($btns);
	}

	$('#item-props-modal').css('display', 'flex');
	await updateItemPropertiesPage(0);
}

export function hideItemPropsModal() {
	$('#item-props-modal').hide();
}

async function openItemPropsInPanel(targetPanel) {
	if (targetPanel > visiblePanels) {
		visiblePanels++;
		$(`#panel-${targetPanel}`).show();
		attachPanelEventListeners(targetPanel);
		updatePanelLayout();
	}
	const $panel = $(`#panel-${targetPanel}`);
	$panel.find('.panel-header').removeClass('active');
	$panel.find('.panel-grid').hide();
	$panel.find('.panel-file-view').hide();
	$panel.find('.panel-landing-page').show();
	await updateItemPropertiesPage(targetPanel);
	setActivePanelId(targetPanel);
}

export async function reopenLastClosedPanel() {
	if (closedPanelStack.length === 0) return;
	if (visiblePanels >= 4) {
		w2alert('Maximum number of panels (4) is already open.');
		return;
	}

	const savedState = closedPanelStack.pop();
	visiblePanels++;
	const newPanelId = visiblePanels;

	$(`#panel-${newPanelId}`).show();
	attachPanelEventListeners(newPanelId);
	updatePanelLayout();
	await initializeGridForPanel(newPanelId);

	if (savedState.currentPath) {
		$(`#panel-${newPanelId} .panel-landing-page`).hide();
		$(`#panel-${newPanelId} .panel-grid`).show();
		const grid = panelState[newPanelId].w2uiGrid;
		if (grid) grid.resize();

		panelState[newPanelId].navigationHistory = savedState.navigationHistory;
		panelState[newPanelId].navigationIndex = savedState.navigationIndex;
		panelState[newPanelId].depth = savedState.depth;
		const depthInput = document.getElementById(`depth-input-${newPanelId}`);
		if (depthInput) depthInput.value = savedState.depth;

		await navigateToDirectory(savedState.currentPath, newPanelId, false);
	}
}

// ============================================
// Layout Save/Load (.aly files)
// ============================================

function applyColumnOverrides(panelId) {
	const overrides = panelState[panelId].columnOverrides;
	if (!overrides) return;

	const grid = panelState[panelId].w2uiGrid;
	if (!grid) return;

	// Apply sizes and hidden state
	for (const override of overrides) {
		const col = grid.columns.find(c => c.field === override.field);
		if (col) {
			col.size = override.size;
			col.hidden = override.hidden;
		}
	}

	// Reorder columns to match saved order
	const fieldOrder = overrides.map(o => o.field);
	grid.columns.sort((a, b) => {
		const ia = fieldOrder.indexOf(a.field);
		const ib = fieldOrder.indexOf(b.field);
		if (ia === -1 && ib === -1) return 0;
		if (ia === -1) return 1;
		if (ib === -1) return -1;
		return ia - ib;
	});

	grid.refresh();
	delete panelState[panelId].columnOverrides;
}

export function serializeLayoutState(description = null) {
	const panels = {};
	for (let panelId = 1; panelId <= 4; panelId++) {
		const $panel = $(`#panel-${panelId}`);
		if (!$panel.is(':visible')) {
			panels[panelId] = null;
			continue;
		}
		const state = panelState[panelId];
		const gridName = `grid-panel-${panelId}`;
		const grid = w2ui[gridName];
		panels[panelId] = {
			currentPath: state.currentPath || '',
			viewType: getPanelViewType(panelId),
			depth: state.depth || 0,
			showDateCreated: state.showDateCreated || false,
			columns: grid ? grid.columns.map(col => ({
				field: col.field,
				size: col.size,
				hidden: !!col.hidden
			})) : [],
			sortData: grid ? (grid.sortData || []).map(s => ({
				field: s.field,
				direction: s.direction
			})) : [],
			filterValues: state.filterValues || null
		};
	}

	const sidebarWidth = w2layoutInstance ? w2layoutInstance.get('left').size : 250;

	return {
		version: 1,
		savedAt: new Date().toISOString(),
		description: description ? String(description).slice(0, 255) : undefined,
		layout: {
			currentLayout,
			visiblePanels,
			dividers: {
				verticalPixels: panelDividerState.verticalPixels,
				horizontalPixels: panelDividerState.horizontalPixels
			},
			sidebarWidth
		},
		panels
	};
}

export async function applyLayoutState(layoutData) {
	if (!layoutData || !layoutData.layout || !layoutData.panels) return;

	const { layout, panels } = layoutData;

	// 1. Hide all panels first
	for (let i = 1; i <= 4; i++) {
		$(`#panel-${i}`).hide();
		clearPanelState(i);
	}

	// 2. Set divider state
	panelDividerState.verticalPixels = layout.dividers.verticalPixels;
	panelDividerState.horizontalPixels = layout.dividers.horizontalPixels;
	localStorage.setItem('panelDividerVertical', layout.dividers.verticalPixels);
	localStorage.setItem('panelDividerHorizontal', layout.dividers.horizontalPixels);

	// 3. Set sidebar width
	if (w2layoutInstance && layout.sidebarWidth) {
		w2layoutInstance.sizeTo('left', layout.sidebarWidth);
		localStorage.setItem('sidebarExpandedWidth', layout.sidebarWidth);
	}

	// 4. Show the correct number of panels
	visiblePanels = layout.visiblePanels;
	for (let i = 1; i <= visiblePanels; i++) {
		$(`#panel-${i}`).show();
	}

	// 5. Switch to the saved layout
	await switchLayout(layout.currentLayout);

	// 6. Initialize grids and navigate panels
	for (let panelId = 1; panelId <= 4; panelId++) {
		const panelData = panels[panelId];
		if (!panelData) continue;

		// Set column overrides before grid init so they apply after creation
		if (panelData.columns && panelData.columns.length > 0) {
			panelState[panelId].columnOverrides = panelData.columns;
		}

		panelState[panelId].showDateCreated = panelData.showDateCreated || false;

		await initializeGridForPanel(panelId);
		attachPanelEventListeners(panelId);

		if (panelData.currentPath) {
			$(`#panel-${panelId} .panel-landing-page`).hide();
			$(`#panel-${panelId} .panel-grid`).show();

			await navigateToDirectory(panelData.currentPath, panelId, true);

			// Restore depth after navigation (navigateToDirectory resets it)
			if (panelData.depth > 0) {
				panelState[panelId].depth = panelData.depth;
				const depthInput = document.getElementById(`depth-input-${panelId}`);
				if (depthInput) depthInput.value = panelData.depth;
			}

			// Apply column overrides again in case navigateToDirectory re-initialized the grid
			if (panelData.columns && panelData.columns.length > 0) {
				panelState[panelId].columnOverrides = panelData.columns;
				applyColumnOverrides(panelId);
			}

			// Restore sort state
			if (panelData.sortData && panelData.sortData.length > 0) {
				const grid = panelState[panelId].w2uiGrid;
				if (grid) {
					grid.sortData = panelData.sortData;
					grid.localSort();
					repositionMetaDirs(grid, panelId);
					grid.refresh();
				}
			}
		}
	}

	// 7. Set active panel to 1
	setActivePanelId(1);
}

// ============================================
// Save Button Menu
// ============================================

let activeSaveMenu = null;

function closeSaveMenu() {
	if (activeSaveMenu) {
		activeSaveMenu.remove();
		activeSaveMenu = null;
	}
}

function showSaveButtonMenu(panelId, anchorEl) {
	// Close any existing menu first
	closeSaveMenu();

	const rect = anchorEl.getBoundingClientRect();
	const menu = document.createElement('div');
	menu.className = 'tb-save-menu';
	menu.innerHTML = `
		<button class="tb-save-menu-item" data-action="remember-grid">
			<div class="tb-save-menu-label">Remember grid layout</div>
		</button>
		<button class="tb-save-menu-item" data-action="save-layout-here">
			<div class="tb-save-menu-label">Save window layout here</div>
		</button>
		<button class="tb-save-menu-item" data-action="save-layout-global">
			<div class="tb-save-menu-label">Save window layout global</div>
		</button>
	`;

	// Position below the button
	menu.style.left = `${rect.left}px`;
	menu.style.top = `${rect.bottom + 2}px`;
	document.body.appendChild(menu);
	activeSaveMenu = menu;

	menu.querySelector('[data-action="remember-grid"]').addEventListener('click', () => {
		closeSaveMenu();
		rememberGridLayout(panelId);
	});

	menu.querySelector('[data-action="save-layout-here"]').addEventListener('click', () => {
		closeSaveMenu();
		saveLayoutToCurrentDir(panelId);
	});

	menu.querySelector('[data-action="save-layout-global"]').addEventListener('click', () => {
		closeSaveMenu();
		openSaveLayoutGlobalModal(panelId);
	});

	// Close on outside click
	setTimeout(() => {
		document.addEventListener('click', closeSaveMenu, { once: true });
	}, 0);
}

async function rememberGridLayout(panelId) {
	const state = panelState[panelId];
	if (!state || !state.currentPath) {
		w2alert('No directory is open in this panel.');
		return;
	}
	const grid = state.w2uiGrid;
	if (!grid) return;

	// Serialize only non-attribute columns or validate that attribute columns still exist
	const validAttrNames = new Set((state.currentAttrColumns || []).map(n => `attr_${n}`));
	const columns = grid.columns
		.filter(col => {
			// Keep standard columns; skip attr_ columns that aren't currently valid
			if (col.field && col.field.startsWith('attr_')) {
				return validAttrNames.has(col.field);
			}
			return true;
		})
		.map(col => ({ field: col.field, size: col.size, hidden: !!col.hidden }));

	const sortData = (grid.sortData || []).map(s => ({ field: s.field, direction: s.direction }));

	const result = await window.electronAPI.saveDirGridLayout(state.currentPath, columns, sortData);
	if (result.success) {
		w2alert('Grid layout remembered for this directory.');
	} else {
		w2alert('Failed to save grid layout: ' + (result.error || 'Unknown error'));
	}
}

async function saveLayoutToCurrentDir(panelId) {
	const state = panelState[panelId];
	if (!state || !state.currentPath) {
		w2alert('No directory is open in this panel.');
		return;
	}
	await openSaveLayoutModal(panelId, 'here', state.currentPath);
}

async function openSaveLayoutGlobalModal(panelId) {
	await openSaveLayoutModal(panelId, 'global', null);
}

async function openSaveLayoutModal(panelId, mode, dirPath) {
	// Capture thumbnail first (before modal obscures the window)
	const thumbResult = await window.electronAPI.captureThumbnail();
	const thumbnailBase64 = thumbResult.success ? thumbResult.thumbnailBase64 : null;

	const modal = document.getElementById('save-layout-global-modal');
	const input = document.getElementById('save-layout-global-name');
	const thumb = document.getElementById('save-layout-global-thumb');
	const thumbPlaceholder = document.getElementById('save-layout-global-thumb-placeholder');
	const destLabel = document.getElementById('save-layout-global-dest');
	const descEl = document.getElementById('save-layout-global-desc');
	const descCount = document.getElementById('save-layout-global-desc-count');
	if (descEl) descEl.value = '';
	if (descCount) descCount.textContent = '0';

	if (mode === 'here') {
		// Collision-avoid in the current directory
		const dirEntries = await window.electronAPI.readDirectory(dirPath);
		const existingAly = new Set(
			(Array.isArray(dirEntries) ? dirEntries : []).map(e => {
				const fn = e.filename || e.name || '';
				return fn.toLowerCase().endsWith('.aly') ? fn.slice(0, -4).toLowerCase() : null;
			}).filter(Boolean)
		);
		let n = 1;
		let defaultName = 'layout';
		if (existingAly.has('layout')) {
			while (existingAly.has(`layout-${n}`)) n++;
			defaultName = `layout-${n}`;
		}
		input.value = defaultName;
		destLabel.textContent = dirPath;
		destLabel.title = dirPath;
	} else {
		// Collision-avoid in global layouts folder
		const listResult = await window.electronAPI.listLayouts();
		const existingNames = new Set(
			(listResult.success ? listResult.layouts : []).map(l => {
				const fn = l.fileName || '';
				return fn.toLowerCase().endsWith('.aly') ? fn.slice(0, -4) : fn;
			})
		);
		let n = 1;
		while (existingNames.has(`layout-${n}`)) n++;
		input.value = `layout-${n}`;
		destLabel.textContent = 'Saved to layouts folder';
		destLabel.title = '';
	}

	if (thumbnailBase64) {
		thumb.src = `data:image/png;base64,${thumbnailBase64}`;
		thumb.style.display = '';
		thumbPlaceholder.style.display = 'none';
	} else {
		thumb.style.display = 'none';
		thumbPlaceholder.style.display = '';
	}

	modal._pendingPanelId = panelId;
	modal._pendingMode = mode;
	modal._pendingDirPath = dirPath;
	modal._pendingThumbnailBase64 = thumbnailBase64 || null;
	modal.style.display = '';
	setTimeout(() => input.select(), 50);
}

export async function confirmSaveLayoutGlobal() {
	const modal = document.getElementById('save-layout-global-modal');
	const input = document.getElementById('save-layout-global-name');
	const descEl = document.getElementById('save-layout-global-desc');
	let name = input.value.trim();

	if (!name) {
		input.focus();
		return;
	}
	// Sanitize: strip path separators
	name = name.replace(/[/\\:*?"<>|]/g, '-');
	if (!name.toLowerCase().endsWith('.aly')) name += '.aly';

	const description = descEl ? descEl.value.trim().slice(0, 255) || null : null;
	const layoutData = serializeLayoutState(description);
	const mode = modal._pendingMode || 'global';
	const thumbnailBase64 = modal._pendingThumbnailBase64 || null;

	let result;
	if (mode === 'here') {
		const dirPath = modal._pendingDirPath;
		const filePath = await window.electronAPI.invoke('path-join', dirPath, name);
		result = await window.electronAPI.saveLayoutToPath(filePath, layoutData, thumbnailBase64);
	} else {
		result = await window.electronAPI.invoke('save-layout-global-named', { name, layoutData, thumbnailBase64 });
	}

	if (result.success) {
		modal.style.display = 'none';
	} else {
		w2alert('Failed to save layout: ' + (result.error || 'Unknown error'));
	}
}

export function closeSaveLayoutGlobalModal() {
	const modal = document.getElementById('save-layout-global-modal');
	if (modal) modal.style.display = 'none';
}

/**
 * Apply the in-memory session layout (sort + column sizes) for a directory.
 * Used when navigating back to a directory visited earlier this session.
 */
function applySessionDirLayout(panelId, layout) {
	const grid = panelState[panelId]?.w2uiGrid;
	if (!grid) return;

	if (layout.columns && layout.columns.length > 0) {
		const currentFields = new Set(grid.columns.map(c => c.field));
		const validColumns = layout.columns.filter(c => currentFields.has(c.field));
		if (validColumns.length > 0) {
			panelState[panelId].columnOverrides = validColumns;
			applyColumnOverrides(panelId);
		}
	}

	if (layout.sortData && layout.sortData.length > 0) {
		grid.sortData = layout.sortData;
		grid.localSort();
		repositionMetaDirs(grid, panelId);
		grid.refresh();
	}
}

export async function applyDirGridLayoutIfExists(panelId, dirPath) {
	const result = await window.electronAPI.getDirGridLayout(dirPath);
	if (!result.success || !result.layout) return;

	const { columns, sortData } = result.layout;
	const grid = panelState[panelId]?.w2uiGrid;
	if (!grid) return;

	// Validate attribute columns — remove any that no longer exist in the current grid
	const currentFields = new Set(grid.columns.map(c => c.field));
	const validColumns = columns.filter(col => currentFields.has(col.field));

	if (validColumns.length > 0) {
		panelState[panelId].columnOverrides = validColumns;
		applyColumnOverrides(panelId);
	}

	if (sortData && sortData.length > 0) {
		grid.sortData = sortData;
		grid.localSort();
		repositionMetaDirs(grid, panelId);
		grid.refresh();
	}
}

// ---------- .aly open-confirm modal ----------

let _pendingAlyPath = null;

export async function openAlyLayoutModal(filePath) {
	_pendingAlyPath = filePath;
	const modal = document.getElementById('aly-open-modal');
	if (!modal) return;

	const titleEl  = document.getElementById('aly-open-modal-title');
	const thumb    = document.getElementById('aly-open-thumb');
	const thumbPh  = document.getElementById('aly-open-thumb-placeholder');
	const nameEl   = document.getElementById('aly-open-name');
	const descEl   = document.getElementById('aly-open-desc');
	const metaEl   = document.getElementById('aly-open-meta');

	// Reset
	thumb.style.display = 'none';
	thumbPh.style.display = '';
	nameEl.textContent = '';
	descEl.style.display = 'none';
	descEl.textContent = '';
	metaEl.textContent = '';
	titleEl.textContent = 'Open Layout';

	modal.style.display = '';

	try {
		const result = await window.electronAPI.invoke('load-layout-file', filePath);
		if (!result.success) {
			w2alert('Failed to read layout file: ' + (result.error || 'Unknown error'));
			modal.style.display = 'none';
			return;
		}
		const { layoutData, thumbnailBase64, description } = result;

		// File name as display name (strip .aly)
		const basename = filePath.replace(/\\/g, '/').split('/').pop();
		const displayName = basename.toLowerCase().endsWith('.aly') ? basename.slice(0, -4) : basename;
		nameEl.textContent = displayName;
		titleEl.textContent = 'Open Layout — ' + displayName;

		if (thumbnailBase64) {
			thumb.src = 'data:image/png;base64,' + thumbnailBase64;
			thumb.style.display = '';
			thumbPh.style.display = 'none';
		}

		const desc = description || layoutData?.description;
		if (desc) {
			descEl.textContent = desc;
			descEl.style.display = '';
		}

		if (layoutData?.savedAt) {
			const d = new Date(layoutData.savedAt);
			metaEl.textContent = 'Saved: ' + d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
		}
	} catch (err) {
		w2alert('Error loading layout: ' + err.message);
		modal.style.display = 'none';
	}
}

export async function confirmLoadAlyLayout() {
	const filePath = _pendingAlyPath;
	if (!filePath) return;
	const modal = document.getElementById('aly-open-modal');
	if (modal) modal.style.display = 'none';
	try {
		const result = await window.electronAPI.invoke('load-layout-file', filePath);
		if (!result.success) {
			w2alert('Failed to load layout: ' + (result.error || 'Unknown error'));
			return;
		}
		await applyLayoutState(result.layoutData);
	} catch (err) {
		w2alert('Error applying layout: ' + err.message);
	}
	_pendingAlyPath = null;
}

export function closeAlyLayoutModal() {
	_pendingAlyPath = null;
	const modal = document.getElementById('aly-open-modal');
	if (modal) modal.style.display = 'none';
}
