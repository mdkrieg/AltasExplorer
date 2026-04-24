/**
 * Settings Module
 * Settings modal shell plus browser settings.
 *
 * Remaining extractions still planned here:
 * - categories
 * - tags
 * - hotkeys
 * - file types
 * - attributes
 */

import * as panels from './panels.js';
import { w2ui, w2grid, w2confirm, w2alert, w2field } from './vendor/w2ui.es6.min.js';
import {
	panelState,
	loadHotkeysFromStorage
} from '../renderer.js';
import { showFormError, showFormSuccess, clearFormStatus, enforceTagNameInput } from './utils.js';

let initializedSettingsTabs = new Set();
let initializedTaggingTabs = new Set();

let categoryFormState = {
	editingName: null
};

function getCategoryFormCategoryNames() {
	const categoryNames = new Set();
	const grid = w2ui['categories-grid'];
	if (grid) {
		grid.records.forEach(record => {
			if (record.categoryName) {
				categoryNames.add(record.categoryName);
			}
		});
	}

	const currentName = ($('#form-cat-name').val() || '').trim();
	if (currentName) {
		categoryNames.add(currentName);
	}

	return Array.from(categoryNames).sort((left, right) => left.localeCompare(right));
}

function syncCategoryAutoAssignField(selectedValue = '') {
	const $hidden = $('#form-cat-autoAssignCategory');
	const $wrap = $('#form-cat-autoAssignCategory-wrap');
	const $optionsEl = $('#form-cat-autoAssignCategory-options');
	const $iconEl = $('#form-cat-autoAssignCategory-icon');
	const $textEl = $('#form-cat-autoAssignCategory-text');
	const $help = $('#form-cat-autoAssignHelp');
	const currentName = ($('#form-cat-name').val() || '').trim();
	const normalizedSelectedValue = selectedValue || '';
	const categoryNames = getCategoryFormCategoryNames();

	// Build icon map from grid records (icons already generated at grid init time)
	const grid = w2ui['categories-grid'];
	const gridRecords = grid ? grid.records.filter(r => !r._isNewRow) : [];
	const iconMap = {};
	gridRecords.forEach(r => { iconMap[r.categoryName || r.name] = r.iconUrl || null; });

	const isDisabled = currentName === 'Default';
	$wrap.toggleClass('cat-icon-select-disabled', isDisabled);

	const effectiveValue = isDisabled ? '' : (categoryNames.includes(normalizedSelectedValue) ? normalizedSelectedValue : '');
	$hidden.val(effectiveValue);

	// Rebuild options list
	$optionsEl.empty().hide();

	const makeOption = (value, iconUrl, label) => {
		const $opt = $('<div class="cat-icon-select-option"></div>').attr('data-value', value);
		const $iconSpan = $('<span class="cat-icon-select-opt-icon"></span>');
		if (iconUrl) {
			$('<img>').attr({ src: iconUrl, style: 'width:16px;height:16px;object-fit:contain;vertical-align:middle;' }).appendTo($iconSpan);
		}
		$opt.append($iconSpan);
		$opt.append($('<span class="cat-icon-select-opt-text"></span>').text(label));
		if (effectiveValue === value) $opt.addClass('cat-icon-select-option-selected');
		return $opt;
	};

	$optionsEl.append(makeOption('', null, 'None'));
	categoryNames.forEach(name => $optionsEl.append(makeOption(name, iconMap[name] || null, name)));

	// Update trigger display
	const selectedIconUrl = effectiveValue ? (iconMap[effectiveValue] || null) : null;
	$iconEl.empty();
	if (selectedIconUrl) {
		$('<img>').attr({ src: selectedIconUrl, style: 'width:16px;height:16px;object-fit:contain;vertical-align:middle;' }).appendTo($iconEl);
	}
	$textEl.text(effectiveValue || 'None');

	if (isDisabled) {
		$help.text('Default category cannot auto-assign subdirectories.');
	} else {
		$help.text('Apply one category automatically to immediate subdirectories of folders in this category.');
	}
}

let tagFormState = {
	editingName: null
};

let attributeFormState = {
	editingName: null
};

export async function showSettingsModal() {
	initializedSettingsTabs = new Set();

	$('#settings-modal').show();
	switchSettingsTab('browser');
	await initializeBrowserSettingsForm();
}

export async function showLabelManagerModal() {
	initializedTaggingTabs = new Set(['category']);
	$('#tagging-modal').show();
	switchTaggingTab('category');
	await initializeCategoriesGrid();
	await initializeCategoriesForm();
	setupCategoryDivider();
}

export function hideTaggingModal() {
	$('#tagging-modal').hide();
	initializedTaggingTabs = new Set();
	if (w2ui['categories-grid']) {
		w2ui['categories-grid'].destroy();
	}
	if (w2ui['tags-grid']) {
		w2ui['tags-grid'].destroy();
	}
	if (w2ui['attributes-grid']) {
		w2ui['attributes-grid'].destroy();
	}
	if (w2ui['auto-labels-grid']) {
		w2ui['auto-labels-grid'].destroy();
	}
}

export function hideSettingsModal() {
	$('#settings-modal').hide();
	initializedSettingsTabs = new Set();

	if (w2ui['filetypes-grid']) {
		w2ui['filetypes-grid'].destroy();
	}

	if (w2ui['hotkeys-grid']) {
		w2ui['hotkeys-grid'].destroy();
	}

	if (w2ui['custom-actions-grid']) {
		w2ui['custom-actions-grid'].destroy();
	}
}

export function switchSettingsTab(tabName) {
	$('.settings-tab-content').hide();

	const $tab = $(`#tab-${tabName}`);
	if (tabName === 'filetypes' || tabName === 'hotkeys' || tabName === 'customactions') {
		$tab.css('display', 'flex');

		if (tabName === 'filetypes' && !initializedSettingsTabs.has('filetypes')) {
			initializedSettingsTabs.add('filetypes');
			initializeFileTypesGrid().then(() => initializeFileTypesForm()).then(() => setupFileTypesDivider());
		} else if (tabName === 'hotkeys' && !initializedSettingsTabs.has('hotkeys')) {
			initializedSettingsTabs.add('hotkeys');
			initializeHotkeysGrid().then(() => initializeHotkeysForm()).then(() => setupHotkeysResizableDivider());
		} else if (tabName === 'customactions' && !initializedSettingsTabs.has('customactions')) {
			initializedSettingsTabs.add('customactions');
			initializeCustomActionsGrid().then(() => initializeCustomActionsForm()).then(() => setupCustomActionsDivider());
		}
	} else if (tabName === 'updates') {
		$tab.css('display', 'flex');
		if (!initializedSettingsTabs.has('updates')) {
			initializedSettingsTabs.add('updates');
			initializeUpdatesTab();
		}
	} else {
		$tab.show();
	}

	$('.settings-tab-btn').each(function () {
		const button = $(this);
		if (button.data('tab') === tabName) {
			button.css('border-bottom-color', '#2196F3').css('color', '#2196F3');
		} else {
			button.css('border-bottom-color', 'transparent').css('color', '#666');
		}
	});
}

export function switchTaggingTab(tabName) {
	$('.tagging-tab-content').hide();
	const $tab = $(`#tab-${tabName}`);
	$tab.css('display', 'flex');

	if (tabName === 'category' && initializedTaggingTabs.has('category')) {
		window.electronAPI.getAttributesList().then(attrList => {
			const $container = $('#form-cat-attributes');
			const checkedValues = [];
			$container.find('input[type="checkbox"]:checked').each(function () {
				checkedValues.push($(this).val());
			});
			$container.empty();
			const nonGlobalAttrs = (attrList || []).filter(attr => !attr.global);
			if (nonGlobalAttrs.length > 0) {
				nonGlobalAttrs.forEach(attr => {
					const id = `cat-attr-cb-${attr.name.replace(/\s+/g, '-')}`;
					$container.append(
						`<label style="display: inline-flex; align-items: center; gap: 4px; margin-right: 10px; font-size: 12px; cursor: pointer;">
							<input type="checkbox" id="${id}" value="${attr.name}" ${checkedValues.includes(attr.name) ? 'checked' : ''}> ${attr.name}
						</label>`
					);
				});
			} else {
				$container.append('<span style="font-size: 12px; color: #999;">No attributes defined yet.</span>');
			}
		});
	}

	if (tabName === 'tag' && !initializedTaggingTabs.has('tag')) {
		initializedTaggingTabs.add('tag');
		initializeTagsGrid().then(() => initializeTagsForm()).then(() => setupTagDivider());
	}

	if (tabName === 'attribute' && !initializedTaggingTabs.has('attribute')) {
		initializedTaggingTabs.add('attribute');
		initializeAttributesGrid().then(() => initializeAttributesForm()).then(() => setupAttributeDivider());
	}

	if (tabName === 'auto-label' && !initializedTaggingTabs.has('auto-label')) {
		initializedTaggingTabs.add('auto-label');
		initializeAutoLabelsGrid().then(() => setupAutoLabelDivider());
	}

	$('.tagging-tab-btn').each(function () {
		const button = $(this);
		if (button.data('tab') === tabName) {
			button.css('border-bottom-color', '#2196F3').css('color', '#2196F3');
		} else {
			button.css('border-bottom-color', 'transparent').css('color', '#666');
		}
	});
}

export async function initializeBrowserSettingsForm() {
	const settings = await window.electronAPI.getSettings();
	const homeDirectory = settings.home_directory || '';
	const fileFormat = settings.file_format || 'Markdown';
	const hideDotDirectory = settings.hide_dot_directory || false;
	const hideDotDotDirectory = settings.hide_dot_dot_directory || false;
	const showFolderNameWithDotEntries = settings.show_folder_name_with_dot_entries || false;
	const pinMetaDirs = settings.pin_meta_dirs || false;
	const recordHeight = settings.record_height || 30;
	const backgroundRefreshEnabled = settings.background_refresh_enabled || false;
	const backgroundRefreshInterval = settings.background_refresh_interval || 30;
	const checksumMaxConcurrent = settings.checksum_max_concurrent || 1;
	const titleDefaultFormat = settings.title_default_format || 'folder-name';
	const titleDisplayNameFormat = settings.title_display_name_format || 'name-relative-path';

	$('#browser-home-directory').val(homeDirectory);
	$('#browser-notes-format').val(fileFormat);
	$('#browser-hide-dot-directory').prop('checked', hideDotDirectory);
	$('#browser-hide-dot-dot-directory').prop('checked', hideDotDotDirectory);
	$('#browser-show-folder-name-with-dot-entries').prop('checked', showFolderNameWithDotEntries);
	$('#browser-pin-meta-dirs').prop('checked', pinMetaDirs);
	$('#browser-record-height').val(recordHeight);
	$('#browser-background-refresh-enabled').prop('checked', backgroundRefreshEnabled);
	$('#browser-background-refresh-interval').val(backgroundRefreshInterval).prop('disabled', !backgroundRefreshEnabled);
	$('#browser-checksum-max-concurrent').val(checksumMaxConcurrent);
	$('#browser-title-default-format').val(titleDefaultFormat);
	$('#browser-title-display-name-format').val(titleDisplayNameFormat);

	await updateHomeDirectoryWarning(homeDirectory);
	setupBrowserSettingsEventListeners();
}

export async function updateHomeDirectoryWarning(dirPath) {
	const normalizedPath = (dirPath || '').trim();
	const $warning = $('#browser-home-warning');

	if (!normalizedPath) {
		$warning.hide();
		return;
	}

	const exists = await window.electronAPI.isDirectory(normalizedPath);
	if (exists) {
		$warning.hide();
	} else {
		$warning.show();
	}
}


function setupBrowserSettingsEventListeners() {
	$('#browser-background-refresh-enabled').off('change');
	$('#btn-browser-save-all').off('click');

	$('#browser-background-refresh-enabled').on('change', function () {
		$('#browser-background-refresh-interval').prop('disabled', !this.checked);
	});

	$('#btn-browser-save-all').on('click', saveBrowserSettings);
}

async function saveBrowserSettings() {
	try {
		const homeDirectory = ($('#browser-home-directory').val() || '').trim();
		const fileFormat = ($('#browser-notes-format').val() || 'Markdown').trim();
		const hideDotDirectory = $('#browser-hide-dot-directory').is(':checked');
		const hideDotDotDirectory = $('#browser-hide-dot-dot-directory').is(':checked');
		const showFolderNameWithDotEntries = $('#browser-show-folder-name-with-dot-entries').is(':checked');
		const pinMetaDirs = $('#browser-pin-meta-dirs').is(':checked');
		let recordHeight = parseInt($('#browser-record-height').val() || '30');
		const backgroundRefreshEnabled = $('#browser-background-refresh-enabled').is(':checked');
		let backgroundRefreshInterval = parseInt($('#browser-background-refresh-interval').val() || '30');
		let checksumMaxConcurrent = parseInt($('#browser-checksum-max-concurrent').val() || '1');
		const titleDefaultFormat = $('#browser-title-default-format').val() || 'folder-name';
		const titleDisplayNameFormat = $('#browser-title-display-name-format').val() || 'name-relative-path';

		if (isNaN(recordHeight) || recordHeight < 20) {
			recordHeight = 20;
			$('#browser-record-height').val(recordHeight);
		} else if (recordHeight > 35) {
			recordHeight = 35;
			$('#browser-record-height').val(recordHeight);
		}

		if (!backgroundRefreshEnabled) {
			backgroundRefreshInterval = 30;
		} else if (isNaN(backgroundRefreshInterval) || backgroundRefreshInterval < 2) {
			backgroundRefreshInterval = 2;
			$('#browser-background-refresh-interval').val(backgroundRefreshInterval);
		} else if (backgroundRefreshInterval > 60) {
			backgroundRefreshInterval = 60;
			$('#browser-background-refresh-interval').val(backgroundRefreshInterval);
		}

		if (isNaN(checksumMaxConcurrent) || checksumMaxConcurrent < 1) {
			checksumMaxConcurrent = 1;
			$('#browser-checksum-max-concurrent').val(checksumMaxConcurrent);
		} else if (checksumMaxConcurrent > 2) {
			checksumMaxConcurrent = 2;
			$('#browser-checksum-max-concurrent').val(checksumMaxConcurrent);
		}

		const settings = await window.electronAPI.getSettings();
		settings.home_directory = homeDirectory;
		settings.file_format = fileFormat;
		settings.hide_dot_directory = hideDotDirectory;
		settings.hide_dot_dot_directory = hideDotDotDirectory;
		settings.record_height = recordHeight;
		settings.background_refresh_enabled = backgroundRefreshEnabled;
		settings.background_refresh_interval = backgroundRefreshInterval;
		settings.show_folder_name_with_dot_entries = showFolderNameWithDotEntries;
		settings.pin_meta_dirs = pinMetaDirs;
		settings.checksum_max_concurrent = checksumMaxConcurrent;
		settings.title_default_format = titleDefaultFormat;
		settings.title_display_name_format = titleDisplayNameFormat;

		const result = await window.electronAPI.saveSettings(settings);
		if (!result || result.success === false) {
			throw new Error(result?.error || 'Unable to save settings');
		}

		await updateHomeDirectoryWarning(homeDirectory);
		panels.applyRecordHeightToAllGrids(recordHeight);

		showFormSuccess('browser-settings-status', 'Settings saved.');

		window.electronAPI.startBackgroundRefresh(backgroundRefreshEnabled, backgroundRefreshInterval);

		// Refresh window title immediately with new format settings
		await panels.maybeRefreshPanel1TitleAndIcon();

		const state = panelState[panels.activePanelId];
		if (state && state.currentPath) {
			await panels.navigateToDirectory(state.currentPath, panels.activePanelId);
		}
	} catch (err) {
		showFormError('browser-settings-status', 'Error: ' + err.message);
	}
}

let fileTypeFormState = {
	editingPattern: null,
	selectedIcon: null
};

let customActionFormState = {
	editingId: null
};

const DEFAULT_CUSTOM_ACTION_TIMEOUT_SECONDS = 60;

function normalizeCustomActionTimeout(value) {
	const numericValue = Number(value);
	if (!Number.isFinite(numericValue)) return DEFAULT_CUSTOM_ACTION_TIMEOUT_SECONDS;

	const roundedValue = Math.trunc(numericValue);
	return roundedValue > 0 ? roundedValue : DEFAULT_CUSTOM_ACTION_TIMEOUT_SECONDS;
}

function updateCustomActionExecutionFields(executionMode) {
	const normalizedMode = executionMode === 'terminal' ? 'terminal' : 'silent';
	$('#form-ca-execution-mode').val(normalizedMode);
	$('#form-ca-timeout-section').toggle(normalizedMode === 'silent');
}

export function setupHotkeysResizableDivider() {
	const divider = $('#hotkeys-divider');
	const formPanel = $('#hotkeys-form-panel');
	let isResizing = false;
	let startX = 0;
	let startWidth = 0;

	divider.mousedown(function (e) {
		isResizing = true;
		startX = e.clientX;
		startWidth = formPanel.width();
		$(document).css('user-select', 'none');
	});

	$(document).mousemove(function (e) {
		if (!isResizing) return;

		const deltaX = e.clientX - startX;
		const newWidth = Math.max(250, startWidth - deltaX);
		formPanel.css('flex', `0 0 ${newWidth}px`);
	});

	$(document).mouseup(function () {
		if (isResizing) {
			isResizing = false;
			$(document).css('user-select', '');
		}
	});
}

function setupCategoryDivider() {
	setupFormDivider('#category-divider', '#category-form-panel');
}

function setupTagDivider() {
	setupFormDivider('#tag-divider', '#tag-form-panel');
}

function setupAttributeDivider() {
	setupFormDivider('#attribute-divider', '#attribute-form-panel');
}

function setupFormDivider(dividerSelector, formPanelSelector) {
	const divider = $(dividerSelector);
	const formPanel = $(formPanelSelector);
	let isResizing = false;
	let startX = 0;
	let startWidth = 0;

	divider.off('mousedown.settingsDivider').on('mousedown.settingsDivider', function (event) {
		isResizing = true;
		startX = event.clientX;
		startWidth = formPanel.width();
		$(document).css('user-select', 'none');
	});

	$(document).off(`mousemove${dividerSelector}`).on(`mousemove${dividerSelector}`, function (event) {
		if (!isResizing) return;
		const deltaX = event.clientX - startX;
		const newWidth = Math.max(250, startWidth - deltaX);
		formPanel.css('flex', `0 0 ${newWidth}px`);
	});

	$(document).off(`mouseup${dividerSelector}`).on(`mouseup${dividerSelector}`, function () {
		if (isResizing) {
			isResizing = false;
			$(document).css('user-select', '');
		}
	});
}

function hexToRgb(hex) {
	if (hex.startsWith('rgb')) return hex;
	const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
	if (!result) return 'rgb(0, 0, 0)';
	const r = parseInt(result[1], 16);
	const g = parseInt(result[2], 16);
	const b = parseInt(result[3], 16);
	return `rgb(${r}, ${g}, ${b})`;
}

function rgbToHex(rgb) {
	if (rgb.startsWith('#')) return rgb;
	const match = rgb.match(/rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
	if (!match) return '#000000';
	const r = parseInt(match[1]).toString(16).padStart(2, '0');
	const g = parseInt(match[2]).toString(16).padStart(2, '0');
	const b = parseInt(match[3]).toString(16).padStart(2, '0');
	return `#${r}${g}${b}`;
}

function initializeColorPickers() {
	const colorFieldIds = [
		'form-cat-bgColor',
		'form-cat-textColor',
		'form-tag-bgColor',
		'form-tag-textColor',
		'item-tag-create-bgColor',
		'item-tag-create-textColor'
	];

	colorFieldIds.forEach(id => {
		const el = document.getElementById(id);
		if (el && !el._w2field) {
			new w2field('color', { el });
		}
		// w2ui sets inline padding with !important — strip it so layout is
		// controlled uniformly by the stylesheet / natural flow
		if (el) {
			el.style.removeProperty('padding-left');
			el.style.removeProperty('padding-right');
		}
		// Wrap the input + w2ui helpers in a positioning container
		// so the helpers align relative to the input, not the label+input parent
		if (el && !el.parentElement.classList.contains('color-input-wrapper')) {
			const wrapper = document.createElement('div');
			wrapper.className = 'color-input-wrapper';
			const parent = el.parentElement;
			// Collect input and its adjacent w2ui-field-helper siblings
			const siblings = Array.from(parent.children).filter(
				c => c === el || c.classList.contains('w2ui-field-helper')
			);
			// Insert wrapper where the input is
			parent.insertBefore(wrapper, siblings[0]);
			siblings.forEach(s => wrapper.appendChild(s));
		}
	});
}

/**
 * Attaches mousedown+mouseup DOM handlers to a rendered w2ui grid container so
 * that row selection works correctly even when the user drags slightly before
 * releasing the mouse button (which prevents the native 'click' event and thus
 * w2ui's onClick from firing).  Also enforces single-row selection.
 *
 * @param {string} gridName  - The w2ui grid name AND the id of the container element.
 * @param {string} statusId  - ID of the status div to clear on selection change.
 * @param {Function} onRecord - Called with the selected record after selection is committed.
 */
function attachGridRowSelection(gridName, statusId, onRecord) {
	const container = document.getElementById(gridName);
	if (!container) return;
	let pendingRecid = null;

	container.addEventListener('mousedown', function (e) {
		const prefix = `grid_${gridName}_rec_`;
		const row = e.target.closest(`tr[id^="${prefix}"]`);
		if (!row) { pendingRecid = null; return; }
		const raw = row.id.slice(prefix.length);
		pendingRecid = raw === 'new' ? 'new' : parseInt(raw, 10);
	}, true);

	container.addEventListener('mouseup', function (e) {
		const recid = pendingRecid;
		pendingRecid = null;
		if (recid === null || recid === undefined) return;
		setTimeout(() => {
			const grid = w2ui[gridName];
			if (!grid) return;
			const record = grid.records.find(r => r.recid === recid);
			if (!record) return;
			// Clear any previous validation status
			clearFormStatus(null, statusId);
			// Enforce single selection of the intended row
			grid.selectNone();
			grid.select(recid);
			onRecord(record);
		}, 0);
	});
}

async function initializeCategoriesGrid() {
	const gridName = 'categories-grid';

	if (w2ui && w2ui[gridName]) {
		w2ui[gridName].destroy();
	}

	const categoriesData = await window.electronAPI.getCategoriesList();
	const records = categoriesData.map((category, index) => ({
		recid: index,
		name: category.name,
		description: category.description || '',
		bgColor: category.bgColor,
		textColor: category.textColor,
		categoryName: category.name,
		enableChecksum: category.enableChecksum || false,
		autoAssignCategory: category.autoAssignCategory || '',
		iconUrl: null,
		attributes: category.attributes || []
	}));

	try {
		await Promise.all(records.map(record =>
			window.electronAPI.generateFolderIcon(record.bgColor, record.textColor)
				.then(iconUrl => {
					record.iconUrl = iconUrl;
					return iconUrl;
				})
				.catch(err => {
					console.error(`Failed to generate icon for "${record.name}":`, err);
					return null;
				})
		));
	} catch (err) {
		console.error('Error generating icons:', err);
	}

	// Persistent "(new)" sentinel row always at the end
	records.push({
		recid: 'new',
		name: '(new)',
		description: '',
		bgColor: '',
		textColor: '',
		categoryName: null,
		enableChecksum: false,
		autoAssignCategory: '',
		iconUrl: null,
		attributes: [],
		_isNewRow: true
	});

	w2ui[gridName] = new w2grid({
		name: gridName,
		show: { header: false, toolbar: false, footer: false },
		columns: [
			{
				field: 'icon', text: '', size: '40px', resizable: false, sortable: false, render: record => {
					if (record._isNewRow) return '';
					if (record.iconUrl) {
						return `<div style="width: 30px; height: 20px; display: inline-flex; align-items: center; justify-content: center;"><img src="${record.iconUrl}" style="width: 20px; height: 20px; object-fit: contain;"></div>`;
					}
					return `<div style="width: 30px; height: 20px; background: ${record.bgColor}; border: 1px solid ${record.textColor}; border-radius: 3px;"></div>`;
				}
			},
			{
				field: 'name', text: 'Name', size: '100px', resizable: true, sortable: true,
				render: record => record._isNewRow
					? `<span style="color: #aaa; font-style: italic;">(new)</span>`
					: (record.name || '')
			},
			{
				field: 'description', text: 'Description', size: '100%', resizable: true, sortable: true,
				render: record => record._isNewRow ? '' : (record.description || '')
			}
		],
		records
	});

	w2ui[gridName].render('#categories-grid');
	attachGridRowSelection('categories-grid', 'form-cat-status', record => {
		if (record._isNewRow) clearCategoryForm();
		else populateCategoryForm(record);
	});

	$('#btn-cat-grid-new').off('click.catGridNew').on('click.catGridNew', function () {
		clearCategoryForm();
	});
}

async function initializeCategoriesForm() {
	try {
		const attrList = await window.electronAPI.getAttributesList();
		const $container = $('#form-cat-attributes');
		$container.empty();
		const nonGlobalAttrs = (attrList || []).filter(attr => !attr.global);
		if (nonGlobalAttrs.length > 0) {
			nonGlobalAttrs.forEach(attr => {
				const id = `cat-attr-cb-${attr.name.replace(/\s+/g, '-')}`;
				$container.append(
					`<label style="display: inline-flex; align-items: center; gap: 4px; margin-right: 10px; font-size: 12px; cursor: pointer;">
						<input type="checkbox" id="${id}" value="${attr.name}"> ${attr.name}
					</label>`
				);
			});
		} else {
			$container.append('<span style="font-size: 12px; color: #999;">No attributes defined yet.</span>');
		}
	} catch (err) {
		console.error('Error loading attributes for category form:', err);
	}

	$('#form-cat-name').off('input.categoryAutoAssign').on('input.categoryAutoAssign', function () {
		syncCategoryAutoAssignField($('#form-cat-autoAssignCategory').val() || '');
	});

	// Custom dropdown interaction (re-bound each time the modal opens)
	$('#form-cat-autoAssignCategory-wrap')
		.off('click.catSelect')
		.on('click.catSelect', '#form-cat-autoAssignCategory-trigger', function () {
			const $wrap = $(this).closest('.cat-icon-select');
			if ($wrap.hasClass('cat-icon-select-disabled')) return;
			$('#form-cat-autoAssignCategory-options').toggle();
		})
		.on('click.catSelect', '.cat-icon-select-option', function () {
			const val = $(this).data('value');
			$('#form-cat-autoAssignCategory').val(val);
			const $opts = $('#form-cat-autoAssignCategory-options');
			$opts.find('.cat-icon-select-option').removeClass('cat-icon-select-option-selected');
			$(this).addClass('cat-icon-select-option-selected');
			const $img = $(this).find('img');
			$('#form-cat-autoAssignCategory-icon').empty();
			if ($img.length) $img.clone().appendTo('#form-cat-autoAssignCategory-icon');
			$('#form-cat-autoAssignCategory-text').text(val || 'None');
			$opts.hide();
		});

	$(document).off('click.catSelectClose').on('click.catSelectClose', function (e) {
		if (!$(e.target).closest('#form-cat-autoAssignCategory-wrap').length) {
			$('#form-cat-autoAssignCategory-options').hide();
		}
	});

	initializeColorPickers();
	clearCategoryForm();
}

function populateCategoryForm(record) {
	categoryFormState.editingName = record.categoryName;
	$('#form-cat-name').val(record.name);

	// Set color pickers (w2field strips the # prefix)
	let bgColorHex = rgbToHex(record.bgColor).replace('#', '');
	let textColorHex = rgbToHex(record.textColor).replace('#', '');
	document.getElementById('form-cat-bgColor').value = bgColorHex;
	document.getElementById('form-cat-textColor').value = textColorHex;
	document.getElementById('form-cat-bgColor')._w2field?.refresh?.();
	document.getElementById('form-cat-textColor')._w2field?.refresh?.();

	$('#form-cat-description').val(record.description || '');
	$('#form-cat-enableChecksum').prop('checked', record.enableChecksum || false);
	$('#form-cat-displayMode').val(record.displayMode || 'details');
	syncCategoryAutoAssignField(record.autoAssignCategory || '');
	const selectedAttrs = record.attributes || [];
	$('#form-cat-attributes').find('input[type="checkbox"]').each(function () {
		$(this).prop('checked', selectedAttrs.includes($(this).val()));
	});
}

export function clearCategoryForm() {
	categoryFormState.editingName = null;
	$('#form-cat-name').val('');

	// Reset color pickers (w2field stores without #)
	document.getElementById('form-cat-bgColor').value = 'efe4b0';
	document.getElementById('form-cat-textColor').value = '000000';
	document.getElementById('form-cat-bgColor')._w2field?.refresh?.();
	document.getElementById('form-cat-textColor')._w2field?.refresh?.();

	$('#form-cat-description').val('');
	$('#form-cat-enableChecksum').prop('checked', false);
	$('#form-cat-displayMode').val('details');
	syncCategoryAutoAssignField('');
	$('#form-cat-attributes').find('input[type="checkbox"]').prop('checked', false);

	const grid = w2ui['categories-grid'];
	if (grid) {
		const newRow = grid.records.find(r => r._isNewRow);
		if (newRow) {
			grid.select(newRow.recid);
		} else {
			grid.selectNone();
		}
	}
}

async function updateGridAfterCategorySave(updatedCategory, isNew = false, oldName = null) {
	const gridName = 'categories-grid';
	if (!w2ui || !w2ui[gridName]) {
		await initializeCategoriesGrid();
		return;
	}

	const grid = w2ui[gridName];
	try {
		const iconUrl = await window.electronAPI.generateFolderIcon(updatedCategory.bgColor, updatedCategory.textColor);
		if (isNew) {
			// Extract the sentinel row, add the new record, then re-append sentinel
			const sentinelIdx = grid.records.findIndex(r => r._isNewRow);
			const sentinel = sentinelIdx >= 0 ? grid.records.splice(sentinelIdx, 1)[0] : null;
			const newRecid = Math.max(...grid.records.map(row => row.recid).filter(id => typeof id === 'number'), -1) + 1;
			grid.records.push({
				recid: newRecid,
				name: updatedCategory.name,
				description: updatedCategory.description || '',
				bgColor: updatedCategory.bgColor,
				textColor: updatedCategory.textColor,
				categoryName: updatedCategory.name,
				enableChecksum: updatedCategory.enableChecksum || false,
				autoAssignCategory: updatedCategory.autoAssignCategory || '',
				iconUrl,
				attributes: updatedCategory.attributes || []
			});
			if (sentinel) grid.records.push(sentinel);
			grid.refresh();
		} else {
			const recordIndex = grid.records.findIndex(row => row.categoryName === oldName);
			if (recordIndex >= 0) {
				const record = grid.records[recordIndex];
				record.name = updatedCategory.name;
				record.description = updatedCategory.description || '';
				record.bgColor = updatedCategory.bgColor;
				record.textColor = updatedCategory.textColor;
				record.categoryName = updatedCategory.name;
				record.enableChecksum = updatedCategory.enableChecksum || false;
				record.autoAssignCategory = updatedCategory.autoAssignCategory || '';
				record.iconUrl = iconUrl;
				record.attributes = updatedCategory.attributes || [];
				grid.refreshRow(record.recid);
			}
		}
	} catch (err) {
		console.error('Error updating category grid after save:', err);
		await initializeCategoriesGrid();
	}
}

export async function saveCategoryFromForm() {
	clearFormStatus('categories-form', 'form-cat-status');
	const name = $('#form-cat-name').val().trim();
	const bgColorHex = $('#form-cat-bgColor').val();
	const textColorHex = $('#form-cat-textColor').val();
	const description = $('#form-cat-description').val().trim();

	if (!name) {
		showFormError('form-cat-status', 'Category name is required.', 'form-cat-name');
		return;
	}

	// Duplicate name check
	const grid = w2ui['categories-grid'];
	if (grid) {
		const duplicate = grid.records.find(r =>
			!r._isNewRow &&
			r.categoryName !== categoryFormState.editingName &&
			r.name.toLowerCase() === name.toLowerCase()
		);
		if (duplicate) {
			showFormError('form-cat-status', `A category named "${duplicate.name}" already exists.`, 'form-cat-name');
			return;
		}
	}

	try {
		const selectedAttributes = [];
		$('#form-cat-attributes').find('input[type="checkbox"]:checked').each(function () {
			selectedAttributes.push($(this).val());
		});

		const categoryData = {
			name,
			bgColor: hexToRgb(bgColorHex),
			textColor: hexToRgb(textColorHex),
			description,
			autoAssignCategory: $('#form-cat-autoAssignCategory').val() || null,
			enableChecksum: $('#form-cat-enableChecksum').prop('checked'),
			displayMode: $('#form-cat-displayMode').val() || 'details',
			attributes: selectedAttributes
		};

		const isNew = !categoryFormState.editingName;
		const oldName = categoryFormState.editingName;

		if (isNew) {
			await window.electronAPI.saveCategory(categoryData);
		} else {
			categoryData.oldName = oldName;
			await window.electronAPI.updateCategory(oldName, categoryData);
		}

		await updateGridAfterCategorySave(categoryData, isNew, oldName);

		// Update editing state to the (possibly renamed) saved item and keep it selected
		categoryFormState.editingName = categoryData.name;
		const savedGrid = w2ui['categories-grid'];
		if (savedGrid) {
			const savedRecord = savedGrid.records.find(r => r.categoryName === categoryData.name);
			if (savedRecord) savedGrid.select(savedRecord.recid);
		}

		showFormSuccess('form-cat-status', isNew ? 'Category created.' : 'Category updated.');
	} catch (err) {
		showFormError('form-cat-status', 'Error saving category: ' + err.message);
	}
}

export async function deleteCategoryFromForm() {
	clearFormStatus('categories-form', 'form-cat-status');
	if (!categoryFormState.editingName) {
		showFormError('form-cat-status', 'Select a category first.');
		return;
	}

	if (categoryFormState.editingName === 'Default') {
		showFormError('form-cat-status', 'The Default category cannot be deleted.');
		return;
	}

	w2confirm({
		msg: `Delete the "${categoryFormState.editingName}" category?<br><br>This action cannot be undone.`,
		title: 'Delete Category',
		width: 400,
		height: 180,
		btn_yes: { text: 'Delete', class: '', style: '' },
		btn_no: { text: 'Cancel', class: '', style: '' }
	}).yes(async () => {
		try {
			const grid = w2ui['categories-grid'];
			const categoryToDelete = categoryFormState.editingName;
			await window.electronAPI.deleteCategory(categoryToDelete);
			if (grid) {
				const recordIndex = grid.records.findIndex(row => row.categoryName === categoryToDelete);
				if (recordIndex >= 0) {
					grid.remove(grid.records[recordIndex].recid);
				}
			}
			clearCategoryForm();
			showFormSuccess('form-cat-status', 'Category deleted.');
		} catch (err) {
			showFormError('form-cat-status', 'Error: ' + err.message);
		}
	});
}

async function initializeAttributesGrid() {
	const gridName = 'attributes-grid';
	if (w2ui && w2ui[gridName]) {
		w2ui[gridName].destroy();
	}

	const attrsData = await window.electronAPI.getAttributesList();
	const records = attrsData.map((attr, index) => ({
		recid: index,
		name: attr.name,
		type: attr.type || 'string',
		description: attr.description || '',
		attrName: attr.name,
		default: attr.default || '',
		options: Array.isArray(attr.options) ? attr.options.join(', ') : '',
		copyable: Boolean(attr.copyable),
		copyableLabel: attr.copyable ? 'Yes' : 'No',
		appliesTo: attr.appliesTo || 'Both',
		global: Boolean(attr.global),
		globalLabel: attr.global ? 'Yes' : 'No'
	}));

	// Persistent "(new)" sentinel row always at the end
	records.push({
		recid: 'new',
		name: '(new)',
		type: '',
		description: '',
		attrName: null,
		default: '',
		options: '',
		copyable: false,
		copyableLabel: '',
		appliesTo: '',
		global: false,
		globalLabel: '',
		_isNewRow: true
	});

	w2ui[gridName] = new w2grid({
		name: gridName,
		show: { header: false, toolbar: false, footer: false },
		columns: [
			{
				field: 'name', text: 'Name', size: '120px', resizable: true, sortable: true,
				render: record => record._isNewRow
					? `<span style="color: #aaa; font-style: italic;">(new)</span>`
					: (record.name || '')
			},
			{
				field: 'type', text: 'Type', size: '80px', resizable: true, sortable: true,
				render: record => record._isNewRow ? '' : (record.type || '')
			},
			{
				field: 'appliesTo', text: 'Applies To', size: '80px', resizable: true, sortable: true,
				render: record => record._isNewRow ? '' : (record.appliesTo || '')
			},
			{
				field: 'globalLabel', text: 'Global', size: '60px', resizable: true, sortable: true,
				render: record => record._isNewRow ? '' : (record.globalLabel || '')
			},
			{
				field: 'copyableLabel', text: 'Copy', size: '60px', resizable: true, sortable: true,
				render: record => record._isNewRow ? '' : (record.copyableLabel || '')
			},
			{
				field: 'description', text: 'Description', size: '100%', resizable: true, sortable: true,
				render: record => record._isNewRow ? '' : (record.description || '')
			}
		],
		records
	});

	w2ui[gridName].render('#attributes-grid');
	attachGridRowSelection('attributes-grid', 'form-attr-status', record => {
		if (record._isNewRow) clearAttributeForm();
		else populateAttributeForm(record);
	});

	$('#btn-attr-grid-new').off('click.attrGridNew').on('click.attrGridNew', function () {
		clearAttributeForm();
	});
}

async function initializeAttributesForm() {
	clearAttributeForm();
}

function populateAttributeForm(record) {
	attributeFormState.editingName = record.attrName;
	$('#form-attr-name').val(record.name);
	$('#form-attr-description').val(record.description || '');
	$('#form-attr-type').val(record.type || 'String');
	$('#form-attr-copyable').val(record.copyable ? 'yes' : 'no');
	$('#form-attr-applies-to').val(record.appliesTo || 'Both');
	$('#form-attr-global').val(record.global ? 'yes' : 'no');
	$('#form-attr-options-list').empty();
	const options = record.options ? record.options.split(',').map(item => item.trim()).filter(Boolean) : [];
	options.forEach(option => addAttrOption(option));
	toggleAttrOptionsSection();
	const typeLower = (record.type || '').toLowerCase();
	if (typeLower === 'selectable' || typeLower === 'yes-no' || typeLower === 'rating') {
		$('#form-attr-default-select').val(record.default || '');
	} else {
		$('#form-attr-default').val(record.default || '');
	}
}

export function clearAttributeForm() {
	attributeFormState.editingName = null;
	$('#form-attr-name').val('');
	$('#form-attr-description').val('');
	$('#form-attr-type').val('String');
	$('#form-attr-default').val('');
	$('#form-attr-copyable').val('no');
	$('#form-attr-applies-to').val('Directory');
	$('#form-attr-global').val('no');
	$('#form-attr-options-list').empty();
	updateAttrDefaultDropdown();
	toggleAttrOptionsSection();
	const grid = w2ui['attributes-grid'];
	if (grid) {
		const newRow = grid.records.find(r => r._isNewRow);
		if (newRow) {
			grid.select(newRow.recid);
		} else {
			grid.selectNone();
		}
	}
}

export function toggleAttrOptionsSection() {
	const type = $('#form-attr-type').val();
	if (type === 'Selectable') {
		$('#form-attr-options-section').css('display', 'flex');
		$('#form-attr-default').hide();
		$('#form-attr-default-select').show();
		updateAttrDefaultDropdown();
	} else if (type === 'Yes-No') {
		$('#form-attr-options-section').hide();
		$('#form-attr-default').hide();
		$('#form-attr-default-select')
			.empty()
			.append('<option value="">(none)</option>')
			.append('<option value="Yes">Yes</option>')
			.append('<option value="No">No</option>')
			.show();
	} else if (type === 'Rating') {
		$('#form-attr-options-section').hide();
		$('#form-attr-default').hide();
		const $sel = $('#form-attr-default-select').empty().append('<option value="">(none)</option>');
		['1', '2', '3', '4', '5'].forEach(n => $sel.append(`<option value="${n}">${'★'.repeat(Number(n))}</option>`));
		$sel.show();
	} else {
		$('#form-attr-options-section').hide();
		$('#form-attr-default').attr('type', type === 'Numeric' ? 'number' : 'text').show();
		$('#form-attr-default-select').hide();
	}
}

export function addAttrOption(value) {
	value = String(value).trim();
	if (!value) return;
	if (getAttrOptionValues().includes(value)) return;
	const $list = $('#form-attr-options-list');
	const safeVal = value.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	const $item = $(`<div class="attr-option-item" style="display: flex; align-items: center; gap: 4px; padding: 3px 6px; border-bottom: 1px solid #f0f0f0; font-size: 11px;">
		<span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${safeVal}</span>
		<button type="button" data-value="${safeVal}" style="background: none; border: none; cursor: pointer; color: #f44336; font-size: 13px; padding: 0 2px; line-height: 1; flex-shrink: 0;">&times;</button>
	</div>`);
	$item.find('button').on('click', function () {
		$item.remove();
		updateAttrDefaultDropdown();
	});
	$list.append($item);
	updateAttrDefaultDropdown();
}

function getAttrOptionValues() {
	const values = [];
	$('#form-attr-options-list .attr-option-item').each(function () {
		values.push($(this).find('span').text());
	});
	return values;
}

function updateAttrDefaultDropdown() {
	const options = getAttrOptionValues();
	const $select = $('#form-attr-default-select');
	const currentVal = $select.val();
	$select.empty().append('<option value="">(none)</option>');
	options.forEach(option => {
		const safeOpt = option.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		$select.append(`<option value="${safeOpt}">${safeOpt}</option>`);
	});
	if (currentVal && options.includes(currentVal)) {
		$select.val(currentVal);
	}
}

export async function saveAttributeFromForm() {
	clearFormStatus('form', 'form-attr-status');
	const name = $('#form-attr-name').val().trim();
	const description = $('#form-attr-description').val().trim();
	const type = $('#form-attr-type').val();
	const copyable = $('#form-attr-copyable').val() === 'yes';
	const appliesTo = $('#form-attr-applies-to').val() || 'Both';
	const global = $('#form-attr-global').val() === 'yes';
	let defaultVal;
	const options = type === 'Selectable' ? getAttrOptionValues() : [];

	if (type === 'Selectable' || type === 'Yes-No' || type === 'Rating') {
		defaultVal = $('#form-attr-default-select').val() || '';
	} else {
		defaultVal = $('#form-attr-default').val().trim();
	}

	if (!name) {
		showFormError('form-attr-status', 'Attribute name is required.', 'form-attr-name');
		return;
	}

	// Duplicate name check
	const grid = w2ui['attributes-grid'];
	if (grid) {
		const duplicate = grid.records.find(r =>
			!r._isNewRow &&
			r.attrName !== attributeFormState.editingName &&
			r.name.toLowerCase() === name.toLowerCase()
		);
		if (duplicate) {
			showFormError('form-attr-status', `An attribute named "${duplicate.name}" already exists.`, 'form-attr-name');
			return;
		}
	}

	const isNew = !attributeFormState.editingName;
	const attrData = { name, description, type, default: defaultVal, options, copyable, appliesTo, global };

	try {
		if (attributeFormState.editingName) {
			await window.electronAPI.updateAttribute(attributeFormState.editingName, attrData);
		} else {
			await window.electronAPI.saveAttribute(attrData);
		}
		await initializeAttributesGrid();

		// Re-select and repopulate the saved attribute (grid was fully rebuilt)
		const savedGrid = w2ui['attributes-grid'];
		if (savedGrid) {
			const savedRecord = savedGrid.records.find(r => r.attrName === attrData.name);
			if (savedRecord) {
				savedGrid.select(savedRecord.recid);
				populateAttributeForm(savedRecord);
			}
		}
		attributeFormState.editingName = attrData.name;
		showFormSuccess('form-attr-status', isNew ? 'Attribute created.' : 'Attribute updated.');
	} catch (err) {
		showFormError('form-attr-status', 'Error saving attribute: ' + err.message);
	}
}

export async function deleteAttributeFromForm() {
	clearFormStatus('form', 'form-attr-status');
	if (!attributeFormState.editingName) {
		showFormError('form-attr-status', 'Select an attribute first.');
		return;
	}
	w2confirm({
		msg: `Delete attribute "<b>${attributeFormState.editingName}</b>"?`,
		title: 'Delete Attribute?',
		width: 400,
		height: 170
	}).yes(async () => {
		try {
			await window.electronAPI.deleteAttribute(attributeFormState.editingName);
			await initializeAttributesGrid();
			clearAttributeForm();
			showFormSuccess('form-attr-status', 'Attribute deleted.');
		} catch (err) {
			showFormError('form-attr-status', 'Error: ' + err.message);
		}
	});
}

async function initializeTagsGrid() {
	const gridName = 'tags-grid';
	if (w2ui && w2ui[gridName]) {
		w2ui[gridName].destroy();
	}

	const tagsData = await window.electronAPI.getTagsList();
	const records = tagsData.map((tag, index) => ({
		recid: index,
		name: tag.name,
		description: tag.description || '',
		bgColor: tag.bgColor,
		textColor: tag.textColor,
		tagName: tag.name,
		iconUrl: null
	}));

	try {
		await Promise.all(records.map(record =>
			window.electronAPI.generateTagIcon(record.bgColor, record.textColor)
				.then(iconUrl => {
					record.iconUrl = iconUrl;
					return iconUrl;
				})
				.catch(err => {
					console.error(`Failed to generate icon for tag "${record.name}":`, err);
					return null;
				})
		));
	} catch (err) {
		console.error('Error generating tag icons:', err);
	}

	// Persistent "(new)" sentinel row always at the end
	records.push({
		recid: 'new',
		name: '(new)',
		description: '',
		bgColor: '',
		textColor: '',
		tagName: null,
		iconUrl: null,
		_isNewRow: true
	});

	w2ui[gridName] = new w2grid({
		name: gridName,
		show: { header: false, toolbar: false, footer: false },
		columns: [
			{
				field: 'icon', text: '', size: '40px', resizable: false, sortable: false, render: record => {
					if (record._isNewRow) return '';
					if (record.iconUrl) {
						return `<div style="width: 30px; height: 20px; display: inline-flex; align-items: center; justify-content: center;"><img src="${record.iconUrl}" style="width: 20px; height: 20px; object-fit: contain;"></div>`;
					}
					return `<div style="width: 30px; height: 20px; background: ${record.bgColor}; border: 1px solid ${record.textColor}; border-radius: 3px;"></div>`;
				}
			},
			{
				field: 'name', text: 'Name', size: '100px', resizable: true, sortable: true,
				render: record => record._isNewRow
					? `<span style="color: #aaa; font-style: italic;">(new)</span>`
					: (record.name || '')
			},
			{
				field: 'description', text: 'Description', size: '100%', resizable: true, sortable: true,
				render: record => record._isNewRow ? '' : (record.description || '')
			}
		],
		records
	});

	w2ui[gridName].render('#tags-grid');
	attachGridRowSelection('tags-grid', 'form-tag-status', record => {
		if (record._isNewRow) clearTagForm();
		else populateTagForm(record);
	});

	$('#btn-tag-grid-new').off('click.tagGridNew').on('click.tagGridNew', function () {
		clearTagForm();
	});
}

async function initializeTagsForm() {
	initializeColorPickers();
	clearTagForm();
	enforceTagNameInput(document.getElementById('form-tag-name'));
}

function populateTagForm(record) {
	tagFormState.editingName = record.tagName;
	$('#form-tag-name').val(record.name);

	// Set color pickers (w2field strips the # prefix)
	let bgColorHex = rgbToHex(record.bgColor).replace('#', '');
	let textColorHex = rgbToHex(record.textColor).replace('#', '');
	document.getElementById('form-tag-bgColor').value = bgColorHex;
	document.getElementById('form-tag-textColor').value = textColorHex;
	document.getElementById('form-tag-bgColor')._w2field?.refresh?.();
	document.getElementById('form-tag-textColor')._w2field?.refresh?.();

	$('#form-tag-description').val(record.description || '');
}

export function clearTagForm() {
	tagFormState.editingName = null;
	$('#form-tag-name').val('');

	// Reset color pickers (w2field stores without #)
	document.getElementById('form-tag-bgColor').value = 'efe4b0';
	document.getElementById('form-tag-textColor').value = '000000';
	document.getElementById('form-tag-bgColor')._w2field?.refresh?.();
	document.getElementById('form-tag-textColor')._w2field?.refresh?.();

	$('#form-tag-description').val('');
	const grid = w2ui['tags-grid'];
	if (grid) {
		const newRow = grid.records.find(r => r._isNewRow);
		if (newRow) {
			grid.select(newRow.recid);
		} else {
			grid.selectNone();
		}
	}
}

async function updateGridAfterTagSave(updatedTag, isNew = false, oldName = null) {
	const gridName = 'tags-grid';
	if (!w2ui || !w2ui[gridName]) {
		await initializeTagsGrid();
		return;
	}

	const grid = w2ui[gridName];
	try {
		const iconUrl = await window.electronAPI.generateTagIcon(updatedTag.bgColor, updatedTag.textColor);
		if (isNew) {
			// Extract the sentinel row, add the new record, then re-append sentinel
			const sentinelIdx = grid.records.findIndex(r => r._isNewRow);
			const sentinel = sentinelIdx >= 0 ? grid.records.splice(sentinelIdx, 1)[0] : null;
			const newRecid = Math.max(...grid.records.map(row => row.recid).filter(id => typeof id === 'number'), -1) + 1;
			grid.records.push({
				recid: newRecid,
				name: updatedTag.name,
				description: updatedTag.description || '',
				bgColor: updatedTag.bgColor,
				textColor: updatedTag.textColor,
				tagName: updatedTag.name,
				iconUrl
			});
			if (sentinel) grid.records.push(sentinel);
			grid.refresh();
		} else {
			const recordIndex = grid.records.findIndex(row => row.tagName === oldName);
			if (recordIndex >= 0) {
				const record = grid.records[recordIndex];
				record.name = updatedTag.name;
				record.description = updatedTag.description || '';
				record.bgColor = updatedTag.bgColor;
				record.textColor = updatedTag.textColor;
				record.tagName = updatedTag.name;
				record.iconUrl = iconUrl;
				grid.refreshRow(record.recid);
			}
		}
	} catch (err) {
		console.error('Error updating tag grid after save:', err);
		await initializeTagsGrid();
	}
}

export async function saveTagFromForm() {
	clearFormStatus('tags-form', 'form-tag-status');
	const name = $('#form-tag-name').val().trim();
	const bgColorHex = $('#form-tag-bgColor').val();
	const textColorHex = $('#form-tag-textColor').val();
	const description = $('#form-tag-description').val().trim();

	if (!name) {
		showFormError('form-tag-status', 'Tag name is required.', 'form-tag-name');
		return;
	}

	// Duplicate name check
	const grid = w2ui['tags-grid'];
	if (grid) {
		const duplicate = grid.records.find(r =>
			!r._isNewRow &&
			r.tagName !== tagFormState.editingName &&
			r.name.toLowerCase() === name.toLowerCase()
		);
		if (duplicate) {
			showFormError('form-tag-status', `A tag named "${duplicate.name}" already exists.`, 'form-tag-name');
			return;
		}
	}

	try {
		const tagData = {
			name,
			bgColor: hexToRgb(bgColorHex),
			textColor: hexToRgb(textColorHex),
			description
		};

		const isNew = !tagFormState.editingName;
		const oldName = tagFormState.editingName;

		if (isNew) {
			await window.electronAPI.saveTag(tagData);
		} else {
			tagData.oldName = oldName;
			await window.electronAPI.updateTag(oldName, tagData);
		}

		await updateGridAfterTagSave(tagData, isNew, oldName);

		// Update editing state to the (possibly renamed) saved item and keep it selected
		tagFormState.editingName = tagData.name;
		const savedGrid = w2ui['tags-grid'];
		if (savedGrid) {
			const savedRecord = savedGrid.records.find(r => r.tagName === tagData.name);
			if (savedRecord) savedGrid.select(savedRecord.recid);
		}

		showFormSuccess('form-tag-status', isNew ? 'Tag created.' : 'Tag updated.');
	} catch (err) {
		showFormError('form-tag-status', 'Error saving tag: ' + err.message);
	}
}

export async function deleteTagFromForm() {
	clearFormStatus('tags-form', 'form-tag-status');
	if (!tagFormState.editingName) {
		showFormError('form-tag-status', 'Select a tag first.');
		return;
	}

	w2confirm({
		msg: `Delete the "${tagFormState.editingName}" tag?<br><br>This action cannot be undone.`,
		title: 'Delete Tag',
		width: 400,
		height: 180,
		btn_yes: { text: 'Delete', class: '', style: '' },
		btn_no: { text: 'Cancel', class: '', style: '' }
	}).yes(async () => {
		try {
			const grid = w2ui['tags-grid'];
			const tagToDelete = tagFormState.editingName;
			await window.electronAPI.deleteTag(tagToDelete);
			if (grid) {
				const recordIndex = grid.records.findIndex(row => row.tagName === tagToDelete);
				if (recordIndex >= 0) {
					grid.remove(grid.records[recordIndex].recid);
				}
			}
			clearTagForm();
			showFormSuccess('form-tag-status', 'Tag deleted.');
		} catch (err) {
			showFormError('form-tag-status', 'Error: ' + err.message);
		}
	});
}

export function setupFileTypesDivider() {
	const divider = $('#filetypes-divider');
	const formPanel = $('#filetypes-form-panel');
	let isResizing = false;
	let startX = 0;
	let startWidth = 0;

	divider.mousedown(function (e) {
		isResizing = true;
		startX = e.clientX;
		startWidth = formPanel.width();
		$(document).css('user-select', 'none');
	});

	$(document).mousemove(function (e) {
		if (!isResizing) return;
		const deltaX = e.clientX - startX;
		const newWidth = Math.max(250, startWidth - deltaX);
		formPanel.css('flex', `0 0 ${newWidth}px`);
	});

	$(document).mouseup(function () {
		if (isResizing) {
			isResizing = false;
			$(document).css('user-select', '');
		}
	});
}

async function buildIconDropdown() {
	const $dropdown = $('#ft-icon-dropdown');
	$dropdown.empty();

	let icons = [];
	try {
		icons = await window.electronAPI.getFileTypeIcons();
	} catch (err) {
		console.error('Error fetching file type icons:', err);
	}

	icons.forEach(filename => {
		const $option = $('<div class="ft-icon-option" role="button" tabindex="0"></div>');
		$option.data('icon', filename);
		$option.append(`<img src="assets/icons/${filename}" style="width: 16px; height: 16px; object-fit: contain; flex-shrink: 0;">`);
		$option.append(`<span>${filename.replace('.png', '')}</span>`);

		$option.on('click', function () {
			setFtIconSelection($(this).data('icon'));
			$dropdown.hide();
		});

		$dropdown.append($option);
	});

	$('#btn-ft-icon-trigger').off('click.iconPicker').on('click.iconPicker', function (e) {
		e.stopPropagation();
		if ($dropdown.is(':visible')) {
			$dropdown.hide();
		} else {
			$dropdown.show();
		}
	});

	$(document).off('click.ftIconDropdown').on('click.ftIconDropdown', function (e) {
		if (!$(e.target).closest('#form-ft-icon-picker').length) {
			$dropdown.hide();
		}
	});
}

function setFtIconSelection(iconFile) {
	fileTypeFormState.selectedIcon = iconFile || null;

	const $preview = $('#ft-icon-preview-img');
	const $label = $('#ft-icon-label');

	if (iconFile) {
		$preview.attr('src', `assets/icons/${iconFile}`).show();
		$label.text(iconFile.replace('.png', ''));
	} else {
		$preview.hide().attr('src', '');
		$label.text('None');
	}

	$('#ft-icon-dropdown .ft-icon-option').each(function () {
		const $option = $(this);
		if ($option.data('icon') === iconFile) {
			$option.addClass('selected');
		} else {
			$option.removeClass('selected');
		}
	});
}

export async function initializeFileTypesGrid() {
	const fileTypes = await window.electronAPI.getFileTypes();

	const records = fileTypes.map((fileType, index) => ({
		recid: index + 1,
		iconHtml: `<img src="assets/icons/${fileType.icon || 'user-file.png'}" style="width: 16px; height: 16px; object-fit: contain;">`,
		lock: fileType.locked ? '🔒' : '',
		pattern: fileType.pattern,
		type: fileType.type,
		locked: fileType.locked || false,
		icon: fileType.icon || null,
		openWith: fileType.openWith || 'none'
	}));

	if (w2ui['filetypes-grid']) {
		w2ui['filetypes-grid'].destroy();
	}

	w2ui['filetypes-grid'] = new w2grid({
		name: 'filetypes-grid',
		show: { header: false, toolbar: false, footer: false },
		columns: [
			{ field: 'iconHtml', text: '', size: '30px', resizable: false, style: 'text-align: center; padding: 0 4px;' },
			{ field: 'lock', text: '', size: '26px', resizable: false, style: 'text-align: center; padding: 0;' },
			{ field: 'pattern', text: 'Pattern', size: '50%', resizable: true, sortable: true },
			{ field: 'type', text: 'Type', size: '100%', resizable: true, sortable: true }
		],
		records,
		onClick: function (event) {
			event.onComplete = function () {
				const grid = this;
				const selection = grid.getSelection();
				if (selection.length > 0) {
					const record = grid.records.find(row => row.recid === selection[0]);
					if (record) {
						populateFileTypeForm(record);
					}
				}
			};
		},
		onLoad: function (event) { event.preventDefault(); }
	});

	w2ui['filetypes-grid'].render('#filetypes-grid');
}

function populateFileTypeForm(record) {
	fileTypeFormState.editingPattern = record.pattern;
	$('#form-ft-pattern').val(record.pattern).prop('disabled', record.locked);
	$('#form-ft-type').val(record.type).prop('disabled', record.locked);
	setFtIconSelection(record.icon || 'user-file.png');
	$('#form-ft-open-with').val(record.openWith || 'os-default').prop('disabled', record.locked);
	$('#btn-ft-icon-trigger').prop('disabled', record.locked);
	if (record.locked) {
		$('#btn-ft-delete').hide();
		$('#btn-ft-save').prop('disabled', true);
	} else {
		$('#btn-ft-delete').show();
		$('#btn-ft-save').prop('disabled', false);
	}
}

export function clearFileTypeForm() {
	fileTypeFormState.editingPattern = null;
	$('#form-ft-pattern').val('').prop('disabled', false);
	$('#form-ft-type').val('').prop('disabled', false);
	setFtIconSelection('user-file.png');
	$('#form-ft-open-with').val('os-default').prop('disabled', false);
	$('#btn-ft-icon-trigger').prop('disabled', false);
	$('#btn-ft-delete').show();
	$('#btn-ft-save').prop('disabled', false);

	const grid = w2ui['filetypes-grid'];
	if (grid) grid.selectNone();
}

export async function initializeFileTypesForm() {
	await buildIconDropdown();
	clearFileTypeForm();
}

export async function saveFileTypeFromForm() {
	clearFormStatus('form', 'form-ft-status');
	const pattern = $('#form-ft-pattern').val().trim();
	const type = $('#form-ft-type').val().trim();

	if (!pattern || !type) {
		showFormError('form-ft-status', 'Pattern and Type are required.');
		return;
	}

	try {
		if (fileTypeFormState.editingPattern) {
			const result = await window.electronAPI.updateFileType(
				fileTypeFormState.editingPattern,
				pattern,
				type,
				fileTypeFormState.selectedIcon || null,
				$('#form-ft-open-with').val() || 'os-default'
			);
			if (result && result.error) {
				showFormError('form-ft-status', 'Error: ' + result.error);
				return;
			}
		} else {
			const result = await window.electronAPI.addFileType(
				pattern,
				type,
				fileTypeFormState.selectedIcon || null,
				$('#form-ft-open-with').val() || 'os-default'
			);
			if (result && result.error) {
				showFormError('form-ft-status', 'Error: ' + result.error);
				return;
			}
		}

		await initializeFileTypesGrid();
		clearFileTypeForm();
		showFormSuccess('form-ft-status', 'File type saved.');
	} catch (err) {
		showFormError('form-ft-status', 'Error saving file type: ' + err.message);
	}
}

export async function deleteFileTypeFromForm() {
	clearFormStatus('form', 'form-ft-status');
	const pattern = fileTypeFormState.editingPattern;
	if (!pattern) {
		showFormError('form-ft-status', 'Select a file type first.');
		return;
	}

	w2confirm({
		msg: `Delete file type "<b>${pattern}</b>"?`,
		title: 'Delete File Type?',
		width: 400,
		height: 170
	}).yes(async () => {
		try {
			const result = await window.electronAPI.deleteFileType(pattern);
			if (result && result.error) {
				showFormError('form-ft-status', 'Error: ' + result.error);
				return;
			}
			await initializeFileTypesGrid();
			clearFileTypeForm();
			showFormSuccess('form-ft-status', 'File type deleted.');
		} catch (err) {
			showFormError('form-ft-status', 'Error: ' + err.message);
		}
	});
}

function formatHotkeyDisplay(combo) {
	if (!combo) return '';
	return combo.split('+').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('+');
}

export async function initializeHotkeysGrid() {
	const gridName = 'hotkeys-grid';

	if (w2ui && w2ui[gridName]) {
		w2ui[gridName].destroy();
	}

	const hotkeyData = await window.electronAPI.getHotkeys();
	const records = [];
	let recid = 0;

	for (const [context, actions] of Object.entries(hotkeyData)) {
		for (const [actionId, actionData] of Object.entries(actions)) {
			records.push({
				recid: recid++,
				context,
				action: actionData.label,
				hotkey: actionData.key,
				actionId,
				defaultKey: actionData.default,
				locked: actionData.locked || false
			});
		}
	}

	w2ui[gridName] = new w2grid({
		name: gridName,
		show: { header: false, toolbar: false, footer: false },
		columns: [
			{ field: 'lock', text: '', size: '28px', resizable: false, sortable: false, render: record => record.locked ? '<span title="Locked — cannot be rebound">🔒</span>' : '' },
			{ field: 'context', text: 'Context', size: '130px', resizable: true, sortable: true },
			{ field: 'action', text: 'Action', size: '150px', resizable: true, sortable: true },
			{ field: 'hotkey', text: 'Hotkey', size: '100%', resizable: true, sortable: false, render: record => formatHotkeyDisplay(record.hotkey) }
		],
		records,
		onClick: function (event) {
			event.onComplete = function () {
				const grid = this;
				const selection = grid.getSelection();
				if (selection.length > 0) {
					const record = grid.records.find(row => row.recid === selection[0]);
					if (record) {
						populateHotkeysForm(record);
					}
				}
			};
		}
	});

	w2ui[gridName].render('#hotkeys-grid');
	w2ui[gridName].selectNone();
	w2ui[gridName].refresh();
	w2ui[gridName].resize();
}

function populateHotkeysForm(record) {
	$('#form-hotkey-context').val(record.context);
	$('#form-hotkey-action').val(record.action);
	$('#form-hotkey-current').val(record.hotkey);
	$('#hotkeys-form').data('currentRecord', record);
	$('#hotkey-demo-section').hide();
	$('#form-hotkey-demo').val('');
	if (record.locked) {
		$('#btn-hotkey-demo').hide();
		$('#btn-hotkey-save').hide();
		$('#hotkey-locked-indicator').show();
	} else {
		$('#btn-hotkey-demo').text('Edit').show();
		$('#btn-hotkey-save').hide();
		$('#hotkey-locked-indicator').hide();
	}
}

async function initializeHotkeysForm() {
	return Promise.resolve();
}

export function enterHotkeyDemoMode() {
	const $demoSection = $('#hotkey-demo-section');
	const $demoInput = $('#form-hotkey-demo');
	const $editButton = $('#btn-hotkey-demo');
	const $saveButton = $('#btn-hotkey-save');

	$demoSection.show();
	$saveButton.show();
	$demoInput.val('Press a key combination...').css('color', '#999').focus();
	$editButton.text('Cancel').css('background', '#f44336');

	let isCapturing = true;
	let capturedCombo = '';

	const keydownHandler = function (event) {
		if (!isCapturing) return;

		if (event.key === 'Meta' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Shift') {
			return;
		}

		event.preventDefault();

		const combo = getHotKeyCombo(event);
		capturedCombo = combo;
		$demoInput.val(combo).css('color', '#333');
		$('#hotkeys-form').data('capturedCombo', combo);
	};

	const cancelHandler = function () {
		isCapturing = false;
		cancelHotkeyDemo();
		$(document).off('keydown.hotkeyDemo');
		$editButton.off('click.hotkeyCancel');
	};

	$editButton.on('click.hotkeyCancel', cancelHandler);
	$(document).on('keydown.hotkeyDemo', keydownHandler);
	$('#hotkeys-form').data('capturedCombo', capturedCombo);
}

function cancelHotkeyDemo() {
	$('#hotkey-demo-section').hide();
	$('#form-hotkey-demo').val('');
	$('#btn-hotkey-demo').text('Edit').css('background', '#2196F3');
	$('#btn-hotkey-save').hide();
	$('#hotkeys-form').removeData('capturedCombo');
	$(document).off('keydown.hotkeyDemo');
	$('#btn-hotkey-demo').off('click.hotkeyCancel');
}

export async function saveHotkeyFromForm() {
	const record = $('#hotkeys-form').data('currentRecord');
	const capturedCombo = $('#hotkeys-form').data('capturedCombo');

	if (!record || !capturedCombo) {
		alert('No hotkey captured. Please use Edit mode to capture a new hotkey.');
		return;
	}

	if (record.locked) {
		alert('This hotkey is locked and cannot be rebound.');
		return;
	}

	try {
		const hotkeyData = await window.electronAPI.getHotkeys();
		const context = record.context;

		for (const [actionId, actionData] of Object.entries(hotkeyData[context])) {
			if (actionId !== record.actionId && actionData.key === capturedCombo) {
				const shouldOverride = await new Promise(resolve => {
					w2confirm({
						msg: `This hotkey is already assigned to "${actionData.label}" in the "${context}" context.<br><br>Do you want to override it?`,
						title: 'Hotkey Conflict',
						width: 420,
						height: 200,
						btn_yes: { text: 'Override', class: '', style: '' },
						btn_no: { text: 'Cancel', class: '', style: '' }
					}).yes(() => resolve(true)).no(() => resolve(false));
				});

				if (!shouldOverride) {
					throw new Error('Hotkey conflict - operation cancelled');
				}

				actionData.key = capturedCombo;
				break;
			}
		}

		hotkeyData[record.context][record.actionId].key = capturedCombo;

		const result = await window.electronAPI.saveHotkeys(hotkeyData);
		if (!result.success) {
			throw new Error(result.error || 'Failed to save hotkeys');
		}

		await loadHotkeysFromStorage();

		const grid = w2ui['hotkeys-grid'];
		if (grid) {
			const gridRecord = grid.records.find(row => row.actionId === record.actionId);
			if (gridRecord) {
				gridRecord.hotkey = capturedCombo;
				grid.refreshRow(gridRecord.recid);
			}
		}

		$('#form-hotkey-current').val(capturedCombo);
		cancelHotkeyDemo();
		alert('Hotkey saved successfully!');
	} catch (err) {
		alert('Error saving hotkey: ' + err.message);
	}
}

export async function resetHotkeyToDefault() {
	const record = $('#hotkeys-form').data('currentRecord');
	if (!record) {
		alert('Please select a hotkey to reset');
		return;
	}

	if (record.locked) {
		alert('This hotkey is locked and cannot be changed.');
		return;
	}

	w2confirm({
		msg: `Reset "${record.action}" hotkey to ${record.defaultKey}?`,
		title: 'Reset Hotkey',
		width: 380,
		height: 160,
		btn_yes: { text: 'Reset', class: '', style: '' },
		btn_no: { text: 'Cancel', class: '', style: '' }
	}).yes(async () => {
		try {
			const hotkeyData = await window.electronAPI.getHotkeys();
			hotkeyData[record.context][record.actionId].key = record.defaultKey;

			const result = await window.electronAPI.saveHotkeys(hotkeyData);
			if (!result.success) {
				throw new Error(result.error || 'Failed to save hotkeys');
			}

			await loadHotkeysFromStorage();

			const grid = w2ui['hotkeys-grid'];
			if (grid) {
				const gridRecord = grid.records.find(row => row.actionId === record.actionId);
				if (gridRecord) {
					gridRecord.hotkey = record.defaultKey;
					grid.refreshRow(gridRecord.recid);
				}
			}

			record.hotkey = record.defaultKey;
			$('#form-hotkey-current').val(record.defaultKey);
			cancelHotkeyDemo();
			alert('Hotkey reset successfully!');
		} catch (err) {
			alert('Error resetting hotkey: ' + err.message);
		}
	});
}

function getHotKeyCombo(event) {
	const parts = [];
	if (event.ctrlKey) parts.push('ctrl');
	if (event.altKey) parts.push('alt');
	if (event.shiftKey) parts.push('shift');
	if (event.metaKey) parts.push('meta');

	let key = event.key;
	if (key.length === 1) {
		key = key.toLowerCase();
	}

	if (key === ' ') key = 'space';
	if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) {
		return parts.join('+');
	}

	parts.push(key);
	return parts.join('+');
}

// ============================================
// Custom Actions Tab
// ============================================

export function setupCustomActionsDivider() {
	const divider = $('#custom-actions-divider');
	const formPanel = $('#custom-actions-form-panel');
	let isResizing = false;
	let startX = 0;
	let startWidth = 0;

	divider.off('mousedown.caDivider').on('mousedown.caDivider', function (event) {
		isResizing = true;
		startX = event.clientX;
		startWidth = formPanel.width();
		$(document).css('user-select', 'none');
	});

	$(document).off('mousemove.caDivider').on('mousemove.caDivider', function (event) {
		if (!isResizing) return;
		const newWidth = Math.max(280, startWidth - (event.clientX - startX));
		formPanel.css('flex', `0 0 ${newWidth}px`);
	});

	$(document).off('mouseup.caDivider').on('mouseup.caDivider', function () {
		if (isResizing) {
			isResizing = false;
			$(document).css('user-select', '');
		}
	});
}

export async function initializeCustomActionsGrid() {
	const actions = await window.electronAPI.getCustomActions();

	const records = actions.map((action, index) => ({
		recid: index + 1,
		id: action.id,
		label: action.label,
		executable: action.executable,
		args: (action.args || []).join(' '),
		filePatterns: (action.filePatterns || []).join(' '),
		executionMode: action.executionMode || 'silent',
		timeoutSeconds: normalizeCustomActionTimeout(action.timeoutSeconds),
		checksum: action.checksum || null,
		checksumUpdatedAt: action.checksumUpdatedAt || null
	}));

	if (w2ui['custom-actions-grid']) {
		w2ui['custom-actions-grid'].destroy();
	}

	w2ui['custom-actions-grid'] = new w2grid({
		name: 'custom-actions-grid',
		show: { header: false, toolbar: false, footer: false },
		columns: [
			{ field: 'label', text: 'Label', size: '40%', resizable: true, sortable: true },
			{ field: 'executable', text: 'Executable', size: '60%', resizable: true, sortable: true }
		],
		records,
		onClick: function (event) {
			event.onComplete = function () {
				const selection = this.getSelection();
				if (selection.length > 0) {
					const record = this.records.find(row => row.recid === selection[0]);
					if (record) populateCustomActionsForm(record);
				}
			};
		},
		onLoad: function (event) {
			event.preventDefault();
		}
	});

	w2ui['custom-actions-grid'].render('#custom-actions-grid');
	w2ui['custom-actions-grid'].selectNone();
	w2ui['custom-actions-grid'].refresh();
	w2ui['custom-actions-grid'].resize();
}

function populateCustomActionsForm(record) {
	customActionFormState.editingId = record.id;
	$('#form-ca-label').val(record.label);
	$('#form-ca-executable').val(record.executable);
	$('#form-ca-args').val(record.args || '');
	$('#form-ca-patterns').val(record.filePatterns || '');
	$('#form-ca-timeout').val(normalizeCustomActionTimeout(record.timeoutSeconds));
	updateCustomActionExecutionFields(record.executionMode);
	updateChecksumDisplay(record);
}

function updateChecksumDisplay(record) {
	const $section = $('#form-ca-checksum-section');
	const $status = $('#form-ca-checksum-status');
	const ext = (record.executable || '').split('.').pop().toLowerCase();
	const scriptExts = ['bat', 'cmd', 'sh', 'py'];

	if (!scriptExts.includes(ext)) {
		$section.hide();
		return;
	}

	$section.css('display', 'flex');
	if (record.checksum) {
		const updated = record.checksumUpdatedAt
			? new Date(record.checksumUpdatedAt).toLocaleString()
			: 'unknown';
		$status.text(`SHA-256: ${record.checksum.substring(0, 16)}...  (recorded ${updated})`);
	} else {
		$status.text('No checksum recorded - will be computed on Save.');
	}
}

export function clearCustomActionsForm() {
	customActionFormState.editingId = null;
	$('#form-ca-label').val('');
	$('#form-ca-executable').val('');
	$('#form-ca-args').val('');
	$('#form-ca-patterns').val('');
	$('#form-ca-timeout').val(DEFAULT_CUSTOM_ACTION_TIMEOUT_SECONDS);
	updateCustomActionExecutionFields('silent');
	$('#form-ca-checksum-section').hide();
	$('#form-ca-checksum-status').text('');

	const grid = w2ui['custom-actions-grid'];
	if (grid) grid.selectNone();
}

export async function initializeCustomActionsForm() {
	clearCustomActionsForm();

	$('#btn-ca-browse').off('click.caBrowse').on('click.caBrowse', async function () {
		const picked = await window.electronAPI.pickFile({
			filters: [
				{ name: 'Executable or Script', extensions: ['exe', 'bat', 'cmd', 'sh', 'py', '*'] }
			]
		});
		if (picked) {
			$('#form-ca-executable').val(picked);
			updateChecksumDisplay({ executable: picked, checksum: null, checksumUpdatedAt: null });
		}
	});

	$('#btn-ca-save').off('click.caSave').on('click.caSave', () => saveCustomActionFromForm());
	$('#btn-ca-clear').off('click.caClear').on('click.caClear', () => clearCustomActionsForm());
	$('#btn-ca-delete').off('click.caDelete').on('click.caDelete', () => deleteCustomActionFromForm());
	$('#form-ca-execution-mode').off('change.caMode').on('change.caMode', function () {
		updateCustomActionExecutionFields($(this).val());
	});
}

export async function saveCustomActionFromForm() {
	const label = $('#form-ca-label').val().trim();
	const executable = $('#form-ca-executable').val().trim();
	const argsRaw = $('#form-ca-args').val().trim();
	const patternsRaw = $('#form-ca-patterns').val().trim();
	const executionMode = $('#form-ca-execution-mode').val() === 'terminal' ? 'terminal' : 'silent';
	const timeoutSeconds = normalizeCustomActionTimeout($('#form-ca-timeout').val());

	if (!label || !executable) {
		w2alert('Label and Executable Path are required.');
		return;
	}

	const args = argsRaw ? argsRaw.match(/(?:[^\s"]+|"[^"]*")+/g) || [] : [];
	const cleanArgs = args.map(arg => arg.replace(/^"|"$/g, ''));
	const filePatterns = patternsRaw ? patternsRaw.split(/\s+/).filter(Boolean) : [];
	const id = customActionFormState.editingId || `ca-${Date.now()}`;

	try {
		const result = await window.electronAPI.saveCustomAction({
			id,
			label,
			executable,
			args: cleanArgs,
			filePatterns,
			executionMode,
			timeoutSeconds
		});

		if (!result.success) {
			w2alert('Error: ' + result.error);
			return;
		}

		await initializeCustomActionsGrid();
		const saved = result.action;
		customActionFormState.editingId = saved.id;
		updateChecksumDisplay(saved);

		const grid = w2ui['custom-actions-grid'];
		const savedRecord = grid?.records.find(record => record.id === saved.id);
		if (savedRecord) {
			grid.select(savedRecord.recid);
			populateCustomActionsForm(savedRecord);
		}
	} catch (err) {
		w2alert('Error saving custom action: ' + err.message);
	}
}

export async function deleteCustomActionFromForm() {
	const id = customActionFormState.editingId;
	if (!id) {
		w2alert('No action selected.');
		return;
	}

	const label = $('#form-ca-label').val().trim() || id;
	w2confirm({
		msg: `Delete custom action "<b>${label}</b>"?`,
		title: 'Delete Custom Action?',
		width: 400,
		height: 170
	}).yes(async () => {
		try {
			const result = await window.electronAPI.deleteCustomAction(id);
			if (result && result.error) {
				w2alert('Error: ' + result.error);
				return;
			}

			await initializeCustomActionsGrid();
			clearCustomActionsForm();
		} catch (err) {
			w2alert('Error deleting custom action: ' + err.message);
		}
	});
}

// ============================================
// Auto Labels Tab
// ============================================

let autoLabelFormState = { editingId: null };

function setupAutoLabelDivider() {
	setupFormDivider('#auto-label-divider', '#auto-label-form-panel');
}

async function initializeAutoLabelsGrid() {
	const gridName = 'auto-labels-grid';
	if (w2ui && w2ui[gridName]) w2ui[gridName].destroy();

	const [result, catsData, tagsData] = await Promise.all([
		window.electronAPI.loadAutoLabels(),
		window.electronAPI.loadCategories().catch(() => ({})),
		window.electronAPI.getTagsList().catch(() => [])
	]);
	const rulesMap = (result && result.success) ? (result.data || {}) : {};
	const catsMap = catsData || {};
	const tagsMap = {};
	(tagsData || []).forEach(t => { tagsMap[t.name] = t; });

	// Build records with async effect HTML
	const ruleList = Object.values(rulesMap);
	const records = [];
	for (let index = 0; index < ruleList.length; index++) {
		const rule = ruleList[index];
		let effectHtml = '';
		if (!rule._isNewRow && rule.applyType && rule.applyValue) {
			if (rule.applyType === 'category') {
				const cat = catsMap[rule.applyValue] || null;
				if (cat) {
					const iconUrl = await window.electronAPI.generateFolderIcon(cat.bgColor, cat.textColor, null).catch(() => null);
					effectHtml = iconUrl
						? `<span style="display:inline-flex;align-items:center;gap:4px;"><img src="${iconUrl}" style="width:18px;height:18px;object-fit:contain;flex-shrink:0;">${rule.applyValue}</span>`
						: `<span style="display:inline-flex;align-items:center;gap:4px;">&#128193;${rule.applyValue}</span>`;
				} else {
					effectHtml = `<span style="display:inline-flex;align-items:center;gap:4px;">&#128193;${rule.applyValue}</span>`;
				}
			} else {
				const tag = tagsMap[rule.applyValue] || null;
				if (tag) {
					const tagIconUrl = await window.electronAPI.generateTagIcon(tag.bgColor, tag.textColor).catch(() => null);
					const tagIconHtml = tagIconUrl ? `<img src="${tagIconUrl}" style="width:16px;height:16px;object-fit:contain;flex-shrink:0;">` : '';
					effectHtml = `<span style="display:inline-flex;align-items:center;gap:4px;">${tagIconHtml}${rule.applyValue}</span>`;
				} else {
					effectHtml = `<span style="display:inline-flex;align-items:center;gap:4px;">${rule.applyValue}</span>`;
				}
			}
		}
		records.push({
			recid: index,
			ruleId: rule.id,
			name: rule.name || '',
			description: rule.description || '',
			effect: effectHtml,
			_rule: rule
		});
	}

	records.push({
		recid: 'new',
		ruleId: null,
		name: '(new)',
		description: '',
		effect: '',
		_rule: null,
		_isNewRow: true
	});

	w2ui[gridName] = new w2grid({
		name: gridName,
		show: { header: false, toolbar: false, footer: false },
		columns: [
			{
				field: 'name', text: 'Name', size: '140px', resizable: true, sortable: true,
				render: record => record._isNewRow
					? `<span style="color:#aaa;font-style:italic;">(new)</span>`
					: (record.name || '')
			},
			{
				field: 'effect', text: 'Effect', size: '160px', resizable: true, sortable: false,
				render: record => record._isNewRow ? '' : (record.effect || '')
			},
			{
				field: 'description', text: 'Description', size: '100%', resizable: true, sortable: true,
				render: record => record._isNewRow ? '' : (record.description || '')
			}
		],
		records
	});

	w2ui[gridName].render('#auto-labels-grid');
	attachGridRowSelection('auto-labels-grid', 'form-al-status', record => {
		if (record._isNewRow) clearAutoLabelForm();
		else populateAutoLabelForm(record._rule);
	});

	$('#btn-auto-label-grid-new').off('click.alGridNew').on('click.alGridNew', function () {
		clearAutoLabelForm();
	});
}

function clearAutoLabelForm() {
	autoLabelFormState.editingId = null;
	$('#form-al-name').val('');
	$('#form-al-description').val('');
	$('#form-al-id').text('');
	$('input[name="form-al-applyType"][value="tag"]').prop('checked', true);
	refreshAutoLabelApplyDropdown('tag');
	$('#form-al-patterns-list').empty();
	clearFormStatus(null, 'form-al-status');
	$('#btn-al-delete').prop('disabled', true).css('opacity', 0.4);
}

function _setAlIconSelDisplay($wrap, val, placeholder) {
	placeholder = placeholder || '-- Select --';
	$wrap.find('.cat-icon-select-option').removeClass('cat-icon-select-option-selected');
	const $icon = $wrap.find('.cat-icon-select-icon');
	$icon.empty();
	$wrap.find('.cat-icon-select-text').text(val || placeholder);
	if (val) {
		const $selectedOpt = $wrap.find('.cat-icon-select-option').filter(function () { return $(this).data('value') === val; });
		if ($selectedOpt.length) {
			$selectedOpt.addClass('cat-icon-select-option-selected');
			const $img = $selectedOpt.find('img');
			if ($img.length) $img.clone().appendTo($icon);
		}
	}
}

async function refreshAutoLabelApplyDropdown(type) {
	const $hidden = $('#form-al-apply-value');
	const $wrap = $('#form-al-apply-value-wrap');
	const $optionsEl = $('#form-al-apply-value-options');
	$hidden.val('');
	$optionsEl.empty().hide();

	const makeOpt = (value, iconUrl, label) => {
		const $opt = $('<div class="cat-icon-select-option"></div>').attr('data-value', value);
		const $iconSpan = $('<span class="cat-icon-select-opt-icon"></span>');
		if (iconUrl) $('<img>').attr({ src: iconUrl, style: 'width:16px;height:16px;object-fit:contain;vertical-align:middle;' }).appendTo($iconSpan);
		$opt.append($iconSpan);
		$opt.append($('<span class="cat-icon-select-opt-text"></span>').text(label));
		return $opt;
	};

	$optionsEl.append(makeOpt('', null, '-- Select --'));
	if (type === 'tag') {
		const tagsList = await window.electronAPI.getTagsList();
		for (const t of (tagsList || [])) {
			const iconUrl = await window.electronAPI.generateTagIcon(t.bgColor, t.textColor).catch(() => null);
			$optionsEl.append(makeOpt(t.name, iconUrl, t.name));
		}
	} else {
		const catsList = await window.electronAPI.getCategoriesList();
		for (const c of (catsList || [])) {
			const iconUrl = await window.electronAPI.generateFolderIcon(c.bgColor, c.textColor, null).catch(() => null);
			$optionsEl.append(makeOpt(c.name, iconUrl, c.name));
		}
	}
	_setAlIconSelDisplay($wrap, '', '-- Select --');
}

function populateAutoLabelForm(rule) {
	autoLabelFormState.editingId = rule.id;
	$('#form-al-name').val(rule.name || '');
	$('#form-al-description').val(rule.description || '');
	$('#form-al-id').text(rule.id || '');
	const applyType = rule.applyType || 'tag';
	$(`input[name="form-al-applyType"][value="${applyType}"]`).prop('checked', true);
	refreshAutoLabelApplyDropdown(applyType).then(() => {
		const val = rule.applyValue || '';
		$('#form-al-apply-value').val(val);
		_setAlIconSelDisplay($('#form-al-apply-value-wrap'), val, '-- Select --');
	});
	renderAllPatternRows(rule.patterns || []);
	clearFormStatus(null, 'form-al-status');
	$('#btn-al-delete').prop('disabled', false).css('opacity', 1);
}

function renderAllPatternRows(patterns) {
	const $list = $('#form-al-patterns-list');
	$list.empty();
	patterns.forEach((p, i) => renderPatternRow(p, i));
}

function renderPatternRow(pattern, index) {
	const target = pattern.target || 'self';
	const conditionType = pattern.conditionType || 'hasCategory';
	const required = !!pattern.required;
	const normalizePaths = !!pattern.normalizePathSeparators;
	const caseInsensitive = !!pattern.caseInsensitive;

	const rowHtml = `
		<div class="al-pattern-row" data-index="${index}" style="border:1px solid #ddd;border-radius:4px;padding:8px;background:#fafafa;">
			<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
				<select class="al-pat-target" style="padding:4px;border:1px solid #ccc;border-radius:3px;font-size:11px;">
					<option value="self" ${target === 'self' ? 'selected' : ''}>Self</option>
					<option value="parent" ${target === 'parent' ? 'selected' : ''}>Parent</option>
				</select>
				<select class="al-pat-condtype" style="padding:4px;border:1px solid #ccc;border-radius:3px;font-size:11px;">
					<option value="hasCategory" ${conditionType === 'hasCategory' ? 'selected' : ''}>Has Category</option>
					<option value="hasTags" ${conditionType === 'hasTags' ? 'selected' : ''}>Has Tags (any)</option>
					<option value="hasAttribute" ${conditionType === 'hasAttribute' ? 'selected' : ''}>Has Attribute</option>
					<option value="nameMatchesRegex" ${conditionType === 'nameMatchesRegex' ? 'selected' : ''}>Name matches regex</option>
					<option value="pathMatchesRegex" ${conditionType === 'pathMatchesRegex' ? 'selected' : ''}>Path matches regex</option>
				</select>
				<label style="font-size:11px;display:flex;align-items:center;gap:3px;cursor:pointer;">
					<input type="checkbox" class="al-pat-required" ${required ? 'checked' : ''}> Required
				</label>
				<button type="button" class="al-pat-remove" style="margin-left:auto;padding:2px 8px;background:#f44336;color:white;border:none;border-radius:3px;cursor:pointer;font-size:11px;">✕</button>
			</div>
			<div class="al-pat-value-area" style="margin-top:6px;"></div>
		</div>
	`;
	$('#form-al-patterns-list').append(rowHtml);
	const $row = $('#form-al-patterns-list .al-pattern-row').last();
	renderPatternValueArea($row, conditionType, pattern.value, normalizePaths, caseInsensitive);
	wirePatternRowEvents($row);
}

async function renderPatternValueArea($row, conditionType, value, normalizePaths, caseInsensitive = false) {
	const $area = $row.find('.al-pat-value-area');
	$area.empty();

	if (conditionType === 'hasCategory') {
		const catsList = await window.electronAPI.getCategoriesList();
		const $widgetWrap = $('<div class="cat-icon-select al-icon-sel" style="width:100%;font-size:11px;"></div>');
		const $hidden = $('<input type="hidden" class="al-pat-value-single">').val(value || '');
		const $trigger = $('<div class="cat-icon-select-trigger"><span class="cat-icon-select-icon"></span><span class="cat-icon-select-text">-- Select category --</span><span class="cat-icon-select-chevron">▼</span></div>');
		const $opts = $('<div class="cat-icon-select-options" style="display:none;z-index:600;"></div>');
		const makeOpt = (val, iconUrl, label) => {
			const $opt = $('<div class="cat-icon-select-option"></div>').attr('data-value', val);
			const $iconSpan = $('<span class="cat-icon-select-opt-icon"></span>');
			if (iconUrl) $('<img>').attr({ src: iconUrl, style: 'width:16px;height:16px;object-fit:contain;vertical-align:middle;' }).appendTo($iconSpan);
			$opt.append($iconSpan).append($('<span class="cat-icon-select-opt-text"></span>').text(label));
			return $opt;
		};
		$opts.append(makeOpt('', null, '-- Select category --'));
		for (const c of (catsList || [])) {
			const iconUrl = await window.electronAPI.generateFolderIcon(c.bgColor, c.textColor, null).catch(() => null);
			$opts.append(makeOpt(c.name, iconUrl, c.name));
		}
		$widgetWrap.append($hidden).append($trigger).append($opts);
		$area.empty().append($widgetWrap);
		_setAlIconSelDisplay($widgetWrap, value || '', '-- Select category --');

	} else if (conditionType === 'hasTags') {
		const tagsList = await window.electronAPI.getTagsList();
		const selectedTags = Array.isArray(value) ? value : (value ? [value] : []);
		const $list = $('<div style="max-height:110px;overflow-y:auto;border:1px solid #ccc;border-radius:3px;padding:4px;display:flex;flex-direction:column;gap:2px;background:#fff;"></div>');
		for (const t of (tagsList || [])) {
			const checked = selectedTags.includes(t.name);
			const iconUrl = await window.electronAPI.generateTagIcon(t.bgColor, t.textColor).catch(() => null);
			const $label = $('<label style="font-size:11px;display:flex;align-items:center;gap:5px;cursor:pointer;padding:2px 4px;border-radius:2px;"></label>');
			if (checked) $label.css('background', '#e3eef9');
			const $cb = $('<input type="checkbox" class="al-pat-tag-checkbox">').val(t.name).prop('checked', checked);
			$label.append($cb);
			if (iconUrl) $label.append($('<img>').attr({ src: iconUrl, style: 'width:14px;height:14px;object-fit:contain;flex-shrink:0;' }));
			$label.append($('<span></span>').text(t.name));
			$list.append($label);
		}
		$area.empty().append($list).append($('<span style="font-size:10px;color:#888;">Check to select multiple</span>'));

	} else if (conditionType === 'hasAttribute') {
		const attrsList = await window.electronAPI.getAttributesList();
		const attrVal = (typeof value === 'object' && value) ? value : { attr: '', attrValue: '' };
		let opts = '<option value="">-- Select attribute --</option>';
		(attrsList || []).forEach(a => {
			opts += `<option value="${a.name}" ${attrVal.attr === a.name ? 'selected' : ''}>${a.name}</option>`;
		});
		$area.html(`
			<div style="display:flex;gap:6px;align-items:center;">
				<select class="al-pat-attr-name" style="flex:1;padding:4px;border:1px solid #ccc;border-radius:3px;font-size:11px;">${opts}</select>
				<span style="font-size:11px;">=</span>
				<input type="text" class="al-pat-attr-value" value="${attrVal.attrValue || ''}" placeholder="value (blank=empty)" style="flex:1;padding:4px;border:1px solid #ccc;border-radius:3px;font-size:11px;">
			</div>
		`);

	} else if (conditionType === 'nameMatchesRegex') {
		const strVal = (typeof value === 'string') ? value : '';
		$area.html(`
			<input type="text" class="al-pat-value-single" value="${strVal.replace(/"/g, '&quot;')}" placeholder="Regular expression" style="width:100%;box-sizing:border-box;padding:4px;border:1px solid #ccc;border-radius:3px;font-size:11px;margin-bottom:4px;">
			<label style="font-size:11px;display:flex;align-items:center;gap:4px;cursor:pointer;">
				<input type="checkbox" class="al-pat-case-insensitive" ${caseInsensitive ? 'checked' : ''}> Case insensitive
			</label>
		`);

	} else if (conditionType === 'pathMatchesRegex') {
		const strVal = (typeof value === 'string') ? value : '';
		$area.html(`
			<input type="text" class="al-pat-value-single" value="${strVal.replace(/"/g, '&quot;')}" placeholder="Regular expression" style="width:100%;box-sizing:border-box;padding:4px;border:1px solid #ccc;border-radius:3px;font-size:11px;margin-bottom:4px;">
			<label style="font-size:11px;display:flex;align-items:center;gap:4px;cursor:pointer;">
				<input type="checkbox" class="al-pat-case-insensitive" ${caseInsensitive ? 'checked' : ''}> Case insensitive
			</label>
			<label style="font-size:11px;display:flex;align-items:center;gap:4px;cursor:pointer;">
				<input type="checkbox" class="al-pat-normalize-paths" ${normalizePaths ? 'checked' : ''}> Normalize to Unix-style separators (/)
			</label>
		`);
	}
}

function wirePatternRowEvents($row) {
	$row.find('.al-pat-condtype').on('change', function () {
		renderPatternValueArea($row, $(this).val(), null, false, false);
	});
	$row.find('.al-pat-remove').on('click', function () {
		$row.remove();
	});
}

function collectAutoLabelFormData() {
	const name = $('#form-al-name').val().trim();
	const description = $('#form-al-description').val().trim();
	const applyType = $('input[name="form-al-applyType"]:checked').val() || 'tag';
	const applyValue = $('#form-al-apply-value').val() || '';

	const patterns = [];
	$('#form-al-patterns-list .al-pattern-row').each(function () {
		const $row = $(this);
		const target = $row.find('.al-pat-target').val();
		const conditionType = $row.find('.al-pat-condtype').val();
		const required = $row.find('.al-pat-required').is(':checked');
		const normalizePaths = $row.find('.al-pat-normalize-paths').is(':checked');
		const caseInsensitive = $row.find('.al-pat-case-insensitive').is(':checked');

		let value = null;
		if (conditionType === 'hasTags') {
			const selected = [];
			$row.find('.al-pat-tag-checkbox:checked').each(function () { selected.push($(this).val()); });
			value = selected;
		} else if (conditionType === 'hasAttribute') {
			value = {
				attr: $row.find('.al-pat-attr-name').val() || '',
				attrValue: $row.find('.al-pat-attr-value').val() || ''
			};
		} else {
			value = $row.find('.al-pat-value-single').val() || '';
		}

		patterns.push({ target, conditionType, value, required, normalizePathSeparators: normalizePaths, caseInsensitive });
	});

	return { name, description, applyType, applyValue, patterns };
}

$(document).on('click', '#btn-al-save', async function () {
	const data = collectAutoLabelFormData();
	if (!data.name) {
		showFormError(null, 'form-al-status', 'Name is required.');
		return;
	}
	if (data.patterns.length === 0) {
		showFormError(null, 'form-al-status', 'At least one pattern is required.');
		return;
	}
	if (!data.applyValue) {
		showFormError(null, 'form-al-status', 'Please select a label to apply.');
		return;
	}
	try {
		let result;
		if (autoLabelFormState.editingId) {
			result = await window.electronAPI.updateAutoLabel(autoLabelFormState.editingId, data);
		} else {
			result = await window.electronAPI.createAutoLabel(data);
		}
		if (!result.success) throw new Error(result.error || 'Save failed');
		if (!autoLabelFormState.editingId && result.data) {
			autoLabelFormState.editingId = result.data.id;
			$('#form-al-id').text(result.data.id);
		}
		showFormSuccess(null, 'form-al-status', 'Saved.');
		await initializeAutoLabelsGrid();
	} catch (err) {
		showFormError(null, 'form-al-status', 'Error: ' + err.message);
	}
});

$(document).on('click', '#btn-al-delete', async function () {
	if (!autoLabelFormState.editingId) return;
	const id = autoLabelFormState.editingId;
	try {
		const result = await window.electronAPI.deleteAutoLabel(id);
		if (!result.success) throw new Error(result.error || 'Delete failed');
		clearAutoLabelForm();
		await initializeAutoLabelsGrid();
	} catch (err) {
		showFormError(null, 'form-al-status', 'Error: ' + err.message);
	}
});

$(document).on('click', '#btn-al-add-pattern', function () {
	const index = $('#form-al-patterns-list .al-pattern-row').length;
	renderPatternRow({ target: 'self', conditionType: 'hasCategory', value: '', required: false }, index);
});

$(document).on('change', 'input[name="form-al-applyType"]', function () {
	const type = $(this).val();
	refreshAutoLabelApplyDropdown(type);
});

// Generic al-icon-sel widget interaction
$(document).on('click.alIconSel', '.al-icon-sel .cat-icon-select-trigger', function (e) {
	e.stopPropagation();
	const $wrap = $(this).closest('.al-icon-sel');
	if ($wrap.hasClass('cat-icon-select-disabled')) return;
	const $opts = $wrap.find('> .cat-icon-select-options');
	$('.al-icon-sel .cat-icon-select-options').not($opts).hide();
	$opts.toggle();
});

$(document).on('click.alIconSelOpt', '.al-icon-sel .cat-icon-select-option', function (e) {
	e.stopPropagation();
	const $opt = $(this);
	const $wrap = $opt.closest('.al-icon-sel');
	const val = $opt.data('value');
	$wrap.find('input[type="hidden"]:first').val(val);
	_setAlIconSelDisplay($wrap, val);
	$wrap.find('> .cat-icon-select-options').hide();
});

$(document).on('click.alIconSelClose', function (e) {
	if (!$(e.target).closest('.al-icon-sel').length) {
		$('.al-icon-sel .cat-icon-select-options').hide();
	}
});
// ── Updates Tab ─────────────────────────────────────────────────────────────

export async function initializeUpdatesTab() {
	// Show current app version
	try {
		const version = await window.electronAPI.getAppVersion();
		$('#updates-current-version').text(version);
	} catch (_) {}

	// Load update settings
	try {
		const s = await window.electronAPI.getSettings();
		$('#updates-auto-check-enabled').prop('checked', s.auto_update_check_enabled !== false);
		$('#updates-auto-check-interval').val(s.auto_update_check_interval_hours || 24);
	} catch (_) {}

	$('#btn-check-updates').off('click.updatesCheck').on('click.updatesCheck', async function () {
		$('#updates-check-status').css('color', '#555').text('Checking for updates...');
		$(this).prop('disabled', true);
		try {
			const result = await window.electronAPI.checkForUpdates();
			if (result && result.success === false) {
				$('#updates-check-status').css('color', '#d32f2f').text('Error: ' + (result.error || 'Unknown error'));
			}
			// Status will be updated via onUpdateAvailable / onUpdateNotAvailable events
		} catch (err) {
			$('#updates-check-status').css('color', '#d32f2f').text('Error: ' + err.message);
		} finally {
			$(this).prop('disabled', false);
		}
	});

	$('#btn-save-update-settings').off('click.updatesSave').on('click.updatesSave', async function () {
		try {
			const enabled = $('#updates-auto-check-enabled').is(':checked');
			let interval = parseInt($('#updates-auto-check-interval').val() || '24');
			if (isNaN(interval) || interval < 1) interval = 1;
			if (interval > 168) interval = 168;
			$('#updates-auto-check-interval').val(interval);

			const settings = await window.electronAPI.getSettings();
			settings.auto_update_check_enabled = enabled;
			settings.auto_update_check_interval_hours = interval;
			const result = await window.electronAPI.saveSettings(settings);
			if (result && result.success === false) throw new Error(result.error || 'Save failed');
			showFormSuccess('updates-settings-status', 'Settings saved.');
		} catch (err) {
			showFormError('updates-settings-status', 'Error: ' + err.message);
		}
	});

	$('#btn-restart-to-update').off('click.updatesRestart').on('click.updatesRestart', () => {
		window.electronAPI.quitAndInstall();
	});
}

// ── Update Notification Banner ──────────────────────────────────────────────

export function initializeUpdateBanner() {
	if (!window.electronAPI) return;

	function showBanner() { $('#update-banner').css('display', 'flex'); }
	function hideBanner() { $('#update-banner').hide(); }

	window.electronAPI.onUpdateAvailable((data) => {
		$('#update-banner-msg').text(`Update ${data.version} is available.`);
		$('#update-banner-progress').hide();
		$('#btn-update-banner-action').text('Download').show();
		$('#btn-update-banner-dismiss').show();
		$('#updates-check-status').css('color', '#1565C0').text(`Update ${data.version} available – click Download in the banner.`);
		showBanner();
	});

	window.electronAPI.onUpdateNotAvailable(() => {
		$('#updates-check-status').css('color', '#388e3c').text('You are running the latest version.');
	});

	window.electronAPI.onUpdateDownloadProgress((progress) => {
		const pct = Math.round(progress.percent || 0);
		$('#update-banner-msg').text(`Downloading update…`);
		$('#update-banner-progress').css('display', 'flex');
		$('#update-banner-bar').css('width', pct + '%');
		$('#update-banner-pct').text(pct + '%');
		$('#btn-update-banner-action').hide();
		$('#updates-progress-bar').css('width', pct + '%');
		$('#updates-download-section').css('display', 'flex');
		const mbTransferred = ((progress.transferred || 0) / 1048576).toFixed(1);
		const mbTotal = ((progress.total || 0) / 1048576).toFixed(1);
		$('#updates-progress-text').text(`${mbTransferred} / ${mbTotal} MB`);
		showBanner();
	});

	window.electronAPI.onUpdateDownloaded((data) => {
		$('#update-banner-msg').text(`Update ${data.version} ready to install.`);
		$('#update-banner-progress').hide();
		$('#btn-update-banner-action').text('Restart Now').show();
		$('#btn-update-banner-dismiss').show();
		$('#btn-restart-to-update').show();
		showBanner();
	});

	window.electronAPI.onUpdateError((msg) => {
		$('#updates-check-status').css('color', '#d32f2f').text('Update error: ' + msg);
		hideBanner();
	});

	$(document).off('click.bannerAction').on('click.bannerAction', '#btn-update-banner-action', function () {
		const label = $(this).text();
		if (label === 'Download') {
			$(this).prop('disabled', true).text('Downloading…');
			window.electronAPI.downloadUpdate();
		} else if (label === 'Restart Now') {
			window.electronAPI.quitAndInstall();
		}
	});

	$(document).off('click.bannerDismiss').on('click.bannerDismiss', '#btn-update-banner-dismiss', function () {
		hideBanner();
	});
}