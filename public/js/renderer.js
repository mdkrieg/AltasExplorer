/**
 * AtlasExplorer Renderer Logic
 * Handles all UI interactions and IPC calls
 */

// Global error handler for debugging
window.addEventListener('error', (event) => {
  console.error('Uncaught error:', event.error);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
});

// Panel state - tracks each panel's directory, grid, and navigation
let panelState = {
  1: { currentPath: '', w2uiGrid: null, navigationHistory: [], navigationIndex: -1, currentCategory: null, selectMode: false, checksumQueue: null, checksumQueueIndex: 0, checksumCancelled: false, showDateCreated: false, hasBeenViewed: false, notesFilePath: null },
  2: { currentPath: '', w2uiGrid: null, navigationHistory: [], navigationIndex: -1, currentCategory: null, selectMode: false, checksumQueue: null, checksumQueueIndex: 0, checksumCancelled: false, showDateCreated: false, hasBeenViewed: false, notesFilePath: null },
  3: { currentPath: '', w2uiGrid: null, navigationHistory: [], navigationIndex: -1, currentCategory: null, selectMode: false, checksumQueue: null, checksumQueueIndex: 0, checksumCancelled: false, showDateCreated: false, hasBeenViewed: false, notesFilePath: null },
  4: { currentPath: '', w2uiGrid: null, navigationHistory: [], navigationIndex: -1, currentCategory: null, selectMode: false, checksumQueue: null, checksumQueueIndex: 0, checksumCancelled: false, showDateCreated: false, hasBeenViewed: false, notesFilePath: null }
};

// Track directory selection from panel-1 for use in panels 2-4
let panel1SelectedDirectoryPath = null;
let panel1SelectedDirectoryName = null;

let activePanelId = 1;
let allCategories = {};
let currentLayout = 1;
let notesEditMode = false;
let visiblePanels = 1;
let panelContextMenuState = {}; // Stores context menu state for onMenuClick handler
let hotkeyRegistry = {}; // Maps action IDs to their current key combinations
const MISSING_DIRECTORY_LABEL = '(DIRECTORY DOES NOT EXIST)';

// Sidebar state
let sidebarState = {
  expandedPaths: new Set(),
  selectedPath: null,
  drives: []
};

// Panel divider state - tracks resizable divider positions and drag state
let panelDividerState = {
  verticalPixels: 400,  // Left panel width in pixels (fixed size)
  horizontalPixels: 300, // Top panel height in pixels (fixed size)
  isResizingVertical: false,
  isResizingHorizontal: false,
  minPanelWidth: 200,   // Minimum panel width in pixels
  minPanelHeight: 100,  // Minimum panel height in pixels
};

// W2Layout instance
let w2layoutInstance = null;

/**
 * Initialize the application
 */
async function initialize() {
  try {
    console.log('Initializing app...');
    
    // Check if electronAPI is available
    if (!window.electronAPI) {
      throw new Error('electronAPI not found - preload script may not be loaded');
    }
    
    console.log('electronAPI available:', Object.keys(window.electronAPI));

    // Initialize w2layout with resizable panels
    w2layoutInstance = new w2layout({
      name: 'layout',
      padding: 0,
      panels: [
        { 
          type: 'left',
          size: parseInt(localStorage.getItem('sidebarWidth') || '250'),
          resizable: true,
          minSize: 150,
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

    // Render layout
    w2layoutInstance.render('#layout');

    // Move sidebar content into left panel
    const sidebarContent = document.getElementById('sidebar-content');
    const leftPanelElement = w2layoutInstance.el('left');
    if (leftPanelElement && sidebarContent) {
      // Move the element into the left panel
      sidebarContent.style.display = 'flex';
      leftPanelElement.appendChild(sidebarContent);
    }

    // Move main content into main panel
    const mainContent = document.getElementById('main-content');
    const mainPanelElement = w2layoutInstance.el('main');
    if (mainPanelElement && mainContent) {
      // Move the element into the main panel
      mainContent.style.display = 'flex';
      mainPanelElement.appendChild(mainContent);
    }

    // Handle panel resize to save sidebar width
    w2layoutInstance.on('resize', function() {
      const leftPanel = this.get('left');
      if (leftPanel && leftPanel.size) {
        localStorage.setItem('sidebarWidth', leftPanel.size);
      }
    });

    // Initialize grids for all panels
    await initializeAllGrids();

    // Initialize sidebar with root drives
    await initializeSidebar();

    // Get settings and navigate to home directory
    const settings = await window.electronAPI.getSettings();
    console.log('Settings loaded:', settings);
    
    const homePath = settings.home_directory;

    // Set initial layout to 1 panel
    switchLayout(1);

    // Initialize panel dividers
    initializeDividers();

    if (homePath) {
      await navigateToDirectory(homePath, 1);
    }

    // Load categories
    await loadCategories();

    // Load hotkeys
    await loadHotkeysFromStorage();

    // Attach event listeners
    attachEventListeners();
    
    // Set up close request listener from main process
    window.electronAPI.onCloseRequest(() => {
      handleCloseRequest();
    });

    // Listen for backend background refresh notifications
    window.electronAPI.onDirectoryChanged(({ panelId, dirPath }) => {
      const state = panelState[panelId];
      if (state && state.currentPath === dirPath) {
        navigateToDirectory(dirPath, panelId, false).catch(err => {
          console.error(`Background refresh failed for panel ${panelId}:`, err);
        });
      }
    });
    
    // Initialize Monaco editor loader
    await initializeMonacoLoader();
    
    // Start backend background refresh
    const bgSettings = await window.electronAPI.getSettings();
    window.electronAPI.startBackgroundRefresh(
      bgSettings.background_refresh_enabled || false,
      bgSettings.background_refresh_interval || 30
    );

    console.log('Initialization complete');
  } catch (err) {
    console.error('Error initializing app:', err);
    alert('Fatal error during initialization: ' + err.message);
  }
}

/**
 * Update the w2grid header with path and toolbar buttons
 */
function updateGridHeader(panelId, path) {
  const gridName = `grid-panel-${panelId}`;
  const headerEl = document.getElementById(`grid_${gridName}_header`);
  
  if (!headerEl) return;
  
  // Build toolbar HTML with path and buttons
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
  
  // Reattach event listeners to new elements
  attachGridHeaderEventListeners(panelId);
}

/**
 * Attach event listeners to grid header elements
 */
function attachGridHeaderEventListeners(panelId) {
  const $header = $(`#grid_grid-panel-${panelId}_header`);
  
  // Path click to edit
  $header.find('.panel-path').off('click').on('click', function() {
    const $path = $(this);
    const $input = $header.find('.panel-path-input');
    $path.hide();
    $input.show().select().focus();
  });
  
  // Path input - handle Enter, Escape, blur
  $header.find('.panel-path-input').off('keydown blur').on('keydown', function(e) {
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
  }).on('blur', function() {
    $(this).hide();
    $header.find('.panel-path').show();
  });
  
  // Parent folder button
  $header.find('.btn-panel-parent').off('click').on('click', function() {
    setActivePanelId(panelId);
    const state = panelState[panelId];
    if (state.currentPath && state.currentPath.length > 3) {
      const parentPath = state.currentPath.substring(0, state.currentPath.lastIndexOf('\\'));
      if (parentPath.length >= 2) {
        navigateToDirectory(parentPath, panelId);
      }
    }
  });
  
  // Refresh button
  $header.find('.btn-panel-refresh').off('click').on('click', async function() {
    setActivePanelId(panelId);
    await navigateToDirectory(panelState[panelId].currentPath, panelId);
  });
  
  // Settings button (panel 1 only)
  if (panelId === 1) {
    $header.find('.btn-panel-settings').off('click').on('click', function() {
      setActivePanelId(panelId);
      showSettingsModal();
    });
    
    // Add panel button (green + button)
    $header.find('#btn-add-panel').off('click').on('click', function() {
      if (visiblePanels < 4) {
        visiblePanels++;
        const newPanelId = visiblePanels;
        $(`#panel-${newPanelId}`).show();
        
        // Reattach event listeners for the newly visible panel
        attachPanelEventListeners(newPanelId);
        
        updatePanelLayout();
      }
    });
  }
  
  // Remove button (panels 2-4 only)
  if (panelId > 1) {
    $header.find('.btn-panel-remove').off('click').on('click', function() {
      console.log('Close button clicked for panel', panelId);
      removePanel(panelId);
    });
  }
}

/**
 * Navigate to a directory in a specific panel
 */
async function navigateToDirectory(dirPath, panelId = activePanelId, addToHistory = true) {
  try {
    // Validate and normalize the path before proceeding
    if (!dirPath || typeof dirPath !== 'string') {
      console.error(`[navigateToDirectory] Invalid path type - received ${typeof dirPath}:`, dirPath);
      throw new Error('Path must be a non-empty string');
    }
    
    let normalizedPath = dirPath.trim();
    if (!normalizedPath) {
      console.error('[navigateToDirectory] Empty path after normalization');
      throw new Error('Path cannot be empty');
    }

    if (normalizedPath.length == 2 && normalizedPath[1] === ':') {
      // append backslash for drive root paths like "C:"
      normalizedPath += '\\';
    }
    
    // Only log on manual navigation (when adding to history), not on background refresh
    const isManualNavigation = addToHistory !== false;
    const isFirstView = !panelState[panelId].hasBeenViewed;
    if (isManualNavigation || isFirstView) {
      console.log(`Navigating panel ${panelId} to:`, normalizedPath);
    }
    
    const state = panelState[panelId];
    state.currentPath = normalizedPath;
    
    // Update navigation history
    if (addToHistory) {
      state.navigationHistory = state.navigationHistory.slice(0, state.navigationIndex + 1);
      state.navigationHistory.push(dirPath);
      state.navigationIndex = state.navigationHistory.length - 1;
    }
    
    // Update sidebar selection if navigating panel-1
    if (panelId === 1) {
      updateSidebarSelection(normalizedPath);
    }
    
    // Update grid header with path (will be called after grid is populated)
    // For now just update the panel state, the header will be set after navigate succeeds

    // Handle non-existent paths without blocking user navigation history
    const directoryExists = await window.electronAPI.isDirectory(normalizedPath);
    if (!directoryExists) {
      state.currentCategory = null;
      setPanelPathValidity(panelId, false);
      showMissingDirectoryRecord(panelId);
      // Update header for invalid path
      updateGridHeader(panelId, normalizedPath);
      return;
    }

    setPanelPathValidity(panelId, true);

    // Scan directory and populate files
    const scanResult = await window.electronAPI.scanDirectoryWithComparison(normalizedPath);

    if (!scanResult.success) {
      throw new Error(scanResult.error || 'Failed to scan directory');
    }

    // Only log on first view or manual navigation, skip logs during background refresh
    if (isManualNavigation || isFirstView) {
      console.log('Scan successful, entries:', scanResult.entries ? scanResult.entries.length : 0);
    }

    // Get category for this directory
    const category = await window.electronAPI.getCategoryForDirectory(normalizedPath);
    state.currentCategory = category;

    // Update window icon if this is the active panel
    // Use initials from the "." dot entry of the current directory if present
    if (panelId === activePanelId && category) {
      const dotEntry = (scanResult.entries || []).find(e => e.filename === '.' && e.isDirectory);
      const currentDirInitials = dotEntry ? (dotEntry.initials || null) : null;
      await window.electronAPI.updateWindowIcon(category.name, currentDirInitials);
    }

    // Use entries from scan result (already has changeState metadata)
    const entries = scanResult.success ? scanResult.entries : [];

    // Populate file grid for this panel
    await populateFileGrid(entries, category, panelId);

    // Update grid header with path and buttons
    updateGridHeader(panelId, normalizedPath);

    // Force grid resize after layout is painted
    const gridToResize = panelState[panelId].w2uiGrid;
    if (gridToResize) {
      requestAnimationFrame(() => gridToResize.resize());
    }

    // Mark this panel as having been viewed
    panelState[panelId].hasBeenViewed = true;

    // Register this directory for backend background refresh
    window.electronAPI.registerWatchedPath(panelId, normalizedPath);

    // Start async checksum calculation if category has it enabled
    if (category && category.enableChecksum) {
      // Collect files that need checksum calculation
      const grid = panelState[panelId].w2uiGrid;
      const filesToChecksum = grid.records.filter(r => 
        !r.isFolder && r.changeState === 'checksumPending'
      );
      
      if (filesToChecksum.length > 0) {
        // Start queue for both manual navigation and background refresh.
        // Don't restart if a queue is already actively running for this panel.
        const queueIdle = !state.checksumQueue ||
                          state.checksumCancelled ||
                          state.checksumQueueIndex >= state.checksumQueue.length;
        if (queueIdle) {
          console.log(`Starting checksum calculation for ${filesToChecksum.length} files (panel ${panelId})`);
          startChecksumQueue(filesToChecksum, panelId, dirPath);
        }
      }
    }
  } catch (err) {
    console.error('Error navigating to directory:', err);
    alert('Error accessing directory: ' + err.message);
  }
}

/**
 * Colorize panel path when directory is invalid
 */
function setPanelPathValidity(panelId, isValid) {
  const $path = $(`#panel-${panelId} .panel-path`);
  if (isValid) {
    $path.css('color', '');
  } else {
    $path.css('color', '#c62828');
  }
}

/**
 * Show a single grid row for missing directory state
 */
function showMissingDirectoryRecord(panelId) {
  const grid = panelState[panelId].w2uiGrid;
  if (!grid) return;

  grid.records = [{
    recid: 1,
    icon: '-',
    filename: MISSING_DIRECTORY_LABEL,
    size: '-',
    dateModified: '-',
    checksum: '-',
    isFolder: false,
    path: '',
    changeState: 'missing'
  }];

  grid.refresh();
}

/**
 * Initialize w2ui grids for all panels
 */
async function initializeAllGrids() {
  for (let panelId = 1; panelId <= 4; panelId++) {
    await initializeGridForPanel(panelId);
  }
}

/**
 * Initialize sidebar with root drives
 */
async function initializeSidebar() {
  try {
    console.log('Initializing sidebar...');
    
    // Get root drives from main process
    const drives = await window.electronAPI.getRootDrives();
    sidebarState.drives = drives;
    
    // Render the sidebar tree
    await renderSidebarTree(drives);
    
    // Render favorites list
    await renderFavoritesList();

    // Attach sidebar event listeners
    attachSidebarEventListeners();

    // Attach favorites event listeners
    attachFavoritesEventListeners();
    
    console.log('Sidebar initialized with', drives.length, 'drives');
  } catch (err) {
    console.error('Error initializing sidebar:', err);
  }
}

/**
 * Render the sidebar tree starting with root drives
 */
async function renderSidebarTree(drives) {
  const $tree = $('#sidebar-tree');
  $tree.empty();
  
  // Create "This PC" group section with all drives
  for (const drive of drives) {
    const $driveItem = createSidebarDriveItem(drive);
    $tree.append($driveItem);
  }
}

/**
 * Create a sidebar item for a drive
 */
function createSidebarDriveItem(drive) {
  const $item = $('<div>')
    .addClass('sidebar-item sidebar-item-drive')
    .attr('data-path', drive.path)
    .attr('data-isDirectory', 'true')
    .attr('data-expanded', 'false');
  
  // Toggle arrow (for expanding/collapsing)
  const $arrow = $('<div>')
    .addClass('sidebar-toggle-arrow collapsed')
    .text('▶')
    .attr('title', 'Expand drive');
  
  // Drive label
  const $label = $('<div>')
    .addClass('sidebar-item-label')
    .text(drive.label)
    .attr('title', drive.label);
  
  $item.append($arrow, $label);
  
  return $item;
}

/**
 * Create a sidebar item for a directory
 */
function createSidebarDirectoryItem(dirName, dirPath, level = 0) {
  const $item = $('<div>')
    .addClass('sidebar-item')
    .addClass(`sidebar-item-indent-${Math.min(level, 5)}`)
    .attr('data-path', dirPath)
    .attr('data-isDirectory', 'true')
    .attr('data-expanded', 'false');
  
  // Toggle arrow (will be hidden if no children, determined on first expand)
  const $arrow = $('<div>')
    .addClass('sidebar-toggle-arrow collapsed')
    .text('▶');
  
  // Directory label
  const $label = $('<div>')
    .addClass('sidebar-item-label')
    .text(dirName)
    .attr('title', dirPath);
  
  $item.append($arrow, $label);
  
  return $item;
}

/**
 * Load and expand children for a sidebar item
 */
async function loadSidebarItemChildren(path, $item) {
  try {
    // Check if already loaded
    const $children = $item.next('.sidebar-children');
    if ($children.length > 0) {
      return; // Already loaded
    }
    
    // Get directory contents
    const entries = await window.electronAPI.readDirectory(path);
    
    // Filter to only directories
    const directories = entries.filter(e => e.isDirectory);
    
    // If no directories, exit
    if (directories.length === 0) {
      // Update arrow to show no children
      $item.find('.sidebar-toggle-arrow').addClass('no-children');
      return;
    }
    
    // Create children container
    const $childrenContainer = $('<div>').addClass('sidebar-children');
    
    // Get current level from indentation class
    const levelMatch = $item.attr('class').match(/sidebar-item-indent-(\d+)/);
    let currentLevel = levelMatch ? parseInt(levelMatch[1]) : 0;
    const childLevel = currentLevel + 1;
    
    // Create items for each subdirectory
    for (const dir of directories) {
      const $childItem = createSidebarDirectoryItem(dir.filename, dir.path, childLevel);
      $childrenContainer.append($childItem);
    }
    
    // Insert children container after the item
    $item.after($childrenContainer);
    
    // Update arrow to show has children
    $item.find('.sidebar-toggle-arrow').removeClass('no-children');
    
    console.log(`Loaded ${directories.length} subdirectories for ${path}`);
  } catch (err) {
    console.error('Error loading sidebar item children:', err);
  }
}

/**
 * Toggle expansion of a sidebar item
 */
async function toggleSidebarItemExpansion($item) {
  const isExpanded = $item.attr('data-expanded') === 'true';
  const path = $item.attr('data-path');
  
  if (isExpanded) {
    // Collapse
    collapseSidebarItem($item);
  } else {
    // Expand - load children if not already loaded
    await expandSidebarItem($item, path);
  }
}

/**
 * Expand a sidebar item and show its children
 */
async function expandSidebarItem($item, path) {
  // Load children if not loaded yet
  await loadSidebarItemChildren(path, $item);
  
  // Show children container
  const $children = $item.next('.sidebar-children');
  if ($children.length > 0) {
    $children.show();
  }
  
  // Update arrow and state
  $item.attr('data-expanded', 'true');
  $item.find('.sidebar-toggle-arrow').removeClass('collapsed').text('▼');
}

/**
 * Collapse a sidebar item and hide its children
 */
function collapseSidebarItem($item) {
  // Hide children container
  const $children = $item.next('.sidebar-children');
  if ($children.length > 0) {
    $children.hide();
  }
  
  // Update arrow and state
  $item.attr('data-expanded', 'false');
  $item.find('.sidebar-toggle-arrow').addClass('collapsed').text('▶');
}

/**
 * Update sidebar selection to highlight a path
 */
function updateSidebarSelection(path) {
  // Remove selection from all items
  $('.sidebar-item').removeClass('sidebar-item-selected');
  
  // Add selection to matching path
  if (path) {
    $(`.sidebar-item[data-path="${path}"]`).addClass('sidebar-item-selected');
    sidebarState.selectedPath = path;
  }
}

/**
 * Attach event listeners to sidebar items
 */
function attachSidebarEventListeners() {
  // Delegate click events for dynamic items
  $('#sidebar-tree').on('click', '.sidebar-toggle-arrow', function(e) {
    e.stopPropagation();
    const $item = $(this).closest('.sidebar-item');
    toggleSidebarItemExpansion($item);
  });
  
  // Double-click to navigate
  $('#sidebar-tree').on('dblclick', '.sidebar-item-label', function(e) {
    e.stopPropagation();
    const $item = $(this).closest('.sidebar-item');
    const path = $item.attr('data-path');
    
    if (path) {
      // Navigate to directory in panel-1
      navigateToDirectory(path, 1);
      // Update sidebar selection
      updateSidebarSelection(path);
    }
  });
  
  // Single click to select
  $('#sidebar-tree').on('click', '.sidebar-item-label', function(e) {
    e.stopPropagation();
    const $item = $(this).closest('.sidebar-item');
    const path = $item.attr('data-path');
    
    if (path) {
      updateSidebarSelection(path);
    }
  });
}

// =====================
// FAVORITES
// =====================

let favoritesContextMenuTarget = null; // path of favorite being right-clicked
let favoriteDragSrcIndex = null;

/**
 * Load favorites array from settings
 */
async function loadFavoritesFromSettings() {
  try {
    const settings = await window.electronAPI.getSettings();
    return Array.isArray(settings.favorites) ? settings.favorites : [];
  } catch (err) {
    console.error('Error loading favorites:', err);
    return [];
  }
}

/**
 * Save favorites array to settings
 */
async function saveFavoritesToSettings(favorites) {
  try {
    const settings = await window.electronAPI.getSettings();
    settings.favorites = favorites;
    await window.electronAPI.saveSettings(settings);
  } catch (err) {
    console.error('Error saving favorites:', err);
  }
}

/**
 * Render the favorites list in the sidebar
 */
async function renderFavoritesList() {
  const favorites = await loadFavoritesFromSettings();
  const $list = $('#favorites-list');
  $list.empty();

  if (favorites.length === 0) {
    $list.append(
      $('<div>').addClass('favorite-item-empty')
        .css({ padding: '4px 12px', fontSize: '11px', color: '#bbb', fontStyle: 'italic' })
        .text('No favorites yet')
    );
    return;
  }

  for (let index = 0; index < favorites.length; index++) {
    const fav = favorites[index];
    const name = fav.name || fav.path.split(/[\\/]/).filter(Boolean).pop() || fav.path;
    const $item = $('<div>')
      .addClass('favorite-item')
      .attr('data-path', fav.path)
      .attr('data-index', index)
      .attr('draggable', 'true');

    const $handle = $('<div>').addClass('favorite-item-drag-handle').text('⠿');
    const $icon = $('<div>').addClass('favorite-item-icon');
    const $label = $('<div>').addClass('favorite-item-label').text(name).attr('title', fav.path);

    // Resolve category-based folder icon with initials
    try {
      const [category, initials] = await Promise.all([
        window.electronAPI.getCategoryForDirectory(fav.path),
        window.electronAPI.getDirectoryInitials(fav.path)
      ]);
      const iconUrl = await window.electronAPI.generateFolderIcon(category.bgColor, category.textColor, initials || null);
      $icon.html(`<img src="${iconUrl}" style="width: 16px; height: 16px; object-fit: contain;">`);
    } catch (err) {
      $icon.html('📁');
    }

    $item.append($handle, $icon, $label);
    $list.append($item);
  }
}

/**
 * Add a directory path to favorites (avoiding duplicates)
 */
async function addToFavorites(dirPath) {
  const favorites = await loadFavoritesFromSettings();
  const normalized = dirPath.replace(/\\/g, '/');
  const exists = favorites.some(f => f.path.replace(/\\/g, '/') === normalized);
  if (!exists) {
    const name = dirPath.split(/[\\/]/).filter(Boolean).pop() || dirPath;
    favorites.push({ path: dirPath, name });
    await saveFavoritesToSettings(favorites);
    await renderFavoritesList();
  }
}

/**
 * Remove a path from favorites
 */
async function removeFromFavorites(dirPath) {
  const favorites = await loadFavoritesFromSettings();
  const normalized = dirPath.replace(/\\/g, '/');
  const updated = favorites.filter(f => f.path.replace(/\\/g, '/') !== normalized);
  await saveFavoritesToSettings(updated);
  await renderFavoritesList();
}

/**
 * Attach event listeners for the favorites list (drag/drop, click, right-click)
 */
function attachFavoritesEventListeners() {
  const $list = $('#favorites-list');

  // Navigate on click
  $list.on('click', '.favorite-item', async function(e) {
    const path = $(this).attr('data-path');
    if (path) {
      await navigateToDirectory(path, 1);
      updateSidebarSelection(path);
    }
  });

  // Right-click context menu
  $list.on('contextmenu', '.favorite-item', function(e) {
    e.preventDefault();
    e.stopPropagation();
    favoritesContextMenuTarget = $(this).attr('data-path');
    showFavoritesContextMenu(e.clientX, e.clientY);
  });

  // Drag events – source
  $list.on('dragstart', '.favorite-item', function(e) {
    favoriteDragSrcIndex = parseInt($(this).attr('data-index'));
    $(this).addClass('dragging');
    e.originalEvent.dataTransfer.effectAllowed = 'move';
    e.originalEvent.dataTransfer.setData('text/plain', favoriteDragSrcIndex.toString());
  });

  $list.on('dragend', '.favorite-item', function() {
    $(this).removeClass('dragging');
    $('.favorite-item').removeClass('drag-over-top drag-over-bottom');
  });

  // Drag events – target
  $list.on('dragover', '.favorite-item', function(e) {
    e.preventDefault();
    e.originalEvent.dataTransfer.dropEffect = 'move';
    const rect = this.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    $(this).removeClass('drag-over-top drag-over-bottom');
    if (e.originalEvent.clientY < midY) {
      $(this).addClass('drag-over-top');
    } else {
      $(this).addClass('drag-over-bottom');
    }
  });

  $list.on('dragleave', '.favorite-item', function() {
    $(this).removeClass('drag-over-top drag-over-bottom');
  });

  $list.on('drop', '.favorite-item', async function(e) {
    e.preventDefault();
    $(this).removeClass('drag-over-top drag-over-bottom');
    const destIndex = parseInt($(this).attr('data-index'));
    if (favoriteDragSrcIndex === null || favoriteDragSrcIndex === destIndex) return;

    const rect = this.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const insertAfter = e.originalEvent.clientY >= midY;

    const favorites = await loadFavoritesFromSettings();
    const moved = favorites.splice(favoriteDragSrcIndex, 1)[0];
    let insertAt = destIndex;
    if (favoriteDragSrcIndex < destIndex) insertAt = destIndex - 1;
    if (insertAfter) insertAt += 1;
    favorites.splice(insertAt, 0, moved);
    await saveFavoritesToSettings(favorites);
    await renderFavoritesList();
    favoriteDragSrcIndex = null;
  });
}

/**
 * Show the favorites right-click context menu
 */
function showFavoritesContextMenu(x, y) {
  let $menu = $('#favorites-context-menu');
  if ($menu.length === 0) {
    $menu = buildFavoritesContextMenuEl();
    $('body').append($menu);
  }

  // Rebuild Open In items based on visible panels
  const $openInSub = $menu.find('.fav-submenu');
  $openInSub.empty();
  for (let i = 1; i <= Math.min(visiblePanels + 1, 4); i++) {
    $openInSub.append(
      $('<div>').addClass('fav-menu-item')
        .attr('data-panel', i)
        .text(`Panel ${i}`)
        .on('click', async function(e) {
          e.stopPropagation();
          hideFavoritesContextMenu();
          const path = favoritesContextMenuTarget;
          if (!path) return;
          const panelNum = parseInt($(this).attr('data-panel'));
          const $panel = $(`#panel-${panelNum}`);
          if (panelNum > visiblePanels) {
            visiblePanels = panelNum;
            $panel.show();
            updatePanelLayout();
          }
          await navigateToDirectory(path, panelNum);
          $panel.find('.panel-landing-page').hide();
          $panel.find('.panel-grid').show();
          const grid = panelState[panelNum].w2uiGrid;
          if (grid && grid.resize) grid.resize();
          setActivePanelId(panelNum);
        })
    );
  }

  $menu.css({ left: x, top: y, display: 'block' });

  // Ensure menu stays in viewport
  const menuRect = $menu[0].getBoundingClientRect();
  if (menuRect.right > window.innerWidth) {
    $menu.css('left', x - menuRect.width);
  }
  if (menuRect.bottom > window.innerHeight) {
    $menu.css('top', y - menuRect.height);
  }
}

function buildFavoritesContextMenuEl() {
  const $menu = $('<div>').attr('id', 'favorites-context-menu');

  // Open In (with submenu)
  const $openIn = $('<div>').addClass('fav-menu-item has-submenu').text('Open In');
  const $sub = $('<div>').addClass('fav-submenu');
  $openIn.append($sub);
  $menu.append($openIn);

  $menu.append($('<hr>').addClass('fav-menu-separator'));

  // Remove
  $menu.append(
    $('<div>').addClass('fav-menu-item fav-menu-item-remove').text('Remove')
      .on('click', async function(e) {
        e.stopPropagation();
        hideFavoritesContextMenu();
        if (favoritesContextMenuTarget) {
          await removeFromFavorites(favoritesContextMenuTarget);
        }
      })
  );

  return $menu;
}

function hideFavoritesContextMenu() {
  $('#favorites-context-menu').hide();
}

// Hide context menu on outside click
$(document).on('click', function(e) {
  if (!$(e.target).closest('#favorites-context-menu').length) {
    hideFavoritesContextMenu();
  }
});

/**
 * Initialize w2ui grid for a specific panel
 */
async function initializeGridForPanel(panelId) {
  const gridName = `grid-panel-${panelId}`;
  
  // Destroy existing grid if present
  if (w2ui && w2ui[gridName]) {
    w2ui[gridName].destroy();
  }

  // Get the recordHeight setting
  const recordHeight = await getRecordHeight();

  // Build columns dynamically based on panel state
  const state = panelState[panelId];
  const columns = [
    { field: 'icon', text: '', size: '40px', resizable: false, sortable: false },
    { field: 'filename', text: 'Name', size: '50%', resizable: true, sortable: true },
    { field: 'size', text: 'Size', size: '120px', resizable: true, sortable: true, align: 'right' },
    { field: 'dateModified', text: 'Date Modified', size: '150px', resizable: true, sortable: true }
  ];
  
  // Add optional DateCreated column if enabled for this panel
  if (state.showDateCreated) {
    columns.push({ field: 'dateCreated', text: 'Date Created', size: '150px', resizable: true, sortable: true });
  }
  
  // Always add checksum at the end
  columns.push({ field: 'checksum', text: 'Checksum', size: '150px', resizable: true, sortable: false });

  // Use w2grid constructor directly
  w2ui[gridName] = new w2grid({
    name: gridName,
    recordHeight: recordHeight,
    show: {
      header: true,
      toolbar: true,
      footer: true
    },
    columns: columns,
    records: [],
    contextMenu: [],
    onClick: function(event) {
      // For panel-1, detect directory selection for use by panels 2-4
      if (panelId === 1 && event.detail.recid) {
        const record = this.records[event.detail.recid - 1];
        if (record) {
          if (record.isFolder) {
            // Select this directory for panels 2-4 to use
            handlePanel1DirectorySelection(record.path, record.filenameRaw || record.filename);
          } else {
            // If a file is selected, reset the button state
            panel1SelectedDirectoryPath = null;
            panel1SelectedDirectoryName = null;
            updatePanelSelectButtons();
          }
          // Let w2ui handle the row highlighting naturally
        }
      }

      // Icon-cell click on a folder row → open inline initials editor
      if (event.detail.column === 0 && event.detail.recid) {
        const record = this.records[event.detail.recid - 1];
        if (record && record.isFolder && record.changeState !== 'moved') {
          openInitialsEditor(record, panelId);
          event.preventDefault();
          return;
        }
      }
      
      // Single click handling for other panels in select mode
      if (panelId > 1 && panelState[panelId].selectMode && event.detail.recid) {
        const record = this.records[event.detail.recid - 1];
        if (record && record.isFolder) {
          setActivePanelId(panelId);
          navigateToDirectory(record.path, panelId);
        }
      }
    },
    onDblClick: function(event) {
      const record = this.records[event.detail.recid - 1];
      
      // Check if this is a folder double-click (navigate)
      if (record && record.isFolder) {
        navigateToDirectory(record.path, panelId);
        return;
      }

      // Check if double-clicking notes.txt — open notes viewer in a new (or current) panel
      if (record && record.filenameRaw && record.filenameRaw.toLowerCase() === 'notes.txt') {
        if (visiblePanels < 4) {
          visiblePanels++;
          const newPanelId = visiblePanels;
          $(`#panel-${newPanelId}`).show();
          attachPanelEventListeners(newPanelId);
          updatePanelLayout();
          setTimeout(() => showNotesView(newPanelId, record.path), 150);
        } else {
          showNotesView(panelId, record.path);
        }
        return;
      }
    },
    onContextMenu: function(event) {
      if (event.detail.recid) {
        setActivePanelId(panelId);
        
        // Get all selected records
        const selectedRecIds = this.getSelection();
        const selectedRecords = selectedRecIds.map(recid => this.records[recid - 1]);
        
        // If no selected records, don't show menu
        if (selectedRecords.length === 0) {
          return;
        }
        
        // Generate w2ui-compatible context menu
        const contextMenu = generateW2UIContextMenu(selectedRecords, visiblePanels);
        
        // Set the contextMenu on this grid
        this.contextMenu = contextMenu;
      }
    },
    onContextMenuClick: function(event) {
      console.log('Context menu click:', event);
      // Handle context menu item clicks
      handleContextMenuClick(event, panelId);
    },
    onReload: function(event) {
      event.preventDefault();
      setActivePanelId(panelId);
      navigateToDirectory(panelState[panelId].currentPath, panelId);
    }
  });

  // Render grid in the panel's grid container
  const $gridContainer = $(`#panel-${panelId} .panel-grid`);
  w2ui[gridName].render($gridContainer[0]);

  // Override reload button tooltip to "Refresh"
  const reloadItem = w2ui[gridName].toolbar.get('w2ui-reload');
  if (reloadItem) reloadItem.tooltip = 'Refresh';
  
  // Set initial header
  updateGridHeader(panelId, 'Loading...');
  
  // Store reference in panelState
  panelState[panelId].w2uiGrid = w2ui[gridName];
}

/**
 * Populate the grid with files and folders for a specific panel
 */
async function populateFileGrid(entries, currentDirCategory, panelId = activePanelId) {
  console.log(`Populating grid for panel ${panelId} with ${entries.length} entries`);

  const state = panelState[panelId];
  
  // Get the hide dot directory setting
  const settings = await window.electronAPI.getSettings();
  const hideDotDirectory = settings.hide_dot_directory || false;
  
  // Filter out "." entries if hiding is enabled
  let filteredEntries = entries;
  if (hideDotDirectory) {
    filteredEntries = entries.filter(e => e.filename !== '.');
  }
  
  // Separate folders and files
  const folders = filteredEntries.filter(e => e.isDirectory);
  const files = filteredEntries.filter(e => !e.isDirectory);

  const records = [];
  let recordId = 1;

  // Helper function to apply CSS class to cell content
  function applyClass(content, className) {
    if (!className) return content;
    return `<div class="${className}">${content}</div>`;
  }

  // Add folders first
  for (const folder of folders) {
    // Determine which icon to use based on changeState
    let iconUrl;
    
    if (folder.changeState === 'moved') {
      // Use the moved folder icon
      iconUrl = 'assets/folder-moved.svg';
    } else {
      const category = await window.electronAPI.getCategoryForDirectory(folder.path);
      iconUrl = await window.electronAPI.generateFolderIcon(category.bgColor, category.textColor, folder.initials || null);
    }
    
    // Use the same getRowClassName function for consistency with files
    const className = getRowClassName(folder.changeState);
    
    records.push({
      recid: recordId++,
      icon: applyClass(`<img src="${iconUrl}" style="width: 20px; height: 20px; object-fit: contain; cursor: pointer;" title="Click to set initials">`, className),
      filename: applyClass(folder.filename, className),
      filenameRaw: folder.filename,
      size: applyClass('-', className),
      dateModified: applyClass(new Date(folder.dateModified).toLocaleString(), className),
      checksum: applyClass('—', className),
      isFolder: true,
      path: folder.path,
      changeState: folder.changeState,
      inode: folder.inode,
      initials: folder.initials || null,
      dir_id: null, // Will be set from DB if needed
      orphan_id: folder.orphan_id || null,
      new_dir_id: folder.new_dir_id || null
    });
  }

  // Then add files
  for (const file of files) {
    const className = getRowClassName(file.changeState);
    const dateModifiedContent = getDateModifiedCell(file, file.changeState);
    const checksumCell = getChecksumCell(file, file.changeState);
    
    // Determine which file icon to use based on changeState
    let iconSvg;
    if (file.changeState === 'moved') {
      iconSvg = '<img src="assets/icons/file-moved.svg" style="width: 20px; height: 20px; object-fit: contain;">';
    } else {
      iconSvg = '<img src="assets/icons/file.svg" style="width: 20px; height: 20px; object-fit: contain;">';
    }
    
    records.push({
      recid: recordId++,
      icon: applyClass(iconSvg, className),
      filename: applyClass(file.filename, className),
      filenameRaw: file.filename,
      size: applyClass(formatBytes(file.size), className),
      dateModified: dateModifiedContent,
      dateModifiedRaw: file.dateModified, // Store raw timestamp for acknowledgment
      dateCreated: file.dateCreated ? new Date(file.dateCreated).toLocaleDateString() : '-',
      dateCreatedRaw: file.dateCreated,
      checksum: checksumCell,
      checksumStatus: file.checksumStatus || null,
      checksumValue: file.checksumValue || null,
      isFolder: false,
      path: file.path,
      changeState: file.changeState,
      inode: file.inode,
      dir_id: file.dir_id || null,
      orphan_id: file.orphan_id || null,
      new_dir_id: file.new_dir_id || null
    });
  }

  // Update grid records for this panel
  const grid = state.w2uiGrid;
  if (grid) {
    grid.records = records;
    grid.refresh();
    console.log(`Grid for panel ${panelId} populated with ${records.length} rows`);
  }
}

/**
 * Inline initials editor — shows a small popup input over the icon cell.
 * The user types up to 2 characters; on confirm the icon regenerates and
 * the value is persisted to dirs.initials via IPC.
 */
function openInitialsEditor(record, panelId) {
  // Remove any existing editor
  const existing = document.getElementById('initials-editor-popup');
  if (existing) existing.remove();

  // Find the icon cell DOM element for this record
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
    // Refresh the icon cell in-place
    record.initials = newInitials;
    const category = await window.electronAPI.getCategoryForDirectory(record.path);
    const iconUrl = await window.electronAPI.generateFolderIcon(category.bgColor, category.textColor, newInitials);
    const className = getRowClassName(record.changeState);
    record.icon = className
      ? `<div class="${className}"><img src="${iconUrl}" style="width: 20px; height: 20px; object-fit: contain; cursor: pointer;" title="Click to set initials"></div>`
      : `<img src="${iconUrl}" style="width: 20px; height: 20px; object-fit: contain; cursor: pointer;" title="Click to set initials">`;
    grid.refreshCell(record.recid, 'icon');
    // Refresh favorites list in case this directory is favorited
    await renderFavoritesList();
  }

  confirmBtn.addEventListener('click', () => applyInitials(input.value));
  clearBtn.addEventListener('click', () => applyInitials(''));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyInitials(input.value);
    if (e.key === 'Escape') popup.remove();
    // Force uppercase as user types
    input.value = input.value.toUpperCase();
  });
  input.addEventListener('input', () => { input.value = input.value.toUpperCase(); });

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('mousedown', function outsideClick(e) {
      if (!popup.contains(e.target)) {
        popup.remove();
        document.removeEventListener('mousedown', outsideClick);
      }
    });
  }, 0);
}

/**
 * Get CSS class name for a file row based on change state
 */
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
    default:
      return '';
  }
}

/**
 * Get formatted date modified cell with appropriate styling
 */
function getDateModifiedCell(file, changeState) {
  const dateStr = new Date(file.dateModified).toLocaleString();
  
  if (changeState === 'new') {
    return `<div class="file-new">${dateStr}</div>`;
  } else if (changeState === 'dateModified') {
    return `<div class="file-date-modified">${dateStr}</div>`;
  } else if (changeState === 'checksumPending') {
    return `<div class="file-checksum-pending">Pending...</div>`;
  } else if (changeState === 'checksumChanged') {
    return `<div class="file-checksum-changed">${dateStr}</div>`;
  }
  
  return dateStr;
}

/**
 * Get formatted checksum cell with appropriate styling based on state
 */
function getChecksumCell(file, changeState) {
  // For folders and files without checksum tracking, show dash
  if (file.isFolder) {
    return '—';
  }
  
  // Show pending status while checksum is being calculated
  if (changeState === 'checksumPending') {
    return '<div class="file-checksum-pending"><span style="animation: spin 1s linear infinite;">⟳</span> Pending</div>';
  }
  
  // Show stored checksum value if available from DB
  if (file.checksumValue) {
    const shortHash = file.checksumValue.substring(0, 12) + '...';
    return `<span title="${file.checksumValue}" style="cursor: help;">${shortHash}</span>`;
  }

  return '—';
}

/**
 * Acknowledge file modification (double-click on date modified cell)
 */
async function acknowledgeFileModification(inode, panelId) {
  try {
    const state = panelState[panelId];
    const currentPath = state.currentPath;
    
    // Get the record to find the current dateModified value
    const grid = state.w2uiGrid;
    const record = grid.records.find(r => r.inode === inode);
    
    if (!record) {
      console.error('Record not found:', inode);
      return;
    }

    // Call IPC to update database with raw timestamp
    const result = await window.electronAPI.updateFileModificationDate(
      currentPath,
      inode,
      record.dateModifiedRaw
    );

    if (result.success) {
      // Update record's changeState
      record.changeState = 'unchanged';
      
      // Rebuild the dateModified cell content (remove styling)
      record.dateModified = new Date(record.dateModifiedRaw).toLocaleDateString();
      
      // Refresh grid
      grid.refresh();
      console.log('File modification acknowledged:', inode);
    } else {
      console.error('Error acknowledging file modification:', result.error);
      alert('Error: ' + result.error);
    }
  } catch (err) {
    console.error('Error in acknowledgeFileModification:', err);
    alert('Error acknowledging modification: ' + err.message);
  }
}

/**
 * Start checksum calculation queue for a panel
 */
async function startChecksumQueue(filesToChecksum, panelId, dirPath) {
  const state = panelState[panelId];
  state.checksumQueue = filesToChecksum;
  state.checksumQueueIndex = 0;
  state.checksumCancelled = false;
  console.log(`Checksum queue started for panel ${panelId} with ${filesToChecksum.length} files`);
  // Process each file sequentially
  while (state.checksumQueueIndex < state.checksumQueue.length && !state.checksumCancelled) {
    const file = state.checksumQueue[state.checksumQueueIndex];
    await calculateChecksumForFile(file, panelId, dirPath);
    state.checksumQueueIndex++;
  }

  if (state.checksumCancelled) {
    console.log('Checksum queue cancelled for panel', panelId);
  } else {
    console.log('Checksum queue completed for panel', panelId);
  }
}

/**
 * Calculate checksum for a single file and update grid
 */
async function calculateChecksumForFile(record, panelId, dirPath) {
  try {
    const result = await window.electronAPI.calculateFileChecksum(
      record.path,
      record.inode,
      record.dir_id
    );

    if (result.success) {
      // Update record with checksum data
      record.checksumStatus = 'calculated';
      record.checksumValue = result.checksum; // Store the full hash
      // Display first 12 characters of hash as a short representation
      const shortHash = result.checksum ? result.checksum.substring(0, 12) + '...' : '—';
      record.checksum = `<span title="${result.checksum || ''}" style="cursor: help;">${shortHash}</span>`;
      
      // Only mark as checksumChanged if there was a previous checksum AND it changed
      // Otherwise leave the existing changeState intact (e.g. 'new', 'dateModified')
      if (result.changed && result.hadPreviousChecksum) {
        record.changeState = 'checksumChanged';
      }
      record.dateModified = new Date(record.dateModifiedRaw).toLocaleDateString();
    } else {
      // Mark as error
      record.checksumStatus = 'error';
      record.checksum = '<span style="color: #f00;">Error</span>';
    }

    // Refresh the specific record in grid
    const grid = panelState[panelId].w2uiGrid;
    if (grid) {
      grid.refresh();
    }

    console.log('Checksum calculated for:', record.filename, result);
  } catch (err) {
    console.error('Error calculating checksum:', err);
    record.checksumStatus = 'error';
    record.checksum = '<span style="color: #f00;">Error</span>';
    const grid = panelState[panelId].w2uiGrid;
    if (grid) {
      grid.refresh();
    }
  }
}

/**
 * Cancel checksum queue for a panel (called when navigating away)
 */
function cancelChecksumQueue(panelId) {
  const state = panelState[panelId];
  if (state.checksumQueue) {
    state.checksumCancelled = true;
    console.log('Checksum queue cancelled for panel', panelId);
  }
}


/**
 * Load all categories from IPC
 */
async function loadCategories() {
  try {
    allCategories = await window.electronAPI.loadCategories();
  } catch (err) {
    console.error('Error loading categories:', err);
  }
}

/**
 * Load hotkeys from storage and populate registry
 */
async function loadHotkeysFromStorage() {
  try {
    const hotkeysData = await window.electronAPI.getHotkeys();
    hotkeyRegistry = {};
    
    // Flatten the nested hotkeys structure into a simple actionId -> key mapping
    for (const context of Object.values(hotkeysData)) {
      for (const [actionId, actionData] of Object.entries(context)) {
        hotkeyRegistry[actionId] = actionData.key;
      }
    }
    
    console.log('Hotkeys loaded:', hotkeyRegistry);
  } catch (err) {
    console.error('Error loading hotkeys:', err);
    // Initialize with defaults if loading fails
    hotkeyRegistry = {
      'navigate_back': 'Alt+Left',
      'navigate_forward': 'Alt+Right',
      'navigate_up': 'Alt+Up',
      'add_panel': 'Ctrl+T',
      'close_panel': 'Ctrl+W',
      'enter_path': 'Enter',
      'cancel_path': 'Escape',
      'edit_notes': 'F2',
      'save_notes': 'Ctrl+S'
    };
  }
}

/**
 * Convert a KeyboardEvent to a normalized hotkey string like "Ctrl+S", "Alt+Left", etc.
 */
function getHotKeyCombo(event) {
  let combo = '';
  
  if (event.ctrlKey) combo += 'Ctrl+';
  if (event.altKey) combo += 'Alt+';
  if (event.shiftKey) combo += 'Shift+';
  
  // Normalize arrow keys and other special keys
  let key = event.key;
  if (key === 'ArrowLeft') key = 'Left';
  else if (key === 'ArrowRight') key = 'Right';
  else if (key === 'ArrowUp') key = 'Up';
  else if (key === 'ArrowDown') key = 'Down';
  else if (key === 'Enter') key = 'Enter';
  else if (key === 'Escape') key = 'Escape';
  else if (key === ' ') key = 'Space';
  
  combo += key;
  return combo;
}

/**
 * Find the action ID for a given hotkey combo (case-insensitive)
 */
function getActionForHotkey(hotkeyCombo) {
  const normalizedCombo = hotkeyCombo.toUpperCase();
  for (const [actionId, key] of Object.entries(hotkeyRegistry)) {
    if (key.toUpperCase() === normalizedCombo) {
      return actionId;
    }
  }
  return null;
}

/**
 * Set which panel is currently active
 */
function setActivePanelId(panelId) {
  if (panelId >= 1 && panelId <= 4) {
    activePanelId = panelId;
    // Update panel badge styling for focus indicator
    for (let i = 1; i <= 4; i++) {
      $(`#panel-${i} .panel-number`).removeClass('panel-number-selected');
    }
    $(`#panel-${panelId} .panel-number`).addClass('panel-number-selected');
    console.log('Active panel set to:', panelId);
  }
}

/**
 * Navigate to previous directory in history for active panel
 */
function navigateBack() {
  const state = panelState[activePanelId];
  if (state.navigationIndex > 0) {
    state.navigationIndex--;
    navigateToDirectory(state.navigationHistory[state.navigationIndex], activePanelId, false);
  }
}

/**
 * Navigate to next directory in history for active panel
 */
function navigateForward() {
  const state = panelState[activePanelId];
  if (state.navigationIndex < state.navigationHistory.length - 1) {
    state.navigationIndex++;
    navigateToDirectory(state.navigationHistory[state.navigationIndex], activePanelId, false);
  }
}

/**
 * Activate path edit mode for a panel
 */
function activatePathEditMode(panelId) {
  const $panel = $(`#panel-${panelId}`);
  const $pathDisplay = $panel.find('.panel-path');
  const $pathInput = $panel.find('.panel-path-input');
  const $title = $panel.find('.w2ui-panel-title');
  
  const currentPath = panelState[panelId].currentPath;
  
  // Show input, hide display, and add editing class
  $pathDisplay.hide();
  $title.addClass('path-input-editing');
  $pathInput.val(currentPath).show().select().focus();
}

/**
 * Deactivate path edit mode and optionally navigate
 */
async function deactivatePathEditMode(panelId, navigateToNewPath = false, newPath = '') {
  const $panel = $(`#panel-${panelId}`);
  const $pathDisplay = $panel.find('.panel-path');
  const $pathInput = $panel.find('.panel-path-input');
  const $title = $panel.find('.w2ui-panel-title');
  
  // Hide input, show display, and remove editing class
  $pathInput.hide();
  $title.removeClass('path-input-editing');
  $pathDisplay.show();
  
  // Navigate to new path if requested and path is not empty
  if (navigateToNewPath && newPath && newPath !== panelState[panelId].currentPath) {
    await navigateToDirectory(newPath, panelId);
  }
}

/**
 * Switch to a different panel layout (1, 2, 3, or 4 panels)
 */
async function switchLayout(layoutNumber) {
  currentLayout = layoutNumber;
  console.log('Switching to layout:', layoutNumber);
  
  const $container = $('#panel-container');
  
  // Remove existing layout class and add new one
  $container.removeClass('layout-1 layout-2 layout-3 layout-4');
  $container.addClass(`layout-${layoutNumber}`);
  
  // Ensure grids are properly sized after layout switch
  setTimeout(() => {
    for (let panelId = 1; panelId <= 4; panelId++) {
      const grid = panelState[panelId].w2uiGrid;
      if (grid) {
        grid.resize();
      }
    }
    
    // Setup dividers and badges after grids are resized
    setupDividers();
    setupBadgeDragHandles();
  }, 150);
}

/**
 * Initialize panel dividers based on localStorage or defaults
 */
function initializeDividers() {
  // Load divider positions from localStorage (as fixed pixel widths/heights)
  panelDividerState.verticalPixels = parseFloat(localStorage.getItem('panelDividerVertical') || '400');
  panelDividerState.horizontalPixels = parseFloat(localStorage.getItem('panelDividerHorizontal') || '300');
  
  console.log('initializeDividers - loaded from localStorage:', panelDividerState);
  
  // Initial setup after a brief delay to allow layout to settle
  setTimeout(() => {
    console.log('initializeDividers - calling setupDividers');
    setupDividers();
  }, 150);
  
  // Handle window resize to maintain percentage-based positioning
  $(window).on('resize.panelDivider', () => {
    setupDividers();
  });
  
  // Also listen to w2layout resize event to catch sidebar resizing
  if (w2layoutInstance) {
    w2layoutInstance.on('resize', () => {
      console.log('w2layout resized, updating dividers');
      setupDividers();
      // Resize all grids so content fills the new size
      for (let panelId = 1; panelId <= 4; panelId++) {
        const grid = panelState[panelId].w2uiGrid;
        if (grid) {
          grid.resize();
        }
      }
    });
  }
}

/**
 * Setup dividers for current layout
 */
function setupDividers() {
  const layout = currentLayout;
  
  // Show/hide dividers based on layout
  const $verticalDivider = $('#panel-divider-vertical');
  const $horizontalDivider = $('#panel-divider-horizontal');
  const $container = $('#panel-container');
  
  console.log('setupDividers called for layout:', layout, 'Container size:', $container.width(), 'x', $container.height());
  
  // Only layouts 2, 3, and 4 have dividers
  const hasVerticalDivider = layout >= 2;
  const hasHorizontalDivider = layout >= 3;
  
  if (hasVerticalDivider) {
    console.log('Showing vertical divider');
    $verticalDivider.css('display', 'block');
    updateGridColumns();
    positionVerticalDivider();
  } else {
    console.log('Hiding vertical divider');
    $verticalDivider.css('display', 'none');
    // Reset columns to single column
    $container.css('grid-template-columns', '1fr');
  }
  
  if (hasHorizontalDivider) {
    console.log('Showing horizontal divider');
    $horizontalDivider.css('display', 'block');
    updateGridRows();
    positionHorizontalDivider();
  } else {
    console.log('Hiding horizontal divider');
    $horizontalDivider.css('display', 'none');
    // Reset rows to single row
    $container.css('grid-template-rows', '1fr');
  }
}

/**
 * Position and setup vertical divider for dragging
 */
function positionVerticalDivider() {
  const $container = $('#panel-container');
  const $divider = $('#panel-divider-vertical');
  
  const containerWidth = $container.width();
  const containerHeight = $container.height();
  
  if (containerWidth === 0 || containerHeight === 0) {
    console.log('Container has no size yet, skipping vertical divider positioning');
    return;
  }
  
  // Use fixed pixel position for left panel
  const dividerX = panelDividerState.verticalPixels;
  
  console.log('Positioning vertical divider:', {
    containerWidth,
    containerHeight,
    leftPanelWidth: panelDividerState.verticalPixels,
    dividerX,
    computed: { left: dividerX - 2, top: 0, height: containerHeight }
  });
  
  $divider.css({
    left: (dividerX - 2) + 'px',
    top: 0,
    height: containerHeight + 'px',
    display: 'block'
  });
  
  console.log('Vertical divider CSS applied:', {
    left: $divider.css('left'),
    top: $divider.css('top'),
    height: $divider.css('height'),
    width: $divider.css('width'),
    position: $divider.css('position'),
    display: $divider.css('display'),
    zIndex: $divider.css('z-index')
  });
  
  // Remove old event handlers
  $divider.off('mousedown.panelResize');
  
  // Add drag handler
  $divider.on('mousedown.panelResize', function(e) {
    console.log('Vertical divider drag started');
    e.preventDefault();
    e.stopPropagation();
    panelDividerState.isResizingVertical = true;
    $divider.addClass('dragging');
    
    const startX = e.pageX;
    const startPixels = panelDividerState.verticalPixels;
    
    $(document).on('mousemove.panelResizeVertical', function(moveEvent) {
      const deltaX = moveEvent.pageX - startX;
      const newPixels = startPixels + deltaX;
      
      // Enforce minimum widths and maximum right panel width
      const maxPixels = containerWidth - panelDividerState.minPanelWidth;
      const constrainedPixels = Math.max(panelDividerState.minPanelWidth, Math.min(maxPixels, newPixels));
      panelDividerState.verticalPixels = constrainedPixels;
      
      // Update grid columns
      updateGridColumns();
      
      // Reposition divider
      positionVerticalDivider();
      
      // In layout 3, also reposition horizontal divider since it depends on vertical divider position
      if (currentLayout === 3) {
        positionHorizontalDivider();
      }
    });
    
    $(document).on('mouseup.panelResizeVertical', function() {
      $(document).off('mousemove.panelResizeVertical mouseup.panelResizeVertical');
      panelDividerState.isResizingVertical = false;
      $divider.removeClass('dragging');
      
      // Save to localStorage
      localStorage.setItem('panelDividerVertical', panelDividerState.verticalPixels);
      
      // Trigger grid resize
      for (let panelId = 1; panelId <= 4; panelId++) {
        const grid = panelState[panelId].w2uiGrid;
        if (grid) {
          grid.resize();
        }
      }
    });
  });
}

/**
 * Position and setup horizontal divider for dragging
 */
function positionHorizontalDivider() {
  const $container = $('#panel-container');
  const $divider = $('#panel-divider-horizontal');
  
  const containerWidth = $container.width();
  const containerHeight = $container.height();
  
  if (containerWidth === 0 || containerHeight === 0) {
    console.log('Container has no size yet, skipping horizontal divider positioning');
    return;
  }
  
  // Use fixed pixel position for top panel
  const dividerY = panelDividerState.horizontalPixels;
  
  // In 3-panel mode, horizontal divider should only span the right side (from vertical divider to right edge)
  // In 4-panel mode, it spans the full width
  let dividerLeft = 0;
  let dividerWidth = containerWidth;
  
  if (currentLayout === 3) {
    // In layout 3, horizontal divider only spans the right side
    dividerLeft = panelDividerState.verticalPixels;
    dividerWidth = containerWidth - panelDividerState.verticalPixels;
  }
  
  console.log('Positioning horizontal divider:', {
    containerWidth,
    containerHeight,
    topPanelHeight: panelDividerState.horizontalPixels,
    dividerY,
    dividerLeft,
    dividerWidth,
    computed: { left: dividerLeft, top: dividerY - 2, width: dividerWidth }
  });
  
  $divider.css({
    left: dividerLeft + 'px',
    top: (dividerY - 2) + 'px',
    width: dividerWidth + 'px',
    display: 'block'
  });
  
  // Remove old event handlers
  $divider.off('mousedown.panelResize');
  
  // Add drag handler
  $divider.on('mousedown.panelResize', function(e) {
    console.log('Horizontal divider drag started');
    e.preventDefault();
    e.stopPropagation();
    panelDividerState.isResizingHorizontal = true;
    $divider.addClass('dragging');
    
    const startY = e.pageY;
    const startPixels = panelDividerState.horizontalPixels;
    
    $(document).on('mousemove.panelResizeHorizontal', function(moveEvent) {
      const deltaY = moveEvent.pageY - startY;
      const newPixels = startPixels + deltaY;
      
      // Enforce minimum heights and maximum bottom panel height
      const maxPixels = containerHeight - panelDividerState.minPanelHeight;
      const constrainedPixels = Math.max(panelDividerState.minPanelHeight, Math.min(maxPixels, newPixels));
      panelDividerState.horizontalPixels = constrainedPixels;
      
      // Update grid rows
      updateGridRows();
      
      // Reposition divider
      positionHorizontalDivider();
    });
    
    $(document).on('mouseup.panelResizeHorizontal', function() {
      $(document).off('mousemove.panelResizeHorizontal mouseup.panelResizeHorizontal');
      panelDividerState.isResizingHorizontal = false;
      $divider.removeClass('dragging');
      
      // Save to localStorage
      localStorage.setItem('panelDividerHorizontal', panelDividerState.horizontalPixels);
      
      // Trigger grid resize
      for (let panelId = 1; panelId <= 4; panelId++) {
        const grid = panelState[panelId].w2uiGrid;
        if (grid) {
          grid.resize();
        }
      }
    });
  });
}

/**
 * Update CSS grid columns based on vertical divider position
 */
function updateGridColumns() {
  const leftWidth = panelDividerState.verticalPixels;
  const $container = $('#panel-container');
  // Left panel stays fixed width, right panel expands/contracts
  const gridTemplateColumns = `${leftWidth}px 1fr`;
  console.log('Updating grid columns to:', gridTemplateColumns, '(left panel fixed at', leftWidth, 'px)');
  $container.css('grid-template-columns', gridTemplateColumns);
}

/**
 * Update CSS grid rows based on horizontal divider position
 */
function updateGridRows() {
  const topHeight = panelDividerState.horizontalPixels;
  const $container = $('#panel-container');
  // Top panels stay fixed height, bottom panels expand/contract
  const gridTemplateRows = `${topHeight}px 1fr`;
  console.log('Updating grid rows to:', gridTemplateRows, '(top panels fixed at', topHeight, 'px)');
  $container.css('grid-template-rows', gridTemplateRows);
}

/**
 * Setup badge drag handlers for resizing dividers
 */
function setupBadgeDragHandles() {
  // Each badge will allow dragging specific dividers based on panel position
  $('.panel-number').off('mousedown.badgeDrag');
  
  $('.panel-number').on('mousedown.badgeDrag', function(e) {
    e.preventDefault();
    
    const $panelNumber = $(this);
    const panelId = parseInt($panelNumber.text());
    
    const $panel = $(`#panel-${panelId}`);
    if (!$panel.is(':visible')) return;
    
    const layout = currentLayout;
    
    // Badge drag behaviors:
    // Badge 1: Resize sidebar (ew-resize)
    // Badge 2: Resize vertical divider (ew-resize)
    // Badge 3: Resize vertical and horizontal dividers (all-scroll)
    // Badge 4: Resize sidebar and horizontal divider (all-scroll)
    
    if (layout === 1) {
      if (panelId === 1) {
        startBadgeDragSidebar(e);
      }
    } else if (layout === 2) {
      if (panelId === 1) {
        startBadgeDragSidebar(e);
      } else {
        startBadgeDragVertical(e);
      }
    } else if (layout === 3) {
      if (panelId === 1) {
        startBadgeDragSidebar(e);
      } else if (panelId === 2) {
        startBadgeDragVertical(e);
      } else if (panelId === 3) {
        startBadgeDragBoth(e, 'vertical-and-horizontal');
      }
    } else if (layout === 4) {
      if (panelId === 1) {
        startBadgeDragSidebar(e);
      } else if (panelId === 2) {
        startBadgeDragVertical(e);
      } else if (panelId === 3) {
        startBadgeDragBoth(e, 'vertical-and-horizontal');
      } else if (panelId === 4) {
        startBadgeDragBoth(e, 'sidebar-and-horizontal');
      }
    }
  });
}

/**
 * Drag sidebar resizer (Badge 1)
 */
function startBadgeDragSidebar(e) {
  const startX = e.pageX;
  const startSidebarWidth = w2layoutInstance.get('left').size;
  
  console.log('Badge 1 drag started. Initial sidebar width:', startSidebarWidth);
  $('body').css('cursor', 'ew-resize');
  
  $(document).on('mousemove.badgeDragSidebar', function(moveEvent) {
    const deltaX = moveEvent.pageX - startX;
    const newWidth = startSidebarWidth + deltaX;
    
    // Enforce minimum sidebar width (e.g., 150px) and max width
    const minWidth = 150;
    const maxWidth = window.innerWidth - 300; // Leave room for main panel
    const constrainedWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
    
    console.log('Badge 1 drag: deltaX=', deltaX, 'newWidth=', constrainedWidth);
    
    // Set the new size (w2ui uses 'size' not 'width')
    w2layoutInstance.set('left', { size: constrainedWidth });
    w2layoutInstance.resize();
    
    // Resize all grids so content fills the new size
    for (let panelId = 1; panelId <= 4; panelId++) {
      const grid = panelState[panelId].w2uiGrid;
      if (grid) {
        grid.resize();
      }
    }
  });
  
  $(document).on('mouseup.badgeDragSidebar', function() {
    $(document).off('mousemove.badgeDragSidebar mouseup.badgeDragSidebar');
    $('body').css('cursor', 'default');
    console.log('Badge 1 drag ended');
  });
}

/**
 * Drag vertical divider (Badge 2)
 */
function startBadgeDragVertical(e) {
  const $container = $('#panel-container');
  const containerWidth = $container.width();
  const startX = e.pageX;
  const startPixels = panelDividerState.verticalPixels;
  
  $('body').css('cursor', 'ew-resize');
  
  $(document).on('mousemove.badgeDragVertical', function(moveEvent) {
    const deltaX = moveEvent.pageX - startX;
    const newPixels = startPixels + deltaX;
    
    const maxPixels = containerWidth - panelDividerState.minPanelWidth;
    const constrainedPixels = Math.max(panelDividerState.minPanelWidth, Math.min(maxPixels, newPixels));
    panelDividerState.verticalPixels = constrainedPixels;
    
    updateGridColumns();
    positionVerticalDivider();
    
    // In layout 3, also reposition horizontal divider since it depends on vertical divider position
    if (currentLayout === 3) {
      positionHorizontalDivider();
    }
  });
  
  $(document).on('mouseup.badgeDragVertical', function() {
    $(document).off('mousemove.badgeDragVertical mouseup.badgeDragVertical');
    $('body').css('cursor', 'default');
    localStorage.setItem('panelDividerVertical', panelDividerState.verticalPixels);
    
    for (let panelId = 1; panelId <= 4; panelId++) {
      const grid = panelState[panelId].w2uiGrid;
      if (grid) {
        grid.resize();
      }
    }
    
    // Re-attach divider drag handler in its new position
    positionVerticalDivider();
    if (currentLayout === 3) {
      positionHorizontalDivider();
    }
  });
}

/**
 * Drag both dividers with direction detection (Badges 3 and 4)
 */
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

  $(document).on('mousemove.badgeDragBoth', function(moveEvent) {
    const deltaX = moveEvent.pageX - startX;
    const deltaY = moveEvent.pageY - startY;

    if (dragMode === 'vertical-and-horizontal') {
      // Move vertical divider with X
      const newVPixels = startVerticalPixels + deltaX;
      const maxVPixels = containerWidth - panelDividerState.minPanelWidth;
      panelDividerState.verticalPixels = Math.max(panelDividerState.minPanelWidth, Math.min(maxVPixels, newVPixels));
      updateGridColumns();
      positionVerticalDivider();
      if (currentLayout === 3) {
        positionHorizontalDivider();
      }
    } else if (dragMode === 'sidebar-and-horizontal') {
      // Move sidebar with X
      const newSidebarWidth = startSidebarWidth + deltaX;
      const constrainedSidebarWidth = Math.max(150, Math.min(window.innerWidth - 300, newSidebarWidth));
      w2layoutInstance.set('left', { size: constrainedSidebarWidth });
      w2layoutInstance.resize();
    }

    // Move horizontal divider with Y (both modes)
    const newHPixels = startHorizontalPixels + deltaY;
    const maxHPixels = containerHeight - panelDividerState.minPanelHeight;
    panelDividerState.horizontalPixels = Math.max(panelDividerState.minPanelHeight, Math.min(maxHPixels, newHPixels));
    updateGridRows();
    positionHorizontalDivider();

    // Resize grids during drag
    for (let panelId = 1; panelId <= 4; panelId++) {
      const grid = panelState[panelId].w2uiGrid;
      if (grid) grid.resize();
    }
  });

  $(document).on('mouseup.badgeDragBoth', function() {
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

/**
 * Show layout configuration modal
 */
function showLayoutModal() {
  $('#layout-modal').show();
}

/**
 * Hide layout configuration modal
 */
function hideLayoutModal() {
  $('#layout-modal').hide();
}

/**
 * Toggle select mode for a panel
 */
function toggleSelectMode(panelId) {
  const state = panelState[panelId];
  state.selectMode = !state.selectMode;
  
  const $selectBtn = $(`#panel-${panelId} .btn-panel-select`);
  
  if (state.selectMode) {
    // Show grid, hide landing page
    $selectBtn.addClass('panel-select-active');
    $(`#panel-${panelId} .panel-landing-page`).hide();
    $(`#panel-${panelId} .panel-grid`).show();
  } else {
    // Hide grid, show landing page
    $selectBtn.removeClass('panel-select-active');
    $(`#panel-${panelId} .panel-landing-page`).show();
    $(`#panel-${panelId} .panel-grid`).hide();
  }
}

/**
 * Update the state of Select buttons based on whether a directory is selected in panel-1
 */
function updatePanelSelectButtons() {
  // Update all panel 2-4 Select buttons
  for (let panelId = 2; panelId <= 4; panelId++) {
    const $selectBtn = $(`#panel-${panelId} .btn-panel-select`);
    
    if (panel1SelectedDirectoryPath && panel1SelectedDirectoryName) {
      // Enable button and show directory name
      $selectBtn.prop('disabled', false);
      $selectBtn.text(panel1SelectedDirectoryName);
      $selectBtn.css('background-color', '');
      $selectBtn.css('color', '');
      $selectBtn.css('cursor', 'pointer');
    } else {
      // Disable button and show placeholder
      $selectBtn.prop('disabled', true);
      $selectBtn.text('Select directory');
      $selectBtn.css('background-color', '#ccc');
      $selectBtn.css('color', '#666');
      $selectBtn.css('cursor', 'not-allowed');
    }
  }
}

/**
 * Handle directory selection in panel-1 grid
 */
function handlePanel1DirectorySelection(dirPath, dirName) {
  panel1SelectedDirectoryPath = dirPath;
  panel1SelectedDirectoryName = dirName;
  updatePanelSelectButtons();
  console.log(`Panel-1 directory selected: ${dirName} (${dirPath})`);
}

/**
 * Get Monaco editor language based on notes format
 */
function getLanguageForFormat(format) {
  switch (format) {
    case 'PlainText':
    case 'Extended':
      return 'plaintext';
    case 'Markdown':
      return 'markdown';
    default:
      return 'plaintext';
  }
}

/**
 * Format notes content based on format type
 */
function formatNotesContent(content, format) {
  switch (format) {
    case 'PlainText':
      // Escape HTML and wrap in pre tag for plain text
      return '<pre style="font-family: monospace; white-space: pre-wrap; word-wrap: break-word;">' + 
             escapeHtml(content) + '</pre>';
    
    case 'Extended':
      // Escape HTML first
      let escaped = escapeHtml(content);
      // Replace [text](url) patterns with clickable links
      // Note: This works with escaped content by looking for the pattern before escaping
      // We need to revert some escaping for link patterns
      // Pattern: &lsqb;text&rsqb;&lpar;url&rpar; -> <a href="url">text</a>
      let formatted = escaped.replace(/&lsqb;([^\]]+)&rsqb;&lpar;([^)]+)&rpar;/g, 
        '<a href="$2" target="_blank" style="color: #2196F3; text-decoration: underline;">$1</a>');
      // Also handle unescaped brackets in case they weren't escaped
      formatted = formatted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, 
        '<a href="$2" target="_blank" style="color: #2196F3; text-decoration: underline;">$1</a>');
      return '<pre style="font-family: monospace; white-space: pre-wrap; word-wrap: break-word;">' + formatted + '</pre>';
    
    case 'Markdown':
      // Return content as-is for markdown rendering via renderMarkdown IPC call
      return null; // Special case: caller should use renderMarkdown
    
    default:
      return '<pre style="font-family: monospace; white-space: pre-wrap; word-wrap: break-word;">' + 
             escapeHtml(content) + '</pre>';
  }
}

/**
 * Hide history modal
 */
function hideHistoryModal() {
  $('#history-modal').hide();
  // Destroy w2ui grid
  if (w2ui['history-grid']) {
    w2ui['history-grid'].destroy();
  }
}

/**
 * Escape HTML special characters
 */
function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Initialize Monaco Editor loader (called once at app startup)
 */
let monacoLoaded = false;
async function initializeMonacoLoader() {
  return new Promise((resolve) => {
    if (monacoLoaded) {
      resolve();
      return;
    }
    
    // Wait for require to be available (Monaco loader script must load first)
    const waitForRequire = setInterval(() => {
      if (typeof require !== 'undefined') {
        clearInterval(waitForRequire);
        
        // Configure Monaco loader path
        require.config({ paths: { 'vs': '../node_modules/monaco-editor/min/vs' } });

        // Load Monaco Editor
        require(['vs/editor/editor.main'], function() {
          console.log('Monaco editor loader initialized');
          monacoLoaded = true;

          // Register tag autocomplete (#tagname) for notes editor
          ['markdown', 'plaintext'].forEach(lang => {
            monaco.languages.registerCompletionItemProvider(lang, {
              triggerCharacters: ['#'],
              provideCompletionItems: async (model, position) => {
                const textUntilPosition = model.getValueInRange({
                  startLineNumber: position.lineNumber,
                  startColumn: 1,
                  endLineNumber: position.lineNumber,
                  endColumn: position.column
                });
                const match = textUntilPosition.match(/#(\w*)$/);
                if (!match) return { suggestions: [] };

                const startCol = position.column - match[0].length;
                const range = {
                  startLineNumber: position.lineNumber,
                  endLineNumber: position.lineNumber,
                  startColumn: startCol,
                  endColumn: position.column
                };

                const tags = await window.electronAPI.getTagsList();
                const suggestions = tags.map(tag => ({
                  label: `#${tag.name}`,
                  kind: monaco.languages.CompletionItemKind.Value,
                  insertText: `#${tag.name}`,
                  filterText: `#${tag.name}`,
                  range: range,
                  documentation: tag.description || ''
                }));
                return { suggestions };
              }
            });
          });

          resolve();
        });
      }
    }, 100);
    
    // Timeout after 5 seconds to prevent infinite waiting
    setTimeout(() => {
      clearInterval(waitForRequire);
      if (monacoLoaded) return;
      console.error('Monaco loader failed to load within 5 seconds');
      resolve(); // Resolve anyway to prevent app hang
    }, 5000);
  });
}

/**
 * Create Monaco Editor instance for a specific container
 */
let monacoEditor = null;
function createMonacoEditorInstance(containerElement) {
  if (monacoEditor) {
    // Dispose existing editor before creating new one
    monacoEditor.dispose();
  }
  
  monacoEditor = monaco.editor.create(containerElement, {
    value: '',
    language: 'plaintext',
    theme: 'vs',
    wordWrap: 'on',
    lineNumbers: 'off',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    fontSize: 13,
    fontFamily: 'Consolas, "Courier New", monospace'
  });

  console.log('Monaco editor instance created');
  return monacoEditor;
}
/**
 * Show notes view for a panel
 * @param {number} panelId - The panel to show notes in
 * @param {string} [notesPathOverride] - Explicit path to notes.txt; defaults to panel 1's current directory
 */
async function showNotesView(panelId, notesPathOverride) {
  const notesPath = notesPathOverride || (panelState[1].currentPath + '\\notes.txt');
  panelState[panelId].notesFilePath = notesPath;
  const $notesView = $(`#panel-${panelId} .panel-notes-view`);
  const $notesEditorContainer = $notesView.find('.notes-editor-container');
  const $notesContentView = $notesView.find('.notes-content-view');
  const $notesToolbar = $notesView.find('.w2ui-panel-title');
  
  try {
    // Get current notes format setting
    const settings = await window.electronAPI.getSettings();
    const notesFormat = settings.notes_format || 'Markdown';
    
    // Create Monaco editor instance if not exists
    if (!monacoEditor) {
      createMonacoEditorInstance($notesEditorContainer[0]);
    }
    
    // Try to read notes.txt
    const content = await window.electronAPI.readNotesFile(notesPath);
    
    // Set Monaco editor content and language
    if (monacoEditor) {
      monacoEditor.setValue(content);
      const language = getLanguageForFormat(notesFormat);
      monaco.editor.setModelLanguage(monacoEditor.getModel(), language);
    }
    
    // Format and display notes based on format setting
    if (notesFormat === 'Markdown') {
      // Render markdown to HTML
      const htmlContent = await window.electronAPI.renderMarkdown(content);
      $notesContentView.html(htmlContent);
    } else {
      // Use plain text or extended formatting
      const htmlContent = formatNotesContent(content, notesFormat);
      $notesContentView.html(htmlContent);
    }
    
    // Hide landing page and grid, show notes view
    $(`#panel-${panelId} .panel-landing-page`).hide();
    $(`#panel-${panelId} .panel-grid`).hide();
    $notesView.show();
    
    // Show view mode by default, hide edit mode
    $notesContentView.show();
    $notesEditorContainer.hide();
    
    // Update toolbar with notes path (overlays grid header)
    $notesToolbar.find('.notes-path').text(notesPath);
    $notesToolbar.show();
    
    // Reset buttons
    $notesToolbar.find('.btn-notes-edit').show().text('Edit').css('background', '#2196F3');
    $notesToolbar.find('.btn-notes-save').hide();
    
    notesEditMode = false;
  } catch (err) {
    // File doesn't exist, create empty notes
    // Create Monaco editor instance if not exists
    if (!monacoEditor) {
      createMonacoEditorInstance($notesEditorContainer[0]);
    }
    
    if (monacoEditor) {
      monacoEditor.setValue('');
      // Set default language based on format setting
      const settings = await window.electronAPI.getSettings();
      const notesFormat = settings.notes_format || 'Markdown';
      const language = getLanguageForFormat(notesFormat);
      monaco.editor.setModelLanguage(monacoEditor.getModel(), language);
    }
    $notesContentView.html('');
    
    $(`#panel-${panelId} .panel-landing-page`).hide();
    $(`#panel-${panelId} .panel-grid`).hide();
    $notesView.show();
    
    // Start in edit mode for new file
    $notesEditorContainer.show();
    $notesContentView.hide();
    
    // Update toolbar with notes path (overlays grid header)
    $notesToolbar.find('.notes-path').text(notesPath);
    $notesToolbar.show();
    
    // Show Save button for new file
    $notesToolbar.find('.btn-notes-edit').hide();
    $notesToolbar.find('.btn-notes-save').show();
    
    notesEditMode = true;
  }
  
  setActivePanelId(panelId);
}

/**
 * Hide notes view and return to landing page
 */
function hideNotesView(panelId) {
  const $notesView = $(`#panel-${panelId} .panel-notes-view`);
  const $notesEditorContainer = $notesView.find('.notes-editor-container');
  const $notesContentView = $notesView.find('.notes-content-view');
  const $notesToolbar = $notesView.find('.w2ui-panel-title');
  
  $notesView.hide();
  $notesToolbar.hide();
  $notesEditorContainer.hide();
  $notesContentView.hide();
  // Panel toolbar (grid header) remains visible
  $(`#panel-${panelId} .panel-landing-page`).show();
  
  notesEditMode = false;
}

/**
 * Toggle edit mode for notes
 */
async function toggleNotesEditMode(panelId) {
  const $notesView = $(`#panel-${panelId} .panel-notes-view`);
  const $notesEditorContainer = $notesView.find('.notes-editor-container');
  const $notesContentView = $notesView.find('.notes-content-view');
  const $editBtn = $notesView.find('.btn-notes-edit');
  const $saveBtn = $notesView.find('.btn-notes-save');
  
  if (notesEditMode === false) {
    // Enter edit mode
    $notesContentView.hide();
    $notesEditorContainer.show();
    if (monacoEditor) {
      monacoEditor.focus();
    }
    $editBtn.hide();
    $saveBtn.show();
    notesEditMode = true;
  } else {
    // Save and exit edit mode
    const content = monacoEditor ? monacoEditor.getValue() : '';
    const notesPath = panelState[panelId].notesFilePath || (panelState[1].currentPath + '\\notes.txt');
    
    try {
      await window.electronAPI.writeNotesFile(notesPath, content);
      
      // Get current notes format setting
      const settings = await window.electronAPI.getSettings();
      const notesFormat = settings.notes_format || 'Markdown';
      
      // Format and display notes based on format setting
      if (notesFormat === 'Markdown') {
        // Render markdown to HTML
        const htmlContent = await window.electronAPI.renderMarkdown(content);
        $notesContentView.html(htmlContent);
      } else {
        // Use plain text formatting
        const htmlContent = formatNotesContent(content, notesFormat);
        $notesContentView.html(htmlContent);
      }
      
      $notesEditorContainer.hide();
      $notesContentView.show();
      
      $editBtn.show().text('Edit').css('background', '#2196F3');
      $saveBtn.hide();
      notesEditMode = false;
    } catch (err) {
      alert('Error saving notes: ' + err.message);
    }
  }
}

/**
 * Update panel layout based on visible panels count
 */
function updatePanelLayout() {
  const $container = $('#panel-container');
  $container.removeClass('layout-1 layout-2 layout-3 layout-4').addClass(`layout-${visiblePanels}`);
  
  // Update current layout and setup dividers
  currentLayout = visiblePanels;
  
  // Give layout time to apply before positioning dividers
  setTimeout(() => {
    console.log('updatePanelLayout: setting up dividers for layout', visiblePanels);
    setupDividers();
    setupBadgeDragHandles();
  }, 100);
}

/**
 * Remove a panel and shift higher-numbered panels down
 */
function removePanel(panelId) {
  if (visiblePanels === 1) {
    alert('Cannot remove the last panel');
    return;
  }
  
  // Hide this panel and clear its state
  $(`#panel-${panelId}`).hide();
  clearPanelState(panelId);
  
  // Shift all higher-numbered panels down
  for (let i = panelId; i < visiblePanels; i++) {
    shiftPanelDown(i);
  }
  
  visiblePanels--;
  activePanelId = 1; // Reset to panel 1 after removal
  updatePanelLayout();
}

/**
 * Shift a panel's content and state down by one position
 */
function shiftPanelDown(panelId) {
  const nextPanelId = panelId + 1;
  
  // Copy state from next panel to current panel
  panelState[panelId] = { ...panelState[nextPanelId] };
  
  // Swap grid references
  const $currentGrid = $(`#panel-${panelId} .panel-grid`);
  const $nextGrid = $(`#panel-${nextPanelId} .panel-grid`);
  
  if (panelState[panelId].w2uiGrid) {
    panelState[panelId].w2uiGrid.render($currentGrid[0]);
  }
  
  // Update path display
  $(`#panel-${panelId} .panel-path`).text(panelState[panelId].currentPath);
}

/**
 * Clear a panel's state
 */
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
    hasBeenViewed: false
  };

  // Unregister from backend background refresh
  window.electronAPI.unregisterWatchedPath(panelId);

  // Note: Grid header is hidden along with the grid
  const $panel = $(`#panel-${panelId}`);
  setPanelPathValidity(panelId, true);
  $panel.find('.panel-landing-page').show();
  $panel.find('.panel-grid').hide();
  $panel.find('.panel-notes-view').hide();
}

/**
 * Close the active panel or the window based on context
 */
async function closeActivePanel() {
  // Check if monaco editor is in edit mode
  if (notesEditMode) {
    if (monacoEditor) {
      const content = monacoEditor.getValue();
      w2confirm({
        msg: 'Notes are being edited.<br><br>Click "Save & Close" to save and close, or "Keep Editing" to continue.',
        title: 'Unsaved Notes',
        width: 420,
        height: 200,
        btn_yes: {
          text: 'Save & Close',
          class: '',
          style: ''
        },
        btn_no: {
          text: 'Keep Editing',
          class: '',
          style: ''
        }
      }).yes(async () => {
          // Save notes before closing
          const notesPath = panelState[1].currentPath + '\\notes.txt';
          try {
            await window.electronAPI.writeNotesFile(notesPath, content);
            
            // Get current notes format setting
            const settings = await window.electronAPI.getSettings();
            const notesFormat = settings.notes_format || 'Markdown';
            
            // Format and display notes based on format setting
            const $notesView = $(`#panel-${activePanelId} .panel-notes-view`);
            const $notesContentView = $notesView.find('.notes-content-view');
            const $notesEditorContainer = $notesView.find('.notes-editor-container');
            const $editBtn = $notesView.find('.btn-notes-edit');
            const $saveBtn = $notesView.find('.btn-notes-save');
            
            if (notesFormat === 'Markdown') {
              // Render markdown to HTML
              const htmlContent = await window.electronAPI.renderMarkdown(content);
              $notesContentView.html(htmlContent);
            } else {
              // Use plain text formatting
              const htmlContent = formatNotesContent(content, notesFormat);
              $notesContentView.html(htmlContent);
            }
            
            $notesEditorContainer.hide();
            $notesContentView.show();
            $editBtn.show().text('Edit').css('background', '#2196F3');
            $saveBtn.hide();
            notesEditMode = false;
            
            // Proceed to close the panel
            proceedWithPanelClose();
          } catch (err) {
            alert('Error saving notes: ' + err.message);
          }
        })
      // If user cancels, do nothing (keep edit mode open)
    }
    return;
  }
  
  // If only one panel is open, confirm before closing the window
  if (visiblePanels === 1) {
    w2confirm({
      msg: 'Close the application?<br><br>Click "Close" to exit, or "Cancel" to keep the app open.',
      title: 'Confirm Close',
      width: 400,
      height: 180,
      btn_yes: {
        text: 'Close',
        class: '',
        style: ''
      },
      btn_no: {
        text: 'Cancel',
        class: '',
        style: ''
      }
    }).yes(async () => {
      await window.electronAPI.closeWindow();
    });
    return;
  }
  
  // Otherwise, just close the active panel
  proceedWithPanelClose();
}

/**
 * Handle close app request from main process (triggered by close button or Alt+F4)
 */
async function handleCloseRequest() {
  // Check if monaco editor is in edit mode
  if (notesEditMode) {
    if (monacoEditor) {
      const content = monacoEditor.getValue();
      w2confirm({
        msg: 'Notes are being edited<br><br>"Exit Anyway" to close WITHOUT saving, or<br>"Cancel" to keep the app open.',
        title: 'WARNING - Unsaved Notes',
        width: 450,        // width of the dialog
        height: 220,       // height of the dialog
        btn_yes: {
            text: 'Exit Anyway',   // text for yes button (or yes_text)
            class: '',     // class for yes button (or yes_class)
            style: '',     // style for yes button (or yes_style)
            onClick: null  // callBack for yes button (or yes_callBack)
        },
        btn_no: {
            text: 'Cancel',    // text for no button (or no_text)
            class: '',     // class for no button (or no_class)
            style: '',     // style for no button (or no_style)
            onClick: null  // callBack for no button (or no_callBack)
        }
      }).yes(async () => {
          // Save notes before closing
          const notesPath = panelState[1].currentPath + '\\notes.txt';
          try {
            // saved in case we want to add a save option to this popup in the future:
            // await window.electronAPI.writeNotesFile(notesPath, content);
            window.electronAPI.allowClose();
          } catch (err) {
            console.error('Error saving notes before close:', err.message);
            window.electronAPI.allowClose();  // Close anyway
          }
        });
      // If user cancels, do nothing (app stays open
    }
    return;
  }
  // default behavior: allow close without confirmation
  window.electronAPI.allowClose();
}

/**
 * Proceed with closing the active panel after any confirmation dialogs
 */
function proceedWithPanelClose() {
  removePanel(activePanelId);
}

/**
 * Attach event listeners to a specific panel (with proper closure)
 */
function attachPanelEventListeners(panelId) {
  const $panel = $(`#panel-${panelId}`);
  
  // Set active panel when clicking anywhere in the panel (except on interactive elements)
  $panel.off('click.panelActive').on('click.panelActive', function(e) {
    // Don't retrigger for buttons that have their own handlers
    if (!$(e.target).is('button') && !$(e.target).closest('button').length) {
      setActivePanelId(panelId);
    }
  });
  
  // Note: Panel title elements are now managed in the grid header by attachGridHeaderEventListeners
  // which is called from updateGridHeader()
  
  // Select button (panels 2-4 only)
  if (panelId > 1) {
    $panel.find('.btn-panel-select').off('click').on('click', function() {
      setActivePanelId(panelId);
      // If a directory is selected from panel-1, navigate to it and hide landing page
      if (panel1SelectedDirectoryPath) {
        navigateToDirectory(panel1SelectedDirectoryPath, panelId);
        // Hide landing page and show grid
        $panel.find('.panel-landing-page').hide();
        $panel.find('.panel-grid').show();
      }
    });
    
    // Notes button
    $panel.find('.btn-panel-notes').off('click').on('click', async function() {
      await showNotesView(panelId);
    });
    
    // Notes edit button
    $panel.find('.btn-notes-edit').off('click').on('click', async function() {
      await toggleNotesEditMode(panelId);
    });
    
    // Notes save button
    $panel.find('.btn-notes-save').off('click').on('click', async function() {
      await toggleNotesEditMode(panelId);
    });
    
    // Notes back button
    $panel.find('.btn-notes-back').off('click').on('click', function() {
      hideNotesView(panelId);
    });
    
    // Panel remove button (panels 2-4 only)
    $panel.find('.btn-panel-remove').off('click').on('click', function() {
      removePanel(panelId);
    });
    
    // Landing page overlay close button (panels 2-4 only)
    $panel.find('.btn-panel-remove-overlay').off('click').on('click', function() {
      removePanel(panelId);
    });
    
    // Add panel button on panel 2 landing page
    if (panelId === 2) {
      $panel.find('.btn-add-panel-landing').off('click').on('click', function() {
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

/**
 * Attach event listeners to buttons and grid
 */
function attachEventListeners() {
  // Keyboard shortcuts - detect hotkey and dispatch to appropriate handler
  $(document).keydown(async function(event) {
    const hotkeyCombo = getHotKeyCombo(event);
    const actionId = getActionForHotkey(hotkeyCombo);
    
    // Only handle recognized hotkeys
    if (!actionId) return;
    
    switch(actionId) {
      case 'navigate_back':
        event.preventDefault();
        navigateBack();
        break;
      case 'navigate_forward':
        event.preventDefault();
        navigateForward();
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
        navigateToDirectory(parentPath, activePanelId);
        break;
      case 'edit_notes':
        const $notesView = $(`#panel-${activePanelId} .panel-notes-view`);
        if ($notesView.is(':visible') && !notesEditMode) {
          event.preventDefault();
          await toggleNotesEditMode(activePanelId);
        }
        break;
      case 'save_notes':
        const $notesViewSave = $(`#panel-${activePanelId} .panel-notes-view`);
        if ($notesViewSave.is(':visible') && notesEditMode) {
          event.preventDefault();
          await toggleNotesEditMode(activePanelId);
        }
        break;
      case 'add_panel':
        event.preventDefault();
        if (visiblePanels < 4) {
          visiblePanels++;
          $(`#panel-${visiblePanels}`).show();
          updatePanelLayout();
        }
        break;
      case 'close_panel':
        event.preventDefault();
        closeActivePanel();
        break;
    }
  });

  // Window focus/blur handlers for panel selection styling
  $(window).blur(function() {
    // When window loses focus, remove selection styling from all panels
    for (let i = 1; i <= 4; i++) {
      $(`#panel-${i} .panel-number`).removeClass('panel-number-selected');
    }
  });

  $(window).focus(function() {
    // When window regains focus, restore selection styling to active panel
    $(`#panel-${activePanelId} .panel-number`).addClass('panel-number-selected');
  });

  // View button - show layout modal
  $('#btn-view').click(function() {
    showLayoutModal();
  });

  // Add panel button
  $('#btn-add-panel').click(function() {
    if (visiblePanels < 4) {
      visiblePanels++;
      const newPanelId = visiblePanels;
      $(`#panel-${newPanelId}`).show();
      
      // Reattach event listeners for the newly visible panel
      attachPanelEventListeners(newPanelId);
      
      updatePanelLayout();
    }
  });

  // Layout option buttons
  $('.layout-option').click(function() {
    const layoutNumber = parseInt($(this).data('layout'));
    switchLayout(layoutNumber);
    hideLayoutModal();
  });

  // Layout modal close button and overlay
  $('#btn-layout-close').click(function() {
    hideLayoutModal();
  });

  $('#layout-modal').click(function(e) {
    if (e.target === this) {
      hideLayoutModal();
    }
  });

  // Panel button handlers - add click listeners for all panels
  for (let panelId = 1; panelId <= 4; panelId++) {
    attachPanelEventListeners(panelId);
  }

  // Settings modal close button
  $('#btn-settings-close').click(function() {
    hideSettingsModal();
  });

  // Sidebar Settings button
  $('#btn-sidebar-settings').click(function() {
    showSettingsModal();
  });

  // Settings modal overlay click to close
  $('#settings-modal').click(function(e) {
    if (e.target === this) {
      hideSettingsModal();
    }
  });

  // Settings tab buttons
  $('.settings-tab-btn').click(function() {
    const tabName = $(this).data('tab');
    switchSettingsTab(tabName);
  });

  // Category form save button
  $('#btn-cat-save').click(async function() {
    await saveCategoryFromForm();
  });

  // Category form clear/new button
  $('#btn-cat-clear').click(function() {
    clearCategoryForm();
  });

  // Category form delete button
  $('#btn-cat-delete').click(async function() {
    await deleteCategoryFromForm();
  });

  // Browser settings: validate directory while typing
  $('#browser-home-directory').on('input', async function() {
    await updateHomeDirectoryWarning($(this).val());
  });

  // Browser settings: update preview on recordHeight input change
  $('#browser-record-height').on('input', function() {
    updateRecordHeightPreview();
  });

  // Browser Settings - Advanced: reinitialize database button
  $('#btn-dev-reinitialize-db').click(async function() {
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
  $('#btn-tag-save').click(async function() {
    await saveTagFromForm();
  });

  // Tag form clear/new button
  $('#btn-tag-clear').click(function() {
    clearTagForm();
  });

  // Tag form delete button
  $('#btn-tag-delete').click(async function() {
    await deleteTagFromForm();
  });

  // Hotkeys form demo button
  $('#btn-hotkey-demo').click(function() {
    enterHotkeyDemoMode();
  });

  // Hotkeys form save button
  $('#btn-hotkey-save').click(async function() {
    await saveHotkeyFromForm();
  });

  // Hotkeys form reset button
  $('#btn-hotkey-reset').click(async function() {
    await resetHotkeyToDefault();
  });

  // History modal close button
  $('#btn-history-close').click(function() {
    hideHistoryModal();
  });

  // History modal overlay click to close
  $('#history-modal').click(function(e) {
    if (e.target === this) {
      hideHistoryModal();
    }
  });
}

/**
 * Setup resizable divider between grid and form
 */
function setupResizableDivider() {
  const divider = $('#category-divider');
  const formPanel = $('#category-form-panel');
  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  divider.mousedown(function(e) {
    isResizing = true;
    startX = e.clientX;
    startWidth = formPanel.width();
    $(document).css('user-select', 'none');
  });

  $(document).mousemove(function(e) {
    if (!isResizing) return;
    
    const deltaX = e.clientX - startX;
    const newWidth = Math.max(250, startWidth - deltaX); // Minimum 250px width
    formPanel.css('flex', `0 0 ${newWidth}px`);
  });

  $(document).mouseup(function() {
    if (isResizing) {
      isResizing = false;
      $(document).css('user-select', '');
    }
  });
}

/**
 * Setup resizable divider for tag form panel
 */
function setupTagResizableDivider() {
  const divider = $('#tag-divider');
  const formPanel = $('#tag-form-panel');
  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  divider.mousedown(function(e) {
    isResizing = true;
    startX = e.clientX;
    startWidth = formPanel.width();
    $(document).css('user-select', 'none');
  });

  $(document).mousemove(function(e) {
    if (!isResizing) return;
    
    const deltaX = e.clientX - startX;
    const newWidth = Math.max(250, startWidth - deltaX); // Minimum 250px width
    formPanel.css('flex', `0 0 ${newWidth}px`);
  });

  $(document).mouseup(function() {
    if (isResizing) {
      isResizing = false;
      $(document).css('user-select', '');
    }
  });
}

/**
 * Setup resizable divider for hotkeys form panel
 */
function setupHotkeysResizableDivider() {
  const divider = $('#hotkeys-divider');
  const formPanel = $('#hotkeys-form-panel');
  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  divider.mousedown(function(e) {
    isResizing = true;
    startX = e.clientX;
    startWidth = formPanel.width();
    $(document).css('user-select', 'none');
  });

  $(document).mousemove(function(e) {
    if (!isResizing) return;
    
    const deltaX = e.clientX - startX;
    const newWidth = Math.max(250, startWidth - deltaX); // Minimum 250px width
    formPanel.css('flex', `0 0 ${newWidth}px`);
  });

  $(document).mouseup(function() {
    if (isResizing) {
      isResizing = false;
      $(document).css('user-select', '');
    }
  });
}

/**
 * Show settings modal
 */
async function showSettingsModal() {
  
  // Reset lazy-init tracking for this modal session
  initializedSettingsTabs = new Set(['category']);

  // Show modal FIRST so containers have proper dimensions
  $('#settings-modal').show();
  
  // Ensure Category Settings tab is active
  switchSettingsTab('category');
  
  // Initialize categories grid and forms (category tab is already visible)
  await initializeCategoriesGrid();
  await initializeCategoriesForm();
  await initializeBrowserSettingsForm();
  
  // Setup category resizable divider
  // Tags/hotkeys dividers are set up lazily when their tab is first opened
  setupResizableDivider();
  
}

/**
 * Hide settings modal
 */
function hideSettingsModal() {
  $('#settings-modal').hide();
  initializedSettingsTabs = new Set();
  // Destroy w2ui grids
  if (w2ui['categories-grid']) {
    w2ui['categories-grid'].destroy();
  }
  if (w2ui['tags-grid']) {
    w2ui['tags-grid'].destroy();
  }
  if (w2ui['hotkeys-grid']) {
    w2ui['hotkeys-grid'].destroy();
  }
  
}


/**
 * Open history modal for a selected file/directory
 */
async function openHistoryModal(selectedRecord) {
  try {
    // Get file history from database
    const result = await window.electronAPI.getFileHistory(selectedRecord.inode);
    
    if (!result.success) {
      alert('Error loading file history: ' + result.error);
      return;
    }
    
    // Update modal title
    $('#history-modal-title').text(`History: ${selectedRecord.filenameRaw || selectedRecord.filename}`);
    
    // Destroy existing grid if it exists
    if (w2ui['history-grid']) {
      w2ui['history-grid'].destroy();
    }
    
    // Build the complete file state from history
    const fullState = buildCompleteFileState(result.data || [], selectedRecord);
    
    // Initialize and populate history grid
    const historyData = formatHistoryData(result.data || [], fullState);
    
    const gridColumns = [
      { field: 'detectedAt', text: 'Detected At', size: '160px', resizable: true, sortable: true },
      { field: 'changeValue', text: 'Change', size: '200px', resizable: true, sortable: true },
      { field: 'path', text: 'Path', size: '100%', resizable: true, sortable: true }
    ];
    
    $('#history-grid').w2grid({
      name: 'history-grid',
      columns: gridColumns,
      records: historyData,
      show: { header: true, toolbar: false, footer: true },
      onClick: function(event) {
        // Update summary when a row is clicked
        if (event.detail && event.detail.recid) {
          const selectedIndex = event.detail.recid - 1;
          console.log('Grid row clicked, index:', selectedIndex);
          updateHistoryChangeSummary(fullState, selectedIndex);
        }
      }
    });
    
    // Create summary view below grid with initial selection (first/newest record)
    createHistorySummaryView(fullState, 0);
    
    // Show modal
    $('#history-modal').show();
  } catch (err) {
    console.error('Error opening history modal:', err);
    alert('Error opening history: ' + err.message);
  }
}

/**
 * Format history data for display in grid
 * Shows only the key that changed (or "INITIAL" for first entry)
 */
function formatHistoryData(historyRecords, fullState) {
  // Priority order for change keys (lower number = higher priority)
  const KEY_PRIORITY = {
    'checksumValue': 1,
    'filename': 2,
    'dateModified': 3,
    'size': 4,
    'filesizeBytes': 4,
    'status': 5
  };
  
  return historyRecords.map((record, index) => {
    let changeKeyDisplay = '-';
    
    try {
      // If this is the first (earliest) entry, show "INITIAL"
      if (index === historyRecords.length - 1) {
        changeKeyDisplay = 'INITIAL';
      } else {
        // Parse changeValue JSON if it's a string
        const parsed = typeof record.changeValue === 'string' ? 
          JSON.parse(record.changeValue) : record.changeValue;
        
        if (parsed && typeof parsed === 'object') {
          // Extract all keys and sort by priority
          const keys = Object.keys(parsed);
          const sortedKeys = keys.sort((a, b) => {
            const priorityA = KEY_PRIORITY[a] ?? 999;
            const priorityB = KEY_PRIORITY[b] ?? 999;
            return priorityA - priorityB;
          });
          
          if (sortedKeys.length > 0) {
            // Display only the highest priority key
            changeKeyDisplay = sortedKeys[0];
          }
        }
      }
    } catch (e) {
      // If JSON parse fails, use '-'
      changeKeyDisplay = '-';
    }
    
    return {
      recid: index + 1,
      detectedAt: record.detectedAt ? new Date(record.detectedAt).toLocaleString() : '-',
      changeValue: changeKeyDisplay,
      path: fullState.path || '-',
      _rawData: record  // Store raw data for summary view
    };
  });
}

/**
 * Build complete file state by analyzing all history records
 * Returns an object with the full state at each history point
 */
function buildCompleteFileState(historyRecords, selectedRecord) {
  const allAttributes = new Set();
  const states = [];
  let currentState = {
    path: selectedRecord ? (selectedRecord.path || selectedRecord.filename) : '-'
  };
  
  // First pass: collect all attributes and build state timeline
  // Start from oldest (end of array) to newest (start of array)
  for (let i = historyRecords.length - 1; i >= 0; i--) {
    const record = historyRecords[i];
    
    try {
      const parsed = typeof record.changeValue === 'string' ? 
        JSON.parse(record.changeValue) : record.changeValue;
      
      if (parsed && typeof parsed === 'object') {
        // Add all keys to the set of attributes
        Object.keys(parsed).forEach(key => allAttributes.add(key));
        
        // Update current state with new values
        Object.assign(currentState, parsed);
      }
    } catch (e) {
      // Skip invalid records
    }
    
    states.push({ ...currentState, detectedAt: record.detectedAt });
  }
  
  // Reverse states to go from oldest to newest
  states.reverse();
  
  return {
    allAttributes: Array.from(allAttributes).sort(),
    states: states,
    path: selectedRecord ? (selectedRecord.path || selectedRecord.filename) : '-'
  };
}

/**
 * Create the history summary view below the grid
 */
function createHistorySummaryView(fullState, selectedIndex) {
  try {
    const attributeList = fullState.allAttributes;
    const len = fullState.states.length;
    
    // selectedIndex is 0-based grid index (0 = newest)
    // states index: 0 = newest, states.length-1 = oldest (after reverse)
    // So selectedIndex maps directly to states[selectedIndex]
    const selectedState = (selectedIndex < len) ? fullState.states[selectedIndex] : {};
    const previousState = (selectedIndex + 1 < len) ? fullState.states[selectedIndex + 1] : {};
    
    console.log('Creating summary for selectedIndex:', selectedIndex, 'states length:', len);
    
    // Build HTML for summary
    let summaryHtml = '<div id="history-summary" style="margin-top: 15px; padding: 15px; background: #f9f9f9; border-radius: 4px; border: 1px solid #ddd;">';
    summaryHtml += '<h3 style="margin-top: 0; margin-bottom: 10px;">Change Summary</h3>';
    
    summaryHtml += '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">';
    
    // Previous column
    summaryHtml += '<div><h4 style="margin: 5px 0 10px 0; color: #666;">Previous</h4>';
    summaryHtml += '<table style="width: 100%; border-collapse: collapse; font-size: 13px;">';
    
    for (const attr of attributeList) {
      const value = previousState[attr];
      const displayValue = formatAttributeValue(attr, value);
      const isChanged = selectedState[attr] !== previousState[attr];
      const className = isChanged ? 'file-new' : '';
      summaryHtml += `<tr style="border-bottom: 1px solid #eee;"><td style="padding: 6px; font-weight: bold; width: 40%;">${escapeHtml(attr)}:</td><td style="padding: 6px;" class="${className}">${escapeHtml(displayValue)}</td></tr>`;
    }
    
    summaryHtml += '</table></div>';
    
    // Changed column
    summaryHtml += '<div><h4 style="margin: 5px 0 10px 0; color: #666;">Changed</h4>';
    summaryHtml += '<table style="width: 100%; border-collapse: collapse; font-size: 13px;">';
    
    for (const attr of attributeList) {
      const value = selectedState[attr];
      const displayValue = formatAttributeValue(attr, value);
      const isChanged = selectedState[attr] !== previousState[attr];
      const className = isChanged ? 'file-new' : '';
      summaryHtml += `<tr style="border-bottom: 1px solid #eee;"><td style="padding: 6px; font-weight: bold; width: 40%;">${escapeHtml(attr)}:</td><td style="padding: 6px;" class="${className}">${escapeHtml(displayValue)}</td></tr>`;
    }
    
    summaryHtml += '</table></div>';
    
    summaryHtml += '</div></div>';
    
    // Update the summary container
    $('#history-summary-container').html(summaryHtml);
  } catch (err) {
    console.error('Error creating history summary:', err);
    $('#history-summary-container').html('<div style="color: red;">Error loading summary: ' + escapeHtml(err.message) + '</div>');
  }
}

/**
 * Update history change summary when a different row is selected
 */
function updateHistoryChangeSummary(fullState, selectedIndex) {
  createHistorySummaryView(fullState, selectedIndex);
}

/**
 * Format attribute values for display
 */
function formatAttributeValue(attr, value) {
  if (value === undefined || value === null) {
    return '-';
  }
  
  if (attr === 'dateModified' || attr === 'dateCreated') {
    if (typeof value === 'number') {
      return new Date(value).toLocaleString();
    }
    return String(value);
  }
  
  if (attr === 'size' || attr === 'filesizeBytes') {
    if (typeof value === 'number') {
      return formatBytes(value);
    }
    return String(value);
  }
  
  return String(value);
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Hide history modal
 */
function hideHistoryModal() {
  $('#history-modal').hide();
  // Destroy w2ui grid
  if (w2ui['history-grid']) {
    w2ui['history-grid'].destroy();
  }
}

/**
 * Switch between settings tabs
 */
function switchSettingsTab(tabName) {
  // Hide all tabs
  $('.settings-tab-content').hide();
  // Show selected tab with proper display mode
  const $tab = $(`#tab-${tabName}`);
  // For tabs that need flex layout (category, tag, hotkeys), use flex display
  if (tabName === 'category' || tabName === 'tag' || tabName === 'hotkeys') {
    $tab.css('display', 'flex');
    // Lazy-init: tags/hotkeys grids are initialized here (after the tab is
    // visible) rather than upfront, so w2ui always measures a real container
    // width and the 100% column renders correctly on first open.
    if (tabName === 'tag' && !initializedSettingsTabs.has('tag')) {
      initializedSettingsTabs.add('tag');
      initializeTagsGrid().then(() => initializeTagsForm()).then(() => setupTagResizableDivider());
    } else if (tabName === 'hotkeys' && !initializedSettingsTabs.has('hotkeys')) {
      initializedSettingsTabs.add('hotkeys');
      initializeHotkeysGrid().then(() => setupHotkeysResizableDivider());
    }
  } else {
    $tab.show();
  }
  
  // Update tab button styles
  $('.settings-tab-btn').each(function() {
    const btn = $(this);
    if (btn.data('tab') === tabName) {
      btn.css('border-bottom-color', '#2196F3').css('color', '#2196F3');
    } else {
      btn.css('border-bottom-color', 'transparent').css('color', '#666');
    }
  });
}

/**
 * Initialize Browser Settings form values
 */
async function initializeBrowserSettingsForm() {
  const settings = await window.electronAPI.getSettings();
  const homeDirectory = settings.home_directory || '';
  const notesFormat = settings.notes_format || 'Markdown';
  const hideDotDirectory = settings.hide_dot_directory || false;
  const recordHeight = settings.record_height || 30;
  const backgroundRefreshEnabled = settings.background_refresh_enabled || false;
  const backgroundRefreshInterval = settings.background_refresh_interval || 30;
  
  $('#browser-home-directory').val(homeDirectory);
  $('#browser-notes-format').val(notesFormat);
  $('#browser-hide-dot-directory').prop('checked', hideDotDirectory);
  $('#browser-record-height').val(recordHeight);
  $('#browser-background-refresh-enabled').prop('checked', backgroundRefreshEnabled);
  $('#browser-background-refresh-interval').val(backgroundRefreshInterval).prop('disabled', !backgroundRefreshEnabled);
  
  await updateHomeDirectoryWarning(homeDirectory);
  updateRecordHeightPreview();
  
  // Setup event listeners for browser settings
  setupBrowserSettingsEventListeners();
}

/**
 * Setup event listeners for browser settings
 */
function setupBrowserSettingsEventListeners() {
  // Toggle refresh interval input based on checkbox
  $('#browser-background-refresh-enabled').on('change', function() {
    $('#browser-background-refresh-interval').prop('disabled', !this.checked);
  });
  
  // Save all browser settings
  $('#btn-browser-save-all').on('click', saveBrowserSettings);
}

/**
 * Save all browser settings at once
 */
async function saveBrowserSettings() {
  try {
    const homeDirectory = ($('#browser-home-directory').val() || '').trim();
    const notesFormat = ($('#browser-notes-format').val() || 'Markdown').trim();
    const hideDotDirectory = $('#browser-hide-dot-directory').is(':checked');
    let recordHeight = parseInt($('#browser-record-height').val() || '30');
    const backgroundRefreshEnabled = $('#browser-background-refresh-enabled').is(':checked');
    let backgroundRefreshInterval = parseInt($('#browser-background-refresh-interval').val() || '30');
    
    // Validate record height range
    if (isNaN(recordHeight) || recordHeight < 20) {
      recordHeight = 20;
      $('#browser-record-height').val(recordHeight);
    } else if (recordHeight > 35) {
      recordHeight = 35;
      $('#browser-record-height').val(recordHeight);
    }
    
    // Validate background refresh interval range
    if (!backgroundRefreshEnabled) {
      backgroundRefreshInterval = 30; // Default when disabled
    } else if (isNaN(backgroundRefreshInterval) || backgroundRefreshInterval < 2) {
      backgroundRefreshInterval = 2;
      $('#browser-background-refresh-interval').val(backgroundRefreshInterval);
    } else if (backgroundRefreshInterval > 60) {
      backgroundRefreshInterval = 60;
      $('#browser-background-refresh-interval').val(backgroundRefreshInterval);
    }

    const settings = await window.electronAPI.getSettings();
    settings.home_directory = homeDirectory;
    settings.notes_format = notesFormat;
    settings.hide_dot_directory = hideDotDirectory;
    settings.record_height = recordHeight;
    settings.background_refresh_enabled = backgroundRefreshEnabled;
    settings.background_refresh_interval = backgroundRefreshInterval;

    const result = await window.electronAPI.saveSettings(settings);
    if (!result || result.success === false) {
      throw new Error(result?.error || 'Unable to save settings');
    }

    await updateHomeDirectoryWarning(homeDirectory);
    updateRecordHeightPreview();
    
    // Apply record height to all active grids
    applyRecordHeightToAllGrids(recordHeight);
    
    alert('All browser settings saved successfully');
    
    // Restart backend background refresh with updated settings
    window.electronAPI.startBackgroundRefresh(backgroundRefreshEnabled, backgroundRefreshInterval);
    
    // Refresh the current directory if hide dot directory changed
    if (hideDotDirectory) {
      const state = panelState[activePanelId];
      if (state && state.currentPath) {
        await navigateToDirectory(state.currentPath, activePanelId);
      }
    }
  } catch (err) {
    alert('Error saving browser settings: ' + err.message);
  }
}

/**
 * Show warning if configured home directory does not exist
 */
async function updateHomeDirectoryWarning(dirPath) {
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

/**
 * Update the preview grid to show the current recordHeight setting
 */
function updateRecordHeightPreview() {
  const recordHeight = parseInt($('#browser-record-height').val() || '30');
  
  // Destroy existing preview grid if it exists
  if (w2ui['preview-record-height-grid']) {
    w2ui['preview-record-height-grid'].destroy();
  }
  
  // Create sample data for preview
  const previewRecords = [
    { recid: 1, filename: 'example-file-1.pdf', size: '2.4 MB', modified: '2026-03-25' },
    { recid: 2, filename: 'project-folder', size: '--', modified: '2026-03-28' },
    { recid: 3, filename: 'document.txt', size: '45 KB', modified: '2026-03-20' },
    { recid: 4, filename: 'image.jpg', size: '1.8 MB', modified: '2026-03-15' },
    { recid: 5, filename: 'archive.zip', size: '156 MB', modified: '2026-03-10' }
  ];
  
  // Create preview grid
  $('#record-height-preview-grid').w2grid({
    name: 'preview-record-height-grid',
    columns: [
      { field: 'filename', text: 'Filename', size: '60%', resizable: true },
      { field: 'size', text: 'Size', size: '20%', resizable: true },
      { field: 'modified', text: 'Modified', size: '20%', resizable: true }
    ],
    records: previewRecords,
    recordHeight: recordHeight,
    show: {
      header: true,
      toolbar: false,
      footer: false
    }
  });
}

/**
 * Apply recordHeight to all active grids
 */
function applyRecordHeightToAllGrids(recordHeight) {
  for (let panelId = 1; panelId <= 4; panelId++) {
    const grid = panelState[panelId].w2uiGrid;
    if (grid) {
      grid.recordHeight = recordHeight;
      if (typeof grid.refresh === 'function') {
        grid.refresh();
      }
    }
  }
}

/**
 * Get the current recordHeight setting
 */
async function getRecordHeight() {
  const settings = await window.electronAPI.getSettings();
  return settings.record_height || 30;
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
        .click(function() {
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
        .click(async function() {
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
        navigateToDirectory(activeState.currentPath, activePanelId);
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

/**
 * Format bytes to human-readable size
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Generate w2ui context menu for grid right-click
 * Returns an array of menu item objects compatible with w2ui's contextMenu system
 * Uses flat format: each item is { id, text, icon } - not nested
 */
function generateW2UIContextMenu(selectedRecords, visiblePanelCount = visiblePanels) {
  const isMultiSelect = selectedRecords.length > 1;
  const directoryCount = selectedRecords.filter(r => r.isFolder).length;
  const fileCount = selectedRecords.filter(r => !r.isFolder).length;
  const orphanCount = selectedRecords.filter(r => r.orphan_id).length;
  console.log("Generating context menu - selected records:", {selectedRecords, isMultiSelect, directoryCount, fileCount, orphanCount});
  
  // Debug: log the orphan_id on each record
  if (orphanCount > 0) {
    selectedRecords.forEach((record, idx) => {
      console.log(`  Record ${idx}:`, {filename: record.filename, orphan_id: record.orphan_id, changeState: record.changeState, keys: Object.keys(record)});
    });
  }
  
  const addSeparator = (menu) =>{
    if (menu.length > 0 && !menu[menu.length - 1].id.startsWith('sep')) {
      menu.push({id: `sep${menu.length}`, text: '--'});
    }
  }

  // Store context for onMenuClick handler
  panelContextMenuState = {
    selectedRecords,
    isMultiSelect,
    directoryCount,
    fileCount,
    orphanCount,
    selectedPaths: selectedRecords.map(r => r.path)
  };
  
  // Determine available panels considering opening only one additional panel at a time
  const availablePanels = [];
  for (let i = 1; i <= Math.min(visiblePanelCount + 1, 4); i++) {
    availablePanels.push(i);
  }
  
  let contextMenu = [];

  if(!isMultiSelect && directoryCount > 0) {
    // Build "Open In Panel X" menu items for available panels
    contextMenu.push({
      id:"open-in",
      text: 'Open In',
      icon: 'fa fa-folder-open',
      items: availablePanels.map(panelNum => ({
        id: `open-in-${panelNum}`,
        text: `Panel ${panelNum}`,
        icon: 'fa fa-folder-open'
      }))
    });
    // Build "Set Category" menu items for each category
    let setCategoryOption = {
      id: 'set-category-label',
      text: 'Set Category',
      icon: 'fa fa-tag'
    };
    if (isMultiSelect) {
      setCategoryOption.text = 'Set Category (applies to all)';
    }
    // Add category items
    setCategoryOption.items = Object.keys(allCategories).map(categoryName => ({
      id: `set-category-${categoryName}`,
      text: categoryName,
      icon: 'fa fa-tag'
    }));;
    contextMenu.push(setCategoryOption);
  }

  // Add "Add to Favorites" for any selection with 1+ directories
  if (directoryCount > 0) {
    addSeparator(contextMenu);
    const label = directoryCount > 1 ? `Add ${directoryCount} folders to Favorites` : 'Add to Favorites';
    contextMenu.push({ id: 'add-to-favorites', text: label, icon: 'fa fa-star' });
  }

  // Add "Acknowledge & Remove" for orphaned files/folders
  if (orphanCount > 0) {
    addSeparator(contextMenu);
    const orphanRecords = selectedRecords.filter(r => r.orphan_id);
    if (isMultiSelect && orphanRecords.length > 0) {
      contextMenu.push({
        id: 'acknowledge-orphans',
        text: `Remove ${orphanRecords.length} orphaned item${orphanRecords.length > 1 ? 's' : ''}`,
        icon: 'fa fa-check-circle',
        orphanIds: orphanRecords.map(r => r.orphan_id)
      });
    } else if (!isMultiSelect && orphanRecords.length === 1) {
      contextMenu.push({
        id: `acknowledge-orphan-${orphanRecords[0].orphan_id}`,
        text: 'Acknowledge & Remove',
        icon: 'fa fa-check-circle'
      });
    }
  }

  // Add "History" section (only for single selection)
  if (!isMultiSelect) {
    addSeparator(contextMenu);
    contextMenu.push({id:"view-history", text: 'History', icon: 'fa fa-history'});
  }
  
  return contextMenu;
}

/**
 * Handle context menu item clicks
 * Routes menu clicks to appropriate handlers based on menu item ID
 */
async function handleContextMenuClick(event, panelId) {
  const menuItemId = event.detail.menuItem.id;
  const { selectedRecords, selectedPaths, isMultiSelect } = panelContextMenuState;
  
  console.log('Menu click:', menuItemId, 'Panel:', panelId);
  
  // Handle "Open In Panel X" clicks
  if (menuItemId.startsWith('open-in-')) {
    const targetPanel = parseInt(menuItemId.split('-')[2]);
    const firstPath = selectedPaths[0]; // Open first selected directory
    const $panel = $(`#panel-${targetPanel}`);
    
    try {
      // If target panel is not visible, make it visible
      if (targetPanel > visiblePanels) {
        visiblePanels = targetPanel;
        $panel.show();
        updatePanelLayout();
      }
      
      // Navigate to the directory in the target panel
      await navigateToDirectory(firstPath, targetPanel);
      
      // Hide landing page and show grid
      $panel.find('.panel-landing-page').hide();
      $panel.find('.panel-grid').show();
      
      // Force grid resize to fix column visibility
      const grid = panelState[targetPanel].w2uiGrid;
      if (grid && grid.resize) {
        grid.resize();
      }
      
      setActivePanelId(targetPanel);
    } catch (err) {
      alert('Error opening in panel: ' + err.message);
    }
  }
  
  // Handle "Set Category" clicks
  if (menuItemId.startsWith('set-category-') && menuItemId !== 'set-category-label') {
    const categoryName = menuItemId.replace('set-category-', '');
    console.log('Setting category:', categoryName);
    
    try {
      if (isMultiSelect) {
        // For multi-select, apply category to all selected directories
        const result = await window.electronAPI.assignCategoryToDirectories(selectedPaths, categoryName);
        if (!result.success) {
          alert('Error assigning category: ' + result.error);
        }
      } else {
        // Single-select: apply to the selected directory
        await window.electronAPI.assignCategoryToDirectory(selectedPaths[0], categoryName);
      }
      
      // Refresh the grid to show updated icons
      const state = panelState[activePanelId];
      await navigateToDirectory(state.currentPath, activePanelId);
    } catch (err) {
      alert('Error assigning category: ' + err.message);
    }
  }
  
  // Handle "View History" click
  if (menuItemId === 'view-history') {
    const selectedRecord = selectedRecords[0]; // Single selection only
    if (!selectedRecord) {
      alert('Please select a file or directory to view history');
      return;
    }
    
    try {
      // Open the history modal with the selected record
      await openHistoryModal(selectedRecord);
    } catch (err) {
      alert('Error opening history: ' + err.message);
    }
  }
  
  // Handle "Add to Favorites" click
  if (menuItemId === 'add-to-favorites') {
    const dirPaths = selectedRecords.filter(r => r.isFolder).map(r => r.path);
    for (const dirPath of dirPaths) {
      await addToFavorites(dirPath);
    }
  }

  // Handle "Acknowledge & Remove" for orphan items
  if (menuItemId.startsWith('acknowledge-orphan-')) {
    const orphanId = parseInt(menuItemId.replace('acknowledge-orphan-', ''));
    try {
      const result = await window.electronAPI.acknowledgeOrphan(orphanId);
      if (result.success) {
        // Refresh the current directory to remove the orphan from display
        const state = panelState[activePanelId];
        await navigateToDirectory(state.currentPath, activePanelId);
      } else {
        alert('Error removing orphan: ' + result.error);
      }
    } catch (err) {
      alert('Error removing orphan: ' + err.message);
    }
  }
  
  // Handle "Remove orphans" for multiple orphan selections
  if (menuItemId === 'acknowledge-orphans') {
    const orphanRecords = selectedRecords.filter(r => r.orphan_id);
    try {
      for (const record of orphanRecords) {
        const result = await window.electronAPI.acknowledgeOrphan(record.orphan_id);
        if (!result.success) {
          alert(`Error removing orphan ${record.filename}: ${result.error}`);
          break;
        }
      }
      // Refresh the current directory to remove the orphans from display
      const state = panelState[activePanelId];
      await navigateToDirectory(state.currentPath, activePanelId);
    } catch (err) {
      alert('Error removing orphans: ' + err.message);
    }
  }
  
  // Handle "Toggle Date Created" column visibility
  if (menuItemId === 'toggle-date-created') {
    const state = panelState[activePanelId];
    state.showDateCreated = !state.showDateCreated;
    
    // Reinitialize the grid with new column configuration
    await initializeGridForPanel(activePanelId);
    
    // Refresh the current directory to reload the grid with new columns
    await navigateToDirectory(state.currentPath, activePanelId);
  }
}

// ==================== Settings Modal & Categories Management ====================

// State for category form editing
let categoryFormState = {
  editingName: null
};

// State for tag form editing
let tagFormState = {
  editingName: null
};

// Tracks which settings tabs have had their grids initialized in the current modal session
let initializedSettingsTabs = new Set();

/**
 * Convert HEX color to RGB string format
 */
function hexToRgb(hex) {
  if (hex.startsWith('rgb')) return hex; // Already RGB
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return 'rgb(0, 0, 0)';
  const r = parseInt(result[1], 16);
  const g = parseInt(result[2], 16);
  const b = parseInt(result[3], 16);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Convert RGB string to HEX format
 */
function rgbToHex(rgb) {
  if (rgb.startsWith('#')) return rgb; // Already HEX
  const match = rgb.match(/rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
  if (!match) return '#000000';
  const r = parseInt(match[1]).toString(16).padStart(2, '0');
  const g = parseInt(match[2]).toString(16).padStart(2, '0');
  const b = parseInt(match[3]).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}

/**
 * Initialize w2ui grid for categories
 */
async function initializeCategoriesGrid() {
  const gridName = 'categories-grid';
  
  // Destroy existing grid if present
  if (w2ui && w2ui[gridName]) {
    w2ui[gridName].destroy();
  }

  // Get categories list from IPC
  const categoriesData = await window.electronAPI.getCategoriesList();
  
  // Build grid records from categories
  const records = categoriesData.map((cat, index) => ({
    recid: index,
    name: cat.name,
    description: cat.description || '',
    bgColor: cat.bgColor,
    textColor: cat.textColor,
    categoryName: cat.name,
    enableChecksum: cat.enableChecksum || false,
    iconUrl: null  // Will be populated before render
  }));

  // Generate all icons in parallel BEFORE creating grid
  try {
    const iconPromises = records.map(record =>
      window.electronAPI.generateFolderIcon(record.bgColor, record.textColor)
        .then(iconUrl => {
          if (iconUrl) {
            record.iconUrl = iconUrl;
            console.log(`Icon generated for "${record.name}"`);
          } else {
            console.warn(`Icon generation returned null for "${record.name}" with colors bg=${record.bgColor}, outline=${record.textColor}`);
          }
          return iconUrl;
        })
        .catch(err => {
          console.error(`Failed to generate icon for "${record.name}":`, err);
          return null;
        })
    );
    
    // Wait for ALL icons to generate before rendering grid
    await Promise.all(iconPromises);
    console.log('All icons generated, rendering grid');
  } catch (err) {
    console.error('Error generating icons:', err);
  }

  // Create w2grid instance with icons already in records
  w2ui[gridName] = new w2grid({
    name: gridName,
    show: {
      header: false,
      toolbar: false,
      footer: false
    },
    columns: [
      { field: 'icon', text: '', size: '40px', resizable: false, sortable: false, render: (record) => {
        if (record.iconUrl) {
          return `<div style="width: 30px; height: 20px; display: inline-flex; align-items: center; justify-content: center;"><img src="${record.iconUrl}" style="width: 20px; height: 20px; object-fit: contain;"></div>`;
        }
        // Fallback (shouldn't happen if all icons generated before render)
        return `<div style="width: 30px; height: 20px; background: ${record.bgColor}; border: 1px solid ${record.textColor}; border-radius: 3px;"></div>`;
      }},
      { field: 'name', text: 'Name', size: '100px', resizable: true, sortable: true },
      { field: 'description', text: 'Description', size: '100%', resizable: true, sortable: true }
    ],
    records: records,
    onClick: function(event) {
      event.onComplete = function() {
        const grid = this;
        const sel = grid.getSelection();
        if (sel.length > 0) {
          const recid = sel[0];
          const record = grid.records.find(r => r.recid === recid);
          if (record) {
            populateCategoryForm(record);
          }
        }
      };
    }
  });

  // Render grid in container (icons already present)
  w2ui[gridName].render('#categories-grid');
}

/**
 * Initialize form elements for category editing
 */
async function initializeCategoriesForm() {
  // Form is already rendered in HTML, just clear it for new entry
  clearCategoryForm();
}

/**
 * Populate form with category data when grid row is clicked
 */
function populateCategoryForm(record) {
  categoryFormState.editingName = record.categoryName;
  $('#form-cat-name').val(record.name);
  $('#form-cat-bgColor').val(rgbToHex(record.bgColor));
  $('#form-cat-textColor').val(rgbToHex(record.textColor));
  $('#form-cat-description').val(record.description || '');
  $('#form-cat-enableChecksum').prop('checked', record.enableChecksum || false);
}

/**
 * Clear category form and reset to new mode
 */
function clearCategoryForm() {
  categoryFormState.editingName = null;
  $('#form-cat-name').val('');
  $('#form-cat-bgColor').val('#efe4b0');
  $('#form-cat-textColor').val('#000000');
  $('#form-cat-description').val('');
  $('#form-cat-enableChecksum').prop('checked', false);
  
  // Clear grid selection
  const grid = w2ui['categories-grid'];
  if (grid) {
    grid.selectNone();
  }
}

/**
 * Update grid after category save (selective update, no grid destruction)
 * @param {object} updatedCategory - The category that was saved/updated
 * @param {boolean} isNew - Whether this is a new category or update
 * @param {string} oldName - The old category name (for renames), null if new
 */
async function updateGridAfterSave(updatedCategory, isNew = false, oldName = null) {
  const gridName = 'categories-grid';
  if (!w2ui || !w2ui[gridName]) {
    // Grid not initialized, reinitialize
    await initializeCategoriesGrid();
    return;
  }

  const grid = w2ui[gridName];
  
  try {
    // Generate icon for the updated category
    const iconUrl = await window.electronAPI.generateFolderIcon(
      updatedCategory.bgColor,
      updatedCategory.textColor
    );
    
    if (isNew) {
      // NEW CATEGORY: Add new record to grid
      const newRecid = Math.max(...grid.records.map(r => r.recid), -1) + 1;
      const newRecord = {
        recid: newRecid,
        name: updatedCategory.name,
        description: updatedCategory.description || '',
        bgColor: updatedCategory.bgColor,
        textColor: updatedCategory.textColor,
        categoryName: updatedCategory.name,
        enableChecksum: updatedCategory.enableChecksum || false,
        iconUrl: iconUrl
      };
      grid.add(newRecord);
      console.log(`Added new category "${updatedCategory.name}" to grid`);
    } else {
      // EXISTING CATEGORY: Find and update record
      const recordIndex = grid.records.findIndex(r => r.categoryName === oldName);
      if (recordIndex >= 0) {
        const record = grid.records[recordIndex];
        // Update all fields
        record.name = updatedCategory.name;
        record.description = updatedCategory.description || '';
        record.bgColor = updatedCategory.bgColor;
        record.textColor = updatedCategory.textColor;
        record.categoryName = updatedCategory.name;
        record.enableChecksum = updatedCategory.enableChecksum || false;
        record.iconUrl = iconUrl;
        
        grid.refreshRow(record.recid);
        console.log(`Updated category "${updatedCategory.name}" in grid`);
      }
    }
  } catch (err) {
    console.error('Error updating grid after save:', err);
    // Fallback: reinitialize entire grid if update fails
    await initializeCategoriesGrid();
  }
}

/**
 * Save category from form (create or update)
 */
async function saveCategoryFromForm() {
  const name = $('#form-cat-name').val().trim();
  const bgColorHex = $('#form-cat-bgColor').val();
  const textColorHex = $('#form-cat-textColor').val();
  const description = $('#form-cat-description').val().trim();

  if (!name) {
    alert('Please enter a category name');
    return;
  }

  try {
    // Convert HEX to RGB for storage
    const categoryData = {
      name: name,
      bgColor: hexToRgb(bgColorHex),
      textColor: hexToRgb(textColorHex),
      description: description,
      enableChecksum: $('#form-cat-enableChecksum').prop('checked')
    };

    const isNew = !categoryFormState.editingName;
    const oldName = categoryFormState.editingName;

    if (isNew) {
      // Create new category
      await window.electronAPI.saveCategory(categoryData);
    } else {
      // Update existing category
      categoryData.oldName = oldName;
      await window.electronAPI.updateCategory(oldName, categoryData);
    }

    // Update grid selectively instead of reinitializing
    await updateGridAfterSave(categoryData, isNew, oldName);
    clearCategoryForm();
    
    alert(isNew ? 'Category created successfully!' : 'Category updated successfully!');
  } catch (err) {
    alert('Error saving category: ' + err.message);
  }
}

/**
 * Delete category from form
 */
async function deleteCategoryFromForm() {
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
        const grid = w2ui['categories-grid'];
        const categoryToDelete = categoryFormState.editingName;
        
        await window.electronAPI.deleteCategory(categoryToDelete);
        
        // Remove from grid selectively if grid exists
        if (grid) {
          const recordIndex = grid.records.findIndex(r => r.categoryName === categoryToDelete);
          if (recordIndex >= 0) {
            grid.remove(grid.records[recordIndex].recid);
            console.log(`Removed category "${categoryToDelete}" from grid`);
          }
        }
        
        clearCategoryForm();
        alert('Category deleted successfully!');
      } catch (err) {
        alert('Error deleting category: ' + err.message);
      }
    })
}

// ==================== Tags Management ====================

/**
 * Initialize tags grid
 */
async function initializeTagsGrid() {
  const gridName = 'tags-grid';
  
  // Destroy existing grid if present
  if (w2ui && w2ui[gridName]) {
    w2ui[gridName].destroy();
  }

  // Get tags list from IPC
  const tagsData = await window.electronAPI.getTagsList();
  
  // Build grid records from tags
  const records = tagsData.map((tag, index) => ({
    recid: index,
    name: tag.name,
    description: tag.description || '',
    bgColor: tag.bgColor,
    textColor: tag.textColor,
    tagName: tag.name,
    iconUrl: null
  }));

  // Generate all icons in parallel BEFORE creating grid
  try {
    const iconPromises = records.map(record =>
      window.electronAPI.generateTagIcon(record.bgColor, record.textColor)
        .then(iconUrl => {
          if (iconUrl) {
            record.iconUrl = iconUrl;
            console.log(`Icon generated for tag "${record.name}"`);
          } else {
            console.warn(`Icon generation returned null for tag "${record.name}" with colors bg=${record.bgColor}, outline=${record.textColor}`);
          }
          return iconUrl;
        })
        .catch(err => {
          console.error(`Failed to generate icon for tag "${record.name}":`, err);
          return null;
        })
    );
    
    // Wait for ALL icons to generate before rendering grid
    await Promise.all(iconPromises);
    console.log('All tag icons generated, rendering grid');
  } catch (err) {
    console.error('Error generating tag icons:', err);
  }

  // Create w2grid instance with icons already in records
  w2ui[gridName] = new w2grid({
    name: gridName,
    show: {
      header: false,
      toolbar: false,
      footer: false
    },
    columns: [
      { field: 'icon', text: '', size: '40px', resizable: false, sortable: false, render: (record) => {
        if (record.iconUrl) {
          return `<div style="width: 30px; height: 20px; display: inline-flex; align-items: center; justify-content: center;"><img src="${record.iconUrl}" style="width: 20px; height: 20px; object-fit: contain;"></div>`;
        }
        return `<div style="width: 30px; height: 20px; background: ${record.bgColor}; border: 1px solid ${record.textColor}; border-radius: 3px;"></div>`;
      }},
      { field: 'name', text: 'Name', size: '100px', resizable: true, sortable: true },
      { field: 'description', text: 'Description', size: '100%', resizable: true, sortable: true }
    ],
    records: records,
    onClick: function(event) {
      event.onComplete = function() {
        const grid = this;
        const sel = grid.getSelection();
        if (sel.length > 0) {
          const recid = sel[0];
          const record = grid.records.find(r => r.recid === recid);
          if (record) {
            populateTagForm(record);
          }
        }
      };
    }
  });

  // Render grid in container
  w2ui[gridName].render('#tags-grid');
}

/**
 * Initialize hotkeys grid
 */

/**
 * Normalize a stored hotkey combo to PascalCase display form.
 * e.g. "ctrl+s" → "Ctrl+S", "alt+Left" → "Alt+Left", "ctrl+shift+f5" → "Ctrl+Shift+F5"
 */
function formatHotkeyDisplay(combo) {
  if (!combo) return '';
  return combo.split('+').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('+');
}

async function initializeHotkeysGrid() {
  const gridName = 'hotkeys-grid';
  
  // Destroy existing grid if present
  if (w2ui && w2ui[gridName]) {
    w2ui[gridName].destroy();
  }

  // Get hotkeys data
  const hotkeyData = await window.electronAPI.getHotkeys();
  
  // Build grid records from hotkeys - flatten the nested structure
  const records = [];
  let recid = 0;
  for (const [context, actions] of Object.entries(hotkeyData)) {
    for (const [actionId, actionData] of Object.entries(actions)) {
      records.push({
        recid: recid++,
        context: context,
        action: actionData.label,
        hotkey: actionData.key,
        actionId: actionId,
        defaultKey: actionData.default
      });
    }
  }

  // Create w2grid instance
  w2ui[gridName] = new w2grid({
    name: gridName,
    show: {
      header: false,
      toolbar: false,
      footer: false
    },
    columns: [
      { field: 'context', text: 'Context', size: '130px', resizable: true, sortable: true },
      { field: 'action', text: 'Action', size: '150px', resizable: true, sortable: true },
      { field: 'hotkey', text: 'Hotkey', size: '100%', resizable: true, sortable: false,
        render: (record) => formatHotkeyDisplay(record.hotkey) }
    ],
    records: records,
    onClick: function(event) {
      event.onComplete = function() {
        const grid = this;
        const sel = grid.getSelection();
        if (sel.length > 0) {
          const recid = sel[0];
          const record = grid.records.find(r => r.recid === recid);
          if (record) {
            populateHotkeysForm(record);
          }
        }
      };
    }
  });

  // Render grid in container
  w2ui[gridName].render('#hotkeys-grid')
  w2ui[gridName].selectNone();
  w2ui[gridName].refresh();
  w2ui[gridName].resize();
}

/**
 * Populate hotkeys form with selected hotkey data
 */
function populateHotkeysForm(record) {
  $('#form-hotkey-context').val(record.context);
  $('#form-hotkey-action').val(record.action);
  $('#form-hotkey-current').val(record.hotkey);
  
  // Store current record in form for later use
  $('#hotkeys-form').data('currentRecord', record);
  
  // Clear demo mode
  $('#hotkey-demo-section').hide();
  $('#form-hotkey-demo').val('');
  $('#btn-hotkey-demo').text('Edit').show();
  $('#btn-hotkey-save').hide();
}

/**
 * Initialize form elements for hotkeys editing
 */
async function initializeHotkeysForm() {
  // Nothing needed here - form is already in HTML and will be populated on grid selection
}

/**
 * Initialize form elements for tag editing
 */
async function initializeTagsForm() {
  // Form is already rendered in HTML, just clear it for new entry
  clearTagForm();
}

/**
 * Populate form with tag data when grid row is clicked
 */
function populateTagForm(record) {
  tagFormState.editingName = record.tagName;
  $('#form-tag-name').val(record.name);
  $('#form-tag-bgColor').val(rgbToHex(record.bgColor));
  $('#form-tag-textColor').val(rgbToHex(record.textColor));
  $('#form-tag-description').val(record.description || '');
}

/**
 * Clear tag form and reset to new mode
 */
function clearTagForm() {
  tagFormState.editingName = null;
  $('#form-tag-name').val('');
  $('#form-tag-bgColor').val('#efe4b0');
  $('#form-tag-textColor').val('#000000');
  $('#form-tag-description').val('');
  
  // Clear grid selection
  const grid = w2ui['tags-grid'];
  if (grid) {
    grid.selectNone();
  }
}

/**
 * Update grid after tag save (selective update)
 * @param {object} updatedTag - The tag that was saved/updated
 * @param {boolean} isNew - Whether this is a new tag or update
 * @param {string} oldName - The old tag name (for renames), null if new
 */
async function updateGridAfterTagSave(updatedTag, isNew = false, oldName = null) {
  const gridName = 'tags-grid';
  if (!w2ui || !w2ui[gridName]) {
    // Grid not initialized, reinitialize
    await initializeTagsGrid();
    return;
  }

  const grid = w2ui[gridName];
  
  try {
    // Generate icon for the updated tag
    const iconUrl = await window.electronAPI.generateFolderIcon(
      updatedTag.bgColor,
      updatedTag.textColor
    );
    
    if (isNew) {
      // NEW TAG: Add new record to grid
      const newRecid = Math.max(...grid.records.map(r => r.recid), -1) + 1;
      const newRecord = {
        recid: newRecid,
        name: updatedTag.name,
        description: updatedTag.description || '',
        bgColor: updatedTag.bgColor,
        textColor: updatedTag.textColor,
        tagName: updatedTag.name,
        iconUrl: iconUrl
      };
      grid.add(newRecord);
      console.log(`Added new tag "${updatedTag.name}" to grid`);
    } else {
      // EXISTING TAG: Find and update record
      const recordIndex = grid.records.findIndex(r => r.tagName === oldName);
      if (recordIndex >= 0) {
        const record = grid.records[recordIndex];
        record.name = updatedTag.name;
        record.description = updatedTag.description || '';
        record.bgColor = updatedTag.bgColor;
        record.textColor = updatedTag.textColor;
        record.tagName = updatedTag.name;
        record.iconUrl = iconUrl;
        
        grid.refreshRow(record.recid);
        console.log(`Updated tag "${updatedTag.name}" in grid`);
      }
    }
  } catch (err) {
    console.error('Error updating tag grid after save:', err);
    // Fallback: reinitialize entire grid if update fails
    await initializeTagsGrid();
  }
}

/**
 * Save tag from form (create or update)
 */
async function saveTagFromForm() {
  const name = $('#form-tag-name').val().trim();
  const bgColorHex = $('#form-tag-bgColor').val();
  const textColorHex = $('#form-tag-textColor').val();
  const description = $('#form-tag-description').val().trim();

  if (!name) {
    alert('Please enter a tag name');
    return;
  }

  try {
    // Convert HEX to RGB for storage
    const tagData = {
      name: name,
      bgColor: hexToRgb(bgColorHex),
      textColor: hexToRgb(textColorHex),
      description: description
    };

    const isNew = !tagFormState.editingName;
    const oldName = tagFormState.editingName;

    if (isNew) {
      // Create new tag
      await window.electronAPI.saveTag(tagData);
    } else {
      // Update existing tag
      tagData.oldName = oldName;
      await window.electronAPI.updateTag(oldName, tagData);
    }

    // Update grid selectively instead of reinitializing
    await updateGridAfterTagSave(tagData, isNew, oldName);
    clearTagForm();
    
    alert(isNew ? 'Tag created successfully!' : 'Tag updated successfully!');
  } catch (err) {
    alert('Error saving tag: ' + err.message);
  }
}

/**
 * Delete tag from form
 */
async function deleteTagFromForm() {
  if (!tagFormState.editingName) {
    alert('Please select a tag to delete');
    return;
  }

  w2confirm({
    msg: `Delete the "${tagFormState.editingName}" tag?<br><br>This action cannot be undone.`,
    title: 'Delete Tag',
    width: 400,
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
        const grid = w2ui['tags-grid'];
        const tagToDelete = tagFormState.editingName;
        
        await window.electronAPI.deleteTag(tagToDelete);
        
        // Remove from grid selectively if grid exists
        if (grid) {
          const recordIndex = grid.records.findIndex(r => r.tagName === tagToDelete);
          if (recordIndex >= 0) {
            grid.remove(grid.records[recordIndex].recid);
            console.log(`Removed tag "${tagToDelete}" from grid`);
          }
        }
        
        clearTagForm();
        alert('Tag deleted successfully!');
      } catch (err) {
        alert('Error deleting tag: ' + err.message);
      }
    })
}

/**
 * Enter demo mode for hotkey capture
 */
function enterHotkeyDemoMode() {
  const $demoSection = $('#hotkey-demo-section');
  const $demoInput = $('#form-hotkey-demo');
  const $editBtn = $('#btn-hotkey-demo');
  const $saveBtn = $('#btn-hotkey-save');
  
  // Show demo section and save button immediately
  $demoSection.show();
  $saveBtn.show();
  $demoInput.val('Press a key combination...').css('color', '#999').focus();
  $editBtn.text('Cancel').css('background', '#f44336');
  
  // Store to track if we're in edit mode
  let isCapturing = true;
  let capturedCombo = '';
  
  const keydownHandler = function(e) {
    if (!isCapturing) return;
    
    // Prevent default for modifier keys and special keys
    if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift') {
      return; // Don't prevent, just return - user is building a combo
    }
    
    e.preventDefault(); // Prevent default browser behavior for other keys
    
    const combo = getHotKeyCombo(e);
    capturedCombo = combo;
    
    // Display captured combo in real-time and update form data
    $demoInput.val(combo).css('color', '#333'); // Change text color back to normal when a key is pressed
    $('#hotkeys-form').data('capturedCombo', combo); // Update form data so Save button can find it
  };
  
  // Handle Cancel button click to exit edit mode
  const cancelHandler = function() {
    isCapturing = false;
    cancelHotkeyDemo();
    $(document).off('keydown.hotkeyDemo');
    $editBtn.off('click.hotkeyCancel');
  };
  
  $editBtn.on('click.hotkeyCancel', cancelHandler);
  
  // Attach key capture listener (only on keydown, not keyup)
  $(document).on('keydown.hotkeyDemo', keydownHandler);
  
  // Store captured combo in form data so Save button can use it
  $('#hotkeys-form').data('capturedCombo', capturedCombo);
}

/**
 * Cancel demo mode
 */
function cancelHotkeyDemo() {
  $('#hotkey-demo-section').hide();
  $('#form-hotkey-demo').val('');
  $('#btn-hotkey-demo').text('Edit').css('background', '#2196F3');
  $('#btn-hotkey-save').hide();
  $('#hotkeys-form').removeData('capturedCombo');
}

/**
 * Save hotkey from form
 */
async function saveHotkeyFromForm() {
  const record = $('#hotkeys-form').data('currentRecord');
  const capturedCombo = $('#hotkeys-form').data('capturedCombo');
  
  if (!record || !capturedCombo) {
    alert('No hotkey captured. Please use Edit mode to capture a new hotkey.');
    return;
  }
  
  try {
    // Get current hotkeys data
    const hotkeyData = await window.electronAPI.getHotkeys();
    
    // Check for duplicates within the same context
    const context = record.context;
    const newKey = capturedCombo;
    
    for (const [actionId, actionData] of Object.entries(hotkeyData[context])) {
      if (actionId !== record.actionId && actionData.key === newKey) {
        // Duplicate found - prompt user for override
        w2confirm({
          msg: `This hotkey is already assigned to "${actionData.label}" in the "${context}" context.<br><br>Do you want to override it?`,
          title: 'Hotkey Conflict',
          width: 420,
          height: 200,
          btn_yes: {
            text: 'Override',
            class: '',
            style: ''
          },
          btn_no: {
            text: 'Cancel',
            class: '',
            style: ''
          }
        }).yes(() => {
            // User confirmed override
            actionData.key = capturedCombo;
            hotkeyData[context][record.actionId].key = capturedCombo;
          })
          .no(() => {
            // User cancelled - don't continue
            throw new Error('Hotkey conflict - operation cancelled');
          });
        // Note: Execution continues immediately; the actual override will be determined by the response
        break;
      }
    }
    
    // Update the hotkey for this action
    hotkeyData[record.context][record.actionId].key = capturedCombo;
    
    // Save to backend
    const result = await window.electronAPI.saveHotkeys(hotkeyData);
    if (!result.success) {
      throw new Error(result.error || 'Failed to save hotkeys');
    }
    
    // Reload hotkey registry in memory
    await loadHotkeysFromStorage();
    
    // Update grid with new hotkey
    const grid = w2ui['hotkeys-grid'];
    if (grid) {
      const gridRecord = grid.records.find(r => r.actionId === record.actionId);
      if (gridRecord) {
        gridRecord.hotkey = capturedCombo;
        grid.refreshRow(gridRecord.recid);
      }
    }
    
    // Update form and clear capture
    $('#form-hotkey-current').val(capturedCombo);
    cancelHotkeyDemo();
    
    alert('Hotkey saved successfully!');
  } catch (err) {
    alert('Error saving hotkey: ' + err.message);
  }
}

/**
 * Reset hotkey to default
 */
async function resetHotkeyToDefault() {
  const record = $('#hotkeys-form').data('currentRecord');
  if (!record) {
    alert('Please select a hotkey to reset');
    return;
  }
  
  w2confirm({
    msg: `Reset "${record.action}" hotkey to ${record.defaultKey}?`,
    title: 'Reset Hotkey',
    width: 380,
    height: 160,
    btn_yes: {
      text: 'Reset',
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
        // Get current hotkeys data
        const hotkeyData = await window.electronAPI.getHotkeys();
        
        // Reset the hotkey for this action to its default
        hotkeyData[record.context][record.actionId].key = record.defaultKey;
        
        // Save to backend
        const result = await window.electronAPI.saveHotkeys(hotkeyData);
        if (!result.success) {
          throw new Error(result.error || 'Failed to save hotkeys');
        }
        
        // Reload hotkey registry in memory
        await loadHotkeysFromStorage();
        
        // Update grid
        const grid = w2ui['hotkeys-grid'];
        if (grid) {
          const gridRecord = grid.records.find(r => r.actionId === record.actionId);
          if (gridRecord) {
            gridRecord.hotkey = record.defaultKey;
            grid.refreshRow(gridRecord.recid);
          }
        }
        
        // Update form and clear any edit state
        record.hotkey = record.defaultKey;
        $('#form-hotkey-current').val(record.defaultKey);
        cancelHotkeyDemo();
        
        alert('Hotkey reset successfully!');
      } catch (err) {
        alert('Error resetting hotkey: ' + err.message);
      }
    });
}

// Initialize on document ready
console.log('Page loaded, waiting for jQuery...');
$(document).ready(function() {
  console.log('Document ready, starting initialization...');
  initialize();
});
