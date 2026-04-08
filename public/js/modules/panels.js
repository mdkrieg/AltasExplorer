/**
 * Panels Module
 * Handles panel state, grid management, navigation, layout, and item properties.
 */

import * as sidebar from './sidebar.js';
import * as utils from './utils.js';
import { w2grid, w2ui, w2confirm, w2alert } from './vendor/w2ui.es6.min.js';
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
	showFileView,
	hideFileView,
	toggleFileEditMode,
	openImageViewerModal,
	buildCompleteFileState,
	formatHistoryData,
	formatFileContent,
	openTodoModal
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

export function setVisiblePanels(value) {
	visiblePanels = value;
}

export function setUnacknowledgedAlertCount(value) {
	unacknowledgedAlertCount = value;
}

export function resetAlertCount() {
	unacknowledgedAlertCount = 0;
}

function updateGridHeader(panelId, path) {
	const gridName = `grid-panel-${panelId}`;
	const headerEl = document.getElementById(`grid_${gridName}_header`);
	if (!headerEl) return;

	let buttonsHtml = `
		<button class="btn-panel-parent" style="padding: 4px 8px; margin-right: 5px;">←  Parent</button>
	`;

	if (panelId === 1) {
		buttonsHtml += `<button id="btn-add-panel" style="padding: 4px 8px; background: #4CAF50; color: white; border: none; font-weight: bold; border-radius: 4px;">+</button>`;
	}

	if (panelId > 1) {
		buttonsHtml += `<button class="btn-panel-remove" style="padding: 4px 8px; background: #f44336; color: white; border: none; font-weight: bold;">-</button>`;
	}

	const headerHtml = `
		<div style="display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 8px 12px; background: #f0f0f0; border-bottom: 1px solid #e0e0e0;">
			<span class="panel-path" style="font-weight: bold; font-size: 12px; cursor: pointer; user-select: none;">${path}</span>
			<input class="panel-path-input" type="text" value="${path}" style="display: none; font-weight: bold; font-size: 12px; padding: 4px; border: 1px solid #2196F3; border-radius: 4px; font-family: inherit; flex: 1; max-width: 60%; margin-right: 8px;">
			<div style="display: flex; gap: 4px;">
				${buttonsHtml}
			</div>
		</div>
	`;

	headerEl.innerHTML = headerHtml;
	attachGridHeaderEventListeners(panelId);
}

function attachGridHeaderEventListeners(panelId) {
	const $header = $(`#grid_grid-panel-${panelId}_header`);

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

	$header.find('.btn-panel-parent').off('click').on('click', function () {
		setActivePanelId(panelId);
		const state = panelState[panelId];
		if (state.currentPath && state.currentPath.length > 3) {
			const parentPath = state.currentPath.substring(0, state.currentPath.lastIndexOf('\\'));
			if (parentPath.length >= 2) {
				navigateToDirectory(parentPath, panelId);
			}
		}
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

		$header.find('#btn-add-panel').off('click').on('click', function () {
			if (visiblePanels < 4) {
				visiblePanels++;
				const newPanelId = visiblePanels;
				$(`#panel-${newPanelId}`).show();
				attachPanelEventListeners(newPanelId);
				updatePanelLayout();
			}
		});
	}

	if (panelId > 1) {
		$header.find('.btn-panel-remove').off('click').on('click', function () {
			removePanel(panelId);
		});
	}
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
	if (!tagsJson) return '';
	let names;
	try { names = JSON.parse(tagsJson); } catch { return ''; }
	if (!Array.isArray(names) || names.length === 0) return '';
	const badges = names.map(name => {
		const def = tagDefs[name];
		const bg = def ? def.bgColor : '#888';
		const fg = def ? def.textColor : '#fff';
		return `<span class="tag-badge" style="background:${bg};color:${fg}">${name}</span>`;
	});
	return `<div class="tag-badge-container">${badges.join('')}</div>`;
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
		records.push({
			recid: state.recidCounter++,
			icon: applyClass(`<img src="${iconUrl}" style="width: 20px; height: 20px; object-fit: contain; cursor: pointer;" title="Click to set initials">`, className),
			filename: applyClass(folder.displayFilename || folder.filename, className),
			filenameRaw: folder.filename,
			size: applyClass('-', className),
			dateModified: applyClass(new Date(folder.dateModified).toLocaleString(), className),
			modified: -new Date(folder.dateModified).getTime(),
			perms: applyClass(getPermsCell(folder), className),
			checksum: applyClass('—', className),
			tags: renderTagBadges(folder.tags || null, tagDefs),
			tagsRaw: folder.tags || null,
			type: applyClass(folder.changeState === 'moved' ? '' : (cat ? cat.name || '' : ''), className),
			isFolder: true,
			path: folder.path,
			changeState: folder.changeState,
			inode: folder.inode,
			initials: folder.initials || null,
			dir_id: null,
			orphan_id: folder.orphan_id || null,
			new_dir_id: folder.new_dir_id || null,
			hasNotes: folder.hasNotes || false,
			todo: folder.todoCounts || null
		});
	}

	for (const file of files) {
		const className = getRowClassName(file.changeState);

		if (file.changeState === 'permError') {
			const iconSvg = '<img src="assets/icons/file-question.png" style="width: 20px; height: 20px; object-fit: contain;">';
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
	const grid = panelState[panelId].w2uiGrid;
	if (!grid) return;
	grid.add(records);
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
			.filter(e => e.filename !== '.')
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
			const subdirs = rawEntries.filter(e => e.isDirectory && e.filename !== '.');
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
		const subdirs = rootRaw.filter(e => e.isDirectory && e.filename !== '.');
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

export async function navigateToDirectory(dirPath, panelId = activePanelId, addToHistory = true) {
	try {
		if (!dirPath || typeof dirPath !== 'string') {
			throw new Error('Path must be a non-empty string');
		}
		let normalizedPath = dirPath.trim();
		if (!normalizedPath) {
			throw new Error('Path cannot be empty');
		}
		if (normalizedPath.length === 2 && normalizedPath[1] === ':') {
			normalizedPath += '\\';
		}

		const state = panelState[panelId];
		if (state.scanInProgress) {
			state.scanCancelled = true;
			state.pendingDirs = [];
		}

		const previousPath = state.currentPath;
		state.currentPath = normalizedPath;
		if (normalizedPath !== previousPath) {
			state.depth = 0;
			const depthInput = document.getElementById(`depth-input-${panelId}`);
			if (depthInput) depthInput.value = 0;
		}
		if (addToHistory) {
			state.navigationHistory = state.navigationHistory.slice(0, state.navigationIndex + 1);
			state.navigationHistory.push(dirPath);
			state.navigationIndex = state.navigationHistory.length - 1;
		}
		if (panelId === 1) sidebar.updateSidebarSelection(normalizedPath);

		const directoryExists = await window.electronAPI.isDirectory(normalizedPath);
		if (!directoryExists) {
			state.currentCategory = null;
			setPanelPathValidity(panelId, false);
			showMissingDirectoryRecord(panelId);
			updateGridHeader(panelId, normalizedPath);
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

		const category = await window.electronAPI.getCategoryForDirectory(normalizedPath);
		const prevCategory = state.currentCategory;
		state.currentCategory = category;
		const prevAttrs = JSON.stringify((prevCategory && prevCategory.attributes) || []);
		const newAttrs = JSON.stringify((category && category.attributes) || []);
		if (prevAttrs !== newAttrs) {
			await initializeGridForPanel(panelId);
		}

		if (panelId === activePanelId && category) {
			const dotEntry = (scanResult.entries || []).find(e => e.filename === '.' && e.isDirectory);
			const currentDirInitials = dotEntry ? (dotEntry.initials || null) : null;
			await window.electronAPI.updateWindowIcon(category.name, currentDirInitials);
		}

		const entries = scanResult.success ? scanResult.entries : [];
		const depth = panelState[panelId].depth || 0;
		if (depth > 0) {
			await scanDirectoryTreeStreaming(normalizedPath, depth, panelId);
		} else {
			await populateFileGrid(entries, category, panelId);
		}

		updateGridHeader(panelId, normalizedPath);
		const gridToResize = panelState[panelId].w2uiGrid;
		if (gridToResize) {
			requestAnimationFrame(() => {
				const toolbarEl = document.getElementById(`grid_${gridToResize.name}_toolbar`);
				if (toolbarEl && toolbarEl.style.height === '0px') {
					toolbarEl.style.height = '';
				}
				gridToResize.resize();
			});
		}

		panelState[panelId].hasBeenViewed = true;
		window.electronAPI.registerWatchedPath(panelId, normalizedPath);

		if (category && category.enableChecksum) {
			const grid = panelState[panelId].w2uiGrid;
			const filesToChecksum = grid.records.filter(r => !r.isFolder && r.changeState === 'checksumPending');
			if (filesToChecksum.length > 0) {
				const queueIdle = !state.checksumQueue || state.checksumCancelled || state.checksumQueueIndex >= state.checksumQueue.length;
				if (queueIdle) {
					startChecksumQueue(filesToChecksum, panelId, dirPath);
				}
			}
		}
	} catch (err) {
		console.error('Error navigating to directory:', err);
		alert('Error accessing directory: ' + err.message);
	}
}

function setPanelPathValidity(panelId, isValid) {
	const $path = $(`#panel-${panelId} .panel-path`);
	if (isValid) {
		$path.css('color', '');
	} else {
		$path.css('color', '#c62828');
	}
}

function showMissingDirectoryRecord(panelId) {
	const grid = panelState[panelId].w2uiGrid;
	if (!grid) return;
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

	if (w2ui && w2ui[gridName]) {
		w2ui[gridName].destroy();
	}

	const recordHeight = await getRecordHeight();
	const state = panelState[panelId];
	const columns = [
		{ field: 'icon', text: '', size: '40px', resizable: false, sortable: false, hideable: false },
		{ field: 'filename', text: 'Name', size: '50%', resizable: true, sortable: true, hideable: false },
		{ field: 'type', text: 'Type', size: '80px', resizable: true, sortable: true },
		{ field: 'size', text: 'Size', size: '60px', resizable: true, sortable: true, align: 'right' },
		{ field: 'dateModified', text: 'Date Modified', size: '150px', resizable: true, sortable: true, hidden: true },
		{
			field: 'modified', text: 'Modified', size: '70px', resizable: true, sortable: true, render: (record) => {
				if (!record.modified) return '-';
				const ts = -record.modified;
				const fullDate = new Date(ts).toLocaleString();
				const ago = formatTimeAgo(ts);
				return `<span title="${fullDate}" style="cursor: help;">${ago}</span>`;
			}
		},
		{ field: 'dateCreated', text: 'Date Created', size: '150px', resizable: true, sortable: true, hidden: !state.showDateCreated },
		{ field: 'perms', text: 'Perms', size: '48px', resizable: true, sortable: true },
		{ field: 'checksum', text: 'Checksum', size: '70px', resizable: true, sortable: false },
		{ field: 'tags', text: 'Tags', size: '160px', resizable: true, sortable: false },
		{
			field: 'notes', text: 'Notes', size: '32px', resizable: false, sortable: false, render: (record) => {
				return record.hasNotes
					? `<img src="assets/icons/note-book-icon.svg" style="width: 16px; height: 16px; object-fit: contain; cursor: pointer; opacity: 0.7;" title="Notes" data-notes-icon="true">`
					: '';
			}
		},
		{
			field: 'todo', text: 'TODO', size: '60px', resizable: true, sortable: false, render: (record) => {
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
			text: attrName,
			size: '100px',
			resizable: true,
			sortable: true
		});
	}

	w2ui[gridName] = new w2grid({
		name: gridName,
		reorderColumns: true,
		recordHeight: recordHeight,
		show: {
			header: true,
			toolbar: true,
			footer: true,
			skipRecords: false,
			saveRestoreState: false
		},
	    multiSelect: true,
	    multiSearch: false,
		searches:[
			{ field: 'filename', caption: 'Filename', type: 'text' },
		],
		toolbar: {
			items: [
				{
					type: 'html',
					id: 'depth-control',
					html: `<div style="display:inline-flex;align-items:center;gap:4px;padding:0 8px;">
						<label style="font-size:14px;color:#555;white-space:nowrap;">Depth</label>
						<input id="depth-input-${panelId}" type="number" min="0" max="99" value="${panelState[panelId].depth || 0}"
							style="width:46px;padding:1px 4px;font-size:14px;border:1px solid #ccc;border-radius:3px;text-align:center;">
					</div>`
				},
				{
					type: 'html',
					id: 'scan-controls',
					html: `<div style="display:inline-flex;align-items:center;gap:6px;padding:0 4px;">
						<button id="btn-stop-scan-${panelId}"
							style="display:none;padding:2px 10px;background:#c62828;color:white;border:none;border-radius:3px;cursor:pointer;font-weight:bold;font-size:12px;"
							title="Stop the current scan">&#9632; Stop</button>
						<span id="scan-status-${panelId}"
							style="display:none;font-size:11px;color:#1565C0;font-style:italic;">Scanning…</span>
					</div>`
				}
			]
		},
		columns,
		records: [],
		contextMenu: [],
		onClick: function (event) {
			gridFocusedPanelId = panelId;
			
			// Handle notes icon click to open modal
			if (event.detail.originalEvent && event.detail.originalEvent.target &&
				event.detail.originalEvent.target.dataset &&
				event.detail.originalEvent.target.dataset.notesIcon) {
				event.preventDefault();
				event.stopPropagation();
				if (event.detail.recid) {
					const record = this.records[event.detail.recid - 1];
					if (record && record.hasNotes) {
						openNotesModal(record);
						return;
					}
				}
			}
			
			if (panelId === 1 && event.detail.recid) {
				const record = this.records[event.detail.recid - 1];
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
				const record = this.records[event.detail.recid - 1];
				if (record && getPanelViewType(panelId) !== 'properties') {
					Object.assign(selectedItemState, {
						path: record.path,
						filename: record.filenameRaw || record.filename,
						isDirectory: record.isFolder || false,
						inode: record.inode || null,
						dir_id: record.dir_id || null,
						record
					});
					setActivePanelId(panelId);
					for (let pid = 2; pid <= 4; pid++) {
						if (panelState[pid]) {
							panelState[pid].attrEditMode = false;
							panelState[pid].notesEditMode = false;
						}
					}
					refreshItemPropertiesInAllPanels();
				}
			}

			if (event.detail.column === 0 && event.detail.recid) {
				const record = this.records[event.detail.recid - 1];
				if (record && record.isFolder && record.changeState !== 'moved') {
					openInitialsEditor(record, panelId);
					event.preventDefault();
					return;
				}
			}

			if (event.detail.recid) {
				const col = this.columns[event.detail.column];
				if (col && col.field === 'todo') {
					const record = this.records[event.detail.recid - 1];
					if (record && record.todo && record.todo.total > 0) {
						openTodoModal(record, panelId);
						event.preventDefault();
						return;
					}
				}
			}

			if (panelId > 1 && panelState[panelId].selectMode && event.detail.recid) {
				const record = this.records[event.detail.recid - 1];
				if (record && record.isFolder) {
					setActivePanelId(panelId);
					navigateToDirectory(record.path, panelId);
				}
			}
		},
		onDblClick: function (event) {
			const record = this.records[event.detail.recid - 1];
			if (record && record.isFolder) {
				navigateToDirectory(record.path, panelId);
				return;
			}

			if (record && !record.isFolder) {
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
		onContextMenu: function (event) {
			if (event.detail.recid) {
				event.preventDefault();
				setActivePanelId(panelId);
				const selectedRecIds = this.getSelection();
				const selectedRecords = selectedRecIds.map(recid => this.records[recid - 1]);
				if (selectedRecords.length === 0) return;
				const menuItems = generateW2UIContextMenu(selectedRecords, visiblePanels);
				const origEvent = event.detail.originalEvent;
				showCustomContextMenu(menuItems, origEvent.clientX, origEvent.clientY, panelId);
			}
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
		}
	});

	const $gridContainer = $(`#panel-${panelId} .panel-grid`);
	w2ui[gridName].render($gridContainer[0]);

	const reloadItem = w2ui[gridName].toolbar.get('w2ui-reload');
	if (reloadItem) reloadItem.tooltip = 'Refresh';

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

	updateGridHeader(panelId, 'Loading...');
	panelState[panelId].w2uiGrid = w2ui[gridName];
}

async function populateFileGrid(entries, currentDirCategory, panelId = activePanelId) {
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
			iconUrl = await window.electronAPI.generateFolderIcon(category.bgColor, category.textColor, folder.initials || null);
			if (category && category.attributes) {
				for (const attr of category.attributes) attrColSet.add(attr);
			}
		}

		const className = getRowClassName(folder.changeState);
		records.push({
			recid: recordId++,
			icon: applyClass(`<img src="${iconUrl}" style="width: 20px; height: 20px; object-fit: contain; cursor: pointer;" title="Click to set initials">`, className),
			filename: applyClass(folder.displayFilename || folder.filename, className),
			filenameRaw: folder.filename,
			type: applyClass(folder.changeState === 'moved' ? '' : (category ? category.name || '' : ''), className),
			size: applyClass('-', className),
			dateModified: applyClass(new Date(folder.dateModified).toLocaleString(), className),
			modified: -new Date(folder.dateModified).getTime(),
			perms: applyClass(getPermsCell(folder), className),
			checksum: applyClass('—', className),
			tags: renderTagBadges(folder.tags || null, tagDefs),
			tagsRaw: folder.tags || null,
			isFolder: true,
			path: folder.path,
			changeState: folder.changeState,
			inode: folder.inode,
			initials: folder.initials || null,
			dir_id: null,
			orphan_id: folder.orphan_id || null,
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
			records.push({
				recid: recordId++,
				icon: applyClass(iconSvg, className),
				filename: applyClass(file.displayFilename || file.filename, className),
				filenameRaw: file.filename,
				type: applyClass('', className),
				size: applyClass('—', className),
				dateModified: applyClass('—', className),
				modified: null,
				dateModifiedRaw: null,
				dateCreated: '—',
				dateCreatedRaw: null,
				perms: applyClass(getPermsCell(file), className),
				checksum: applyClass('—', className),
				checksumStatus: null,
				checksumValue: null,
				tags: '',
				tagsRaw: null,
				isFolder: false,
				path: file.path,
				changeState: 'permError',
				inode: file.inode,
				dir_id: file.dir_id || null,
				orphan_id: null,
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
		const iconSvg = file.changeState === 'moved'
			? '<img src="assets/icons/file-moved.svg" style="width: 20px; height: 20px; object-fit: contain;">'
			: `<img src="assets/icons/${ftIconFile}" style="width: 20px; height: 20px; object-fit: contain;">`;

		records.push({
			recid: recordId++,
			icon: applyClass(iconSvg, className),
			filename: applyClass(file.displayFilename || file.filename, className),
			filenameRaw: file.filename,
			type: applyClass(file.changeState === 'moved' ? '' : ftType, className),
			size: applyClass(utils.formatBytes(file.size), className),
			dateModified: dateModifiedContent,
			modified: -new Date(file.dateModified).getTime(),
			dateModifiedRaw: file.dateModified,
			dateCreated: file.dateCreated ? new Date(file.dateCreated).toLocaleDateString() : '-',
			dateCreatedRaw: file.dateCreated,
			perms: applyClass(getPermsCell(file), className),
			checksum: checksumCell,
			checksumStatus: file.checksumStatus || null,
			checksumValue: file.checksumValue || null,
			tags: renderTagBadges(file.tags || null, tagDefs),
			tagsRaw: file.tags || null,
			isFolder: false,
			path: file.path,
			changeState: file.changeState,
			inode: file.inode,
			dir_id: file.dir_id || null,
			orphan_id: file.orphan_id || null,
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
		grid.clear();
		grid.add(records);
	}
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

function matchFileType(filename) {
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
		for (let i = 1; i <= 4; i++) {
			$(`#panel-${i} .panel-number`).removeClass('panel-number-selected');
		}
		$(`#panel-${panelId} .panel-number`).addClass('panel-number-selected');
		refreshItemPropertiesInAllPanels();
	}
}

export function getPanelViewType(panelId) {
	const $panel = $(`#panel-${panelId}`);
	if ($panel.find('.panel-file-view').is(':visible')) return 'file';
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

export function navigateForward() {
	const state = panelState[activePanelId];
	if (state.navigationIndex < state.navigationHistory.length - 1) {
		state.navigationIndex++;
		navigateToDirectory(state.navigationHistory[state.navigationIndex], activePanelId, false);
	}
}

export function activatePathEditMode(panelId) {
	const $panel = $(`#panel-${panelId}`);
	const $pathDisplay = $panel.find('.panel-path');
	const $pathInput = $panel.find('.panel-path-input');
	const $title = $panel.find('.w2ui-panel-title');
	const currentPath = panelState[panelId].currentPath;
	$pathDisplay.hide();
	$title.addClass('path-input-editing');
	$pathInput.val(currentPath).show().select().focus();
}

export async function deactivatePathEditMode(panelId, navigateToNewPath = false, newPath = '') {
	const $panel = $(`#panel-${panelId}`);
	const $pathDisplay = $panel.find('.panel-path');
	const $pathInput = $panel.find('.panel-path-input');
	const $title = $panel.find('.w2ui-panel-title');
	$pathInput.hide();
	$title.removeClass('path-input-editing');
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
		const minWidth = 150;
		const maxWidth = window.innerWidth - 300;
		const constrainedWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
		w2layoutInstance.set('left', { size: constrainedWidth });
		w2layoutInstance.resize();
		for (let panelId = 1; panelId <= 4; panelId++) {
			const grid = panelState[panelId].w2uiGrid;
			if (grid) grid.resize();
		}
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
			const constrainedSidebarWidth = Math.max(150, Math.min(window.innerWidth - 300, newSidebarWidth));
			w2layoutInstance.set('left', { size: constrainedSidebarWidth });
			w2layoutInstance.resize();
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
		const grid = panelState[panelId].w2uiGrid;
		if (grid) {
			const toolbarEl = document.getElementById(`grid_grid-panel-${panelId}_toolbar`);
			if (toolbarEl && toolbarEl.style.height === '0px') toolbarEl.style.height = '';
			grid.resize();
		}
	} else {
		$selectBtn.removeClass('panel-select-active');
		$(`#panel-${panelId} .panel-landing-page`).show();
		$(`#panel-${panelId} .panel-grid`).hide();
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
	setTimeout(() => {
		setupDividers();
		setupBadgeDragHandles();
	}, 100);
}

export function removePanel(panelId) {
	if (visiblePanels === 1) {
		alert('Cannot remove the last panel');
		return;
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
	activePanelId = 1;
	updatePanelLayout();
}

function shiftPanelDown(panelId) {
	const nextPanelId = panelId + 1;
	panelState[panelId] = { ...panelState[nextPanelId] };
	const $currentGrid = $(`#panel-${panelId} .panel-grid`);
	if (panelState[panelId].w2uiGrid) {
		panelState[panelId].w2uiGrid.render($currentGrid[0]);
	}
	$(`#panel-${panelId} .panel-path`).text(panelState[panelId].currentPath);
}

function clearPanelState(panelId) {
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
		sectionCollapseState: null,
		currentItemOpenWith: null
	};

	window.electronAPI.unregisterWatchedPath(panelId);
	const $panel = $(`#panel-${panelId}`);
	setPanelPathValidity(panelId, true);
	$panel.find('.panel-landing-page').show();
	$panel.find('.panel-grid').hide();
	$panel.find('.panel-file-view').hide();
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

	if (panelId > 1) {
		$panel.find('.btn-panel-select').off('click').on('click', function () {
			setActivePanelId(panelId);
			if (panel1SelectedDirectoryPath) {
				navigateToDirectory(panel1SelectedDirectoryPath, panelId);
				$panel.find('.panel-landing-page').hide();
				$panel.find('.panel-grid').show();
				const grid = panelState[panelId].w2uiGrid;
				if (grid) {
					const toolbarEl = document.getElementById(`grid_grid-panel-${panelId}_toolbar`);
					if (toolbarEl && toolbarEl.style.height === '0px') toolbarEl.style.height = '';
					grid.resize();
				}
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

		$panel.find('.item-props-icon').off('click').on('click', async function () {
			if (!$(this).hasClass('clickable')) return;
			const openWith = panelState[panelId].currentItemOpenWith;
			if (!openWith || openWith === 'none') return;
			if (openWith === 'image-viewer') {
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
			const val = $(this).attr('data-copy-value');
			if (val) navigator.clipboard.writeText(val).catch(() => { });
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
				const type = $(this).data('attr-type');
				if (!name) return;
				if ((type || '').toLowerCase() === 'yes-no') {
					attrs[name] = $(this).find('input[type="checkbox"]').prop('checked');
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

		if (panelId === 2) {
			$panel.find('.btn-add-panel-landing').off('click').on('click', function () {
				if (visiblePanels < 4) {
					visiblePanels++;
					const newPanelId = visiblePanels;
					$(`#panel-${newPanelId}`).show();
					attachPanelEventListeners(newPanelId);
					updatePanelLayout();
				}
			});
		}
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
				updateGridHeader(panelId, currentPath);
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
		$content.hide();
		$placeholder.show();
		return;
	}

	try {
		const stats = await window.electronAPI.getItemStats(selectedItemState.path);
		if (!stats) {
			$content.hide();
			$placeholder.show();
			return;
		}

		panelState[panelId].itemInode = stats.inode;
		panelState[panelId].itemDirId = stats.dir_id;

		if (!panelState[panelId].sectionCollapseState) {
			panelState[panelId].sectionCollapseState = {
				preview: false, information: false, attributes: false, notes: false, history: false
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

		const $stats = $panel.find('.item-props-stats').empty();
		function statRow(label, value, extraHtml) {
			return `<div class="stat-row"><span class="stat-label">${label}</span><span class="stat-value stat-value-wrap">${value}${extraHtml || ''}</span></div>`;
		}
		function copyBtn(value) {
			const escaped = value.replace(/"/g, '&quot;');
			return ` <button class="btn-copy-value" data-copy-value="${escaped}" title="Copy">&#x2398;</button>`;
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
		if (stats.tags && stats.tags.length > 0) {
			const tagHtml = stats.tags.map(tag => `<span class="tag-pill">${tag}</span>`).join('');
			$stats.append(statRow('Tags', tagHtml));
		}
		if (stats.categoryName) {
			$stats.append(statRow('Category', stats.categoryName));
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
						controlHtml = `<input type="checkbox" ${val ? 'checked' : ''}>`;
					} else if (type === 'selectable' && attr.options && attr.options.length > 0) {
						const opts = attr.options.map(option => `<option value="${option}" ${String(val) === String(option) ? 'selected' : ''}>${option}</option>`).join('');
						controlHtml = `<select>${opts}</select>`;
					} else if (type === 'numeric') {
						controlHtml = `<input type="number" value="${val}">`;
					} else {
						controlHtml = `<input type="text" value="${String(val)}">`;
					}
				} else if (type === 'yes-no') {
					controlHtml = `<span>${val ? 'Yes' : 'No'}</span>`;
				} else {
					controlHtml = `<span>${String(val || '')}</span>`;
				}
				const $row = $(`<div class="attr-row" data-attr-name="${attr.name}" data-attr-type="${attr.type}"><label>${attr.name}</label>${controlHtml}</div>`);
				$attrContainer.append($row);
			});
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
			const historyResult = await window.electronAPI.getFileHistory(stats.inode);
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
		$content.hide();
		$placeholder.show();
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
			Object.assign(selectedItemState, {
				path: record.path,
				filename: record.filenameRaw || record.filename,
				isDirectory: record.isFolder || false,
				inode: record.inode || null,
				dir_id: record.dir_id || null,
				record
			});
			for (let pid = 2; pid <= 4; pid++) {
				if (panelState[pid]) {
					panelState[pid].attrEditMode = false;
					panelState[pid].notesEditMode = false;
				}
			}
			refreshItemPropertiesInAllPanels();
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

export function openSelectedItem(panelId) {
	const grid = panelState[panelId].w2uiGrid;
	if (!grid) return;
	const selected = grid.getSelection();
	if (selected.length === 0) return;
	const recid = selected[0];
	const record = grid.records.find(r => r.recid === recid);
	if (!record) return;

	if (record.isFolder) {
		navigateToDirectory(record.path, panelId);
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
		if (grid) {
			const toolbarEl = document.getElementById(`grid_grid-panel-${newPanelId}_toolbar`);
			if (toolbarEl && toolbarEl.style.height === '0px') toolbarEl.style.height = '';
			grid.resize();
		}

		panelState[newPanelId].navigationHistory = savedState.navigationHistory;
		panelState[newPanelId].navigationIndex = savedState.navigationIndex;
		panelState[newPanelId].depth = savedState.depth;
		const depthInput = document.getElementById(`depth-input-${newPanelId}`);
		if (depthInput) depthInput.value = savedState.depth;

		await navigateToDirectory(savedState.currentPath, newPanelId, false);
	}
}
