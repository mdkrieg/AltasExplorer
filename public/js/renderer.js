/**
 * BestExplorer Renderer Logic
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
  1: { currentPath: '', w2uiGrid: null, navigationHistory: [], navigationIndex: -1, currentCategory: null, selectMode: false },
  2: { currentPath: '', w2uiGrid: null, navigationHistory: [], navigationIndex: -1, currentCategory: null, selectMode: false },
  3: { currentPath: '', w2uiGrid: null, navigationHistory: [], navigationIndex: -1, currentCategory: null, selectMode: false },
  4: { currentPath: '', w2uiGrid: null, navigationHistory: [], navigationIndex: -1, currentCategory: null, selectMode: false }
};

let activePanelId = 1;
let allCategories = {};
let currentLayout = 1;
let notesEditMode = false;
let visiblePanels = 1;

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

    // Scan directory and populate files
    const scanResult = await window.electronAPI.scanDirectory(dirPath);
    console.log('Scan result:', scanResult);

    // Get category for this directory
    const category = await window.electronAPI.getCategoryForDirectory(dirPath);
    console.log('Category for directory:', category);
    state.currentCategory = category;

    // Update window icon if this is the active panel
    if (panelId === activePanelId && category) {
      await window.electronAPI.updateWindowIcon(category.name);
    }

    // Read directory to get folder structure
    const entries = await window.electronAPI.readDirectory(dirPath);
    console.log('Entries count:', entries ? entries.length : 0);

    // Populate file grid for this panel
    await populateFileGrid(entries, category, panelId);
  } catch (err) {
    console.error('Error navigating to directory:', err);
    alert('Error accessing directory: ' + err.message);
  }
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
      { field: 'dateModified', text: 'Date Modified', size: '150px', resizable: true, sortable: true }
    ],
    records: [],
    onClick: function(event) {
      // Single click handling for select mode
      if (panelState[panelId].selectMode && event.detail.recid) {
        const record = this.records[event.detail.recid - 1];
        if (record && record.isFolder) {
          setActivePanelId(panelId);
          navigateToDirectory(record.path, panelId);
        }
      }
    },
    onDblClick: function(event) {
      const record = this.records[event.detail.recid - 1];
      if (record && record.isFolder) {
        navigateToDirectory(record.path, panelId);
      }
    },
    onContextMenu: function(event) {
      if (event.detail.recid) {
        const record = this.records[event.detail.recid - 1];
        if (record && record.isFolder) {
          setActivePanelId(panelId);
          showFolderContextMenu(event.detail.originalEvent, record.path);
        }
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

  // Add folders first
  for (const folder of folders) {
    const category = await window.electronAPI.getCategoryForDirectory(folder.path);
    const iconUrl = await window.electronAPI.generateFolderIcon(category.bgColor, category.textColor);
    
    records.push({
      recid: recordId++,
      icon: `<img src="${iconUrl}" style="width: 20px; height: 20px; object-fit: contain;">`,
      filename: folder.filename,
      size: '-',
      dateModified: new Date(folder.dateModified).toLocaleDateString(),
      isFolder: true,
      path: folder.path
    });
  }

  // Then add files
  for (const file of files) {
    records.push({
      recid: recordId++,
      icon: '📄',
      filename: file.filename,
      size: formatBytes(file.size),
      dateModified: new Date(file.dateModified).toLocaleDateString(),
      isFolder: false,
      path: file.path
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
 * Build and show context menu for a folder
 */
async function showFolderContextMenu(event, folderPath) {
  event.preventDefault();

  console.log('Context menu triggered for:', folderPath);
  console.log('Available categories:', allCategories);

  const $menu = $('#context-menu');
  $menu.empty();

  // Build submenu items HTML
  let submenuHTML = '';
  for (const [name, category] of Object.entries(allCategories)) {
    submenuHTML += `<div class="category-item" data-category="${name}" style="padding: 8px 12px; cursor: pointer; user-select: none;">${name}</div>`;
  }

  // Create submenu div
  const $submenu = $(`
    <div class="submenu" style="
      position: fixed;
      background: white;
      border: 1px solid #ccc;
      border-radius: 4px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.2);
      min-width: 180px;
      display: none;
      z-index: 10001;
    ">
      ${submenuHTML}
    </div>
  `);

  // Add main "Set Category" item
  const $setCategory = $(`
    <div class="set-category-item" style="padding: 8px 12px; cursor: pointer; user-select: none; position: relative;">
      Set Category <span class="submenu-arrow" style="position: absolute; right: 8px;">▶</span>
    </div>
  `);

  $menu.append($setCategory);
  $menu.append($submenu);

  // Position the menu at cursor
  $menu.css({
    left: event.clientX + 'px',
    top: event.clientY + 'px',
    display: 'block'
  });

  // Function to position submenu relative to parent
  function positionSubmenu() {
    const offset = $setCategory.offset();
    const width = $setCategory.outerWidth();
    $submenu.css({
      top: offset.top + 'px',
      left: (offset.left + width + 4) + 'px'
    });
  }

  // Show submenu on hover
  $setCategory.on('mouseenter', function() {
    positionSubmenu();
    $submenu.stop(true, true).fadeIn(100);
  });

  // Hide submenu on leave (from both items)
  $setCategory.on('mouseleave', function() {
    $submenu.stop(true, true).fadeOut(100);
  });

  $submenu.on('mouseleave', function() {
    $submenu.stop(true, true).fadeOut(100);
  });

  // Keep submenu visible when hovering over it
  $submenu.on('mouseenter', function() {
    $submenu.stop(true, true).show();
  });

  // Add click handlers to category items
  $submenu.find('.category-item').on('click', async function(e) {
    e.stopPropagation();
    const categoryName = $(this).data('category');
    console.log('Selected category:', categoryName);
    try {
      await window.electronAPI.assignCategoryToDirectory(folderPath, categoryName);
      // Refresh the grid for active panel to show updated icon
      const state = panelState[activePanelId];
      await navigateToDirectory(state.currentPath, activePanelId);
    } catch (err) {
      alert('Error assigning category: ' + err.message);
    }
    $menu.hide();
  });

  // Close menu when clicking elsewhere
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
 * Show notes view for a panel
 */
async function showNotesView(panelId) {
  const notesPath = panelState[1].currentPath + '\\notes.txt';
  const $notesView = $(`#panel-${panelId} .panel-notes-view`);
  const $notesContent = $notesView.find('.notes-content');
  const $panelToolbar = $(`#panel-${panelId} > .w2ui-panel-title`);
  const $notesToolbar = $notesView.find('.w2ui-panel-title');
  
  try {
    // Try to read notes.txt
    const content = await window.electronAPI.readNotesFile(notesPath);
    $notesContent.val(content);
    $notesContent.prop('readonly', true);
    
    // Hide landing page and grid, show notes view
    $(`#panel-${panelId} .panel-landing-page`).hide();
    $(`#panel-${panelId} .panel-grid`).hide();
    $notesView.show();
    
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
    $notesContent.val('');
    $notesContent.prop('readonly', false);
    
    $(`#panel-${panelId} .panel-landing-page`).hide();
    $(`#panel-${panelId} .panel-grid`).hide();
    $notesView.show();
    
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
  const $notesContent = $notesView.find('.notes-content');
  const $panelToolbar = $(`#panel-${panelId} > .w2ui-panel-title`);
  const $notesToolbar = $notesView.find('.w2ui-panel-title');
  
  $notesContent.prop('readonly', true);
  $notesView.hide();
  $notesToolbar.hide();
  $panelToolbar.show();
  $(`#panel-${panelId} .panel-landing-page`).show();
  
  notesEditMode = false;
}

/**
 * Toggle edit mode for notes
 */
async function toggleNotesEditMode(panelId) {
  const $notesView = $(`#panel-${panelId} .panel-notes-view`);
  const $notesContent = $notesView.find('.notes-content');
  const $editBtn = $notesView.find('.btn-notes-edit');
  const $saveBtn = $notesView.find('.btn-notes-save');
  
  if ($notesContent.prop('readonly')) {
    // Enter edit mode
    $notesContent.prop('readonly', false);
    $notesContent.focus();
    $editBtn.hide();
    $saveBtn.show();
  } else {
    // Save and exit edit mode
    const content = $notesContent.val();
    const notesPath = panelState[1].currentPath + '\\notes.txt';
    
    try {
      await window.electronAPI.writeNotesFile(notesPath, content);
      $notesContent.prop('readonly', true);
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

  // Categories button (only for panel 1)
  if (panelId === 1) {
    $panel.find('.btn-panel-categories').click(function() {
      setActivePanelId(panelId);
      showCategoryModal();
    });
  }
  
  // Select button (panels 2-4 only)
  if (panelId > 1) {
    $panel.find('.btn-panel-select').click(function() {
      setActivePanelId(panelId);
      toggleSelectMode(panelId);
    });
    
    // Open as main button
    $panel.find('.btn-panel-open-main').click(function() {
      setActivePanelId(panelId);
      const state = panelState[panelId];
      if (state.currentPath) {
        navigateToDirectory(state.currentPath, 1);
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

  // Modal close button
  $('#btn-modal-close').click(function() {
    hideModal();
  });

  // Modal create category button
  $('#btn-modal-create-category').click(async function() {
    const name = $('#modal-cat-name').val().trim();
    const bgColor = $('#modal-cat-bg').val();
    const textColor = $('#modal-cat-text').val();
    const patternsStr = $('#modal-cat-patterns').val().trim();

    if (!name) {
      alert('Please enter a category name');
      return;
    }

    const patterns = patternsStr ? patternsStr.split(',').map(p => p.trim()) : [];

    try {
      await window.electronAPI.createCategory(name, `rgb${rgbToString(bgColor)}`, `rgb${rgbToString(textColor)}`, patterns);
      await loadCategories();

      // Clear form
      $('#modal-cat-name').val('');
      $('#modal-cat-patterns').val('');

      // Refresh categories list
      refreshCategoriesList();

      alert('Category created successfully!');
    } catch (err) {
      alert('Error creating category: ' + err.message);
    }
  });

  // Modal close on overlay click
  $('#category-modal').click(function(e) {
    if (e.target === this) {
      hideModal();
    }
  });
}

/**
 * Show category manager modal
 */
async function showCategoryModal() {
  $('#category-modal').show();
  await refreshCategoriesList();
}

/**
 * Hide category manager modal
 */
function hideModal() {
  $('#category-modal').hide();
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

// Initialize on document ready
console.log('Page loaded, waiting for jQuery...');
$(document).ready(function() {
  console.log('Document ready, starting initialization...');
  initialize();
});
