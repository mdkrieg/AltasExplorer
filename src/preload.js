const { contextBridge, ipcRenderer } = require('electron');

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
  
  // Database operations
  // scanDirectory: (dirPath) => ipcRenderer.invoke('scan-directory', dirPath),
  scanDirectoryWithComparison: (dirPath, isManualNavigation = true) => ipcRenderer.invoke('scan-directory-with-comparison', dirPath, isManualNavigation),
  getFilesInDirectory: (dirPath) => ipcRenderer.invoke('get-files-in-directory', dirPath),

  // File change detection
  calculateFileChecksum: (filePath, inode, dirId) => 
    ipcRenderer.invoke('calculate-file-checksum', { filePath, inode, dirId }),
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
  assignCategoryToDirectory: (dirPath, categoryName) =>
    ipcRenderer.invoke('assign-category-to-directory', { dirPath, categoryName }),
  assignCategoryToDirectories: (dirPaths, categoryName) =>
    ipcRenderer.invoke('assign-category-to-directories', { dirPaths, categoryName }),
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
  
  // Directory initials
  getDirectoryInitials: (dirPath) =>
    ipcRenderer.invoke('get-directory-initials', dirPath),
  saveDirectoryInitials: (dirPath, initials) =>
    ipcRenderer.invoke('save-directory-initials', { dirPath, initials }),
  
  // Window control
  closeWindow: () => ipcRenderer.invoke('close-window'),
  onCloseRequest: (callback) => ipcRenderer.on('request-close-app', callback),
  allowClose: () => ipcRenderer.send('allow-close-app'),
  
  // Notes file operations
  readNotesFile: (notesPath) => ipcRenderer.invoke('read-notes-file', notesPath),
  writeNotesFile: (notesPath, content) => ipcRenderer.invoke('write-notes-file', { notesPath, content }),
  
  // Markdown rendering via IPC
  renderMarkdown: (content) => ipcRenderer.invoke('render-markdown', content),
  
  // File history operations
  getFileHistory: (inode) => ipcRenderer.invoke('get-file-history', inode),
  
  // Database operations
  reinitializeDatabase: () => ipcRenderer.invoke('reinitialize-database'),

  // Background refresh (backend-driven)
  startBackgroundRefresh: (enabled, interval) => ipcRenderer.invoke('start-background-refresh', { enabled, interval }),
  stopBackgroundRefresh: () => ipcRenderer.invoke('stop-background-refresh'),
  registerWatchedPath: (panelId, dirPath) => ipcRenderer.invoke('register-watched-path', { panelId, dirPath }),
  unregisterWatchedPath: (panelId) => ipcRenderer.invoke('unregister-watched-path', { panelId }),
  onDirectoryChanged: (callback) => ipcRenderer.on('directory-changed', (event, data) => callback(data))
});
