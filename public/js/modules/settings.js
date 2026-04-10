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
import { w2ui, w2grid, w2confirm, w2alert } from './vendor/w2ui.es6.min.js';
import {
	panelState,
	loadHotkeysFromStorage
} from '../renderer.js';

let initializedSettingsTabs = new Set();
let initializedTaggingTabs = new Set();

let categoryFormState = {
	editingName: null
};

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

export async function showTaggingModal() {
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
}

export function switchSettingsTab(tabName) {
	$('.settings-tab-content').hide();

	const $tab = $(`#tab-${tabName}`);
	if (tabName === 'filetypes' || tabName === 'hotkeys') {
		$tab.css('display', 'flex');

		if (tabName === 'filetypes' && !initializedSettingsTabs.has('filetypes')) {
			initializedSettingsTabs.add('filetypes');
			initializeFileTypesGrid().then(() => initializeFileTypesForm()).then(() => setupFileTypesDivider());
		} else if (tabName === 'hotkeys' && !initializedSettingsTabs.has('hotkeys')) {
			initializedSettingsTabs.add('hotkeys');
			initializeHotkeysGrid().then(() => initializeHotkeysForm()).then(() => setupHotkeysResizableDivider());
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
			if (attrList && attrList.length > 0) {
				attrList.forEach(attr => {
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
	const recordHeight = settings.record_height || 30;
	const backgroundRefreshEnabled = settings.background_refresh_enabled || false;
	const backgroundRefreshInterval = settings.background_refresh_interval || 30;

	$('#browser-home-directory').val(homeDirectory);
	$('#browser-notes-format').val(fileFormat);
	$('#browser-hide-dot-directory').prop('checked', hideDotDirectory);
	$('#browser-hide-dot-dot-directory').prop('checked', hideDotDotDirectory);
	$('#browser-show-folder-name-with-dot-entries').prop('checked', showFolderNameWithDotEntries);
	$('#browser-record-height').val(recordHeight);
	$('#browser-background-refresh-enabled').prop('checked', backgroundRefreshEnabled);
	$('#browser-background-refresh-interval').val(backgroundRefreshInterval).prop('disabled', !backgroundRefreshEnabled);

	await updateHomeDirectoryWarning(homeDirectory);
	updateRecordHeightPreview();
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

export function updateRecordHeightPreview() {
	const recordHeight = parseInt($('#browser-record-height').val() || '30');

	if (w2ui['preview-record-height-grid']) {
		w2ui['preview-record-height-grid'].destroy();
	}

	const previewRecords = [
		{ recid: 1, filename: 'example-file-1.pdf', size: '2.4 MB', modified: '2026-03-25' },
		{ recid: 2, filename: 'project-folder', size: '--', modified: '2026-03-28' },
		{ recid: 3, filename: 'document.txt', size: '45 KB', modified: '2026-03-20' },
		{ recid: 4, filename: 'image.jpg', size: '1.8 MB', modified: '2026-03-15' },
		{ recid: 5, filename: 'archive.zip', size: '156 MB', modified: '2026-03-10' }
	];

	$('#record-height-preview-grid').w2grid({
		name: 'preview-record-height-grid',
		columns: [
			{ field: 'filename', text: 'Filename', size: '60%', resizable: true },
			{ field: 'size', text: 'Size', size: '20%', resizable: true },
			{ field: 'modified', text: 'Modified', size: '20%', resizable: true }
		],
		records: previewRecords,
		recordHeight,
		show: {
			header: true,
			toolbar: false,
			footer: false
		}
	});
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
		let recordHeight = parseInt($('#browser-record-height').val() || '30');
		const backgroundRefreshEnabled = $('#browser-background-refresh-enabled').is(':checked');
		let backgroundRefreshInterval = parseInt($('#browser-background-refresh-interval').val() || '30');

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

		const settings = await window.electronAPI.getSettings();
		settings.home_directory = homeDirectory;
		settings.file_format = fileFormat;
		settings.hide_dot_directory = hideDotDirectory;
		settings.hide_dot_dot_directory = hideDotDotDirectory;
		settings.record_height = recordHeight;
		settings.background_refresh_enabled = backgroundRefreshEnabled;
		settings.background_refresh_interval = backgroundRefreshInterval;
		settings.show_folder_name_with_dot_entries = showFolderNameWithDotEntries;

		const result = await window.electronAPI.saveSettings(settings);
		if (!result || result.success === false) {
			throw new Error(result?.error || 'Unable to save settings');
		}

		await updateHomeDirectoryWarning(homeDirectory);
		updateRecordHeightPreview();
		panels.applyRecordHeightToAllGrids(recordHeight);

		alert('All browser settings saved successfully');

		window.electronAPI.startBackgroundRefresh(backgroundRefreshEnabled, backgroundRefreshInterval);

		const state = panelState[panels.activePanelId];
		if (state && state.currentPath) {
			await panels.navigateToDirectory(state.currentPath, panels.activePanelId);
		}
	} catch (err) {
		alert('Error saving browser settings: ' + err.message);
	}
}

let fileTypeFormState = {
	editingPattern: null,
	selectedIcon: null
};

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

	w2ui[gridName] = new w2grid({
		name: gridName,
		show: { header: false, toolbar: false, footer: false },
		columns: [
			{
				field: 'icon', text: '', size: '40px', resizable: false, sortable: false, render: record => {
					if (record.iconUrl) {
						return `<div style="width: 30px; height: 20px; display: inline-flex; align-items: center; justify-content: center;"><img src="${record.iconUrl}" style="width: 20px; height: 20px; object-fit: contain;"></div>`;
					}
					return `<div style="width: 30px; height: 20px; background: ${record.bgColor}; border: 1px solid ${record.textColor}; border-radius: 3px;"></div>`;
				}
			},
			{ field: 'name', text: 'Name', size: '100px', resizable: true, sortable: true },
			{ field: 'description', text: 'Description', size: '100%', resizable: true, sortable: true }
		],
		records,
		onClick: function (event) {
			event.onComplete = function () {
				const selection = this.getSelection();
				if (selection.length > 0) {
					const record = this.records.find(row => row.recid === selection[0]);
					if (record) {
						populateCategoryForm(record);
					}
				}
			};
		}
	});

	w2ui[gridName].render('#categories-grid');
}

async function initializeCategoriesForm() {
	try {
		const attrList = await window.electronAPI.getAttributesList();
		const $container = $('#form-cat-attributes');
		$container.empty();
		if (attrList && attrList.length > 0) {
			attrList.forEach(attr => {
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
	clearCategoryForm();
}

function populateCategoryForm(record) {
	categoryFormState.editingName = record.categoryName;
	$('#form-cat-name').val(record.name);
	$('#form-cat-bgColor').val(rgbToHex(record.bgColor));
	$('#form-cat-textColor').val(rgbToHex(record.textColor));
	$('#form-cat-description').val(record.description || '');
	$('#form-cat-enableChecksum').prop('checked', record.enableChecksum || false);
	const selectedAttrs = record.attributes || [];
	$('#form-cat-attributes').find('input[type="checkbox"]').each(function () {
		$(this).prop('checked', selectedAttrs.includes($(this).val()));
	});
}

export function clearCategoryForm() {
	categoryFormState.editingName = null;
	$('#form-cat-name').val('');
	$('#form-cat-bgColor').val('#efe4b0');
	$('#form-cat-textColor').val('#000000');
	$('#form-cat-description').val('');
	$('#form-cat-enableChecksum').prop('checked', false);
	$('#form-cat-attributes').find('input[type="checkbox"]').prop('checked', false);

	const grid = w2ui['categories-grid'];
	if (grid) {
		grid.selectNone();
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
			const newRecid = Math.max(...grid.records.map(row => row.recid), -1) + 1;
			grid.add({
				recid: newRecid,
				name: updatedCategory.name,
				description: updatedCategory.description || '',
				bgColor: updatedCategory.bgColor,
				textColor: updatedCategory.textColor,
				categoryName: updatedCategory.name,
				enableChecksum: updatedCategory.enableChecksum || false,
				iconUrl,
				attributes: updatedCategory.attributes || []
			});
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
	const name = $('#form-cat-name').val().trim();
	const bgColorHex = $('#form-cat-bgColor').val();
	const textColorHex = $('#form-cat-textColor').val();
	const description = $('#form-cat-description').val().trim();

	if (!name) {
		alert('Please enter a category name');
		return;
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
			enableChecksum: $('#form-cat-enableChecksum').prop('checked'),
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
		clearCategoryForm();
		alert(isNew ? 'Category created successfully!' : 'Category updated successfully!');
	} catch (err) {
		alert('Error saving category: ' + err.message);
	}
}

export async function deleteCategoryFromForm() {
	if (!categoryFormState.editingName) {
		alert('Please select a category to delete');
		return;
	}

	if (categoryFormState.editingName === 'Default') {
		alert('Cannot delete the Default category');
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
			alert('Category deleted successfully!');
		} catch (err) {
			alert('Error deleting category: ' + err.message);
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
		options: Array.isArray(attr.options) ? attr.options.join(', ') : ''
	}));

	w2ui[gridName] = new w2grid({
		name: gridName,
		show: { header: false, toolbar: false, footer: false },
		columns: [
			{ field: 'name', text: 'Name', size: '120px', resizable: true, sortable: true },
			{ field: 'type', text: 'Type', size: '80px', resizable: true, sortable: true },
			{ field: 'description', text: 'Description', size: '100%', resizable: true, sortable: true }
		],
		records,
		onClick: function (event) {
			event.onComplete = function () {
				const selection = this.getSelection();
				if (selection.length > 0) {
					const record = this.records.find(row => row.recid === selection[0]);
					if (record) populateAttributeForm(record);
				}
			};
		}
	});

	w2ui[gridName].render('#attributes-grid');
}

async function initializeAttributesForm() {
	clearAttributeForm();
}

function populateAttributeForm(record) {
	attributeFormState.editingName = record.attrName;
	$('#form-attr-name').val(record.name);
	$('#form-attr-description').val(record.description || '');
	$('#form-attr-type').val(record.type || 'String');
	$('#form-attr-options-list').empty();
	const options = record.options ? record.options.split(',').map(item => item.trim()).filter(Boolean) : [];
	options.forEach(option => addAttrOption(option));
	toggleAttrOptionsSection();
	if ((record.type || '').toLowerCase() === 'selectable') {
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
	$('#form-attr-options-list').empty();
	updateAttrDefaultDropdown();
	toggleAttrOptionsSection();
	const grid = w2ui['attributes-grid'];
	if (grid) grid.selectNone();
}

export function toggleAttrOptionsSection() {
	const type = $('#form-attr-type').val();
	if (type === 'Selectable') {
		$('#form-attr-options-section').css('display', 'flex');
		$('#form-attr-default').hide();
		$('#form-attr-default-select').show();
		updateAttrDefaultDropdown();
	} else {
		$('#form-attr-options-section').hide();
		$('#form-attr-default').show();
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
	const name = $('#form-attr-name').val().trim();
	const description = $('#form-attr-description').val().trim();
	const type = $('#form-attr-type').val();
	let defaultVal;
	const options = type === 'Selectable' ? getAttrOptionValues() : [];

	if (type === 'Selectable') {
		defaultVal = $('#form-attr-default-select').val() || '';
	} else {
		defaultVal = $('#form-attr-default').val().trim();
	}

	if (!name) {
		alert('Please enter an attribute name.');
		return;
	}

	const attrData = { name, description, type, default: defaultVal, options };

	try {
		if (attributeFormState.editingName) {
			await window.electronAPI.updateAttribute(attributeFormState.editingName, attrData);
		} else {
			await window.electronAPI.saveAttribute(attrData);
		}
		await initializeAttributesGrid();
		clearAttributeForm();
		alert(attributeFormState.editingName ? 'Attribute updated!' : 'Attribute created!');
		attributeFormState.editingName = null;
	} catch (err) {
		alert('Error saving attribute: ' + err.message);
	}
}

export async function deleteAttributeFromForm() {
	if (!attributeFormState.editingName) {
		alert('Please select an attribute to delete.');
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
			alert('Attribute deleted.');
		} catch (err) {
			alert('Error deleting attribute: ' + err.message);
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

	w2ui[gridName] = new w2grid({
		name: gridName,
		show: { header: false, toolbar: false, footer: false },
		columns: [
			{
				field: 'icon', text: '', size: '40px', resizable: false, sortable: false, render: record => {
					if (record.iconUrl) {
						return `<div style="width: 30px; height: 20px; display: inline-flex; align-items: center; justify-content: center;"><img src="${record.iconUrl}" style="width: 20px; height: 20px; object-fit: contain;"></div>`;
					}
					return `<div style="width: 30px; height: 20px; background: ${record.bgColor}; border: 1px solid ${record.textColor}; border-radius: 3px;"></div>`;
				}
			},
			{ field: 'name', text: 'Name', size: '100px', resizable: true, sortable: true },
			{ field: 'description', text: 'Description', size: '100%', resizable: true, sortable: true }
		],
		records,
		onClick: function (event) {
			event.onComplete = function () {
				const selection = this.getSelection();
				if (selection.length > 0) {
					const record = this.records.find(row => row.recid === selection[0]);
					if (record) {
						populateTagForm(record);
					}
				}
			};
		}
	});

	w2ui[gridName].render('#tags-grid');
}

async function initializeTagsForm() {
	clearTagForm();
}

function populateTagForm(record) {
	tagFormState.editingName = record.tagName;
	$('#form-tag-name').val(record.name);
	$('#form-tag-bgColor').val(rgbToHex(record.bgColor));
	$('#form-tag-textColor').val(rgbToHex(record.textColor));
	$('#form-tag-description').val(record.description || '');
}

export function clearTagForm() {
	tagFormState.editingName = null;
	$('#form-tag-name').val('');
	$('#form-tag-bgColor').val('#efe4b0');
	$('#form-tag-textColor').val('#000000');
	$('#form-tag-description').val('');
	const grid = w2ui['tags-grid'];
	if (grid) {
		grid.selectNone();
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
		const iconUrl = await window.electronAPI.generateFolderIcon(updatedTag.bgColor, updatedTag.textColor);
		if (isNew) {
			const newRecid = Math.max(...grid.records.map(row => row.recid), -1) + 1;
			grid.add({
				recid: newRecid,
				name: updatedTag.name,
				description: updatedTag.description || '',
				bgColor: updatedTag.bgColor,
				textColor: updatedTag.textColor,
				tagName: updatedTag.name,
				iconUrl
			});
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
	const name = $('#form-tag-name').val().trim();
	const bgColorHex = $('#form-tag-bgColor').val();
	const textColorHex = $('#form-tag-textColor').val();
	const description = $('#form-tag-description').val().trim();

	if (!name) {
		alert('Please enter a tag name');
		return;
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
		clearTagForm();
		alert(isNew ? 'Tag created successfully!' : 'Tag updated successfully!');
	} catch (err) {
		alert('Error saving tag: ' + err.message);
	}
}

export async function deleteTagFromForm() {
	if (!tagFormState.editingName) {
		alert('Please select a tag to delete');
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
			alert('Tag deleted successfully!');
		} catch (err) {
			alert('Error deleting tag: ' + err.message);
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
	$('#form-ft-open-with').val(record.openWith || 'none').prop('disabled', record.locked);
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
	$('#form-ft-open-with').val('none').prop('disabled', false);
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
	const pattern = $('#form-ft-pattern').val().trim();
	const type = $('#form-ft-type').val().trim();

	if (!pattern || !type) {
		w2alert('Pattern and Type are required.');
		return;
	}

	try {
		if (fileTypeFormState.editingPattern) {
			const result = await window.electronAPI.updateFileType(
				fileTypeFormState.editingPattern,
				pattern,
				type,
				fileTypeFormState.selectedIcon || null,
				$('#form-ft-open-with').val() || 'none'
			);
			if (result && result.error) {
				w2alert('Error: ' + result.error);
				return;
			}
		} else {
			const result = await window.electronAPI.addFileType(
				pattern,
				type,
				fileTypeFormState.selectedIcon || null,
				$('#form-ft-open-with').val() || 'none'
			);
			if (result && result.error) {
				w2alert('Error: ' + result.error);
				return;
			}
		}

		await initializeFileTypesGrid();
		clearFileTypeForm();
	} catch (err) {
		w2alert('Error saving file type: ' + err.message);
	}
}

export async function deleteFileTypeFromForm() {
	const pattern = fileTypeFormState.editingPattern;
	if (!pattern) {
		w2alert('No file type selected.');
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
				w2alert('Error: ' + result.error);
				return;
			}
			await initializeFileTypesGrid();
			clearFileTypeForm();
		} catch (err) {
			w2alert('Error deleting file type: ' + err.message);
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
