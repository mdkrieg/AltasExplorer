const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('path');
const os = require('os');

// Import service modules
const db = require('../src/db');
const fs = require('../src/filesystem');
const categories = require('../src/categories');
const icons = require('../src/icons');
const checksum = require('../src/checksum');

let mainWindow;

/**
 * Create the main application window
 */
function createWindow() {
  try {
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      webPreferences: {
        preload: path.join(__dirname, '..', 'src', 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    // Hide the menu bar by default
    mainWindow.setAutoHideMenuBar(true);
    mainWindow.setMenuBarVisibility(false);

    const indexPath = path.join(__dirname, '..', 'public', 'index.html');
    console.log('Loading index from:', indexPath);
    mainWindow.loadFile(indexPath);

    mainWindow.webContents.on('crashed', () => {
      console.error('Renderer process crashed');
    });

    mainWindow.webContents.on('unresponsive', () => {
      console.warn('Renderer process became unresponsive');
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  } catch (err) {
    console.error('Error creating window:', err);
    app.quit();
  }
}

/**
 * Initialize the application
 */
function initialize() {
  db.initialize();
  
  // Load default window icon
  const defaultCategory = categories.getCategory('Default');
  if (defaultCategory) {
    updateWindowIcon(defaultCategory);
  }
}

/**
 * Update the main window icon based on category colors
 */
async function updateWindowIcon(category) {
  try {
    const iconBuffer = await icons.generateWindowIcon(category.bgColor, category.textColor);
    if (iconBuffer && mainWindow) {
      const nimg = nativeImage.createFromBuffer(iconBuffer);
      mainWindow.setIcon(nimg);
    }
  } catch (err) {
    console.error('Error updating window icon:', err);
  }
}

// ============================================
// IPC Handlers
// ============================================

/**
 * File system operations
 */
ipcMain.handle('read-directory', (event, dirPath) => {
  try {
    return fs.readDirectory(dirPath);
  } catch (err) {
    console.error('Error reading directory:', err);
    return [];
  }
});

/**
 * Database: Scan directory and upsert files
 */
ipcMain.handle('scan-directory', (event, dirPath) => {
  try {
    // Get directory inode to track the directory itself
    const dirStats = fs.getStats(dirPath);
    if (!dirStats) {
      return { success: false, error: 'Unable to read directory stats' };
    }

    const dirInode = dirStats.inode;

    // Get category for this directory
    const category = categories.getCategoryForDirectory(dirPath);
    const categoryName = category ? category.name : 'Default';

    // Create or get the directory entry (returns dir_id)
    const dirId = db.getOrCreateDirectory(dirPath, dirInode, categoryName);

    // Clear existing file entries for this directory
    db.clearDirectory(dirPath);

    // Read and upsert files
    const entries = fs.readDirectory(dirPath);
    for (const entry of entries) {
      if (!entry.isDirectory) { // Only index files
        db.upsertFile({
          inode: entry.inode,
          dir_id: dirId,
          filename: entry.filename,
          dateModified: entry.dateModified,
          dateCreated: entry.dateCreated,
          size: entry.size
        });
      }
    }

    return {
      success: true,
      count: entries.filter(e => !e.isDirectory).length,
      category: categoryName
    };
  } catch (err) {
    console.error('Error scanning directory:', err);
    return { success: false, error: err.message };
  }
});

/**
 * Database: Get files from a directory
 */
ipcMain.handle('get-files-in-directory', (event, dirPath) => {
  try {
    return db.getFilesInDirectory(dirPath);
  } catch (err) {
    console.error('Error getting files:', err);
    return [];
  }
});

/**
 * Categories: Load all categories
 */
ipcMain.handle('load-categories', () => {
  try {
    return categories.loadCategories();
  } catch (err) {
    console.error('Error loading categories:', err);
    return {};
  }
});

/**
 * Categories: Get single category
 */
ipcMain.handle('get-category', (event, name) => {
  try {
    return categories.getCategory(name);
  } catch (err) {
    console.error('Error getting category:', err);
    return null;
  }
});

/**
 * Categories: Create new category
 */
ipcMain.handle('create-category', (event, { name, bgColor, textColor, patterns }) => {
  try {
    return categories.createCategory(name, bgColor, textColor, patterns);
  } catch (err) {
    console.error('Error creating category:', err);
    return { error: err.message };
  }
});

/**
 * Categories: Delete category
 */
ipcMain.handle('delete-category', (event, name) => {
  try {
    categories.deleteCategory(name);
    return { success: true };
  } catch (err) {
    console.error('Error deleting category:', err);
    return { error: err.message };
  }
});

/**
 * Categories: Get categories list as array (for Settings modal grid)
 */
ipcMain.handle('get-categories-list', () => {
  try {
    const categoriesObj = categories.loadCategories();
    // Convert object to array
    return Object.values(categoriesObj);
  } catch (err) {
    console.error('Error getting categories list:', err);
    return [];
  }
});

/**
 * Categories: Save category (create or update)
 */
ipcMain.handle('save-category', (event, categoryData) => {
  try {
    const { name, bgColor, textColor, description, patterns } = categoryData;
    
    // Check if category exists
    const existing = categories.getCategory(name);
    
    if (existing) {
      // Update existing
      return categories.updateCategory(name, bgColor, textColor, patterns || [], description || '');
    } else {
      // Create new
      return categories.createCategory(name, bgColor, textColor, patterns || [], description || '');
    }
  } catch (err) {
    console.error('Error saving category:', err);
    throw err;
  }
});

/**
 * Categories: Update category (with new schema including description)
 */
ipcMain.handle('update-category', (event, categoryData) => {
  try {
    const { name, oldName, bgColor, textColor, patterns, description } = categoryData;
    const updateName = name || oldName;
    
    // If name changed, delete old and create new
    if (oldName && name && oldName !== name) {
      categories.deleteCategory(oldName);
      return categories.createCategory(name, bgColor, textColor, patterns || [], description || '');
    } else {
      // Just update
      return categories.updateCategory(updateName, bgColor, textColor, patterns || [], description || '');
    }
  } catch (err) {
    console.error('Error updating category:', err);
    throw err;
  }
});

/**
 * Directory Assignments: Assign category to directory
 */
ipcMain.handle('assign-category-to-directory', (event, { dirPath, categoryName }) => {
  try {
    categories.assignCategoryToDirectory(dirPath, categoryName);
    return { success: true };
  } catch (err) {
    console.error('Error assigning category:', err);
    return { error: err.message };
  }
});

/**
 * Directory Assignments: Get assignment
 */
ipcMain.handle('get-directory-assignment', (event, dirPath) => {
  try {
    return categories.getDirectoryAssignment(dirPath);
  } catch (err) {
    console.error('Error getting assignment:', err);
    return null;
  }
});

/**
 * Directory Assignments: Remove assignment
 */
ipcMain.handle('remove-directory-assignment', (event, dirPath) => {
  try {
    categories.removeDirectoryAssignment(dirPath);
    return { success: true };
  } catch (err) {
    console.error('Error removing assignment:', err);
    return { error: err.message };
  }
});

/**
 * Categories: Get applicable category for a directory
 */
ipcMain.handle('get-category-for-directory', (event, dirPath) => {
  try {
    return categories.getCategoryForDirectory(dirPath);
  } catch (err) {
    console.error('Error getting category for directory:', err);
    return categories.createDefaultCategory();
  }
});

/**
 * Settings: Get settings
 */
ipcMain.handle('get-settings', () => {
  try {
    return categories.getSettings();
  } catch (err) {
    console.error('Error getting settings:', err);
    return {};
  }
});

/**
 * Window Icon: Update icon for category
 */
ipcMain.handle('update-window-icon', async (event, categoryName) => {
  try {
    const category = categories.getCategory(categoryName);
    if (category) {
      await updateWindowIcon(category);
      return { success: true };
    }
    return { error: 'Category not found' };
  } catch (err) {
    console.error('Error updating window icon:', err);
    return { error: err.message };
  }
});

/**
 * Generate folder icon with category colors
 */
ipcMain.handle('generate-folder-icon', async (event, { bgColor, textColor }) => {
  try {
    const iconBuffer = await icons.generateWindowIcon(bgColor, textColor);
    if (iconBuffer) {
      // Convert to base64 data URL
      return 'data:image/png;base64,' + iconBuffer.toString('base64');
    }
    return null;
  } catch (err) {
    console.error('Error generating folder icon:', err);
    return null;
  }
});

/**
 * Notes: Read notes.txt file
 */
ipcMain.handle('read-notes-file', async (event, notesPath) => {
  try {
    const fsSync = require('fs');
    if (fsSync.existsSync(notesPath)) {
      return fsSync.readFileSync(notesPath, 'utf-8');
    } else {
      throw new Error('File does not exist');
    }
  } catch (err) {
    console.error('Error reading notes file:', err);
    throw err;
  }
});

/**
 * Notes: Write notes.txt file
 */
ipcMain.handle('write-notes-file', async (event, { notesPath, content }) => {
  try {
    const fsSync = require('fs');
    fsSync.writeFileSync(notesPath, content, 'utf-8');
    return { success: true };
  } catch (err) {
    console.error('Error writing notes file:', err);
    throw err;
  }
});

/**
 * Markdown: Render markdown to HTML
 */
ipcMain.handle('render-markdown', async (event, content) => {
  try {
    const MarkdownIt = require('markdown-it');
    const md = new MarkdownIt({
      html: true,
      linkify: true,
      typographer: true
    });
    return md.render(content);
  } catch (err) {
    console.error('Error rendering markdown:', err);
    throw err;
  }
});

/**
 * File Change Detection: Scan directory with comparison
 */
ipcMain.handle('scan-directory-with-comparison', (event, dirPath) => {
  try {
    // Get directory inode to track the directory itself
    const dirStats = fs.getStats(dirPath);
    if (!dirStats) {
      return { success: false, error: 'Unable to read directory stats' };
    }

    const dirInode = dirStats.inode;

    // Get category for this directory
    const category = categories.getCategoryForDirectory(dirPath);
    const categoryName = category ? category.name : 'Default';

    // Create or get the directory entry (returns dir_id)
    const dirId = db.getOrCreateDirectory(dirPath, dirInode, categoryName);

    // IMPORTANT: Get existing database records BEFORE clearing
    const existingDbFiles = db.getFilesByDirId(dirId);
    const dbFileMap = new Map(existingDbFiles.map(f => [f.inode, f]));

    // Read all filesystem entries (folders + files)
    const entries = fs.readDirectory(dirPath);
    const entriesWithChanges = [];

    for (const entry of entries) {
      if (!entry.isDirectory) {
        // For files, determine change state
        const dbFile = dbFileMap.get(entry.inode);
        let changeState = 'unchanged';
        let previousDateModified = null;

        if (!dbFile) {
          // New file
          changeState = 'new';
        } else if (dbFile.dateModified !== entry.dateModified) {
          // Date modified changed
          changeState = 'dateModified';
          previousDateModified = dbFile.dateModified;
        }

        entriesWithChanges.push({
          ...entry,
          changeState,
          previousDateModified
        });
      } else {
        // For directories, check if they're new
        const existingDir = db.getDirectory(entry.path);
        let changeState = 'unchanged';

        if (!existingDir) {
          // New directory - create entry in dirs table
          changeState = 'new';
          db.getOrCreateDirectory(entry.path, entry.inode, 'Default');
        }

        entriesWithChanges.push({
          ...entry,
          changeState
        });
      }
    }

    // Now clear existing file entries for this directory
    db.clearDirectory(dirPath);

    // Upsert all files with their new data
    for (const entry of entriesWithChanges) {
      if (!entry.isDirectory) {
        db.upsertFile({
          inode: entry.inode,
          dir_id: dirId,
          filename: entry.filename,
          dateModified: entry.dateModified,
          dateCreated: entry.dateCreated,
          size: entry.size
        });
      }
    }

    return {
      success: true,
      count: entriesWithChanges.filter(e => !e.isDirectory).length,
      entries: entriesWithChanges,
      category: categoryName,
      categoryData: category
    };
  } catch (err) {
    console.error('Error scanning directory with comparison:', err);
    return { success: false, error: err.message };
  }
});

/**
 * File Change Detection: Calculate checksum for a file
 */
ipcMain.handle('calculate-file-checksum', async (event, { filePath, inode, dirId }) => {
  try {
    const result = await checksum.calculateMD5(filePath);

    if (result.error) {
      // Update with error status
      db.updateFileChecksum(inode, dirId, null, 'error');
      return { 
        success: false, 
        checksum: null, 
        status: 'error',
        error: result.error 
      };
    }

    // Update database with calculated checksum
    db.updateFileChecksum(inode, dirId, result.value, 'calculated');

    return { 
      success: true, 
      checksum: result.value, 
      status: 'calculated',
      error: null 
    };
  } catch (err) {
    console.error('Error calculating file checksum:', err);
    db.updateFileChecksum(inode, dirId, null, 'error');
    return { 
      success: false, 
      checksum: null, 
      status: 'error',
      error: err.message 
    };
  }
});

/**
 * File Change Detection: Update file modification date (acknowledge change)
 */
ipcMain.handle('update-file-modification-date', (event, { dirPath, inode, newDateModified }) => {
  try {
    // Get the directory to find its dir_id
    const dir = db.getDirectory(dirPath);
    if (!dir) {
      return { success: false, error: 'Directory not found in database' };
    }

    db.updateFileModificationDate(inode, dir.id, newDateModified);
    return { success: true };
  } catch (err) {
    console.error('Error updating file modification date:', err);
    return { success: false, error: err.message };
  }
});

// ============================================
// App lifecycle
// ============================================

app.on('ready', () => {
  initialize();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on('quit', () => {
  db.close();
});
