'use strict';

/**
 * server/src/api-router.js
 *
 * Single POST /api endpoint implementing JSON-RPC style dispatch.
 * Request body:  { method: string, args: any[] }
 * Response body: { result: any } | { error: string }
 *
 * All handler bodies are STUBBED (return null) in this skeleton pass.
 * Phase 2: replace each stub body with the real implementation, mirroring
 * the corresponding ipcMain.handle() in main/main.js.
 *
 * Grouped by backing src/ module for easy navigation.
 */

const { JailError } = require('./path-jail');

let _config = null;

function init(config) {
  _config = config;
}

// ---------------------------------------------------------------------------
// Handler map — { methodName: async ([...args], config) => result }
// ---------------------------------------------------------------------------

const HANDLERS = {

  // ── Categories (src/categories.js) ───────────────────────────────────────
  loadCategories: async () => {
    const categories = require('../../src/categories');
    try { return categories.loadCategories(); } catch { return {}; }
  },
  getCategory: async ([name]) => {
    const categories = require('../../src/categories');
    try { return categories.getCategory(name); } catch { return null; }
  },
  getCategoriesList: async () => {
    const categories = require('../../src/categories');
    try { return Object.values(categories.loadCategories()); } catch { return []; }
  },
  createCategory:               async ([name, bgColor, textColor, patterns]) => null,
  saveCategory:                 async ([categoryData]) => null,
  updateCategory:               async ([name, categoryData]) => null,
  deleteCategory:               async ([name]) => null,
  assignCategoryToDirectory:    async ([dirPath, categoryName, force]) => null,
  assignCategoryToDirectories:  async ([dirPaths, categoryName, force]) => null,
  getDirectoryAssignment:       async ([dirPath]) => null,
  removeDirectoryAssignment:    async ([dirPath]) => null,
  getCategoryForDirectory: async ([dirPath]) => {
    const categories = require('../../src/categories');
    try {
      return categories.getCategoryForDirectory(dirPath);
    } catch {
      return categories.createDefaultCategory ? categories.createDefaultCategory() : null;
    }
  },

  // ── Tags (src/tags.js) ────────────────────────────────────────────────────
  loadTags: async () => {
    const tags = require('../../src/tags');
    try { return tags.loadTags(); } catch { return {}; }
  },
  getTag: async ([name]) => {
    const tags = require('../../src/tags');
    try { return tags.getTag(name); } catch { return null; }
  },
  getTagsList: async () => {
    const tags = require('../../src/tags');
    try { return Object.values(tags.loadTags()); } catch { return []; }
  },
  createTag:          async ([name, bgColor, textColor, description]) => null,
  saveTag:            async ([tagData]) => null,
  updateTag:          async ([name, tagData]) => null,
  deleteTag:          async ([name]) => null,
  addTagToItem:       async ([data]) => null,
  removeTagFromItem:  async ([data]) => null,

  // ── Auto-Labels (src/autoLabels.js) ──────────────────────────────────────
  loadAutoLabels:           async () => null,
  getAutoLabel:             async ([id]) => null,
  createAutoLabel:          async ([data]) => null,
  updateAutoLabel:          async ([id, data]) => null,
  deleteAutoLabel:          async ([id]) => null,
  evaluateAutoLabels:       async ([items]) => null,
  applyAutoLabelSuggestions: async ([suggestions]) => null,
  updateHistoryComment:     async ([id, comment]) => null,
  updateDirHistoryComment:  async ([id, comment]) => null,

  // ── Attributes (src/attributes.js) ───────────────────────────────────────
  getAttributesList:  async () => null,
  saveAttribute:      async ([attrData]) => null,
  updateAttribute:    async ([name, attrData]) => null,
  deleteAttribute:    async ([name]) => null,
  getFileAttributes:  async ([inode, dir_id]) => null,
  setFileAttributes:  async ([inode, dir_id, attributes]) => null,
  getItemStats:       async ([itemPath]) => null,

  // ── File Types (src/filetypes.js) ─────────────────────────────────────────
  getFileTypeIcons:  async () => null,
  getFileTypes: async () => {
    const filetypes = require('../../src/filetypes');
    return filetypes.getFileTypes();
  },
  addFileType:       async ([pattern, type, icon, openWith]) => null,
  updateFileType:    async ([pattern, newPattern, newType, icon, openWith]) => null,
  deleteFileType:    async ([pattern]) => null,

  // ── Settings & Config (src/categories.js) ────────────────────────────────
  getSettings: async () => {
    const categories = require('../../src/categories');
    try {
      return categories.getSettings();
    } catch (err) {
      return {};
    }
  },
  saveSettings: async ([settings]) => {
    const categories = require('../../src/categories');
    try {
      categories.saveSettings(settings);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
  getHotkeys: async () => {
    const categories = require('../../src/categories');
    try {
      return categories.getHotkeys();
    } catch (err) {
      return {};
    }
  },
  saveHotkeys: async ([hotkeyData]) => {
    const categories = require('../../src/categories');
    try {
      categories.saveHotkeys(hotkeyData);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
  getFavorites: async () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const categories = require('../../src/categories');
    const favPath = path.join(os.homedir(), '.atlasexplorer', 'favorites.json');
    try {
      if (fs.existsSync(favPath)) {
        return JSON.parse(fs.readFileSync(favPath, 'utf8'));
      }
      // Migration: pull favorites out of settings.json into favorites.json
      const settings = categories.getSettings();
      const favorites = Array.isArray(settings.favorites) ? settings.favorites : [];
      fs.writeFileSync(favPath, JSON.stringify(favorites, null, 2), 'utf8');
      if (Array.isArray(settings.favorites)) {
        delete settings.favorites;
        categories.saveSettings(settings);
      }
      return favorites;
    } catch (err) {
      return [];
    }
  },
  saveFavorites: async ([favorites]) => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const favPath = path.join(os.homedir(), '.atlasexplorer', 'favorites.json');
    try {
      fs.writeFileSync(favPath, JSON.stringify(favorites, null, 2), 'utf8');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  // ── Filesystem Reads (src/filesystem.js) ─────────────────────────────────
  readDirectory:              async ([dirPath]) => null,
  getRootDrives:              async () => null,
  getParentDirectoryMetadata: async ([dirPath]) => {
    const path = require('path');
    const filesystem = require('../../src/filesystem');
    const db = require('../../src/db');
    const categories = require('../../src/categories');
    try {
      const fsMetadata = filesystem.getParentDirectoryMetadata(dirPath);
      if (!fsMetadata) return null;
      const parentDirPath = path.dirname(dirPath);
      const dbMetadata = db.getParentDirectoryInfo(dirPath);
      let parentAttributes = null;
      if (dbMetadata) {
        const dotFile = db.getFileByFilename(dbMetadata.id, '.');
        if (dotFile && dotFile.attributes) parentAttributes = dotFile.attributes;
      }
      const parentTags = dbMetadata ? db.getTagsForDirectory(parentDirPath) : null;
      const parentResolution = categories.getCategoryResolutionForDirectory(parentDirPath);
      const resolvedInitials = db.resolveDirectoryInitials(parentDirPath);
      return {
        ...fsMetadata,
        category: parentResolution.categoryName,
        tags: parentTags,
        initials: dbMetadata?.initials || null,
        resolvedInitials: resolvedInitials.value,
        description: dbMetadata?.description || null,
        attributes: parentAttributes
      };
    } catch (err) {
      return null;
    }
  },
  getShortcutsInDirectory:    async ([dirPath]) => null,
  getFilesInDirectory:        async ([dirPath]) => null,
  isDirectory: async ([dirPath]) => {
    const filesystem = require('../../src/filesystem');
    try {
      return filesystem.isDirectory(dirPath);
    } catch {
      return false;
    }
  },

  // ── Filesystem Scan (src/filesystem.js + src/db.js) ──────────────────────
  scanDirectoryWithComparison: async ([dirPath, isManualNavigation]) => {
    const { doScanDirectoryWithComparison } = require('../../src/scanner');
    const wsHandler = require('./ws-handler');
    return doScanDirectoryWithComparison(
      dirPath,
      isManualNavigation !== false,
      false,
      {},
      (event) => {
        if (event === 'todo-aggregates-changed') wsHandler.pushTodoAggregatesChanged();
        else if (event === 'reminder-aggregates-changed') wsHandler.pushReminderAggregatesChanged();
      }
    );
  },
  getVirtualView:              async ([basePath, params, depth]) => null,
  getBadgeCounts:              async ([dirPath, depth]) => null,

  // ── Filesystem Mutations (src/filesystem.js, path-jailed) ────────────────
  createFolder:     async ([parentPath, folderName]) => null,
  deleteItems:      async ([items]) => null,       // uses src/trash.js on server
  moveItems:        async ([items, targetDirPath, onCollision]) => null,
  copyItems:        async ([items, targetDirPath, onCollision]) => null,
  checkCollisions:  async ([items, targetDirPath]) => null,

  // ── Trash (src/trash.js) ─────────────────────────────────────────────────
  restoreFromTrash:          async ([items]) => null,
  permanentlyDeleteFromTrash: async ([items]) => null,

  // ── File Change Detection (src/checksum.js) ───────────────────────────────
  calculateFileChecksum:    async ([filePath, inode, dirId, isManual]) => null,
  updateFileModificationDate: async ([dirPath, inode, newDateModified]) => null,

  // ── Directory Labels & Initials (src/db.js) ──────────────────────────────
  getDirectoryInitials: async ([dirPath]) => {
    const db = require('../../src/db');
    try { const dir = db.getDirectory(dirPath); return dir ? (dir.initials || null) : null; } catch { return null; }
  },
  saveDirectoryInitials: async ([dirPath, initials]) => {
    const db = require('../../src/db');
    try { db.updateDirectoryInitials(dirPath, initials); return { success: true }; } catch (err) { return { success: false, error: err.message }; }
  },
  getDirectoryLabels: async ([dirPath]) => {
    const db = require('../../src/db');
    try {
      const dir = db.getDirectory(dirPath);
      if (!dir) return { initials: null, initialsInherit: false, initialsForce: false, displayName: null, displayNameInherit: false, displayNameForce: false, resolvedInitials: null, initialsIsInherited: false, resolvedDisplayName: null, displayNameIsInherited: false, displayNameSourceDir: null };
      const ri = db.resolveDirectoryInitials(dirPath);
      const rn = db.resolveDirectoryDisplayName(dirPath);
      return { initials: dir.initials || null, initialsInherit: Boolean(dir.initials_inherit), initialsForce: Boolean(dir.initials_force), displayName: dir.display_name || null, displayNameInherit: Boolean(dir.display_name_inherit), displayNameForce: Boolean(dir.display_name_force), resolvedInitials: ri.value, initialsIsInherited: ri.isInherited, resolvedDisplayName: rn.value, displayNameIsInherited: rn.isInherited, displayNameSourceDir: rn.sourceDir };
    } catch { return null; }
  },
  saveDirectoryLabels: async ([dirPath, labels]) => {
    const db = require('../../src/db');
    try { db.updateDirectoryLabels(dirPath, labels); return { success: true }; } catch (err) { return { success: false, error: err.message }; }
  },

  // ── Dir Grid Layout (src/db.js) ───────────────────────────────────────────
  saveDirGridLayout: async ([dirname, columns, sortData]) => null,
  getDirGridLayout: async ([dirname]) => {
    const db = require('../../src/db');
    try {
      const layout = db.getDirGridLayout(dirname);
      return { success: true, layout };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
  setCategoryDefaultGridLayout: async ([name, columns, sortData]) => null,
  getCategoryDefaultGridLayout: async ([name]) => {
    const cats = require('../../src/categories');
    try {
      const layout = cats.getCategoryDefaultGridLayout(name);
      return { success: true, layout };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  // ── Notes File I/O (fs, path-jailed) ─────────────────────────────────────
  readFileContent:  async ([filePath]) => null,
  writeFileContent: async ([filePath, content]) => null,
  saveNotesImage:   async ([opts]) => null,

  // ── Notes Parser (src/notesParser.js) ────────────────────────────────────
  parseTodoSection:            async ([sectionContent]) => null,
  normalizeTodoSection:        async ([sectionContent]) => null,
  updateTodoItems:             async ([sectionContent, updates]) => null,
  parseReminderSection:        async ([sectionContent]) => null,
  normalizeReminderSection:    async ([sectionContent]) => null,
  parseTodoBlocksWithReminders: async ([sectionContent]) => null,
  renderMarkdown:              async ([content, basePath]) => null,

  // ── TODO Aggregates (src/todoAggregator.js) ───────────────────────────────
  getTodoAggregates:     async ([opts]) => null,
  refreshTodoAggregate:  async ([notesPath, dirId]) => null,
  refreshTodoAggregates: async () => null,

  // ── Reminder Aggregates (src/reminderAggregator.js) ──────────────────────
  getReminderAggregates:     async () => null,
  refreshReminderAggregate:  async ([notesPath, dirId]) => null,
  refreshReminderAggregates: async () => null,

  // ── File History (src/db.js) ──────────────────────────────────────────────
  getItemHistory:      async ([item]) => null,
  getFileHistory:      async ([inode]) => null,
  getFileRecordByPath: async ([filePath]) => null,

  // ── Alerts (src/db.js) ────────────────────────────────────────────────────
  getAlertsSummary:           async () => null,
  getAlertsHistory:           async () => null,
  getUnacknowledgedAlertCount: async () => {
    const db = require('../../src/db');
    try {
      return { success: true, count: db.getUnacknowledgedAlertCount() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
  acknowledgeAlerts:          async ([ids, comment]) => null,
  getAlertRules:              async () => null,
  saveAlertRule:              async ([rule]) => null,
  deleteAlertRules:           async ([ids]) => null,

  // ── Monitoring (src/db.js + in-server timer) ──────────────────────────────
  getMonitoringRules:   async () => null,
  saveMonitoringRule:   async ([rule]) => null,
  deleteMonitoringRules: async ([ids]) => null,
  startActiveMonitoring: async () => null,
  stopActiveMonitoring:  async () => null,

  // ── Orphan acknowledgment (src/db.js) ─────────────────────────────────────
  acknowledgeOrphan:    async ([orphanId]) => null,
  acknowledgeDirOrphan: async ([orphanId]) => null,

  // ── Custom Actions (src/customActions.js) ─────────────────────────────────
  getCustomActions:     async () => null,
  saveCustomAction:     async ([entry]) => null,
  deleteCustomAction:   async ([id]) => null,
  verifyCustomAction:   async ([id]) => null,
  // runCustomAction / runCustomActionInTerminal are gated by config
  runCustomAction: async ([actionId, filePath]) => {
    if (!_config.runCustomActionsEnabled) {
      throw new Error('Custom action execution is disabled. Set runCustomActionsEnabled: true in config.js.');
    }
    return null; // stub — implement in Phase 2
  },
  runCustomActionInTerminal: async ([actionId, filePath, terminalId]) => {
    if (!_config.runCustomActionsEnabled) {
      throw new Error('Custom action execution is disabled. Set runCustomActionsEnabled: true in config.js.');
    }
    return null; // stub — implement in Phase 2
  },

  // ── Layouts (src/layouts.js) ──────────────────────────────────────────────
  saveLayout:        async ([layoutData]) => null,
  saveLayoutToPath:  async ([filePath, layoutData, thumbnailBase64]) => null,
  loadLayout:        async () => null,
  listLayouts:       async () => null,
  loadLayoutFile:    async ([filePath]) => null,
  deleteLayout:      async ([filePath]) => null,

  // ── Icons (src/icons.js) ──────────────────────────────────────────────────
  generateFolderIcon: async ([bgColor, textColor, initials]) => {
    const icons = require('../../src/icons');
    try {
      const buf = await icons.generateWindowIcon(bgColor, textColor, initials || null);
      return buf ? 'data:image/png;base64,' + buf.toString('base64') : null;
    } catch {
      return null;
    }
  },
  generateTagIcon: async ([bgColor, textColor]) => {
    const icons = require('../../src/icons');
    try {
      const buf = await icons.generateTagIcon(bgColor, textColor);
      return buf ? 'data:image/png;base64,' + buf.toString('base64') : null;
    } catch {
      return null;
    }
  },

  // ── Background Refresh (in-server timer) ─────────────────────────────────
  startBackgroundRefresh:  async ([enabled, interval]) => null,
  stopBackgroundRefresh:   async () => null,
  registerWatchedPath:     async ([panelId, dirPath]) => null,
  unregisterWatchedPath:   async ([panelId]) => null,

  // ── EXIF & Video (from main.js — Phase 2 extraction) ─────────────────────
  getExifData:       async ([filePath]) => null,
  getVideoThumbnail: async ([filePath]) => null,

  // ── DB Admin (src/db.js) ──────────────────────────────────────────────────
  reinitializeDatabase: async () => null,

  // ── Misc ──────────────────────────────────────────────────────────────────
  getAppVersion: async () => {
    try { return require('../../package.json').version; } catch { return '0.0.0'; }
  },
  pathJoin: async ([...segments]) => {
    const path = require('path');
    return path.join(...segments);
  },

  // ── Window management / Electron-only — no-ops ────────────────────────────
  closeWindow:       async () => ({ ok: true }),
  allowClose:        async () => ({ ok: true }),
  setWindowTitle:    async ([title]) => ({ ok: true }), // ws-handler broadcasts push:setWindowTitle
  updateWindowIcon: async ([categoryName, initials]) => {
    const categories = require('../../src/categories');
    const icons = require('../../src/icons');
    try {
      const cat = categories.getCategory(categoryName);
      if (cat) {
        const buf = await icons.generateWindowIcon(cat.bgColor, cat.textColor, initials || null);
        if (buf) return { ok: true, dataUrl: 'data:image/png;base64,' + buf.toString('base64') };
      }
    } catch {}
    return { ok: true, dataUrl: null };
  },
  startExternalDrag: async ([filePaths]) => ({ ok: false }), // N/A in browser
  pickFile:          async ([options]) => ({ cancelled: true, filePaths: [] }),
  openInDefaultApp:  async ([filePath]) => ({ ok: false }),
  getDefaultApp:     async ([filePath]) => ({ success: false }),
  resolveShortcut:   async ([lnkPath]) => ({ success: false }),
  openExternalLink:  async ([url]) => ({ ok: false }),
  getPathForFile:    async ([file]) => '',
  captureThumbnail:  async () => ({ success: false, thumbnailBase64: null }), // overridden by thumbnail-renderer.js

  // ── Auto-update — no-ops (not applicable to server) ──────────────────────
  getAppVersion_electron: async () => '0.0.0',
  checkForUpdates:        async () => ({ checking: false }),
  downloadUpdate:         async () => ({ ok: false }),
  quitAndInstall:         async () => ({ ok: false }),
};

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

async function handle(req, res) {
  const { method, args = [] } = req.body;

  if (!method || typeof method !== 'string') {
    return res.status(400).json({ error: 'method is required' });
  }

  const handler = HANDLERS[method];
  if (!handler) {
    return res.status(404).json({ error: `Unknown method: ${method}` });
  }

  try {
    const result = await handler(Array.isArray(args) ? args : [args], _config);
    return res.json({ result: result !== undefined ? result : null });
  } catch (err) {
    if (err instanceof JailError) {
      return res.status(err.statusCode || 403).json({ error: err.message });
    }
    console.error(`[api] Error in ${method}:`, err.message);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { init, handle };
