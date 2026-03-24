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

let currentPath = '';
let currentCategory = null;
let allCategories = {};
let fileGridData = [];
let navigationHistory = [];
let navigationIndex = -1;

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

    // Initialize w2ui grid
    await initializeGrid();

    // Get settings and navigate to home directory
    const settings = await window.electronAPI.getSettings();
    console.log('Settings loaded:', settings);
    
    const homePath = settings.home_directory;

    if (homePath) {
      await navigateToDirectory(homePath);
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
 * Navigate to a directory
 */
async function navigateToDirectory(dirPath, addToHistory = true) {
  try {
    console.log('Navigating to:', dirPath);
    currentPath = dirPath;
    // Update navigation history
    if (addToHistory) {
      navigationHistory = navigationHistory.slice(0, navigationIndex + 1);
      navigationHistory.push(dirPath);
      navigationIndex = navigationHistory.length - 1;
    }
    // Update current path display in title
    $('#current-path-title').text(dirPath);

    // Scan directory and populate files
    const scanResult = await window.electronAPI.scanDirectory(dirPath);
    console.log('Scan result:', scanResult);

    // Get category for this directory
    const category = await window.electronAPI.getCategoryForDirectory(dirPath);
    console.log('Category for directory:', category);
    currentCategory = category;

    // Update window icon
    if (category) {
      await window.electronAPI.updateWindowIcon(category.name);
    }

    // Read directory to get folder structure
    const entries = await window.electronAPI.readDirectory(dirPath);
    console.log('Entries count:', entries ? entries.length : 0);

    // Populate file grid (now with both folders and files)
    populateFileGrid(entries, category);
  } catch (err) {
    console.error('Error navigating to directory:', err);
    alert('Error accessing directory: ' + err.message);
  }
}

/**
 * Initialize w2ui grid
 */
async function initializeGrid() {
  if (w2ui && w2ui.grid) {
    w2ui.grid.destroy();
  }

  // Use w2grid constructor directly
  w2ui.grid = new w2grid({
    name: 'grid',
    show: {
      header: false,
      toolbar: false,
      footer: false
    },
    columns: [
      { field: 'icon', text: 'Icon', size: '40px', resizable: false, sortable: false },
      { field: 'filename', text: 'Name', size: '50%', resizable: true, sortable: true },
      { field: 'size', text: 'Size', size: '120px', resizable: true, sortable: true, align: 'right' },
      { field: 'dateModified', text: 'Date Modified', size: '150px', resizable: true, sortable: true }
    ],
    records: [],
    onDblClick: function(event) {
      const record = this.records[event.detail.recid - 1];
      if (record && record.isFolder) {
        navigateToDirectory(record.path);
      }
    },
    onContextMenu: function(event) {
      if (event.detail.recid) {
        const record = this.records[event.detail.recid - 1];
        if (record && record.isFolder) {
          showFolderContextMenu(event.detail.originalEvent, record.path);
        }
      }
    }
  });

  w2ui.grid.render('#grid');
}

/**
 * Populate the grid with files and folders
 */
async function populateFileGrid(entries, currentDirCategory) {
  fileGridData = entries;
  console.log('Populating grid with', entries.length, 'entries');

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

  // Update grid records
  w2ui.grid.records = records;
  w2ui.grid.refresh();
  console.log('Grid populated with', records.length, 'rows');
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
      // Refresh the grid to show updated icon
      await navigateToDirectory(currentPath);
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
 * Navigate to previous directory in history
 */
function navigateBack() {
  if (navigationIndex > 0) {
    navigationIndex--;
    navigateToDirectory(navigationHistory[navigationIndex], false);
  }
}

/**
 * Navigate to next directory in history
 */
function navigateForward() {
  if (navigationIndex < navigationHistory.length - 1) {
    navigationIndex++;
    navigateToDirectory(navigationHistory[navigationIndex], false);
  }
}

/**
 * Attach event listeners to buttons and grid
 */
function attachEventListeners() {
  // Keyboard shortcuts for Back/Forward
  $(document).keydown(function(event) {
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
  });

  // Parent folder button
  $('#btn-parent-folder').click(function() {
    if (currentPath && currentPath.length > 3) {
      const parentPath = currentPath.substring(0, currentPath.lastIndexOf('\\'));
      if (parentPath.length >= 2) {
        navigateToDirectory(parentPath);
      }
    }
  });

  // Refresh button
  $('#btn-refresh').click(function() {
    navigateToDirectory(currentPath);
  });

  // Categories button
  $('#btn-categories').click(function() {
    showCategoryModal();
  });

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

      // Update current view if editing the current category
      if (currentCategory && currentCategory.name === name) {
        navigateToDirectory(currentPath);
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
