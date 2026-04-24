const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * Console Bridging
 * Capture all console.log, console.warn, and console.error calls
 * and send them to the main process for file logging
 * 
 * This ensures browser console output also appears in the persisted log file
 */
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

console.log = (...args) => {
  originalLog(...args);  // Still show in DevTools
  ipcRenderer.send('log-to-file', {
    level: 'INFO',
    message: args[0],
    args: args.slice(1)
  });
};

console.warn = (...args) => {
  originalWarn(...args);  // Still show in DevTools
  ipcRenderer.send('log-to-file', {
    level: 'WARN',
    message: args[0],
    args: args.slice(1)
  });
};

console.error = (...args) => {
  originalError(...args);  // Still show in DevTools
  ipcRenderer.send('log-to-file', {
    level: 'ERROR',
    message: args[0],
    args: args.slice(1)
  });
};

contextBridge.exposeInMainWorld('electronAPI', {
  // File system operations
  readDirectory: (dirPath) => ipcRenderer.invoke('read-directory', dirPath),
  getRootDrives: () => ipcRenderer.invoke('get-root-drives'),
  getParentDirectoryMetadata: (dirPath) => ipcRenderer.invoke('get-parent-directory-metadata', dirPath),
  
  // Database operations
  // scanDirectory: (dirPath) => ipcRenderer.invoke('scan-directory', dirPath),
  scanDirectoryWithComparison: (dirPath, isManualNavigation = true) => ipcRenderer.invoke('scan-directory-with-comparison', dirPath, isManualNavigation),
  getVirtualView: (basePath, params, depth = 1) => ipcRenderer.invoke('get-virtual-view', basePath, params, depth),
  getBadgeCounts: (dirPath, depth = 1) => ipcRenderer.invoke('get-badge-counts', dirPath, depth),
  getFilesInDirectory: (dirPath) => ipcRenderer.invoke('get-files-in-directory', dirPath),

  // File change detection
  calculateFileChecksum: (filePath, inode, dirId, isManual = false) => 
    ipcRenderer.invoke('calculate-file-checksum', { filePath, inode, dirId, isManual }),
  updateFileModificationDate: (dirPath, inode, newDateModified) => 
    ipcRenderer.invoke('update-file-modification-date', { dirPath, inode, newDateModified }),

  // Category operations
  loadCategories: () => ipcRenderer.invoke('load-categories'),
  getCategory: (name) => ipcRenderer.invoke('get-category', name),
  getCategoriesList: () => ipcRenderer.invoke('get-categories-list'),
  createCategory: (name, bgColor, textColor, patterns) =>
    ipcRenderer.invoke('create-category', { name, bgColor, textColor, patterns }),
  updateCategory: (name, categoryData) =>
    ipcRenderer.invoke('update-category', { name, ...categoryData }),
  saveCategory: (categoryData) =>
    ipcRenderer.invoke('save-category', categoryData),
  deleteCategory: (name) => ipcRenderer.invoke('delete-category', name),
  
  // Directory assignments
  assignCategoryToDirectory: (dirPath, categoryName, force = true) =>
    ipcRenderer.invoke('assign-category-to-directory', { dirPath, categoryName, force }),
  assignCategoryToDirectories: (dirPaths, categoryName, force = true) =>
    ipcRenderer.invoke('assign-category-to-directories', { dirPaths, categoryName, force }),
  getDirectoryAssignment: (dirPath) =>
    ipcRenderer.invoke('get-directory-assignment', dirPath),
  removeDirectoryAssignment: (dirPath) =>
    ipcRenderer.invoke('remove-directory-assignment', dirPath),
  getCategoryForDirectory: (dirPath) =>
    ipcRenderer.invoke('get-category-for-directory', dirPath),

  // Tag operations
  loadTags: () => ipcRenderer.invoke('load-tags'),
  getTag: (name) => ipcRenderer.invoke('get-tag', name),
  getTagsList: () => ipcRenderer.invoke('get-tags-list'),
  createTag: (name, bgColor, textColor, description) =>
    ipcRenderer.invoke('create-tag', { name, bgColor, textColor, description }),
  updateTag: (name, tagData) =>
    ipcRenderer.invoke('update-tag', { name, ...tagData }),
  saveTag: (tagData) =>
    ipcRenderer.invoke('save-tag', tagData),
  deleteTag: (name) => ipcRenderer.invoke('delete-tag', name),
  addTagToItem: (data) => ipcRenderer.invoke('add-tag-to-item', data),
  removeTagFromItem: (data) => ipcRenderer.invoke('remove-tag-from-item', data),

  // Auto-Label operations
  loadAutoLabels: () => ipcRenderer.invoke('load-auto-labels'),
  getAutoLabel: (id) => ipcRenderer.invoke('get-auto-label', id),
  createAutoLabel: (data) => ipcRenderer.invoke('create-auto-label', data),
  updateAutoLabel: (id, data) => ipcRenderer.invoke('update-auto-label', { id, data }),
  deleteAutoLabel: (id) => ipcRenderer.invoke('delete-auto-label', id),
  evaluateAutoLabels: (items) => ipcRenderer.invoke('evaluate-auto-labels', { items }),
  applyAutoLabelSuggestions: (suggestions) => ipcRenderer.invoke('apply-auto-label-suggestions', { suggestions }),
  updateHistoryComment: (id, comment) => ipcRenderer.invoke('update-history-comment', { id, comment }),
  updateDirHistoryComment: (id, comment) => ipcRenderer.invoke('update-dir-history-comment', { id, comment }),

  // File Type operations
  getFileTypeIcons: () => ipcRenderer.invoke('get-file-type-icons'),
  getFileTypes: () => ipcRenderer.invoke('get-file-types'),
  addFileType: (pattern, type, icon, openWith) => ipcRenderer.invoke('add-file-type', { pattern, type, icon, openWith }),
  updateFileType: (pattern, newPattern, newType, icon, openWith) => ipcRenderer.invoke('update-file-type', { pattern, newPattern, newType, icon, openWith }),
  deleteFileType: (pattern) => ipcRenderer.invoke('delete-file-type', pattern),

  // Attribute operations
  getAttributesList: () => ipcRenderer.invoke('get-attributes-list'),
  saveAttribute: (attrData) => ipcRenderer.invoke('save-attribute', attrData),
  updateAttribute: (name, attrData) => ipcRenderer.invoke('update-attribute', { name, ...attrData }),
  deleteAttribute: (name) => ipcRenderer.invoke('delete-attribute', name),
  getFileAttributes: (inode, dir_id) => ipcRenderer.invoke('get-file-attributes', { inode, dir_id }),
  setFileAttributes: (inode, dir_id, attributes) => ipcRenderer.invoke('set-file-attributes', { inode, dir_id, attributes }),
  getItemStats: (itemPath) => ipcRenderer.invoke('get-item-stats', { itemPath }),
  deleteItems: (items) => ipcRenderer.invoke('delete-items', items),
  createFolder: (parentPath, folderName) => ipcRenderer.invoke('create-folder', { parentPath, folderName }),
  moveItems: (items, targetDirPath, onCollision) => ipcRenderer.invoke('move-items', { items, targetDirPath, onCollision }),
  copyItems: (items, targetDirPath, onCollision) => ipcRenderer.invoke('copy-items', { items, targetDirPath, onCollision }),
  checkCollisions: (items, targetDirPath) => ipcRenderer.invoke('check-collisions', { items, targetDirPath }),

  /**
   * Cross-app drag IN: turn a renderer-side `File` object (from
   * `event.dataTransfer.files`) into the absolute filesystem path. Newer
   * Electron versions removed the legacy `File.path` property; use
   * `webUtils.getPathForFile()` instead.
   */
  getPathForFile: (file) => {
    try { return webUtils && typeof webUtils.getPathForFile === 'function' ? webUtils.getPathForFile(file) : (file && file.path) || ''; }
    catch (_) { return (file && file.path) || ''; }
  },

  /**
   * Cross-app drag OUT: ask the main process to start an OS-level drag of the
   * given absolute paths so they can be dropped on Explorer/Finder/etc.
   *
   * Uses synchronous IPC (`sendSync`) because `webContents.startDrag` MUST be
   * called while the renderer's dragstart tick is still alive. Any async hop
   * (`invoke`, `send`) lets the event loop turn first and the native drag
   * source is torn down, which on Windows crashes the main process with
   * "crashpad: not connected".
   */
  startExternalDrag: (filePaths) => {
    try { return ipcRenderer.sendSync('start-external-drag', { filePaths }); }
    catch (_) { return { ok: false }; }
  },

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  isDirectory: (dirPath) => ipcRenderer.invoke('is-directory', dirPath),
  
  // Hotkeys
  getHotkeys: () => ipcRenderer.invoke('get-hotkeys'),
  saveHotkeys: (hotkeyData) => ipcRenderer.invoke('save-hotkeys', hotkeyData),
  
  // Window icon update
  updateWindowIcon: (categoryName, initials) =>
    ipcRenderer.invoke('update-window-icon', { categoryName, initials }),

  // Generate folder icon
  generateFolderIcon: (bgColor, textColor, initials) =>
    ipcRenderer.invoke('generate-folder-icon', { bgColor, textColor, initials }),

  // Generate tag icon
  generateTagIcon: (bgColor, textColor) =>
    ipcRenderer.invoke('generate-tag-icon', { bgColor, textColor }),
  
  // Directory initials
  getDirectoryInitials: (dirPath) =>
    ipcRenderer.invoke('get-directory-initials', dirPath),
  saveDirectoryInitials: (dirPath, initials) =>
    ipcRenderer.invoke('save-directory-initials', { dirPath, initials }),

  // Directory labels (initials + display name with inheritance)
  getDirectoryLabels: (dirPath) =>
    ipcRenderer.invoke('get-directory-labels', dirPath),
  saveDirectoryLabels: (dirPath, labels) =>
    ipcRenderer.invoke('save-directory-labels', { dirPath, labels }),

  // Window title
  setWindowTitle: (title) =>
    ipcRenderer.invoke('set-window-title', { title }),
  
  // Window control
  closeWindow: () => ipcRenderer.invoke('close-window'),
  onCloseRequest: (callback) => ipcRenderer.on('request-close-app', callback),
  allowClose: () => ipcRenderer.send('allow-close-app'),
  
  // Notes file operations
  readFileContent: (filePath) => ipcRenderer.invoke('read-file-content', filePath),
  writeFileContent: (filePath, content) => ipcRenderer.invoke('write-file-content', { filePath, content }),

  // TODO operations
  parseTodoSection: (sectionContent) => ipcRenderer.invoke('parse-todo-section', sectionContent),
  normalizeTodoSection: (sectionContent) => ipcRenderer.invoke('normalize-todo-section', sectionContent),
  updateTodoItems: (sectionContent, updates) => ipcRenderer.invoke('update-todo-items', { sectionContent, updates }),

  // TODO aggregation (sidebar TODO section)
  getTodoAggregates: (opts) => ipcRenderer.invoke('get-todo-aggregates', opts || {}),
  refreshTodoAggregate: (notesPath, dirId) => ipcRenderer.invoke('refresh-todo-aggregate', { notesPath, dirId }),
  refreshTodoAggregates: () => ipcRenderer.invoke('refresh-todo-aggregates'),
  onTodoAggregatesChanged: (callback) => ipcRenderer.on('todo-aggregates-changed', () => callback()),

  // Markdown rendering via IPC
  renderMarkdown: (content) => ipcRenderer.invoke('render-markdown', content),

  // EXIF metadata
  getExifData: (filePath) => ipcRenderer.invoke('get-exif-data', filePath),
  
  // File history operations
  getItemHistory: (item) => ipcRenderer.invoke('get-item-history', item),
  getFileHistory: (inode) => ipcRenderer.invoke('get-file-history', inode),
  getFileRecordByPath: (filePath) => ipcRenderer.invoke('get-file-record-by-path', { filePath }),

  // Alerts
  getAlertsSummary: () => ipcRenderer.invoke('get-alerts-summary'),
  getAlertsHistory: () => ipcRenderer.invoke('get-alerts-history'),
  getUnacknowledgedAlertCount: () => ipcRenderer.invoke('get-unacknowledged-alert-count'),
  acknowledgeAlerts: (ids, comment) => ipcRenderer.invoke('acknowledge-alerts', { ids, comment }),
  getAlertRules: () => ipcRenderer.invoke('get-alert-rules'),
  saveAlertRule: (rule) => ipcRenderer.invoke('save-alert-rule', rule),
  deleteAlertRules: (ids) => ipcRenderer.invoke('delete-alert-rules', { ids }),
  getMonitoringRules: () => ipcRenderer.invoke('get-monitoring-rules'),
  saveMonitoringRule: (rule) => ipcRenderer.invoke('save-monitoring-rule', rule),
  deleteMonitoringRules: (ids) => ipcRenderer.invoke('delete-monitoring-rules', { ids }),
  startActiveMonitoring: () => ipcRenderer.invoke('start-active-monitoring'),
  stopActiveMonitoring: () => ipcRenderer.invoke('stop-active-monitoring'),
  
  // Custom Actions
  getCustomActions: () => ipcRenderer.invoke('get-custom-actions'),
  saveCustomAction: (entry) => ipcRenderer.invoke('save-custom-action', entry),
  deleteCustomAction: (id) => ipcRenderer.invoke('delete-custom-action', id),
  verifyCustomAction: (id) => ipcRenderer.invoke('verify-custom-action', id),
  runCustomAction: (actionId, filePath) => ipcRenderer.invoke('run-custom-action', { actionId, filePath }),
  runCustomActionInTerminal: (actionId, filePath, terminalId) => ipcRenderer.invoke('run-custom-action-in-terminal', { actionId, filePath, terminalId }),
  openInDefaultApp: (filePath) => ipcRenderer.invoke('open-in-default-app', filePath),
  openExternalLink: (url) => ipcRenderer.invoke('open-external-link', url),
  pickFile: (options) => ipcRenderer.invoke('pick-file', options || {}),

  // Layout save/load
  saveLayout: (layoutData) => ipcRenderer.invoke('save-layout', layoutData),
  saveLayoutToPath: (filePath, layoutData, thumbnailBase64) => ipcRenderer.invoke('save-layout-to-path', { filePath, layoutData, thumbnailBase64 }),
  captureThumbnail: () => ipcRenderer.invoke('capture-thumbnail'),
  loadLayout: () => ipcRenderer.invoke('load-layout'),
  listLayouts: () => ipcRenderer.invoke('list-layouts'),
  loadLayoutFile: (filePath) => ipcRenderer.invoke('load-layout-file', filePath),
  deleteLayout: (filePath) => ipcRenderer.invoke('delete-layout', filePath),
  onLoadLayoutFromFile: (callback) => ipcRenderer.on('load-layout-from-file', (event, filePath) => callback(filePath)),

  // Dir grid layout (per-directory column/sort state)
  saveDirGridLayout: (dirname, columns, sortData) => ipcRenderer.invoke('save-dir-grid-layout', { dirname, columns, sortData }),
  getDirGridLayout: (dirname) => ipcRenderer.invoke('get-dir-grid-layout', dirname),

  // Database operations
  reinitializeDatabase: () => ipcRenderer.invoke('reinitialize-database'),

  acknowledgeDirOrphan: (orphanId) => ipcRenderer.invoke('acknowledge-dir-orphan', orphanId),

  // Background refresh (backend-driven)
  startBackgroundRefresh: (enabled, interval) => ipcRenderer.invoke('start-background-refresh', { enabled, interval }),
  stopBackgroundRefresh: () => ipcRenderer.invoke('stop-background-refresh'),
  registerWatchedPath: (panelId, dirPath) => ipcRenderer.invoke('register-watched-path', { panelId, dirPath }),
  unregisterWatchedPath: (panelId) => ipcRenderer.invoke('unregister-watched-path', { panelId }),
  
  // Generic IPC invoke for custom handlers
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  
  onDirectoryChanged: (callback) => ipcRenderer.on('directory-changed', (event, data) => callback(data)),
  onAlertCountUpdated: (callback) => ipcRenderer.on('alert-count-updated', (event, data) => callback(data)),

  // Terminal (node-pty)
  terminalCreate: (cwd) => ipcRenderer.invoke('terminal-create', cwd),
  terminalSendInput: (id, data) => ipcRenderer.invoke('terminal-input', { id, data }),
  terminalResize: (id, cols, rows) => ipcRenderer.invoke('terminal-resize', { id, cols, rows }),
  terminalDestroy: (id) => ipcRenderer.invoke('terminal-destroy', { id }),
  onTerminalOutput: (callback) => ipcRenderer.on('terminal-output', (event, args) => callback(args)),
  onTerminalExit: (callback) => ipcRenderer.on('terminal-exit', (event, args) => callback(args)),

  // Video thumbnail extraction
  getVideoThumbnail: (filePath) => ipcRenderer.invoke('get-video-thumbnail', filePath)
});
