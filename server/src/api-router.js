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
  loadCategories:               async () => null,
  getCategory:                  async ([name]) => null,
  getCategoriesList:            async () => null,
  createCategory:               async ([name, bgColor, textColor, patterns]) => null,
  saveCategory:                 async ([categoryData]) => null,
  updateCategory:               async ([name, categoryData]) => null,
  deleteCategory:               async ([name]) => null,
  assignCategoryToDirectory:    async ([dirPath, categoryName, force]) => null,
  assignCategoryToDirectories:  async ([dirPaths, categoryName, force]) => null,
  getDirectoryAssignment:       async ([dirPath]) => null,
  removeDirectoryAssignment:    async ([dirPath]) => null,
  getCategoryForDirectory:      async ([dirPath]) => null,

  // ── Tags (src/tags.js) ────────────────────────────────────────────────────
  loadTags:           async () => null,
  getTag:             async ([name]) => null,
  getTagsList:        async () => null,
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
  getFileTypes:      async () => null,
  addFileType:       async ([pattern, type, icon, openWith]) => null,
  updateFileType:    async ([pattern, newPattern, newType, icon, openWith]) => null,
  deleteFileType:    async ([pattern]) => null,

  // ── Settings & Config (src/categories.js) ────────────────────────────────
  getSettings:   async () => null,
  saveSettings:  async ([settings]) => null,
  getHotkeys:    async () => null,
  saveHotkeys:   async ([hotkeyData]) => null,
  getFavorites:  async () => null,
  saveFavorites: async ([favorites]) => null,

  // ── Filesystem Reads (src/filesystem.js) ─────────────────────────────────
  readDirectory:              async ([dirPath]) => null,
  getRootDrives:              async () => null,
  getParentDirectoryMetadata: async ([dirPath]) => null,
  getShortcutsInDirectory:    async ([dirPath]) => null,
  getFilesInDirectory:        async ([dirPath]) => null,
  isDirectory:                async ([dirPath]) => null,

  // ── Filesystem Scan (src/filesystem.js + src/db.js) ──────────────────────
  scanDirectoryWithComparison: async ([dirPath, isManualNavigation]) => null,
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
  getDirectoryInitials:  async ([dirPath]) => null,
  saveDirectoryInitials: async ([dirPath, initials]) => null,
  getDirectoryLabels:    async ([dirPath]) => null,
  saveDirectoryLabels:   async ([dirPath, labels]) => null,

  // ── Dir Grid Layout (src/db.js) ───────────────────────────────────────────
  saveDirGridLayout: async ([dirname, columns, sortData]) => null,
  getDirGridLayout:  async ([dirname]) => null,

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
  getUnacknowledgedAlertCount: async () => null,
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
  generateFolderIcon: async ([bgColor, textColor, initials]) => null,
  generateTagIcon:    async ([bgColor, textColor]) => null,

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
  updateWindowIcon:  async ([categoryName, initials]) => ({ ok: true }),
  startExternalDrag: async ([filePaths]) => ({ ok: false }), // N/A in browser
  pickFile:          async ([options]) => ({ cancelled: true, filePaths: [] }),
  openInDefaultApp:  async ([filePath]) => ({ ok: false }),
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
