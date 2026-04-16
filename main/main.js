const { app, BrowserWindow, ipcMain, nativeImage, Menu, globalShortcut } = require('electron');
const path = require('path');
const os = require('os');
const fsSync = require('fs');
const pty = require('node-pty');

// Import service modules
const logger = require('../src/logger');
const db = require('../src/db');
const fs = require('../src/filesystem');
const categories = require('../src/categories');
const tags = require('../src/tags');
const filetypes = require('../src/filetypes');
const icons = require('../src/icons');
const checksum = require('../src/checksum');
const attributes = require('../src/attributes');
const notesParser = require('../src/notesParser');
const customActions = require('../src/customActions');
const { execFile } = require('child_process');
const { dialog } = require('electron');

let mainWindow;

let checksumInFlight = 0;
const checksumWaiters = [];
let monitoringTimer = null;
let monitoringPassInProgress = false;

function delay(ms) {
  if (!ms || ms <= 0) {
    return Promise.resolve();
  }
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function acquireChecksumSlot() {
  const settings = categories.getSettings();
  const maxConcurrent = Math.max(1, Math.min(2, Number(settings.checksum_max_concurrent) || 1));

  if (checksumInFlight < maxConcurrent) {
    checksumInFlight++;
    return () => {
      checksumInFlight--;
      const next = checksumWaiters.shift();
      if (next) next();
    };
  }

  await new Promise(resolve => checksumWaiters.push(resolve));
  checksumInFlight++;
  return () => {
    checksumInFlight--;
    const next = checksumWaiters.shift();
    if (next) next();
  };
}

function getRuleIntervalMs(rule) {
  const value = Math.max(1, Number(rule.interval_value) || 1);
  switch (rule.interval_unit) {
    case 'seconds':
      return value * 1000;
    case 'minutes':
      return value * 60 * 1000;
    case 'hours':
      return value * 60 * 60 * 1000;
    case 'days':
    default:
      return value * 24 * 60 * 60 * 1000;
  }
}

function doesRuleMatchFilters(rule, category, tagsJson, attributesJson) {
  if (rule.categories !== 'ANY') {
    try {
      const ruleCategories = JSON.parse(rule.categories);
      if (!ruleCategories.includes(category)) return false;
    } catch {
      return false;
    }
  }

  if (rule.tags !== 'ANY') {
    try {
      const ruleTags = JSON.parse(rule.tags);
      const itemTags = tagsJson ? JSON.parse(tagsJson) : [];
      if (!ruleTags.some(tag => itemTags.includes(tag))) return false;
    } catch {
      return false;
    }
  }

  if (rule.attributes !== 'ANY') {
    try {
      const ruleAttrs = JSON.parse(rule.attributes);
      const itemAttrs = attributesJson ? JSON.parse(attributesJson) : {};
      const allMatch = ruleAttrs.every(attr => {
        if (attr.value === '' || attr.value === null || typeof attr.value === 'undefined') {
          return Object.prototype.hasOwnProperty.call(itemAttrs, attr.name);
        }
        return itemAttrs[attr.name] === attr.value;
      });
      if (!allMatch) return false;
    } catch {
      return false;
    }
  }

  return true;
}

async function runMonitoringPass() {
  if (monitoringPassInProgress) {
    return;
  }

  const settings = categories.getSettings();
  if (!settings.monitoring_enabled) {
    return;
  }

  monitoringPassInProgress = true;
  try {
    const rules = db.getMonitoringRules().filter(rule => rule.enabled);
    if (rules.length === 0) {
      return;
    }

    const allDirs = db.getDirectoriesForMonitoring();
    const now = Date.now();
    const queue = [];
    const seen = new Set();
    const maxPerPass = Math.max(1, Number(settings.monitoring_max_dirs_per_pass) || 10);

    for (const rule of rules) {
      const cutoff = now - getRuleIntervalMs(rule);
      for (const dir of allDirs) {
        if (queue.length >= maxPerPass) {
          break;
        }
        if (!doesRuleMatchFilters(rule, dir.category || 'Default', dir.dot_tags || null, dir.dot_attributes || null)) {
          continue;
        }
        if (dir.last_observed_at && dir.last_observed_at > cutoff) {
          continue;
        }

        const queueKey = `${rule.id}:${dir.id}`;
        if (seen.has(queueKey)) {
          continue;
        }
        seen.add(queueKey);
        queue.push({
          rule,
          dirname: dir.dirname,
          remainingDepth: Math.max(0, Number(rule.max_depth) || 0)
        });
      }

      if (queue.length >= maxPerPass) {
        break;
      }
    }

    const interScanDelay = Math.max(0, Number(settings.monitoring_inter_scan_delay_ms) || 0);
    while (queue.length > 0) {
      const job = queue.shift();
      const result = doScanDirectoryWithComparison(job.dirname, false, true, {
        observationSource: 'monitoring'
      });

      if (result.success && result.alertsCreated && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('alert-count-updated', { count: db.getUnacknowledgedAlertCount() });
      }

      if (result.success && job.remainingDepth > 0) {
        const subdirs = (result.entries || []).filter(entry => entry.isDirectory && entry.filename !== '.');
        for (const subdir of subdirs) {
          queue.push({
            rule: job.rule,
            dirname: subdir.path,
            remainingDepth: job.remainingDepth - 1
          });
        }
      }

      await delay(interScanDelay);
    }
  } catch (err) {
    logger.error('Active monitoring pass failed:', err.message);
  } finally {
    monitoringPassInProgress = false;
  }
}

function reconfigureActiveMonitoring() {
  if (monitoringTimer) {
    clearInterval(monitoringTimer);
    monitoringTimer = null;
  }

  const settings = categories.getSettings();
  if (!settings.monitoring_enabled) {
    return;
  }

  const intervalMs = Math.max(5, Number(settings.monitoring_scheduler_interval) || 15) * 1000;
  monitoringTimer = setInterval(() => {
    runMonitoringPass().catch(err => {
      logger.error('Active monitoring interval failed:', err.message);
    });
  }, intervalMs);
}

function getTerminalShell() {
  return process.platform === 'win32'
    ? (process.env.COMSPEC || 'cmd.exe')
    : (process.env.SHELL || '/bin/bash');
}

function getSafeWorkingDirectory(targetPath) {
  const fallbackPath = os.homedir();
  const candidatePath = targetPath && fsSync.existsSync(targetPath)
    ? (fsSync.statSync(targetPath).isDirectory() ? targetPath : path.dirname(targetPath))
    : fallbackPath;

  return fsSync.existsSync(candidatePath) ? candidatePath : fallbackPath;
}

function quoteForCommandShell(value) {
  const normalized = String(value ?? '');
  return `"${normalized.replace(/"/g, '""')}"`;
}

function quoteForPosixShell(value) {
  const normalized = String(value ?? '');
  return `'${normalized.replace(/'/g, `'\\''`)}'`;
}

function quoteForShell(value) {
  return process.platform === 'win32'
    ? quoteForCommandShell(value)
    : quoteForPosixShell(value);
}

function buildTerminalCommand(action, filePath) {
  const executable = quoteForShell(action.executable);
  const args = Array.isArray(action.args) ? action.args.map(quoteForShell) : [];
  return `${[executable, ...args, quoteForShell(filePath)].join(' ')}\r`;
}

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
    logger.info('Loading index from:', indexPath);
    mainWindow.loadFile(indexPath);

    mainWindow.webContents.on('crashed', () => {
      logger.error('Renderer process crashed');
    });

    mainWindow.webContents.on('unresponsive', () => {
      logger.warn('Renderer process became unresponsive');
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    // Handle window close requests - ask renderer if it's OK to close
    mainWindow.on('close', (event) => {
      if (!app.isQuitting) {
        event.preventDefault();
        // Ask the renderer if we should close
        mainWindow.webContents.send('request-close-app');
      }
    });
  } catch (err) {
    logger.error('Error creating window:', err.message);
    app.quit();
  }
}

/**
 * Sync ~/.atlasexplorer/icons → public/assets/icons at startup
 * Falls back to bundled icons if user directory is empty or missing
 */
function syncIconAssets() {
  const srcDir = path.join(os.homedir(), '.atlasexplorer', 'icons');
  const destDir = path.join(__dirname, '..', 'public', 'assets', 'icons');
  const assetsDir = path.join(__dirname, '..', 'public', 'assets');

  try {
    // Delete public/assets entirely, then recreate icons destination
    if (fsSync.existsSync(assetsDir)) {
      fsSync.rmSync(assetsDir, { recursive: true, force: true });
      logger.info('Deleted public/assets');
    }
    fsSync.mkdirSync(destDir, { recursive: true });

    // Check if user directory has any icon files
    let effectiveSrcDir = srcDir;
    const userDirHasIcons = fsSync.existsSync(srcDir) &&
      fsSync.readdirSync(srcDir).some(f => /\.(png|svg)$/i.test(f));

    if (!userDirHasIcons) {
      const bundledDir = icons.resolveBundledIconsDir();
      if (!bundledDir) {
        logger.warn('No icon source available; public/assets/icons will be empty');
        return;
      }
      effectiveSrcDir = bundledDir;
      logger.warn('User icons directory empty or missing; falling back to bundled assets');
    }

    const files = fsSync.readdirSync(effectiveSrcDir);
    let copied = 0;
    for (const file of files) {
      if (/\.(png|svg)$/i.test(file)) {
        fsSync.copyFileSync(path.join(effectiveSrcDir, file), path.join(destDir, file));
        copied++;
      }
    }
    logger.info(`Synced ${copied} icon(s) to public/assets/icons`);
  } catch (err) {
    logger.error('Error syncing icon assets:', err.message);
  }
}

/**
 * Initialize the application
 */
function initialize() {
  logger.info('Initializing application');
  syncIconAssets();
  db.initialize();
  reconfigureActiveMonitoring();
  runMonitoringPass().catch(err => {
    logger.error('Initial active monitoring pass failed:', err.message);
  });
  
  // Load default window icon
  const defaultCategory = categories.getCategory('Default');
  if (defaultCategory) {
    updateWindowIcon(defaultCategory);
  }
}

/**
 * Update the main window icon based on category colors
 */
async function updateWindowIcon(category, initials = null) {
  try {
    const iconBuffer = await icons.generateWindowIcon(category.bgColor, category.textColor, initials);
    if (iconBuffer && mainWindow) {
      const nimg = nativeImage.createFromBuffer(iconBuffer);
      mainWindow.setIcon(nimg);
    }
  } catch (err) {
    logger.error('Error updating window icon:', err.message);
  }
}

// ============================================
// IPC Handlers
// ============================================

/**
 * Application window control
 */
ipcMain.handle('close-window', () => {
  if (mainWindow) {
    app.isQuitting = true;  // Set flag to allow window close
    mainWindow.close();
  }
});

ipcMain.on('allow-close-app', () => {
  if (mainWindow) {
    app.isQuitting = true;
    mainWindow.close();
  }
});

/**
 * File system operations
 */
ipcMain.handle('read-directory', (event, dirPath) => {
  try {
    return fs.readDirectory(dirPath);
  } catch (err) {
    logger.error('Error reading directory:', err.message);
    return [];
  }
});

/**
 * Get parent directory metadata (filesystem + database info)
 */
ipcMain.handle('get-parent-directory-metadata', (event, dirPath) => {
  try {
    // Get filesystem metadata (inode, permissions, dates)
    const fsMetadata = fs.getParentDirectoryMetadata(dirPath);
    // logger.info(`[DEBUG] get-parent-directory-metadata for: ${dirPath}, fsMetadata:`, fsMetadata);
    if (!fsMetadata) {
      // logger.info('[DEBUG] fsMetadata is null, returning null (at root)');
      return null; // At root, no parent
    }
    
    // Get database metadata (category, tags, initials, attributes)
    const dbMetadata = db.getParentDirectoryInfo(dirPath);
    // logger.info('[DEBUG] dbMetadata:', dbMetadata);

    // Look up the parent's dot-file for attributes
    let parentAttributes = null;
    if (dbMetadata) {
      const parentDotFile = db.getFileByFilename(dbMetadata.id, '.');
      if (parentDotFile && parentDotFile.attributes) {
        parentAttributes = parentDotFile.attributes;
      }
    }
    
    // Get parent tags from files dot-entry (same source as '.' and child dirs)
    const parentDirPath = path.dirname(dirPath);
    const parentTags = dbMetadata ? db.getTagsForDirectory(parentDirPath) : null;
    const parentResolution = categories.getCategoryResolutionForDirectory(parentDirPath);

    // Merge filesystem and database metadata
    const result = {
      ...fsMetadata,
      category: parentResolution.categoryName,
      tags: parentTags,
      initials: dbMetadata?.initials || null,
      description: dbMetadata?.description || null,
      attributes: parentAttributes
    };
    // logger.info('[DEBUG] Returning parent metadata:', result);
    return result;
  } catch (err) {
    logger.error('Error getting parent directory metadata:', err.message);
    logger.error('[DEBUG] Stack:', err.stack);
    return null;
  }
});

// /**
//  * Database: Scan directory and upsert files
//  */
// ipcMain.handle('scan-directory', (event, dirPath) => {
//   try {
//     // Validate path parameter
//     if (!dirPath || typeof dirPath !== 'string') {
//       logger.error(`scan-directory: Invalid path - received ${typeof dirPath}`);
//       return { success: false, error: 'Directory path must be a valid string' };
//     }
    
//     const normalizedPath = dirPath.trim();
//     if (!normalizedPath) {
//       logger.error('scan-directory: Empty path provided');
//       return { success: false, error: 'Directory path cannot be empty' };
//     }
    
//     // Get directory inode to track the directory itself
//     const dirStats = fs.getStats(normalizedPath);
//     if (!dirStats) {
//       return { success: false, error: 'Unable to read directory stats' };
//     }

//     const dirInode = dirStats.inode;

//     // Get category for this directory
//     const category = categories.getCategoryForDirectory(dirPath);
//     const categoryName = category ? category.name : 'Default';

//     // Create or get the directory entry (returns dir_id)
//     const dirId = db.getOrCreateDirectory(dirPath, dirInode, categoryName);

//     // Create/update dot entry for the directory itself
//     db.upsertFile({
//       inode: dirInode,
//       dir_id: dirId,
//       filename: '.',
//       dateModified: dirStats.dateModified,
//       dateCreated: dirStats.dateCreated,
//       size: 0
//     });

//     // Get existing database files for this directory
//     const existingDbFiles = db.getFilesByDirId(dirId);
//     const dbFileMap = new Map(existingDbFiles.map(f => [f.inode, f]));

//     // Read and process files
//     const entries = fs.readDirectory(normalizedPath);
//     let insertedCount = 0;
//     let updatedCount = 0;
//     let deletedCount = 0;

//     // Process filesystem entries: upsert files, track changes
//     for (const entry of entries) {
//       if (!entry.isDirectory) {
//         const dbFile = dbFileMap.get(entry.inode);
        
//         if (!dbFile) {
//           // New file
//           db.upsertFile({
//             inode: entry.inode,
//             dir_id: dirId,
//             filename: entry.filename,
//             dateModified: entry.dateModified,
//             dateCreated: entry.dateCreated,
//             size: entry.size
//           });
//           insertedCount++;
//         } else if (dbFile.dateModified !== entry.dateModified || dbFile.size !== entry.size) {
//           // File changed - update it
//           db.upsertFile({
//             inode: entry.inode,
//             dir_id: dirId,
//             filename: entry.filename,
//             dateModified: entry.dateModified,
//             dateCreated: entry.dateCreated,
//             size: entry.size
//           });
//           updatedCount++;
//         }
        
//         // Mark as processed
//         dbFileMap.delete(entry.inode);
//       } else {
//         // Track subdirectories with dot placeholder file
//         const existingDir = db.getDirectory(entry.path);
//         let subDirId;
//         if (!existingDir) {
//           // New subdirectory - create entry in dirs table and get its ID
//           subDirId = db.getOrCreateDirectory(entry.path, entry.inode, 'Default');
//           insertedCount++;
//         } else {
//           // Get existing directory's ID
//           subDirId = existingDir.id;
//         }
        
//         // Create/update dot file entry for directory tracking with the child directory's own dir_id
//         db.upsertFile({
//           inode: entry.inode,
//           dir_id: subDirId,
//           filename: '.',
//           dateModified: entry.dateModified,
//           dateCreated: entry.dateCreated,
//           size: 0
//         });
        
//         dbFileMap.delete(entry.inode);
//       }
//     }

//     // Process deletions: remaining files in dbFileMap are no longer on filesystem
//     for (const [inode, dbFile] of dbFileMap) {
//       try {
//         db.deleteFile(inode, dirId);
//         deletedCount++;
//       } catch (err) {
//         logger.error(`Error deleting file ${dbFile.filename}:`, err.message);
//       }
//     }

//     return {
//       success: true,
//       count: entries.filter(e => !e.isDirectory).length,
//       category: categoryName,
//       inserted: insertedCount,
//       updated: updatedCount,
//       deleted: deletedCount
//     };
//   } catch (err) {
//     logger.error('Error scanning directory:', err.message);
//     return { success: false, error: err.message };
//   }
// });

/**
 * Database: Get files from a directory
 */
ipcMain.handle('get-files-in-directory', (event, dirPath) => {
  try {
    return db.getFilesInDirectory(dirPath);
  } catch (err) {
    logger.error('Error getting files:', err.message);
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
    logger.error('Error loading categories:', err.message);
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
    logger.error('Error getting category:', err.message);
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
    logger.error('Error creating category:', err.message);
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
    logger.error('Error deleting category:', err.message);
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
    logger.error('Error getting categories list:', err.message);
    return [];
  }
});

/**
 * Categories: Save category (create or update)
 */
ipcMain.handle('save-category', (event, categoryData) => {
  try {
    const { name, bgColor, textColor, description, patterns, enableChecksum, attributes: attrs, autoAssignCategory } = categoryData;
    
    // Check if category exists
    const existing = categories.getCategory(name);
    
    if (existing) {
      // Update existing
      return categories.updateCategory(name, bgColor, textColor, patterns || [], description || '', enableChecksum || false, attrs || [], autoAssignCategory);
    } else {
      // Create new
      return categories.createCategory(name, bgColor, textColor, patterns || [], description || '', enableChecksum || false, attrs || [], autoAssignCategory);
    }
  } catch (err) {
    logger.error('Error saving category:', err.message);
    throw err;
  }
});

/**
 * Categories: Update category (with new schema including description)
 */
ipcMain.handle('update-category', (event, categoryData) => {
  try {
    const { name, oldName, bgColor, textColor, patterns, description, enableChecksum, attributes: attrs, autoAssignCategory } = categoryData;
    const updateName = name || oldName;
    
    // If name changed, delete old and create new
    if (oldName && name && oldName !== name) {
      categories.deleteCategory(oldName);
      return categories.createCategory(name, bgColor, textColor, patterns || [], description || '', enableChecksum || false, attrs || [], autoAssignCategory);
    } else {
      // Just update
      return categories.updateCategory(updateName, bgColor, textColor, patterns || [], description || '', enableChecksum, attrs || [], autoAssignCategory);
    }
  } catch (err) {
    logger.error('Error updating category:', err.message);
    throw err;
  }
});

/**
 * Directory Assignments: Assign category to directory
 */
ipcMain.handle('assign-category-to-directory', (event, { dirPath, categoryName, force = true }) => {
  try {
    categories.setCategoryForDirectory(dirPath, categoryName, force);
    // Record the category change in file_history via the directory's dot-file
    try {
      const dirEntry = db.getDirectory(dirPath);
      if (dirEntry) {
        const dotFile = db.getFileByInode(dirEntry.inode, dirEntry.id);
        if (dotFile) {
          db.insertFileHistory(dirEntry.inode, dirEntry.id, dotFile.id, { category: categoryName });
        }
      }
    } catch (histErr) {
      logger.error('Error recording category history for directory:', histErr.message);
    }
    return { success: true };
  } catch (err) {
    logger.error('Error assigning category:', err.message);
    return { error: err.message };
  }
});

/**
 * Directory Assignments: Assign category to multiple directories (bulk operation)
 */
ipcMain.handle('assign-category-to-directories', (event, { dirPaths, categoryName, force = true }) => {
  try {
    const results = [];
    for (const dirPath of dirPaths) {
      try {
        categories.setCategoryForDirectory(dirPath, categoryName, force);
        // Record the category change in file_history via the directory's dot-file
        try {
          const dirEntry = db.getDirectory(dirPath);
          if (dirEntry) {
            const dotFile = db.getFileByInode(dirEntry.inode, dirEntry.id);
            if (dotFile) {
              db.insertFileHistory(dirEntry.inode, dirEntry.id, dotFile.id, { category: categoryName });
            }
          }
        } catch (histErr) {
          logger.error(`Error recording category history for directory ${dirPath}:`, histErr.message);
        }
        results.push({ path: dirPath, success: true });
      } catch (err) {
        logger.error(`Error assigning category to ${dirPath}:`, err.message);
        results.push({ path: dirPath, success: false, error: err.message });
      }
    }
    return { success: true, results };
  } catch (err) {
    logger.error('Error in bulk category assignment:', err.message);
    return { success: false, error: err.message };
  }
});

/**
 * Directory Assignments: Get assignment
 */
ipcMain.handle('get-directory-assignment', (event, dirPath) => {
  try {
    return categories.getCategoryAssignmentForDirectory(dirPath);
  } catch (err) {
    logger.error('Error getting assignment:', err.message);
    return null;
  }
});

/**
 * Directory Assignments: Remove assignment
 */
ipcMain.handle('remove-directory-assignment', (event, dirPath) => {
  try {
    categories.clearCategoryForDirectory(dirPath);
    return { success: true };
  } catch (err) {
    logger.error('Error removing assignment:', err.message);
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
    logger.error('Error getting category for directory:', err.message);
    return categories.createDefaultCategory();
  }
});

// ============================================
// Tags IPC Handlers
// ============================================

/**
 * Tags: Load all tags
 */
ipcMain.handle('load-tags', () => {
  try {
    return tags.loadTags();
  } catch (err) {
    logger.error('Error loading tags:', err.message);
    return {};
  }
});

/**
 * Tags: Get single tag
 */
ipcMain.handle('get-tag', (event, name) => {
  try {
    return tags.getTag(name);
  } catch (err) {
    logger.error('Error getting tag:', err.message);
    return null;
  }
});

/**
 * Tags: Get tags list as array (for Settings modal grid)
 */
ipcMain.handle('get-tags-list', () => {
  try {
    const tagsObj = tags.loadTags();
    // Convert object to array
    return Object.values(tagsObj);
  } catch (err) {
    logger.error('Error getting tags list:', err.message);
    return [];
  }
});

/**
 * Tags: Save tag (create or update)
 */
ipcMain.handle('save-tag', (event, tagData) => {
  try {
    const { name, bgColor, textColor, description } = tagData;
    
    // Check if tag exists
    const existing = tags.getTag(name);
    
    if (existing) {
      // Update existing
      return tags.updateTag(name, bgColor, textColor, description || '');
    } else {
      // Create new
      return tags.createTag(name, bgColor, textColor, description || '');
    }
  } catch (err) {
    logger.error('Error saving tag:', err.message);
    throw err;
  }
});

/**
 * Tags: Update tag
 */
ipcMain.handle('update-tag', (event, tagData) => {
  try {
    const { name, oldName, bgColor, textColor, description } = tagData;
    const updateName = name || oldName;
    
    // If name changed, delete old and create new
    if (oldName && name && oldName !== name) {
      tags.deleteTag(oldName);
      return tags.createTag(name, bgColor, textColor, description || '');
    } else {
      // Just update
      return tags.updateTag(updateName, bgColor, textColor, description || '');
    }
  } catch (err) {
    logger.error('Error updating tag:', err.message);
    throw err;
  }
});

/**
 * Tags: Delete tag
 */
ipcMain.handle('delete-tag', (event, name) => {
  try {
    tags.deleteTag(name);
    return { success: true };
  } catch (err) {
    logger.error('Error deleting tag:', err.message);
    return { error: err.message };
  }
});

// ============================================
// Attributes IPC Handlers
// ============================================

ipcMain.handle('get-attributes-list', () => {
  try {
    return Object.values(attributes.loadAttributes());
  } catch (err) {
    logger.error('Error getting attributes list:', err.message);
    return [];
  }
});

ipcMain.handle('save-attribute', (event, attrData) => {
  try {
    const { name, description, type, default: defaultValue, options, copyable } = attrData;
    if (!name) throw new Error('Attribute name is required');
    const existing = attributes.getAttribute(name);
    if (existing) {
      return attributes.updateAttribute(name, description || '', type || 'String', defaultValue || '', options || [], copyable);
    } else {
      return attributes.createAttribute(name, description || '', type || 'String', defaultValue || '', options || [], copyable);
    }
  } catch (err) {
    logger.error('Error saving attribute:', err.message);
    throw err;
  }
});

ipcMain.handle('update-attribute', (event, attrData) => {
  try {
    const { name, oldName, description, type, default: defaultValue, options, copyable } = attrData;
    const updateName = name || oldName;
    if (oldName && name && oldName !== name) {
      attributes.deleteAttribute(oldName);
      return attributes.createAttribute(name, description || '', type || 'String', defaultValue || '', options || [], copyable);
    } else {
      return attributes.updateAttribute(updateName, description || '', type || 'String', defaultValue || '', options || [], copyable);
    }
  } catch (err) {
    logger.error('Error updating attribute:', err.message);
    throw err;
  }
});

ipcMain.handle('delete-attribute', (event, name) => {
  try {
    attributes.deleteAttribute(name);
    return { success: true };
  } catch (err) {
    logger.error('Error deleting attribute:', err.message);
    return { error: err.message };
  }
});

ipcMain.handle('get-file-attributes', (event, { inode, dir_id }) => {
  try {
    return { success: true, attributes: db.getFileAttributes(inode, dir_id) };
  } catch (err) {
    logger.error('Error getting file attributes:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('set-file-attributes', (event, { inode, dir_id, attributes: attrs }) => {
  try {
    db.setFileAttributes(inode, dir_id, attrs);
    return { success: true };
  } catch (err) {
    logger.error('Error setting file attributes:', err.message);
    return { success: false, error: err.message };
  }
});

/**
 * Get all metadata for a file/directory (for Item Properties page)
 */
ipcMain.handle('get-item-stats', (event, { itemPath }) => {
  try {
    const stats = fs.getStats(itemPath);
    if (!stats) return { success: false, error: 'Could not stat path' };

    const isDir = stats.isDirectory;
    const dirname = isDir ? itemPath : path.dirname(itemPath);
    const filename = isDir ? path.basename(itemPath) : path.basename(itemPath);

    // Get DB records
    const dirEntry = db.getDirectory(dirname);
    let inode = stats.inode;
    let dirId = dirEntry ? dirEntry.id : null;
    let checksumValue = null;
    let checksumStatus = null;
    let tagsJson = null;
    let attrsJson = {};
    // Always resolve category regardless of whether the directory is in the DB
    const categoryResolution = categories.getCategoryResolutionForDirectory(dirname);
    const category = categoryResolution.category;

    if (dirEntry) {
      if (isDir) {
        // For directories, get the dot-entry
        const dotFile = db.getFileByFilename(dirEntry.id, '.');
        if (dotFile) {
          tagsJson = dotFile.tags;
          attrsJson = db.getFileAttributes(dotFile.inode, dirEntry.id);
        }
      } else {
        const fileRecord = db.getFileByFilename(dirEntry.id, filename);
        if (fileRecord) {
          inode = fileRecord.inode;
          dirId = dirEntry.id;
          checksumValue = fileRecord.checksumValue;
          checksumStatus = fileRecord.checksumStatus;
          tagsJson = fileRecord.tags;
          attrsJson = db.getFileAttributes(fileRecord.inode, dirEntry.id);
        }
      }
    }

    // Resolve category attribute definitions
    const categoryAttrNames = category ? (category.attributes || []) : [];
    const allAttributeDefs = attributes.loadAttributes();
    const categoryAttributeDefs = categoryAttrNames
      .map(name => allAttributeDefs[name])
      .filter(Boolean);

    // Resolve file icon
    const allFileTypes = filetypes.getFileTypes();
    let fileType = isDir ? 'Directory' : 'File';
    let openWith = null;
    let ftIcon = 'user-file.png';
    if (!isDir) {
      const matched = allFileTypes.find(ft => {
        if (ft.pattern.startsWith('*.')) {
          return filename.toLowerCase().endsWith(ft.pattern.slice(1).toLowerCase());
        }
        return filename.toLowerCase() === ft.pattern.toLowerCase();
      });
      if (matched) {
        fileType = matched.type;
        openWith = matched.openWith || null;
        ftIcon = matched.icon || 'user-file.png';
      }
    }

    let tags = [];
    if (tagsJson) {
      try { tags = JSON.parse(tagsJson); } catch {}
    }

    return {
      success: true,
      path: itemPath,
      filename,
      isDirectory: isDir,
      size: stats.size,
      dateModified: stats.dateModified,
      dateCreated: stats.dateCreated,
      inode,
      dir_id: dirId,
      checksumValue,
      checksumStatus,
      tags,
      attributes: attrsJson,
      fileType,
      ftIcon,
      openWith,
      categoryName: category ? category.name : 'Default',
      effectiveCategoryName: categoryResolution.categoryName,
      explicitCategoryName: categoryResolution.explicitCategoryName,
      isForcedCategory: categoryResolution.isForced,
      isAutoAssignedCategory: categoryResolution.isAutoAssigned,
      inheritedFromPath: categoryResolution.inheritedFromPath,
      inheritedFromCategoryName: categoryResolution.inheritedFromCategoryName,
      canForceCategory: isDir,
      categoryAttributes: categoryAttributeDefs
    };
  } catch (err) {
    logger.error('Error getting item stats:', err.message);
    return { success: false, error: err.message };
  }
});

/**
 * Tags: Add a tag to a directory or file
 */
ipcMain.handle('add-tag-to-item', (event, { path, tagName, isDirectory, inode, dir_id }) => {
  try {
    if (isDirectory) {
      db.addTagToDirectory(path, tagName);
    } else {
      db.addTagToFile(inode, dir_id, tagName);
    }
    return { success: true };
  } catch (err) {
    logger.error('Error adding tag to item:', err.message);
    return { success: false, error: err.message };
  }
});

/**
 * Tags: Remove a tag from a directory or file
 */
ipcMain.handle('remove-tag-from-item', (event, { path, tagName, isDirectory, inode, dir_id }) => {
  try {
    if (isDirectory) {
      db.removeTagFromDirectory(path, tagName);
    } else {
      db.removeTagFromFile(inode, dir_id, tagName);
    }
    return { success: true };
  } catch (err) {
    logger.error('Error removing tag from item:', err.message);
    return { success: false, error: err.message };
  }
});

/**
 * File Types: List available user-*.png icon files
 */
ipcMain.handle('get-file-type-icons', () => {
  try {
    const iconsDir = path.join(__dirname, '..', 'public', 'assets', 'icons');
    if (!fsSync.existsSync(iconsDir)) return [];
    return fsSync.readdirSync(iconsDir)
      .filter(f => /^user-.*\.png$/i.test(f))
      .sort();
  } catch (err) {
    logger.error('Error listing file type icons:', err.message);
    return [];
  }
});

/**
 * File Types: Get all file types
 */
ipcMain.handle('get-file-types', () => {
  try {
    return filetypes.getFileTypes();
  } catch (err) {
    logger.error('Error getting file types:', err.message);
    return { error: err.message };
  }
});

/**
 * File Types: Add a new file type
 */
ipcMain.handle('add-file-type', (event, { pattern, type, icon, openWith }) => {
  try {
    return filetypes.addFileType(pattern, type, icon || null, openWith || null);
  } catch (err) {
    logger.error('Error adding file type:', err.message);
    return { error: err.message };
  }
});

/**
 * File Types: Update an existing file type
 */
ipcMain.handle('update-file-type', (event, { pattern, newPattern, newType, icon, openWith }) => {
  try {
    return filetypes.updateFileType(pattern, newPattern, newType, icon || null, openWith || null);
  } catch (err) {
    logger.error('Error updating file type:', err.message);
    return { error: err.message };
  }
});

/**
 * File Types: Delete a file type
 */
ipcMain.handle('delete-file-type', (event, pattern) => {
  try {
    filetypes.deleteFileType(pattern);
    return { success: true };
  } catch (err) {
    logger.error('Error deleting file type:', err.message);
    return { error: err.message };
  }
});

/**
 * Settings: Get settings
 */
ipcMain.handle('get-settings', () => {
  try {
    return categories.getSettings();
  } catch (err) {
    logger.error('Error getting settings:', err.message);
    return {};
  }
});

/**
 * Settings: Save settings
 */
ipcMain.handle('save-settings', (event, settings) => {
  try {
    categories.saveSettings(settings);
    reconfigureActiveMonitoring();
    return { success: true };
  } catch (err) {
    logger.error('Error saving settings:', err.message);
    return { success: false, error: err.message };
  }
});

/**
 * Hotkeys: Get hotkeys
 */
ipcMain.handle('get-hotkeys', () => {
  try {
    return categories.getHotkeys();
  } catch (err) {
    logger.error('Error getting hotkeys:', err.message);
    return {};
  }
});

/**
 * Hotkeys: Save hotkeys
 */
ipcMain.handle('save-hotkeys', (event, hotkeyData) => {
  try {
    categories.saveHotkeys(hotkeyData);
    return { success: true };
  } catch (err) {
    logger.error('Error saving hotkeys:', err.message);
    return { success: false, error: err.message };
  }
});

/**
 * File system: Check whether a path is an existing directory
 */
ipcMain.handle('is-directory', (event, dirPath) => {
  try {
    return fs.isDirectory(dirPath);
  } catch (err) {
    logger.error('Error checking directory:', err.message);
    return false;
  }
});

/**
 * Window Icon: Update icon for category
 */
ipcMain.handle('update-window-icon', async (event, { categoryName, initials }) => {
  try {
    const category = categories.getCategory(categoryName);
    if (category) {
      await updateWindowIcon(category, initials || null);
      return { success: true };
    }
    return { error: 'Category not found' };
  } catch (err) {
    logger.error('Error updating window icon:', err.message);
    return { error: err.message };
  }
});

/**
 * Generate folder icon with category colors
 */
ipcMain.handle('generate-folder-icon', async (event, { bgColor, textColor, initials }) => {
  try {
    const iconBuffer = await icons.generateWindowIcon(bgColor, textColor, initials || null);
    if (iconBuffer) {
      // Convert to base64 data URL
      return 'data:image/png;base64,' + iconBuffer.toString('base64');
    }
    return null;
  } catch (err) {
    logger.error('Error generating folder icon:', err.message);
    return null;
  }
});

ipcMain.handle('generate-tag-icon', async (event, { bgColor, textColor }) => {
  try {
    const iconBuffer = await icons.generateTagIcon(bgColor, textColor);
    if (iconBuffer) {
      return 'data:image/png;base64,' + iconBuffer.toString('base64');
    }
    return null;
  } catch (err) {
    logger.error('Error generating tag icon:', err.message);
    return null;
  }
});

/**
 * Directory Initials: Get initials for a directory
 */
ipcMain.handle('get-directory-initials', (event, dirPath) => {
  try {
    const dir = db.getDirectory(dirPath);
    return dir ? (dir.initials || null) : null;
  } catch (err) {
    logger.error('Error getting directory initials:', err.message);
    return null;
  }
});

/**
 * Directory Initials: Save initials for a directory
 */
ipcMain.handle('save-directory-initials', (event, { dirPath, initials }) => {
  try {
    db.updateDirectoryInitials(dirPath, initials);
    return { success: true };
  } catch (err) {
    logger.error('Error saving directory initials:', err.message);
    return { success: false, error: err.message };
  }
});

/**
 * Notes: Read notes.txt file
 */
ipcMain.handle('read-file-content', async (event, filePath) => {
  try {
    const fsSync = require('fs');
    if (fsSync.existsSync(filePath)) {
      return fsSync.readFileSync(filePath, 'utf-8');
    } else {
      throw new Error('File does not exist');
    }
  } catch (err) {
    logger.error('Error reading notes file:', err.message);
    throw err;
  }
});

/**
 * Notes: Write notes.txt file
 */
ipcMain.handle('write-file-content', async (event, { filePath, content }) => {
  try {
    const fsSync = require('fs');
    fsSync.writeFileSync(filePath, content, 'utf-8');
    return { success: true };
  } catch (err) {
    logger.error('Error writing notes file:', err.message);
    throw err;
  }
});

/**
 * Notes Parser: Parse notes.txt file into sections
 */
ipcMain.handle('parse-notes-file', async (event, content) => {
  try {
    return notesParser.parseNotesFileSections(content);
  } catch (err) {
    logger.error('Error parsing notes file:', err.message);
    throw err;
  }
});

/**
 * Notes Parser: Write section back to notes.txt
 */
ipcMain.handle('write-notes-section', async (event, { existingContent, sectionKey, newContent }) => {
  try {
    return notesParser.writeNotesSection(existingContent, sectionKey, newContent);
  } catch (err) {
    logger.error('Error writing notes section:', err.message);
    throw err;
  }
});

/**
 * Notes Parser: Extract all file headers
 */
ipcMain.handle('extract-notes-headers', async (event, content) => {
  try {
    return notesParser.extractAllHeaders(content);
  } catch (err) {
    logger.error('Error extracting notes headers:', err.message);
    throw err;
  }
});

/**
 * Notes Parser: Extract directory-level notes
 */
ipcMain.handle('extract-directory-notes', async (event, content) => {
  try {
    return notesParser.extractDirectoryNotes(content);
  } catch (err) {
    logger.error('Error extracting directory notes:', err.message);
    throw err;
  }
});

/**
 * Notes Parser: Extract file-specific notes
 */
ipcMain.handle('extract-file-notes', async (event, { content, filename }) => {
  try {
    return notesParser.extractFileNotes(content, filename);
  } catch (err) {
    logger.error('Error extracting file notes:', err.message);
    throw err;
  }
});

/**
 * Notes Parser: Validate if a line is a valid file header
 */
ipcMain.handle('validate-notes-header', async (event, line) => {
  try {
    return notesParser.isValidFileHeader(line);
  } catch (err) {
    logger.error('Error validating notes header:', err.message);
    throw err;
  }
});

/**
 * TODO Parser: Parse ALL TODO blocks from a section's content (returns array with labels)
 */
ipcMain.handle('parse-todo-section', async (event, sectionContent) => {
  try {
    return notesParser.parseTodoBlocks(sectionContent);
  } catch (err) {
    logger.error('Error parsing TODO section:', err.message);
    throw err;
  }
});

/**
 * TODO Parser: Normalize * bullets to [ ] within the first TODO block
 */
ipcMain.handle('normalize-todo-section', async (event, sectionContent) => {
  try {
    return notesParser.normalizeTodoBlock(sectionContent);
  } catch (err) {
    logger.error('Error normalizing TODO section:', err.message);
    throw err;
  }
});

/**
 * TODO Parser: Toggle completion state of specified TODO items by index
 */
ipcMain.handle('update-todo-items', async (event, { sectionContent, updates }) => {
  try {
    return notesParser.updateTodoItemStates(sectionContent, updates);
  } catch (err) {
    logger.error('Error updating TODO items:', err.message);
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
      html: false, // Disable raw HTML for security
      linkify: true,
      typographer: true,
      breaks: true // Enable single line breaks to render as <br>
    });

    // Add custom rule to handle GFM task lists [ ] and [x]
    md.inline.ruler.push('task_list', (state, silent) => {
      const pos = state.pos;
      const max = state.posMax;

      // Match [ ] or [x] at the start of a line or after whitespace
      if (pos + 3 > max) return false;

      const isStart = pos === 0 || /\s/.test(state.src[pos - 1]);
      if (!isStart) return false;

      // Check for [ ] or [x]
      if (state.src[pos] === '[' && (state.src[pos + 1] === ' ' || state.src[pos + 1] === 'x' || state.src[pos + 1] === 'X') && state.src[pos + 2] === ']') {
        if (silent) return true;

        const token = state.push('task_list', 'span', 0);
        token.content = state.src[pos + 1] === ' ' ? '☐' : '☑';
        token.meta = { checked: state.src[pos + 1] !== ' ' };

        state.pos += 3;
        return true;
      }

      return false;
    });

    // Custom renderer for task list items
    md.renderer.rules.task_list = (tokens, idx) => {
      const token = tokens[idx];
      const checked = token.meta?.checked ? 'checked' : '';
      return `<input type="checkbox" disabled ${checked} class="task-list-checkbox" />`;
    };

    // Render markdown
    let html = md.render(content);

    // Post-process HTML to handle TODO: markers with titles
    // Match TODO: followed by text within inline content
    html = html.replace(/TODO:\s*([^\<]*)/g, (match, title) => {
      if (title && title.trim()) {
        return `<span class="todo-marker">TODO:</span> <span class="todo-title">${title}</span>`;
      } else {
        return `<span class="todo-marker">TODO:</span>`;
      }
    });

    return html;
  } catch (err) {
    logger.error('Error rendering markdown:', err.message);
    throw err;
  }
});

/**
 * EXIF: Extract image metadata from a file using sharp.
 * Returns exif fields if found, or null if file has no EXIF / is not an image.
 */
ipcMain.handle('get-exif-data', async (event, filePath) => {
  try {
    if (!filePath || typeof filePath !== 'string') {
      return { success: false, exif: null };
    }
    if (!fsSync.existsSync(filePath)) {
      return { success: false, exif: null };
    }

    const sharp = require('sharp');
    const meta = await sharp(filePath).metadata();
    if (!meta) {
      return { success: true, exif: null };
    }

    const exif = meta.exif ? require('sharp').metadata : null;

    // sharp exposes the parsed EXIF fields directly on metadata for common tags
    const result = {};

    if (meta.width)             result.width            = meta.width;
    if (meta.height)            result.height           = meta.height;
    if (meta.format)            result.format           = meta.format;
    if (meta.space)             result.colorSpace       = meta.space;
    if (meta.channels)          result.channels         = meta.channels;
    if (meta.density)           result.density          = `${meta.density} PPI`;
    if (meta.hasProfile)        result.hasIccProfile    = meta.hasProfile ? 'Yes' : 'No';
    if (meta.orientation)       result.orientation      = meta.orientation;

    // Parse raw EXIF buffer with exif-reader if available, otherwise surface what sharp provides
    if (meta.exif) {
      try {
        const ExifReader = require('exif-reader');
        const parsed = ExifReader(meta.exif);
        const image   = parsed.image   || {};
        const photo   = parsed.Photo   || parsed.exif || {};
        const gps     = parsed.GPSInfo || parsed.gps  || {};

        if (image.Make)              result.make              = String(image.Make);
        if (image.Model)             result.model             = String(image.Model);
        if (image.Software)          result.software          = String(image.Software);
        if (image.Artist)            result.artist            = String(image.Artist);
        if (image.Copyright)         result.copyright         = String(image.Copyright);
        if (image.DateTime)          result.dateTime          = String(image.DateTime);
        if (photo.DateTimeOriginal)  result.dateTimeOriginal  = String(photo.DateTimeOriginal);
        if (photo.ExposureTime)      result.exposureTime      = String(photo.ExposureTime);
        if (photo.FNumber)           result.fNumber           = String(photo.FNumber);
        if (photo.ISOSpeedRatings)   result.iso               = String(photo.ISOSpeedRatings);
        if (photo.FocalLength)       result.focalLength       = String(photo.FocalLength);
        if (photo.Flash !== undefined) result.flash           = String(photo.Flash);
        if (photo.ExposureProgram !== undefined) result.exposureProgram = String(photo.ExposureProgram);
        if (photo.WhiteBalance !== undefined)    result.whiteBalance    = String(photo.WhiteBalance);
        if (gps.GPSLatitude && gps.GPSLongitude) {
          result.gpsLatitude  = String(gps.GPSLatitude);
          result.gpsLongitude = String(gps.GPSLongitude);
          if (gps.GPSLatitudeRef)  result.gpsLatRef  = String(gps.GPSLatitudeRef);
          if (gps.GPSLongitudeRef) result.gpsLonRef  = String(gps.GPSLongitudeRef);
          if (gps.GPSAltitude)     result.gpsAltitude = String(gps.GPSAltitude);
        }
      } catch (_) {
        // exif-reader not installed or parse failed — image geometry from sharp is still returned
      }
    }

    const hasData = Object.keys(result).length > 0;
    return { success: true, exif: hasData ? result : null };
  } catch (err) {
    logger.error('Error reading EXIF data:', err.message);
    return { success: false, exif: null };
  }
});

// ============================================
// Custom Actions
// ============================================

/**
 * Custom Actions: Return all configured actions
 */
ipcMain.handle('get-custom-actions', () => {
  try {
    return customActions.getCustomActions();
  } catch (err) {
    logger.error('Error getting custom actions:', err.message);
    return [];
  }
});

/**
 * Custom Actions: Save (create or update) an action.
 * For script-type executables, the checksum is (re-)computed automatically.
 */
ipcMain.handle('save-custom-action', (event, entry) => {
  try {
    const saved = customActions.saveCustomAction(entry);
    return { success: true, action: saved };
  } catch (err) {
    logger.error('Error saving custom action:', err.message);
    return { success: false, error: err.message };
  }
});

/**
 * Custom Actions: Delete an action by id
 */
ipcMain.handle('delete-custom-action', (event, id) => {
  try {
    customActions.deleteCustomAction(id);
    return { success: true };
  } catch (err) {
    logger.error('Error deleting custom action:', err.message);
    return { success: false, error: err.message };
  }
});

/**
 * Custom Actions: Verify the checksum of a script-type action.
 * Returns { valid, current, isScriptType, storedChecksum, checksumUpdatedAt }
 */
ipcMain.handle('verify-custom-action', (event, id) => {
  try {
    const actions = customActions.getCustomActions();
    const action = actions.find(a => a.id === id);
    if (!action) return { success: false, error: 'Action not found' };
    const result = customActions.verifyChecksum(action);
    return { success: true, ...result, storedChecksum: action.checksum, checksumUpdatedAt: action.checksumUpdatedAt };
  } catch (err) {
    logger.error('Error verifying custom action:', err.message);
    return { success: false, error: err.message };
  }
});

/**
 * Custom Actions: Execute an action against a file path.
 * Uses execFile (no shell) for security. The file path is always the last argument.
 */
ipcMain.handle('run-custom-action', async (event, { actionId, filePath }) => {
  try {
    const actions = customActions.getCustomActions();
    const action = actions.find(a => a.id === actionId);
    if (!action) return { success: false, error: 'Action not found' };

    const executable = action.executable;
    const scriptArgs = Array.isArray(action.args) ? action.args : [];

    if (!fsSync.existsSync(executable)) {
      return { success: false, error: `Executable not found: ${executable}` };
    }
    if (!fsSync.existsSync(filePath)) {
      return { success: false, error: `File not found: ${filePath}` };
    }

    logger.info(`[CUSTOM ACTION] "${action.label}" | ${executable} ${[...scriptArgs, filePath].join(' ')}`);

    const timeoutSeconds = Number.isFinite(Number(action.timeoutSeconds))
      ? Math.max(1, Math.trunc(Number(action.timeoutSeconds)))
      : customActions.getDefaultTimeoutSeconds();

    return new Promise((resolve) => {
      execFile(
        executable,
        [...scriptArgs, filePath],
        {
          shell: false,
          timeout: timeoutSeconds * 1000,
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: false,
          encoding: 'utf8',
          cwd: getSafeWorkingDirectory(filePath)
        },
        (error, stdout, stderr) => {
          if (error) {
            const detail = [];
            if (error.code !== undefined) detail.push(`exit code ${error.code}`);
            if (stderr && stderr.trim()) detail.push(`stderr: ${stderr.trim()}`);
            else if (stdout && stdout.trim()) detail.push(`stdout: ${stdout.trim()}`);
            logger.error(`[CUSTOM ACTION] Failed: ${error.message}${detail.length ? ' | ' + detail.join(' | ') : ''}`);
            resolve({ success: false, error: error.message, stdout: stdout || '', stderr: stderr || '' });
          } else {
            logger.info(`[CUSTOM ACTION] Success: "${action.label}"`);
            resolve({ success: true, stdout: stdout || '', stderr: stderr || '' });
          }
        }
      );
    });
  } catch (err) {
    logger.error('Error running custom action:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('run-custom-action-in-terminal', async (event, { actionId, filePath, terminalId }) => {
  try {
    const actions = customActions.getCustomActions();
    const action = actions.find(a => a.id === actionId);
    if (!action) return { success: false, error: 'Action not found' };

    const executable = action.executable;
    if (!fsSync.existsSync(executable)) {
      return { success: false, error: `Executable not found: ${executable}` };
    }
    if (!fsSync.existsSync(filePath)) {
      return { success: false, error: `File not found: ${filePath}` };
    }

    const ptyProcess = ptyMap.get(String(terminalId));
    if (!ptyProcess) {
      return { success: false, error: 'Terminal session not found' };
    }

    const workingDirectory = getSafeWorkingDirectory(filePath);
    const command = buildTerminalCommand(action, filePath);

    logger.info(`[CUSTOM ACTION] Terminal run: "${action.label}" | ${executable} ${[...(action.args || []), filePath].join(' ')}`);

    if (process.platform === 'win32') {
      ptyProcess.write(`cd /d ${quoteForCommandShell(workingDirectory)}\r`);
    } else {
      ptyProcess.write(`cd ${quoteForPosixShell(workingDirectory)}\r`);
    }
    ptyProcess.write(command);

    return { success: true };
  } catch (err) {
    logger.error('Error running custom action in terminal:', err.message);
    return { success: false, error: err.message };
  }
});

/**
 * File picker dialog (used by Custom Actions settings form)
 */
ipcMain.handle('pick-file', async (event, { filters, defaultPath } = {}) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      defaultPath: defaultPath || os.homedir(),
      filters: filters || [{ name: 'All Files', extensions: ['*'] }],
      properties: ['openFile']
    });
    return result.filePaths[0] || null;
  } catch (err) {
    logger.error('Error showing file picker:', err.message);
    return null;
  }
});

// ============================================
// Terminal (node-pty)
// ============================================

const ptyMap = new Map(); // id → IPty
let ptyIdCounter = 0;

ipcMain.handle('terminal-create', (event, cwd) => {
  const id = String(++ptyIdCounter);
  const shell = getTerminalShell();

  const safeCwd = getSafeWorkingDirectory(cwd);

  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: safeCwd,
    env: process.env
  });

  ptyProcess.onData(data => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-output', { id, data });
    }
  });

  ptyProcess.onExit(() => {
    ptyMap.delete(id);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-exit', { id });
    }
  });

  ptyMap.set(id, ptyProcess);
  logger.info(`[TERMINAL] Created session ${id} in ${safeCwd}`);
  return { id };
});

ipcMain.handle('terminal-input', (event, { id, data }) => {
  const ptyProcess = ptyMap.get(id);
  if (ptyProcess) ptyProcess.write(data);
});

ipcMain.handle('terminal-resize', (event, { id, cols, rows }) => {
  const ptyProcess = ptyMap.get(id);
  if (ptyProcess) ptyProcess.resize(cols, rows);
});

ipcMain.handle('terminal-destroy', (event, { id }) => {
  const ptyProcess = ptyMap.get(id);
  if (ptyProcess) {
    try { ptyProcess.kill(); } catch (_) {}
    ptyMap.delete(id);
    logger.info(`[TERMINAL] Destroyed session ${id}`);
  }
  return { success: true };
});

// ============================================
// Background Refresh (backend-driven)
// ============================================

let bgRefreshTimer = null;
const bgWatchedPaths = new Map(); // panelId → dirPath

function startBackgroundRefresh(enabled, interval) {
  if (bgRefreshTimer) {
    clearInterval(bgRefreshTimer);
    bgRefreshTimer = null;
  }
  if (enabled && interval > 0) {
    bgRefreshTimer = setInterval(() => {
      for (const [panelId, dirPath] of bgWatchedPaths) {
        try {
          const result = doScanDirectoryWithComparison(dirPath, false, true);
          if (result.success && mainWindow) {
            if (result.alertsCreated) {
              const newCount = db.getUnacknowledgedAlertCount();
              mainWindow.webContents.send('alert-count-updated', { count: newCount });
            }
            if (result.hasChanges) {
              mainWindow.webContents.send('directory-changed', { panelId, dirPath });
            }
          }
        } catch (err) {
          logger.error(`Background refresh error for panel ${panelId} (${dirPath}):`, err.message);
        }
      }
    }, interval * 1000);
    logger.info(`Background refresh started at ${interval}s intervals`);
  }
}

ipcMain.handle('start-background-refresh', (event, { enabled, interval }) => {
  startBackgroundRefresh(enabled, interval);
  return { success: true };
});

ipcMain.handle('stop-background-refresh', () => {
  if (bgRefreshTimer) {
    clearInterval(bgRefreshTimer);
    bgRefreshTimer = null;
    logger.info('Background refresh stopped');
  }
  return { success: true };
});

ipcMain.handle('register-watched-path', (event, { panelId, dirPath }) => {
  bgWatchedPaths.set(panelId, dirPath);
  return { success: true };
});

ipcMain.handle('unregister-watched-path', (event, { panelId }) => {
  bgWatchedPaths.delete(panelId);
  return { success: true };
});

/**
 * Alert Rule Matching: Returns the first enabled rule that matches all conditions, or null.
 *
 * @param {Array}       rules            - Alert rule objects from DB
 * @param {string}      eventType        - fileAdded | fileRemoved | fileRenamed | fileModified | fileChanged
 * @param {string}      category         - Category name for the directory
 * @param {string|null} dirTagsJson      - JSON string array of directory tags (or null)
 * @param {string|null} fileAttributesJson - JSON string map of file attributes (or null)
 * @returns {object|null} First matching rule or null
 */
function doesEventMatchRules(rules, eventType, category, dirTagsJson, fileAttributesJson) {
  for (const rule of rules) {
    if (!rule.enabled) continue;

    // Check event type
    let events;
    try { events = JSON.parse(rule.events); } catch { continue; }
    if (!Array.isArray(events) || !events.includes(eventType)) continue;

    if (!doesRuleMatchFilters(rule, category, dirTagsJson, fileAttributesJson)) {
      continue;
    }

    return rule; // First matching rule
  }
  return null;
}

/**
 * Core scan logic (shared by IPC handler and background refresh timer)
 */
function doScanDirectoryWithComparison(dirPath, isManualNavigation = true, isBackgroundRefresh = false, options = {}) {
  try {
    // Validate path parameter
    if (!dirPath || typeof dirPath !== 'string') {
      logger.error(`scan-directory-with-comparison: Invalid path - received ${typeof dirPath}`);
      return { success: false, error: 'Directory path must be a valid string' };
    }
    
    const normalizedPath = dirPath.trim();
    if (!normalizedPath) {
      logger.error('scan-directory-with-comparison: Empty path provided');
      return { success: false, error: 'Directory path cannot be empty' };
    }
    
    // Get directory inode to track the directory itself
    const dirStats = fs.getStats(normalizedPath);
    if (!dirStats) {
      return { success: false, error: 'Unable to read directory stats' };
    }

    const dirInode = dirStats.inode;

    // Get category for this directory
    const category = categories.getCategoryForDirectory(normalizedPath);
    const categoryName = category ? category.name : 'Default';

    // Create or get the directory entry (returns dir_id)
    const dirId = db.getOrCreateDirectory(normalizedPath, dirInode, categoryName);
    db.updateDirectoryParent(normalizedPath, db.getParentDirectoryId(normalizedPath));
    db.updateDirectoryObservation(
      normalizedPath,
      options.observationSource || (isManualNavigation ? 'manual' : isBackgroundRefresh ? 'background-refresh' : 'scan')
    );

    // Load alert rules once for this scan pass
    let alertRules = [];
    try { alertRules = db.getAlertRules(); } catch (e) { /* non-fatal */ }
    const dirTagsJson = db.getTagsForDirectoryId(dirId);
    let alertsCreated = 0;

    // Create/update dot entry for the directory itself
    db.upsertFile({
      inode: dirInode,
      dir_id: dirId,
      filename: '.',
      dateModified: dirStats.dateModified,
      dateCreated: dirStats.dateCreated,
      size: 0,
      mode: dirStats.mode ?? null
    });

    // IMPORTANT: Get existing database records BEFORE any modifications
    const existingDbFiles = db.getFilesByDirId(dirId);
    const dbFileMap = new Map(existingDbFiles.map(f => [f.inode, f]));

    // On background refresh, skip files already known to be permErrors so we
    // don't re-stat them (and re-log warnings) every refresh cycle.
    const ignoreFilenames = isBackgroundRefresh
      ? existingDbFiles.filter(f => f.inode.startsWith('-1:')).map(f => f.filename)
      : [];

    // Pre-remove ignored permError entries from dbFileMap so they are not
    // treated as orphaned/deleted during the missing-files pass.
    for (const filename of ignoreFilenames) {
      dbFileMap.delete(`-1:${filename}`);
    }

    // Read all filesystem entries (folders + files)
    const entries = fs.readDirectory(normalizedPath, ignoreFilenames);
    const entriesWithChanges = [];

    for (const entry of entries) {
      // Permission error entries: always persist in DB; hide from renderer on
      // background refresh to avoid repetitive UI churn.
      if (entry.permError) {
        const permErrMode = -1;
        const existingPermErr = dbFileMap.get(entry.inode);

        db.upsertFile({
          inode: entry.inode,
          dir_id: dirId,
          filename: entry.filename,
          dateModified: null,
          dateCreated: null,
          size: 0,
          mode: permErrMode
        });

        const permErrFileRecord = db.getFileByInode(entry.inode, dirId);
        if (permErrFileRecord && (!existingPermErr || existingPermErr.mode !== permErrMode)) {
          try {
            db.insertFileHistory(entry.inode, dirId, permErrFileRecord.id, {
              filename: entry.filename,
              status: 'permError',
              mode: permErrMode
            });
          } catch (err) {
            logger.error(`Error recording permission history for ${entry.filename}:`, err.message);
          }
        }

        dbFileMap.delete(entry.inode);

        if (!isBackgroundRefresh) {
          entriesWithChanges.push({
            ...entry,
            changeState: 'permError',
            dir_id: dirId,
            mode: permErrMode
          });
        }
        continue;
      }

      if (!entry.isDirectory) {
        // If a permission-error placeholder exists for this filename, remove it
        // now that we can stat the file again.
        const stalePermErrInode = `-1:${entry.filename}`;
        if (dbFileMap.has(stalePermErrInode)) {
          db.deleteFile(stalePermErrInode, dirId);
          dbFileMap.delete(stalePermErrInode);
        }

        // For files, determine change state
        const dbFile = dbFileMap.get(entry.inode);
        let changeState = 'unchanged';
        const wasRenamed = !!(dbFile && entry.filename !== dbFile.filename);

        if (!dbFile) {
          // New file
          changeState = 'new';
        } else if (dbFile.dateModified !== entry.dateModified) {
          // Date modified changed
          changeState = 'dateModified';
        } else if ((dbFile.mode ?? null) !== (entry.mode ?? null)) {
          // File mode changed (permissions / attributes)
          changeState = 'modeChanged';
        }

        // If category has checksum enabled, mark file for checksum calculation only when needed:
        // - new file (no DB record yet)
        // - dateModified changed (content may have changed, recalculate)
        // - no stored checksum (first-time calculation for an existing file)
        if (category && category.enableChecksum) {
          const needsChecksum = !dbFile ||
                                changeState === 'dateModified' ||
                                !dbFile.checksumValue;
          if (needsChecksum) {
            changeState = 'checksumPending';
          }
        }

        entriesWithChanges.push({
          ...entry,
          changeState,
          dir_id: dirId,
          checksumValue: (dbFile && dbFile.checksumValue) ? dbFile.checksumValue : null,
          checksumStatus: (dbFile && dbFile.checksumStatus) ? dbFile.checksumStatus : null,
          perms: entry.perms || { read: false, write: false },
          mode: entry.mode ?? null,
          tags: (dbFile && dbFile.tags) ? dbFile.tags : null,
          attributes: (dbFile && dbFile.attributes) ? dbFile.attributes : null,
          wasRenamed,
          previousFilename: wasRenamed ? dbFile.filename : null
        });
        
        // Mark as processed
        dbFileMap.delete(entry.inode);
      } else {
        // For directories, only mark as new if the directory itself is new (not in dirs table)
        const existingDir = db.getDirectory(entry.path);
        let changeState = 'unchanged';

        if (!existingDir) {
          // New directory - create entry in dirs table
          changeState = 'new';
          db.getOrCreateDirectory(entry.path, entry.inode, 'Default');
        }
        db.updateDirectoryParent(entry.path, db.getParentDirectoryId(entry.path));
        // Note: Don't check for existing dot files to determine changeState - subdirectories'
        // dot files are stored in their own directory entry (different dir_id), not in parent

        entriesWithChanges.push({
          ...entry,
          changeState,
          initials: existingDir ? (existingDir.initials || null) : null,
          perms: entry.perms || { read: true, write: false },
          mode: entry.mode ?? null,
          tags: existingDir ? db.getTagsForDirectory(entry.path) : null,
          attributes: (() => {
            if (!existingDir) return null;
            const dotFile = db.getFileByFilename(existingDir.id, '.');
            return (dotFile && dotFile.attributes) ? dotFile.attributes : null;
          })()
        });
      }
    }

    // Upsert all files with their new data and track changes in file_history
    for (const entry of entriesWithChanges) {
      // Permission error entries are persisted earlier in the scan loop.
      if (entry.changeState === 'permError') continue;

      if (!entry.isDirectory) {
        const dbFile = existingDbFiles.find(f => f.inode === entry.inode);
        
        // Upsert the file
        db.upsertFile({
          inode: entry.inode,
          dir_id: dirId,
          filename: entry.filename,
          dateModified: entry.dateModified,
          dateCreated: entry.dateCreated,
          size: entry.size,
          mode: entry.mode ?? null
        });

        // Get the file record to get its ID for history tracking
        const fileRecord = db.getFileByInode(entry.inode, dirId);
        if (!fileRecord) {
          logger.error(`Failed to retrieve file record after upsert for ${entry.filename}`);
          continue;
        }

        // Track file changes in file_history
        if (!dbFile) {
          // First encounter: store all file metadata
          try {
            db.insertFileHistory(entry.inode, dirId, fileRecord.id, {
              filename: entry.filename,
              dateModified: entry.dateModified,
              filesizeBytes: entry.size,
              mode: entry.mode ?? null
            });
          } catch (err) {
            logger.error(`Error recording file history for new file ${entry.filename}:`, err.message);
          }
          // Alert: fileAdded
          try {
            const addedRule = doesEventMatchRules(alertRules, 'fileAdded', categoryName, dirTagsJson, entry.attributes || null);
            if (addedRule) {
              db.insertAlert(addedRule.id, null, 'fileAdded', entry.filename, categoryName, dirId, entry.inode, null, null);
              alertsCreated++;
            }
          } catch (alertErr) { logger.error(`Error creating fileAdded alert for ${entry.filename}:`, alertErr.message); }
        } else {
          const modeChanged = (dbFile.mode ?? null) !== (entry.mode ?? null);
          const dateChanged = dbFile.dateModified !== entry.dateModified;

          if (dateChanged || modeChanged) {
            const historyPayload = {};
            if (dateChanged) historyPayload.dateModified = entry.dateModified;
            if (modeChanged) historyPayload.mode = entry.mode ?? null;

            try {
              db.insertFileHistory(entry.inode, dirId, fileRecord.id, historyPayload);
            } catch (err) {
              logger.error(`Error recording file history for ${entry.filename}:`, err.message);
            }
          }
          // Alert: fileModified (date change)
          if (dateChanged) {
            try {
              const modRule = doesEventMatchRules(alertRules, 'fileModified', categoryName, dirTagsJson, entry.attributes || null);
              if (modRule) {
                db.insertAlert(modRule.id, null, 'fileModified', entry.filename, categoryName, dirId, entry.inode, null, null);
                alertsCreated++;
              }
            } catch (alertErr) { logger.error(`Error creating fileModified alert for ${entry.filename}:`, alertErr.message); }
          }
          // Alert: fileRenamed
          if (entry.wasRenamed) {
            try {
              const renameHistResult = db.insertFileHistory(entry.inode, dirId, fileRecord.id, {
                filename: entry.filename,
                previousFilename: entry.previousFilename
              });
              const renameRule = doesEventMatchRules(alertRules, 'fileRenamed', categoryName, dirTagsJson, entry.attributes || null);
              if (renameRule) {
                db.insertAlert(renameRule.id, renameHistResult.lastInsertRowid, 'fileRenamed', entry.filename, categoryName, dirId, entry.inode, entry.previousFilename, entry.filename);
                alertsCreated++;
              }
            } catch (alertErr) { logger.error(`Error creating fileRenamed alert for ${entry.filename}:`, alertErr.message); }
          }
        }

        // Sync checksumStatus with category's tracking setting
        if (!category || !category.enableChecksum) {
          // Checksum tracking is disabled for this directory's category.
          // If the file previously had a checksum calculated (or errored), mark it untracked
          // and record the transition in history so the grid reflects the change.
          // If checksumStatus is already null (never tracked), silently initialize to 'untracked'.
          const prevStatus = dbFile ? dbFile.checksumStatus : null;
          if (prevStatus === 'calculated' || prevStatus === 'error') {
            try {
              db.updateFileChecksum(entry.inode, dirId, null, 'untracked');
              db.insertFileHistory(entry.inode, dirId, fileRecord.id, {
                checksumStatus: 'untracked'
              });
            } catch (err) {
              logger.error(`Error marking checksum untracked for ${entry.filename}:`, err.message);
            }
          } else if (prevStatus === null) {
            // First scan for this file with no tracking — silently initialize
            try {
              db.updateFileChecksum(entry.inode, dirId, null, 'untracked');
            } catch (err) {
              logger.error(`Error initializing checksum as untracked for ${entry.filename}:`, err.message);
            }
          }
          // prevStatus === 'untracked' or 'manual' → already correct, no-op
          // 'manual' means the user explicitly requested a one-off calculation; preserve it.
        }
      } else {
        // Handle subdirectory dot entries
        const existingDir = db.getDirectory(entry.path);
        let subDirId;
        if (!existingDir) {
          // New subdirectory - create entry in dirs table
          subDirId = db.getOrCreateDirectory(entry.path, entry.inode, 'Default');
        } else {
          // Get existing directory's ID
          subDirId = existingDir.id;
        }
        
        const subDirCategory = categories.getCategoryForDirectory(entry.path) || category;
        
        // Create or update dot placeholder file for directory with its own dir_id
        db.upsertFile({
          inode: entry.inode,
          dir_id: subDirId,
          filename: '.',
          dateModified: entry.dateModified,
          dateCreated: entry.dateCreated,
          size: 0,
          mode: entry.mode ?? null
        });

        // Get the dot file record for history tracking
        const dotFileRecord = db.getFileByInode(entry.inode, subDirId);
        if (dotFileRecord) {
          try {
            // Only insert history if this is actually a NEW directory (first time in dirs table)
            if (!existingDir) {
              // First time seeing this directory - record it in history
              db.insertFileHistory(entry.inode, subDirId, dotFileRecord.id, {
                dirname: path.basename(entry.path),
                category: subDirCategory ? subDirCategory.name : 'Default'
              });
            }
          } catch (err) {
            logger.error(`Error recording directory history for ${entry.path}:`, err.message);
          }
        }
        
        // Mark as processed
        dbFileMap.delete(entry.inode);
      }
    }

    // Process missing files: check for moves vs orphans
    const orphanedEntries = [];
    for (const [inode, dbFile] of dbFileMap) {
      try {
        // Skip "." entries - they represent the directory itself and should be ignored
        if (dbFile.filename === '.') {
          continue;
        }
        
        // Check if this inode exists in another directory (i.e., file moved)
        const movedFileRecord = db.findInodeInOtherDirectories(inode, dirId);
        
        if (movedFileRecord) {
          // File moved to another directory
          const newDirId = movedFileRecord.dir_id_match;
          
          // Create orphan record to track the move
          const orphanResult = db.createOrphan(dirId, dbFile.filename, inode);
          const orphanId = orphanResult.lastID;
          
          // Update orphan with the new location
          db.updateOrphanNewLocation(orphanId, newDirId);
          
          // Add to entries as 'moved' so it displays with special icon
          orphanedEntries.push({
            inode: inode,
            filename: dbFile.filename,
            isDirectory: false,
            size: dbFile.size,
            dateModified: dbFile.dateModified,
            dateCreated: dbFile.dateCreated,
            mode: dbFile.mode ?? null,
            path: path.join(dirPath, dbFile.filename),
            changeState: 'moved',
            orphan_id: orphanId,
            new_dir_id: newDirId
          });
          
          logger.info(`File ${dbFile.filename} detected as moved from ${dirPath}`);
        } else {
          // File not found anywhere - it's orphaned/deleted
          
          // Create orphan record
          const orphanResult = db.createOrphan(dirId, dbFile.filename, inode);
          const orphanId = orphanResult.lastID;
          
          // Record deletion in history before marking as orphan
          try {
            db.insertFileHistory(inode, dirId, dbFile.id, {
              filename: dbFile.filename,
              status: 'orphan'
            });
          } catch (err) {
            logger.error(`Error recording orphan history for ${dbFile.filename}:`, err.message);
          }
          // Alert: fileRemoved
          try {
            const removedRule = doesEventMatchRules(alertRules, 'fileRemoved', categoryName, dirTagsJson, null);
            if (removedRule) {
              db.insertAlert(removedRule.id, null, 'fileRemoved', dbFile.filename, categoryName, dirId, inode, null, null);
              alertsCreated++;
            }
          } catch (alertErr) { logger.error(`Error creating fileRemoved alert for ${dbFile.filename}:`, alertErr.message); }

          // Add to entries as 'orphan' so it displays as red text
          orphanedEntries.push({
            inode: inode,
            filename: dbFile.filename,
            isDirectory: false,
            size: dbFile.size,
            dateModified: dbFile.dateModified,
            dateCreated: dbFile.dateCreated,
            mode: dbFile.mode ?? null,
            path: path.join(dirPath, dbFile.filename),
            changeState: 'orphan',
            orphan_id: orphanId
          });
          
          logger.info(`File ${dbFile.filename} marked as orphan in ${dirPath}`);
        }
      } catch (err) {
        logger.error(`Error processing missing file ${dbFile.filename}:`, err.message);
      }
    }

    // Add orphaned entries to the entries list
    entriesWithChanges.push(...orphanedEntries);

    // Add the "." current directory entry to the results
    // (it's stored in DB but not in filesystem, so we need to add it manually)
    const dotFileRecord = db.getFileByInode(dirInode, dirId);
    if (dotFileRecord && dotFileRecord.filename === '.') {
      // Read current dir record to get saved initials
      const dirRecord = db.getDirectory(normalizedPath);
      entriesWithChanges.unshift({
        inode: dirInode,
        filename: '.',
        isDirectory: true, // Treat "." as a directory entry
        size: 0,
        dateModified: dirStats.dateModified,
        dateCreated: dirStats.dateCreated,
        mode: dirStats.mode ?? null,
        perms: dirStats.perms || { read: true, write: false },
        path: dirPath,
        changeState: 'unchanged',
        initials: dirRecord ? (dirRecord.initials || null) : null,
        tags: dotFileRecord.tags || null,
        attributes: dotFileRecord.attributes || null,
        orphan_id: null,
        new_dir_id: null
      });
    }

    // Resolve which entries have notes attached (for notes indicator in grid)
    let filesWithNotes = new Set();
    let localNotesContent = '';
    let localNotesSections = {};
    try {
      const notesFilePath = path.join(normalizedPath, 'notes.txt');
      if (fsSync.existsSync(notesFilePath)) {
        const notesContent = fsSync.readFileSync(notesFilePath, 'utf-8');
        localNotesSections = notesParser.parseNotesFileSections(notesContent);

        localNotesContent = notesContent;

        const headersArray = notesParser.extractAllHeaders(localNotesContent);
        filesWithNotes = new Set(headersArray);
        // Directories get checked later since we have to dive into subdirs for it
      }
    } catch (err) {
      logger.warn(`Error reading notes for directory ${normalizedPath}:`, err.message);
    }

    // Add hasNotes and todoCounts fields to each entry
    let dirNotesFilePath;
    let dirNotesContent;
    let directoryNotes;
    for (const entry of entriesWithChanges) {
      if (entry.isDirectory) {
        // For directories, check if it has directory-level notes
        if (entry.filename != '.') {
          dirNotesFilePath = path.join(normalizedPath, entry.filename, 'notes.txt');
          if (fsSync.existsSync(dirNotesFilePath)) {
            try {
              dirNotesContent = fsSync.readFileSync(dirNotesFilePath, 'utf-8');

              // (normalization deferred to write-back)
            } catch (err) {
              logger.warn(`Error reading notes for subdirectory ${entry.path}:`, err.message);
              dirNotesContent = '';
            }
            directoryNotes = notesParser.extractDirectoryNotes(dirNotesContent);
          } else {
            directoryNotes = '';
            dirNotesContent = '';
          }
        } else {
          // For the current directory's "." entry, use the already-read localNotesContent
          directoryNotes = notesParser.extractDirectoryNotes(localNotesContent);
          dirNotesContent = localNotesContent;
        }
        entry.hasNotes = !!directoryNotes && directoryNotes.trim().length > 0;

        // Compute todoCounts for the directory (from its __dir__ section)
        const dirSection = entry.filename === '.'
          ? (localNotesSections['__dir__'] || directoryNotes)
          : notesParser.extractDirectoryNotes(dirNotesContent || '');
        const dirTodoCounts = notesParser.countTodoItems(dirSection);
        entry.todoCounts = dirTodoCounts.total > 0 ? dirTodoCounts : null;
      } else {
        // For files, check if they have file-specific notes
        entry.hasNotes = filesWithNotes.has(entry.filename);

        // Compute todoCounts for the file (from its named section in localNotesContent)
        const fileSection = localNotesSections[entry.filename] || '';
        const fileTodoCounts = notesParser.countTodoItems(fileSection);
        entry.todoCounts = fileTodoCounts.total > 0 ? fileTodoCounts : null;
      }
    }

    // Count entries with actual changes (not 'unchanged')
    const changedEntries = entriesWithChanges.filter(e => e.changeState !== 'unchanged');
    const hasChanges = changedEntries.length > 0;

    // Log if browsing to a new directory (manual navigation) or if there are actual changes
    if (isManualNavigation || hasChanges) {
      logger.info(`Scanning directory: ${normalizedPath} - ${changedEntries.length} changes detected`);
    }

    return {
      success: true,
      count: entriesWithChanges.filter(e => !e.isDirectory).length,
      entries: entriesWithChanges,
      category: categoryName,
      categoryData: category,
      hasChanges: hasChanges,
      alertsCreated,
    };
  } catch (err) {
    logger.error('Error scanning directory with comparison:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * File Change Detection: Scan directory with comparison (IPC handler)
 */
ipcMain.handle('scan-directory-with-comparison', (event, dirPath, isManualNavigation = true) => {
  return doScanDirectoryWithComparison(dirPath, isManualNavigation);
});

/**
 * File Change Detection: Calculate checksum for a file
 */
ipcMain.handle('calculate-file-checksum', async (event, { filePath, inode, dirId, isManual = false }) => {
  const releaseChecksumSlot = await acquireChecksumSlot();
  try {
    // Retrieve previously stored checksum for comparison
    const existingChecksum = db.getFileChecksum(inode, dirId);
    const result = await checksum.compareChecksum(filePath, existingChecksum);

    if (result.error) {
      // Update with error status
      db.updateFileChecksum(inode, dirId, null, 'error');
      return { 
        success: false, 
        checksum: null, 
        status: 'error',
        changed: false,
        hadPreviousChecksum: existingChecksum !== null,
        error: result.error 
      };
    }

    // Use 'manual' status for on-demand calculations so scans won't reset the value
    const storedStatus = isManual ? 'manual' : 'calculated';

    // Update database with calculated checksum
    db.updateFileChecksum(inode, dirId, result.value, storedStatus);

    let notificationCreated = false;
    if (result.changed) {
      try {
        const filename = path.basename(filePath);
        const fileRecord = db.getFileByInode(inode, dirId);
        const dirRecord = db.getDirById(dirId);
        const categoryName = dirRecord
          ? categories.getCategoryResolutionForDirectory(dirRecord.dirname).categoryName
          : 'Default';
        if (fileRecord) {
          const historyResult = db.insertFileHistory(inode, dirId, fileRecord.id, {
            checksumValue: result.value,
            checksumStatus: storedStatus
          });
          // Only alert on actual content changes (not first-time initialization)
          if (existingChecksum !== null) {
            try {
              const csAlertRules = db.getAlertRules();
              const csTagsJson = dirRecord ? db.getTagsForDirectoryId(dirId) : null;
              const csAttrsJson = fileRecord ? fileRecord.attributes : null;
              const csRule = doesEventMatchRules(csAlertRules, 'fileChanged', categoryName, csTagsJson, csAttrsJson);
              if (csRule) {
                db.insertAlert(csRule.id, historyResult.lastInsertRowid, 'fileChanged', filename, categoryName, dirId, inode, existingChecksum, result.value);
                notificationCreated = true;
              }
            } catch (alertErr) {
              logger.error('Error creating fileChanged alert:', alertErr.message);
            }
          }
        }
      } catch (notifErr) {
        logger.error('Error creating checksum notification:', notifErr.message);
      }
    }

    return { 
      success: true, 
      checksum: result.value, 
      status: storedStatus,
      changed: result.changed,
      hadPreviousChecksum: existingChecksum !== null,
      notificationCreated,
      error: null 
    };
  } catch (err) {
    logger.error('Error calculating file checksum:', err.message);
    db.updateFileChecksum(inode, dirId, null, 'error');
    return { 
      success: false, 
      checksum: null, 
      status: 'error',
      changed: false,
      hadPreviousChecksum: false,
      error: err.message 
    };
  } finally {
    releaseChecksumSlot();
  }
});

/**
 * File Change Detection: Resolve a file record and its category config from a full path
 */
ipcMain.handle('get-file-record-by-path', (event, { filePath }) => {
  try {
    const dirname = path.dirname(filePath);
    const basename = path.basename(filePath);
    const dirEntry = db.getDirectory(dirname);
    if (!dirEntry) {
      return { success: false, error: 'Directory not found in database' };
    }
    const fileRecord = db.getFileByFilename(dirEntry.id, basename);
    if (!fileRecord) {
      return { success: false, error: 'File not found in database' };
    }
    const category = categories.getCategoryForDirectory(dirname);
    return {
      success: true,
      inode: fileRecord.inode,
      dir_id: dirEntry.id,
      checksumValue: fileRecord.checksumValue,
      checksumStatus: fileRecord.checksumStatus,
      enableChecksum: category ? !!category.enableChecksum : false
    };
  } catch (err) {
    logger.error('Error getting file record by path:', err.message);
    return { success: false, error: err.message };
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

    // Get the current file data before updating
    const file = db.getFileByInode(inode, dir.id);
    if (!file) {
      return { success: false, error: 'File not found in database' };
    }

    // Update the file modification date in the files table
    db.updateFileModificationDate(inode, dir.id, newDateModified);

    // Record the acknowledgement in file_history
    try {
      db.insertFileHistory(inode, dir.id, file.id, {
        filename: file.filename,
        dateModified: newDateModified
      });

      // Get the newly inserted record to set acknowledgedAt
      const latestHistory = db.getLatestFileHistory(inode);
      if (latestHistory) {
        db.updateFileHistoryAcknowledgement(latestHistory.id);
      }
    } catch (err) {
      logger.error(`Error recording acknowledgement in file_history for ${inode}:`, err.message);
      // Don't fail the overall update if history recording fails
    }

    return { success: true };
  } catch (err) {
    console.error('Error updating file modification date:', err);
    return { success: false, error: err.message };
  }
});

/**
 * Alerts: Get unacknowledged alerts (Summary tab)
 */
ipcMain.handle('get-alerts-summary', () => {
  try {
    return { success: true, data: db.getAlertsSummary() };
  } catch (err) {
    logger.error('Error retrieving alerts summary:', err.message);
    return { success: false, error: err.message };
  }
});

/**
 * Alerts: Get acknowledged alerts (History tab)
 */
ipcMain.handle('get-alerts-history', () => {
  try {
    return { success: true, data: db.getAlertsHistory() };
  } catch (err) {
    logger.error('Error retrieving alerts history:', err.message);
    return { success: false, error: err.message };
  }
});

/**
 * Alerts: Get unacknowledged count
 */
ipcMain.handle('get-unacknowledged-alert-count', () => {
  try {
    return { success: true, count: db.getUnacknowledgedAlertCount() };
  } catch (err) {
    logger.error('Error getting unacknowledged alert count:', err.message);
    return { success: true, count: 0 };
  }
});

/**
 * Alerts: Acknowledge a set of alerts with optional comment
 */
ipcMain.handle('acknowledge-alerts', (event, { ids, comment }) => {
  try {
    db.acknowledgeAlerts(ids, comment || null);
    const newCount = db.getUnacknowledgedAlertCount();
    return { success: true, newCount };
  } catch (err) {
    logger.error('Error acknowledging alerts:', err.message);
    return { success: false, error: err.message };
  }
});

/**
 * Alerts: Get all alert rules
 */
ipcMain.handle('get-alert-rules', () => {
  try {
    return { success: true, data: db.getAlertRules() };
  } catch (err) {
    logger.error('Error retrieving alert rules:', err.message);
    return { success: false, error: err.message };
  }
});

/**
 * Alerts: Save (create or update) an alert rule
 */
ipcMain.handle('save-alert-rule', (event, rule) => {
  try {
    const result = db.saveAlertRule(rule);
    return { success: true, id: result.id };
  } catch (err) {
    logger.error('Error saving alert rule:', err.message);
    return { success: false, error: err.message };
  }
});

/**
 * Alerts: Delete alert rules by ID array
 */
ipcMain.handle('delete-alert-rules', (event, { ids }) => {
  try {
    db.deleteAlertRules(ids);
    return { success: true };
  } catch (err) {
    logger.error('Error deleting alert rules:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-monitoring-rules', () => {
  try {
    return { success: true, data: db.getMonitoringRules() };
  } catch (err) {
    logger.error('Error retrieving monitoring rules:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('save-monitoring-rule', (event, rule) => {
  try {
    const result = db.saveMonitoringRule(rule);
    reconfigureActiveMonitoring();
    return { success: true, id: result.id };
  } catch (err) {
    logger.error('Error saving monitoring rule:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('delete-monitoring-rules', (event, { ids }) => {
  try {
    db.deleteMonitoringRules(ids);
    reconfigureActiveMonitoring();
    return { success: true };
  } catch (err) {
    logger.error('Error deleting monitoring rules:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('start-active-monitoring', async () => {
  reconfigureActiveMonitoring();
  await runMonitoringPass();
  return { success: true };
});

ipcMain.handle('stop-active-monitoring', () => {
  if (monitoringTimer) {
    clearInterval(monitoringTimer);
    monitoringTimer = null;
  }
  return { success: true };
});

/**
 * File History: Get all history records for a file by inode
 */
ipcMain.handle('get-file-history', (event, inode) => {
  try {
    const history = db.getFileHistory(inode);
    return { success: true, data: history };
  } catch (err) {
    logger.error('Error retrieving file history:', err.message);
    return { success: false, error: err.message };
  }
});

/**
 * Orphans: Acknowledge and remove an orphan record
 */
ipcMain.handle('acknowledge-orphan', (event, orphanId) => {
  try {
    db.deleteOrphan(orphanId);
    return { success: true };
  } catch (err) {
    logger.error(`Error acknowledging orphan ${orphanId}:`, err.message);
    return { success: false, error: err.message };
  }
});

/**
 * Database: Reinitialize database (clear all data and reset schema)
 */
ipcMain.handle('reinitialize-database', (event) => {
  try {
    logger.info('Reinitializing database...');
    
    // Close current database
    db.close();
    
    // Delete the database file
    const dbPath = path.join(os.homedir(), '.atlasexplorer', 'data.sqlite');
    const dbWalPath = dbPath + '-wal';
    const dbShmPath = dbPath + '-shm';
    
    if (fsSync.existsSync(dbPath)) {
      fsSync.unlinkSync(dbPath);
      logger.info('Deleted database file');
    }
    
    if (fsSync.existsSync(dbWalPath)) {
      fsSync.unlinkSync(dbWalPath);
    }
    
    if (fsSync.existsSync(dbShmPath)) {
      fsSync.unlinkSync(dbShmPath);
    }
    
    // Reinitialize database
    db.initialize();
    logger.info('Database reinitialized successfully');
    
    return { success: true, message: 'Database reinitialized successfully' };
  } catch (err) {
    logger.error('Error reinitializing database:', err.message);
    return { success: false, error: err.message };
  }
});

/**
 * Logging: Capture browser console output and write to log file
 * Uses ipcMain.on for fire-and-forget logging (no response needed)
 */
ipcMain.on('log-to-file', (event, { level, message, args }) => {
  try {
    logger.rendererLog(level, message, ...(args || []));
  } catch (err) {
    logger.error('Error logging from renderer:', err.message);
  }
});

// ============================================
// App lifecycle
// ============================================

app.on('ready', () => {
  // Disable the default menu to prevent Alt key from showing it
  Menu.setApplicationMenu(null);
  initialize();
  createWindow();

  // Register dev tools shortcuts since menu bar is hidden
  globalShortcut.register('F12', () => {
    if (mainWindow) {
      mainWindow.webContents.toggleDevTools();
    }
  });

  globalShortcut.register('Ctrl+Shift+I', () => {
    if (mainWindow) {
      mainWindow.webContents.toggleDevTools();
    }
  });
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
  // Unregister all global shortcuts
  globalShortcut.unregisterAll();
  db.close();
});
