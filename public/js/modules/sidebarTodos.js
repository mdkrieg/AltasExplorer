/**
 * Sidebar TODO section renderer.
 *
 * Populates #sidebar-todos-body with aggregated TODO items from all known
 * notes.txt files. Groups are keyed by `TODO: <label>`, nested per source file.
 *
 * Wires:
 *   - refresh button (.btn-todos-refresh)           → full refresh
 *   - show-completed toggle (.btn-todos-show-completed) → filter
 *   - checkbox toggle on an item                    → updates notes.txt
 *   - click on item text                            → navigates panel + opens modal
 *   - onTodoAggregatesChanged event                 → re-render
 */

import { navigateToDirectory } from './panels.js';
import { openTodoModal } from './todos.js';
import { onSidebarSectionExpanded } from './sidebar.js';
import { panelState, activePanelId } from '../renderer.js';

let showCompleted = false;
let lastRenderedBodyId = null;
let isRendering = false;
let collapsedGroups = new Set();
let startupRefreshState = null; // { done, total } while deferred refresh is running, null otherwise

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getBody() {
  return document.getElementById('sidebar-todos-body');
}

function renderEmpty(body, message) {
  body.innerHTML = `<div class="sidebar-todos-empty">${escapeHtml(message)}</div>`;
}

function renderLoading(body, done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  body.innerHTML = `<div class="sidebar-todos-loading">
    <div class="sidebar-todos-loading-label">Indexing TODOs… ${done}/${total}</div>
    <div class="sidebar-todos-loading-bar-track">
      <div class="sidebar-todos-loading-bar-fill" style="width:${pct}%"></div>
    </div>
  </div>`;
}

function renderGroups(body, groups) {
  if (!groups || groups.length === 0) {
    renderEmpty(body, showCompleted ? 'No TODOs found.' : 'No open TODOs.');
    return;
  }

  let html = '';
  for (const group of groups) {
    const label = group.groupLabel || '(no label)';
    const groupKey = group.groupLabel || '';
    const collapsed = collapsedGroups.has(groupKey);
    const itemCount = group.sources.reduce((n, s) => n + s.items.length, 0);

    html += `<div class="sidebar-todo-group${collapsed ? ' collapsed' : ''}" data-group-label="${escapeHtml(groupKey)}">`;
    html += `<div class="sidebar-todo-group-header">`;
    html += `<span class="sidebar-todo-group-chevron"></span>`;
    html += `<span class="sidebar-todo-group-title">${escapeHtml(label)}</span>`;
    html += `<span class="sidebar-todo-group-count">${itemCount}</span>`;
    html += `</div>`;

    for (const source of group.sources) {
      html += `<div class="sidebar-todo-source">`;
      html += `<div class="sidebar-todo-source-header" title="${escapeHtml(source.notesPath)}">${escapeHtml(source.sourceDisplayName)}</div>`;
      for (const item of source.items) {
        const levelClass = item.level > 0 ? ` sidebar-todo-item-level-${Math.min(item.level, 3)}` : '';
        const completedClass = item.completed ? ' completed' : '';
        html += `<div class="sidebar-todo-item${levelClass}${completedClass}"
            data-item-id="${item.id}"
            data-notes-path="${escapeHtml(source.notesPath)}"
            data-dir-id="${source.dirId}"
            data-section-key="${escapeHtml(source.sectionKey)}"
            data-group-index="${item.groupIndex}"
            data-item-index="${item.itemIndex}">
          <input type="checkbox" class="sidebar-todo-checkbox"${item.completed ? ' checked' : ''}>
          <span class="sidebar-todo-item-text">${escapeHtml(item.text)}</span>
        </div>`;
      }
      html += `</div>`;
    }

    html += `</div>`;
  }
  body.innerHTML = html;
}

async function refreshRender() {
  const body = getBody();
  if (!body) return;
  if (startupRefreshState) {
    renderLoading(body, startupRefreshState.done, startupRefreshState.total);
    return;
  }
  if (isRendering) return;
  isRendering = true;
  try {
    const groups = await window.electronAPI.getTodoAggregates({ includeCompleted: showCompleted });
    renderGroups(body, groups);
  } catch (err) {
    console.error('Sidebar TODO render failed:', err);
    renderEmpty(body, 'Failed to load TODOs.');
  } finally {
    isRendering = false;
  }
}

async function fullRefresh() {
  try {
    await window.electronAPI.refreshTodoAggregates();
  } catch (err) {
    console.warn('Sidebar TODO refresh IPC failed:', err);
  }
  await refreshRender();
}

function toggleGroupCollapsed(groupKey) {
  if (collapsedGroups.has(groupKey)) collapsedGroups.delete(groupKey);
  else collapsedGroups.add(groupKey);
}

async function handleCheckboxToggle(itemEl, checked) {
  const notesPath = itemEl.dataset.notesPath;
  const sectionKey = itemEl.dataset.sectionKey;
  const groupIndex = parseInt(itemEl.dataset.groupIndex, 10);
  const itemIndex = parseInt(itemEl.dataset.itemIndex, 10);
  const dirId = parseInt(itemEl.dataset.dirId, 10);
  if (!notesPath || Number.isNaN(groupIndex) || Number.isNaN(itemIndex)) return;

  // Optimistic UI
  itemEl.classList.toggle('completed', checked);

  try {
    const rawContent = await window.electronAPI.readFileContent(notesPath);
    if (!rawContent) throw new Error('notes.txt not found');
    const sections = await window.electronAPI.invoke('parse-notes-file', rawContent);
    const sectionContent = sections[sectionKey] || '';
    if (!sectionContent) throw new Error('section not found: ' + sectionKey);

    // Compute flat item index within the section: sum items in prior groups + itemIndex
    const blocks = await window.electronAPI.parseTodoSection(sectionContent);
    if (!blocks || !blocks[groupIndex]) throw new Error('group out of range');
    let flatIndex = 0;
    for (let i = 0; i < groupIndex; i++) flatIndex += blocks[i].items.length;
    flatIndex += itemIndex;

    const updated = await window.electronAPI.updateTodoItems(sectionContent, [{ itemIndex: flatIndex, completed: checked }]);
    const newFull = await window.electronAPI.invoke('write-notes-section', {
      existingContent: rawContent,
      sectionKey,
      newContent: updated
    });
    await window.electronAPI.writeFileContent(notesPath, newFull);
    await window.electronAPI.refreshTodoAggregate(notesPath, dirId);
    // refresh-todo-aggregate broadcasts a changed event which triggers re-render.
  } catch (err) {
    console.error('Sidebar TODO toggle failed:', err);
    // Revert optimistic UI
    itemEl.classList.toggle('completed', !checked);
    const cb = itemEl.querySelector('.sidebar-todo-checkbox');
    if (cb) cb.checked = !checked;
  }
}

async function handleItemTextClick(itemEl) {
  const notesPath = itemEl.dataset.notesPath;
  const sectionKey = itemEl.dataset.sectionKey;
  if (!notesPath || !sectionKey) return;

  const sep = notesPath.includes('\\') ? '\\' : '/';
  const lastSep = notesPath.lastIndexOf(sep);
  const dirPath = lastSep >= 0 ? notesPath.substring(0, lastSep) : notesPath;

  const panelId = activePanelId || 1;

  try {
    await navigateToDirectory(dirPath, panelId, true);
  } catch (err) {
    console.error('Sidebar TODO navigate failed:', err);
    return;
  }

  // After navigation, synthesize or find a record compatible with openTodoModal
  const state = panelState[panelId];
  const grid = state && state.w2uiGrid;
  let record = null;
  if (grid && Array.isArray(grid.records)) {
    if (sectionKey === '__dir__') {
      // The folder itself — synthesize a record pointing at the directory
      record = {
        path: dirPath,
        isFolder: true,
        filenameRaw: dirPath.substring(dirPath.lastIndexOf(sep) + 1) || dirPath,
        filename: dirPath.substring(dirPath.lastIndexOf(sep) + 1) || dirPath
      };
    } else {
      record = grid.records.find(r => r.filenameRaw === sectionKey);
      if (!record) {
        // Fall back: synthesize a record from the section key
        record = {
          path: dirPath + sep + sectionKey,
          isFolder: false,
          filenameRaw: sectionKey,
          filename: sectionKey
        };
      }
    }
  } else {
    record = sectionKey === '__dir__'
      ? { path: dirPath, isFolder: true, filenameRaw: dirPath.substring(dirPath.lastIndexOf(sep) + 1) || dirPath, filename: '' }
      : { path: dirPath + sep + sectionKey, isFolder: false, filenameRaw: sectionKey, filename: sectionKey };
  }

  try {
    await openTodoModal(record, panelId);
  } catch (err) {
    console.error('Sidebar TODO modal open failed:', err);
  }
}

function wireEvents() {
  const body = getBody();
  if (!body || lastRenderedBodyId === body.id + ':wired') return;
  lastRenderedBodyId = body.id + ':wired';

  body.addEventListener('click', (e) => {
    const groupHeader = e.target.closest('.sidebar-todo-group-header');
    if (groupHeader) {
      const group = groupHeader.closest('.sidebar-todo-group');
      if (group) {
        const key = group.dataset.groupLabel || '';
        toggleGroupCollapsed(key);
        group.classList.toggle('collapsed');
      }
      return;
    }

    const itemEl = e.target.closest('.sidebar-todo-item');
    if (!itemEl) return;

    if (e.target.matches('.sidebar-todo-checkbox')) {
      // checkbox handled via 'change' below; don't double-handle
      return;
    }

    // Click on text or row background → open modal
    void handleItemTextClick(itemEl);
  });

  body.addEventListener('change', (e) => {
    const cb = e.target.closest('.sidebar-todo-checkbox');
    if (!cb) return;
    const itemEl = cb.closest('.sidebar-todo-item');
    if (!itemEl) return;
    void handleCheckboxToggle(itemEl, cb.checked);
  });

  // Header action buttons
  const section = document.querySelector('.sidebar-section[data-section="todos"]');
  if (section) {
    const refreshBtn = section.querySelector('.btn-todos-refresh');
    if (refreshBtn && !refreshBtn.dataset.wired) {
      refreshBtn.dataset.wired = 'true';
      refreshBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void fullRefresh();
      });
    }
    const showCompletedBtn = section.querySelector('.btn-todos-show-completed');
    if (showCompletedBtn && !showCompletedBtn.dataset.wired) {
      showCompletedBtn.dataset.wired = 'true';
      showCompletedBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showCompleted = !showCompleted;
        showCompletedBtn.setAttribute('aria-pressed', showCompleted ? 'true' : 'false');
        showCompletedBtn.classList.toggle('active', showCompleted);
        void refreshRender();
      });
    }
  }
}

export function initSidebarTodos() {
  wireEvents();

  // Track the deferred startup refresh and show a progress bar while it runs.
  if (window.electronAPI.onTodoRefreshStart) {
    window.electronAPI.onTodoRefreshStart(({ total }) => {
      startupRefreshState = { done: 0, total };
      const body = getBody();
      if (body) renderLoading(body, 0, total);
    });
    window.electronAPI.onTodoRefreshProgress(({ done, total }) => {
      if (!startupRefreshState) return;
      startupRefreshState = { done, total };
      const body = getBody();
      if (body) renderLoading(body, done, total);
    });
    window.electronAPI.onTodoRefreshDone(() => {
      startupRefreshState = null;
      void refreshRender();
    });
  }

  // Re-render on any aggregate change (other source of truth like a scan).
  if (window.electronAPI.onTodoAggregatesChanged) {
    window.electronAPI.onTodoAggregatesChanged(() => {
      const section = document.querySelector('.sidebar-section[data-section="todos"]');
      if (!section || section.classList.contains('collapsed')) return;
      void refreshRender();
    });
  }

  // Lazy-populate when the section is expanded.
  onSidebarSectionExpanded('todos', async () => {
    wireEvents();
    await refreshRender();
  });
}
