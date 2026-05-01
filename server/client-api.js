/**
 * server/client-api.js
 *
 * Browser-side window.electronAPI polyfill for the server layer.
 * Injected as a plain <script> by server/build.js before renderer.js.
 *
 * Architecture:
 *   - All request/response API methods → POST /api  { method, args }
 *   - Push event listeners              → WebSocket /ws message routing
 *   - Terminal methods                  → WebSocket /ws sends
 *   - Window management                → no-ops / document.title
 *
 * The Proxy-based approach means adding new API methods server-side
 * requires zero changes here — they work automatically.
 */

(function () {
  'use strict';

  // ── WebSocket connection ──────────────────────────────────────────────────

  const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  let ws       = null;
  let wsReady  = false;
  const wsQueue    = [];   // messages buffered before connection opens
  const wsListeners = {};  // type → [callback, ...]

  function connectWS() {
    ws = new WebSocket(WS_URL);

    ws.addEventListener('open', () => {
      wsReady = true;
      wsQueue.splice(0).forEach(msg => ws.send(msg));
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      const cbs = wsListeners[msg.type] || [];
      cbs.forEach(cb => { try { cb(msg); } catch { /* ignore */ } });
    });

    ws.addEventListener('close', () => {
      wsReady = false;
      // Reconnect after a short delay
      setTimeout(connectWS, 3000);
    });

    ws.addEventListener('error', () => { /* close handler will reconnect */ });
  }

  function wsSend(obj) {
    const msg = JSON.stringify(obj);
    if (wsReady && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    } else {
      wsQueue.push(msg);
    }
  }

  function onWS(type, callback) {
    if (!wsListeners[type]) wsListeners[type] = [];
    wsListeners[type].push(callback);
  }

  connectWS();

  // ── REST API call ─────────────────────────────────────────────────────────

  function call(method, args) {
    return fetch('/api', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body:    JSON.stringify({ method, args }),
    }).then(r => {
      if (r.status === 401) {
        // Session expired — redirect to login
        location.href = '/auth/login';
        return Promise.reject(new Error('Session expired'));
      }
      return r.json();
    }).then(r => {
      if (r.error) throw new Error(r.error);
      return r.result;
    });
  }

  // ── Terminal ID tracking ──────────────────────────────────────────────────
  // terminalCreate returns a promise that resolves to the server-assigned id.

  const pendingTerminalCreates = {}; // callback waiting for terminal:created

  onWS('terminal:created', (msg) => {
    // We correlate by being the only pending create at a time; a real impl
    // would use a request correlation id. For now, FIFO queue is sufficient
    // since terminal creates are user-initiated one at a time.
    const next = pendingTerminalCreates._queue && pendingTerminalCreates._queue.shift();
    if (next) next(msg.id);
  });

  if (!pendingTerminalCreates._queue) pendingTerminalCreates._queue = [];

  // ── window.electronAPI ────────────────────────────────────────────────────

  window.electronAPI = {

    // ── Generic passthrough (for any method not explicitly listed) ──────────
    invoke: (channel, ...args) => call(channel, args),

    // ── Categories ──────────────────────────────────────────────────────────
    loadCategories:               ()                             => call('loadCategories', []),
    getCategory:                  (name)                         => call('getCategory', [name]),
    getCategoriesList:            ()                             => call('getCategoriesList', []),
    createCategory:               (name, bgColor, textColor, patterns) => call('createCategory', [name, bgColor, textColor, patterns]),
    saveCategory:                 (categoryData)                 => call('saveCategory', [categoryData]),
    updateCategory:               (name, categoryData)           => call('updateCategory', [name, categoryData]),
    deleteCategory:               (name)                         => call('deleteCategory', [name]),
    assignCategoryToDirectory:    (dirPath, categoryName, force) => call('assignCategoryToDirectory', [dirPath, categoryName, force]),
    assignCategoryToDirectories:  (dirPaths, categoryName, force) => call('assignCategoryToDirectories', [dirPaths, categoryName, force]),
    getDirectoryAssignment:       (dirPath)                      => call('getDirectoryAssignment', [dirPath]),
    removeDirectoryAssignment:    (dirPath)                      => call('removeDirectoryAssignment', [dirPath]),
    getCategoryForDirectory:      (dirPath)                      => call('getCategoryForDirectory', [dirPath]),

    // ── Tags ─────────────────────────────────────────────────────────────────
    loadTags:          ()                                        => call('loadTags', []),
    getTag:            (name)                                    => call('getTag', [name]),
    getTagsList:       ()                                        => call('getTagsList', []),
    createTag:         (name, bgColor, textColor, description)   => call('createTag', [name, bgColor, textColor, description]),
    saveTag:           (tagData)                                 => call('saveTag', [tagData]),
    updateTag:         (name, tagData)                           => call('updateTag', [name, tagData]),
    deleteTag:         (name)                                    => call('deleteTag', [name]),
    addTagToItem:      (data)                                    => call('addTagToItem', [data]),
    removeTagFromItem: (data)                                    => call('removeTagFromItem', [data]),

    // ── Auto-Labels ──────────────────────────────────────────────────────────
    loadAutoLabels:            ()                   => call('loadAutoLabels', []),
    getAutoLabel:              (id)                 => call('getAutoLabel', [id]),
    createAutoLabel:           (data)               => call('createAutoLabel', [data]),
    updateAutoLabel:           (id, data)           => call('updateAutoLabel', [id, data]),
    deleteAutoLabel:           (id)                 => call('deleteAutoLabel', [id]),
    evaluateAutoLabels:        (items)              => call('evaluateAutoLabels', [items]),
    applyAutoLabelSuggestions: (suggestions)        => call('applyAutoLabelSuggestions', [suggestions]),
    updateHistoryComment:      (id, comment)        => call('updateHistoryComment', [id, comment]),
    updateDirHistoryComment:   (id, comment)        => call('updateDirHistoryComment', [id, comment]),

    // ── Attributes ───────────────────────────────────────────────────────────
    getAttributesList: ()                               => call('getAttributesList', []),
    saveAttribute:     (attrData)                       => call('saveAttribute', [attrData]),
    updateAttribute:   (name, attrData)                 => call('updateAttribute', [name, attrData]),
    deleteAttribute:   (name)                           => call('deleteAttribute', [name]),
    getFileAttributes: (inode, dir_id)                  => call('getFileAttributes', [inode, dir_id]),
    setFileAttributes: (inode, dir_id, attributes)      => call('setFileAttributes', [inode, dir_id, attributes]),
    getItemStats:      (itemPath)                       => call('getItemStats', [itemPath]),

    // ── File Types ───────────────────────────────────────────────────────────
    getFileTypeIcons: ()                                        => call('getFileTypeIcons', []),
    getFileTypes:     ()                                        => call('getFileTypes', []),
    addFileType:      (pattern, type, icon, openWith)           => call('addFileType', [pattern, type, icon, openWith]),
    updateFileType:   (pattern, newPattern, newType, icon, openWith) => call('updateFileType', [pattern, newPattern, newType, icon, openWith]),
    deleteFileType:   (pattern)                                 => call('deleteFileType', [pattern]),

    // ── Settings & Config ─────────────────────────────────────────────────────
    getSettings:   ()          => call('getSettings', []),
    saveSettings:  (settings)  => call('saveSettings', [settings]),
    getHotkeys:    ()          => call('getHotkeys', []),
    saveHotkeys:   (hotkeyData) => call('saveHotkeys', [hotkeyData]),
    getFavorites:  ()          => call('getFavorites', []),
    saveFavorites: (favorites) => call('saveFavorites', [favorites]),

    // ── Filesystem Reads ──────────────────────────────────────────────────────
    readDirectory:              (dirPath)  => call('readDirectory', [dirPath]),
    getRootDrives:              ()         => call('getRootDrives', []),
    getParentDirectoryMetadata: (dirPath)  => call('getParentDirectoryMetadata', [dirPath]),
    getShortcutsInDirectory:    (dirPath)  => call('getShortcutsInDirectory', [dirPath]),
    getFilesInDirectory:        (dirPath)  => call('getFilesInDirectory', [dirPath]),
    isDirectory:                (dirPath)  => call('isDirectory', [dirPath]),

    // ── Filesystem Scan ───────────────────────────────────────────────────────
    scanDirectoryWithComparison: (dirPath, isManualNavigation)   => call('scanDirectoryWithComparison', [dirPath, isManualNavigation]),
    getVirtualView:              (basePath, params, depth)       => call('getVirtualView', [basePath, params, depth]),
    getBadgeCounts:              (dirPath, depth)                => call('getBadgeCounts', [dirPath, depth]),

    // ── Filesystem Mutations ──────────────────────────────────────────────────
    createFolder:    (parentPath, folderName)           => call('createFolder', [parentPath, folderName]),
    deleteItems:     (items)                            => call('deleteItems', [items]),
    moveItems:       (items, targetDirPath, onCollision) => call('moveItems', [items, targetDirPath, onCollision]),
    copyItems:       (items, targetDirPath, onCollision) => call('copyItems', [items, targetDirPath, onCollision]),
    checkCollisions: (items, targetDirPath)             => call('checkCollisions', [items, targetDirPath]),

    // ── Trash ─────────────────────────────────────────────────────────────────
    restoreFromTrash:           (items) => call('restoreFromTrash', [items]),
    permanentlyDeleteFromTrash: (items) => call('permanentlyDeleteFromTrash', [items]),

    // ── File Change Detection ─────────────────────────────────────────────────
    calculateFileChecksum:     (filePath, inode, dirId, isManual) => call('calculateFileChecksum', [filePath, inode, dirId, isManual]),
    updateFileModificationDate: (dirPath, inode, newDateModified)  => call('updateFileModificationDate', [dirPath, inode, newDateModified]),

    // ── Directory Labels & Initials ───────────────────────────────────────────
    getDirectoryInitials:  (dirPath)          => call('getDirectoryInitials', [dirPath]),
    saveDirectoryInitials: (dirPath, initials) => call('saveDirectoryInitials', [dirPath, initials]),
    getDirectoryLabels:    (dirPath)          => call('getDirectoryLabels', [dirPath]),
    saveDirectoryLabels:   (dirPath, labels)  => call('saveDirectoryLabels', [dirPath, labels]),

    // ── Dir Grid Layout ───────────────────────────────────────────────────────
    saveDirGridLayout: (dirname, columns, sortData) => call('saveDirGridLayout', [dirname, columns, sortData]),
    getDirGridLayout:  (dirname)                    => call('getDirGridLayout', [dirname]),
    setCategoryDefaultGridLayout: (name, columns, sortData) => call('setCategoryDefaultGridLayout', [name, columns, sortData]),
    getCategoryDefaultGridLayout: (name)                    => call('getCategoryDefaultGridLayout', [name]),

    // ── Notes File I/O ────────────────────────────────────────────────────────
    readFileContent:  (filePath)          => call('readFileContent', [filePath]),
    writeFileContent: (filePath, content) => call('writeFileContent', [filePath, content]),
    saveNotesImage:   (opts)              => call('saveNotesImage', [opts]),

    // ── Notes Parser ──────────────────────────────────────────────────────────
    parseTodoSection:             (sectionContent)          => call('parseTodoSection', [sectionContent]),
    normalizeTodoSection:         (sectionContent)          => call('normalizeTodoSection', [sectionContent]),
    updateTodoItems:              (sectionContent, updates) => call('updateTodoItems', [sectionContent, updates]),
    parseReminderSection:         (sectionContent)          => call('parseReminderSection', [sectionContent]),
    normalizeReminderSection:     (sectionContent)          => call('normalizeReminderSection', [sectionContent]),
    parseTodoBlocksWithReminders: (sectionContent)          => call('parseTodoBlocksWithReminders', [sectionContent]),
    renderMarkdown:               (content, basePath)       => call('renderMarkdown', [content, basePath]),

    // ── TODO Aggregates ───────────────────────────────────────────────────────
    getTodoAggregates:     (opts)             => call('getTodoAggregates', [opts]),
    refreshTodoAggregate:  (notesPath, dirId) => call('refreshTodoAggregate', [notesPath, dirId]),
    refreshTodoAggregates: ()                 => call('refreshTodoAggregates', []),
    onTodoAggregatesChanged: (callback) => onWS('push:todoAggregatesChanged', callback),

    // ── Reminder Aggregates ───────────────────────────────────────────────────
    getReminderAggregates:     ()                 => call('getReminderAggregates', []),
    refreshReminderAggregate:  (notesPath, dirId) => call('refreshReminderAggregate', [notesPath, dirId]),
    refreshReminderAggregates: ()                 => call('refreshReminderAggregates', []),
    onReminderAggregatesChanged: (callback) => onWS('push:reminderAggregatesChanged', callback),

    // ── File History ──────────────────────────────────────────────────────────
    getItemHistory:      (item)     => call('getItemHistory', [item]),
    getFileHistory:      (inode)    => call('getFileHistory', [inode]),
    getFileRecordByPath: (filePath) => call('getFileRecordByPath', [filePath]),

    // ── Alerts ────────────────────────────────────────────────────────────────
    getAlertsSummary:            ()              => call('getAlertsSummary', []),
    getAlertsHistory:            ()              => call('getAlertsHistory', []),
    getUnacknowledgedAlertCount: ()              => call('getUnacknowledgedAlertCount', []),
    acknowledgeAlerts:           (ids, comment)  => call('acknowledgeAlerts', [ids, comment]),
    getAlertRules:               ()              => call('getAlertRules', []),
    saveAlertRule:               (rule)          => call('saveAlertRule', [rule]),
    deleteAlertRules:            (ids)           => call('deleteAlertRules', [ids]),
    onAlertCountUpdated: (callback) => onWS('push:alertCountUpdated', (msg) => callback(msg.count)),

    // ── Monitoring ────────────────────────────────────────────────────────────
    getMonitoringRules:    ()     => call('getMonitoringRules', []),
    saveMonitoringRule:    (rule) => call('saveMonitoringRule', [rule]),
    deleteMonitoringRules: (ids)  => call('deleteMonitoringRules', [ids]),
    startActiveMonitoring: ()     => call('startActiveMonitoring', []),
    stopActiveMonitoring:  ()     => call('stopActiveMonitoring', []),

    // ── Orphan acknowledgment ─────────────────────────────────────────────────
    acknowledgeOrphan:    (orphanId) => call('acknowledgeOrphan', [orphanId]),
    acknowledgeDirOrphan: (orphanId) => call('acknowledgeDirOrphan', [orphanId]),

    // ── Custom Actions ────────────────────────────────────────────────────────
    getCustomActions:          ()                          => call('getCustomActions', []),
    saveCustomAction:          (entry)                     => call('saveCustomAction', [entry]),
    deleteCustomAction:        (id)                        => call('deleteCustomAction', [id]),
    verifyCustomAction:        (id)                        => call('verifyCustomAction', [id]),
    runCustomAction:           (actionId, filePath)        => call('runCustomAction', [actionId, filePath]),
    runCustomActionInTerminal: (actionId, filePath, terminalId) => call('runCustomActionInTerminal', [actionId, filePath, terminalId]),
    openInDefaultApp:          (filePath)                  => call('openInDefaultApp', [filePath]),
    getDefaultApp:             (filePath)                  => Promise.resolve({ success: false }),
    resolveShortcut:           (lnkPath)                   => Promise.resolve({ success: false }),
    openExternalLink:          (url)                       => { window.open(url, '_blank', 'noopener'); return Promise.resolve({ ok: true }); },
    pickFile:                  (options)                   => call('pickFile', [options]),

    // ── Layouts ───────────────────────────────────────────────────────────────
    saveLayout:       (layoutData)                           => call('saveLayout', [layoutData]),
    saveLayoutToPath: (filePath, layoutData, thumbnailBase64) => call('saveLayoutToPath', [filePath, layoutData, thumbnailBase64]),
    loadLayout:       ()                                     => call('loadLayout', []),
    listLayouts:      ()                                     => call('listLayouts', []),
    loadLayoutFile:   (filePath)                             => call('loadLayoutFile', [filePath]),
    deleteLayout:     (filePath)                             => call('deleteLayout', [filePath]),
    onLoadLayoutFromFile: (callback) => onWS('push:loadLayoutFromFile', (msg) => callback(msg.filePath)),

    // ── Icons ─────────────────────────────────────────────────────────────────
    generateFolderIcon: (bgColor, textColor, initials) => call('generateFolderIcon', [bgColor, textColor, initials]),
    generateTagIcon:    (bgColor, textColor)           => call('generateTagIcon', [bgColor, textColor]),
    updateWindowIcon:   (categoryName, initials)       => call('updateWindowIcon', [categoryName, initials]),

    // ── Background Refresh ────────────────────────────────────────────────────
    startBackgroundRefresh: (enabled, interval) => call('startBackgroundRefresh', [enabled, interval]),
    stopBackgroundRefresh:  ()                  => call('stopBackgroundRefresh', []),
    registerWatchedPath:    (panelId, dirPath)  => call('registerWatchedPath', [panelId, dirPath]),
    unregisterWatchedPath:  (panelId)           => call('unregisterWatchedPath', [panelId]),
    onDirectoryChanged: (callback) => onWS('push:directoryChanged', (msg) => callback(msg.dirPath)),

    // ── EXIF & Video ──────────────────────────────────────────────────────────
    getExifData:       (filePath) => call('getExifData', [filePath]),
    getVideoThumbnail: (filePath) => call('getVideoThumbnail', [filePath]),

    // ── DB Admin ──────────────────────────────────────────────────────────────
    reinitializeDatabase: () => call('reinitializeDatabase', []),

    // ── Misc ──────────────────────────────────────────────────────────────────
    getAppVersion: () => call('getAppVersion', []),
    pathJoin: (...segments) => call('pathJoin', segments),

    // ── Terminal (WebSocket) ──────────────────────────────────────────────────
    terminalCreate: (cwd) => new Promise((resolve) => {
      pendingTerminalCreates._queue.push(resolve);
      wsSend({ type: 'terminal:create', cwd });
    }),
    terminalSendInput: (id, data)        => wsSend({ type: 'terminal:input', id, data }),
    terminalResize:    (id, cols, rows)  => wsSend({ type: 'terminal:resize', id, cols, rows }),
    terminalDestroy:   (id)              => wsSend({ type: 'terminal:destroy', id }),
    onTerminalOutput: (callback) => onWS('terminal:output', (msg) => callback(null, { id: msg.id, data: msg.data })),
    onTerminalExit:   (callback) => onWS('terminal:exit',   (msg) => callback(null, { id: msg.id, code: msg.code })),

    // ── Window management (no-ops / document-level) ───────────────────────────
    closeWindow:      () => Promise.resolve({ ok: true }),
    allowClose:       () => Promise.resolve({ ok: true }),
    onCloseRequest:   (_cb) => { /* no-op */ },
    setWindowTitle:   (title) => { document.title = title; return Promise.resolve({ ok: true }); },
    getPathForFile:   (_file) => Promise.resolve(''),
    startExternalDrag: (_paths) => Promise.resolve({ ok: false }),
    captureThumbnail: () => Promise.resolve({ success: false, thumbnailBase64: null }),
    // overridden by thumbnail-renderer.js which is injected after this file

    // ── Auto-update (no-ops) ──────────────────────────────────────────────────
    checkForUpdates:         () => Promise.resolve({ checking: false }),
    downloadUpdate:          () => Promise.resolve({ ok: false }),
    quitAndInstall:          () => Promise.resolve({ ok: false }),
    onUpdateAvailable:       (_cb) => { /* no-op */ },
    onUpdateNotAvailable:    (_cb) => { /* no-op */ },
    onUpdateDownloadProgress: (_cb) => { /* no-op */ },
    onUpdateDownloaded:      (_cb) => { /* no-op */ },
    onUpdateError:           (_cb) => { /* no-op */ },
  };

  // Suppress browser default context menu (same as demo)
  document.addEventListener('contextmenu', (e) => e.preventDefault());

})();
