/**
 * Sidebar REMINDERS section renderer.
 *
 * Populates #sidebar-reminders-body with aggregated REMINDER items from all
 * known notes.txt files, bucketed by due date.
 *
 * Wires:
 *   - refresh button (.btn-reminders-refresh)   → full refresh
 *   - dblclick on item                          → opens reminder modal
 *   - onReminderAggregatesChanged event         → re-render
 */

import { navigateToDirectory } from './panels.js';
import { openReminderModal } from './reminders.js';
import { onSidebarSectionExpanded } from './sidebar.js';
import { activePanelId } from '../renderer.js';

let isRendering = false;
let collapsedBuckets = new Set();

const BUCKET_TINT = {
  'Past Due':  'sidebar-reminder-bucket-past-due',
  'Today':     'sidebar-reminder-bucket-today',
  'Tomorrow':  'sidebar-reminder-bucket-tomorrow',
  'This Week': 'sidebar-reminder-bucket-this-week',
  'Next Week': 'sidebar-reminder-bucket-next-week',
  'Later':     'sidebar-reminder-bucket-later',
  'No Date':   'sidebar-reminder-bucket-no-date'
};

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getBody() {
  return document.getElementById('sidebar-reminders-body');
}

function renderEmpty(body, message) {
  body.innerHTML = `<div class="sidebar-reminders-empty">${escapeHtml(message)}</div>`;
}

/**
 * @param {HTMLElement} body
 * @param {Array<{bucketLabel: string, count: number, items: object[]}>} buckets
 */
function renderGroups(body, buckets) {
  if (!buckets || buckets.length === 0) {
    renderEmpty(body, 'No reminders found.');
    return;
  }

  let html = '';
  for (const bucket of buckets) {
    const label      = bucket.bucketLabel;
    const tintClass  = BUCKET_TINT[label] || '';
    const collapsed  = collapsedBuckets.has(label);

    html += `<div class="sidebar-reminder-group${collapsed ? ' collapsed' : ''} ${tintClass}" data-bucket="${escapeHtml(label)}">`;
    html += `<div class="sidebar-reminder-group-header">`;
    html += `<span class="sidebar-reminder-group-chevron"></span>`;
    html += `<span class="sidebar-reminder-group-title">${escapeHtml(label)}</span>`;
    html += `<span class="sidebar-reminder-group-count">${bucket.count}</span>`;
    html += `</div>`;
    html += `<div class="sidebar-reminder-group-body">`;

    for (const item of bucket.items) {
      const dateLabel = item.due_datetime
        ? `<span class="sidebar-reminder-item-date">${escapeHtml(item.due_datetime)}</span>`
        : '';
      const cohabBadge = item.isCohabitated
        ? `<span class="sidebar-reminder-item-cohab" title="Embedded in a TODO item">⧓</span>`
        : '';
      html += `<div class="sidebar-reminder-item"
          data-reminder-id="${item.id}"
          data-notes-path="${escapeHtml(item.notesPath)}"
          data-dir-id="${item.dirId}"
          data-section-key="${escapeHtml(item.sectionKey)}"
          data-due="${escapeHtml(item.due_datetime || '')}"
          data-line-start="${item.lineStart}"
          data-is-cohabitated="${item.isCohabitated ? '1' : '0'}"
          data-linked-todo-line="${item.linkedTodoLine ?? ''}"
          title="${escapeHtml(item.notesPath)}"
          >
          ${dateLabel}
          ${cohabBadge}
          <span class="sidebar-reminder-item-text">${escapeHtml(item.text)}</span>
        </div>`;
    }

    html += `</div>`;
    html += `</div>`;
  }
  body.innerHTML = html;
}

async function refreshRender() {
  const body = getBody();
  if (!body) return;
  if (isRendering) return;
  isRendering = true;
  try {
    const buckets = await window.electronAPI.getReminderAggregates();
    renderGroups(body, buckets);
  } catch (err) {
    console.error('Sidebar Reminders render failed:', err);
    renderEmpty(body, 'Failed to load reminders.');
  } finally {
    isRendering = false;
  }
}

async function fullRefresh() {
  try {
    await window.electronAPI.refreshReminderAggregates();
  } catch (err) {
    console.warn('Sidebar Reminders full refresh IPC failed:', err);
  }
  await refreshRender();
}

function toggleBucketCollapsed(label) {
  if (collapsedBuckets.has(label)) collapsedBuckets.delete(label);
  else collapsedBuckets.add(label);
}

async function handleItemDblClick(itemEl) {
  const notesPath  = itemEl.dataset.notesPath;
  const sectionKey = itemEl.dataset.sectionKey;
  if (!notesPath || !sectionKey) return;

  const sep        = notesPath.includes('\\') ? '\\' : '/';
  const lastSep    = notesPath.lastIndexOf(sep);
  const dirPath    = lastSep >= 0 ? notesPath.substring(0, lastSep) : notesPath;
  const panelId    = activePanelId || 1;

  // Build a minimal reminder item object for the modal
  const reminderItem = {
    id:              parseInt(itemEl.dataset.reminderId, 10) || null,
    text:            itemEl.querySelector('.sidebar-reminder-item-text')?.textContent || '',
    due_datetime:    itemEl.dataset.due || null,
    notesPath,
    sectionKey,
    lineStart:       parseInt(itemEl.dataset.lineStart, 10) || null,
    isCohabitated:   itemEl.dataset.isCohabitated === '1',
    linkedTodoLine:  itemEl.dataset.linkedTodoLine ? parseInt(itemEl.dataset.linkedTodoLine, 10) : null,
    dirId:           parseInt(itemEl.dataset.dirId, 10) || null
  };

  try {
    await navigateToDirectory(dirPath, panelId, true);
  } catch (err) {
    console.error('Sidebar Reminders navigate failed:', err);
  }

  try {
    await openReminderModal(reminderItem, null, panelId);
  } catch (err) {
    console.error('Sidebar Reminders modal open failed:', err);
  }
}

let _eventsWired = false;

function wireEvents() {
  if (_eventsWired) return;
  _eventsWired = true;

  const body = getBody();
  if (!body) return;

  body.addEventListener('click', (e) => {
    const groupHeader = e.target.closest('.sidebar-reminder-group-header');
    if (groupHeader) {
      const group = groupHeader.closest('.sidebar-reminder-group');
      if (group) {
        const key = group.dataset.bucket || '';
        toggleBucketCollapsed(key);
        group.classList.toggle('collapsed');
      }
    }
  });

  body.addEventListener('dblclick', (e) => {
    const itemEl = e.target.closest('.sidebar-reminder-item');
    if (itemEl) {
      void handleItemDblClick(itemEl);
    }
  });

  // Header refresh button
  const section = document.querySelector('.sidebar-section[data-section="reminders"]');
  if (section) {
    const refreshBtn = section.querySelector('.btn-reminders-refresh');
    if (refreshBtn && !refreshBtn.dataset.wired) {
      refreshBtn.dataset.wired = 'true';
      refreshBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void fullRefresh();
      });
    }
  }
}

export function initSidebarReminders() {
  wireEvents();

  // Re-render on aggregate change (e.g. after a notes save or scan).
  if (window.electronAPI.onReminderAggregatesChanged) {
    window.electronAPI.onReminderAggregatesChanged(() => {
      const section = document.querySelector('.sidebar-section[data-section="reminders"]');
      if (!section || section.classList.contains('collapsed')) return;
      void refreshRender();
    });
  }

  // Lazy-populate when the section is expanded.
  onSidebarSectionExpanded('reminders', async () => {
    wireEvents();
    await refreshRender();
  });
}
