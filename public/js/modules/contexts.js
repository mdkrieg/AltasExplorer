/**
 * Contexts module.
 * Owns grid context-menu state, menu generation, click routing, and custom flyout menus.
 */

import * as panels from './panels.js';
import * as sidebar from './sidebar.js';
import * as terminal from './terminal.js';
import { w2utils } from './vendor/w2ui.es6.min.js';
import {
	panelState,
	selectedItemState,
	activePanelId,
	openNotesModal,
	getAllCategories,
	getAllTags
} from '../renderer.js';

let panelContextMenuState = {};
let globalHandlersInitialized = false;

async function openActionTerminalPanel(filePath, actionLabel) {
	let targetPanelId = terminal.getFallbackTerminalPanelId(panels.visiblePanels);
	if (targetPanelId > panels.visiblePanels) {
		panels.setVisiblePanels(targetPanelId);
		$(`#panel-${targetPanelId}`).show();
		panels.attachPanelEventListeners(targetPanelId);
		panels.updatePanelLayout();
	}

	return terminal.createTerminalPanel(targetPanelId, filePath, `Action: ${actionLabel}`);
}

export async function generateW2UIContextMenu(selectedRecords, visiblePanelCount = panels.visiblePanels) {
	const allCategories = getAllCategories();
	const allTags = getAllTags();
	const isMultiSelect = selectedRecords.length > 1;
	const directoryCount = selectedRecords.filter(record => record.isFolder).length;
	const fileCount = selectedRecords.filter(record => !record.isFolder).length;
	const orphanCount = selectedRecords.filter(record => record.orphan_id).length;

	console.log('Generating context menu - selected records:', {
		selectedRecords,
		isMultiSelect,
		directoryCount,
		fileCount,
		orphanCount
	});

	if (orphanCount > 0) {
		selectedRecords.forEach((record, index) => {
			console.log(`  Record ${index}:`, {
				filename: record.filename,
				orphan_id: record.orphan_id,
				changeState: record.changeState,
				keys: Object.keys(record)
			});
		});
	}

	const addSeparator = (menu) => {
		if (menu.length > 0 && !menu[menu.length - 1].id.startsWith('sep')) {
			menu.push({ id: `sep${menu.length}`, text: '--' });
		}
	};

	panelContextMenuState = {
		selectedRecords,
		isMultiSelect,
		directoryCount,
		fileCount,
		orphanCount,
		selectedPaths: selectedRecords.map(record => record.path)
	};

	const availablePanels = [];
	for (let panelNumber = 1; panelNumber <= Math.min(visiblePanelCount + 1, 4); panelNumber++) {
		availablePanels.push(panelNumber);
	}

	const contextMenu = [];

	// Pre-generate category folder icons and tag icons in parallel
	const categoryNames = Object.keys(allCategories);
	const [categoryIconUrls, tagIconUrls] = await Promise.all([
		Promise.all(categoryNames.map(name => {
			const cat = allCategories[name];
			if (!cat || !cat.bgColor) return Promise.resolve(null);
			return window.electronAPI.generateFolderIcon(cat.bgColor, cat.textColor).catch(() => null);
		})),
		Promise.all(allTags.map(tag => {
			if (!tag || !tag.bgColor) return Promise.resolve(null);
			return window.electronAPI.generateTagIcon(tag.bgColor, tag.textColor).catch(() => null);
		}))
	]);
	const categoryIconMap = {};
	categoryNames.forEach((name, i) => { categoryIconMap[name] = categoryIconUrls[i]; });
	const tagIconMap = {};
	allTags.forEach((tag, i) => { tagIconMap[tag.name] = tagIconUrls[i]; });

	const buildCategorySubmenuItems = () => Object.keys(allCategories).map(categoryName => ({
		id: `set-category-${categoryName}`,
		text: categoryName,
		iconHtml: categoryIconMap[categoryName]
			? `<img src="${categoryIconMap[categoryName]}" style="width:16px;height:16px;object-fit:contain;vertical-align:middle;">`
			: ''
	}));

	if (!isMultiSelect && directoryCount > 0) {
		contextMenu.push({
			id: 'open-in',
			text: 'Open In',
			items: availablePanels.map(panelNumber => ({
				id: `open-in-${panelNumber}`,
				text: `Panel ${panelNumber}`
			}))
		});
		contextMenu.push({
			id: 'set-category-label',
			text: 'Set Category',
			items: buildCategorySubmenuItems()
		});

		// Open in Terminal submenu
		const terminalItems = [];
		const existingTerminalPanelIds = terminal.getTerminalPanelIds();
		for (const pid of existingTerminalPanelIds) {
			terminalItems.push({ id: `open-in-terminal-${pid}`, text: `Panel ${pid}` });
		}
		const nextTerminalPanel = panels.visiblePanels + 1;
		if (nextTerminalPanel <= 4) {
			terminalItems.push({ id: `open-in-terminal-new`, text: `New Terminal (Panel ${nextTerminalPanel})` });
		} else if (terminalItems.length === 0) {
			// All 4 panels are busy, offer replacing the last non-panel-1 panel
			terminalItems.push({ id: `open-in-terminal-new`, text: `New Terminal (replace Panel ${panels.visiblePanels})` });
		}
		if (terminalItems.length > 0) {
			contextMenu.push({
				id: 'open-in-terminal-label',
				text: 'Open in Terminal',
				items: terminalItems
			});
		}
	}

	if (isMultiSelect && directoryCount > 0) {
		contextMenu.push({
			id: 'set-category-label',
			text: 'Set Category (all)',
			items: buildCategorySubmenuItems()
		});
	}

	if (!isMultiSelect && fileCount > 0) {
		contextMenu.push({ id: 'open-in-default-app', text: 'Open', icon: 'fa fa-external-link' });
		const filePanels = availablePanels.filter(panelNumber => panelNumber > 1);
		if (filePanels.length > 0) {
			addSeparator(contextMenu);
			contextMenu.push({
				id: 'open-in',
				text: 'Open In',
				items: filePanels.map(panelNumber => ({
					id: `open-in-${panelNumber}`,
					text: `Panel ${panelNumber}`
				}))
			});
		}
	}

	if (allTags.length > 0) {
		contextMenu.push({
			id: 'add-tag-label',
			text: isMultiSelect ? 'Add Tag (all)' : 'Add Tag',
			items: allTags.map(tag => ({
				id: `add-tag-${tag.name}`,
				text: tag.name,
				iconHtml: tagIconMap[tag.name]
					? `<img src="${tagIconMap[tag.name]}" style="width:16px;height:16px;object-fit:contain;vertical-align:middle;">`
					: ''
			}))
		});
	}

	if (!isMultiSelect) {
		const singleRecord = selectedRecords[0];
		let existingTags = [];
		try {
			if (singleRecord && singleRecord.tagsRaw) existingTags = JSON.parse(singleRecord.tagsRaw);
			if (!Array.isArray(existingTags)) existingTags = [];
		} catch { }

		if (existingTags.length > 0) {
			contextMenu.push({
				id: 'remove-tag-label',
				text: 'Remove Tag',
				items: existingTags.map(tag => ({ id: `remove-tag-${tag}`, text: tag }))
			});
		} else {
			contextMenu.push({
				id: 'remove-tag-disabled',
				text: 'Remove Tag',
				disabled: true
			});
		}
	}

	if (directoryCount > 0) {
		addSeparator(contextMenu);
		const label = directoryCount > 1 ? `Add ${directoryCount} folders to Favorites` : 'Add to Favorites';
		contextMenu.push({ id: 'add-to-favorites', text: label, icon: 'fa fa-star' });
	}

	if (orphanCount > 0) {
		addSeparator(contextMenu);
		const orphanRecords = selectedRecords.filter(record => record.orphan_id);
		if (isMultiSelect && orphanRecords.length > 0) {
			contextMenu.push({
				id: 'acknowledge-orphans',
				text: `Remove ${orphanRecords.length} orphaned item${orphanRecords.length > 1 ? 's' : ''}`,
				icon: 'fa fa-check-circle',
				orphanIds: orphanRecords.map(record => record.orphan_id)
			});
		} else if (!isMultiSelect && orphanRecords.length === 1) {
			contextMenu.push({
				id: `acknowledge-orphan-${orphanRecords[0].orphan_id}`,
				text: 'Acknowledge & Remove',
				icon: 'fa fa-check-circle'
			});
		}
	}

	if (!isMultiSelect) {
		addSeparator(contextMenu);
		contextMenu.push({ id: 'view-notes', text: 'Notes', icon: 'fa fa-sticky-note' });
		contextMenu.push({ id: 'view-properties', text: 'Properties', icon: 'fa fa-info-circle' });
	}

	if (fileCount > 0) {
		addSeparator(contextMenu);
		const label = fileCount > 1 ? `Calculate Checksum (${fileCount} files)` : 'Calculate Checksum';
		contextMenu.push({ id: 'calculate-checksum', text: label, icon: 'fa fa-hashtag' });
	}

	// Copy as Path
	{
		addSeparator(contextMenu);
		const copyPathLabel = isMultiSelect ? `Copy ${selectedRecords.length} Paths` : 'Copy as Path';
		contextMenu.push({ id: 'copy-as-path', text: copyPathLabel, icon: 'fa fa-copy' });
	}

	// Delete
	{
		const deletableRecords = selectedRecords.filter(r => r.filenameRaw !== '.' && r.filenameRaw !== '..');
		if (deletableRecords.length > 0) {
			addSeparator(contextMenu);
			const deleteLabel = deletableRecords.length > 1 ? `Delete (${deletableRecords.length} items)` : 'Delete';
			contextMenu.push({ id: 'delete-items', text: deleteLabel, icon: 'fa fa-trash' });
		}
	}

	// Custom Actions
	try {
		const allActions = await window.electronAPI.getCustomActions();
		if (allActions && allActions.length > 0) {
			const singleRecord = !isMultiSelect ? selectedRecords[0] : null;
			const filename = singleRecord ? (singleRecord.filenameRaw || singleRecord.filename || '') : '';
			const matchingActions = allActions.filter(action => {
				if (!action.filePatterns || action.filePatterns.length === 0) return true;
				return action.filePatterns.some(pattern => {
					const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
					return new RegExp('^' + escaped + '$', 'i').test(filename);
				});
			});
			if (matchingActions.length > 0) {
				addSeparator(contextMenu);
				matchingActions.forEach(action => {
					contextMenu.push({ id: `run-custom-action-${action.id}`, text: action.label });
				});
			}
		}
	} catch (_) { /* custom actions are non-critical */ }

	return contextMenu;
}

async function handleContextMenuClick(event, panelId) {
	const menuItemId = event.detail.menuItem.id;
	const { selectedRecords, selectedPaths, isMultiSelect } = panelContextMenuState;
	const allTags = getAllTags();

	console.log('Menu click:', menuItemId, 'Panel:', panelId);

	if (menuItemId.startsWith('open-in-') && !menuItemId.startsWith('open-in-terminal-')) {
		const targetPanel = parseInt(menuItemId.split('-')[2]);
		const firstRecord = selectedRecords[0];
		const $panel = $(`#panel-${targetPanel}`);

		try {
			if (targetPanel > panels.visiblePanels) {
				panels.setVisiblePanels(targetPanel);
				$panel.show();
				panels.attachPanelEventListeners(targetPanel);
				panels.updatePanelLayout();
			}

			if (firstRecord && firstRecord.isFolder) {
				await panels.navigateToDirectory(firstRecord.path, targetPanel);
				$panel.find('.panel-landing-page').hide();
				// Only force grid visible when not in gallery mode
				const viewType = panels.getPanelViewType(targetPanel);
				if (viewType !== 'gallery') {
					$panel.find('.panel-grid').show();
				}
				const grid = panelState[targetPanel].w2uiGrid;
				if (grid && grid.resize) grid.resize();
			} else if (firstRecord) {
				Object.assign(selectedItemState, {
					path: firstRecord.path,
					filename: firstRecord.filenameRaw || firstRecord.filename,
					isDirectory: false,
					inode: firstRecord.inode,
					dir_id: firstRecord.dir_id,
					record: firstRecord
				});
				$panel.find('.panel-grid').hide();
				$panel.find('.panel-file-view').hide();
				$panel.find('.panel-landing-page').show();
				panels.updateItemPropertiesPage(targetPanel);
			}

			panels.setActivePanelId(targetPanel);
		} catch (err) {
			alert('Error opening in panel: ' + err.message);
		}
	}

	if (menuItemId.startsWith('open-in-terminal-')) {
		const firstRecord = selectedRecords[0];
		if (!firstRecord || !firstRecord.isFolder) return;
		const dirPath = firstRecord.path;

		if (menuItemId === 'open-in-terminal-new') {
			// Open a new terminal panel in the next available slot
			let targetPanelId;
			if (panels.visiblePanels < 4) {
				targetPanelId = panels.visiblePanels + 1;
				panels.setVisiblePanels(targetPanelId);
				$(`#panel-${targetPanelId}`).show();
				panels.attachPanelEventListeners(targetPanelId);
				panels.updatePanelLayout();
			} else {
				targetPanelId = panels.visiblePanels;
			}
			await terminal.createTerminalPanel(targetPanelId, dirPath);
		} else {
			const targetPanelId = parseInt(menuItemId.replace('open-in-terminal-', ''));
			if (targetPanelId >= 2 && targetPanelId <= 4) {
				await terminal.createTerminalPanel(targetPanelId, dirPath);
			}
		}
	}

	if (menuItemId.startsWith('set-category-') && menuItemId !== 'set-category-label') {
		const categoryName = menuItemId.replace('set-category-', '');
		try {
			if (isMultiSelect) {
				const result = await window.electronAPI.assignCategoryToDirectories(selectedPaths, categoryName, true);
				if (!result.success) {
					alert('Error assigning category: ' + result.error);
				}
			} else {
				await window.electronAPI.assignCategoryToDirectory(selectedPaths[0], categoryName, true);
			}

			const state = panelState[activePanelId];
			await panels.navigateToDirectory(state.currentPath, activePanelId);
		} catch (err) {
			alert('Error assigning category: ' + err.message);
		}
	}

	if (menuItemId === 'view-properties') {
		const selectedRecord = selectedRecords[0];
		if (!selectedRecord) return;

		try {
			await panels.showItemPropsModal(selectedRecord, activePanelId);
		} catch (err) {
			alert('Error opening properties: ' + err.message);
		}
	}

	if (menuItemId === 'view-notes') {
		const selectedRecord = selectedRecords[0];
		if (!selectedRecord) return;

		try {
			await openNotesModal(selectedRecord);
		} catch (err) {
			alert('Error opening notes: ' + err.message);
		}
	}

	if (menuItemId === 'calculate-checksum') {
		const fileRecords = selectedRecords.filter(record => !record.isFolder && record.inode && record.dir_id);
		const grid = panelState[activePanelId].w2uiGrid;
		for (const record of fileRecords) {
			try {
				const result = await window.electronAPI.calculateFileChecksum(record.path, record.inode, record.dir_id, true);
				const gridRecord = grid ? grid.records.find(item => item.inode === record.inode && item.dir_id === record.dir_id) : null;
				if (gridRecord) {
					if (result.success) {
						gridRecord.checksumStatus = result.status;
						gridRecord.checksumValue = result.checksum;
						const shortHash = result.checksum ? result.checksum.substring(0, 12) + '...' : '—';
						gridRecord.checksum = `<span title="${result.checksum || ''}" style="cursor: help;">${shortHash}</span>`;
						if (result.changed && result.hadPreviousChecksum) {
							gridRecord.changeState = 'checksumChanged';
						}
					} else {
						gridRecord.checksumStatus = 'error';
						gridRecord.checksum = '<span style="color: #f00;">Error</span>';
					}
				}
			} catch (err) {
				console.error(`Error calculating checksum for ${record.filenameRaw || record.filename}:`, err.message);
			}
		}
		if (grid) grid.refresh();
	}

	if (menuItemId === 'add-to-favorites') {
		const dirPaths = selectedRecords.filter(record => record.isFolder).map(record => record.path);
		for (const dirPath of dirPaths) {
			await sidebar.addToFavorites(dirPath);
		}
	}

	if (menuItemId.startsWith('acknowledge-orphan-')) {
		const orphanId = parseInt(menuItemId.replace('acknowledge-orphan-', ''));
		try {
			const orphanRecord = selectedRecords.find(record => record.orphan_id === orphanId);
			const result = orphanRecord?.orphan_type === 'dir'
				? await window.electronAPI.acknowledgeDirOrphan(orphanId)
				: await window.electronAPI.acknowledgeOrphan(orphanId);
			if (result.success) {
				const state = panelState[activePanelId];
				await panels.navigateToDirectory(state.currentPath, activePanelId);
			} else {
				alert('Error removing orphan: ' + result.error);
			}
		} catch (err) {
			alert('Error removing orphan: ' + err.message);
		}
	}

	if (menuItemId === 'acknowledge-orphans') {
		const orphanRecords = selectedRecords.filter(record => record.orphan_id);
		try {
			for (const record of orphanRecords) {
				const result = record.orphan_type === 'dir'
					? await window.electronAPI.acknowledgeDirOrphan(record.orphan_id)
					: await window.electronAPI.acknowledgeOrphan(record.orphan_id);
				if (!result.success) {
					alert(`Error removing orphan ${record.filename}: ${result.error}`);
					break;
				}
			}
			const state = panelState[activePanelId];
			await panels.navigateToDirectory(state.currentPath, activePanelId);
		} catch (err) {
			alert('Error removing orphans: ' + err.message);
		}
	}

	if (menuItemId.startsWith('add-tag-') && menuItemId !== 'add-tag-label') {
		const tagName = menuItemId.replace('add-tag-', '');
		try {
			const grid = panelState[panelId].w2uiGrid;
			const tagDefs = Object.fromEntries(allTags.map(tag => [tag.name, tag]));
			for (const record of selectedRecords) {
				await window.electronAPI.addTagToItem({
					path: record.path,
					tagName,
					isDirectory: record.isFolder,
					inode: record.inode,
					dir_id: record.dir_id
				});

				if (grid) {
					const gridRecord = grid.records.find(item => item.recid === record.recid);
					if (gridRecord) {
						let currentTags = [];
						try {
							if (gridRecord.tagsRaw) currentTags = JSON.parse(gridRecord.tagsRaw);
							if (!Array.isArray(currentTags)) currentTags = [];
						} catch { }
						if (!currentTags.includes(tagName)) currentTags.push(tagName);
						gridRecord.tagsRaw = JSON.stringify(currentTags);
						gridRecord.tags = panels.renderTagBadges(gridRecord.tagsRaw, tagDefs);
						grid.refreshRow(gridRecord.recid);
					}
				}
			}
		} catch (err) {
			alert('Error adding tag: ' + err.message);
		}
	}

	if (menuItemId.startsWith('remove-tag-') && menuItemId !== 'remove-tag-label' && menuItemId !== 'remove-tag-disabled') {
		const tagName = menuItemId.replace('remove-tag-', '');
		const record = selectedRecords[0];
		if (!record) return;

		try {
			await window.electronAPI.removeTagFromItem({
				path: record.path,
				tagName,
				isDirectory: record.isFolder,
				inode: record.inode,
				dir_id: record.dir_id
			});

			const grid = panelState[panelId].w2uiGrid;
			if (grid) {
				const gridRecord = grid.records.find(item => item.recid === record.recid);
				if (gridRecord) {
					let currentTags = [];
					try {
						if (gridRecord.tagsRaw) currentTags = JSON.parse(gridRecord.tagsRaw);
						if (!Array.isArray(currentTags)) currentTags = [];
					} catch { }
					currentTags = currentTags.filter(tag => tag !== tagName);
					gridRecord.tagsRaw = currentTags.length > 0 ? JSON.stringify(currentTags) : null;
					const tagDefs = Object.fromEntries(allTags.map(tag => [tag.name, tag]));
					gridRecord.tags = panels.renderTagBadges(gridRecord.tagsRaw, tagDefs);
					grid.refreshRow(gridRecord.recid);
				}
			}
		} catch (err) {
			alert('Error removing tag: ' + err.message);
		}
	}

	if (menuItemId === 'copy-as-path') {
		const paths = panelContextMenuState.selectedPaths;
		try {
			await navigator.clipboard.writeText(paths.join('\n'));
			const msg = paths.length > 1 ? `${paths.length} paths copied to clipboard` : 'Path copied to clipboard';
			w2utils.notify(msg, { success: true, timeout: 2500 });
		} catch (err) {
			console.error('Failed to copy path to clipboard:', err);
			w2utils.notify('Failed to copy path to clipboard', { error: true, timeout: 2500 });
		}
	}

	if (menuItemId === 'delete-items') {
		const grid = panelState[panelId]?.w2uiGrid;
		if (grid) {
			// Ensure the selection reflects only the items from the context-click
			// (user may have right-clicked a record that wasn't previously selected)
			const deletableRecords = selectedRecords.filter(r => r.filenameRaw !== '.' && r.filenameRaw !== '..');
			grid.selectNone();
			grid.select(...deletableRecords.map(r => r.recid));
			grid['delete'](); // triggers onDelete with force=false → shows confirm dialog
		}
	}

	if (menuItemId === 'open-in-default-app') {
		const record = selectedRecords[0];
		if (!record || record.isFolder) return;
		try {
			const result = await window.electronAPI.openInDefaultApp(record.path);
			if (result && !result.success) {
				w2alert(`<b>Could not open file</b><br><br>${result.error}`, 'Open Failed');
			}
		} catch (err) {
			console.error('Error opening file in default app:', err);
		}
	}

	if (menuItemId.startsWith('run-custom-action-')) {
		const actionId = menuItemId.replace('run-custom-action-', '');
		const record = selectedRecords[0];
		if (!record) return;
		try {
			const allActions = await window.electronAPI.getCustomActions();
			const action = allActions.find(item => item.id === actionId);
			if (!action) {
				w2alert('Custom action not found.');
				return;
			}
			const verify = await window.electronAPI.verifyCustomAction(actionId);
			const runAction = async () => {
				if (action.executionMode === 'terminal') {
					const terminalPanel = await openActionTerminalPanel(record.path, action.label);
					if (!terminalPanel || !terminalPanel.termId) {
						w2alert('Unable to open a terminal panel for this action.');
						return;
					}
					const result = await window.electronAPI.runCustomActionInTerminal(actionId, record.path, terminalPanel.termId);
					if (result && !result.success) {
						w2alert(`<b>Custom action failed</b><br><br><pre style="font-size:11px;max-height:200px;overflow:auto;white-space:pre-wrap">${result.error}</pre>`, 'Action Failed');
					}
					return;
				}

				const result = await window.electronAPI.runCustomAction(actionId, record.path);
				if (result && !result.success) {
					const detail = result.stderr && result.stderr.trim()
						? result.stderr.trim()
						: (result.stdout && result.stdout.trim() ? result.stdout.trim() : result.error);
					w2alert(`<b>Custom action failed</b><br><br><pre style="font-size:11px;max-height:200px;overflow:auto;white-space:pre-wrap">${detail}</pre>`, 'Action Failed');
				}
			};
			if (verify && verify.isScriptType && verify.valid === false) {
				const oldHash = (verify.storedChecksum || '').substring(0, 16) + '…';
				const newHash = (verify.current || '').substring(0, 16) + '…';
				w2confirm({
					msg: `The script file has changed since it was registered.<br><br>Stored: <code>${oldHash}</code><br>Current: <code>${newHash}</code><br><br>Run anyway?`,
					title: 'Script Modified — Proceed?',
					width: 480,
					height: 240
				}).yes(async () => { await runAction(); });
			} else {
				await runAction();
			}
		} catch (err) {
			console.error('Error running custom action:', err);
		}
	}
}

export function hideCustomContextMenu() {
	document.getElementById('custom-ctx-menu')?.remove();
	document.querySelectorAll('.custom-ctx-submenu').forEach(element => element.remove());
}

function buildMenuEl(items, panelId) {
	const menu = document.createElement('div');
	menu.className = 'custom-ctx-menu';

	let activeSubEl = null;
	let subHideTimer = null;

	const clearHideTimer = () => clearTimeout(subHideTimer);
	const startHideTimer = () => {
		subHideTimer = setTimeout(() => {
			if (activeSubEl) {
				activeSubEl.remove();
				activeSubEl = null;
			}
		}, 200);
	};

	for (const item of items) {
		if (item.text === '--') {
			const sep = document.createElement('div');
			sep.className = 'custom-ctx-separator';
			menu.appendChild(sep);
			continue;
		}

		const row = document.createElement('div');
		row.className = 'custom-ctx-item';

		if (item.iconHtml) {
			const iconWrap = document.createElement('span');
			iconWrap.className = 'custom-ctx-icon';
			iconWrap.innerHTML = item.iconHtml;
			row.appendChild(iconWrap);
		}

		const label = document.createElement('span');
		label.className = 'custom-ctx-label';
		label.textContent = item.text;
		row.appendChild(label);

		const hasSub = Array.isArray(item.items) && item.items.length > 0;
		if (hasSub) {
			const arrow = document.createElement('span');
			arrow.className = 'custom-ctx-arrow';
			arrow.textContent = '›';
			row.appendChild(arrow);
		}

		row.addEventListener('mouseenter', () => {
			clearHideTimer();
			menu.querySelectorAll('.custom-ctx-item').forEach(itemRow => itemRow.classList.remove('active'));
			row.classList.add('active');

			if (!hasSub) {
				if (activeSubEl) {
					activeSubEl.remove();
					activeSubEl = null;
				}
				return;
			}

			if (activeSubEl) {
				activeSubEl.remove();
				activeSubEl = null;
			}

			const sub = buildMenuEl(item.items, panelId);
			sub.classList.add('custom-ctx-submenu');
			const rowRect = row.getBoundingClientRect();
			sub.style.left = (rowRect.right + 2) + 'px';
			sub.style.top = rowRect.top + 'px';
			document.body.appendChild(sub);
			activeSubEl = sub;

			requestAnimationFrame(() => {
				const subRect = sub.getBoundingClientRect();
				if (subRect.right > window.innerWidth) {
					sub.style.left = (rowRect.left - subRect.width - 2) + 'px';
				}
				if (subRect.bottom > window.innerHeight) {
					sub.style.top = (rowRect.top - (subRect.bottom - window.innerHeight)) + 'px';
				}
			});

			sub.addEventListener('mouseenter', () => clearHideTimer());
			sub.addEventListener('mouseleave', () => startHideTimer());
		});

		if (hasSub) {
			row.addEventListener('mouseleave', () => startHideTimer());
		} else {
			row.addEventListener('click', (event) => {
				event.stopPropagation();
				hideCustomContextMenu();
				if (typeof item.onClick === 'function') {
					item.onClick();
				} else {
					handleContextMenuClick({ detail: { menuItem: item } }, panelId);
				}
			});
		}

		menu.appendChild(row);
	}

	return menu;
}

export function showCustomContextMenu(items, x, y, panelId) {
	hideCustomContextMenu();

	const menu = buildMenuEl(items, panelId);
	menu.id = 'custom-ctx-menu';
	menu.style.left = x + 'px';
	menu.style.top = y + 'px';
	document.body.appendChild(menu);

	requestAnimationFrame(() => {
		const rect = menu.getBoundingClientRect();
		if (rect.right > window.innerWidth) menu.style.left = (x - rect.width) + 'px';
		if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + 'px';
	});

	const onOutside = (event) => {
		if (!event.target.closest?.('#custom-ctx-menu') && !event.target.closest?.('.custom-ctx-submenu')) {
			hideCustomContextMenu();
			document.removeEventListener('click', onOutside);
			document.removeEventListener('keydown', onEsc);
		}
	};
	const onEsc = (event) => {
		if (event.key === 'Escape') {
			hideCustomContextMenu();
			document.removeEventListener('click', onOutside);
			document.removeEventListener('keydown', onEsc);
		}
	};
	document.addEventListener('click', onOutside);
	document.addEventListener('keydown', onEsc);
}

export function initializeGlobalContextMenuHandlers() {
	if (globalHandlersInitialized) return;
	globalHandlersInitialized = true;

	document.addEventListener('contextmenu', () => {
		hideCustomContextMenu();
		if (typeof w2menu !== 'undefined') {
			try {
				w2menu.hide();
			} catch { }
		}
	}, true);
}
