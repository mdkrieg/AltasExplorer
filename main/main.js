const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('path');
const os = require('os');

// Import service modules
const db = require('../src/db');
const fs = require('../src/filesystem');
const categories = require('../src/categories');
const icons = require('../src/icons');

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
    const entries = fs.readDirectory(dirPath);
    
    // Clear existing entries for this directory
    db.clearDirectory(dirPath);

    // Get category for this directory
    const category = categories.getCategoryForDirectory(dirPath);
    const categoryName = category ? category.name : 'Default';

    // Upsert all entries
    for (const entry of entries) {
      if (!entry.isDirectory) { // Only index files
        db.upsertFile({
          inode: entry.inode,
          dirname: dirPath,
          filename: entry.filename,
          dateModified: entry.dateModified,
          dateCreated: entry.dateCreated,
          size: entry.size,
          categoryName
        });
      }
    }

    return {
      success: true,
      count: entries.length,
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
 * Categories: Update category
 */
ipcMain.handle('update-category', (event, { name, bgColor, textColor, patterns }) => {
  try {
    return categories.updateCategory(name, bgColor, textColor, patterns);
  } catch (err) {
    console.error('Error updating category:', err);
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
