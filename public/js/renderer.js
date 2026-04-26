/**
 * AtlasExplorer Renderer Logic
 * Handles all UI interactions and IPC calls
 * 
 * MODULAR ORGANIZATION:
 * This file is being incrementally split into feature modules in public/js/modules/:
 * - modules/utils.js      – Pure utility functions (formatBytes, escapeHtml, etc.)
 * - modules/sidebar.js    – Sidebar navigation, tree, and favorites [extracted]
 * - modules/panels.js     – Grid management, navigation, layout switching [in progress]
 * - modules/notes.js      – Notes modal, file view, and Monaco loader [extracted]
 * - modules/alerts.js – Alert badge and modal [extracted]
 * - modules/settings.js   – Settings modal, categories, tags, hotkeys [in progress]
 * - modules/history.js    – History modal and change summaries [extracted]
 * - modules/contexts.js   – Grid context menus and flyout interactions [extracted]
 * 
 * Functions are being extracted incrementally as features are developed.
 * See module files for planned function extractions.
 */

// Import utility functions module
import * as utils from './modules/utils.js';
import * as sidebar from './modules/sidebar.js';
import * as panels from './modules/panels.js';
import * as contexts from './modules/contexts.js';
import * as history from './modules/history.js';
import * as notes from './modules/notes.js';
import * as alerts from './modules/alerts.js';
import * as settings from './modules/settings.js';
import * as todos from './modules/todos.js';
import * as sidebarTodos from './modules/sidebarTodos.js';
import * as terminal from './modules/terminal.js';
import { w2ui, w2layout, w2grid, w2confirm, w2alert, w2popup } from './modules/vendor/w2ui.es6.min.js';

export { monacoEditor, formatFileContent, openNotesModal, showFileView, hideFileView, toggleFileEditMode } from './modules/notes.js';
export { generateW2UIContextMenu, showCustomContextMenu } from './modules/contexts.js';
export { openHistoryModal, formatHistoryData, buildCompleteFileState } from './modules/history.js';
export { updateAlertBadge } from './modules/alerts.js';
export { openTodoModal } from './modules/todos.js';

// Global error handler for debugging
window.addEventListener('error', (event) => {
  if (event.error) console.error('Uncaught error:', event.error);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
});

// Panel state - tracks each panel's directory, grid, and navigation
export let panelState = {
  0: { currentPath: '', w2uiGrid: null, navigationHistory: [], navigationIndex: -1, currentCategory: null, selectMode: false, checksumQueue: null, checksumQueueIndex: 0, checksumCancelled: false, showDateCreated: false, hasBeenViewed: false, fileViewPath: null, depth: 0, scanCancelled: false, pendingDirs: [], scanInProgress: false, scanToken: 0, recidCounter: 1, attrEditMode: false, notesEditMode: false, notesMonacoEditor: null, notesFilePath: null, sectionCollapseState: null, currentItemOpenWith: null, labelsUiState: null, currentItemStats: null, filterVisible: false, filterValues: null, filterMenuField: null, sourceRecords: [], currentNavParams: null, currentBasePath: null, orphanCount: 0, trashCount: 0 },
  1: { currentPath: '', w2uiGrid: null, navigationHistory: [], navigationIndex: -1, currentCategory: null, selectMode: false, checksumQueue: null, checksumQueueIndex: 0, checksumCancelled: false, showDateCreated: false, hasBeenViewed: false, fileViewPath: null, depth: 0, scanCancelled: false, pendingDirs: [], scanInProgress: false, scanToken: 0, recidCounter: 1, attrEditMode: false, notesEditMode: false, notesMonacoEditor: null, notesFilePath: null, sectionCollapseState: null, currentItemOpenWith: null, labelsUiState: null, currentItemStats: null, filterVisible: false, filterValues: null, filterMenuField: null, sourceRecords: [], currentNavParams: null, currentBasePath: null, orphanCount: 0, trashCount: 0 },
  2: { currentPath: '', w2uiGrid: null, navigationHistory: [], navigationIndex: -1, currentCategory: null, selectMode: false, checksumQueue: null, checksumQueueIndex: 0, checksumCancelled: false, showDateCreated: false, hasBeenViewed: false, fileViewPath: null, depth: 0, scanCancelled: false, pendingDirs: [], scanInProgress: false, scanToken: 0, recidCounter: 1, attrEditMode: false, notesEditMode: false, notesMonacoEditor: null, notesFilePath: null, sectionCollapseState: null, currentItemOpenWith: null, labelsUiState: null, currentItemStats: null, filterVisible: false, filterValues: null, filterMenuField: null, sourceRecords: [], currentNavParams: null, currentBasePath: null, orphanCount: 0, trashCount: 0 },
  3: { currentPath: '', w2uiGrid: null, navigationHistory: [], navigationIndex: -1, currentCategory: null, selectMode: false, checksumQueue: null, checksumQueueIndex: 0, checksumCancelled: false, showDateCreated: false, hasBeenViewed: false, fileViewPath: null, depth: 0, scanCancelled: false, pendingDirs: [], scanInProgress: false, scanToken: 0, recidCounter: 1, attrEditMode: false, notesEditMode: false, notesMonacoEditor: null, notesFilePath: null, sectionCollapseState: null, currentItemOpenWith: null, labelsUiState: null, currentItemStats: null, filterVisible: false, filterValues: null, filterMenuField: null, sourceRecords: [], currentNavParams: null, currentBasePath: null, orphanCount: 0, trashCount: 0 },
  4: { currentPath: '', w2uiGrid: null, navigationHistory: [], navigationIndex: -1, currentCategory: null, selectMode: false, checksumQueue: null, checksumQueueIndex: 0, checksumCancelled: false, showDateCreated: false, hasBeenViewed: false, fileViewPath: null, depth: 0, scanCancelled: false, pendingDirs: [], scanInProgress: false, scanToken: 0, recidCounter: 1, attrEditMode: false, notesEditMode: false, notesMonacoEditor: null, notesFilePath: null, sectionCollapseState: null, currentItemOpenWith: null, labelsUiState: null, currentItemStats: null, filterVisible: false, filterValues: null, filterMenuField: null, sourceRecords: [], currentNavParams: null, currentBasePath: null, orphanCount: 0, trashCount: 0 }
};

export let selectedItemState = {
  path: null,
  filename: null,
  isDirectory: false,
  inode: null,
  dir_id: null,
  record: null,
  panelId: null
};

export let activePanelId = 1;
export let sidebarHasFocus = false;
let allCategories = {};
let allTags = [];
export let fileEditMode = false;
let hotkeyRegistry = {};
export const MISSING_DIRECTORY_LABEL = '(DIRECTORY DOES NOT EXIST)';
const SIDEBAR_COLLAPSED_WIDTH = 50;

export let sidebarState = {
  expandedPaths: new Set(),
  selectedPath: null,
  drives: [],
  expandedSections: new Set(['favorites'])
};

let panelDividerState = {
  verticalPixels: 400,
  horizontalPixels: 300,
  isResizingVertical: false,
  isResizingHorizontal: false,
  minPanelWidth: 200,
  minPanelHeight: 100
};

export let w2layoutInstance = null;

export function setFileEditMode(value) {
  fileEditMode = value;
}

export function setSelectedItemState(value) {
  selectedItemState = value;
}

export function syncRendererActivePanelId(panelId) {
  activePanelId = panelId;
}

export function activateSidebarContext(panelId) {
  sidebarHasFocus = true;
  const $sidebar = $('#sidebar-content');
  $sidebar.addClass('sidebar-focused');
  for (let i = 1; i <= 4; i++) {
    $(`#panel-${i} .panel-number`).removeClass('panel-number-selected');
    $(`#panel-${i}`).removeClass('panel-active').removeClass('panel-previously-active');
  }
  // Store the previously-focused panel ID on the element for later use, but don't show
  // the orange shadow yet — it only shows when a favorite item is actually selected.
  $(`#sidebar-content`).data('previousPanelId', panelId >= 1 && panelId <= 4 ? panelId : 1);
}

export function setPreviouslyActivePanel(panelId) {
  for (let i = 1; i <= 4; i++) {
    $(`#panel-${i}`).removeClass('panel-previously-active');
  }
  if (panelId >= 1 && panelId <= 4) {
    $(`#panel-${panelId}`).addClass('panel-previously-active');
  }
}

export function setSidebarFocus(focused) {
  if (focused) {
    activateSidebarContext(activePanelId);
    sidebar.initSidebarFocus();
  } else {
    sidebarHasFocus = false;
    const $sidebar = $('#sidebar-content');
    $sidebar.removeClass('sidebar-focused');
    for (let i = 1; i <= 4; i++) {
      $(`#panel-${i}`).removeClass('panel-previously-active');
    }
    sidebar.clearSidebarArrowFocus();
  }
}

export function getAllCategories() {
  return allCategories;
}

export function getAllTags() {
  return allTags;
}

async function initialize() {
  try {
    console.log('Initializing app...');

    if (!window.electronAPI) {
      throw new Error('electronAPI not found - preload script may not be loaded');
    }

    console.log('electronAPI available:', Object.keys(window.electronAPI));

    w2layoutInstance = new w2layout({
      name: 'layout',
      padding: 0,
      panels: [
        {
          type: 'left',
          size: parseInt(localStorage.getItem('sidebarExpandedWidth') || localStorage.getItem('sidebarWidth') || '250'),
          resizable: true,
          minSize: SIDEBAR_COLLAPSED_WIDTH,
          maxSize: 500,
          style: 'border-right: 1px solid #ddd;'
        },
        {
          type: 'main',
          minSize: 300,
          overflow: 'hidden'
        }
      ]
    });

    w2layoutInstance.render('#layout');

    const sidebarContent = document.getElementById('sidebar-content');
    const leftPanelElement = w2layoutInstance.el('left');
    if (leftPanelElement && sidebarContent) {
      sidebarContent.style.display = 'flex';
      leftPanelElement.appendChild(sidebarContent);
    }

    const mainContent = document.getElementById('main-content');
    const mainPanelElement = w2layoutInstance.el('main');
    if (mainPanelElement && mainContent) {
      mainContent.style.display = 'flex';
      mainPanelElement.appendChild(mainContent);
    }

    w2layoutInstance.on('resize', function () {
      const leftPanel = this.get('left');
      if (leftPanel) {
        sidebar.handleSidebarLayoutResize(leftPanel.size);
      }
    });

    await panels.initializeAllGrids();
    // Register sidebar section callbacks BEFORE initializeSidebar() so that
    // sections expanded on startup fire their populate callbacks.
    sidebarTodos.initSidebarTodos();
    await sidebar.initializeSidebar();
    sidebar.handleSidebarLayoutResize(w2layoutInstance.get('left').size);

    const appSettings = await window.electronAPI.getSettings();
    console.log('Settings loaded:', appSettings);

    const homePath = appSettings.home_directory;

    await panels.switchLayout(1);
    panels.initializeDividers();
    await panels.loadFileTypes();

    if (homePath) {
      await panels.navigateToDirectory(homePath, 1);
    }

    await loadCategories();
    await loadTagsList();
    await loadHotkeysFromStorage();

    attachEventListeners();

    settings.initializeUpdateBanner();

    window.electronAPI.onCloseRequest(() => {
      panels.handleCloseRequest();
    });

    window.electronAPI.onDirectoryChanged(({ panelId, dirPath }) => {
      const state = panelState[panelId];
      if (state && state.currentPath === dirPath) {
        panels.navigateToDirectory(dirPath, panelId, false).catch(err => {
          console.error(`Background refresh failed for panel ${panelId}:`, err);
        });
      }
    });

    window.electronAPI.onAlertCountUpdated(({ count }) => {
      panels.setUnacknowledgedAlertCount(count);
      alerts.updateAlertBadge();
    });

    window.electronAPI.onLoadLayoutFromFile((filePath) => {
      console.log('Loading layout from file:', filePath);
      window.electronAPI.loadLayoutFile(filePath)
        .then(result => {
          if (result.success && result.data) {
            console.log('Layout loaded successfully:', result.data);
            // Apply the layout to the app
            if (result.data.layoutData) {
              // Restore the layout structure and panels
              const layoutData = result.data.layoutData;
              // This will reload the panels with the saved layout
              panels.applyLayoutState(layoutData);
            }
          } else {
            console.error('Failed to load layout:', result.error || 'Unknown error');
          }
        })
        .catch(err => {
          console.error('Error loading layout from file:', err);
        });
    });

    await notes.initializeMonacoLoader();
    todos.initTodoModal();

    const bgSettings = await window.electronAPI.getSettings();
    window.electronAPI.startBackgroundRefresh(
      bgSettings.background_refresh_enabled || false,
      bgSettings.background_refresh_interval || 30
    );

    try {
      const countResult = await window.electronAPI.getUnacknowledgedAlertCount();
      if (countResult.success) {
        panels.setUnacknowledgedAlertCount(countResult.count);
        alerts.updateAlertBadge();
      }
    } catch (err) {
      console.warn('Could not load notification count:', err);
    }

    console.log('Initialization complete');

    panels.setActivePanelId(1);
    panels.setGridFocusedPanelId(1);
  } catch (err) {
    console.error('Error initializing app:', err);
    alert('Fatal error during initialization: ' + err.message);
  }
}


/**
 * Load all categories from IPC
 */
async function loadCategories() {
  try {
    allCategories = await window.electronAPI.loadCategories();
    await panels.loadCategories();
  } catch (err) {
    console.error('Error loading categories:', err);
  }
}

/**
 * Load configured tags list for context menu use
 */
async function loadTagsList() {
  try {
    allTags = await window.electronAPI.getTagsList();
    await panels.loadTagsList();
  } catch (err) {
    console.error('Error loading tags list:', err);
    allTags = [];
  }
}

/**
 * Load hotkeys from storage and populate registry
 */
export async function loadHotkeysFromStorage() {
  try {
    const hotkeysData = await window.electronAPI.getHotkeys();
    hotkeyRegistry = {};

    for (const context of Object.values(hotkeysData)) {
      for (const [actionId, actionData] of Object.entries(context)) {
        hotkeyRegistry[actionId] = normalizeHotkeyCombo(actionData.key);
      }
    }

    console.log('Hotkeys loaded:', hotkeyRegistry);
  } catch (err) {
    console.error('Error loading hotkeys:', err);
    hotkeyRegistry = {
      navigate_back: normalizeHotkeyCombo('Alt+Left'),
      navigate_forward: normalizeHotkeyCombo('Alt+Right'),
      navigate_up: normalizeHotkeyCombo('Alt+Up'),
      add_panel: normalizeHotkeyCombo('Ctrl+T'),
      close_panel: normalizeHotkeyCombo('Ctrl+W'),
      focus_path_bar: normalizeHotkeyCombo('Ctrl+L'),
      enter_path: normalizeHotkeyCombo('Enter'),
      cancel_path: normalizeHotkeyCombo('Escape'),
      edit_file: normalizeHotkeyCombo('F2'),
      save_file: normalizeHotkeyCombo('Ctrl+S')
    };
  }
}

function normalizeHotkeyCombo(combo) {
  return String(combo || '')
    .split('+')
    .map(part => part.trim().toLowerCase())
    .filter(Boolean)
    .join('+');
}

function getHotKeyCombo(event) {
  const parts = [];
  if (event.ctrlKey) parts.push('ctrl');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  if (event.metaKey) parts.push('meta');

  let key = event.key;
  // Normalize Arrow* key names to match the shorthand used in hotkeys.json
  // (e.g. "ArrowLeft" → "Left", "ArrowUp" → "Up")
  if (key.startsWith('Arrow')) {
    key = key.slice(5);
  }
  if (key.length === 1) {
    key = key.toLowerCase();
  }

  if (key === ' ') key = 'space';
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) {
    return normalizeHotkeyCombo(parts.join('+'));
  }

  parts.push(key);
  return normalizeHotkeyCombo(parts.join('+'));
}

function getActionForHotkey(combo) {
  const normalizedCombo = normalizeHotkeyCombo(combo);
  return Object.entries(hotkeyRegistry).find(([, hotkey]) => hotkey === normalizedCombo)?.[0] || null;
}

// ============================================================
// NOTES MODAL — Parsing Utilities (via IPC)
// ============================================================
// Notes parsing functions have been consolidated in src/notesParser.js
// and are accessed via IPC to ensure consistent behavior across the app

/**
 * Show the Load Layout modal with thumbnails of saved layouts
 */
async function showLoadLayoutModal() {
  const grid = document.getElementById('load-layout-grid');
  grid.innerHTML = '<div style="padding: 20px; text-align: center; color: #888;">Loading layouts...</div>';
  $('#load-layout-modal').show();

  const result = await window.electronAPI.listLayouts();
  if (!result.success) {
    grid.innerHTML = `<div style="padding: 20px; text-align: center; color: #c62828;">Error: ${result.error}</div>`;
    return;
  }

  if (result.layouts.length === 0) {
    grid.innerHTML = '<div style="padding: 20px; text-align: center; color: #888;">No saved layouts found.<br><span style="font-size: 12px; color: #aaa;">Use "Save Layout..." to save your first layout.</span></div>';
    return;
  }

  grid.innerHTML = '';
  for (const layout of result.layouts) {
    const card = document.createElement('div');
    card.style.cssText = 'display: flex; align-items: center; gap: 14px; padding: 10px 12px; border: 1px solid #e0e0e0; border-radius: 6px; margin-bottom: 8px; cursor: pointer; transition: background 0.15s;';
    card.onmouseenter = () => card.style.background = '#f5f9ff';
    card.onmouseleave = () => card.style.background = '';

    const thumb = document.createElement('div');
    thumb.style.cssText = 'width: 120px; height: 75px; flex-shrink: 0; border-radius: 4px; overflow: hidden; background: #f0f0f0; border: 1px solid #ddd;';
    if (layout.thumbnailBase64) {
      const img = document.createElement('img');
      img.src = 'data:image/png;base64,' + layout.thumbnailBase64;
      img.style.cssText = 'width: 100%; height: 100%; object-fit: cover;';
      thumb.appendChild(img);
    } else {
      thumb.innerHTML = '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#bbb;font-size:11px;">No preview</div>';
    }

    const info = document.createElement('div');
    info.style.cssText = 'flex: 1; min-width: 0;';
    const name = layout.fileName.replace(/\.aly$/i, '');
    const date = new Date(layout.savedAt);
    const dateStr = date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) + ' ' + date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const panelLabel = layout.panelCount ? `${layout.panelCount} panel${layout.panelCount > 1 ? 's' : ''}` : '';
    info.innerHTML = `<div style="font-weight: 600; font-size: 14px; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${utils.escapeHtml(name)}</div>`
      + `<div style="font-size: 12px; color: #888;">${dateStr}${panelLabel ? ' &middot; ' + panelLabel : ''}</div>`
      + (layout.description ? `<div style="font-size: 12px; color: #555; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${utils.escapeHtml(layout.description)}</div>` : '');

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '\u00D7';
    deleteBtn.title = 'Delete layout';
    deleteBtn.style.cssText = 'flex-shrink: 0; width: 28px; height: 28px; border: none; background: transparent; color: #999; font-size: 18px; cursor: pointer; border-radius: 4px; display: flex; align-items: center; justify-content: center;';
    deleteBtn.onmouseenter = () => { deleteBtn.style.background = '#ffebee'; deleteBtn.style.color = '#c62828'; };
    deleteBtn.onmouseleave = () => { deleteBtn.style.background = 'transparent'; deleteBtn.style.color = '#999'; };
    deleteBtn.onclick = async (e) => {
      e.stopPropagation();
      const delResult = await window.electronAPI.deleteLayout(layout.filePath);
      if (delResult.success) {
        card.remove();
        // Show empty message if no cards remain
        if (grid.children.length === 0) {
          grid.innerHTML = '<div style="padding: 20px; text-align: center; color: #888;">No saved layouts found.</div>';
        }
      }
    };

    card.onclick = async () => {
      const loadResult = await window.electronAPI.loadLayoutFile(layout.filePath);
      if (loadResult.success && loadResult.layoutData) {
        $('#load-layout-modal').hide();
        await panels.applyLayoutState(loadResult.layoutData);
      } else if (loadResult.error) {
        console.error('Failed to load layout:', loadResult.error);
      }
    };

    card.appendChild(thumb);
    card.appendChild(info);
    card.appendChild(deleteBtn);
    grid.appendChild(card);
  }
}

/**
 * Find the next available "New folder" name in parentPath.
 * Mirrors Windows behaviour: "New folder", "New folder (2)", "New folder (3)", …
 */
async function getAvailableNewFolderName(parentPath) {
  let existingNames;
  try {
    const entries = await window.electronAPI.readDirectory(parentPath);
    existingNames = new Set(entries.map(e => e.filename.toLowerCase()));
  } catch (_) {
    return 'New folder';
  }
  const base = 'New folder';
  if (!existingNames.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!existingNames.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Show the New Folder modal for the given panel context.
 */
async function showNewFolderModal(parentPath, panelId) {
  const input = document.getElementById('new-folder-name-input');
  const errorEl = document.getElementById('new-folder-error');
  input.value = await getAvailableNewFolderName(parentPath);
  errorEl.textContent = '';
  $('#new-folder-modal').show();
  input.select();
  input.focus();

  async function doCreate() {
    const name = input.value.trim();
    errorEl.textContent = '';
    if (!name) {
      errorEl.textContent = 'Folder name cannot be empty.';
      return;
    }
    const result = await window.electronAPI.createFolder(parentPath, name);
    if (result.success) {
      closeNewFolderModal();
      await panels.navigateToDirectory(parentPath, panelId);
      // Select and scroll to the new folder
      const state = panelState[panelId];
      const grid = state && state.w2uiGrid;
      if (grid) {
        const record = grid.records.find(r => r.path === result.path);
        if (record) {
          grid.selectNone();
          grid.select(record.recid);
          if (typeof grid.scrollIntoView === 'function') grid.scrollIntoView(record.recid);
        }
      }
    } else {
      errorEl.textContent = result.error || 'Could not create folder.';
      input.focus();
    }
  }

  // Store handlers so they can be removed on close
  input._newFolderKeydown = async function (e) {
    if (e.key === 'Enter') { e.preventDefault(); await doCreate(); }
    if (e.key === 'Escape') { e.preventDefault(); closeNewFolderModal(); }
  };
  document.getElementById('btn-new-folder-confirm')._newFolderClick = doCreate;

  input.addEventListener('keydown', input._newFolderKeydown);
  document.getElementById('btn-new-folder-confirm').addEventListener('click', doCreate);
}

function closeNewFolderModal() {
  $('#new-folder-modal').hide();
  const input = document.getElementById('new-folder-name-input');
  if (input && input._newFolderKeydown) {
    input.removeEventListener('keydown', input._newFolderKeydown);
    delete input._newFolderKeydown;
  }
}

/**
 * Attach event listeners to buttons and grid
 */
function attachEventListeners() {
  // Capture-phase key handler for grid navigation and panel cycling.
  // Must be capture phase so we can intercept before the browser or w2ui processes them.
  document.addEventListener('keydown', function (event) {
    // While a w2ui in-grid confirm message (e.g. delete confirmation) is open,
    // swallow navigation/shortcut keys so the grid underneath does not move selection.
    // Enter confirms the dialog; Escape and Tab are passed through natively.
    if (document.querySelector('.w2ui-message')) {
      if (event.key === 'Enter') {
        // Click the primary action button (yes/delete — rendered with name="yes")
        const yesBtn = document.querySelector('.w2ui-message button[name="yes"]')
                    || document.querySelector('.w2ui-message .w2ui-btn-red');
        if (yesBtn) {
          event.preventDefault();
          event.stopPropagation();
          yesBtn.click();
        }
        return;
      }
      if (event.key !== 'Escape' && event.key !== 'Tab') {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    // Delete key: trigger grid deletion on the focused grid panel.
    // We handle this ourselves because w2ui's keyboard-textarea loses reliable
    // focus whenever our custom arrow-key navigation (gridNavigate) is used.
    if (event.key === 'Delete' && !event.ctrlKey && !event.altKey && !event.metaKey && !sidebarHasFocus) {
      const tgt = event.target;
      const inRealInput = tgt && (
        tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' ||
        tgt.contentEditable === 'true' ||
        (tgt.tagName === 'TEXTAREA' && $(tgt).closest('.panel-grid').length === 0)
      );
      if (!inRealInput) {
        const viewType = panels.getPanelViewType(activePanelId);
        if (viewType === 'grid' || viewType === 'gallery') {
          const gridPanelId = (panels.gridFocusedPanelId !== null && panels.gridFocusedPanelId !== undefined)
            ? panels.gridFocusedPanelId
            : activePanelId;
          const grid = panelState[gridPanelId]?.w2uiGrid;
          if (grid && grid.getSelection().length > 0) {
            event.preventDefault();
            event.stopPropagation();
            grid['delete']();
          }
        }
      }
      return;
    }

    // Tab / Shift+Tab: cycle focus through sidebar and panels
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const tgt = event.target;
      const inInput = tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' ||
          tgt.contentEditable === 'true' ||
          (tgt.tagName === 'TEXTAREA' && $(tgt).closest('.panel-grid').length === 0));
      if (!inInput) {
        event.preventDefault();
        event.stopPropagation();
        // Tab order: sidebar(0) → panel 1 → panel 2 → ... → panel N → sidebar(0)
        // Current position: 0 = sidebar, 1..N = panel id
        const current = sidebarHasFocus ? 0 : activePanelId;
        const slotCount = panels.visiblePanels + 1; // sidebar + N panels
        let next;
        if (event.shiftKey) {
          next = (current - 1 + slotCount) % slotCount;
        } else {
          next = (current + 1) % slotCount;
        }
        if (next === 0) {
          // Focus sidebar
          setSidebarFocus(true);
        } else {
          // Focus panel (setActivePanelId clears sidebar focus)
          panels.setActivePanelId(next);
          // Auto-focus the grid so arrow keys work immediately
          panels.setGridFocusedPanelId(next);
        }
        return;
      }
    }

    // Sidebar keyboard navigation when sidebar is focused
    if (sidebarHasFocus && !event.altKey && !event.ctrlKey && !event.metaKey &&
        (event.key === 'ArrowUp' || event.key === 'ArrowDown' ||
         event.key === 'ArrowLeft' || event.key === 'ArrowRight' ||
         event.key === 'Enter')) {
      const tgt = event.target;
      const inInput = tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' ||
          tgt.contentEditable === 'true' ||
          (tgt.tagName === 'TEXTAREA' && $(tgt).closest('.panel-grid').length === 0));
      if (!inInput) {
        event.preventDefault();
        event.stopPropagation();
        sidebar.handleSidebarArrowKey(event.key);
        return;
      }
    }

    // Printable key while grid/gallery has focus → redirect to search bar
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const target = event.target;
      const isRealInput = target && (
        target.tagName === 'INPUT' || target.tagName === 'SELECT' ||
        target.contentEditable === 'true' ||
        (target.tagName === 'TEXTAREA' && $(target).closest('.panel-grid').length === 0)
      );
      if (!isRealInput) {
        const viewType = panels.getPanelViewType(activePanelId);
        if (viewType === 'gallery' || viewType === 'grid') {
          event.preventDefault();
          event.stopPropagation();
          panels.focusSearchBarWithChar(activePanelId, event.key);
          return;
        }
      }
    }

    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown' ||
         event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
        !event.altKey && !event.ctrlKey && !event.metaKey) {
      const galleryPanelId = panels.getPanelViewType(activePanelId) === 'gallery'
        ? activePanelId
        : (panels.gridFocusedPanelId !== null && panels.gridFocusedPanelId !== undefined
            ? panels.gridFocusedPanelId
            : activePanelId);
      if (galleryPanelId !== null && galleryPanelId !== undefined &&
          panels.getPanelViewType(galleryPanelId) === 'gallery') {
        const target = event.target;
        const isRealInput = target &&
            (target.tagName === 'INPUT' || target.tagName === 'SELECT' ||
             target.contentEditable === 'true' ||
             (target.tagName === 'TEXTAREA' && $(target).closest('.panel-grid').length === 0));
        if (!isRealInput) {
          event.preventDefault();
          event.stopPropagation();
          panels.galleryNavigate(event.key.replace('Arrow', '').toLowerCase(), galleryPanelId);
          return;
        }
      }
    }

    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
        !event.altKey && !event.ctrlKey && !event.metaKey) {
      let targetPanelId = panels.gridFocusedPanelId;
      if (targetPanelId === null || targetPanelId === undefined) {
        if (panelState[activePanelId] && panelState[activePanelId].w2uiGrid &&
            $(`#panel-${activePanelId} .panel-grid`).is(':visible')) {
          targetPanelId = activePanelId;
        }
      }
      if (targetPanelId !== null && targetPanelId !== undefined &&
          panelState[targetPanelId] && panelState[targetPanelId].w2uiGrid &&
          $(`#panel-${targetPanelId} .panel-grid`).is(':visible')) {
        // Check the event target is not a real user input (path input, search box, etc.).
        // w2ui's own keyboard-capture textarea lives inside .panel-grid — allow that through.
        const target = event.target;
        const isRealInput = target &&
            (target.tagName === 'INPUT' || target.tagName === 'SELECT' ||
             target.contentEditable === 'true' ||
             (target.tagName === 'TEXTAREA' && $(target).closest('.panel-grid').length === 0));
        if (!isRealInput) {
          event.preventDefault();
          event.stopPropagation();
          panels.gridNavigate(event.key === 'ArrowUp' ? 'up' : 'down', event.shiftKey, targetPanelId);
        }
      }
    }
  }, true);

  // Keyboard shortcuts - detect hotkey and dispatch to appropriate handler
  $(document).keydown(async function (event) {
    if (event.key === 'Escape' && panels.handleTransientEscape()) {
      return;
    }

    // Escape with no input focused: clear active panel search
    if (event.key === 'Escape') {
      const tgt = event.target;
      const inInput = tgt && (
        tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' ||
        tgt.contentEditable === 'true' ||
        (tgt.tagName === 'TEXTAREA' && $(tgt).closest('.panel-grid').length === 0)
      );
      if (!inInput) {
        const viewType = panels.getPanelViewType(activePanelId);
        if ((viewType === 'grid' || viewType === 'gallery') && panelState[activePanelId]?.toolbarSearch) {
          panels.applyPanelToolbarSearch(activePanelId, '');
          const toolbar = document.querySelector(`#panel-${activePanelId} .panel-toolbar`);
          if (toolbar) {
            const input = toolbar.querySelector('.panel-tb-search');
            if (input) input.value = '';
          }
          return;
        }
      }
    }

    // Escape key: close item properties modal if open
    if (event.key === 'Escape' && $('#item-props-modal').is(':visible')) {
      panels.hideItemPropsModal();
      return;
    }

    // Escape key: close image viewer modal if open
    if (event.key === 'Escape' && $('#image-viewer-modal').is(':visible')) {
      $('#image-viewer-modal').hide();
      return;
    }

    // Escape key: close notes modal if open
    if (event.key === 'Escape' && $('#notes-modal').is(':visible')) {
      notes.hideNotesModal();
      return;
    }

    // Escape key: close new folder modal if open
    if (event.key === 'Escape' && $('#new-folder-modal').is(':visible')) {
      closeNewFolderModal();
      return;
    }

    const hotkeyCombo = getHotKeyCombo(event);
    const actionId = getActionForHotkey(hotkeyCombo);

    // Only handle recognized hotkeys
    if (!actionId) return;

    switch (actionId) {
      case 'navigate_back':
        event.preventDefault();
        panels.navigateBack();
        break;
      case 'navigate_forward':
        event.preventDefault();
        panels.navigateForward();
        break;
      case 'navigate_up':
        event.preventDefault();
        const state = panelState[activePanelId];
        if (!state.currentPath || typeof state.currentPath !== 'string' || state.currentPath.trim() === '') {
          console.warn('[navigate_up] Invalid current path');
          break;
        }

        let path = state.currentPath.trim();

        // Remove trailing backslash for consistent handling
        if (path.endsWith('\\')) {
          path = path.substring(0, path.length - 1);
        }

        // Check if at drive root (e.g., "E:", "C:")
        if (path.length === 2 && path[1] === ':') {
          console.info(`[navigate_up] Already at drive root: ${path}`);
          break;
        }

        // Find last backslash
        const lastSlash = path.lastIndexOf('\\');
        if (lastSlash <= 2) {
          console.warn(`[navigate_up] Cannot navigate up from: ${path}`);
          break;
        }

        const parentPath = path.substring(0, lastSlash);
        if (parentPath.length == 2 && parentPath[1] === ':') {
          // Add backslash for drive root
          parentPath += '\\';
        }
        console.info(`[navigate_up] Navigating from ${state.currentPath} to ${parentPath}`);
        panels.navigateToDirectory(parentPath, activePanelId);
        break;
      case 'edit_file':
        const $fileView = $(`#panel-${activePanelId} .panel-file-view`);
        if ($fileView.is(':visible') && !fileEditMode) {
          event.preventDefault();
          await notes.toggleFileEditMode(activePanelId);
        }
        break;
      case 'save_file':
        const $fileViewSave = $(`#panel-${activePanelId} .panel-file-view`);
        if ($fileViewSave.is(':visible') && fileEditMode) {
          event.preventDefault();
          await notes.toggleFileEditMode(activePanelId);
        }
        break;
      case 'add_panel':
        event.preventDefault();
        panels.addPanel();
        break;
      case 'open_terminal': {
        event.preventDefault();
        const cwd = panelState[1].currentPath || '';
        let termPanelId;
        if (panels.visiblePanels < 4) {
          termPanelId = panels.visiblePanels + 1;
          panels.setVisiblePanels(termPanelId);
          $(`#panel-${termPanelId}`).show();
          panels.attachPanelEventListeners(termPanelId);
          panels.updatePanelLayout();
        } else {
          termPanelId = panels.visiblePanels;
        }
        await terminal.createTerminalPanel(termPanelId, cwd);
        break;
      }
      case 'close_panel':
        event.preventDefault();
        panels.closeActivePanel();
        break;
      case 'focus_path_bar':
        event.preventDefault();
        panels.activatePathEditMode(activePanelId);
        break;
      case 'enter_path': {
        // Don't navigate while a w2ui confirmation dialog is open inside a grid
        if (document.querySelector('.w2ui-message')) {
          break;
        }
        const tgt = event.target;
        const isRealInput = tgt && (
          tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' ||
          tgt.contentEditable === 'true' ||
          (tgt.tagName === 'TEXTAREA' && $(tgt).closest('.panel-grid').length === 0)
        );
        if (!isRealInput) {
          const targetPanelId = activePanelId;
          const viewType = panels.getPanelViewType(targetPanelId);
          if (viewType === 'gallery') {
            const state = panelState[targetPanelId];
            if (state && state.gallerySelectedRecids && state.gallerySelectedRecids.size > 0) {
              const recid = [...state.gallerySelectedRecids][0];
              const record = (state.galleryRecords || []).find(r => r.recid === recid);
              if (record) {
                event.preventDefault();
                if (record.isFolder && record.changeState !== 'moved') {
                  panels.navigateToDirectory(record.path, targetPanelId);
                } else if (!record.isFolder) {
                  if (record.path && record.path.toLowerCase().endsWith('.aly')) {
                    panels.openAlyLayoutModal(record.path);
                  } else {
                    panels.showItemPropsModal(record, targetPanelId);
                  }
                }
              }
            }
          } else if (viewType !== 'properties') {
            const gridState = panelState[targetPanelId];
            if (gridState && gridState.w2uiGrid && $(`#panel-${targetPanelId} .panel-grid`).is(':visible')) {
              const grid = gridState.w2uiGrid;
              const selected = grid.getSelection();
              if (selected.length === 1) {
                const recid = selected[0];
                const record = grid.records.find(r => r.recid === recid);
                if (record) {
                  event.preventDefault();
                  if (record.isFolder && record.changeState !== 'moved') {
                    panels.navigateToDirectory(record.path, targetPanelId);
                  } else if (!record.isFolder) {
                    if (record.path && record.path.toLowerCase().endsWith('.aly')) {
                      panels.openAlyLayoutModal(record.path);
                    } else {
                      panels.showItemPropsModal(record, targetPanelId);
                    }
                  }
                }
              }
            }
          }
        }
        break;
      }
      case 'open_item':
        event.preventDefault();
        panels.openSelectedItem(activePanelId);
        break;
      case 'reopen_panel':
        event.preventDefault();
        await panels.reopenLastClosedPanel();
        break;
      case 'save_layout': {
        event.preventDefault();
        const layoutData = panels.serializeLayoutState();
        const result = await window.electronAPI.saveLayout(layoutData);
        if (result.error) console.error('Failed to save layout:', result.error);
        break;
      }
      case 'load_layout': {
        event.preventDefault();
        await showLoadLayoutModal();
        break;
      }
      case 'new_folder': {
        event.preventDefault();
        const state = panelState[activePanelId];
        if (!state || !state.currentPath) break;
        await showNewFolderModal(state.currentPath, activePanelId);
        break;
      }
    }
  });

  // Window focus/blur handlers for panel selection styling
  $(window).blur(function () {
    // When window loses focus, remove selection styling from all panels and sidebar
    for (let i = 1; i <= 4; i++) {
      $(`#panel-${i} .panel-number`).removeClass('panel-number-selected');
    }
    $('#sidebar-content').removeClass('sidebar-focused');
  });

  $(window).focus(function () {
    // When window regains focus, restore focus styling
    if (sidebarHasFocus) {
      $('#sidebar-content').addClass('sidebar-focused');
    } else {
      $(`#panel-${activePanelId} .panel-number`).addClass('panel-number-selected');
    }
  });

  // View button - show layout modal
  $('#btn-view').click(function () {
    panels.showLayoutModal();
  });

  $('#btn-sidebar-add-panel').click(function () {
    panels.addPanel();
  });

  // Layout option buttons
  $('.layout-option').click(function () {
    const layoutNumber = parseInt($(this).data('layout'));
    panels.switchLayout(layoutNumber);
    panels.hideLayoutModal();
  });

  // Layout modal close button and overlay
  $('#btn-layout-close').click(function () {
    panels.hideLayoutModal();
  });

  $('#layout-modal').click(function (e) {
    if (e.target === this) {
      panels.hideLayoutModal();
    }
  });

  // Layout save/load buttons
  $('#btn-layout-save').click(async function () {
    const layoutData = panels.serializeLayoutState();
    const result = await window.electronAPI.saveLayout(layoutData);
    if (result.success) {
      panels.hideLayoutModal();
    } else if (result.error) {
      console.error('Failed to save layout:', result.error);
    }
  });

  $('#btn-layout-load').click(async function () {
    panels.hideLayoutModal();
    await showLoadLayoutModal();
  });

  // Load Layout modal close
  $('#btn-load-layout-close').click(function () {
    $('#load-layout-modal').hide();
  });
  $('#load-layout-modal').click(function (e) {
    if (e.target === this) $(this).hide();
  });

  // New Folder modal
  $('#btn-new-folder-close, #btn-new-folder-cancel').click(function () {
    closeNewFolderModal();
  });
  $('#new-folder-modal').click(function (e) {
    if (e.target === this) closeNewFolderModal();
  });

  // Save Layout Global modal
  $('#btn-save-layout-global-close, #btn-save-layout-global-cancel').click(function () {
    panels.closeSaveLayoutGlobalModal();
  });
  $('#save-layout-global-modal').click(function (e) {
    if (e.target === this) panels.closeSaveLayoutGlobalModal();
  });
  $('#btn-save-layout-global-confirm').click(async function () {
    await panels.confirmSaveLayoutGlobal();
  });
  $('#save-layout-global-name').on('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      panels.confirmSaveLayoutGlobal();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      panels.closeSaveLayoutGlobalModal();
    }
  });
  $('#save-layout-global-desc').on('input', function () {
    const count = document.getElementById('save-layout-global-desc-count');
    if (count) count.textContent = this.value.length;
  });

  // ALY layout open-confirm modal
  $('#btn-aly-open-close, #btn-aly-open-cancel').click(function () {
    panels.closeAlyLayoutModal();
  });
  $('#aly-open-modal').click(function (e) {
    if (e.target === this) panels.closeAlyLayoutModal();
  });
  $('#btn-aly-open-confirm').click(async function () {
    await panels.confirmLoadAlyLayout();
  });

  // Browse for .aly file (fallback to native dialog)
  $('#btn-load-layout-browse').click(async function () {
    const result = await window.electronAPI.loadLayout();
    if (result.success && result.layoutData) {
      $('#load-layout-modal').hide();
      await panels.applyLayoutState(result.layoutData);
    } else if (result.error) {
      console.error('Failed to load layout:', result.error);
    }
  });

  // Panel button handlers - add click listeners for all panels (0 = item-props modal)
  for (let panelId = 0; panelId <= 4; panelId++) {
    panels.attachPanelEventListeners(panelId);
  }

  // Item properties modal close button
  $('#btn-item-props-modal-close').click(function () {
    panels.hideItemPropsModal();
  });

  // Close item properties modal when clicking the backdrop
  $('#item-props-modal').on('click', function (e) {
    if (e.target === this) panels.hideItemPropsModal();
  });

  // Settings modal close button
  $('#btn-settings-close').click(function () {
    settings.hideSettingsModal();
  });

  // Sidebar toolbar: Settings
  $('#btn-sidebar-settings-toolbar').click(function () {
    settings.showSettingsModal();
  });

  // Sidebar toolbar: Collapse / expand
  $('#btn-sidebar-collapse').click(function () {
    sidebar.toggleSidebarCollapse();
  });

  // Sidebar toolbar: Alerts
  $('#btn-sidebar-alerts').click(function () {
    alerts.showAlertsModal();
  });

  // Sidebar toolbar: Tagging
  $('#btn-sidebar-label-manager').click(function () {
    settings.showLabelManagerModal();
  });

  // Sidebar toolbar: Terminal — left click opens modal, right click opens panel context menu
  $('#btn-sidebar-terminal').click(function () {
    const activePanel = Object.keys(panelState).find(id => $(`#panel-${id}`).hasClass('panel-active'));
    const cwd = activePanel && panelState[activePanel] ? panelState[activePanel].currentPath : undefined;
    terminal.updateTerminalModalPanelButtons(panels.visiblePanels, (targetPanelId) => {
      terminal.snapModalTerminalToPanel(targetPanelId, (panelId) => {
        if (panelId > panels.visiblePanels) {
          panels.setVisiblePanels(panelId);
          $(`#panel-${panelId}`).show();
          panels.attachPanelEventListeners(panelId);
          panels.updatePanelLayout();
        }
      });
    });
    terminal.openTerminalModal(cwd, Number(activePanel) || 1);
  });

  $('#btn-sidebar-terminal').on('contextmenu', function (e) {
    e.preventDefault();
    const activePanel = Object.keys(panelState).find(id => $(`#panel-${id}`).hasClass('panel-active'));
    const cwd = activePanel && panelState[activePanel] ? panelState[activePanel].currentPath : undefined;

    contexts.hideCustomContextMenu();

    const menu = document.createElement('div');
    menu.id = 'custom-ctx-menu';
    menu.className = 'custom-ctx-menu';

    const addRow = (text, action) => {
      const row = document.createElement('div');
      row.className = 'custom-ctx-item';
      const label = document.createElement('span');
      label.className = 'custom-ctx-label';
      label.textContent = text;
      row.appendChild(label);
      row.addEventListener('mouseenter', () => {
        menu.querySelectorAll('.custom-ctx-item').forEach(r => r.classList.remove('active'));
        row.classList.add('active');
      });
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        contexts.hideCustomContextMenu();
        action();
      });
      menu.appendChild(row);
    };

    // Existing panels 2-4 (panel 1 has no terminal container)
    for (let i = 2; i <= panels.visiblePanels; i++) {
      const targetPanelId = i;
      addRow(`Open in Panel ${targetPanelId}`, async () => {
        await terminal.createTerminalPanel(targetPanelId, cwd);
        panels.setActivePanelId(targetPanelId);
      });
    }
    // N+1: open a new panel (capped at 4)
    if (panels.visiblePanels < 4) {
      const newPanelId = panels.visiblePanels + 1;
      addRow(`Open in new Panel ${newPanelId}`, async () => {
        const created = panels.addPanel();
        const targetId = created ?? newPanelId;
        await terminal.createTerminalPanel(targetId, cwd);
        panels.setActivePanelId(targetId);
      });
    }

    if (!menu.children.length) return;

    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    document.body.appendChild(menu);

    requestAnimationFrame(() => {
      const mr = menu.getBoundingClientRect();
      if (mr.right > window.innerWidth) menu.style.left = (e.clientX - mr.width) + 'px';
      if (mr.bottom > window.innerHeight) menu.style.top = (e.clientY - mr.height) + 'px';
    });

    const onOutside = (ev) => {
      if (!ev.target.closest?.('#custom-ctx-menu')) {
        contexts.hideCustomContextMenu();
        document.removeEventListener('click', onOutside);
        document.removeEventListener('keydown', onEsc);
      }
    };
    const onEsc = (ev) => {
      if (ev.key === 'Escape') {
        contexts.hideCustomContextMenu();
        document.removeEventListener('click', onOutside);
        document.removeEventListener('keydown', onEsc);
      }
    };
    document.addEventListener('click', onOutside);
    document.addEventListener('keydown', onEsc);
  });

  // Terminal drawer: close button (also bound inside openTerminalModal, this is a belt-and-suspenders binding)
  $('#btn-terminal-drawer-close').click(function () {
    terminal.closeTerminalModal();
  });

  // Tagging modal close button
  $('#btn-tagging-close').click(async function () {
    settings.hideTaggingModal();
    await loadCategories();
    await loadTagsList();
  });

  // Tagging modal overlay click to close
  $('#tagging-modal').click(async function (e) {
    if (e.target === this) {
      settings.hideTaggingModal();
      await loadCategories();
      await loadTagsList();
    }
  });

  // Tagging tab buttons
  $('.tagging-tab-btn').click(function () {
    const tabName = $(this).data('tab');
    settings.switchTaggingTab(tabName);
  });

  // Settings modal overlay click to close
  $('#settings-modal').click(function (e) {
    if (e.target === this) {
      settings.hideSettingsModal();
    }
  });

  // Settings tab buttons
  $('.settings-tab-btn').click(function () {
    const tabName = $(this).data('tab');
    settings.switchSettingsTab(tabName);
  });

  // Category form save button
  $('#btn-cat-save').click(async function () {
    await settings.saveCategoryFromForm();
  });

  // Category form delete button
  $('#btn-cat-delete').click(async function () {
    await settings.deleteCategoryFromForm();
  });

  // Browser settings: validate directory while typing
  $('#browser-home-directory').on('input', async function () {
    await settings.updateHomeDirectoryWarning($(this).val());
  });

  // Browser Settings - Advanced: reinitialize database button
  $('#btn-dev-reinitialize-db').click(async function () {
    w2confirm({
      msg: 'This will delete all file history and directory assignments.<br><br>This action cannot be undone.',
      title: 'Reinitialize Database?',
      width: 450,
      height: 200,
      btn_yes: {
        text: 'Reinitialize',
        class: '',
        style: ''
      },
      btn_no: {
        text: 'Cancel',
        class: '',
        style: ''
      }
    }).yes(async () => {
      try {
        const result = await window.electronAPI.reinitializeDatabase();
        if (result.success) {
          alert('Database reinitialized successfully. The application will now reload.');
          // Reload the page to reset all state
          window.location.reload();
        } else {
          alert('Error reinitializing database: ' + result.error);
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    });
  });

  // Tag form save button
  $('#btn-tag-save').click(async function () {
    await settings.saveTagFromForm();
  });

  // Tag form delete button
  $('#btn-tag-delete').click(async function () {
    await settings.deleteTagFromForm();
  });

  // Attribute form save button
  $('#btn-attr-save').click(async function () {
    await settings.saveAttributeFromForm();
  });

  // Attribute form delete button
  $('#btn-attr-delete').click(async function () {
    await settings.deleteAttributeFromForm();
  });

  // Attribute type change - toggle options section
  $('#form-attr-type').on('change', function () {
    settings.toggleAttrOptionsSection();
  });

  // Attribute options: Add button and Enter key
  $('#btn-attr-option-add').on('click', function () {
    const val = $('#form-attr-option-input').val();
    settings.addAttrOption(val);
    $('#form-attr-option-input').val('').focus();
  });
  $('#form-attr-option-input').on('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = $(this).val();
      settings.addAttrOption(val);
      $(this).val('');
    }
  });

  // File Types form save button
  $('#btn-ft-save').click(async function () {
    await settings.saveFileTypeFromForm();
  });

  // File Types form clear/new button
  $('#btn-ft-clear').click(function () {
    settings.clearFileTypeForm();
  });

  // File Types form delete button
  $('#btn-ft-delete').click(async function () {
    await settings.deleteFileTypeFromForm();
  });

  // Hotkeys form demo button
  $('#btn-hotkey-demo').click(function () {
    settings.enterHotkeyDemoMode();
  });

  // Hotkeys form save button
  $('#btn-hotkey-save').click(async function () {
    await settings.saveHotkeyFromForm();
  });

  // Hotkeys form reset button
  $('#btn-hotkey-reset').click(async function () {
    await settings.resetHotkeyToDefault();
  });

  // History modal close button
  $('#btn-history-close').click(function () {
    history.hideHistoryModal();
  });

  // History modal overlay click to close
  $('#history-modal').click(function (e) {
    if (e.target === this) {
      history.hideHistoryModal();
    }
  });

  // Notes modal close button
  $('#btn-notes-close').click(function () {
    notes.hideNotesModal();
  });

  // Notes modal Edit/Save buttons
  $('#btn-notes-edit').click(async function () {
    await notes.toggleNotesEditMode();
  });
  $('#btn-notes-save').click(async function () {
    await notes.toggleNotesEditMode();
  });

  // Notes modal overlay click to close
  $('#notes-modal').click(function (e) {
    if (e.target === this) {
      notes.hideNotesModal();
    }
  });

  // Image viewer modal close button and overlay click
  $('#btn-image-viewer-close').click(function () {
    $('#image-viewer-modal').hide();
  });
  $('#image-viewer-modal').click(function (e) {
    if (e.target === this) {
      $('#image-viewer-modal').hide();
    }
  });

  // Alerts modal close button
  $('#btn-alerts-close').click(function () {
    alerts.hideAlertsModal();
  });

  // Alerts modal overlay click to close
  $('#alerts-modal').click(function (e) {
    if (e.target === this) {
      alerts.hideAlertsModal();
    }
  });

  // Alerts tab switching
  $('.alerts-tab-btn').click(function () {
    alerts.switchTab($(this).data('tab'));
  });

  // Alerts summary: Acknowledge selected
  $('#btn-alerts-acknowledge').click(async function () {
    await alerts.acknowledgeSelected();
  });

  $('#btn-alerts-select-all').click(function () {
    alerts.selectAllSummaryAlerts();
  });

  // Alerts configuration: Add new rule
  $('#btn-alerts-rule-add').click(function () {
    alerts.openNewRuleEditor();
  });

  // Alerts configuration: Edit selected rule
  $('#btn-alerts-rule-edit').click(function () {
    const sel = w2ui['alerts-rules-grid'] ? w2ui['alerts-rules-grid'].getSelection() : [];
    if (sel.length === 1) {
      const rec = w2ui['alerts-rules-grid'].get(sel[0]);
      if (rec) alerts.openRuleEditor(rec._raw);
    }
  });

  // Alerts configuration: Delete selected rules
  $('#btn-alerts-rule-delete').click(async function () {
    await alerts.deleteRules();
  });

  // Alerts configuration: Save rule
  $('#btn-alerts-rule-save').click(async function () {
    await alerts.saveRule();
  });

  // Alerts configuration: Cancel rule editor
  $('#btn-alerts-rule-cancel').click(function () {
    alerts.closeRuleEditor();
  });

  // Monitoring configuration: Add new rule
  $('#btn-monitoring-rule-add').click(function () {
    alerts.openNewMonitoringRuleEditor();
  });

  // Monitoring configuration: Edit selected rule
  $('#btn-monitoring-rule-edit').click(function () {
    const sel = w2ui['monitoring-rules-grid'] ? w2ui['monitoring-rules-grid'].getSelection() : [];
    if (sel.length === 1) {
      const rec = w2ui['monitoring-rules-grid'].get(sel[0]);
      if (rec) alerts.openMonitoringRuleEditor(rec._raw);
    }
  });

  // Monitoring configuration: Delete selected rules
  $('#btn-monitoring-rule-delete').click(async function () {
    await alerts.deleteMonitoringRules();
  });

  // Monitoring configuration: Save rule
  $('#btn-monitoring-rule-save').click(async function () {
    await alerts.saveMonitoringRule();
  });

  // Monitoring configuration: Cancel rule editor
  $('#btn-monitoring-rule-cancel').click(function () {
    alerts.closeMonitoringRuleEditor();
  });

  // Alerts and Monitoring settings: Save
  $('#btn-alerts-settings-save').click(async function () {
    await alerts.saveMonitoringSettings();
  });
}

/**
 * Show settings modal
 */
export async function showSettingsModal() {
  return settings.showSettingsModal();
}

/**
 * Refresh the categories list in modal
 */
async function refreshCategoriesList() {
  const container = $('#modal-categories-list');
  container.empty();

  const categories = await window.electronAPI.loadCategories();

  for (const [name, category] of Object.entries(categories)) {
    const catDiv = $('<div>').css({
      'padding': '10px',
      'margin': '10px 0',
      'border': '1px solid #ddd',
      'border-radius': '4px',
      'background': category.bgColor
    });

    const nameSpan = $('<div>').css({
      'font-weight': 'bold',
      'color': category.textColor,
      'margin-bottom': '5px'
    }).text(name);

    const controlsDiv = $('<div>').css('margin-top', '10px');

    if (name !== 'Default') {
      const editBtn = $('<button>')
        .text('Edit')
        .css({
          'padding': '4px 8px',
          'margin-right': '5px',
          'margin-bottom': '5px',
          'background': '#2196F3',
          'color': 'white',
          'border': 'none',
          'border-radius': '4px',
          'cursor': 'pointer'
        })
        .click(function () {
          editCategory(name, category);
        });

      const deleteBtn = $('<button>')
        .text('Delete')
        .css({
          'padding': '4px 8px',
          'margin-bottom': '5px',
          'background': '#f44336',
          'color': 'white',
          'border': 'none',
          'border-radius': '4px',
          'cursor': 'pointer'
        })
        .click(async function () {
          w2confirm({
            msg: `Delete category "${name}"?<br><br>This action cannot be undone.`,
            title: 'Delete Category',
            width: 380,
            height: 180,
            btn_yes: {
              text: 'Delete',
              class: '',
              style: ''
            },
            btn_no: {
              text: 'Cancel',
              class: '',
              style: ''
            }
          }).yes(async () => {
            try {
              await window.electronAPI.deleteCategory(name);
              await loadCategories();
              await refreshCategoriesList();
            } catch (err) {
              alert('Error deleting category: ' + err.message);
            }
          });
        });

      controlsDiv.append(editBtn, deleteBtn);
    }

    catDiv.append(nameSpan, controlsDiv);
    container.append(catDiv);
  }
}

/**
 * Edit category - shows form with current values
 */
function editCategory(name, category) {
  const newBgColor = prompt('Enter background color (rgb format or hex):', category.bgColor);
  if (newBgColor === null) return;

  const newTextColor = prompt('Enter text color (rgb format or hex):', category.textColor);
  if (newTextColor === null) return;

  const newPatterns = prompt('Enter patterns (comma-separated):', category.patterns.join(', '));
  if (newPatterns === null) return;

  const patterns = newPatterns.trim() ? newPatterns.split(',').map(p => p.trim()) : [];

  window.electronAPI.updateCategory(name, newBgColor, newTextColor, patterns)
    .then(() => {
      loadCategories();
      refreshCategoriesList();

      // Update current view if editing a category of the active panel
      const activeState = panelState[activePanelId];
      if (activeState.currentCategory && activeState.currentCategory.name === name) {
        panels.navigateToDirectory(activeState.currentPath, activePanelId);
      }

      alert('Category updated!');
    })
    .catch(err => {
      alert('Error updating category: ' + err.message);
    });
}

/**
 * Convert hex color to RGB string
 */
function rgbToString(hexColor) {
  const hex = hexColor.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return `(${r}, ${g}, ${b})`;
}

// ==================== Settings Modal & Categories Management ====================

/**
 * Open the image viewer modal with the given file path
 */
export function openImageViewerModal(filePath) {
  const imgUrl = 'file:///' + filePath.replace(/\\/g, '/');
  $('#image-viewer-img').attr('src', imgUrl);
  $('#image-viewer-modal').css('display', 'flex');
}

// Initialize on document ready
console.log('Page loaded, waiting for jQuery...');
$(document).ready(function () {
  console.log('Document ready, starting initialization...');
  contexts.initializeGlobalContextMenuHandlers();
  initialize();
});
