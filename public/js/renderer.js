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
import * as terminal from './modules/terminal.js';
import { w2ui, w2layout, w2grid, w2confirm, w2alert, w2popup } from './modules/vendor/w2ui.es6.min.js';

export { monacoEditor, formatFileContent, openNotesModal, showFileView, hideFileView, toggleFileEditMode } from './modules/notes.js';
export { generateW2UIContextMenu, showCustomContextMenu } from './modules/contexts.js';
export { openHistoryModal, formatHistoryData, buildCompleteFileState } from './modules/history.js';
export { updateAlertBadge } from './modules/alerts.js';
export { openTodoModal } from './modules/todos.js';

// Global error handler for debugging
window.addEventListener('error', (event) => {
  console.error('Uncaught error:', event.error);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
});

// Panel state - tracks each panel's directory, grid, and navigation
export let panelState = {
  1: { currentPath: '', w2uiGrid: null, navigationHistory: [], navigationIndex: -1, currentCategory: null, selectMode: false, checksumQueue: null, checksumQueueIndex: 0, checksumCancelled: false, showDateCreated: false, hasBeenViewed: false, fileViewPath: null, depth: 0, scanCancelled: false, pendingDirs: [], scanInProgress: false, scanToken: 0, recidCounter: 1, attrEditMode: false, notesEditMode: false, notesMonacoEditor: null, notesFilePath: null, sectionCollapseState: null, currentItemOpenWith: null, labelsUiState: null, currentItemStats: null },
  2: { currentPath: '', w2uiGrid: null, navigationHistory: [], navigationIndex: -1, currentCategory: null, selectMode: false, checksumQueue: null, checksumQueueIndex: 0, checksumCancelled: false, showDateCreated: false, hasBeenViewed: false, fileViewPath: null, depth: 0, scanCancelled: false, pendingDirs: [], scanInProgress: false, scanToken: 0, recidCounter: 1, attrEditMode: false, notesEditMode: false, notesMonacoEditor: null, notesFilePath: null, sectionCollapseState: null, currentItemOpenWith: null, labelsUiState: null, currentItemStats: null },
  3: { currentPath: '', w2uiGrid: null, navigationHistory: [], navigationIndex: -1, currentCategory: null, selectMode: false, checksumQueue: null, checksumQueueIndex: 0, checksumCancelled: false, showDateCreated: false, hasBeenViewed: false, fileViewPath: null, depth: 0, scanCancelled: false, pendingDirs: [], scanInProgress: false, scanToken: 0, recidCounter: 1, attrEditMode: false, notesEditMode: false, notesMonacoEditor: null, notesFilePath: null, sectionCollapseState: null, currentItemOpenWith: null, labelsUiState: null, currentItemStats: null },
  4: { currentPath: '', w2uiGrid: null, navigationHistory: [], navigationIndex: -1, currentCategory: null, selectMode: false, checksumQueue: null, checksumQueueIndex: 0, checksumCancelled: false, showDateCreated: false, hasBeenViewed: false, fileViewPath: null, depth: 0, scanCancelled: false, pendingDirs: [], scanInProgress: false, scanToken: 0, recidCounter: 1, attrEditMode: false, notesEditMode: false, notesMonacoEditor: null, notesFilePath: null, sectionCollapseState: null, currentItemOpenWith: null, labelsUiState: null, currentItemStats: null }
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
let allCategories = {};
let allTags = [];
export let fileEditMode = false;
let hotkeyRegistry = {};
export const MISSING_DIRECTORY_LABEL = '(DIRECTORY DOES NOT EXIST)';
const SIDEBAR_COLLAPSED_WIDTH = 50;

export let sidebarState = {
  expandedPaths: new Set(),
  selectedPath: null,
  drives: []
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
    await sidebar.initializeSidebar();
    sidebar.handleSidebarLayoutResize(w2layoutInstance.get('left').size);

    const settings = await window.electronAPI.getSettings();
    console.log('Settings loaded:', settings);

    const homePath = settings.home_directory;

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
 * Attach event listeners to buttons and grid
 */
function attachEventListeners() {
  // Capture-phase arrow key handler for grid navigation.
  // Must be capture phase (fires before w2ui's textarea keydown handler) so we can
  // stopPropagation() and prevent w2ui from also processing the key internally,
  // which would otherwise trigger its nextRow() and crash on undefined records.
  document.addEventListener('keydown', function (event) {
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
        if (panels.visiblePanels < 4) {
          const nextPanelId = panels.visiblePanels + 1;
          panels.setVisiblePanels(nextPanelId);
          $(`#panel-${nextPanelId}`).show();
          panels.attachPanelEventListeners(nextPanelId);
          panels.updatePanelLayout();
        }
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
      case 'open_item':
        event.preventDefault();
        panels.openSelectedItem(activePanelId);
        break;
      case 'reopen_panel':
        event.preventDefault();
        await panels.reopenLastClosedPanel();
        break;
    }
  });

  // Window focus/blur handlers for panel selection styling
  $(window).blur(function () {
    // When window loses focus, remove selection styling from all panels
    for (let i = 1; i <= 4; i++) {
      $(`#panel-${i} .panel-number`).removeClass('panel-number-selected');
    }
  });

  $(window).focus(function () {
    // When window regains focus, restore selection styling to active panel
    $(`#panel-${activePanelId} .panel-number`).addClass('panel-number-selected');
  });

  // View button - show layout modal
  $('#btn-view').click(function () {
    panels.showLayoutModal();
  });

  // Add panel button
  $('#btn-add-panel').click(function () {
    if (panels.visiblePanels < 4) {
      const newPanelId = panels.visiblePanels + 1;
      panels.setVisiblePanels(newPanelId);
      $(`#panel-${newPanelId}`).show();

      // Reattach event listeners for the newly visible panel
      panels.attachPanelEventListeners(newPanelId);

      panels.updatePanelLayout();
    }
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

  // Panel button handlers - add click listeners for all panels
  for (let panelId = 1; panelId <= 4; panelId++) {
    panels.attachPanelEventListeners(panelId);
  }

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
  $('#btn-sidebar-tagging').click(function () {
    settings.showTaggingModal();
  });

  // Tagging modal close button
  $('#btn-tagging-close').click(function () {
    settings.hideTaggingModal();
  });

  // Tagging modal overlay click to close
  $('#tagging-modal').click(function (e) {
    if (e.target === this) {
      settings.hideTaggingModal();
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

  // Category form clear/new button
  $('#btn-cat-clear').click(function () {
    settings.clearCategoryForm();
  });

  // Category form delete button
  $('#btn-cat-delete').click(async function () {
    await settings.deleteCategoryFromForm();
  });

  // Browser settings: validate directory while typing
  $('#browser-home-directory').on('input', async function () {
    await settings.updateHomeDirectoryWarning($(this).val());
  });

  // Browser settings: update preview on recordHeight input change
  $('#browser-record-height').on('input', function () {
    settings.updateRecordHeightPreview();
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

  // Tag form clear/new button
  $('#btn-tag-clear').click(function () {
    settings.clearTagForm();
  });

  // Tag form delete button
  $('#btn-tag-delete').click(async function () {
    await settings.deleteTagFromForm();
  });

  // Attribute form save button
  $('#btn-attr-save').click(async function () {
    await settings.saveAttributeFromForm();
  });

  // Attribute form clear/new button
  $('#btn-attr-clear').click(function () {
    settings.clearAttributeForm();
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
