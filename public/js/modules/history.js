/**
 * History module.
 * Owns the history modal, history timeline shaping, and change-summary rendering.
 */

import * as utils from './utils.js';
import { w2ui, w2grid } from './vendor/w2ui.es6.min.js';

const EVENT_LABELS = {
  INITIAL: 'INITIAL',
  dirSeen: 'Directory Seen',
  dirOpened: 'Directory Opened',
  dirObserved: 'Directory Observed',
  dirAdded: 'Directory Added',
  dirMoved: 'Directory Moved',
  dirOrphaned: 'Directory Orphaned',
  dirManual: 'Directory Manual Event',
  fileAdded: 'File Added',
  fileRemoved: 'File Removed',
  fileRenamed: 'File Renamed',
  fileModified: 'File Modified',
  fileChanged: 'File Changed',
  categoryChanged: 'Category Changed',
  tagAdded: 'Tag Added',
  tagRemoved: 'Tag Removed',
  autoLabelApplied: 'Auto-Label Applied'
};

let _isDirectoryItem = false;

export function hideHistoryModal() {
  $('#history-modal').hide();
  if (w2ui['history-grid']) {
    w2ui['history-grid'].destroy();
  }
}

export async function openHistoryModal(selectedRecord) {
  try {
    const result = await window.electronAPI.getItemHistory({
      isDirectory: !!selectedRecord.isFolder,
      inode: selectedRecord.inode,
      dirId: selectedRecord.dir_id || null
    });

    _isDirectoryItem = !!selectedRecord.isFolder;

    if (!result.success) {
      alert('Error loading history: ' + result.error);
      return;
    }

    $('#history-modal-title').text(`History: ${selectedRecord.filenameRaw || selectedRecord.filename}`);

    if (w2ui['history-grid']) {
      w2ui['history-grid'].destroy();
    }

    const fullState = buildCompleteFileState(result.data || [], selectedRecord);
    const historyData = formatHistoryData(result.data || [], fullState);

    $('#history-grid').empty();
    w2ui['history-grid'] = new w2grid({
      name: 'history-grid',
      box: document.getElementById('history-grid'),
      columns: [
        { field: 'detectedAt', text: 'Detected At', size: '160px', resizable: true, sortable: true },
        { field: 'changeValue', text: 'Change', size: '200px', resizable: true, sortable: true },
        { field: 'path', text: 'Path', size: '100%', resizable: true, sortable: true },
        { field: 'comment', text: 'Comment', size: '200px', resizable: true, sortable: true, editable: { type: 'text' } }
      ],
      records: historyData,
      show: { header: true, toolbar: false, footer: true },
      onClick: function (event) {
        if (event.detail && event.detail.recid) {
          const selectedIndex = event.detail.recid - 1;
          console.log('Grid row clicked, index:', selectedIndex);
          updateHistoryChangeSummary(fullState, selectedIndex);
        }
      },
      onChange: async function (event) {
        await event.complete;
        const rec = w2ui['history-grid']?.get(event.detail?.recid);
        if (!rec || event.detail?.column === undefined) return;
        const col = w2ui['history-grid'].columns[event.detail.column];
        if (!col || col.field !== 'comment') return;
        const newComment = event.detail?.value?.new ?? '';
        try {
          if (_isDirectoryItem) {
            await window.electronAPI.updateDirHistoryComment(rec._id, newComment);
          } else {
            await window.electronAPI.updateHistoryComment(rec._id, newComment);
          }
        } catch (err) {
          console.error('Failed to update comment:', err);
        }
      }
    });

    createHistorySummaryView(fullState, 0);
    $('#history-modal').css('display', 'flex');
  } catch (err) {
    console.error('Error opening history modal:', err);
    alert('Error opening history: ' + err.message);
  }
}

export function formatHistoryData(historyRecords, fullState) {
  return historyRecords.map((record, index) => ({
      recid: index + 1,
      _id: record.id,
      _rawTimestamp: record.detectedAt || null,
      detectedAt: record.detectedAt ? new Date(record.detectedAt).toLocaleString() : '-',
      changeValue: EVENT_LABELS[record.eventType] || record.eventType || '-',
      path: fullState.path || '-',
      comment: record.comment || '',
      _rawData: record
    }));
}

export function buildCompleteFileState(historyRecords, selectedRecord) {
  const allAttributes = new Set();
  const states = [];
  const currentState = {
    path: selectedRecord ? (selectedRecord.path || selectedRecord.filename) : '-'
  };

  for (let index = historyRecords.length - 1; index >= 0; index--) {
    const record = historyRecords[index];

    try {
      const parsed = typeof record.changeValue === 'string'
        ? JSON.parse(record.changeValue)
        : record.changeValue;

      if (parsed && typeof parsed === 'object') {
        Object.keys(parsed).forEach(key => allAttributes.add(key));
        Object.assign(currentState, parsed);
      }
    } catch {
      // Ignore malformed history entries.
    }

    states.push({ ...currentState, detectedAt: record.detectedAt });
  }

  states.reverse();

  return {
    allAttributes: Array.from(allAttributes).sort(),
    states,
    path: selectedRecord ? (selectedRecord.path || selectedRecord.filename) : '-'
  };
}

/**
 * Render the change-summary into any container element.
 * Used by both the legacy modal and the panel-embedded history view.
 */
function _createHistorySummaryInContainer(containerEl, fullState, selectedIndex) {
  if (!containerEl) return;
  try {
    const attributeList = fullState.allAttributes;
    const length = fullState.states.length;
    const selectedState = selectedIndex < length ? fullState.states[selectedIndex] : {};
    const previousState = selectedIndex + 1 < length ? fullState.states[selectedIndex + 1] : {};

    let summaryHtml = '<div style="padding: 15px; background: #f9f9f9; border-radius: 4px; border: 1px solid #ddd;">';
    summaryHtml += '<h3 style="margin-top: 0; margin-bottom: 10px;">Change Summary</h3>';
    summaryHtml += '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">';

    summaryHtml += '<div><h4 style="margin: 5px 0 10px 0; color: #666;">Previous</h4>';
    summaryHtml += '<table style="width: 100%; border-collapse: collapse; font-size: 13px;">';
    for (const attr of attributeList) {
      const displayValue = formatAttributeValue(attr, previousState[attr]);
      const isChanged = selectedState[attr] !== previousState[attr];
      const className = isChanged ? 'file-new' : '';
      summaryHtml += `<tr style="border-bottom: 1px solid #eee;"><td style="padding: 6px; font-weight: bold; width: 40%;">${utils.escapeHtml(attr)}:</td><td style="padding: 6px;" class="${className}">${utils.escapeHtml(displayValue)}</td></tr>`;
    }
    summaryHtml += '</table></div>';

    summaryHtml += '<div><h4 style="margin: 5px 0 10px 0; color: #666;">Changed</h4>';
    summaryHtml += '<table style="width: 100%; border-collapse: collapse; font-size: 13px;">';
    for (const attr of attributeList) {
      const displayValue = formatAttributeValue(attr, selectedState[attr]);
      const isChanged = selectedState[attr] !== previousState[attr];
      const className = isChanged ? 'file-new' : '';
      summaryHtml += `<tr style="border-bottom: 1px solid #eee;"><td style="padding: 6px; font-weight: bold; width: 40%;">${utils.escapeHtml(attr)}:</td><td style="padding: 6px;" class="${className}">${utils.escapeHtml(displayValue)}</td></tr>`;
    }
    summaryHtml += '</table></div>';

    summaryHtml += '</div></div>';
    containerEl.innerHTML = summaryHtml;
  } catch (err) {
    console.error('Error creating history summary:', err);
    containerEl.innerHTML = `<div style="color: red;">Error loading summary: ${utils.escapeHtml(err.message)}</div>`;
  }
}

function createHistorySummaryView(fullState, selectedIndex) {
  _createHistorySummaryInContainer(document.getElementById('history-summary-container'), fullState, selectedIndex);
}

function updateHistoryChangeSummary(fullState, selectedIndex) {
  createHistorySummaryView(fullState, selectedIndex);
}

/**
 * Render history view inside a panel's `.panel-history-view` element.
 * The w2grid is named `history-grid-${panelId}` to avoid clashes between panels.
 */
export async function openHistoryViewInPanel(selectedRecord, panelId, auxPaths = []) {
  try {
    const isMultiSelect = Array.isArray(auxPaths) && auxPaths.length > 0;

    if (isMultiSelect) {
      await _openMultiSelectHistoryView(selectedRecord, panelId, auxPaths);
      return;
    }

    const result = await window.electronAPI.getItemHistory({
      isDirectory: !!selectedRecord.isFolder,
      inode: selectedRecord.inode,
      dirId: selectedRecord.dir_id || null
    });

    const isDir = !!selectedRecord.isFolder;
    const $panel = $(`#panel-${panelId}`);
    const $view = $panel.find('.panel-history-view');
    const $gridContainer = $view.find('.panel-history-grid-container');
    const $summaryContainer = $view.find('.panel-history-summary-container');

    if (!result.success) {
      $gridContainer.html(`<div style="padding: 20px; color: #c00;">Error loading history: ${utils.escapeHtml(result.error || 'Unknown error')}</div>`);
      return;
    }

    const gridName = `history-grid-${panelId}`;
    if (w2ui[gridName]) {
      try { w2ui[gridName].destroy(); } catch (_) {}
    }

    const fullState = buildCompleteFileState(result.data || [], selectedRecord);
    const historyData = formatHistoryData(result.data || [], fullState);

    $gridContainer.empty();
    const gridEl = document.createElement('div');
    gridEl.style.cssText = 'width: 100%; height: 100%;';
    $gridContainer.append(gridEl);

    const summaryEl = $summaryContainer[0];
    w2ui[gridName] = new w2grid({
      name: gridName,
      box: gridEl,
      columns: [
        { field: 'detectedAt', text: 'Detected At', size: '160px', resizable: true, sortable: true },
        { field: 'changeValue', text: 'Change', size: '200px', resizable: true, sortable: true },
        { field: 'path', text: 'Path', size: '100%', resizable: true, sortable: true },
        { field: 'comment', text: 'Comment', size: '200px', resizable: true, sortable: true, editable: { type: 'text' } }
      ],
      records: historyData,
      show: { header: true, toolbar: false, footer: true },
      onClick: function (event) {
        if (event.detail && event.detail.recid) {
          _createHistorySummaryInContainer(summaryEl, fullState, event.detail.recid - 1);
        }
      },
      onChange: async function (event) {
        await event.complete;
        const rec = w2ui[gridName]?.get(event.detail?.recid);
        if (!rec || event.detail?.column === undefined) return;
        const col = w2ui[gridName].columns[event.detail.column];
        if (!col || col.field !== 'comment') return;
        const newComment = event.detail?.value?.new ?? '';
        try {
          if (isDir) {
            await window.electronAPI.updateDirHistoryComment(rec._id, newComment);
          } else {
            await window.electronAPI.updateHistoryComment(rec._id, newComment);
          }
        } catch (err) {
          console.error('Failed to update comment:', err);
        }
      }
    });

    _createHistorySummaryInContainer(summaryEl, fullState, 0);
  } catch (err) {
    console.error('Error opening history view in panel:', err);
  }
}

/**
 * Multi-select history view: fetch history for all items, merge and display in one grid.
 */
async function _openMultiSelectHistoryView(primaryRecord, panelId, auxPaths) {
  const $panel = $(`#panel-${panelId}`);
  const $view = $panel.find('.panel-history-view');
  const $gridContainer = $view.find('.panel-history-grid-container');
  const $summaryContainer = $view.find('.panel-history-summary-container');

  // Build item descriptors for bulk fetch
  const allItemDescriptors = [primaryRecord, ...auxPaths.map(p => {
    // We have only paths — do a quick stats lookup
    return { path: p, _needsStats: true };
  })];

  // For aux paths we need to fetch their isFolder/inode/dir_id
  const resolvedItems = [primaryRecord];
  for (const auxPath of auxPaths) {
    try {
      const s = await window.electronAPI.getItemStats(auxPath);
      if (s && s.success) {
        resolvedItems.push({ path: auxPath, isFolder: !!s.isDirectory, inode: s.inode, dir_id: s.dir_id, filename: s.filename });
      }
    } catch (_) {}
  }

  const historyItems = resolvedItems.map(r => ({
    isDirectory: !!r.isFolder,
    inode: r.inode || null,
    dirId: r.dir_id || null
  }));

  const multiResult = await window.electronAPI.getItemsHistory(historyItems);

  const gridName = `history-grid-${panelId}`;
  if (w2ui[gridName]) {
    try { w2ui[gridName].destroy(); } catch (_) {}
  }

  // Build per-item fullStates and format their rows
  const allItemsData = []; // { itemLabel, fullState, rawData, formattedRows }
  if (multiResult && multiResult.success && multiResult.results) {
    multiResult.results.forEach(res => {
      const item = resolvedItems[res._itemIndex];
      const itemLabel = item ? (item.filename || item.path || `Item ${res._itemIndex}`) : `Item ${res._itemIndex}`;
      if (!res.success || !res.data || !res.data.length) {
        allItemsData[res._itemIndex] = { itemLabel, fullState: {}, rawData: [], formattedRows: [] };
        return;
      }
      const fullState = buildCompleteFileState(res.data, item);
      const formattedRows = formatHistoryData(res.data, fullState);
      allItemsData[res._itemIndex] = { itemLabel, fullState, rawData: res.data, formattedRows };
    });
  }

  // Merge all rows, tagging each with _itemIndex and renumbering recids
  let mergedRows = [];
  allItemsData.forEach((itemData, idx) => {
    if (!itemData) return;
    itemData.formattedRows.forEach((row, rowIdx) => {
      mergedRows.push({ ...row, _itemIndex: idx, _rowIndexWithinItem: rowIdx, _itemLabel: itemData.itemLabel });
    });
  });
  // Sort by timestamp descending
  mergedRows.sort((a, b) => {
    const ta = new Date(a._rawTimestamp || 0).getTime();
    const tb = new Date(b._rawTimestamp || 0).getTime();
    return tb - ta;
  });
  // Re-number recids
  mergedRows = mergedRows.map((row, i) => ({ ...row, recid: i + 1 }));

  $gridContainer.empty();
  const gridEl = document.createElement('div');
  gridEl.style.cssText = 'width: 100%; height: 100%;';
  $gridContainer.append(gridEl);

  const summaryEl = $summaryContainer[0];
  w2ui[gridName] = new w2grid({
    name: gridName,
    box: gridEl,
    columns: [
      { field: '_itemLabel', text: 'Item', size: '120px', resizable: true, sortable: true },
      { field: 'detectedAt', text: 'Detected At', size: '160px', resizable: true, sortable: true },
      { field: 'changeValue', text: 'Change', size: '200px', resizable: true, sortable: true },
      { field: 'path', text: 'Path', size: '100%', resizable: true, sortable: true }
    ],
    records: mergedRows,
    show: { header: true, toolbar: false, footer: true },
    onClick: function (event) {
      if (!event.detail || !event.detail.recid) return;
      const clickedRow = mergedRows.find(r => r.recid === event.detail.recid);
      if (!clickedRow) return;
      const itemData = allItemsData[clickedRow._itemIndex];
      if (!itemData) return;
      // Use the row's position within its item's own history for the comparison card
      _createHistorySummaryInContainer(summaryEl, itemData.fullState, clickedRow._rowIndexWithinItem);
    }
  });

  if (mergedRows.length > 0) {
    const first = mergedRows[0];
    const firstItemData = allItemsData[first._itemIndex];
    if (firstItemData) {
      _createHistorySummaryInContainer(summaryEl, firstItemData.fullState, first._rowIndexWithinItem);
    }
  }
}

/**
 * Tear down the panel-scoped history grid.
 * Show/hide of `.panel-history-view` is handled by panels.js.
 */
export function hideHistoryView(panelId) {
  const gridName = `history-grid-${panelId}`;
  if (w2ui[gridName]) {
    try { w2ui[gridName].destroy(); } catch (_) {}
  }
}

function formatAttributeValue(attr, value) {
  if (value === undefined || value === null) {
    return '-';
  }

  if (attr === 'dateModified' || attr === 'dateCreated') {
    if (typeof value === 'number') {
      return new Date(value).toLocaleString();
    }
    return String(value);
  }

  if (attr === 'size' || attr === 'filesizeBytes') {
    if (typeof value === 'number') {
      return utils.formatBytes(value);
    }
    return String(value);
  }

  return String(value);
}