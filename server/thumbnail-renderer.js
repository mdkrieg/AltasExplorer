/**
 * server/thumbnail-renderer.js
 *
 * Client-side captureThumbnail replacement for the server layer.
 * Injected as a plain <script> AFTER client-api.js by server/build.js,
 * so it can safely override window.electronAPI.captureThumbnail.
 *
 * Strategy:
 *   - Read window.__atlasPanelState (populated by build.js appending
 *     `window.__atlasPanelState = panelState;` to dist/app/js/renderer.js)
 *   - Build a hidden off-screen div that mirrors the visible panel layout
 *   - Draw it to a Canvas, return the PNG as base64
 *
 * Returns { success: true, thumbnailBase64: string }
 * (same shape as Electron's capturePage-based implementation in main.js)
 */

(function () {
  'use strict';

  // ── Visual constants — tweak here without touching the logic ──────────────
  const THUMB_WIDTH   = 800;
  const THUMB_HEIGHT  = 500;
  const BG_COLOR      = '#1e1e2e';   // Catppuccin Mocha base
  const PANEL_BG      = '#181825';   // Catppuccin Mocha mantle
  const PANEL_HEADER  = '#313244';   // Catppuccin Mocha surface0
  const PANEL_BORDER  = '#45475a';   // Catppuccin Mocha surface1
  const TEXT_COLOR    = '#cdd6f4';   // Catppuccin Mocha text
  const TEXT_MUTED    = '#6c7086';   // Catppuccin Mocha overlay0
  const PANEL_GAP     = 4;
  const HEADER_HEIGHT = 36;
  const FOLDER_ICON_SIZE = 56;
  const FILE_ICON_SIZE   = 40;
  const ROW_HEIGHT       = 26;
  const FONT_BODY        = '13px "Segoe UI", system-ui, sans-serif';
  const FONT_HEADER      = 'bold 12px "Segoe UI", system-ui, sans-serif';
  const FONT_ICON_LABEL  = 'bold 18px "Segoe UI", system-ui, sans-serif';

  // ── Helper: draw a rounded rect ───────────────────────────────────────────
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // ── Helper: draw a folder icon with initials ──────────────────────────────
  function drawFolderIcon(ctx, cx, cy, size, bgColor, initials) {
    const half = size / 2;
    // Tab
    ctx.fillStyle = bgColor;
    roundRect(ctx, cx - half, cy - half, size * 0.45, size * 0.22, 3);
    ctx.fill();
    // Body
    roundRect(ctx, cx - half, cy - half + size * 0.18, size, size * 0.82, 4);
    ctx.fill();
    // Initials
    if (initials) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = `bold ${Math.round(size * 0.32)}px "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(initials.slice(0, 3), cx, cy + size * 0.1);
    }
  }

  // ── Helper: draw a file rows list ─────────────────────────────────────────
  function drawFileRows(ctx, x, y, w, records, maxRows) {
    ctx.font = FONT_BODY;
    ctx.textBaseline = 'middle';
    const count = Math.min(records.length, maxRows);
    for (let i = 0; i < count; i++) {
      const ry = y + i * ROW_HEIGHT;
      if (i % 2 === 1) {
        ctx.fillStyle = 'rgba(255,255,255,0.04)';
        ctx.fillRect(x, ry, w, ROW_HEIGHT);
      }
      ctx.fillStyle = TEXT_COLOR;
      ctx.textAlign = 'left';
      const label = String(records[i].filename || records[i].name || '');
      ctx.fillText(label, x + 8, ry + ROW_HEIGHT / 2, w - 16);
    }
  }

  // ── Core render function ──────────────────────────────────────────────────
  function renderThumbnail() {
    const state = window.__atlasPanelState;
    if (!state) return null;

    const canvas  = document.createElement('canvas');
    canvas.width  = THUMB_WIDTH;
    canvas.height = THUMB_HEIGHT;
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, THUMB_WIDTH, THUMB_HEIGHT);

    // Determine visible panel IDs (those with a currentPath set)
    const panelIds = Object.keys(state).filter(id => state[id] && state[id].currentPath);
    if (panelIds.length === 0) {
      // Nothing open — return a blank thumbnail
      return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
    }

    const panelCount = panelIds.length;
    const panelWidth = Math.floor((THUMB_WIDTH - PANEL_GAP * (panelCount + 1)) / panelCount);

    panelIds.forEach((panelId, idx) => {
      const ps  = state[panelId];
      const px  = PANEL_GAP + idx * (panelWidth + PANEL_GAP);
      const py  = PANEL_GAP;
      const ph  = THUMB_HEIGHT - PANEL_GAP * 2;

      // Panel background
      ctx.fillStyle = PANEL_BG;
      roundRect(ctx, px, py, panelWidth, ph, 6);
      ctx.fill();

      // Panel border
      ctx.strokeStyle = PANEL_BORDER;
      ctx.lineWidth = 1;
      roundRect(ctx, px, py, panelWidth, ph, 6);
      ctx.stroke();

      // Panel header bar
      ctx.fillStyle = PANEL_HEADER;
      roundRect(ctx, px, py, panelWidth, HEADER_HEIGHT, 6);
      ctx.fill();
      // Square off bottom of header
      ctx.fillRect(px, py + HEADER_HEIGHT / 2, panelWidth, HEADER_HEIGHT / 2);

      // Panel path text in header
      const pathStr = ps.currentPath || '';
      const displayPath = pathStr.length > 42 ? '…' + pathStr.slice(-40) : pathStr;
      ctx.fillStyle = TEXT_COLOR;
      ctx.font = FONT_HEADER;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(displayPath, px + 10, py + HEADER_HEIGHT / 2, panelWidth - 20);

      // Panel body content area
      const contentX = px + 8;
      const contentY = py + HEADER_HEIGHT + 10;
      const contentW = panelWidth - 16;
      const contentH = ph - HEADER_HEIGHT - 16;

      // Determine view type
      const viewType = ps.fileViewPath ? 'fileview'
                     : ps.notesFilePath ? 'notes'
                     : 'grid';

      if (viewType === 'notes') {
        // Notes panel: show a faint page icon
        ctx.fillStyle = TEXT_MUTED;
        ctx.font = '32px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('📄', contentX + contentW / 2, contentY + contentH / 3);
        ctx.font = FONT_BODY;
        ctx.fillStyle = TEXT_MUTED;
        ctx.fillText('notes', contentX + contentW / 2, contentY + contentH / 3 + 28);
      } else if (viewType === 'fileview') {
        // File view panel: show filename + generic file icon
        const filename = (ps.fileViewPath || '').split('/').pop().split('\\').pop();
        const iconSize = FILE_ICON_SIZE;
        const iconX    = contentX + contentW / 2;
        const iconY    = contentY + contentH / 4;

        ctx.fillStyle = PANEL_BORDER;
        roundRect(ctx, iconX - iconSize / 2, iconY - iconSize / 2, iconSize, iconSize, 5);
        ctx.fill();
        ctx.fillStyle = TEXT_MUTED;
        ctx.font = '11px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('FILE', iconX, iconY);

        ctx.fillStyle = TEXT_COLOR;
        ctx.font = FONT_BODY;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(filename, iconX, iconY + iconSize / 2 + 8, contentW);
      } else {
        // Grid panel: folder icon + directory name + row list
        const dirName = pathStr.split('/').pop().split('\\').pop() || pathStr;
        const initials = (ps.currentCategory || dirName)
          .replace(/[^a-zA-Z0-9]/g, '')
          .slice(0, 2)
          .toUpperCase();
        const folderColor = ps.currentCategory
          ? '#89b4fa'   // blue if categorized
          : '#a6e3a1';  // green default

        const iconCX = contentX + contentW / 2;
        const iconCY = contentY + FOLDER_ICON_SIZE / 2 + 6;
        drawFolderIcon(ctx, iconCX, iconCY, FOLDER_ICON_SIZE, folderColor, initials);

        // Directory name below icon
        ctx.fillStyle = TEXT_COLOR;
        ctx.font = FONT_HEADER;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(dirName, iconCX, iconCY + FOLDER_ICON_SIZE / 2 + 8, contentW);

        // File rows (from sourceRecords if available)
        const records = Array.isArray(ps.sourceRecords) ? ps.sourceRecords : [];
        const rowsTop = iconCY + FOLDER_ICON_SIZE / 2 + 32;
        const maxRows = Math.floor((contentY + contentH - rowsTop) / ROW_HEIGHT);
        if (maxRows > 0 && records.length > 0) {
          drawFileRows(ctx, contentX, rowsTop, contentW, records, maxRows);
        } else if (maxRows > 0) {
          ctx.fillStyle = TEXT_MUTED;
          ctx.font = FONT_BODY;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('(empty)', iconCX, rowsTop + ROW_HEIGHT / 2);
        }
      }
    });

    return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
  }

  // ── Override window.electronAPI.captureThumbnail ──────────────────────────
  if (window.electronAPI) {
    window.electronAPI.captureThumbnail = function () {
      return new Promise((resolve) => {
        try {
          const thumbnailBase64 = renderThumbnail();
          if (thumbnailBase64) {
            resolve({ success: true, thumbnailBase64 });
          } else {
            resolve({ success: false, thumbnailBase64: null });
          }
        } catch (err) {
          console.warn('[thumbnail-renderer] Error:', err);
          resolve({ success: false, thumbnailBase64: null });
        }
      });
    };
  }

})();
