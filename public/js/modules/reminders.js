/**
 * Reminder modal module.
 * Opens, renders, saves, and closes the REMINDER modal.
 * Supports:
 *   - Editable reminder text, date, and time inputs
 *   - Push buttons: +1 hr, → 15:00, Tomorrow, Next week
 *   - Cohabitation panel (when reminder lives inside a TODO item)
 *   - Comment / reply annotations (via annotationHelpers)
 *   - "Switch to TODO" for cohabitated reminders
 */

import { openTodoModal } from './todos.js';
import {
  navigateToDirectory,
  visiblePanels,
  setActivePanelId,
  setGridFocusedPanelId,
  addPanel,
  initializeGridForPanel
} from './panels.js';
import {
  renderCommentSection,
  startEditAnnotation,
  confirmEditAnnotation,
  cancelEditAnnotation,
  deleteAnnotation,
  addPendingComment,
  addPendingReply
} from './annotationHelpers.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ReminderModalContext
 * @property {string}        notesFilePath
 * @property {string}        sectionKey
 * @property {string}        sectionContent   – raw section text at time of open
 * @property {object}        reminderItem     – the item from the sidebar / aggregator
 * @property {object|null}   record
 * @property {number}        panelId
 */

/** @type {ReminderModalContext|null} */
let reminderModalContext = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Parse "YYYY-MM-DD HH:MM" → { date: "YYYY-MM-DD", time: "HH:MM" } */
function splitDateTime(isoDateTime) {
  if (!isoDateTime) return { date: '', time: '' };
  const parts = isoDateTime.split(' ');
  return { date: parts[0] || '', time: parts[1] || '' };
}

/** Join separate date + time back to "YYYY-MM-DD HH:MM" (or just date if no time) */
function joinDateTime(date, time) {
  if (!date) return null;
  if (!time) return date + ' 23:00';
  return date + ' ' + time;
}

/** Add minutes to a "HH:MM" string; wraps around midnight */
function addMinutesToTime(timeStr, minutes) {
  const [hh, mm] = timeStr.split(':').map(Number);
  const total = hh * 60 + mm + minutes;
  const newHh = Math.floor(((total % 1440) + 1440) % 1440 / 60);
  const newMm = ((total % 60) + 60) % 60;
  return `${String(newHh).padStart(2, '0')}:${String(newMm).padStart(2, '0')}`;
}

/** Add days to a "YYYY-MM-DD" string */
function addDaysToDate(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Modal UI helpers
// ---------------------------------------------------------------------------

function getModal()       { return document.getElementById('reminder-modal'); }
function getTextInput()   { return document.getElementById('reminder-text-input'); }
function getDateInput()   { return document.getElementById('reminder-date-input'); }
function getTimeInput()   { return document.getElementById('reminder-time-input'); }
function getCohPanel()    { return document.getElementById('reminder-cohabitation-panel'); }
function getCohText()     { return document.getElementById('reminder-cohab-todo-text'); }
function getAnnotations() { return document.getElementById('reminder-annotations'); }

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderReminderModal(reminderItem) {
  const textInput = getTextInput();
  const dateInput = getDateInput();
  const timeInput = getTimeInput();
  if (textInput) textInput.value = reminderItem.text || '';

  const { date, time } = splitDateTime(reminderItem.due_datetime || null);
  if (dateInput) dateInput.value = date;
  if (timeInput) timeInput.value = time;

  // Subtitle (file context)
  const subtitle = document.getElementById('reminder-modal-subtitle');
  if (subtitle) {
    const path = reminderItem.notesPath || '';
    const sep  = path.includes('\\') ? '\\' : '/';
    const dir  = path.substring(0, path.lastIndexOf(sep));
    subtitle.textContent = dir.substring(dir.lastIndexOf(sep) + 1) || '';
  }

  // Navigate buttons — one per visible panel plus optional "new panel"
  const navContainer = document.getElementById('reminder-navigate-buttons');
  if (navContainer) {
    const notesPath = reminderItem.notesPath || '';
    const sep       = notesPath.includes('\\') ? '\\' : '/';
    const dirPath   = notesPath.substring(0, notesPath.lastIndexOf(sep));
    const basename  = dirPath.substring(dirPath.lastIndexOf(sep) + 1) || dirPath;

    navContainer.innerHTML = '';

    const label = document.createElement('span');
    label.className = 'reminder-navigate-label';
    label.textContent = 'Navigate';
    navContainer.appendChild(label);

    for (let i = 1; i <= visiblePanels; i++) {
      const btn = document.createElement('button');
      btn.className        = 'btn-reminder-navigate';
      btn.dataset.panelId  = i;
      btn.dataset.dirPath  = dirPath;
      btn.textContent      = `P${i}`;
      btn.title            = dirPath;
      navContainer.appendChild(btn);
    }
    if (visiblePanels < 4) {
      const btn = document.createElement('button');
      btn.className        = 'btn-reminder-navigate';
      btn.dataset.panelId  = 'new';
      btn.dataset.dirPath  = dirPath;
      btn.textContent      = `P${visiblePanels + 1}↑`;
      btn.title            = dirPath;
      navContainer.appendChild(btn);
    }

    const dest = document.createElement('span');
    dest.className = 'reminder-navigate-dest';
    dest.textContent = `to ${basename}`;
    dest.title = dirPath;
    navContainer.appendChild(dest);
  }

  // Cohabitation panel
  const cohPanel = getCohPanel();
  if (cohPanel) {
    if (reminderItem.isCohabitated && reminderItem.linkedTodoText) {
      cohPanel.style.display = '';
      const cohText = getCohText();
      if (cohText) cohText.textContent = reminderItem.linkedTodoText;
    } else {
      cohPanel.style.display = 'none';
    }
  }

  // Annotations (comments/replies) — rendered via shared helper
  const annotationsEl = getAnnotations();
  if (annotationsEl) {
    const { html } = renderCommentSection(reminderItem, 0);
    annotationsEl.innerHTML = html;
    // Expand the top-level comments section immediately (replies stay collapsed)
    const sec = annotationsEl.querySelector('.todo-comments-section');
    if (sec) sec.classList.remove('collapsed');
  }
}

// ---------------------------------------------------------------------------
// Push button handlers
// ---------------------------------------------------------------------------

function handlePushButton(pushType) {
  const dateInput = getDateInput();
  const timeInput = getTimeInput();
  if (!dateInput || !timeInput) return;

  const currentDate = dateInput.value;
  const currentTime = timeInput.value || '09:00';

  switch (pushType) {
    case '+1hr': {
      if (!currentDate) {
        const today = new Date().toISOString().slice(0, 10);
        dateInput.value = today;
      }
      timeInput.value = addMinutesToTime(currentTime, 60);
      break;
    }
    case '15:00': {
      if (!currentDate) {
        dateInput.value = new Date().toISOString().slice(0, 10);
      }
      timeInput.value = '15:00';
      break;
    }
    case 'tomorrow': {
      const baseDate = currentDate || new Date().toISOString().slice(0, 10);
      dateInput.value = addDaysToDate(baseDate, 1);
      break;
    }
    case 'nextweek': {
      const baseDate = currentDate || new Date().toISOString().slice(0, 10);
      dateInput.value = addDaysToDate(baseDate, 7);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

async function saveReminder() {
  if (!reminderModalContext) return;
  const { notesFilePath, sectionKey, reminderItem, panelId } = reminderModalContext;

  const newText     = getTextInput()?.value?.trim() || '';
  const newDate     = getDateInput()?.value || '';
  const newTime     = getTimeInput()?.value || '';
  const newDateTime = joinDateTime(newDate, newTime);

  if (!newText) return; // Don't save an empty reminder

  try {
    // Re-read the current file so we don't overwrite concurrent changes
    const rawContent = await window.electronAPI.readFileContent(notesFilePath);
    if (rawContent == null) throw new Error('notes.txt not found');

    const sections   = await window.electronAPI.invoke('parse-notes-file', rawContent);
    let sectionContent = sections[sectionKey] || '';

    // Rewrite the REMINDER line for this item by line number
    const lines     = sectionContent.split('\n');
    const lineIdx   = reminderItem.lineStart;
    const comments  = reminderItem.comments || [];

    if (lineIdx != null && lineIdx >= 0 && lineIdx < lines.length) {
      const leadingWs = (lines[lineIdx].match(/^(\s*)/) || ['', ''])[1];
      const datePart  = newDateTime ? `(${newDateTime})` : '';
      lines[lineIdx]  = `${leadingWs}REMINDER${datePart}: ${newText}`;
    } else {
      const datePart = newDateTime ? `(${newDateTime})` : '';
      lines.push(`REMINDER${datePart}: ${newText}`);
    }

    // 2. Process edits/deletes on existing comments
    const deletedLines = new Set();
    document.querySelectorAll('#reminder-annotations .todo-comment-row:not(.todo-annotation-new)').forEach(row => {
      const cIdx = parseInt(row.dataset.commentIndex, 10);
      if (isNaN(cIdx)) return;
      const comment = comments[cIdx];
      if (!comment || comment.lineStart < 0) return;
      if (row.dataset.deleted === 'true') {
        deletedLines.add(comment.lineStart);
        for (const r of (comment.replies || [])) deletedLines.add(r.lineStart);
        return;
      }
      if (row.dataset.editedText !== undefined) {
        lines[comment.lineStart] = lines[comment.lineStart].replace(/^(\s*COMMENT:)(.*)/, `$1 ${row.dataset.editedText}`);
      }
    });

    document.querySelectorAll('#reminder-annotations .todo-reply-row:not(.todo-annotation-new)').forEach(row => {
      const cIdx = parseInt(row.dataset.commentIndex, 10);
      const rIdx = parseInt(row.dataset.replyIndex, 10);
      if (isNaN(cIdx) || isNaN(rIdx)) return;
      const comment = comments[cIdx];
      const reply   = comment && comment.replies[rIdx];
      if (!reply) return;
      if (row.dataset.deleted === 'true') {
        deletedLines.add(reply.lineStart);
        return;
      }
      if (row.dataset.editedText !== undefined) {
        lines[reply.lineStart] = lines[reply.lineStart].replace(/^(\s*REPLY:)(.*)/, `$1 ${row.dataset.editedText}`);
      }
    });

    // Remove deleted lines in reverse order
    [...deletedLines].sort((a, b) => b - a).forEach(li => lines.splice(li, 1));
    let content = lines.join('\n');

    // 3. Collect and insert new pending comments/replies
    const newComments = [];
    document.querySelectorAll('#reminder-annotations .todo-comment-row.todo-annotation-new').forEach(row => {
      const span = row.querySelector('.todo-annotation-text');
      const newReplies = [];
      row.querySelectorAll('.todo-reply-row.todo-annotation-new .todo-annotation-text').forEach(s => newReplies.push(s.textContent));
      if (span) newComments.push({ text: span.textContent.trim(), replies: newReplies });
    });

    const newRepliesByComment = {};
    document.querySelectorAll('#reminder-annotations .todo-comment-row:not(.todo-annotation-new) .todo-reply-row.todo-annotation-new').forEach(row => {
      const cIdx = parseInt(row.dataset.commentIndex, 10);
      if (isNaN(cIdx)) return;
      if (!newRepliesByComment[cIdx]) newRepliesByComment[cIdx] = [];
      const span = row.querySelector('.todo-annotation-text');
      if (span) newRepliesByComment[cIdx].push(span.textContent.trim());
    });

    const hasNewComments = newComments.length > 0;
    const hasNewReplies  = Object.keys(newRepliesByComment).length > 0;

    if (hasNewComments || hasNewReplies) {
      let freshReminders = await window.electronAPI.parseReminderSection(content);
      let freshLines     = content.split('\n');

      // Find the matching reminder (now with updated text)
      const freshReminder = (freshReminders || []).find(r => r.text === newText) || (freshReminders || [])[0];

      if (freshReminder) {
        if (hasNewReplies) {
          const replyKeys = Object.keys(newRepliesByComment).map(Number).sort((a, b) => b - a);
          for (const cIdx of replyKeys) {
            const fc = freshReminder.comments && freshReminder.comments[cIdx];
            if (!fc || fc.lineStart < 0) continue;
            let insertAfter = fc.lineStart;
            for (const r of (fc.replies || [])) {
              if (r.lineStart > insertAfter) insertAfter = r.lineStart;
            }
            for (const nr of newRepliesByComment[cIdx]) {
              freshLines.splice(insertAfter + 1, 0, `    REPLY: ${nr}`);
              insertAfter++;
            }
          }
          content = freshLines.join('\n');
          freshReminders = await window.electronAPI.parseReminderSection(content);
          freshLines = content.split('\n');
        }

        if (hasNewComments) {
          let insertAfter = freshReminder.lineStart;
          for (const c of (freshReminder.comments || [])) {
            if (c.lineStart > insertAfter) insertAfter = c.lineStart;
            for (const r of (c.replies || [])) {
              if (r.lineStart > insertAfter) insertAfter = r.lineStart;
            }
          }
          for (const nc of newComments) {
            freshLines.splice(insertAfter + 1, 0, `  COMMENT: ${nc.text}`);
            insertAfter++;
            for (const nr of nc.replies) {
              freshLines.splice(insertAfter + 1, 0, `    REPLY: ${nr}`);
              insertAfter++;
            }
          }
          content = freshLines.join('\n');
        }
      }
    }

    // Normalize the reminder section
    const normalizedContent = await window.electronAPI.normalizeReminderSection(content);

    // Write back
    const newFull = await window.electronAPI.invoke('write-notes-section', {
      existingContent: rawContent,
      sectionKey,
      newContent: normalizedContent
    });
    await window.electronAPI.writeFileContent(notesFilePath, newFull);

    // Refresh aggregators
    await window.electronAPI.refreshTodoAggregate(notesFilePath, reminderItem.dirId);
    await window.electronAPI.refreshReminderAggregate(notesFilePath, reminderItem.dirId);

    closeReminderModal();
  } catch (err) {
    console.error('Reminder save failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------

function closeReminderModal() {
  const modal = getModal();
  if (modal) modal.style.display = 'none';
  reminderModalContext = null;
}

// ---------------------------------------------------------------------------
// Switch to TODO
// ---------------------------------------------------------------------------

async function switchToTodoModal() {
  if (!reminderModalContext) return;
  const { record, panelId } = reminderModalContext;
  closeReminderModal();
  if (record) {
    try {
      await openTodoModal(record, panelId);
    } catch (err) {
      console.error('switchToTodoModal failed:', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Wire modal events (called once)
// ---------------------------------------------------------------------------

let _modalWired = false;

function wireModalEvents() {
  if (_modalWired) return;
  _modalWired = true;

  const modal = getModal();
  if (!modal) return;

  // Navigate buttons (dynamically generated per-open, handled via delegation)
  const navContainer = document.getElementById('reminder-navigate-buttons');
  if (navContainer) {
    navContainer.addEventListener('click', async (e) => {
      const btn = e.target.closest('.btn-reminder-navigate');
      if (!btn) return;
      const dirPath    = btn.dataset.dirPath;
      const panelIdStr = btn.dataset.panelId;
      if (!dirPath) return;
      if (panelIdStr === 'new') {
        const targetId = await addPanel();
        if (!targetId) return;
        // addPanel() shows the welcome view (atlas://landing). Initialize the grid,
        // then hide the welcome view before navigating to the real directory.
        await initializeGridForPanel(targetId);
        $(`#panel-${targetId} .panel-welcome-view`).hide();
        $(`#panel-${targetId} .panel-landing-page`).hide();
        $(`#panel-${targetId} .panel-grid`).show();
        await navigateToDirectory(dirPath, targetId, true);
        setActivePanelId(targetId);
        setGridFocusedPanelId(targetId);
      } else {
        const targetId = parseInt(panelIdStr, 10);
        await navigateToDirectory(dirPath, targetId, true);
        setActivePanelId(targetId);
        setGridFocusedPanelId(targetId);
      }
    });
  }

  // Cancel / backdrop
  document.getElementById('btn-reminder-cancel')?.addEventListener('click', closeReminderModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeReminderModal();
  });

  // Save
  document.getElementById('btn-reminder-save')?.addEventListener('click', () => void saveReminder());

  // Switch to TODO
  document.getElementById('btn-reminder-switch-todo')?.addEventListener('click', () => void switchToTodoModal());

  // Push buttons
  modal.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-reminder-push');
    if (btn) handlePushButton(btn.dataset.push);
  });

  // Annotation events (comment/reply add, edit, delete)
  const annotationsEl = getAnnotations();
  if (annotationsEl) {
    annotationsEl.addEventListener('click', (e) => {
      const addCommentBtn = e.target.closest('.todo-comment-add-btn');
      if (addCommentBtn) {
        addPendingComment(parseInt(addCommentBtn.dataset.itemIndex, 10), annotationsEl);
        return;
      }

      const repliesToggle = e.target.closest('.todo-replies-toggle');
      if (repliesToggle) {
        const repliesSection = repliesToggle.closest('.todo-comment-row')?.querySelector('.todo-replies-section');
        if (repliesSection) repliesSection.classList.toggle('collapsed');
        return;
      }

      const addReplyBtn = e.target.closest('.todo-reply-add-btn');
      if (addReplyBtn) {
        const commentRow = addReplyBtn.closest('.todo-comment-row');
        if (commentRow) addPendingReply(commentRow);
        return;
      }

      const editBtn = e.target.closest('.todo-item-edit-btn');
      if (editBtn) {
        const annotRow = editBtn.closest('.todo-comment-row, .todo-reply-row');
        if (annotRow && !annotRow.dataset.new && !annotRow.classList.contains('todo-item-deleted')) {
          startEditAnnotation(annotRow);
        }
        return;
      }

      const confirmBtn = e.target.closest('.todo-item-confirm-btn');
      if (confirmBtn) {
        const annotRow = confirmBtn.closest('.todo-comment-row, .todo-reply-row');
        if (annotRow) confirmEditAnnotation(annotRow);
        return;
      }

      const cancelEditBtn = e.target.closest('.todo-item-cancel-edit-btn');
      if (cancelEditBtn) {
        const annotRow = cancelEditBtn.closest('.todo-comment-row, .todo-reply-row');
        if (annotRow) cancelEditAnnotation(annotRow);
        return;
      }

      const deleteBtn = e.target.closest('.todo-item-delete-btn');
      if (deleteBtn) {
        const annotRow = deleteBtn.closest('.todo-comment-row, .todo-reply-row');
        if (annotRow && !annotRow.dataset.new) deleteAnnotation(annotRow);
        return;
      }

      const deleteNewBtn = e.target.closest('.todo-item-delete-new-btn');
      if (deleteNewBtn) {
        const row = deleteNewBtn.closest('.todo-comment-row, .todo-reply-row');
        if (row) row.remove();
        return;
      }
    });

    annotationsEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('.todo-comment-add-input')) {
        e.preventDefault();
        addPendingComment(parseInt(e.target.dataset.itemIndex, 10), annotationsEl);
      }
      if (e.key === 'Enter' && e.target.matches('.todo-reply-add-input')) {
        e.preventDefault();
        const commentRow = e.target.closest('.todo-comment-row');
        if (commentRow) addPendingReply(commentRow);
      }
      if (e.key === 'Enter' && e.target.matches('.todo-item-edit-input')) {
        e.preventDefault();
        const annotRow = e.target.closest('.todo-comment-row, .todo-reply-row');
        if (annotRow) confirmEditAnnotation(annotRow);
      }
      if (e.key === 'Escape' && e.target.matches('.todo-item-edit-input')) {
        e.preventDefault();
        const annotRow = e.target.closest('.todo-comment-row, .todo-reply-row');
        if (annotRow) cancelEditAnnotation(annotRow);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open the reminder modal for a given reminder item.
 *
 * @param {object}      reminderItem  – item from aggregator or inline parse
 * @param {object|null} record        – grid record (for Switch to TODO)
 * @param {number}      panelId
 */
export async function openReminderModal(reminderItem, record, panelId) {
  wireModalEvents();

  const notesPath  = reminderItem.notesPath;
  const sectionKey = reminderItem.sectionKey;

  // If we need the linked TODO text for cohabitation, try to fetch it
  if (reminderItem.isCohabitated && reminderItem.linkedTodoLine != null) {
    try {
      const rawContent = await window.electronAPI.readFileContent(notesPath);
      if (rawContent) {
        const sections = await window.electronAPI.invoke('parse-notes-file', rawContent);
        const sec      = sections[sectionKey] || '';
        const todoBlocks = await window.electronAPI.parseTodoBlocksWithReminders(sec);
        // Find the item at linkedTodoLine
        for (const block of (todoBlocks || [])) {
          for (const item of (block.items || [])) {
            if (item.lineStart === reminderItem.linkedTodoLine) {
              reminderItem = { ...reminderItem, linkedTodoText: item.text };
              break;
            }
          }
        }
      }
    } catch (_) { /* non-fatal */ }
  }

  // Fetch comments for this reminder from the notes section
  let reminderWithComments = { ...reminderItem, comments: [] };
  try {
    const rawContent = await window.electronAPI.readFileContent(notesPath);
    if (rawContent) {
      const sections   = await window.electronAPI.invoke('parse-notes-file', rawContent);
      const sec        = sections[sectionKey] || '';
      const remBlocks  = await window.electronAPI.parseReminderSection(sec);
      // Find matching reminder by line number
      const match = (remBlocks || []).find(r => r.lineStart === reminderItem.lineStart);
      if (match) {
        reminderWithComments = { ...reminderItem, comments: match.comments || [], linkedTodoText: reminderItem.linkedTodoText };
      }
    }
  } catch (_) { /* non-fatal */ }

  reminderModalContext = {
    notesFilePath: notesPath,
    sectionKey,
    reminderItem: reminderWithComments,
    record: record || null,
    panelId: panelId || 1
  };

  renderReminderModal(reminderWithComments);

  const modal = getModal();
  if (modal) modal.style.display = 'flex';
}
