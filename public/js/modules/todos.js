/**
 * TODO modal module.
 * Handles opening, rendering, saving and cancelling the TODO checklist modal.
 * Supports multiple TODO: groups per notes section, per-group add inputs,
 * collapsible groups, collapse-all / expand-all controls, COMMENT: / REPLY:
 * annotations per item (collapsible), and inline add/edit/delete for all.
 */

import { panelState } from '../renderer.js';
import {
  renderCommentSection,
  startEditAnnotation,
  confirmEditAnnotation,
  cancelEditAnnotation,
  deleteAnnotation,
  addPendingComment,
  addPendingReply
} from './annotationHelpers.js';
import { openReminderModal } from './reminders.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// { notesFilePath, sectionKey, sectionContent, parsedBlocks, panelId, record }
let todoModalContext = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getNotesFileInfo(record) {
  const sep = record.path.includes('\\') ? '\\' : '/';
  if (record.isFolder) {
    return {
      notesFilePath: record.path + sep + 'notes.txt',
      sectionKey: '__dir__'
    };
  }
  const lastSep = record.path.lastIndexOf(sep);
  const dir = record.path.substring(0, lastSep);
  return {
    notesFilePath: dir + sep + 'notes.txt',
    sectionKey: record.filenameRaw
  };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function todayIso() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Pending item management -- adds a row to the DOM without writing to disk
// ---------------------------------------------------------------------------

function addPendingItem(groupIndex) {
  const groupEl = document.querySelector(`.todo-group[data-group-index="${groupIndex}"]`);
  if (!groupEl) return;

  const addInput = groupEl.querySelector('.todo-add-input');
  const text = addInput ? addInput.value.trim() : '';
  if (!text) return;

  const addRow = groupEl.querySelector('.todo-add-row');
  const body = groupEl.querySelector('.todo-group-body');
  if (!body || !addRow) return;

  const row = document.createElement('div');
  row.className = 'todo-item-row todo-item-new';
  row.dataset.new = 'true';
  row.dataset.groupIndex = String(groupIndex);
  const newItemId = `new-${groupIndex}-${Date.now()}`;
  row.dataset.itemIndex = newItemId;
  row.innerHTML = `<input type="checkbox" class="todo-item-checkbox" style="flex-shrink:0; margin-top:3px; cursor:pointer;">
    <span class="todo-item-text">${escapeHtml(text)}</span>
    <div class="todo-item-actions">
      <button class="todo-comments-toggle" data-item-index="${newItemId}" title="Toggle comments">&#128172;</button>
      <button class="todo-item-action-btn todo-item-edit-btn" title="Edit">&#9998;</button>
      <button class="todo-item-action-btn todo-item-delete-new-btn" title="Remove">&#10005;</button>
    </div>
    <span class="todo-comment-badge"></span>`;
  body.insertBefore(row, addRow);

  // Insert empty comment section so the toggle works
  const commentSection = document.createElement('div');
  commentSection.className = 'todo-comments-section collapsed';
  commentSection.dataset.itemIndex = newItemId;
  commentSection.innerHTML = `<div class="todo-comment-add-row">
      <input type="text" class="todo-annotation-add-input todo-comment-add-input" placeholder="Add comment..." data-item-index="${newItemId}">
      <button class="todo-comment-add-btn" data-item-index="${newItemId}" title="Add comment">+</button>
    </div>`;
  body.insertBefore(commentSection, addRow);

  if (addInput) {
    addInput.value = '';
    addInput.focus();
  }
}

// ---------------------------------------------------------------------------
// Item edit / delete (existing items)
// ---------------------------------------------------------------------------

function startEditItem(row) {
  if (row.classList.contains('editing')) return;
  const span = row.querySelector('.todo-item-text');
  const actions = row.querySelector('.todo-item-actions');
  if (!span || !actions) return;

  row.classList.add('editing');
  const current = row.dataset.editedText !== undefined ? row.dataset.editedText : span.textContent;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'todo-item-edit-input';
  input.value = current;
  span.replaceWith(input);
  input.focus();
  input.select();

  actions.innerHTML = `<button class="todo-item-action-btn todo-item-confirm-btn" title="Confirm">&#10003;</button>
    <button class="todo-item-action-btn todo-item-cancel-edit-btn" title="Cancel">&#10005;</button>`;
}

function confirmEditItem(row) {
  const input = row.querySelector('.todo-item-edit-input');
  const actions = row.querySelector('.todo-item-actions');
  if (!input || !actions) return;

  const newText = input.value.trim() || input.value;
  row.dataset.editedText = newText;

  const span = document.createElement('span');
  span.className = 'todo-item-text';
  span.textContent = newText;
  const cb = row.querySelector('.todo-item-checkbox');
  if (cb && cb.checked) { span.style.textDecoration = 'line-through'; span.style.color = '#888'; }
  input.replaceWith(span);
  row.classList.remove('editing');

  const deleteClass = row.dataset.new ? 'todo-item-delete-new-btn' : 'todo-item-delete-btn';
  actions.innerHTML = `<button class="todo-item-action-btn todo-item-edit-btn" title="Edit">&#9998;</button>
    <button class="todo-item-action-btn ${deleteClass}" title="Remove">&#10005;</button>`;
}

function cancelEditItem(row) {
  const input = row.querySelector('.todo-item-edit-input');
  const actions = row.querySelector('.todo-item-actions');
  if (!input || !actions) return;

  const idx = parseInt(row.dataset.index, 10);
  const allItems = todoModalContext ? todoModalContext.parsedBlocks.flatMap(b => b.items) : [];
  const restoreText = row.dataset.editedText !== undefined
    ? row.dataset.editedText
    : (allItems[idx] ? allItems[idx].text : input.value);

  const span = document.createElement('span');
  span.className = 'todo-item-text';
  span.textContent = restoreText;
  const cb = row.querySelector('.todo-item-checkbox');
  if (cb && cb.checked) { span.style.textDecoration = 'line-through'; span.style.color = '#888'; }
  input.replaceWith(span);
  row.classList.remove('editing');

  const deleteClass = row.dataset.new ? 'todo-item-delete-new-btn' : 'todo-item-delete-btn';
  actions.innerHTML = `<button class="todo-item-action-btn todo-item-edit-btn" title="Edit">&#9998;</button>
    <button class="todo-item-action-btn ${deleteClass}" title="Remove">&#10005;</button>`;
}

function deleteItem(row) {
  const isDeleted = row.classList.contains('todo-item-deleted');
  const actions = row.querySelector('.todo-item-actions');
  if (isDeleted) {
    row.classList.remove('todo-item-deleted');
    delete row.dataset.deleted;
    if (actions) actions.innerHTML = `<button class="todo-item-action-btn todo-item-edit-btn" title="Edit">&#9998;</button>
      <button class="todo-item-action-btn todo-item-delete-btn" title="Remove">&#10005;</button>`;
  } else {
    if (row.classList.contains('editing')) cancelEditItem(row);
    row.classList.add('todo-item-deleted');
    row.dataset.deleted = 'true';
    if (actions) actions.innerHTML = `<button class="todo-item-action-btn todo-item-delete-btn" title="Undo remove" style="color:#1976d2;">&#8617;</button>`;
  }
}

// ---------------------------------------------------------------------------
// Comment edit / delete helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTodoGroups(parsedBlocks) {
  const container = document.getElementById('todo-modal-items');
  if (!container) return;

  const multiGroup = parsedBlocks.length > 1;
  let flatIndex = 0;
  let html = '';

  for (let gi = 0; gi < parsedBlocks.length; gi++) {
    const group = parsedBlocks[gi];
    const labelText = group.label || 'TODO';

    html += `<div class="todo-group" data-group-index="${gi}">`;
    html += `<div class="todo-group-header">
        <button class="todo-group-toggle" aria-label="Toggle group">&#9660;</button>
        <span class="todo-group-label-text">${escapeHtml(labelText)}</span>
      </div>`;
    html += `<div class="todo-group-body">`;

    for (const item of group.items) {
      const idx = flatIndex++;
      const indentClass = item.level > 0 ? ` todo-item-level-${Math.min(item.level, 4)}` : '';
      const checked = item.completed ? 'checked' : '';
      const crossStyle = item.completed ? 'text-decoration:line-through; color:#888;' : '';
      const { html: commentsHtml, badge } = renderCommentSection(item, idx);

      html += `<div class="todo-item-row${indentClass}" data-index="${idx}">
          <input type="checkbox" class="todo-item-checkbox" data-index="${idx}" ${checked} style="flex-shrink:0; margin-top:3px; cursor:pointer;">
          <span class="todo-item-text" style="${crossStyle}">${escapeHtml(item.text)}</span>
          <div class="todo-item-actions">
            <button class="todo-comments-toggle" data-item-index="${idx}" title="Toggle comments">&#128172;<span class="todo-comment-badge">${badge}</span> </button>
            <button class="todo-item-action-btn todo-item-edit-btn" title="Edit">&#9998;</button>
            <button class="todo-item-action-btn todo-item-delete-btn" title="Remove">&#10005;</button>
          </div>
          <span class="todo-comment-badge">${badge}</span>
        </div>`;

      // Cohabitation banner: show linked REMINDER below the item
      if (item.cohabitatingReminder) {
        const rem = item.cohabitatingReminder;
        const dateLabel = rem.parsedDate ? ` <span class="todo-cohab-reminder-date">${escapeHtml(rem.parsedDate)}</span>` : '';
        html += `<div class="todo-cohab-reminder-banner" data-item-index="${idx}"
            data-reminder-line="${rem.lineStart ?? ''}"
            data-reminder-date="${escapeHtml(rem.parsedDate || '')}"
            data-reminder-text="${escapeHtml(rem.text)}">
            <span class="todo-cohab-reminder-icon" title="Linked reminder">&#9201;</span>
            ${dateLabel}
            <span class="todo-cohab-reminder-text">${escapeHtml(rem.text)}</span>
            <button class="btn-todo-switch-reminder" data-item-index="${idx}" title="Switch to Reminder modal">&#8594; Reminder</button>
          </div>`;
      }

      html += commentsHtml;
    }

    // Per-group add row
    html += `<div class="todo-add-row">
        <input type="text" class="todo-add-input" data-group-index="${gi}" placeholder="Add item..." value="">
        <button class="todo-add-btn" data-group-index="${gi}" title="Add item">+</button>
      </div>`;

    html += `</div>`; // .todo-group-body
    html += `</div>`; // .todo-group
  }

  container.innerHTML = html;

  const collapseControls = document.getElementById('todo-collapse-controls');
  if (collapseControls) {
    collapseControls.style.display = multiGroup ? 'flex' : 'none';
  }

  // Live strike-through on checkbox toggle
  container.querySelectorAll('.todo-item-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      const span = cb.closest('.todo-item-row').querySelector('.todo-item-text');
      if (span) {
        span.style.textDecoration = cb.checked ? 'line-through' : '';
        span.style.color = cb.checked ? '#888' : '';
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

export async function openTodoModal(record, panelId) {
  const { notesFilePath, sectionKey } = getNotesFileInfo(record);

  let sectionContent = '';
  try {
    const rawContent = await window.electronAPI.readFileContent(notesFilePath);
    if (rawContent) {
      const sections = await window.electronAPI.invoke('parse-notes-file', rawContent);
      sectionContent = sections[sectionKey] || '';
    }
  } catch (err) {
    console.error('TODO: failed to read notes file', err);
  }

  const parsedBlocks = sectionContent
    ? (await window.electronAPI.parseTodoBlocksWithReminders(sectionContent) || [])
    : [];

  todoModalContext = { notesFilePath, sectionKey, sectionContent, parsedBlocks, panelId, record };

  const subtitle = document.getElementById('todo-modal-subtitle');
  if (subtitle) subtitle.textContent = record.filenameRaw || record.filename || '';

  renderTodoGroups(parsedBlocks);

  const modal = document.getElementById('todo-modal');
  if (modal) modal.style.display = 'flex';

  setTimeout(() => {
    const firstInput = document.querySelector('#todo-modal-items .todo-add-input');
    if (firstInput) firstInput.focus();
  }, 80);
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

async function saveTodo() {
  if (!todoModalContext) return;

  const { notesFilePath, sectionKey, sectionContent, parsedBlocks, panelId, record } = todoModalContext;

  // Auto-confirm any rows still in inline-edit mode
  document.querySelectorAll('#todo-modal-items .todo-item-row.editing').forEach(row => confirmEditItem(row));
  document.querySelectorAll('#todo-modal-items .todo-comment-row.editing, #todo-modal-items .todo-reply-row.editing').forEach(row => confirmEditAnnotation(row));

  const allItems = parsedBlocks.flatMap(b => b.items);
  const lines = sectionContent.split('\n');
  const deletedLines = new Set();

  // 1. Apply item-level changes (toggle, edit, delete)
  document.querySelectorAll('#todo-modal-items .todo-item-row:not(.todo-item-new)').forEach(row => {
    const idx = parseInt(row.dataset.index, 10);
    if (isNaN(idx)) return;
    const item = allItems[idx];
    if (!item) return;
    const li = item.lineStart;

    if (row.dataset.deleted === 'true') {
      deletedLines.add(li);
      // Also delete all comment/reply lines for this item
      for (const comment of (item.comments || [])) {
        if (comment.lineStart >= 0) deletedLines.add(comment.lineStart);
        for (const reply of (comment.replies || [])) {
          deletedLines.add(reply.lineStart);
        }
      }
      return;
    }

    if (row.dataset.editedText !== undefined) {
      const match = lines[li] ? lines[li].match(/^(\s*(?:\[[ x]\]|\*) )(.*)/i) : null;
      if (match) lines[li] = match[1] + row.dataset.editedText;
    }

    const cb = row.querySelector('.todo-item-checkbox');
    if (cb && cb.checked !== item.completed) {
      if (cb.checked) {
        lines[li] = lines[li].replace(/^(\s*)(\[ \] |\* )/, '$1[x] ');
      } else {
        lines[li] = lines[li].replace(/^(\s*)\[x\] /i, '$1[ ] ');
      }
    }
  });

  // 2. Apply comment-level changes (edit, delete)
  document.querySelectorAll('#todo-modal-items .todo-comment-row:not(.todo-annotation-new)').forEach(row => {
    const iIdx = parseInt(row.dataset.itemIndex, 10);
    const cIdx = parseInt(row.dataset.commentIndex, 10);
    if (isNaN(iIdx) || isNaN(cIdx)) return;
    const comment = allItems[iIdx] && allItems[iIdx].comments[cIdx];
    if (!comment || comment.lineStart < 0) return;
    const li = comment.lineStart;

    if (row.dataset.deleted === 'true') {
      deletedLines.add(li);
      // Also delete all replies of this comment
      for (const reply of (comment.replies || [])) {
        deletedLines.add(reply.lineStart);
      }
      return;
    }

    if (row.dataset.editedText !== undefined) {
      lines[li] = lines[li].replace(/^(\s*COMMENT:)(.*)/, `$1 ${row.dataset.editedText}`);
    }
  });

  // 3. Apply reply-level changes (edit, delete)
  document.querySelectorAll('#todo-modal-items .todo-reply-row:not(.todo-annotation-new)').forEach(row => {
    const iIdx = parseInt(row.dataset.itemIndex, 10);
    const cIdx = parseInt(row.dataset.commentIndex, 10);
    const rIdx = parseInt(row.dataset.replyIndex, 10);
    if (isNaN(iIdx) || isNaN(cIdx) || isNaN(rIdx)) return;
    const comment = allItems[iIdx] && allItems[iIdx].comments[cIdx];
    const reply = comment && comment.replies[rIdx];
    if (!reply) return;
    const li = reply.lineStart;

    if (row.dataset.deleted === 'true') {
      deletedLines.add(li);
      return;
    }

    if (row.dataset.editedText !== undefined) {
      lines[li] = lines[li].replace(/^(\s*REPLY:)(.*)/, `$1 ${row.dataset.editedText}`);
    }
  });

  // Remove deleted lines in reverse order
  [...deletedLines].sort((a, b) => b - a).forEach(li => lines.splice(li, 1));
  let content = lines.join('\n');

  // 4. Collect new items, comments, replies per group from the DOM
  // (skip items belonging to brand-new sections — handled in step 5.5)
  const newItemsByGroup = [];
  document.querySelectorAll('#todo-modal-items .todo-item-row.todo-item-new').forEach(row => {
    const group = row.closest('.todo-group');
    if (group && group.dataset.newSection) return; // handled separately
    const gi = parseInt(row.dataset.groupIndex, 10);
    if (!newItemsByGroup[gi]) newItemsByGroup[gi] = [];
    const span = row.querySelector('.todo-item-text');
    if (span) newItemsByGroup[gi].push(span.textContent);
  });

  // Collect new comments per item (indexed by flat item index)
  const newCommentsByItem = {};
  document.querySelectorAll('#todo-modal-items .todo-comment-row.todo-annotation-new').forEach(row => {
    const iIdx = parseInt(row.dataset.itemIndex, 10);
    if (!newCommentsByItem[iIdx]) newCommentsByItem[iIdx] = [];
    const span = row.querySelector('.todo-annotation-text');
    // Also collect any new replies hanging off this new comment row
    const newReplies = [];
    row.querySelectorAll('.todo-reply-row.todo-annotation-new .todo-annotation-text').forEach(s => newReplies.push(s.textContent));
    if (span) newCommentsByItem[iIdx].push({ text: span.textContent, replies: newReplies });
  });

  // Collect new replies on existing comments (indexed by itemIndex-commentIndex)
  const newRepliesByComment = {};
  document.querySelectorAll('#todo-modal-items .todo-comment-row:not(.todo-annotation-new) .todo-reply-row.todo-annotation-new').forEach(row => {
    const iIdx = parseInt(row.dataset.itemIndex, 10);
    const cIdx = parseInt(row.dataset.commentIndex, 10);
    const key = `${iIdx}-${cIdx}`;
    if (!newRepliesByComment[key]) newRepliesByComment[key] = [];
    const span = row.querySelector('.todo-annotation-text');
    if (span) newRepliesByComment[key].push(span.textContent);
  });

  // 5. Insert new content, re-parsing after each round for accurate line positions
  const hasNewItems = newItemsByGroup.some(g => g && g.length > 0);
  const hasNewComments = Object.keys(newCommentsByItem).length > 0;
  const hasNewReplies = Object.keys(newRepliesByComment).length > 0;

  if (hasNewItems || hasNewComments || hasNewReplies) {
    let freshBlocks = await window.electronAPI.parseTodoSection(content);
    let freshLines = content.split('\n');

    // Insert new items (reverse group order to preserve line numbers)
    if (hasNewItems && freshBlocks) {
      for (let gi = freshBlocks.length - 1; gi >= 0; gi--) {
        const items = newItemsByGroup[gi];
        if (!items || items.length === 0 || !freshBlocks[gi]) continue;
        let insertAfter = freshBlocks[gi].blockEndLine;
        for (const text of items) {
          freshLines.splice(insertAfter + 1, 0, `[ ] ${text.trim()}`);
          insertAfter++;
        }
      }
      content = freshLines.join('\n');
      freshBlocks = await window.electronAPI.parseTodoSection(content);
      freshLines = content.split('\n');
    }

    // Insert new comments (in reverse flat-index order)
    if (hasNewComments && freshBlocks) {
      const freshAllItems = freshBlocks.flatMap(b => b.items);
      const commentKeys = Object.keys(newCommentsByItem).map(Number).sort((a, b) => b - a);
      for (const iIdx of commentKeys) {
        const newComments = newCommentsByItem[iIdx];
        if (!newComments || newComments.length === 0) continue;
        const freshItem = freshAllItems[iIdx];
        if (!freshItem) continue;
        // Insert after all existing comments/replies of this item
        let insertAfter = freshItem.lineStart;
        for (const c of (freshItem.comments || [])) {
          if (c.lineStart > insertAfter) insertAfter = c.lineStart;
          for (const r of (c.replies || [])) {
            if (r.lineStart > insertAfter) insertAfter = r.lineStart;
          }
        }
        for (const nc of newComments) {
          freshLines.splice(insertAfter + 1, 0, `  COMMENT: ${nc.text.trim()}`);
          insertAfter++;
          for (const nr of nc.replies) {
            freshLines.splice(insertAfter + 1, 0, `    REPLY: ${nr.trim()}`);
            insertAfter++;
          }
        }
      }
      content = freshLines.join('\n');
      freshBlocks = await window.electronAPI.parseTodoSection(content);
      freshLines = content.split('\n');
    }

    // Insert new replies on existing comments (reverse order)
    if (hasNewReplies && freshBlocks) {
      const freshAllItems = freshBlocks.flatMap(b => b.items);
      const replyKeys = Object.keys(newRepliesByComment).sort((a, b) => {
        const [ai, ac] = a.split('-').map(Number);
        const [bi, bc] = b.split('-').map(Number);
        return bi !== ai ? bi - ai : bc - ac;
      }).reverse();
      for (const key of replyKeys) {
        const [iIdx, cIdx] = key.split('-').map(Number);
        const freshItem = freshAllItems[iIdx];
        const freshComment = freshItem && freshItem.comments[cIdx];
        if (!freshComment || freshComment.lineStart < 0) continue;
        let insertAfter = freshComment.lineStart;
        for (const r of (freshComment.replies || [])) {
          if (r.lineStart > insertAfter) insertAfter = r.lineStart;
        }
        for (const nr of newRepliesByComment[key]) {
          freshLines.splice(insertAfter + 1, 0, `    REPLY: ${nr.trim()}`);
          insertAfter++;
        }
      }
      content = freshLines.join('\n');
    }
  }

  // 5.5 Append brand-new TODO sections added via "Add Section"
  document.querySelectorAll('#todo-modal-items .todo-group-new').forEach(groupEl => {
    const labelInput = groupEl.querySelector('.todo-new-section-label-input');
    const label = labelInput ? labelInput.value.trim() : '';
    const items = [];
    groupEl.querySelectorAll('.todo-item-row.todo-item-new').forEach(row => {
      const span = row.querySelector('.todo-item-text');
      if (span && span.textContent.trim()) items.push(span.textContent.trim());
    });
    if (items.length === 0) return; // skip empty sections with no items
    const header = label ? `TODO: ${label}` : 'TODO:';
    const itemLines = items.map(t => `[ ] ${t}`).join('\n');
    const block = `${header}\n${itemLines}`;
    if (content.length > 0 && !content.endsWith('\n')) content += '\n';
    if (content.length > 0) content += '\n';
    content += block;
  });

  // 6. Normalize (coerce indentation, asterisks → [ ], insert synthetic COMMENT before orphan REPLYs)
  content = await window.electronAPI.normalizeTodoSection(content);

  // 7. Write back to notes.txt
  try {
    const rawContent = await window.electronAPI.readFileContent(notesFilePath);
    const newFullContent = await window.electronAPI.invoke('write-notes-section', {
      existingContent: rawContent || '',
      sectionKey,
      newContent: content
    });
    await window.electronAPI.writeFileContent(notesFilePath, newFullContent);

    // Refresh the sidebar TODO aggregate for this notes file.
    // dirId is looked up in main from the notes path, so we can omit it here.
    try {
      await window.electronAPI.refreshTodoAggregate(notesFilePath, null);
    } catch (aggErr) {
      console.warn('TODO: aggregate refresh failed', aggErr);
    }
  } catch (err) {
    console.error('TODO: failed to write notes file', err);
    closeTodoModal();
    return;
  }

  // 8. Update grid record and refresh
  try {
    const newBlocks = await window.electronAPI.parseTodoSection(content);
    const total = newBlocks ? newBlocks.reduce((s, b) => s + b.items.length, 0) : 0;
    const completed = newBlocks ? newBlocks.reduce((s, b) => s + b.items.filter(i => i.completed).length, 0) : 0;
    const newTodoCounts = total > 0 ? { total, completed } : null;

    const state = panelState[panelId];
    if (state && state.w2uiGrid) {
      const grid = state.w2uiGrid;
      const rec = grid.records.find(r => r.recid === record.recid);
      if (rec) {
        rec.todo = newTodoCounts;
        grid.refresh();
      }
    }
  } catch (err) {
    console.warn('TODO: grid refresh after save failed', err);
  }

  closeTodoModal();
}

// ---------------------------------------------------------------------------
// Cancel / Close
// ---------------------------------------------------------------------------

function closeTodoModal() {
  const modal = document.getElementById('todo-modal');
  if (modal) modal.style.display = 'none';
  const box = document.querySelector('.todo-modal-box');
  if (box) box.classList.remove('todo-modal-expanded');
  const expandBtn = document.getElementById('btn-todo-expand');
  if (expandBtn) { expandBtn.title = 'Expand'; expandBtn.innerHTML = '&#10064;'; }
  todoModalContext = null;
}

// ---------------------------------------------------------------------------
// Add new section
// ---------------------------------------------------------------------------

function addNewSection() {
  const container = document.getElementById('todo-modal-items');
  if (!container) return;

  const gi = container.querySelectorAll('.todo-group').length;
  const div = document.createElement('div');
  div.className = 'todo-group todo-group-new';
  div.dataset.groupIndex = String(gi);
  div.dataset.newSection = 'true';
  div.innerHTML = `<div class="todo-group-header">
      <button class="todo-group-toggle" aria-label="Toggle group">&#9660;</button>
      <input type="text" class="todo-new-section-label-input" placeholder="Section name..." data-group-index="${gi}">
    </div>
    <div class="todo-group-body">
      <div class="todo-add-row">
        <input type="text" class="todo-add-input" data-group-index="${gi}" placeholder="Add item..." value="">
        <button class="todo-add-btn" data-group-index="${gi}" title="Add item">+</button>
      </div>
    </div>`;
  container.appendChild(div);

  const collapseControls = document.getElementById('todo-collapse-controls');
  if (collapseControls && container.querySelectorAll('.todo-group').length > 1) {
    collapseControls.style.display = 'flex';
  }

  div.querySelector('.todo-new-section-label-input').focus();
}

// ---------------------------------------------------------------------------
// Init -- wire up static buttons + event delegation for dynamic content
// ---------------------------------------------------------------------------

export function initTodoModal() {
  const saveBtn = document.getElementById('btn-todo-save');
  const cancelBtn = document.getElementById('btn-todo-cancel');
  const collapseAllBtn = document.getElementById('btn-todo-collapse-all');
  const expandAllBtn = document.getElementById('btn-todo-expand-all');
  const expandModalBtn = document.getElementById('btn-todo-expand');
  const addSectionBtn = document.getElementById('btn-todo-add-section');

  if (saveBtn) saveBtn.addEventListener('click', saveTodo);
  if (cancelBtn) cancelBtn.addEventListener('click', closeTodoModal);
  if (addSectionBtn) addSectionBtn.addEventListener('click', addNewSection);

  if (expandModalBtn) {
    expandModalBtn.addEventListener('click', () => {
      const box = document.querySelector('.todo-modal-box');
      if (!box) return;
      const expanded = box.classList.toggle('todo-modal-expanded');
      expandModalBtn.title = expanded ? 'Restore' : 'Expand';
      expandModalBtn.innerHTML = expanded ? '&#10063;' : '&#10064;';
    });
  }

  if (collapseAllBtn) {
    collapseAllBtn.addEventListener('click', () => {
      document.querySelectorAll('#todo-modal-items .todo-group').forEach(g => g.classList.add('collapsed'));
    });
  }
  if (expandAllBtn) {
    expandAllBtn.addEventListener('click', () => {
      document.querySelectorAll('#todo-modal-items .todo-group').forEach(g => g.classList.remove('collapsed'));
    });
  }

  const itemsContainer = document.getElementById('todo-modal-items');
  if (itemsContainer) {
    itemsContainer.addEventListener('click', (e) => {
      // Toggle group collapse
      const toggleTarget = e.target.closest('.todo-group-toggle') || e.target.closest('.todo-group-header');
      if (toggleTarget) {
        const group = toggleTarget.closest('.todo-group');
        if (group) group.classList.toggle('collapsed');
        return;
      }

      // Toggle comments section
      const commentsToggle = e.target.closest('.todo-comments-toggle');
      if (commentsToggle) {
        const iIdx = commentsToggle.dataset.itemIndex;
        const section = document.querySelector(`.todo-comments-section[data-item-index="${iIdx}"]`);
        if (section) section.classList.toggle('collapsed');
        return;
      }

      // Toggle replies section inside a comment
      const repliesToggle = e.target.closest('.todo-replies-toggle');
      if (repliesToggle) {
        const repliesSection = repliesToggle.closest('.todo-comment-row')?.querySelector('.todo-replies-section');
        if (repliesSection) repliesSection.classList.toggle('collapsed');
        return;
      }

      // + add item button
      const addBtn = e.target.closest('.todo-add-btn');
      if (addBtn) {
        addPendingItem(parseInt(addBtn.dataset.groupIndex, 10));
        return;
      }

      // + add comment button
      const commentAddBtn = e.target.closest('.todo-comment-add-btn');
      if (commentAddBtn) {
        addPendingComment(parseInt(commentAddBtn.dataset.itemIndex, 10));
        return;
      }

      // + add reply button
      const replyAddBtn = e.target.closest('.todo-reply-add-btn');
      if (replyAddBtn) {
        const commentRow = replyAddBtn.closest('.todo-comment-row');
        if (commentRow) addPendingReply(commentRow);
        return;
      }

      // Edit item (existing)
      const editBtn = e.target.closest('.todo-item-edit-btn');
      if (editBtn) {
        const itemRow = editBtn.closest('.todo-item-row');
        if (itemRow && !itemRow.classList.contains('todo-item-deleted')) {
          startEditItem(itemRow);
          return;
        }
        // Edit annotation (comment/reply)
        const annotRow = editBtn.closest('.todo-comment-row, .todo-reply-row');
        if (annotRow && !annotRow.dataset.new && !annotRow.classList.contains('todo-item-deleted')) {
          startEditAnnotation(annotRow);
          return;
        }
        return;
      }

      // Confirm edit
      const confirmBtn = e.target.closest('.todo-item-confirm-btn');
      if (confirmBtn) {
        const itemRow = confirmBtn.closest('.todo-item-row');
        if (itemRow) { confirmEditItem(itemRow); return; }
        const annotRow = confirmBtn.closest('.todo-comment-row, .todo-reply-row');
        if (annotRow) { confirmEditAnnotation(annotRow); return; }
        return;
      }

      // Cancel edit
      const cancelEditBtn = e.target.closest('.todo-item-cancel-edit-btn');
      if (cancelEditBtn) {
        const itemRow = cancelEditBtn.closest('.todo-item-row');
        if (itemRow) { cancelEditItem(itemRow); return; }
        const annotRow = cancelEditBtn.closest('.todo-comment-row, .todo-reply-row');
        if (annotRow) { cancelEditAnnotation(annotRow); return; }
        return;
      }

      // Delete (existing item)
      const deleteBtn = e.target.closest('.todo-item-delete-btn');
      if (deleteBtn) {
        const itemRow = deleteBtn.closest('.todo-item-row');
        if (itemRow && !itemRow.dataset.new) { deleteItem(itemRow); return; }
        const annotRow = deleteBtn.closest('.todo-comment-row, .todo-reply-row');
        if (annotRow && !annotRow.dataset.new) { deleteAnnotation(annotRow); return; }
      }

      // Delete pending new (item, comment, or reply)
      const deleteNewBtn = e.target.closest('.todo-item-delete-new-btn');
      if (deleteNewBtn) {
        const row = deleteNewBtn.closest('.todo-item-row, .todo-comment-row, .todo-reply-row');
        if (row) row.remove();
        return;
      }

      // Switch to Reminder modal from cohabitation banner
      const switchRemBtn = e.target.closest('.btn-todo-switch-reminder');
      if (switchRemBtn && todoModalContext) {
        const banner = switchRemBtn.closest('.todo-cohab-reminder-banner');
        if (banner) {
          const reminderItem = {
            text:            banner.dataset.reminderText || '',
            due_datetime:    banner.dataset.reminderDate || null,
            lineStart:       parseInt(banner.dataset.reminderLine, 10) || null,
            notesPath:       todoModalContext.notesFilePath,
            sectionKey:      todoModalContext.sectionKey,
            isCohabitated:   true,
            linkedTodoLine:  null, // will be resolved in modal
            dirId:           null
          };
          const { record, panelId } = todoModalContext;
          closeTodoModal();
          void openReminderModal(reminderItem, record, panelId);
        }
        return;
      }
    });

    itemsContainer.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('.todo-add-input')) {
        e.preventDefault();
        addPendingItem(parseInt(e.target.dataset.groupIndex, 10));
      }
      if (e.key === 'Enter' && e.target.matches('.todo-comment-add-input')) {
        e.preventDefault();
        addPendingComment(parseInt(e.target.dataset.itemIndex, 10));
      }
      if (e.key === 'Enter' && e.target.matches('.todo-reply-add-input')) {
        e.preventDefault();
        const commentRow = e.target.closest('.todo-comment-row');
        if (commentRow) addPendingReply(commentRow);
      }
      if (e.key === 'Enter' && e.target.matches('.todo-item-edit-input')) {
        e.preventDefault();
        const itemRow = e.target.closest('.todo-item-row');
        if (itemRow) { confirmEditItem(itemRow); return; }
        const annotRow = e.target.closest('.todo-comment-row, .todo-reply-row');
        if (annotRow) confirmEditAnnotation(annotRow);
      }
      if (e.key === 'Escape' && e.target.matches('.todo-item-edit-input')) {
        e.preventDefault();
        const itemRow = e.target.closest('.todo-item-row');
        if (itemRow) { cancelEditItem(itemRow); return; }
        const annotRow = e.target.closest('.todo-comment-row, .todo-reply-row');
        if (annotRow) cancelEditAnnotation(annotRow);
      }
    });
  }

  const modal = document.getElementById('todo-modal');
  if (modal) {
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveTodo();
      }
    });
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeTodoModal();
    });
  }
}
