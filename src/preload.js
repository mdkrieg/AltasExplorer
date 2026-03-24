const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // File system operations
  readDirectory: (dirPath) => ipcRenderer.invoke('read-directory', dirPath),
  
  // Database operations
  scanDirectory: (dirPath) => ipcRenderer.invoke('scan-directory', dirPath),
  getFilesInDirectory: (dirPath) => ipcRenderer.invoke('get-files-in-directory', dirPath),

  // Category operations
  loadCategories: () => ipcRenderer.invoke('load-categories'),
  getCategory: (name) => ipcRenderer.invoke('get-category', name),
  createCategory: (name, bgColor, textColor, patterns) =>
    ipcRenderer.invoke('create-category', { name, bgColor, textColor, patterns }),
  updateCategory: (name, bgColor, textColor, patterns) =>
    ipcRenderer.invoke('update-category', { name, bgColor, textColor, patterns }),
  deleteCategory: (name) => ipcRenderer.invoke('delete-category', name),
  
  // Directory assignments
  assignCategoryToDirectory: (dirPath, categoryName) =>
    ipcRenderer.invoke('assign-category-to-directory', { dirPath, categoryName }),
  getDirectoryAssignment: (dirPath) =>
    ipcRenderer.invoke('get-directory-assignment', dirPath),
  removeDirectoryAssignment: (dirPath) =>
    ipcRenderer.invoke('remove-directory-assignment', dirPath),
  getCategoryForDirectory: (dirPath) =>
    ipcRenderer.invoke('get-category-for-directory', dirPath),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  
  // Window icon update
  updateWindowIcon: (categoryName) =>
    ipcRenderer.invoke('update-window-icon', categoryName),

  // Generate folder icon
  generateFolderIcon: (bgColor, textColor) =>
    ipcRenderer.invoke('generate-folder-icon', { bgColor, textColor }),
  
  // Notes file operations
  readNotesFile: (notesPath) => ipcRenderer.invoke('read-notes-file', notesPath),
  writeNotesFile: (notesPath, content) => ipcRenderer.invoke('write-notes-file', { notesPath, content })
});
