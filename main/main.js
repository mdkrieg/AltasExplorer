const { app, BrowserWindow, ipcMain, nativeImage, Menu, globalShortcut, shell, session } = require('electron');
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
const todoAggregator = require('../src/todoAggregator');
const customActions = require('../src/customActions');
const layouts = require('../src/layouts');
const { execFile } = require('child_process');
const ffmpegBin = require('ffmpeg-static');
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

    // Block in-page navigation away from the local file (e.g. a link click inside rendered markdown)
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('file://')) {
        logger.warn('[SECURITY] Blocked navigation to:', url);
        event.preventDefault();
      }
    });

    // Block target="_blank" and any other attempt to open a new window
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      logger.warn('[SECURITY] Blocked new-window open for:', url);
      return { action: 'deny' };
    });

    mainWindow.webContents.on('crashed', () => {
      logger.error('Renderer process crashed');
    });

    mainWindow.webContents.on('unresponsive', () => {
      logger.warn('Renderer process became unresponsive');
    });

    // Capture renderer console output in the log file.
    // This catches errors that originate outside the preload.js override
    // (e.g. unhandled rejections surfaced by Electron, errors in module load, etc.)
    // Note: DevTools-internal messages like Autofill.enable are NOT capturable this way.
    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
      if (!message || message.includes('Autofill')) return; // skip DevTools noise
      const levelName = level === 0 ? 'INFO' : level === 1 ? 'WARN' : 'ERROR';
      logger.rendererLog(levelName, `[${sourceId}:${line}] ${message}`);
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
 * Reconcile any files left staged for deletion after a crash. If the file is
 * still present on disk the staging was aborted — roll back. If it is gone the
 * trashItem call completed but our DB cleanup did not — finalize (write the
 * audit entry and purge the rows).
 */
function reconcilePendingDeletions() {
  let pending;
  try {
    pending = db.getPendingDeletions();
  } catch (err) {
    logger.error('Error reading pending deletions for reconciliation:', err.message);
    return;
  }
  if (!pending || pending.length === 0) return;
  logger.info(`Reconciling ${pending.length} pending deletion(s) from previous session`);
  for (const row of pending) {
    try {
      const stillOnDisk = fsSync.existsSync(row.original_path);
      if (stillOnDisk) {
        db.rollbackFileDeletion(row.file_id);
        logger.info(`Rolled back pending deletion for ${row.original_path} (file still present)`);
      } else {
        try {
          db.insertFileHistory(row.inode, row.original_dir_id, row.file_id, 'fileRemoved', {
            filename: row.original_filename,
            status: 'deleted',
            source: 'user-app-recovered'
          });
        } catch (histErr) {
          logger.error(`Error writing recovered delete history for ${row.original_path}:`, histErr.message);
        }
        db.finalizeFileDeletion(row.file_id);
        try { db.deleteOrphanByFile(row.inode, row.original_dir_id); } catch (e) { /* ignore */ }
        logger.info(`Finalized pending deletion for ${row.original_path} (file missing from disk)`);
      }
    } catch (err) {
      logger.error(`Error reconciling pending deletion for ${row.original_path}:`, err.message);
    }
  }
}

/**
 * Initialize the application
 */
function initialize() {
  logger.info('Initializing application');
  syncIconAssets();
  db.initialize();
  reconcilePendingDeletions();
  try {
    const result = todoAggregator.refreshAll();
    logger.info(`TODO aggregator: refreshed ${result.changed}/${result.total} notes.txt files at startup`);
  } catch (err) {
    logger.error('TODO aggregator startup refresh failed:', err.message);
  }
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
    const { name, bgColor, textColor, description, patterns, enableChecksum, attributes: attrs, autoAssignCategory, displayMode } = categoryData;
    
    // Check if category exists
    const existing = categories.getCategory(name);
    
    if (existing) {
      // Update existing
      return categories.updateCategory(name, bgColor, textColor, patterns || [], description || '', enableChecksum || false, attrs || [], autoAssignCategory, displayMode || null);
    } else {
      // Create new
      return categories.createCategory(name, bgColor, textColor, patterns || [], description || '', enableChecksum || false, attrs || [], autoAssignCategory, displayMode || 'details');
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
    const { name, oldName, bgColor, textColor, patterns, description, enableChecksum, attributes: attrs, autoAssignCategory, displayMode } = categoryData;
    const updateName = name || oldName;
    
    // If name changed, delete old and create new
    if (oldName && name && oldName !== name) {
      categories.deleteCategory(oldName);
      return categories.createCategory(name, bgColor, textColor, patterns || [], description || '', enableChecksum || false, attrs || [], autoAssignCategory, displayMode || 'details');
    } else {
      // Just update
      return categories.updateCategory(updateName, bgColor, textColor, patterns || [], description || '', enableChecksum, attrs || [], autoAssignCategory, displayMode || null);
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
          const dirHistoryId = createStandaloneDirHistory(dirEntry, 'category-assignment', 0, 1, 'categoryChanged');
          db.insertFileHistory(dirEntry.inode, dirEntry.id, dotFile.id, 'categoryChanged', { category: categoryName }, dirHistoryId);
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
                const dirHistoryId = createStandaloneDirHistory(dirEntry, 'category-assignment', 0, 1, 'categoryChanged');
                db.insertFileHistory(dirEntry.inode, dirEntry.id, dotFile.id, 'categoryChanged', { category: categoryName }, dirHistoryId);
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
    const { name, description, type, default: defaultValue, options, copyable, appliesTo, global: isGlobal } = attrData;
    if (!name) throw new Error('Attribute name is required');
    const existing = attributes.getAttribute(name);
    if (existing) {
      return attributes.updateAttribute(name, description || '', type || 'String', defaultValue || '', options || [], copyable, appliesTo || 'Both', Boolean(isGlobal));
    } else {
      return attributes.createAttribute(name, description || '', type || 'String', defaultValue || '', options || [], copyable, appliesTo || 'Both', Boolean(isGlobal));
    }
  } catch (err) {
    logger.error('Error saving attribute:', err.message);
    throw err;
  }
});

ipcMain.handle('update-attribute', (event, attrData) => {
  try {
    const { name, oldName, description, type, default: defaultValue, options, copyable, appliesTo, global: isGlobal } = attrData;
    const updateName = name || oldName;
    if (oldName && name && oldName !== name) {
      attributes.deleteAttribute(oldName);
      return attributes.createAttribute(name, description || '', type || 'String', defaultValue || '', options || [], copyable, appliesTo || 'Both', Boolean(isGlobal));
    } else {
      return attributes.updateAttribute(updateName, description || '', type || 'String', defaultValue || '', options || [], copyable, appliesTo || 'Both', Boolean(isGlobal));
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
/**
 * Sync a tag addition/removal to the notes.txt file for an item.
 * Operates synchronously and silently skips if notes.txt or the section is absent.
 *
 * @param {string} filePath - Absolute path of the file or directory
 * @param {boolean} isDirectory - True if the item is a directory
 * @param {string} tagName - Tag name (no prefix)
 * @param {'promote'|'demote'} action - promote: #tag→@#tag, demote: @#tag→#tag
 */
function updateNotesTagSync(filePath, isDirectory, tagName, action) {
  const notesFilePath = isDirectory
    ? path.join(filePath, 'notes.txt')
    : path.join(path.dirname(filePath), 'notes.txt');
  const sectionKey = isDirectory ? '__dir__' : path.basename(filePath);

  if (!fsSync.existsSync(notesFilePath)) return;

  let existingContent;
  try {
    existingContent = fsSync.readFileSync(notesFilePath, 'utf-8');
  } catch (err) {
    logger.warn(`updateNotesTagSync: could not read ${notesFilePath}: ${err.message}`);
    return;
  }

  const sections = notesParser.parseNotesFileSections(existingContent);
  if (!(sectionKey in sections)) return;

  const original = sections[sectionKey];
  const updated = action === 'promote'
    ? notesParser.promoteTagInSection(original, tagName)
    : notesParser.demoteTagInSection(original, tagName);

  if (updated === original) return; // nothing changed

  const newContent = notesParser.writeNotesSection(existingContent, sectionKey, updated);
  try {
    fsSync.writeFileSync(notesFilePath, newContent, 'utf-8');
  } catch (err) {
    logger.warn(`updateNotesTagSync: could not write ${notesFilePath}: ${err.message}`);
  }
}

ipcMain.handle('add-tag-to-item', (event, { path: itemPath, tagName, isDirectory, inode, dir_id }) => {
  try {
    if (isDirectory) {
      db.addTagToDirectory(itemPath, tagName);
    } else {
      db.addTagToFile(inode, dir_id, tagName);
    }
    try { updateNotesTagSync(itemPath, isDirectory, tagName, 'promote'); } catch (err) {
      logger.warn(`add-tag-to-item: notes sync failed for '${tagName}': ${err.message}`);
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
ipcMain.handle('remove-tag-from-item', (event, { path: itemPath, tagName, isDirectory, inode, dir_id }) => {
  try {
    if (isDirectory) {
      db.removeTagFromDirectory(itemPath, tagName);
    } else {
      db.removeTagFromFile(inode, dir_id, tagName);
    }
    try { updateNotesTagSync(itemPath, isDirectory, tagName, 'demote'); } catch (err) {
      logger.warn(`remove-tag-from-item: notes sync failed for '${tagName}': ${err.message}`);
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
      .filter(f => /^user-.*\.(png|svg)$/i.test(f))
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
 * Directory Labels: Get all label fields (stored + resolved) for a directory
 */
ipcMain.handle('get-directory-labels', (event, dirPath) => {
  try {
    const dir = db.getDirectory(dirPath);
    if (!dir) {
      return {
        initials: null, initialsInherit: false, initialsForce: false,
        displayName: null, displayNameInherit: false, displayNameForce: false,
        resolvedInitials: null, initialsIsInherited: false,
        resolvedDisplayName: null, displayNameIsInherited: false,
        displayNameSourceDir: null
      };
    }
    const resolvedInitials = db.resolveDirectoryInitials(dirPath);
    const resolvedDisplayName = db.resolveDirectoryDisplayName(dirPath);
    return {
      initials: dir.initials || null,
      initialsInherit: Boolean(dir.initials_inherit),
      initialsForce: Boolean(dir.initials_force),
      displayName: dir.display_name || null,
      displayNameInherit: Boolean(dir.display_name_inherit),
      displayNameForce: Boolean(dir.display_name_force),
      resolvedInitials: resolvedInitials.value,
      initialsIsInherited: resolvedInitials.isInherited,
      resolvedDisplayName: resolvedDisplayName.value,
      displayNameIsInherited: resolvedDisplayName.isInherited,
      displayNameSourceDir: resolvedDisplayName.sourceDir
    };
  } catch (err) {
    logger.error('Error getting directory labels:', err.message);
    return null;
  }
});

/**
 * Directory Labels: Save label fields for a directory
 */
ipcMain.handle('save-directory-labels', (event, { dirPath, labels }) => {
  try {
    db.updateDirectoryLabels(dirPath, labels);
    return { success: true };
  } catch (err) {
    logger.error('Error saving directory labels:', err.message);
    return { success: false, error: err.message };
  }
});

/**
 * Window title: Set the main window title
 */
ipcMain.handle('set-window-title', (event, { title }) => {
  try {
    if (mainWindow) {
      mainWindow.setTitle(title || 'Atlas Explorer');
    }
    return { success: true };
  } catch (err) {
    logger.error('Error setting window title:', err.message);
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
 * TODO Aggregator: Get aggregated TODO data for the sidebar.
 * Shape: [ { groupLabel, sources: [ { notesPath, dirId, sectionKey, sourceDisplayName, items: [...] } ] } ]
 */
ipcMain.handle('get-todo-aggregates', async (event, opts = {}) => {
  try {
    return todoAggregator.getAggregates(opts);
  } catch (err) {
    logger.error('Error getting TODO aggregates:', err.message);
    throw err;
  }
});

/**
 * TODO Aggregator: Refresh a single notes.txt file (e.g. after a modal save).
 */
ipcMain.handle('refresh-todo-aggregate', async (event, { notesPath, dirId }) => {
  try {
    let resolvedDirId = dirId;
    if (resolvedDirId == null && notesPath) {
      const sep = notesPath.includes('\\') ? '\\' : '/';
      const dirname = notesPath.substring(0, notesPath.lastIndexOf(sep));
      const existingRow = db.getTodoNotesFile(notesPath);
      if (existingRow) {
        resolvedDirId = existingRow.dir_id;
      } else {
        const dirRow = db.getDirectory(dirname);
        if (dirRow) resolvedDirId = dirRow.id;
      }
    }
    if (resolvedDirId == null) {
      logger.warn(`refresh-todo-aggregate: could not resolve dir_id for ${notesPath}`);
      return { changed: false, notesFileId: null };
    }
    const result = todoAggregator.ensureAndRefresh(notesPath, resolvedDirId);
    if (result.changed && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('todo-aggregates-changed');
    }
    return result;
  } catch (err) {
    logger.error(`Error refreshing TODO aggregate for ${notesPath}: ${err.message}`);
    throw err;
  }
});

/**
 * TODO Aggregator: Refresh every known notes.txt (user-triggered refresh).
 */
ipcMain.handle('refresh-todo-aggregates', async () => {
  try {
    const result = todoAggregator.refreshAll();
    if (result.changed > 0 && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('todo-aggregates-changed');
    }
    return result;
  } catch (err) {
    logger.error('Error refreshing all TODO aggregates:', err.message);
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
 * Filesystem: Move items to trash using the DB trash-staging pattern.
 * For each file we first re-parent the files row into the trash sentinel dir
 * (so any concurrent scan of the original dir no longer sees the inode as a
 * missing/orphaned child), then call shell.trashItem. On success we finalize
 * (delete the row + staging record + any stale orphan row) and insert the
 * audit entry. On failure we roll back the row to its original dir.
 *
 * Accepts { path, inode, dir_id, isFolder } descriptors. Folders go to trash
 * but their DB rows are not yet staged/finalized (future work).
 */
ipcMain.handle('delete-items', async (event, items) => {
  if (!Array.isArray(items) || items.length === 0) {
    return { succeeded: [], failed: [] };
  }
  const succeeded = [];
  const failed = [];
  for (const item of items) {
    if (!item || !item.path) {
      failed.push({ path: String(item?.path || ''), error: 'Missing path' });
      continue;
    }

    let stagedFileId = null;
    let originalFilename = null;
    const canStage = !item.isFolder && item.inode && item.dir_id;

    if (canStage) {
      try {
        const staged = db.stageFileForDeletion(item.inode, item.dir_id, item.path);
        stagedFileId = staged.file_id;
        originalFilename = staged.filename;
      } catch (err) {
        logger.error(`Error staging deletion for ${item.path}:`, err.message);
        failed.push({ path: item.path, error: `Staging failed: ${err.message}` });
        continue;
      }
    }

    try {
      await shell.trashItem(item.path);
    } catch (err) {
      if (stagedFileId !== null) {
        try { db.rollbackFileDeletion(stagedFileId); }
        catch (rbErr) { logger.error(`Rollback failed for ${item.path}:`, rbErr.message); }
      }
      failed.push({ path: item.path, error: err?.message || 'Unknown error' });
      continue;
    }

    if (stagedFileId !== null) {
      try {
        db.insertFileHistory(item.inode, item.dir_id, stagedFileId, 'fileRemoved', {
          filename: originalFilename,
          status: 'deleted',
          source: 'user-app'
        });
      } catch (histErr) {
        logger.error(`Error recording delete history for ${item.path}:`, histErr.message);
      }
      try { db.finalizeFileDeletion(stagedFileId); }
      catch (finErr) { logger.error(`Error finalizing deletion for ${item.path}:`, finErr.message); }
      try { db.deleteOrphanByFile(item.inode, item.dir_id); }
      catch (orphErr) { logger.error(`Error removing stale orphan row for ${item.path}:`, orphErr.message); }
    }

    succeeded.push(item.path);
  }
  return { succeeded, failed };
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
 * Open an http/https URL in the OS default web browser.
 * Only http: and https: are accepted — all other schemes are rejected.
 */
ipcMain.handle('open-external-link', async (event, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    logger.warn('[SECURITY] Rejected open-external-link for invalid URL:', url);
    return { success: false, error: 'Only http and https URLs are permitted' };
  }
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (err) {
    logger.error('Error opening external link:', err.message);
    return { success: false, error: err.message };
  }
});

/**
 * Open a file in its default OS application.
 */
ipcMain.handle('open-in-default-app', async (event, filePath) => {
  try {
    const resolved = path.resolve(String(filePath));
    if (!fsSync.existsSync(resolved)) {
      return { success: false, error: `File not found: ${resolved}` };
    }
    const result = await shell.openPath(resolved);
    return result === '' ? { success: true } : { success: false, error: result };
  } catch (err) {
    logger.error('Error opening file in default app:', err.message);
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
// Grid Layout (per-directory column/sort state)
// ============================================

ipcMain.handle('save-dir-grid-layout', (event, { dirname, columns, sortData }) => {
  try {
    db.saveDirGridLayout(dirname, columns, sortData);
    return { success: true };
  } catch (err) {
    logger.error('Error saving dir grid layout:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-dir-grid-layout', (event, dirname) => {
  try {
    const layout = db.getDirGridLayout(dirname);
    return { success: true, layout };
  } catch (err) {
    logger.error('Error getting dir grid layout:', err.message);
    return { success: false, error: err.message };
  }
});

// ============================================
// Layout Save/Load (.aly files)
// ============================================

ipcMain.handle('save-layout-to-path', async (event, { filePath, layoutData, thumbnailBase64 }) => {
  try {
    let thumbnailBuffer;
    if (thumbnailBase64) {
      thumbnailBuffer = Buffer.from(thumbnailBase64, 'base64');
    } else {
      const sharp = require('sharp');
      const nimg = await mainWindow.webContents.capturePage();
      thumbnailBuffer = await sharp(nimg.toPNG()).resize(400).png().toBuffer();
    }
    layouts.saveLayout(filePath, layoutData, thumbnailBuffer);
    return { success: true, filePath };
  } catch (err) {
    logger.error('Error saving layout to path:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('capture-thumbnail', async () => {
  try {
    const sharp = require('sharp');
    const nimg = await mainWindow.webContents.capturePage();
    const fullPng = nimg.toPNG();
    const thumbnailBuffer = await sharp(fullPng).resize(400).png().toBuffer();
    return { success: true, thumbnailBase64: thumbnailBuffer.toString('base64') };
  } catch (err) {
    logger.error('Error capturing thumbnail:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('save-layout', async (event, layoutData) => {
  try {
    const sharp = require('sharp');

    // Capture screenshot of current window
    const nimg = await mainWindow.webContents.capturePage();
    const fullPng = nimg.toPNG();

    // Resize to 400px wide thumbnail
    const thumbnailBuffer = await sharp(fullPng)
      .resize(400)
      .png()
      .toBuffer();

    // Show save dialog
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(layouts.getDefaultDirectory(), 'layout.aly'),
      filters: [{ name: 'Atlas Layout', extensions: ['aly'] }]
    });

    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }

    layouts.saveLayout(result.filePath, layoutData, thumbnailBuffer);
    return { success: true, filePath: result.filePath };
  } catch (err) {
    logger.error('Error saving layout:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('save-layout-global-named', async (event, { name, layoutData, thumbnailBase64 }) => {
  try {
    let thumbnailBuffer;
    if (thumbnailBase64) {
      thumbnailBuffer = Buffer.from(thumbnailBase64, 'base64');
    } else {
      const sharp = require('sharp');
      const nimg = await mainWindow.webContents.capturePage();
      thumbnailBuffer = await sharp(nimg.toPNG()).resize(400).png().toBuffer();
    }

    // Ensure name ends with .aly and contains no path separators
    let safeName = path.basename(name.replace(/[/\\:*?"<>|]/g, '-'));
    if (!safeName.toLowerCase().endsWith('.aly')) safeName += '.aly';

    const filePath = path.join(layouts.getDefaultDirectory(), safeName);
    layouts.saveLayout(filePath, layoutData, thumbnailBuffer);
    return { success: true, filePath };
  } catch (err) {
    logger.error('Error saving named global layout:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('path-join', (event, ...parts) => {
  return path.join(...parts);
});

ipcMain.handle('load-layout', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      defaultPath: layouts.getDefaultDirectory(),
      filters: [{ name: 'Atlas Layout', extensions: ['aly'] }],
      properties: ['openFile']
    });

    if (result.canceled || !result.filePaths[0]) {
      return { success: false, canceled: true };
    }

    const { layoutData, thumbnailBase64 } = layouts.loadLayout(result.filePaths[0]);
    return { success: true, layoutData, thumbnailBase64 };
  } catch (err) {
    logger.error('Error loading layout:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('list-layouts', async () => {
  try {
    const layoutsList = layouts.listLayouts();
    return { success: true, layouts: layoutsList };
  } catch (err) {
    logger.error('Error listing layouts:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('load-layout-file', async (event, filePath) => {
  try {
    const resolved = path.resolve(filePath);
    if (!resolved.toLowerCase().endsWith('.aly')) {
      return { success: false, error: 'Not an .aly file' };
    }
    const { layoutData, thumbnailBase64, description } = layouts.loadLayout(resolved);
    return { success: true, layoutData, thumbnailBase64, description };
  } catch (err) {
    logger.error('Error loading layout file:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('delete-layout', async (event, filePath) => {
  try {
    layouts.deleteLayout(filePath);
    return { success: true };
  } catch (err) {
    logger.error('Error deleting layout:', err.message);
    return { success: false, error: err.message };
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

function getObservationSource(isManualNavigation, isBackgroundRefresh, options = {}) {
  return options.observationSource || (isManualNavigation ? 'manual' : isBackgroundRefresh ? 'background-refresh' : 'scan');
}

function getMonitoringObservationDeadTimeMs() {
  const settings = categories.getSettings();
  const value = Math.max(1, Number(settings.monitoring_observation_dead_time_value) || 1);
  const unit = settings.monitoring_observation_dead_time_unit || 'hours';

  switch (unit) {
    case 'minutes':
      return value * 60 * 1000;
    case 'days':
      return value * 24 * 60 * 60 * 1000;
    case 'hours':
    default:
      return value * 60 * 60 * 1000;
  }
}

function ensureDirectoryRecord(dirPath, inode, categoryName = 'Default') {
  const existingByPath = db.getDirectory(dirPath);
  if (existingByPath) {
    db.upsertDirectory(
      dirPath,
      inode,
      existingByPath.category || categoryName,
      existingByPath.description || null,
      existingByPath.initials || null,
      existingByPath.parent_id,
      existingByPath.category_force || 0
    );
    db.updateDirectoryParent(dirPath, db.getParentDirectoryId(dirPath));
    return { dir: db.getDirectory(dirPath), isNew: false, movedFrom: null };
  }

  const existingByInode = db.getDirectoryByInode(inode);
  if (existingByInode) {
    const parentId = db.getParentDirectoryId(dirPath);
    const previousPath = existingByInode.dirname;
    db.updateDirectoryPath(existingByInode.id, dirPath, parentId);
    return { dir: db.getDirectory(dirPath), isNew: true, movedFrom: previousPath };
  }

  const dirId = db.getOrCreateDirectory(dirPath, inode, categoryName);
  db.updateDirectoryParent(dirPath, db.getParentDirectoryId(dirPath));
  return { dir: db.getDirById(dirId), isNew: true, movedFrom: null };
}

function recordDirectoryObservation(dirEntry, eventType, source, hasChanges, fileChanges, dirChanges) {
  const detectedAt = Date.now();
  const latestObservation = db.getLatestDirectoryHistory(dirEntry.id);
  const deadTimeMs = getMonitoringObservationDeadTimeMs();
  let shouldInsert = true;

  if (!hasChanges && latestObservation && deadTimeMs > 0) {
    shouldInsert = (detectedAt - latestObservation.detectedAt) >= deadTimeMs;
  }

  db.updateDirectoryObservation(dirEntry.dirname, source, detectedAt);

  if (!shouldInsert) {
    return { id: null, detectedAt };
  }

  const result = db.insertDirHistory(dirEntry.id, eventType, {
    dirname: path.basename(dirEntry.dirname),
    source,
    hasChanges,
    fileChanges,
    dirChanges,
    status: hasChanges ? 'changed' : (eventType === 'dirOpened' ? 'opened' : eventType === 'dirSeen' ? 'seen' : 'observed')
  }, detectedAt);

  return { id: result.lastInsertRowid, detectedAt };
}

function createStandaloneDirHistory(dirEntry, source, fileChanges = 1, dirChanges = 0, status = 'manual') {
  const result = db.insertDirHistory(dirEntry.id, 'dirManual', {
    dirname: path.basename(dirEntry.dirname),
    source,
    hasChanges: true,
    fileChanges,
    dirChanges,
    status
  });

  return result.lastInsertRowid;
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
    const observationSource = getObservationSource(isManualNavigation, isBackgroundRefresh, options);

    // Create or get the directory entry (returns dir_id)
    const currentDirInfo = ensureDirectoryRecord(normalizedPath, dirInode, categoryName);
    const dirId = currentDirInfo.dir.id;
    const initialObservation = !db.getLatestDirectoryObservation(dirId);
    const currentDirEventType = isManualNavigation ? 'dirOpened' : 'dirObserved';

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
    const pendingMissingFiles = [];
    const pendingMissingDirs = [];
    const pendingPermErrorEntries = [];
    const existingChildDirs = db.getDirectoryChildren(dirId);
    const childDirMap = new Map(existingChildDirs.map(child => [child.id, child]));

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
          pendingPermErrorEntries.push({
            inode: entry.inode,
            filename: entry.filename,
            fileId: permErrFileRecord.id,
            mode: permErrMode
          });
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
        const subDirCategory = categories.getCategoryForDirectory(entry.path);
        const subDirCategoryName = subDirCategory ? subDirCategory.name : 'Default';
        const subDirInfo = ensureDirectoryRecord(entry.path, entry.inode, subDirCategoryName);
        const existingDir = subDirInfo.dir;
        let changeState = 'unchanged';

        if (subDirInfo.isNew) {
          changeState = 'new';
        }
        childDirMap.delete(existingDir.id);

        entriesWithChanges.push({
          ...entry,
          changeState,
          initials: existingDir ? (existingDir.initials || null) : null,
          resolvedInitials: existingDir ? (db.resolveDirectoryInitials(entry.path).value) : null,
          displayName: existingDir ? (existingDir.display_name || null) : null,
          perms: entry.perms || { read: true, write: false },
          mode: entry.mode ?? null,
          tags: existingDir ? db.getTagsForDirectory(entry.path) : null,
          attributes: (() => {
            if (!existingDir) return null;
            const dotFile = db.getFileByFilename(existingDir.id, '.');
            return (dotFile && dotFile.attributes) ? dotFile.attributes : null;
          })(),
          dir_id: existingDir.id
        });
      }
    }

    // Process missing files: check for moves vs orphans.
    // Orphan rows are state, not a log — createOrphan upserts and reports isNew
    // so we only emit history / alerts / INFO logs on first detection or when a
    // state transition is observed (e.g. a previously-unknown orphan becomes
    // found-elsewhere).
    const orphanedEntries = [];
    const pendingMovedFiles = [];
    for (const [inode, dbFile] of dbFileMap) {
      try {
        if (dbFile.filename === '.') {
          continue;
        }

        const movedFileRecord = db.findInodeInOtherDirectories(inode, dirId);

        if (movedFileRecord) {
          const newDirId = movedFileRecord.dir_id_match;
          const orphanResult = db.createOrphan(dirId, dbFile.filename, inode);
          const orphanId = orphanResult.id;
          const transitioned = orphanResult.isNew || orphanResult.new_dir_id !== newDirId;
          if (transitioned) {
            db.updateOrphanNewLocation(orphanId, newDirId);
            pendingMovedFiles.push({ inode, dbFile, newDirId });
            logger.info(`File ${dbFile.filename} detected as moved from ${dirPath}`);
          }

          orphanedEntries.push({
            inode,
            filename: dbFile.filename,
            isDirectory: false,
            size: dbFile.size,
            dateModified: dbFile.dateModified,
            dateCreated: dbFile.dateCreated,
            mode: dbFile.mode ?? null,
            path: path.join(dirPath, dbFile.filename),
            changeState: 'moved',
            isStateTransition: transitioned,
            orphan_id: orphanId,
            new_dir_id: newDirId,
            dir_id: dirId
          });
        } else {
          const orphanResult = db.createOrphan(dirId, dbFile.filename, inode);
          const orphanId = orphanResult.id;

          orphanedEntries.push({
            inode,
            filename: dbFile.filename,
            isDirectory: false,
            size: dbFile.size,
            dateModified: dbFile.dateModified,
            dateCreated: dbFile.dateCreated,
            mode: dbFile.mode ?? null,
            path: path.join(dirPath, dbFile.filename),
            changeState: 'orphan',
            isStateTransition: !!orphanResult.isNew,
            orphan_id: orphanId,
            new_dir_id: null,
            dir_id: dirId
          });
          if (orphanResult.isNew) {
            pendingMissingFiles.push({ inode, dbFile });
            logger.info(`File ${dbFile.filename} marked as orphan in ${dirPath}`);
          }
        }
      } catch (err) {
        logger.error(`Error processing missing file ${dbFile.filename}:`, err.message);
      }
    }

    for (const childDir of childDirMap.values()) {
      try {
        const movedDirRecord = db.findDirectoryInOtherParents(childDir.inode, dirId);
        if (movedDirRecord) {
          const orphanResult = db.createDirOrphan(dirId, childDir.id, path.basename(childDir.dirname));
          const orphanId = orphanResult.id;
          const transitioned = orphanResult.isNew || orphanResult.new_dir_id !== movedDirRecord.id;
          if (transitioned) {
            db.updateDirOrphanNewLocation(orphanId, movedDirRecord.id);
          }

          entriesWithChanges.push({
            inode: childDir.inode,
            filename: path.basename(childDir.dirname),
            isDirectory: true,
            size: 0,
            dateModified: dirStats.dateModified,
            dateCreated: dirStats.dateCreated,
            mode: null,
            path: childDir.dirname,
            changeState: 'moved',
            isStateTransition: transitioned,
            dir_id: childDir.id,
            initials: childDir.initials || null,
            resolvedInitials: db.resolveDirectoryInitials(childDir.dirname).value,
            displayName: childDir.display_name || null,
            tags: db.getTagsForDirectoryId(childDir.id),
            attributes: db.getAttributesForDirectoryId(childDir.id),
            orphan_id: orphanId,
            new_dir_id: movedDirRecord.id
          });

          if (transitioned) {
            pendingMissingDirs.push({
              childDir,
              eventType: 'dirMoved',
              orphanId,
              newDirId: movedDirRecord.id
            });
          }
        } else {
          const orphanResult = db.createDirOrphan(dirId, childDir.id, path.basename(childDir.dirname));
          const orphanId = orphanResult.id;

          entriesWithChanges.push({
            inode: childDir.inode,
            filename: path.basename(childDir.dirname),
            isDirectory: true,
            size: 0,
            dateModified: dirStats.dateModified,
            dateCreated: dirStats.dateCreated,
            mode: null,
            path: childDir.dirname,
            changeState: 'orphan',
            isStateTransition: !!orphanResult.isNew,
            dir_id: childDir.id,
            initials: childDir.initials || null,
            resolvedInitials: db.resolveDirectoryInitials(childDir.dirname).value,
            displayName: childDir.display_name || null,
            tags: db.getTagsForDirectoryId(childDir.id),
            attributes: db.getAttributesForDirectoryId(childDir.id),
            orphan_id: orphanId,
            new_dir_id: null
          });

          if (orphanResult.isNew) {
            pendingMissingDirs.push({
              childDir,
              eventType: 'dirOrphaned',
              orphanId,
              newDirId: null
            });
          }
        }
      } catch (err) {
        logger.error(`Error processing missing directory ${childDir.dirname}:`, err.message);
      }
    }

    entriesWithChanges.push(...orphanedEntries);

    // For the "did this scan observe new activity?" tally, treat already-known
    // orphan/moved entries as quiescent state — only count them when this scan
    // actually observed a state transition (new orphan, or a moved file now
    // located in a different directory). Otherwise every scan of a directory
    // with a persistent orphan would report hasChanges=true forever.
    const isQuiescentOrphan = (entry) =>
      (entry.changeState === 'orphan' || entry.changeState === 'moved') &&
      entry.isStateTransition === false;
    const changedFileEntries = entriesWithChanges.filter(entry =>
      !entry.isDirectory && entry.changeState !== 'unchanged' && !isQuiescentOrphan(entry));
    const changedDirEntries = entriesWithChanges.filter(entry =>
      entry.isDirectory && entry.filename !== '.' && entry.changeState !== 'unchanged' && !isQuiescentOrphan(entry));
    const hasChanges = changedFileEntries.length > 0 || changedDirEntries.length > 0;
    const currentObservation = recordDirectoryObservation(
      currentDirInfo.dir,
      currentDirEventType,
      observationSource,
      hasChanges,
      changedFileEntries.length,
      changedDirEntries.length
    );
    const currentDirHistoryId = currentObservation.id;

    if (currentObservation.id) {
      try {
        const currentDirAttrsJson = db.getAttributesForDirectoryId(dirId);
        const dirRule = doesEventMatchRules(alertRules, currentDirEventType, categoryName, dirTagsJson, currentDirAttrsJson);
        if (dirRule) {
          db.insertAlert(dirRule.id, currentObservation.id, currentDirEventType, path.basename(normalizedPath), categoryName, dirId, dirInode, null, null);
          alertsCreated++;
        }
      } catch (alertErr) {
        logger.error(`Error creating ${currentDirEventType} alert for ${normalizedPath}:`, alertErr.message);
      }
    }

    for (const permErrEntry of pendingPermErrorEntries) {
      try {
        db.insertFileHistory(permErrEntry.inode, dirId, permErrEntry.fileId, 'fileModified', {
          filename: permErrEntry.filename,
          status: 'permError',
          mode: permErrEntry.mode
        }, currentDirHistoryId);
      } catch (err) {
        logger.error(`Error recording permission history for ${permErrEntry.filename}:`, err.message);
      }
    }

    // Upsert all files with their new data and track changes in file_history
    for (const entry of entriesWithChanges) {
      // Permission error entries are persisted earlier in the scan loop.
      if (entry.changeState === 'permError') continue;

      if (entry.changeState === 'moved' || entry.changeState === 'orphan') {
        continue;
      }

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
          const eventType = initialObservation ? 'INITIAL' : 'fileAdded';
          try {
            db.insertFileHistory(entry.inode, dirId, fileRecord.id, eventType, {
              filename: entry.filename,
              dateModified: entry.dateModified,
              filesizeBytes: entry.size,
              mode: entry.mode ?? null
            }, currentDirHistoryId);
          } catch (err) {
            logger.error(`Error recording file history for new file ${entry.filename}:`, err.message);
          }
          try {
            const addedRule = doesEventMatchRules(alertRules, eventType, categoryName, dirTagsJson, entry.attributes || null);
            if (addedRule) {
              db.insertAlert(addedRule.id, null, eventType, entry.filename, categoryName, dirId, entry.inode, null, null);
              alertsCreated++;
            }
          } catch (alertErr) { logger.error(`Error creating ${eventType} alert for ${entry.filename}:`, alertErr.message); }
        } else {
          const modeChanged = (dbFile.mode ?? null) !== (entry.mode ?? null);
          const dateChanged = dbFile.dateModified !== entry.dateModified;

          if (dateChanged || modeChanged) {
            const historyPayload = {};
            if (dateChanged) historyPayload.dateModified = entry.dateModified;
            if (modeChanged) historyPayload.mode = entry.mode ?? null;

            try {
              db.insertFileHistory(entry.inode, dirId, fileRecord.id, 'fileModified', historyPayload, currentDirHistoryId);
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
              const renameHistResult = db.insertFileHistory(entry.inode, dirId, fileRecord.id, 'fileRenamed', {
                filename: entry.filename,
                previousFilename: entry.previousFilename
              }, currentDirHistoryId);
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
              db.insertFileHistory(entry.inode, dirId, fileRecord.id, 'fileModified', {
                checksumStatus: 'untracked'
              }, currentDirHistoryId);
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
        const subDirId = entry.dir_id;
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
            if (entry.changeState === 'new') {
              const dirEventType = initialObservation ? 'dirSeen' : 'dirAdded';
              db.insertDirHistory(subDirId, dirEventType, {
                dirname: path.basename(entry.path),
                category: subDirCategory ? subDirCategory.name : 'Default',
                parentDirname: path.basename(normalizedPath),
                source: observationSource,
                hasChanges: true,
                fileChanges: 0,
                dirChanges: 1,
                status: dirEventType === 'dirSeen' ? 'seen' : 'added'
              });

              const subDirTagsJson = db.getTagsForDirectoryId(subDirId);
              const subDirAttrsJson = db.getAttributesForDirectoryId(subDirId);
              const dirRule = doesEventMatchRules(
                alertRules,
                dirEventType,
                subDirCategory ? subDirCategory.name : 'Default',
                subDirTagsJson,
                subDirAttrsJson
              );
              if (dirRule) {
                db.insertAlert(dirRule.id, null, dirEventType, path.basename(entry.path), subDirCategory ? subDirCategory.name : 'Default', subDirId, entry.inode, null, null);
                alertsCreated++;
              }
            }
          } catch (err) {
            logger.error(`Error recording directory history for ${entry.path}:`, err.message);
          }
        }
      }
    }

    for (const missingFile of pendingMissingFiles) {
      try {
        db.insertFileHistory(missingFile.inode, dirId, missingFile.dbFile.id, 'fileRemoved', {
          filename: missingFile.dbFile.filename,
          status: 'orphan'
        }, currentDirHistoryId);

        const removedRule = doesEventMatchRules(alertRules, 'fileRemoved', categoryName, dirTagsJson, null);
        if (removedRule) {
          db.insertAlert(removedRule.id, null, 'fileRemoved', missingFile.dbFile.filename, categoryName, dirId, missingFile.inode, null, null);
          alertsCreated++;
        }
      } catch (err) {
        logger.error(`Error processing missing file ${missingFile.dbFile.filename}:`, err.message);
      }
    }

    for (const moved of pendingMovedFiles) {
      try {
        const newDir = db.getDirById(moved.newDirId);
        db.insertFileHistory(moved.inode, dirId, moved.dbFile.id, 'fileMoved', {
          filename: moved.dbFile.filename,
          status: 'moved',
          oldPath: path.join(dirPath, moved.dbFile.filename),
          newPath: newDir ? path.join(newDir.dirname, moved.dbFile.filename) : null
        }, currentDirHistoryId);

        const movedRule = doesEventMatchRules(alertRules, 'fileMoved', categoryName, dirTagsJson, null);
        if (movedRule) {
          db.insertAlert(movedRule.id, null, 'fileMoved', moved.dbFile.filename, categoryName, dirId, moved.inode, null, null);
          alertsCreated++;
        }
      } catch (err) {
        logger.error(`Error processing moved file ${moved.dbFile.filename}:`, err.message);
      }
    }

    for (const missingDir of pendingMissingDirs) {
      try {
        const childCategory = categories.getCategoryForDirectory(missingDir.childDir.dirname);
        const childCategoryName = childCategory ? childCategory.name : 'Default';
        const dirTags = db.getTagsForDirectoryId(missingDir.childDir.id);
        const dirAttrs = db.getAttributesForDirectoryId(missingDir.childDir.id);
        db.insertDirHistory(missingDir.childDir.id, missingDir.eventType, {
          dirname: path.basename(missingDir.childDir.dirname),
          source: observationSource,
          hasChanges: true,
          fileChanges: 0,
          dirChanges: 1,
          oldPath: missingDir.childDir.dirname,
          newPath: missingDir.newDirId ? (db.getDirById(missingDir.newDirId)?.dirname || null) : null,
          status: missingDir.eventType === 'dirMoved' ? 'moved' : 'orphaned'
        });

        const dirRule = doesEventMatchRules(alertRules, missingDir.eventType, childCategoryName, dirTags, dirAttrs);
        if (dirRule) {
          db.insertAlert(
            dirRule.id,
            null,
            missingDir.eventType,
            path.basename(missingDir.childDir.dirname),
            childCategoryName,
            missingDir.childDir.id,
            missingDir.childDir.inode,
            missingDir.eventType === 'dirMoved' ? missingDir.childDir.dirname : null,
            missingDir.newDirId ? (db.getDirById(missingDir.newDirId)?.dirname || null) : null
          );
          alertsCreated++;
        }
      } catch (err) {
        logger.error(`Error recording directory event for ${missingDir.childDir.dirname}:`, err.message);
      }
    }

    // Add the "." current directory entry to the results
    // (it's stored in DB but not in filesystem, so we need to add it manually)
    const dotFileRecord = db.getFileByInode(dirInode, dirId);
    if (dotFileRecord && dotFileRecord.filename === '.') {
      // Read current dir record to get saved initials
      const dirRecord = db.getDirectory(normalizedPath);
      const resolvedInitialsResult = db.resolveDirectoryInitials(normalizedPath);
      const resolvedDisplayNameResult = db.resolveDirectoryDisplayName(normalizedPath);
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
        dir_id: dirId,
        initials: dirRecord ? (dirRecord.initials || null) : null,
        resolvedInitials: resolvedInitialsResult.value,
        displayName: dirRecord ? (dirRecord.display_name || null) : null,
        resolvedDisplayName: resolvedDisplayNameResult.value,
        displayNameIsInherited: resolvedDisplayNameResult.isInherited,
        displayNameSourceDir: resolvedDisplayNameResult.sourceDir,
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
    let localNotesFilePath = null;
    try {
      const notesFilePath = path.join(normalizedPath, 'notes.txt');
      if (fsSync.existsSync(notesFilePath)) {
        const notesContent = fsSync.readFileSync(notesFilePath, 'utf-8');
        localNotesSections = notesParser.parseNotesFileSections(notesContent);

        localNotesContent = notesContent;
        localNotesFilePath = notesFilePath;

        const headersArray = notesParser.extractAllHeaders(localNotesContent);
        filesWithNotes = new Set(headersArray);
        // Directories get checked later since we have to dive into subdirs for it
      }
    } catch (err) {
      logger.warn(`Error reading notes for directory ${normalizedPath}:`, err.message);
    }

    // Opportunistically refresh the TODO aggregation row for this directory's notes.txt.
    // Reuses the content already in memory so there is no extra file read.
    if (localNotesFilePath) {
      try {
        const aggResult = todoAggregator.ensureAndRefresh(localNotesFilePath, dirId, { contentOverride: localNotesContent });
        if (aggResult.changed && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('todo-aggregates-changed');
        }
      } catch (err) {
        logger.warn(`todoAggregator.ensureAndRefresh failed for ${localNotesFilePath}: ${err.message}`);
      }
    } else {
      // If a previous scan had a notes.txt row but the file is gone, drop it.
      const notesFilePath = path.join(normalizedPath, 'notes.txt');
      const existing = db.getTodoNotesFile(notesFilePath);
      if (existing) {
        db.deleteTodoNotesFileByPath(notesFilePath);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('todo-aggregates-changed');
        }
      }
    }

    // Add hasNotes and todoCounts fields to each entry
    let dirNotesFilePath;
    let dirNotesContent;
    let directoryNotes;
    let todoAggChanged = false;
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

            // Opportunistically feed child notes.txt into the TODO aggregator
            if (dirNotesContent && entry.dir_id) {
              try {
                const childAgg = todoAggregator.ensureAndRefresh(dirNotesFilePath, entry.dir_id, { contentOverride: dirNotesContent });
                if (childAgg.changed) todoAggChanged = true;
              } catch (err) {
                logger.warn(`todoAggregator child refresh failed for ${dirNotesFilePath}: ${err.message}`);
              }
            }
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

        // Promote @#tags from notes into the DB (idempotent)
        const noteDirTags = notesParser.extractNoteTags(dirSection);
        if (noteDirTags.length > 0) {
          const targetDirPath = entry.filename === '.' ? normalizedPath : entry.path;
          for (const tagName of noteDirTags) {
            try { db.addTagToDirectory(targetDirPath, tagName); } catch (err) {
              logger.warn(`notes-tag: failed to add tag '${tagName}' to dir '${targetDirPath}': ${err.message}`);
            }
          }
          entry.tags = db.getTagsForDirectoryId(entry.dir_id);
        }
      } else {
        // For files, check if they have file-specific notes
        entry.hasNotes = filesWithNotes.has(entry.filename);

        // Compute todoCounts for the file (from its named section in localNotesContent)
        const fileSection = localNotesSections[entry.filename] || '';
        const fileTodoCounts = notesParser.countTodoItems(fileSection);
        entry.todoCounts = fileTodoCounts.total > 0 ? fileTodoCounts : null;

        // Promote @#tags from notes into the DB (idempotent)
        const noteFileTags = notesParser.extractNoteTags(fileSection);
        if (noteFileTags.length > 0) {
          for (const tagName of noteFileTags) {
            try { db.addTagToFile(entry.inode, entry.dir_id, tagName); } catch (err) {
              logger.warn(`notes-tag: failed to add tag '${tagName}' to file '${entry.filename}': ${err.message}`);
            }
          }
          entry.tags = db.getFileByInode(entry.inode, entry.dir_id)?.tags || null;
        }
      }
    }

    if (todoAggChanged && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('todo-aggregates-changed');
    }

    const changedEntries = entriesWithChanges.filter(e =>
      e.changeState !== 'unchanged' && !isQuiescentOrphan(e));

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
          const dirHistoryId = dirRecord ? createStandaloneDirHistory(dirRecord, isManual ? 'manual-checksum' : 'checksum', 1, 0, 'checksumChanged') : null;
          const historyResult = db.insertFileHistory(inode, dirId, fileRecord.id, 'fileChanged', {
            checksumValue: result.value,
            checksumStatus: storedStatus
          }, dirHistoryId);
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
      const dirHistoryId = createStandaloneDirHistory(dir, 'acknowledgement', 1, 0, 'acknowledged');
      db.insertFileHistory(inode, dir.id, file.id, 'fileModified', {
        filename: file.filename,
        dateModified: newDateModified
      }, dirHistoryId);

      // Get the newly inserted record to set acknowledgedAt
      const latestHistory = db.getLatestFileHistory(inode, dir.id);
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
 * Item History: Get history records for a file or directory
 */
ipcMain.handle('get-item-history', (event, item) => {
  try {
    if (item && item.isDirectory) {
      if (!item.dirId) {
        return { success: false, error: 'Directory ID is required for directory history.' };
      }
      const history = db.getDirectoryHistory(item.dirId);
      return { success: true, data: history };
    }

    if (!item || !item.inode) {
      return { success: false, error: 'File inode is required for file history.' };
    }

    const history = db.getFileHistory(item.inode, item.dirId || null);
    return { success: true, data: history };
  } catch (err) {
    logger.error('Error retrieving item history:', err.message);
    return { success: false, error: err.message };
  }
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

ipcMain.handle('acknowledge-dir-orphan', (event, orphanId) => {
  try {
    db.deleteDirOrphan(orphanId);
    return { success: true };
  } catch (err) {
    logger.error(`Error acknowledging directory orphan ${orphanId}:`, err.message);
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

/**
 * Extract a single thumbnail frame from a video file using ffmpeg.
 * Tries 1 s first; falls back to the first frame for short clips.
 * Returns a JPEG data URL, or success:false if extraction fails.
 */
ipcMain.handle('get-video-thumbnail', (event, filePath) => {
  const runFfmpeg = (seekTime) => new Promise((resolve) => {
    const args = [
      '-ss', seekTime,
      '-i', filePath,
      '-vframes', '1',
      '-vf', 'scale=200:-2',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-loglevel', 'error',
      'pipe:1'
    ];
    execFile(ffmpegBin, args, { encoding: 'buffer', maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
      const failed = err || !stdout || stdout.length === 0;
      resolve({ ok: !failed, stdout, error: err ? err.message : 'no output' });
    });
  });

  return (async () => {
    // Check cache first
    let mtime = 0;
    try {
      mtime = fsSync.statSync(filePath).mtimeMs;
      const cached = db.getCachedVideoThumbnail(filePath, mtime);
      if (cached) {
        return { success: true, dataUrl: 'data:image/jpeg;base64,' + cached.thumbnail.toString('base64') };
      }
    } catch (e) {
      logger.warn(`Video thumbnail: could not stat "${filePath}" — ${e.message}`);
    }

    let result = await runFfmpeg('00:00:01');
    if (!result.ok) {
      logger.warn(`Video thumbnail: seek to 1s failed for "${filePath}" (${result.error}), retrying at 0s`);
      result = await runFfmpeg('00:00:00');
    }
    if (!result.ok) {
      logger.error(`Video thumbnail: could not extract frame from "${filePath}" — ${result.error}`);
      return { success: false, error: result.error };
    }

    // Store in cache
    try {
      db.saveCachedVideoThumbnail(filePath, mtime, result.stdout);
    } catch (e) {
      logger.warn(`Video thumbnail: failed to cache "${filePath}" — ${e.message}`);
    }

    return { success: true, dataUrl: 'data:image/jpeg;base64,' + result.stdout.toString('base64') };
  })();
});

// ============================================
// App lifecycle
// ============================================

app.on('ready', () => {
  // Disable the default menu to prevent Alt key from showing it
  Menu.setApplicationMenu(null);
  initialize();
  createWindow();

  // ── Session-level network firewall ──────────────────────────────────────────
  // Block ALL outbound HTTP/HTTPS/WebSocket requests at the Chromium network
  // layer. This fires below the renderer, so it cannot be bypassed by any JS
  // running in the page — regardless of how it was injected.
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      logger.warn('[SECURITY] Blocked external request:', details.url);
      callback({ cancel: true });
    }
  );

  // ── Content-Security-Policy injection ───────────────────────────────────────
  // Inject a strict CSP on every file:// response so that even if an injected
  // <script> tag somehow survives markdown sanitization it cannot execute.
  //   script-src 'self'      → only loaded .js files from public/; blocks inline
  //                             scripts, data: and blob: script sources entirely
  //   style-src unsafe-inline → required by w2ui and Monaco (inject inline styles)
  //   img-src data:           → required by w2ui/Monaco icon data URIs
  //   connect-src 'none'      → second-layer ban on fetch/XHR/WebSocket
  const cspValue = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: file:",
    "media-src file:",
    "font-src 'self' data:",
    "connect-src 'none'"
  ].join('; ');

  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['file:///*'] },
    (details, callback) => {
      const headers = Object.assign({}, details.responseHeaders, {
        'Content-Security-Policy': [cspValue]
      });
      callback({ responseHeaders: headers });
    }
  );

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
