/**
 * Shared annotation (COMMENT / REPLY) helpers.
 * Used by both the TODO modal (todos.js) and the Reminder modal (reminders.js).
 *
 * These helpers deal with:
 *   - Rendering the comments/replies HTML tree for a single item
 *   - Inline editing of annotation text (start / confirm / cancel)
 *   - Soft-delete of annotations (with undo)
 *   - Adding new pending comment / reply rows
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/**
 * Build the HTML for the collapsible comments + replies section of one item.
 *
 * @param {object} item        – parsed TODO or REMINDER item with `.comments`
 * @param {number} flatIndex   – 0-based flat item index within the modal scope
 * @param {string} [containerClass='todo-comments-section'] – CSS class for the outer div
 * @returns {{ html: string, badge: string }}
 */
export function renderCommentSection(item, flatIndex, containerClass = 'todo-comments-section') {
  const comments = item.comments || [];
  const count = comments.reduce((n, c) => n + 1 + (c.replies ? c.replies.length : 0), 0);
  const badge = count > 0 ? ` (${count})` : '';

  let html = `<div class="${escapeHtml(containerClass)} collapsed" data-item-index="${flatIndex}">`;

  for (let ci = 0; ci < comments.length; ci++) {
    const comment = comments[ci];
    const isSynthetic = comment.lineStart === -1;
    const replyCount = (comment.replies || []).length;
    const replyBadge = replyCount > 0 ? ` (${replyCount})` : '';

    html += `<div class="todo-comment-row" data-item-index="${flatIndex}" data-comment-index="${ci}" data-line="${comment.lineStart}">`;
    if (!isSynthetic) {
      html += `<div class="todo-comment-header">
          <span class="todo-annotation-label">COMMENT:</span>
          <span class="todo-annotation-text">${escapeHtml(comment.text)}</span>
          <span class="todo-comment-reply-badge">${replyCount > 0 ? `&#128172; (${replyCount})` : ''}</span>
          <div class="todo-item-actions">
            <button class="todo-replies-toggle" data-item-index="${flatIndex}" data-comment-index="${ci}" title="Toggle replies">&#128172;<span class="todo-reply-badge">${replyBadge}</span></button>
            <button class="todo-item-action-btn todo-item-edit-btn" title="Edit">&#9998;</button>
            <button class="todo-item-action-btn todo-item-delete-btn" title="Remove">&#10005;</button>
          </div>
        </div>`;
    }
    html += `<div class="todo-replies-section collapsed" data-item-index="${flatIndex}" data-comment-index="${ci}">`;
    html += `<div class="todo-reply-list">`;
    for (let ri = 0; ri < (comment.replies || []).length; ri++) {
      const reply = comment.replies[ri];
      html += `<div class="todo-reply-row" data-item-index="${flatIndex}" data-comment-index="${ci}" data-reply-index="${ri}" data-line="${reply.lineStart}">
          <span class="todo-annotation-label">REPLY:</span>
          <span class="todo-annotation-text">${escapeHtml(reply.text)}</span>
          <div class="todo-item-actions">
            <button class="todo-item-action-btn todo-item-edit-btn" title="Edit">&#9998;</button>
            <button class="todo-item-action-btn todo-item-delete-btn" title="Remove">&#10005;</button>
          </div>
        </div>`;
    }
    html += `</div>`; // .todo-reply-list
    html += `<div class="todo-reply-add-row">
        <input type="text" class="todo-annotation-add-input todo-reply-add-input" placeholder="Add reply..." data-item-index="${flatIndex}" data-comment-index="${ci}">
        <button class="todo-reply-add-btn" data-item-index="${flatIndex}" data-comment-index="${ci}" title="Add reply">+</button>
      </div>`;
    html += `</div>`; // .todo-replies-section
    html += `</div>`; // .todo-comment-row
  }

  html += `<div class="todo-comment-add-row">
      <input type="text" class="todo-annotation-add-input todo-comment-add-input" placeholder="Add comment..." data-item-index="${flatIndex}">
      <button class="todo-comment-add-btn" data-item-index="${flatIndex}" title="Add comment">+</button>
    </div>`;

  html += `</div>`; // outer container

  return { html, badge };
}

// ---------------------------------------------------------------------------
// Inline editing
// ---------------------------------------------------------------------------

/** Build the actions HTML for the comment header (replies toggle + edit + delete). */
function commentHeaderActionsHtml(row) {
  const repliesSection = row.querySelector('.todo-replies-section');
  const replyCount = repliesSection ? repliesSection.querySelectorAll('.todo-reply-row').length : 0;
  const replyBadge = replyCount > 0 ? ` (${replyCount})` : '';

  // Also sync the static badge span
  const staticBadge = row.querySelector('.todo-comment-header > .todo-comment-reply-badge');
  if (staticBadge) staticBadge.innerHTML = replyCount > 0 ? `&#128172; (${replyCount})` : '';

  return `<button class="todo-replies-toggle" data-item-index="${row.dataset.itemIndex}" data-comment-index="${row.dataset.commentIndex}" title="Toggle replies">&#128172;<span class="todo-reply-badge">${replyBadge}</span></button>
    <button class="todo-item-action-btn todo-item-edit-btn" title="Edit">&#9998;</button>
    <button class="todo-item-action-btn todo-item-delete-btn" title="Remove">&#10005;</button>`;
}

/**
 * Start editing an annotation row (COMMENT or REPLY).
 * @param {HTMLElement} row
 */
export function startEditAnnotation(row) {
  if (row.classList.contains('editing')) return;
  const span    = row.querySelector('.todo-annotation-text');
  const actions = row.querySelector('.todo-item-actions');
  if (!span || !actions) return;

  row.classList.add('editing');
  const current = row.dataset.editedText !== undefined ? row.dataset.editedText : span.textContent;

  const input = document.createElement('input');
  input.type      = 'text';
  input.className = 'todo-item-edit-input';
  input.value     = current;
  span.replaceWith(input);
  input.focus();
  input.select();

  actions.innerHTML = `<button class="todo-item-action-btn todo-item-confirm-btn" title="Confirm">&#10003;</button>
    <button class="todo-item-action-btn todo-item-cancel-edit-btn" title="Cancel">&#10005;</button>`;
}

/**
 * Confirm the edit of an annotation row.
 * @param {HTMLElement} row
 */
export function confirmEditAnnotation(row) {
  const input   = row.querySelector('.todo-item-edit-input');
  const actions = row.querySelector('.todo-item-actions');
  if (!input || !actions) return;

  const newText        = input.value.trim() || input.value;
  row.dataset.editedText = newText;

  const span           = document.createElement('span');
  span.className       = 'todo-annotation-text';
  span.textContent     = newText;
  input.replaceWith(span);
  row.classList.remove('editing');

  actions.innerHTML = row.classList.contains('todo-comment-row')
    ? commentHeaderActionsHtml(row)
    : `<button class="todo-item-action-btn todo-item-edit-btn" title="Edit">&#9998;</button>
    <button class="todo-item-action-btn todo-item-delete-btn" title="Remove">&#10005;</button>`;
}

/**
 * Cancel editing an annotation row, restoring the previous value.
 * @param {HTMLElement} row
 */
export function cancelEditAnnotation(row) {
  const input   = row.querySelector('.todo-item-edit-input');
  const actions = row.querySelector('.todo-item-actions');
  if (!input || !actions) return;

  const restoreText    = row.dataset.editedText !== undefined ? row.dataset.editedText : input.value;
  const span           = document.createElement('span');
  span.className       = 'todo-annotation-text';
  span.textContent     = restoreText;
  input.replaceWith(span);
  row.classList.remove('editing');

  actions.innerHTML = row.classList.contains('todo-comment-row')
    ? commentHeaderActionsHtml(row)
    : `<button class="todo-item-action-btn todo-item-edit-btn" title="Edit">&#9998;</button>
    <button class="todo-item-action-btn todo-item-delete-btn" title="Remove">&#10005;</button>`;
}

/**
 * Toggle soft-delete state of an annotation row.
 * Deleting a second time undoes the deletion.
 * @param {HTMLElement} row
 */
export function deleteAnnotation(row) {
  const isDeleted = row.classList.contains('todo-item-deleted');
  const actions   = row.querySelector('.todo-item-actions');
  if (isDeleted) {
    row.classList.remove('todo-item-deleted');
    delete row.dataset.deleted;
    if (actions) actions.innerHTML = row.classList.contains('todo-comment-row')
      ? commentHeaderActionsHtml(row)
      : `<button class="todo-item-action-btn todo-item-edit-btn" title="Edit">&#9998;</button>
      <button class="todo-item-action-btn todo-item-delete-btn" title="Remove">&#10005;</button>`;
  } else {
    if (row.classList.contains('editing')) cancelEditAnnotation(row);
    row.classList.add('todo-item-deleted');
    row.dataset.deleted = 'true';
    if (actions) actions.innerHTML = `<button class="todo-item-action-btn todo-item-delete-btn" title="Undo remove" style="color:#1976d2;">&#8617;</button>`;
  }
}

// ---------------------------------------------------------------------------
// Add pending rows
// ---------------------------------------------------------------------------

/**
 * Read the comment-add input for the given flat item index and insert a new
 * pending comment row before the add row.
 *
 * @param {number}           itemIndex
 * @param {HTMLElement|null} [scope=document] – scope element for the query
 */
export function addPendingComment(itemIndex, scope = document) {
  const section = scope.querySelector(`.todo-comments-section[data-item-index="${itemIndex}"]`);
  if (!section) return;
  const addRow = section.querySelector('.todo-comment-add-row');
  const input  = addRow ? addRow.querySelector('.todo-annotation-add-input') : null;
  const text   = input ? input.value.trim() : '';
  if (!text) return;

  const row = document.createElement('div');
  row.className = 'todo-comment-row todo-annotation-new';
  row.dataset.new       = 'true';
  row.dataset.kind      = 'comment';
  row.dataset.itemIndex = String(itemIndex);
  row.innerHTML = `<div class="todo-comment-header">
      <span class="todo-annotation-label">COMMENT:</span>
      <span class="todo-annotation-text">${escapeHtml(text)}</span>
      <span class="todo-comment-reply-badge"></span>
      <div class="todo-item-actions">
        <button class="todo-replies-toggle" data-item-index="${itemIndex}" data-comment-new="true" title="Toggle replies">&#128172;</button>
        <button class="todo-item-action-btn todo-item-delete-new-btn" title="Remove">&#10005;</button>
      </div>
    </div>
    <div class="todo-replies-section collapsed" data-item-index="${itemIndex}" data-comment-new="true">
      <div class="todo-reply-list"></div>
      <div class="todo-reply-add-row">
        <input type="text" class="todo-annotation-add-input todo-reply-add-input" placeholder="Add reply..." data-item-index="${itemIndex}" data-comment-new="true">
        <button class="todo-reply-add-btn" data-item-index="${itemIndex}" data-comment-new="true" title="Add reply">+</button>
      </div>
    </div>`;
  section.insertBefore(row, addRow);

  if (input) { input.value = ''; input.focus(); }
}

/**
 * Read the reply-add input inside a comment row and append a new pending
 * reply row to that comment's reply list.
 *
 * @param {HTMLElement} commentRow
 */
export function addPendingReply(commentRow) {
  const addRow    = commentRow.querySelector('.todo-reply-add-row');
  const input     = addRow ? addRow.querySelector('.todo-reply-add-input') : null;
  const text      = input ? input.value.trim() : '';
  if (!text) return;

  const replyList = commentRow.querySelector('.todo-reply-list');
  if (!replyList) return;

  const row = document.createElement('div');
  row.className      = 'todo-reply-row todo-annotation-new';
  row.dataset.new          = 'true';
  row.dataset.kind         = 'reply';
  row.dataset.itemIndex    = commentRow.dataset.itemIndex    || '';
  row.dataset.commentIndex = commentRow.dataset.commentIndex || '';
  row.innerHTML = `<span class="todo-annotation-label">REPLY:</span>
    <span class="todo-annotation-text">${escapeHtml(text)}</span>
    <div class="todo-item-actions">
      <button class="todo-item-action-btn todo-item-delete-new-btn" title="Remove">&#10005;</button>
    </div>`;
  replyList.appendChild(row);

  if (input) { input.value = ''; input.focus(); }
}
