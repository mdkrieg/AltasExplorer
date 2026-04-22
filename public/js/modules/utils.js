/**
 * Utility Functions Module
 * Pure helper functions for formatting, validation, and conversion
 * No dependency on global state
 */

/**
 * Get Monaco editor language based on notes format
 */
export function getLanguageForFormat(format) {
  const formatToLanguage = {
    'markdown': 'markdown',
    'html': 'html',
    'json': 'json',
    'text': 'plaintext',
    'python': 'python',
    'javascript': 'javascript',
    'css': 'css',
    'xml': 'xml'
  };
  return formatToLanguage[format] || 'plaintext';
}

/**
 * Format notes content based on format type
 */
export function formatFileContent(content, format) {
  if (format === 'json') {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch (e) {
      return content; // Return original if invalid JSON
    }
  }
  return content;
}

/**
 * Get CSS class name for a file row based on change state
 */
export function getRowClassName(changeState) {
  if (!changeState) return '';
  if (changeState === 'added') return 'row-added';
  if (changeState === 'modified') return 'row-modified';
  if (changeState === 'deleted') return 'row-deleted';
  return '';
}

/**
 * Format a permissions object as a short display string
 */
export function formatPerms(perms) {
  if (!perms) return '-';
  const rwx = (num) => {
    let s = '';
    s += num & 4 ? 'r' : '-';
    s += num & 2 ? 'w' : '-';
    s += num & 1 ? 'x' : '-';
    return s;
  };
  const mode = perms.mode || 0;
  const owner = rwx((mode >> 6) & 7);
  const group = rwx((mode >> 3) & 7);
  const other = rwx(mode & 7);
  return `${owner}${group}${other}`;
}

/**
 * Render permission text with a tooltip containing raw stats.mode
 */
export function getPermsCell(entry) {
  const permsText = formatPerms(entry.stats);
  const modeStr = entry.stats?.mode ? `0o${(entry.stats.mode & parseInt('7777', 8)).toString(8)}` : 'N/A';
  return `<span title="${modeStr}">${permsText}</span>`;
}

/**
 * Get formatted date modified cell with appropriate styling
 */
export function getDateModifiedCell(file, changeState) {
  const dateStr = new Date(file.dateModified).toLocaleString();
  const className = changeState ? `change-${changeState}` : '';
  return `<span class="${className}">${dateStr}</span>`;
}

/**
 * Get formatted checksum cell with appropriate styling based on state
 */
export function getChecksumCell(file, changeState) {
  if (!file.checksum) return '<span class="checksum-pending">pending</span>';
  if (file.checksum === 'calculating') return '<span class="checksum-calculating">calculating...</span>';
  if (changeState === 'modified') return `<span class="checksum-mismatch">${file.checksum}</span>`;
  return `<span class="checksum-ok">${file.checksum}</span>`;
}

/**
 * Format attribute values for display
 */
export function formatAttributeValue(attr, value) {
  if (!value) return '';
  if (attr.type === 'number') {
    return value.toString();
  }
  if (attr.type === 'date') {
    const date = new Date(value);
    return date.toLocaleDateString();
  }
  if (attr.type === 'checkbox') {
    return value ? 'Yes' : 'No';
  }
  return value.toString();
}

/**
 * Escape HTML special characters
 */
export function escapeHtml(unsafe) {
  if (!unsafe) return '';
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Convert hex color to RGB string
 */
export function rgbToString(hexColor) {
  const r = parseInt(hexColor.substr(1, 2), 16);
  const g = parseInt(hexColor.substr(3, 2), 16);
  const b = parseInt(hexColor.substr(5, 2), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Format bytes to human-readable size
 */
export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Convert HEX color to RGB string format
 */
export function hexToRgb(hex) {
  if (!hex || hex.length < 7) return 'rgb(0, 0, 0)';
  const r = parseInt(hex.substr(1, 2), 16);
  const g = parseInt(hex.substr(3, 2), 16);
  const b = parseInt(hex.substr(5, 2), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Convert RGB string to HEX format
 */
export function rgbToHex(rgb) {
  if (!rgb) return '#000000';
  const match = rgb.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  if (!match) return '#000000';
  const hex = (x) => {
    return ('0' + parseInt(x).toString(16)).slice(-2);
  };
  return '#' + hex(match[1]) + hex(match[2]) + hex(match[3]);
}

/**
 * Normalize a stored hotkey combo to PascalCase display form
 */
export function formatHotkeyDisplay(combo) {
  if (!combo) return '';
  return combo
    .split('+')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('+');
}

/**
 * Return the portion of entryPath that is relative to rootPath
 */
export function getRelativePathFromRoot(rootPath, entryPath) {
  if (!rootPath || !entryPath) return entryPath;

  const rootNorm = rootPath.replace(/\\/g, '/').toLowerCase();
  const entryNorm = entryPath.replace(/\\/g, '/').toLowerCase();

  if (rootNorm === entryNorm) return '.';

  if (entryNorm.startsWith(rootNorm + '/')) {
    return entryPath.substring(rootPath.length + 1);
  }

  return entryPath;
}

/**
 * Display inline form error message and optionally mark a field as invalid
 * @param {string} statusId - ID of status/message display div
 * @param {string} message - Error message to display
 * @param {string} [fieldId] - Optional ID of input field to mark with w2ui-error class
 */
export function showFormError(statusId, message, fieldId = null) {
  if (fieldId) {
    const el = document.getElementById(fieldId);
    if (el) el.classList.add('w2ui-error');
  }
  const status = document.getElementById(statusId);
  if (status) {
    status.textContent = message;
    status.style.color = '#c62828';
    status.style.display = 'block';
  }
}

/**
 * Display inline form success message (auto-hides after 2.5s)
 * @param {string} statusId - ID of status/message display div
 * @param {string} message - Success message to display
 */
export function showFormSuccess(statusId, message) {
  const status = document.getElementById(statusId);
  if (status) {
    status.textContent = message;
    status.style.color = '#388e3c';
    status.style.display = 'block';
    setTimeout(() => { status.style.display = 'none'; status.textContent = ''; }, 2500);
  }
}

/**
 * Clear all form error styling and status message
 * @param {string} [formId] - Optional ID of form to clear .w2ui-error classes from
 * @param {string} statusId - ID of status/message display div to clear
 */
export function clearFormStatus(formId, statusId) {
  if (formId) {
    document.getElementById(formId)
      ?.querySelectorAll('.w2ui-error')
      .forEach(el => el.classList.remove('w2ui-error'));
  }
  const status = document.getElementById(statusId);
  if (status) {
    status.style.display = 'none';
    status.textContent = '';
  }
}

/**
 * Attach a live input validator to a tag name input element.
 * Strips any character that is not in [a-zA-Z0-9_-] on every keystroke or paste,
 * preserving the cursor position so the field does not feel jumpy.
 *
 * @param {HTMLInputElement} inputEl - The input element to enforce
 */
export function enforceTagNameInput(inputEl) {
  if (!inputEl || inputEl._tagNameEnforced) return;
  inputEl._tagNameEnforced = true;
  inputEl.addEventListener('input', function () {
    const before = this.selectionStart;
    const raw = this.value;
    const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '');
    if (cleaned !== raw) {
      const removed = raw.length - cleaned.length;
      this.value = cleaned;
      const newPos = Math.max(0, before - removed);
      this.setSelectionRange(newPos, newPos);
    }
  });
}
