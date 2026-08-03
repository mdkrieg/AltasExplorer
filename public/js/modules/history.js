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

/**
 * gridName → the closure that renders the Change Summary for a given record.
 * Keyboard navigation lives outside the render function but needs the subject list
 * that only the closure captures; keying by grid name keeps panels independent.
 * @type {Map<string, (row: object) => void>}
 */
const _summaryRenderers = new Map();

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
 * Timestamp of a state, formatted exactly like the grid's "Detected At" column so
 * the two can be matched by eye. Each `states` entry carries the `detectedAt` of
 * the history row that produced it — see buildCompleteFileState.
 */
function formatStateTimestamp(state) {
  return state && state.detectedAt ? new Date(state.detectedAt).toLocaleString() : null;
}

/**
 * One side of the Previous/Changed comparison. Both sides highlight the same
 * attributes (each compares against the other), so a changed row lines up
 * horizontally with its counterpart.
 */
function buildSummaryColumn(heading, timestamp, state, compareTo, attributeList) {
  const stamp = timestamp
    ? `<span style="font-weight: normal; color: #888; margin-left: 8px;">${utils.escapeHtml(timestamp)}</span>`
    : '<span style="font-weight: normal; color: #bbb; font-style: italic; margin-left: 8px;">no earlier record</span>';

  let html = `<div><h4 style="margin: 5px 0 10px 0; color: #666;">${heading}${stamp}</h4>`;
  html += '<table style="width: 100%; border-collapse: collapse; font-size: 13px;">';
  for (const attr of attributeList) {
    const displayValue = formatAttributeValue(attr, state[attr]);
    const className = state[attr] !== compareTo[attr] ? 'file-new' : '';
    html += `<tr style="border-bottom: 1px solid #eee;"><td style="padding: 6px; font-weight: bold; width: 40%;">${utils.escapeHtml(attr)}:</td><td style="padding: 6px;" class="${className}">${utils.escapeHtml(displayValue)}</td></tr>`;
  }
  return html + '</table></div>';
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
    summaryHtml += buildSummaryColumn('Previous', formatStateTimestamp(previousState), previousState, selectedState, attributeList);
    summaryHtml += buildSummaryColumn('Changed', formatStateTimestamp(selectedState), selectedState, previousState, attributeList);
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
 * A "subject" is one item whose change history is on screen. Every flavour of the
 * panel history view — a single item, a multi-select, a directory plus its
 * contents — is just a different set of subjects rendered into one grid, so they
 * all funnel through `_renderPanelHistoryGrid` below.
 *
 * Each subject owns its own `fullState`, because the Change Summary card compares
 * a row against the *previous state of that same item* — comparing across items
 * would be meaningless.
 *
 * @param {{ label: string, path: string, isDirectory: boolean, records: array }} spec
 */
function _makeSubject({ label, path, isDirectory, records }) {
  const rows = records || [];
  const fullState = buildCompleteFileState(rows, { path, filename: label });
  return { label, path, isDirectory: !!isDirectory, fullState, rows: formatHistoryData(rows, fullState) };
}

function _leafName(p) {
  const s = String(p || '');
  const idx = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return idx >= 0 ? s.slice(idx + 1) : s;
}

function _joinPath(dirPath, name) {
  const sep = String(dirPath).includes('/') && !String(dirPath).includes('\\') ? '/' : '\\';
  return String(dirPath).replace(/[\\/]+$/, '') + sep + name;
}

/**
 * Render a set of subjects into the panel's history grid.
 *
 * The Item column appears only when more than one subject is on screen — with a
 * single subject every cell would carry the same value, and the column would cost
 * width for nothing.
 *
 * @param {number} panelId
 * @param {Array} subjects
 * @param {HTMLElement} gridHostEl
 * @param {HTMLElement} summaryEl
 */
function _renderPanelHistoryGrid(panelId, subjects, gridHostEl, summaryEl) {
  const gridName = `history-grid-${panelId}`;
  if (w2ui[gridName]) {
    try { w2ui[gridName].destroy(); } catch (_) {}
  }

  const showItemColumn = subjects.length > 1;

  let mergedRows = [];
  subjects.forEach((subject, subjectIndex) => {
    subject.rows.forEach((row, rowIndex) => {
      mergedRows.push({
        ...row,
        _subjectIndex: subjectIndex,
        _rowIndexWithinSubject: rowIndex,
        _itemLabel: subject.label,
        _isDir: subject.isDirectory
      });
    });
  });

  if (showItemColumn) {
    mergedRows.sort((a, b) => {
      const ta = new Date(a._rawTimestamp || 0).getTime();
      const tb = new Date(b._rawTimestamp || 0).getTime();
      return tb - ta;
    });
  }
  mergedRows = mergedRows.map((row, i) => ({ ...row, recid: i + 1 }));

  const columns = [
    { field: 'detectedAt', text: 'Detected At', size: '160px', resizable: true, sortable: true },
    { field: 'changeValue', text: 'Change', size: '200px', resizable: true, sortable: true },
    { field: 'path', text: 'Path', size: '100%', resizable: true, sortable: true },
    { field: 'comment', text: 'Comment', size: '200px', resizable: true, sortable: true, editable: { type: 'text' } }
  ];
  if (showItemColumn) {
    columns.unshift({ field: '_itemLabel', text: 'Item', size: '160px', resizable: true, sortable: true });
  }

  const showSummaryFor = (row) => {
    const subject = subjects[row?._subjectIndex];
    if (!subject) return;
    _createHistorySummaryInContainer(summaryEl, subject.fullState, row._rowIndexWithinSubject);
  };
  // Held so arrow-key navigation can re-render the summary without re-deriving the
  // subject list, which only this closure has.
  _summaryRenderers.set(gridName, showSummaryFor);

  w2ui[gridName] = new w2grid({
    name: gridName,
    box: gridHostEl,
    columns,
    records: mergedRows,
    show: { header: true, toolbar: false, footer: true },
    onClick: function (event) {
      if (!event.detail || !event.detail.recid) return;
      showSummaryFor(w2ui[gridName]?.get(event.detail.recid));
    },
    onChange: async function (event) {
      await event.complete;
      const rec = w2ui[gridName]?.get(event.detail?.recid);
      if (!rec || event.detail?.column === undefined) return;
      const col = w2ui[gridName].columns[event.detail.column];
      if (!col || col.field !== 'comment') return;
      const newComment = event.detail?.value?.new ?? '';
      try {
        // Comments live in file_history or dir_history depending on the row's own
        // subject, not on what the panel was opened with — a directory's contents
        // list mixes both.
        if (rec._isDir) {
          await window.electronAPI.updateDirHistoryComment(rec._id, newComment);
        } else {
          await window.electronAPI.updateHistoryComment(rec._id, newComment);
        }
      } catch (err) {
        console.error('Failed to update comment:', err);
      }
    }
  });

  // Select the newest row rather than only summarising it. The summary always
  // describes *some* row, so that row must be visibly selected — otherwise the
  // card refers to a line the user cannot pick out, and Up/Down would have no
  // anchor to move from.
  if (mergedRows.length > 0) {
    w2ui[gridName].select(mergedRows[0].recid);
    showSummaryFor(mergedRows[0]);
  } else if (summaryEl) {
    summaryEl.innerHTML = '';
  }
}

/**
 * Move the history grid's selection one row up or down and re-render the summary.
 * Called by the renderer's global arrow-key handler; the file grid's equivalent is
 * `panels.gridNavigate`.
 *
 * Indexes into `grid.records`, which w2ui reorders in place when a column is
 * sorted — so "next row" means next *as displayed*.
 *
 * @param {'up'|'down'} direction
 * @param {number} panelId
 * @returns {boolean} true when the key was consumed
 */
export function historyNavigate(direction, panelId) {
  const gridName = `history-grid-${panelId}`;
  const grid = w2ui[gridName];
  if (!grid || !grid.records || grid.records.length === 0) return false;

  const selected = grid.getSelection();
  const currentIndex = selected.length > 0 ? grid.get(selected[0], true) : -1;

  let nextIndex;
  if (currentIndex === -1) {
    // Nothing selected yet: Down enters at the top, Up enters at the bottom.
    nextIndex = direction === 'down' ? 0 : grid.records.length - 1;
  } else {
    nextIndex = direction === 'down' ? currentIndex + 1 : currentIndex - 1;
    // Clamp rather than wrap — running off the end should feel like hitting a
    // wall, not silently jumping to the other end of the timeline.
    if (nextIndex < 0 || nextIndex >= grid.records.length) return true;
  }

  const nextRecord = grid.records[nextIndex];
  if (!nextRecord) return false;

  grid.selectNone(true);
  grid.select(nextRecord.recid);
  grid.scrollIntoView(nextIndex);
  _summaryRenderers.get(gridName)?.(nextRecord);
  return true;
}

/**
 * Render history view inside a panel's `.panel-history-view` element.
 * The w2grid is named `history-grid-${panelId}` to avoid clashes between panels.
 *
 * @param {object} selectedRecord
 * @param {number} panelId
 * @param {string[]} [auxPaths] Additional selected items (multi-select history)
 * @param {{ includeContents?: boolean }} [options] `includeContents` folds the
 *        history of a directory's files and immediate subdirectories into the
 *        same list. Ignored for non-directories.
 */
export async function openHistoryViewInPanel(selectedRecord, panelId, auxPaths = [], options = {}) {
  const $panel = $(`#panel-${panelId}`);
  const $view = $panel.find('.panel-history-view');
  const $gridContainer = $view.find('.panel-history-grid-container');
  const summaryEl = $view.find('.panel-history-summary-container')[0];

  const showError = (message) => {
    $gridContainer.html(`<div style="padding: 20px; color: #c00;">${utils.escapeHtml(message)}</div>`);
    if (summaryEl) summaryEl.innerHTML = '';
  };

  try {
    const isMultiSelect = Array.isArray(auxPaths) && auxPaths.length > 0;
    const isDir = !!selectedRecord.isFolder;
    const wantContents = !!options.includeContents && isDir && !isMultiSelect;

    let subjects;
    if (isMultiSelect) {
      subjects = await _buildMultiSelectSubjects(selectedRecord, auxPaths);
    } else {
      const result = await window.electronAPI.getItemHistory({
        isDirectory: isDir,
        inode: selectedRecord.inode,
        dirId: selectedRecord.dir_id || null
      });
      if (!result.success) {
        showError(`Error loading history: ${result.error || 'Unknown error'}`);
        return;
      }
      subjects = [_makeSubject({
        label: selectedRecord.filename || _leafName(selectedRecord.path),
        path: selectedRecord.path || selectedRecord.filename,
        isDirectory: isDir,
        records: result.data || []
      })];

      if (wantContents) {
        subjects = subjects.concat(await _buildContentsSubjects(selectedRecord));
      }
    }

    // Rebuilt from scratch each time: the grid host is destroyed along with the
    // w2grid, and `showError` above may have replaced the container's contents.
    $gridContainer.empty();
    const gridEl = document.createElement('div');
    gridEl.style.cssText = 'width: 100%; height: 100%;';
    $gridContainer.append(gridEl);

    _renderPanelHistoryGrid(panelId, subjects, gridEl, summaryEl);
  } catch (err) {
    console.error('Error opening history view in panel:', err);
    showError(`Error loading history: ${err.message}`);
  }
}

/**
 * Subjects for a multi-select history view: the primary record plus every aux path.
 * Aux paths arrive as paths only, so each needs a stats lookup for inode/dir_id.
 */
async function _buildMultiSelectSubjects(primaryRecord, auxPaths) {
  const resolvedItems = [primaryRecord];
  for (const auxPath of auxPaths) {
    try {
      const s = await window.electronAPI.getItemStats(auxPath);
      if (s && s.success) {
        resolvedItems.push({ path: auxPath, isFolder: !!s.isDirectory, inode: s.inode, dir_id: s.dir_id, filename: s.filename });
      }
    } catch (_) {}
  }

  const multiResult = await window.electronAPI.getItemsHistory(resolvedItems.map(r => ({
    isDirectory: !!r.isFolder,
    inode: r.inode || null,
    dirId: r.dir_id || null
  })));

  const recordsByIndex = new Map();
  if (multiResult && multiResult.success && multiResult.results) {
    multiResult.results.forEach(res => {
      if (res.success && Array.isArray(res.data)) recordsByIndex.set(res._itemIndex, res.data);
    });
  }

  return resolvedItems.map((item, idx) => _makeSubject({
    label: item.filename || _leafName(item.path) || `Item ${idx + 1}`,
    path: item.path || item.filename,
    isDirectory: !!item.isFolder,
    records: recordsByIndex.get(idx) || []
  }));
}

/**
 * Subjects for the "Contents" toggle: one per file/subdirectory whose history is
 * recorded under this directory. The backend returns a single flat, newest-first
 * list tagged with `itemKey`/`itemKind`/`itemName`; grouping preserves that order,
 * so each subject's records stay newest-first as `buildCompleteFileState` expects.
 */
async function _buildContentsSubjects(dirRecord) {
  if (!dirRecord.dir_id) return [];

  const result = await window.electronAPI.getDirectoryContentsHistory(dirRecord.dir_id);
  if (!result || !result.success || !Array.isArray(result.data)) return [];

  const dirPath = dirRecord.path || dirRecord.filename || '';
  const byItem = new Map();
  for (const row of result.data) {
    const key = row.itemKey || `${row.itemKind}:${row.itemName}`;
    if (!byItem.has(key)) {
      byItem.set(key, {
        label: row.itemName,
        path: row.itemPath || _joinPath(dirPath, row.itemName),
        isDirectory: row.itemKind === 'dir',
        records: []
      });
    }
    byItem.get(key).records.push(row);
  }

  return [...byItem.values()].map(_makeSubject);
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
  _summaryRenderers.delete(gridName);
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