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
  1: { currentPath: '', w2uiGrid: null, navigationHistory: [], navigationIndex: -1, currentCategory: null, selectMode: false, checksumQueue: null, checksumQueueIndex: 0, checksumCancelled: false },
  2: { currentPath: '', w2uiGrid: null, navigationHistory: [], navigationIndex: -1, currentCategory: null, selectMode: false, checksumQueue: null, checksumQueueIndex: 0, checksumCancelled: false },
  3: { currentPath: '', w2uiGrid: null, navigationHistory: [], navigationIndex: -1, currentCategory: null, selectMode: false, checksumQueue: null, checksumQueueIndex: 0, checksumCancelled: false },
  4: { currentPath: '', w2uiGrid: null, navigationHistory: [], navigationIndex: -1, currentCategory: null, selectMode: false, checksumQueue: null, checksumQueueIndex: 0, checksumCancelled: false }
};

// Track directory selection from panel-1 for use in panels 2-4
let panel1SelectedDirectoryPath = null;
let panel1SelectedDirectoryName = null;

let activePanelId = 1;
let allCategories = {};
let currentLayout = 1;
let notesEditMode = false;
let visiblePanels = 1;
const MISSING_DIRECTORY_LABEL = '(DIRECTORY DOES NOT EXIST)';

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

    // Initialize grids for all panels
    await initializeAllGrids();

    // Get settings and navigate to home directory
    const settings = await window.electronAPI.getSettings();
    console.log('Settings loaded:', settings);
    
    const homePath = settings.home_directory;

    // Set initial layout to 1 panel
    switchLayout(1);

    if (homePath) {
      await navigateToDirectory(homePath, 1);
    }

    // Load categories
    await loadCategories();

    // Attach event listeners
    attachEventListeners();
    
    console.log('Initialization complete');
  } catch (err) {
    console.error('Error initializing app:', err);
    alert('Fatal error during initialization: ' + err.message);
  }
}

/**
 * Navigate to a directory in a specific panel
 */
async function navigateToDirectory(dirPath, panelId = activePanelId, addToHistory = true) {
  try {
    console.log(`Navigating panel ${panelId} to:`, dirPath);
    
    const state = panelState[panelId];
    state.currentPath = dirPath;
    
    // Update navigation history
    if (addToHistory) {
      state.navigationHistory = state.navigationHistory.slice(0, state.navigationIndex + 1);
      state.navigationHistory.push(dirPath);
      state.navigationIndex = state.navigationHistory.length - 1;
    }
    
    // Update panel path display
    const $panel = $(`#panel-${panelId}`);
    $panel.find('.panel-path').text(dirPath);

    // Handle non-existent paths without blocking user navigation history
    const directoryExists = await window.electronAPI.isDirectory(dirPath);
    if (!directoryExists) {
      state.currentCategory = null;
      setPanelPathValidity(panelId, false);
      showMissingDirectoryRecord(panelId);
      $panel.find('.w2ui-panel-title').show();
      return;
    }

    setPanelPathValidity(panelId, true);

    // Scan directory and populate files
    const scanResult = await window.electronAPI.scanDirectoryWithComparison(dirPath);
    console.log('Scan result:', scanResult);

    if (!scanResult.success) {
      throw new Error(scanResult.error || 'Failed to scan directory');
    }

    // Get category for this directory
    const category = await window.electronAPI.getCategoryForDirectory(dirPath);
    console.log('Category for directory:', category);
    state.currentCategory = category;

    // Update window icon if this is the active panel
    if (panelId === activePanelId && category) {
      await window.electronAPI.updateWindowIcon(category.name);
    }

    // Use entries from scan result (already has changeState metadata)
    const entries = scanResult.success ? scanResult.entries : [];
    console.log('Entries count:', entries ? entries.length : 0);

    // Populate file grid for this panel
    await populateFileGrid(entries, category, panelId);

    // Show the toolbar when displaying the grid (for all panels)
    $panel.find('.w2ui-panel-title').show();

    // Start async checksum calculation if category has it enabled
    if (category && category.enableChecksum) {
      // Collect files that need checksum calculation
      const grid = panelState[panelId].w2uiGrid;
      const filesToChecksum = grid.records.filter(r => 
        !r.isFolder && r.changeState === 'checksumPending'
      );
      
      if (filesToChecksum.length > 0) {
        console.log(`Starting checksum calculation for ${filesToChecksum.length} files`);
        startChecksumQueue(filesToChecksum, panelId, dirPath);
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
 * Initialize w2ui grid for a specific panel
 */
async function initializeGridForPanel(panelId) {
  const gridName = `grid-panel-${panelId}`;
  
  // Destroy existing grid if present
  if (w2ui && w2ui[gridName]) {
    w2ui[gridName].destroy();
  }

  // Use w2grid constructor directly
  w2ui[gridName] = new w2grid({
    name: gridName,
    show: {
      header: false,
      toolbar: false,
      footer: false
    },
    columns: [
      { field: 'icon', text: '', size: '40px', resizable: false, sortable: false },
      { field: 'filename', text: 'Name', size: '50%', resizable: true, sortable: true },
      { field: 'size', text: 'Size', size: '120px', resizable: true, sortable: true, align: 'right' },
      { field: 'dateModified', text: 'Date Modified', size: '150px', resizable: true, sortable: true },
      { field: 'checksum', text: 'Checksum', size: '150px', resizable: true, sortable: false }
    ],
    records: [],
    onClick: function(event) {
      // For panel-1, detect directory selection for use by panels 2-4
      if (panelId === 1 && event.detail.recid) {
        const record = this.records[event.detail.recid - 1];
        if (record) {
          if (record.isFolder) {
            // Select this directory for panels 2-4 to use
            handlePanel1DirectorySelection(record.path, record.filename);
          } else {
            // If a file is selected, reset the button state
            panel1SelectedDirectoryPath = null;
            panel1SelectedDirectoryName = null;
            updatePanelSelectButtons();
          }
          // Let w2ui handle the row highlighting naturally
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
      
      // Check if this is a dateModified cell double-click for a file with date modification
      if (record && !record.isFolder && record.changeState === 'dateModified') {
        const columnIndex = event.detail.column;
        const columns = ['icon', 'filename', 'size', 'dateModified', 'checksum'];
        const columnField = columns[columnIndex];
        
        if (columnField === 'dateModified') {
          const inode = record.inode;
          acknowledgeFileModification(inode, panelId);
        }
      }
    },
    onContextMenu: function(event) {
      if (event.detail.recid) {
        setActivePanelId(panelId);
        
        // Get all selected records
        const selectedRecIds = this.getSelection();
        const selectedRecords = selectedRecIds.map(recid => this.records[recid - 1]).filter(r => r && r.isFolder);
        
        // If no selected records or right-clicked item is not a folder, don't show menu
        if (selectedRecords.length === 0) {
          return;
        }
        
        // Generate context menu options based on selection
        const contextMenuOptions = generateContextMenuOptions(selectedRecords, visiblePanels);
        
        // Show context menu for all selected items (or just the right-clicked one if only one is selected)
        showFolderContextMenu(event.detail.originalEvent, selectedRecords, contextMenuOptions, panelId);
      }
    }
  });

  // Render grid in the panel's grid container
  const $gridContainer = $(`#panel-${panelId} .panel-grid`);
  w2ui[gridName].render($gridContainer[0]);
  
  // Store reference in panelState
  panelState[panelId].w2uiGrid = w2ui[gridName];
}

/**
 * Populate the grid with files and folders for a specific panel
 */
async function populateFileGrid(entries, currentDirCategory, panelId = activePanelId) {
  console.log(`Populating grid for panel ${panelId} with ${entries.length} entries`);

  const state = panelState[panelId];
  
  // Separate folders and files
  const folders = entries.filter(e => e.isDirectory);
  const files = entries.filter(e => !e.isDirectory);

  const records = [];
  let recordId = 1;

  // Helper function to apply CSS class to cell content
  function applyClass(content, className) {
    if (!className) return content;
    return `<div class="${className}">${content}</div>`;
  }

  // Add folders first
  for (const folder of folders) {
    const category = await window.electronAPI.getCategoryForDirectory(folder.path);
    const iconUrl = await window.electronAPI.generateFolderIcon(category.bgColor, category.textColor);
    
    // Use the same getRowClassName function for consistency with files
    const className = getRowClassName(folder.changeState);
    
    records.push({
      recid: recordId++,
      icon: applyClass(`<img src="${iconUrl}" style="width: 20px; height: 20px; object-fit: contain;">`, className),
      filename: applyClass(folder.filename, className),
      size: applyClass('-', className),
      dateModified: applyClass(new Date(folder.dateModified).toLocaleDateString(), className),
      checksum: applyClass('—', className),
      isFolder: true,
      path: folder.path,
      changeState: folder.changeState,
      inode: folder.inode,
      dir_id: null // Will be set from DB if needed
    });
  }

  // Then add files
  for (const file of files) {
    const className = getRowClassName(file.changeState);
    const dateModifiedContent = getDateModifiedCell(file, file.changeState);
    const checksumCell = getChecksumCell(file, file.changeState);
    
    records.push({
      recid: recordId++,
      icon: applyClass('📄', className),
      filename: applyClass(file.filename, className),
      size: applyClass(formatBytes(file.size), className),
      dateModified: dateModifiedContent,
      dateModifiedRaw: file.dateModified, // Store raw timestamp for acknowledgment
      checksum: checksumCell,
      checksumStatus: null, // Will store 'pending', 'calculated', 'error'
      checksumValue: null, // Will store the actual hash
      isFolder: false,
      path: file.path,
      changeState: file.changeState,
      inode: file.inode,
      dir_id: null // Will be set from DB if needed
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
 * Get CSS class name for a file row based on change state
 */
function getRowClassName(changeState) {
  switch (changeState) {
    case 'new':
      return 'file-new';
    case 'checksumChanged':
      return 'file-checksum-changed';
    default:
      return '';
  }
}

/**
 * Get formatted date modified cell with appropriate styling
 */
function getDateModifiedCell(file, changeState) {
  const dateStr = new Date(file.dateModified).toLocaleDateString();
  
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
  
  // Show checksum value if available (checksumValue should be set after calculation)
  // For now, show dash as placeholder - will be updated by calculateChecksumForFile
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
      null // dir_id not needed in renderer
    );

    if (result.success) {
      // Update record with checksum data
      record.checksumStatus = 'calculated';
      record.checksumValue = result.checksum; // Store the full hash
      // Display first 12 characters of hash as a short representation
      const shortHash = result.checksum ? result.checksum.substring(0, 12) + '...' : '—';
      record.checksum = `<span title="${result.checksum || ''}" style="cursor: help;">${shortHash}</span>`;
      
      // Update record's changeState based on comparison result
      record.changeState = 'checksumChanged';
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
 * Build and show context menu for selected folder(s)
 * @param {Event} event - The right-click event
 * @param {Array} selectedRecords - Array of selected record objects (folders only)
 * @param {Object} contextMenuOptions - Options generated by generateContextMenuOptions()
 * @param {Number} panelId - The ID of the panel where context menu was triggered
 */
async function showFolderContextMenu(event, selectedRecords, contextMenuOptions, panelId) {
  event.preventDefault();

  const isMultiSelect = selectedRecords.length > 1;
  const selectedPaths = selectedRecords.map(r => r.path);
  
  console.log('Context menu triggered for:', selectedPaths);
  console.log('Multi-select:', isMultiSelect);
  console.log('Available categories:', allCategories);

  const $menu = $('#context-menu');
  $menu.empty();

  // ==================== Open In Submenu ====================
  let openInMenuHTML = '';
  for (const panel of contextMenuOptions.availablePanels) {
    openInMenuHTML += `<div class="open-in-item" data-panel="${panel}" style="padding: 8px 12px; cursor: pointer; user-select: none;">Panel ${panel}</div>`;
  }

  const $openInSubmenu = $(`
    <div class="open-in-submenu" style="
      position: fixed;
      background: white;
      border: 1px solid #ccc;
      border-radius: 4px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.2);
      min-width: 120px;
      display: none;
      z-index: 10001;
    ">
      ${openInMenuHTML}
    </div>
  `);

  const $openIn = $(`
    <div class="open-in-item" style="padding: 8px 12px; cursor: pointer; user-select: none; position: relative;">
      Open In <span class="submenu-arrow" style="position: absolute; right: 8px;">▶</span>
    </div>
  `);

  // ==================== Set Category Submenu ====================
  let categoryMenuHTML = '';
  for (const [name, category] of Object.entries(allCategories)) {
    categoryMenuHTML += `<div class="category-item" data-category="${name}" style="padding: 8px 12px; cursor: pointer; user-select: none;">${name}</div>`;
  }

  const $setCategorySubmenu = $(`
    <div class="set-category-submenu" style="
      position: fixed;
      background: white;
      border: 1px solid #ccc;
      border-radius: 4px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.2);
      min-width: 180px;
      display: none;
      z-index: 10001;
    ">
      ${categoryMenuHTML}
    </div>
  `);

  const setCategoryText = isMultiSelect ? 'Set Category (applies to all)' : 'Set Category';
  const $setCategory = $(`
    <div class="set-category-item" style="padding: 8px 12px; cursor: pointer; user-select: none; position: relative;">
      ${setCategoryText} <span class="submenu-arrow" style="position: absolute; right: 8px;">▶</span>
    </div>
  `);

  // ==================== Assemble Menu ====================
  $menu.append($openIn);
  $menu.append($openInSubmenu);
  $menu.append($setCategory);
  $menu.append($setCategorySubmenu);

  // Position the menu at cursor
  $menu.css({
    left: event.clientX + 'px',
    top: event.clientY + 'px',
    display: 'block'
  });

  // ==================== Helper: Position submenu relative to parent menu item ====================
  function positionSubmenu($menuItem, $submenu) {
    const offset = $menuItem.offset();
    const width = $menuItem.outerWidth();
    $submenu.css({
      top: offset.top + 'px',
      left: (offset.left + width + 4) + 'px'
    });
  }

  // ==================== Open In Submenu Handlers ====================
  $openIn.on('mouseenter', function() {
    positionSubmenu($openIn, $openInSubmenu);
    $openInSubmenu.stop(true, true).fadeIn(100);
  });

  $openIn.on('mouseleave', function() {
    $openInSubmenu.stop(true, true).fadeOut(100);
  });

  $openInSubmenu.on('mouseenter', function() {
    $openInSubmenu.stop(true, true).show();
  });

  $openInSubmenu.on('mouseleave', function() {
    $openInSubmenu.stop(true, true).fadeOut(100);
  });

  // Open In click handler
  $openInSubmenu.find('.open-in-item').on('click', async function(e) {
    e.stopPropagation();
    const targetPanel = parseInt($(this).data('panel'));
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
    $menu.hide();
  });

  // ==================== Set Category Submenu Handlers ====================
  $setCategory.on('mouseenter', function() {
    positionSubmenu($setCategory, $setCategorySubmenu);
    $setCategorySubmenu.stop(true, true).fadeIn(100);
  });

  $setCategory.on('mouseleave', function() {
    $setCategorySubmenu.stop(true, true).fadeOut(100);
  });

  $setCategorySubmenu.on('mouseenter', function() {
    $setCategorySubmenu.stop(true, true).show();
  });

  $setCategorySubmenu.on('mouseleave', function() {
    $setCategorySubmenu.stop(true, true).fadeOut(100);
  });

  // Set Category click handler
  $setCategorySubmenu.find('.category-item').on('click', async function(e) {
    e.stopPropagation();
    const categoryName = $(this).data('category');
    console.log('Selected category:', categoryName);
    
    try {
      if (isMultiSelect) {
        // For multi-select, apply category to all selected directories
        // The backend will skip files if mixed selection
        const result = await window.electronAPI.assignCategoryToDirectories(selectedPaths, categoryName);
        if (!result.success) {
          alert('Error assigning category: ' + result.error);
        }
      } else {
        // Single-select: apply to the selected directory
        await window.electronAPI.assignCategoryToDirectory(selectedPaths[0], categoryName);
      }
      
      // Refresh the grid for active panel to show updated icons
      const state = panelState[activePanelId];
      await navigateToDirectory(state.currentPath, activePanelId);
    } catch (err) {
      alert('Error assigning category: ' + err.message);
    }
    $menu.hide();
  });

  // ==================== Close menu when clicking elsewhere ====================
  $(document).one('click', function() {
    $menu.hide();
  });
}

/**
 * Set which panel is currently active
 */
function setActivePanelId(panelId) {
  if (panelId >= 1 && panelId <= 4) {
    activePanelId = panelId;
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
  }, 100);
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
 * Show notes view for a panel
 */
async function showNotesView(panelId) {
  const notesPath = panelState[1].currentPath + '\\notes.txt';
  const $notesView = $(`#panel-${panelId} .panel-notes-view`);
  const $notesContentEdit = $notesView.find('.notes-content-edit');
  const $notesContentView = $notesView.find('.notes-content-view');
  const $panelToolbar = $(`#panel-${panelId} > .w2ui-panel-title`);
  const $notesToolbar = $notesView.find('.w2ui-panel-title');
  
  try {
    // Try to read notes.txt
    const content = await window.electronAPI.readNotesFile(notesPath);
    $notesContentEdit.val(content);
    
    // Render markdown to HTML
    const htmlContent = await window.electronAPI.renderMarkdown(content);
    $notesContentView.html(htmlContent);
    
    // Hide landing page and grid, show notes view
    $(`#panel-${panelId} .panel-landing-page`).hide();
    $(`#panel-${panelId} .panel-grid`).hide();
    $notesView.show();
    
    // Show view mode by default, hide edit mode
    $notesContentView.show();
    $notesContentEdit.hide();
    
    // Update toolbar with notes path
    $notesToolbar.find('.notes-path').text(notesPath);
    $notesToolbar.show();
    $panelToolbar.hide();
    
    // Reset buttons
    $notesToolbar.find('.btn-notes-edit').show().text('Edit').css('background', '#2196F3');
    $notesToolbar.find('.btn-notes-save').hide();
    
    notesEditMode = false;
  } catch (err) {
    // File doesn't exist, create empty notes
    $notesContentEdit.val('');
    $notesContentView.html('');
    
    $(`#panel-${panelId} .panel-landing-page`).hide();
    $(`#panel-${panelId} .panel-grid`).hide();
    $notesView.show();
    
    // Start in edit mode for new file
    $notesContentEdit.show();
    $notesContentView.hide();
    
    // Update toolbar with notes path
    $notesToolbar.find('.notes-path').text(notesPath);
    $notesToolbar.show();
    $panelToolbar.hide();
    
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
  const $notesContentEdit = $notesView.find('.notes-content-edit');
  const $notesContentView = $notesView.find('.notes-content-view');
  const $panelToolbar = $(`#panel-${panelId} > .w2ui-panel-title`);
  const $notesToolbar = $notesView.find('.w2ui-panel-title');
  
  $notesView.hide();
  $notesToolbar.hide();
  $notesContentEdit.hide();
  $notesContentView.hide();
  $panelToolbar.show();
  $(`#panel-${panelId} .panel-landing-page`).show();
  
  notesEditMode = false;
}

/**
 * Toggle edit mode for notes
 */
async function toggleNotesEditMode(panelId) {
  const $notesView = $(`#panel-${panelId} .panel-notes-view`);
  const $notesContentEdit = $notesView.find('.notes-content-edit');
  const $notesContentView = $notesView.find('.notes-content-view');
  const $editBtn = $notesView.find('.btn-notes-edit');
  const $saveBtn = $notesView.find('.btn-notes-save');
  
  if (notesEditMode === false) {
    // Enter edit mode
    $notesContentView.hide();
    $notesContentEdit.show().focus();
    $editBtn.hide();
    $saveBtn.show();
    notesEditMode = true;
  } else {
    // Save and exit edit mode
    const content = $notesContentEdit.val();
    const notesPath = panelState[1].currentPath + '\\notes.txt';
    
    try {
      await window.electronAPI.writeNotesFile(notesPath, content);
      
      // Render markdown to HTML and show view
      const htmlContent = await window.electronAPI.renderMarkdown(content);
      $notesContentView.html(htmlContent);
      $notesContentEdit.hide();
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
}

/**
 * Remove a panel and shift higher-numbered panels down
 */
function removePanel(panelId) {
  if (panelId === 1 || visiblePanels === 1) {
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
    selectMode: false
  };
  
  // Hide the toolbar when clearing panel state
  const $panel = $(`#panel-${panelId}`);
  $panel.find('.w2ui-panel-title').hide();
  setPanelPathValidity(panelId, true);
  $panel.find('.panel-landing-page').show();
  $panel.find('.panel-grid').hide();
  $panel.find('.panel-notes-view').hide();
}

/**
 * Attach event listeners to a specific panel (with proper closure)
 */
function attachPanelEventListeners(panelId) {
  const $panel = $(`#panel-${panelId}`);
  
  // Set active panel when clicking on title
  $panel.find('.w2ui-panel-title').click(function() {
    setActivePanelId(panelId);
  });
  
  // Parent folder button
  $panel.find('.btn-panel-parent').click(function() {
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
  $panel.find('.btn-panel-refresh').click(function() {
    setActivePanelId(panelId);
    navigateToDirectory(panelState[panelId].currentPath, panelId);
  });

  // Settings button (only for panel 1)
  if (panelId === 1) {
    $panel.find('.btn-panel-settings').click(function() {
      setActivePanelId(panelId);
      showSettingsModal();
    });
  }
  
  // Select button (panels 2-4 only)
  if (panelId > 1) {
    $panel.find('.btn-panel-select').click(function() {
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
    $panel.find('.btn-panel-notes').click(async function() {
      await showNotesView(panelId);
    });
    
    // Notes edit button
    $panel.find('.btn-notes-edit').click(async function() {
      await toggleNotesEditMode(panelId);
    });
    
    // Notes save button
    $panel.find('.btn-notes-save').click(async function() {
      await toggleNotesEditMode(panelId);
    });
    
    // Notes back button
    $panel.find('.btn-notes-back').click(function() {
      hideNotesView(panelId);
    });
    
    // Panel remove button (panels 2-4 only)
    $panel.find('.btn-panel-remove').click(function() {
      removePanel(panelId);
    });
  }
}

/**
 * Attach event listeners to buttons and grid
 */
function attachEventListeners() {
  // Keyboard shortcuts for Back/Forward
  $(document).keydown(async function(event) {
    // Alt+Left for back
    if (event.altKey && event.key === 'ArrowLeft') {
      event.preventDefault();
      navigateBack();
    }
    // Alt+Right for forward
    if (event.altKey && event.key === 'ArrowRight') {
      event.preventDefault();
      navigateForward();
    }
    // Alt+Up for parent directory
    if (event.altKey && event.key === 'ArrowUp') {
      event.preventDefault();
      const state = panelState[activePanelId];
      if (state.currentPath && state.currentPath.length > 3) {
        const parentPath = state.currentPath.substring(0, state.currentPath.lastIndexOf('\\'));
        if (parentPath.length >= 2) {
          navigateToDirectory(parentPath, activePanelId);
        }
      }
    }
    // F2 to begin edit mode in notes
    if (event.key === 'F2') {
      const $notesView = $(`#panel-${activePanelId} .panel-notes-view`);
      if ($notesView.is(':visible')) {
        event.preventDefault();
        const $notesContent = $notesView.find('.notes-content');
        if ($notesContent.prop('readonly')) {
          await toggleNotesEditMode(activePanelId);
        }
      }
    }
    // Ctrl+Enter to save in notes edit mode
    if (event.ctrlKey && event.key === 'Enter') {
      const $notesView = $(`#panel-${activePanelId} .panel-notes-view`);
      if ($notesView.is(':visible')) {
        const $notesContent = $notesView.find('.notes-content');
        if (!$notesContent.prop('readonly')) {
          event.preventDefault();
          await toggleNotesEditMode(activePanelId);
        }
      }
    }
  });

  // View button - show layout modal
  $('#btn-view').click(function() {
    showLayoutModal();
  });

  // Add panel button
  $('#btn-add-panel').click(function() {
    if (visiblePanels < 4) {
      visiblePanels++;
      $(`#panel-${visiblePanels}`).show();
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

  // Browser settings: save home directory
  $('#btn-browser-save-home').click(async function() {
    await saveHomeDirectoryFromBrowserSettings();
  });

  // Browser settings: validate directory while typing
  $('#browser-home-directory').on('input', async function() {
    await updateHomeDirectoryWarning($(this).val());
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
 * Show settings modal
 */
async function showSettingsModal() {
  // Initialize grid and form
  await initializeCategoriesGrid();
  await initializeCategoriesForm();
  await initializeBrowserSettingsForm();
  
  // Setup resizable divider
  setupResizableDivider();
  
  // Show modal
  $('#settings-modal').show();
  
  // Ensure Category Settings tab is active
  switchSettingsTab('category');
}

/**
 * Hide settings modal
 */
function hideSettingsModal() {
  $('#settings-modal').hide();
  // Destroy w2ui grid
  if (w2ui['categories-grid']) {
    w2ui['categories-grid'].destroy();
  }
}

/**
 * Switch between settings tabs
 */
function switchSettingsTab(tabName) {
  // Hide all tabs
  $('.settings-tab-content').hide();
  // Show selected tab
  $(`#tab-${tabName}`).show();
  
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
  $('#browser-home-directory').val(homeDirectory);
  await updateHomeDirectoryWarning(homeDirectory);
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
 * Save home directory setting from Browser Settings tab
 */
async function saveHomeDirectoryFromBrowserSettings() {
  const homeDirectory = ($('#browser-home-directory').val() || '').trim();

  try {
    const settings = await window.electronAPI.getSettings();
    settings.home_directory = homeDirectory;

    const result = await window.electronAPI.saveSettings(settings);
    if (!result || result.success === false) {
      throw new Error(result?.error || 'Unable to save settings');
    }

    await updateHomeDirectoryWarning(homeDirectory);
    alert('Home directory saved');
  } catch (err) {
    alert('Error saving home directory: ' + err.message);
  }
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
          if (confirm(`Delete category "${name}"?`)) {
            try {
              await window.electronAPI.deleteCategory(name);
              await loadCategories();
              await refreshCategoriesList();
            } catch (err) {
              alert('Error deleting category: ' + err.message);
            }
          }
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
 * Generate context menu options based on selected records and visible panels
 * Returns an object describing what menu items should be available
 */
function generateContextMenuOptions(selectedRecords, visiblePanelCount = visiblePanels) {
  const isMultiSelect = selectedRecords.length > 1;
  const hasDirectories = selectedRecords.some(record => record.isFolder);
  const hasFiles = selectedRecords.some(record => !record.isFolder);
  
  // Available panels: current visible panels plus one more if not at max (4)
  const availablePanels = [];
  for (let i = 1; i <= Math.min(visiblePanelCount + 1, 4); i++) {
    availablePanels.push(i);
  }
  
  return {
    isMultiSelect,
    hasDirectories,
    hasFiles,
    availablePanels,
    // Can apply bulk operations to directories in multi-select
    canApplyBulkOps: hasDirectories
  };
}

// ==================== Settings Modal & Categories Management ====================

// State for category form editing
let categoryFormState = {
  editingName: null
};

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

  if (!confirm(`Are you sure you want to delete the "${categoryFormState.editingName}" category?`)) {
    return;
  }

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
}

// Initialize on document ready
console.log('Page loaded, waiting for jQuery...');
$(document).ready(function() {
  console.log('Document ready, starting initialization...');
  initialize();
});
