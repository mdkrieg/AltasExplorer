/*
 * Drag Tray renderer
 *
 * Owns the tray window's DOM:
 *   - Receives the initial item list from main via `drag-tray-init` IPC.
 *   - Renders one wide tile per item with a generic icon (folder vs file)
 *     and the filename.
 *   - On a tile's `dragstart`, calls window.electronAPI.startExternalDrag
 *     (sync IPC -> webContents.startDrag) so the drop is delivered to whatever
 *     app the user releases over (Windows Explorer, etc.). Single-tile drag
 *     in v1; multi-tile aggregate drag deferred.
 *   - X button and clicks on the empty list background close the tray.
 *   - Tile clicks do NOT close the tray (would race with dragstart).
 */
(function () {
  'use strict';

  const list = document.getElementById('tray-list');
  const closeBtn = document.getElementById('tray-close');

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderTiles(items) {
    list.innerHTML = '';
    if (!Array.isArray(items) || items.length === 0) return;
    const frag = document.createDocumentFragment();
    for (const item of items) {
      if (!item || !item.path) continue;
      const tile = document.createElement('div');
      tile.className = 'tray-tile';
      tile.setAttribute('draggable', 'true');
      tile.dataset.path = item.path;
      const iconChar = item.isFolder ? '\u{1F4C1}' : '\u{1F4C4}'; // folder / page emoji as generic glyphs
      tile.innerHTML =
        '<span class="tray-tile-icon ' + (item.isFolder ? 'is-folder' : 'is-file') + '">' +
          iconChar +
        '</span>' +
        '<span class="tray-tile-name" title="' + escapeHtml(item.path) + '">' +
          escapeHtml(item.name || item.path) +
        '</span>';
      frag.appendChild(tile);
    }
    list.appendChild(frag);
  }

  // dragstart on a tile -> hand off to OS-level drag via main process.
  list.addEventListener('dragstart', (e) => {
    const tile = e.target && e.target.closest && e.target.closest('.tray-tile');
    if (!tile) { e.preventDefault(); return; }
    const filePath = tile.dataset.path;
    if (!filePath) { e.preventDefault(); return; }
    // Suppress HTML5 drag; webContents.startDrag must own the drag-source.
    e.preventDefault();
    try {
      if (window.electronAPI && typeof window.electronAPI.startExternalDrag === 'function') {
        window.electronAPI.startExternalDrag([filePath]);
      }
    } catch (_) { /* non-fatal */ }
  });

  // Close on X button or click on empty list background.
  closeBtn.addEventListener('click', () => {
    try { window.electronAPI && window.electronAPI.closeDragTray && window.electronAPI.closeDragTray(); }
    catch (_) { /* ignore */ }
  });
  list.addEventListener('mousedown', (e) => {
    // Only fire when the click lands on the list itself (not a tile).
    if (e.target === list) {
      try { window.electronAPI && window.electronAPI.closeDragTray && window.electronAPI.closeDragTray(); }
      catch (_) { /* ignore */ }
    }
  });

  // Receive items from main.
  if (window.electronAPI && typeof window.electronAPI.onDragTrayInit === 'function') {
    window.electronAPI.onDragTrayInit((payload) => {
      renderTiles((payload && payload.items) || []);
    });
  }
})();
