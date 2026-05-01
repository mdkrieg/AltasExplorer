/**
 * Notes module.
 * Owns notes modal behavior, panel file-view editing, and shared Monaco loader state.
 */

import * as utils from './utils.js';
import * as panels from './panels.js';
import { panelState, setFileEditMode, setSelectedItemState } from '../renderer.js';

let monacoLoaded = false;
export let monacoEditor = null;

// Intercept all anchor clicks in the renderer. Runs in capture phase so it
// fires before any child handler and cannot be suppressed by the DOM tree.
//   http/https hrefs  → forwarded to the OS default browser via IPC
//   all other non-'#' → silently blocked (javascript:, data:, relative paths, etc.)
//   '#' fragments     → allowed through unchanged (in-page anchors)
document.addEventListener('click', (e) => {
  const anchor = e.target.closest('a[href]');
  if (!anchor) return;
  const href = anchor.getAttribute('href');
  if (!href || href.startsWith('#')) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (/^https?:\/\//i.test(href)) {
    window.electronAPI.openExternalLink(href).catch(() => {});
  }
}, true);

let notesModalEditor = null;
let notesModalEditMode = false;
let notesModalContext = null;

/**
 * Attach an image-paste handler to a Monaco editor instance.
 * Listens at the document level (capture phase) so it fires before Monaco's
 * internal textarea handler, which otherwise consumes the paste event.
 * Gated on editor.hasTextFocus() so it only activates when this editor is
 * the active target. Cleans itself up automatically when the editor is disposed.
 */
function attachImagePasteHandler(editor, notesFilePath) {
  const handler = async (e) => {
    if (!editor.hasTextFocus()) return;
    const items = Array.from(e.clipboardData?.items || []);
    const imageItem = items.find(item => item.type.startsWith('image/'));
    if (!imageItem) return;
    e.preventDefault();
    e.stopPropagation();
    const blob = imageItem.getAsFile();
    if (!blob) return;
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      const rawExt = imageItem.type.split('/')[1] || 'png';
      const ext = rawExt === 'jpeg' ? 'jpg' : 'png';
      const result = await window.electronAPI.saveNotesImage({ notesFilePath, base64, ext });
      if (result && result.relativePath) {
        const position = editor.getPosition();
        editor.executeEdits('paste-image', [{
          range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
          text: `![image](${result.relativePath})`
        }]);
        editor.focus();
      }
    } catch (err) {
      console.error('Error saving pasted image:', err);
    }
  };

  document.addEventListener('paste', handler, true);
  editor.onDidDispose(() => {
    document.removeEventListener('paste', handler, true);
  });
}

function syncRecordHasNotes(record, hasNotes) {
  if (!record || !record.path) {
    return;
  }

  record.hasNotes = hasNotes;

  for (const state of Object.values(panelState)) {
    const grid = state.w2uiGrid;
    if (!grid || !Array.isArray(grid.records)) {
      continue;
    }

    const gridRecord = grid.records.find(candidate =>
      candidate.path === record.path && candidate.isFolder === record.isFolder
    );

    if (!gridRecord) {
      continue;
    }

    gridRecord.hasNotes = hasNotes;
    grid.refreshRow(gridRecord.recid);
  }
}

export function getLanguageForFormat(format) {
  switch (format) {
    case 'PlainText':
    case 'Extended':
      return 'plaintext';
    case 'Markdown':
      return 'markdown';
    default:
      return 'plaintext';
  }
}

/**
 * Resolve the display format ('Markdown' | 'PlainText') for a file.
 * viewMode values: 'text-plain', 'text-markdown', 'auto-detect', or null (use settings).
 */
function resolveViewFormat(filePath, viewMode, settingsFileFormat) {
  if (viewMode === 'text-plain') return 'PlainText';
  if (viewMode === 'text-markdown') return 'Markdown';
  if (viewMode === 'auto-detect') {
    const basename = (filePath || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
    if (basename === 'notes.txt' || basename.endsWith('.md')) {
      return settingsFileFormat || 'Markdown';
    }
    return 'PlainText';
  }
  // null / undefined → honour the global setting (existing behaviour)
  return settingsFileFormat || 'Markdown';
}

/**
 * Build a hex-dump HTML string from a byte array.
 * Standard "offset  | hex groups | ASCII" layout, 16 bytes per row.
 */
function formatHexDump(bytes, totalSize, truncated) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = Array.isArray(bytes) ? bytes.slice(i, i + 16) : Array.from(bytes.slice(i, i + 16));
    const offset = i.toString(16).toUpperCase().padStart(8, '0');
    const hex1 = [], hex2 = [], ascii = [];
    for (let j = 0; j < 16; j++) {
      if (j < chunk.length) {
        const b = chunk[j];
        const h = b.toString(16).toUpperCase().padStart(2, '0');
        (j < 8 ? hex1 : hex2).push(h);
        ascii.push(b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '.');
      } else {
        (j < 8 ? hex1 : hex2).push('  ');
        ascii.push(' ');
      }
    }
    lines.push(`${offset}  ${hex1.join(' ')}  ${hex2.join(' ')}  |${ascii.join('')}|`);
  }
  const body = utils.escapeHtml(lines.join('\n'));
  const note = truncated
    ? `\n<span style="color:#888;font-style:italic;">[First ${bytes.length.toLocaleString()} of ${totalSize.toLocaleString()} bytes shown]</span>`
    : '';
  return `<pre style="font-family:'Courier New',Consolas,monospace;font-size:12px;white-space:pre;line-height:1.5;padding:8px;margin:0;overflow:auto;">${body}${note}</pre>`;
}

export function formatFileContent(content, format) {
  switch (format) {
    case 'PlainText':
      return '<pre style="font-family: monospace; white-space: pre-wrap; word-wrap: break-word;">' +
        utils.escapeHtml(content) + '</pre>';

    case 'Extended': {
      let escaped = utils.escapeHtml(content);
      let formatted = escaped.replace(/&lsqb;([^\]]+)&rsqb;&lpar;([^)]+)&rpar;/g,
        '<a href="$2" target="_blank" style="color: #2196F3; text-decoration: underline;">$1</a>');
      formatted = formatted.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
        '<a href="$2" target="_blank" style="color: #2196F3; text-decoration: underline;">$1</a>');
      return '<pre style="font-family: monospace; white-space: pre-wrap; word-wrap: break-word;">' + formatted + '</pre>';
    }

    case 'Markdown':
      return null;

    default:
      return '<pre style="font-family: monospace; white-space: pre-wrap; word-wrap: break-word;">' +
        utils.escapeHtml(content) + '</pre>';
  }
}

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

export async function initializeMonacoLoader() {
  return new Promise((resolve) => {
    if (monacoLoaded) {
      resolve();
      return;
    }

    const waitForRequire = setInterval(() => {
      if (typeof require !== 'undefined') {
        clearInterval(waitForRequire);

        require.config({ paths: { 'vs': '../node_modules/monaco-editor/min/vs' } });

        require(['vs/editor/editor.main'], function () {
          console.log('Monaco editor loader initialized');
          monacoLoaded = true;

          ['markdown', 'plaintext'].forEach(lang => {
            monaco.languages.registerCompletionItemProvider(lang, {
              triggerCharacters: ['@', '#'],
              provideCompletionItems: async (model, position) => {
                const textUntilPosition = model.getValueInRange({
                  startLineNumber: position.lineNumber,
                  startColumn: 1,
                  endLineNumber: position.lineNumber,
                  endColumn: position.column
                });
                const match = textUntilPosition.match(/@#(\w*)$/);
                if (!match) return { suggestions: [] };

                const startCol = position.column - match[0].length;
                const range = {
                  startLineNumber: position.lineNumber,
                  endLineNumber: position.lineNumber,
                  startColumn: startCol,
                  endColumn: position.column
                };

                const tags = await window.electronAPI.getTagsList();
                const suggestions = tags.map(tag => ({
                  label: `@#${tag.name}`,
                  kind: monaco.languages.CompletionItemKind.Value,
                  insertText: `@#${tag.name}`,
                  filterText: `@#${tag.name}`,
                  range,
                  documentation: tag.description || ''
                }));
                return { suggestions };
              }
            });

            // TODO: keyword completion
            monaco.languages.registerCompletionItemProvider(lang, {
              triggerCharacters: ['T', 'O', 'D'],
              provideCompletionItems: (model, position) => {
                const textUntilPosition = model.getValueInRange({
                  startLineNumber: position.lineNumber,
                  startColumn: 1,
                  endLineNumber: position.lineNumber,
                  endColumn: position.column
                });
                if (!/^TODO?:?$/.test(textUntilPosition)) return { suggestions: [] };
                const range = {
                  startLineNumber: position.lineNumber,
                  endLineNumber: position.lineNumber,
                  startColumn: 1,
                  endColumn: position.column
                };
                return {
                  suggestions: [{
                    label: 'TODO:',
                    kind: monaco.languages.CompletionItemKind.Keyword,
                    insertText: 'TODO: ',
                    filterText: 'TODO:',
                    sortText: '0',
                    range,
                    documentation: 'Insert a TODO checklist block'
                  }]
                };
              }
            });
          });

          resolve();
        });
      }
    }, 100);

    setTimeout(() => {
      clearInterval(waitForRequire);
      if (monacoLoaded) return;
      console.error('Monaco loader failed to load within 5 seconds');
      resolve();
    }, 5000);
  });
}

function createMonacoEditorInstance(containerElement) {
  if (monacoEditor) {
    monacoEditor.dispose();
  }

  monacoEditor = monaco.editor.create(containerElement, {
    value: '',
    language: 'plaintext',
    theme: 'vs',
    wordWrap: 'on',
    lineNumbers: 'off',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    fontSize: 13,
    fontFamily: 'Consolas, "Courier New", monospace'
  });

  console.log('Monaco editor instance created');
  return monacoEditor;
}

export async function showFileView(panelId, filePathOverride, viewMode) {
  const filePath = filePathOverride || (panelState[1].currentPath + '\\notes.txt');
  panelState[panelId].fileViewPath = filePath;

  if (filePath) {
    const fname = filePath.split('\\').pop() || filePath.split('/').pop() || '';
    setSelectedItemState({
      path: filePath,
      filename: fname,
      isDirectory: false,
      inode: null,
      dir_id: null,
      record: null
    });
    panels.refreshItemPropertiesInAllPanels();
  }

  const $fileView = $(`#panel-${panelId} .panel-file-view`);
  const $fileEditorContainer = $fileView.find('.file-editor-container');
  const $fileContentView = $fileView.find('.file-content-view');
  const $fileToolbar = $fileView.find('.w2ui-panel-title');

  try {
    const settings = await window.electronAPI.getSettings();
    const fileFormat = resolveViewFormat(filePath, viewMode, settings.file_format);

    createMonacoEditorInstance($fileEditorContainer[0]);
    attachImagePasteHandler(monacoEditor, filePath);

    const content = await window.electronAPI.readFileContent(filePath);

    try {
      const fileRecord = await window.electronAPI.getFileRecordByPath(filePath);
      panelState[panelId].fileViewRecord = fileRecord.success ? fileRecord : null;
    } catch (_) {
      panelState[panelId].fileViewRecord = null;
    }

    if (monacoEditor) {
      monacoEditor.setValue(content);
      const language = getLanguageForFormat(fileFormat);
      monaco.editor.setModelLanguage(monacoEditor.getModel(), language);
    }

    if (fileFormat === 'Markdown') {
      const htmlContent = await window.electronAPI.renderMarkdown(content, filePath);
      $fileContentView.html(htmlContent);
    } else {
      const htmlContent = formatFileContent(content, fileFormat);
      $fileContentView.html(htmlContent);
    }

    $(`#panel-${panelId} .panel-landing-page`).hide();
    $(`#panel-${panelId} .panel-grid`).hide();
    $(`#panel-${panelId} .panel-gallery`).removeClass('active');
    panels.hidePanelToolbar(panelId);
    $fileView.css('display', 'flex');

    $fileContentView.show();
    $fileEditorContainer.hide();

    $fileToolbar.find('.file-path').text(filePath);
    $fileToolbar.show();

    $fileToolbar.find('.btn-file-edit').show().text('Edit').css('background', '#2196F3');
    $fileToolbar.find('.btn-file-save').hide();

    setFileEditMode(false);
  } catch (err) {
    createMonacoEditorInstance($fileEditorContainer[0]);

    if (monacoEditor) {
      monacoEditor.setValue('');
      const settings = await window.electronAPI.getSettings();
      const fileFormat = resolveViewFormat(filePath, viewMode, settings.file_format);
      const language = getLanguageForFormat(fileFormat);
      monaco.editor.setModelLanguage(monacoEditor.getModel(), language);
    }
    $fileContentView.html('');

    $(`#panel-${panelId} .panel-landing-page`).hide();
    $(`#panel-${panelId} .panel-grid`).hide();
    $(`#panel-${panelId} .panel-gallery`).removeClass('active');
    panels.hidePanelToolbar(panelId);
    $fileView.css('display', 'flex');

    $fileEditorContainer.show();
    $fileContentView.hide();

    $fileToolbar.find('.file-path').text(filePath);
    $fileToolbar.show();

    $fileToolbar.find('.btn-file-edit').hide();
    $fileToolbar.find('.btn-file-save').show();

    setFileEditMode(true);
  }

  panels.setActivePanelId(panelId);
}

export function hideFileView(panelId) {
  const $fileView = $(`#panel-${panelId} .panel-file-view`);
  const $fileEditorContainer = $fileView.find('.file-editor-container');
  const $fileContentView = $fileView.find('.file-content-view');
  const $fileToolbar = $fileView.find('.w2ui-panel-title');

  $fileView.hide();
  $fileToolbar.hide();
  $fileEditorContainer.hide();
  $fileContentView.hide();
  $(`#panel-${panelId} .panel-landing-page`).show();

  setFileEditMode(false);
}

/**
 * Show a read-only hex dump of a file in the panel file-view area.
 */
export async function showHexView(panelId, filePath) {
  panelState[panelId].fileViewPath = filePath;

  const $fileView = $(`#panel-${panelId} .panel-file-view`);
  const $fileEditorContainer = $fileView.find('.file-editor-container');
  const $fileContentView = $fileView.find('.file-content-view');
  const $fileToolbar = $fileView.find('.w2ui-panel-title');

  try {
    const result = await window.electronAPI.readFileAsBuffer(filePath);
    const bytes = result && result.bytes ? result.bytes : [];
    const totalSize = result && result.totalSize != null ? result.totalSize : bytes.length;
    const truncated = !!(result && result.truncated);
    $fileContentView.html(formatHexDump(bytes, totalSize, truncated));
  } catch (err) {
    $fileContentView.html(`<pre style="padding:8px;color:#c00;">Error reading file: ${utils.escapeHtml(err.message)}</pre>`);
  }

  $(`#panel-${panelId} .panel-landing-page`).hide();
  $(`#panel-${panelId} .panel-grid`).hide();
  $(`#panel-${panelId} .panel-gallery`).removeClass('active');
  panels.hidePanelToolbar(panelId);
  $fileView.css('display', 'flex');

  $fileContentView.show();
  $fileEditorContainer.hide();

  $fileToolbar.find('.file-path').text(filePath);
  $fileToolbar.show();
  $fileToolbar.find('.btn-file-edit').hide();
  $fileToolbar.find('.btn-file-save').hide();

  panels.setActivePanelId(panelId);
}

export async function toggleFileEditMode(panelId) {
  const $fileView = $(`#panel-${panelId} .panel-file-view`);
  const $fileEditorContainer = $fileView.find('.file-editor-container');
  const $fileContentView = $fileView.find('.file-content-view');
  const $editBtn = $fileView.find('.btn-file-edit');
  const $saveBtn = $fileView.find('.btn-file-save');

  if (!panelState[panelId]) {
    return;
  }

  if ($('#panel-' + panelId + ' .panel-file-view').is(':visible') && $saveBtn.is(':hidden')) {
    $fileContentView.hide();
    $fileEditorContainer.show();
    if (monacoEditor) {
      monacoEditor.focus();
    }
    $editBtn.hide();
    $saveBtn.show();
    setFileEditMode(true);
    return;
  }

  const content = monacoEditor ? monacoEditor.getValue() : '';
  const filePath = panelState[panelId].fileViewPath || (panelState[1].currentPath + '\\notes.txt');

  try {
    await window.electronAPI.writeFileContent(filePath, content);

    const settings = await window.electronAPI.getSettings();
    const fileFormat = settings.file_format || 'Markdown';

    if (fileFormat === 'Markdown') {
      const htmlContent = await window.electronAPI.renderMarkdown(content, filePath);
      $fileContentView.html(htmlContent);
    } else {
      const htmlContent = formatFileContent(content, fileFormat);
      $fileContentView.html(htmlContent);
    }

    $fileEditorContainer.hide();
    $fileContentView.show();

    $editBtn.show().text('Edit').css('background', '#2196F3');
    $saveBtn.hide();
    setFileEditMode(false);

    const fileRecord = panelState[panelId].fileViewRecord;
    if (fileRecord?.enableChecksum && fileRecord.inode && fileRecord.dir_id) {
      try {
        await window.electronAPI.calculateFileChecksum(filePath, fileRecord.inode, fileRecord.dir_id, false);
      } catch (checksumErr) {
        console.warn('Post-save checksum recalculation failed:', checksumErr.message);
      }
    }
  } catch (err) {
    alert('Error saving notes: ' + err.message);
  }
}

export async function openNotesModal(record) {
  const { notesFilePath, sectionKey } = getNotesFileInfo(record);
  const title = record.filenameRaw || record.filename || '';

  let existingContent = '';
  try {
    existingContent = await window.electronAPI.readFileContent(notesFilePath);
  } catch (_e) {
    existingContent = '';
  }

  const sections = await window.electronAPI.invoke('parse-notes-file', existingContent);
  const sectionContent = sections[sectionKey] || '';

  const settings = await window.electronAPI.getSettings();
  notesModalContext = { notesFilePath, sectionKey, title, record };
  notesModalEditMode = false;

  const displayTitle = sectionKey === '__dir__'
    ? `Notes — ${title} (directory)`
    : `Notes — ${title}`;
  $('#notes-modal-title').text(displayTitle);

  const $editorContainer = $('#notes-editor-container');
  $editorContainer.empty();
  if (notesModalEditor) {
    notesModalEditor.dispose();
    notesModalEditor = null;
  }
  notesModalEditor = monaco.editor.create($editorContainer[0], {
    value: sectionContent,
    language: getLanguageForFormat(settings.file_format || 'Markdown'),
    theme: 'vs',
    wordWrap: 'on',
    lineNumbers: 'off',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    fontSize: 13,
    fontFamily: 'Consolas, "Courier New", monospace'
  });
  attachImagePasteHandler(notesModalEditor, notesFilePath);

  const fileFormat = settings.file_format || 'Markdown';
  const $contentView = $('#notes-content-view');
  if (fileFormat === 'Markdown') {
    const htmlContent = await window.electronAPI.renderMarkdown(sectionContent, notesFilePath);
    $contentView.html(htmlContent);
  } else {
    $contentView.html(formatFileContent(sectionContent, fileFormat));
  }

  if (sectionContent.trim() === '') {
    $editorContainer.show();
    $contentView.hide();
    $('#btn-notes-edit').hide();
    $('#btn-notes-save').show();
    notesModalEditMode = true;
    setTimeout(() => notesModalEditor && notesModalEditor.focus(), 100);
  } else {
    $editorContainer.hide();
    $contentView.show();
    $('#btn-notes-edit').show();
    $('#btn-notes-save').hide();
  }

  $('#notes-modal').css('display', 'flex');
}

export async function toggleNotesEditMode() {
  if (!notesModalContext) return;

  const { notesFilePath, sectionKey } = notesModalContext;
  const $editorContainer = $('#notes-editor-container');
  const $contentView = $('#notes-content-view');

  if (!notesModalEditMode) {
    $contentView.hide();
    $editorContainer.show();
    $('#btn-notes-edit').hide();
    $('#btn-notes-save').show();
    notesModalEditMode = true;
    setTimeout(() => notesModalEditor && notesModalEditor.focus(), 50);
    return;
  }

  const newContent = notesModalEditor ? notesModalEditor.getValue() : '';

  let existingContent = '';
  try {
    existingContent = await window.electronAPI.readFileContent(notesFilePath);
  } catch (_e) {
    existingContent = '';
  }

  const updatedContent = await window.electronAPI.invoke('write-notes-section', {
    existingContent,
    sectionKey,
    newContent
  });
  await window.electronAPI.writeFileContent(notesFilePath, updatedContent);
  syncRecordHasNotes(notesModalContext.record, newContent.trim().length > 0);

  const tagMatches = [...newContent.matchAll(/@#(\w+)/g)];
  if (tagMatches.length > 0 && notesModalContext.record) {
    const rec = notesModalContext.record;
    for (const match of tagMatches) {
      window.electronAPI.addTagToItem({
        path: rec.path,
        tagName: match[1],
        isDirectory: rec.isFolder,
        inode: rec.inode,
        dir_id: rec.dir_id
      }).catch(err => console.error('Error auto-tagging from notes:', err));
    }
  }

  const settings = await window.electronAPI.getSettings();
  const fileFormat = settings.file_format || 'Markdown';
  if (fileFormat === 'Markdown') {
    const htmlContent = await window.electronAPI.renderMarkdown(newContent, notesFilePath);
    $contentView.html(htmlContent);
  } else {
    $contentView.html(formatFileContent(newContent, fileFormat));
  }

  $editorContainer.hide();
  $contentView.show();
  $('#btn-notes-save').hide();
  $('#btn-notes-edit').show();
  notesModalEditMode = false;
}

export function hideNotesModal() {
  $('#notes-modal').hide();
  if (notesModalEditor) {
    notesModalEditor.dispose();
    notesModalEditor = null;
  }
  notesModalEditMode = false;
  notesModalContext = null;
  $('#notes-content-view').html('').hide();
  $('#notes-editor-container').hide();
  $('#btn-notes-edit').show();
  $('#btn-notes-save').hide();
}

// ============================================================
// File Viewer Modal (View/Edit for arbitrary text/hex files)
// ============================================================

let fvModalEditor = null;
let fvModalEditMode = false;
let fvModalContext = null; // { filePath, viewMode }

export async function openFileViewerModal(filePath, viewMode) {
  fvModalContext = { filePath, viewMode };
  fvModalEditMode = false;

  const $modal = $('#file-viewer-modal');
  const $editorContainer = $('#fv-editor-container');
  const $contentView = $('#fv-content-view');

  // Title: just the filename
  const filename = filePath.replace(/\\/g, '/').split('/').pop() || filePath;
  $('#file-viewer-modal-title').text(filePath);
  $('#file-viewer-modal-title').attr('title', filePath);

  $editorContainer.empty();
  if (fvModalEditor) { fvModalEditor.dispose(); fvModalEditor = null; }

  const isHex = viewMode === 'hex';
  const isText = !isHex;

  // Hex: no edit buttons
  $('#btn-fv-edit').toggle(isText);
  $('#btn-fv-save').hide();
  $('#btn-fv-switch-view').text(isHex ? 'View Text' : 'View Hex');

  $editorContainer.hide();
  $contentView.empty().hide();

  // Info bar: panel push buttons + encoding/newline badges
  const $panelBtns = $('#fv-panel-btns').empty();
  const maxPanel = Math.min(panels.visiblePanels + 1, 4);
  for (let p = 1; p <= maxPanel; p++) {
    const isNew = p > panels.visiblePanels;
    const label = isNew ? `P${p} (+)` : `P${p}`;
    const title = isNew ? `Open new panel ${p} and show file` : `Open in panel ${p} file view`;
    const $btn = $(`<button style="padding: 2px 8px; background: #fff; border: 1px solid #ccc; border-radius: 3px; cursor: pointer; font-size: 11px; font-weight: 600;" title="${title}">${label}</button>`);
    $btn.click(async () => {
      if (isNew) {
        const $panel = $(`#panel-${p}`);
        panels.setVisiblePanels(p);
        $panel.show();
        panels.attachPanelEventListeners(p);
        panels.updatePanelLayout();
      }
      if (isHex) { await showHexView(p, filePath); }
      else { await showFileView(p, filePath, viewMode); }
    });
    $panelBtns.append($btn);
  }

  if (!isHex) {
    try {
      const encInfo = await window.electronAPI.detectFileEncoding(filePath);
      $('#fv-encoding-badge').text(encInfo.encoding || 'UTF-8').show();
      if (encInfo.newline) {
        $('#fv-newline-badge').text(encInfo.newline).show();
      } else {
        $('#fv-newline-badge').hide();
      }
    } catch (_) {
      $('#fv-encoding-badge').text('?').show();
      $('#fv-newline-badge').hide();
    }
  } else {
    $('#fv-encoding-badge').hide();
    $('#fv-newline-badge').hide();
  }
  $('#fv-info-bar').css('display', 'flex');

  await initializeMonacoLoader();

  if (isHex) {
    try {
      const result = await window.electronAPI.readFileAsBuffer(filePath);
      const bytes = (result && result.bytes) ? result.bytes : [];
      const totalSize = result && result.totalSize != null ? result.totalSize : bytes.length;
      const truncated = !!(result && result.truncated);
      $contentView.html(formatHexDump(bytes, totalSize, truncated));
    } catch (err) {
      $contentView.html(`<pre style="padding:8px;color:#c00;">Error reading file: ${utils.escapeHtml(err.message)}</pre>`);
    }
    $contentView.show();
  } else {
    // Text / Markdown
    const settings = await window.electronAPI.getSettings();
    const fileFormat = resolveViewFormat(filePath, viewMode, settings.file_format);

    let content = '';
    let readError = false;
    try {
      content = await window.electronAPI.readFileContent(filePath);
    } catch (_) {
      readError = true;
    }

    // Build Monaco editor (hidden initially unless file is empty / unreadable)
    fvModalEditor = monaco.editor.create($editorContainer[0], {
      value: content,
      language: getLanguageForFormat(fileFormat),
      theme: 'vs',
      wordWrap: 'on',
      lineNumbers: 'on',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      fontSize: 13,
      fontFamily: 'Consolas, "Courier New", monospace'
    });
    attachImagePasteHandler(fvModalEditor, filePath);

    if (readError || content.trim() === '') {
      // Start in edit mode
      $editorContainer.show();
      $contentView.hide();
      $('#btn-fv-edit').hide();
      $('#btn-fv-save').show();
      fvModalEditMode = true;
      setTimeout(() => fvModalEditor && fvModalEditor.focus(), 100);
    } else {
      // Render content view
      if (fileFormat === 'Markdown') {
        const htmlContent = await window.electronAPI.renderMarkdown(content, filePath);
        $contentView.html(htmlContent);
      } else {
        $contentView.html(formatFileContent(content, fileFormat));
      }
      $editorContainer.hide();
      $contentView.show();
      $('#btn-fv-edit').show();
      $('#btn-fv-save').hide();
    }
  }

  $modal.css('display', 'flex');
}

export async function toggleFileViewerEditMode() {
  if (!fvModalContext) return;
  const { filePath, viewMode } = fvModalContext;
  const $editorContainer = $('#fv-editor-container');
  const $contentView = $('#fv-content-view');

  if (!fvModalEditMode) {
    // Switch to edit
    $contentView.hide();
    $editorContainer.show();
    $('#btn-fv-edit').hide();
    $('#btn-fv-save').show();
    fvModalEditMode = true;
    setTimeout(() => fvModalEditor && fvModalEditor.focus(), 50);
    return;
  }

  // Save
  const newContent = fvModalEditor ? fvModalEditor.getValue() : '';
  try {
    await window.electronAPI.writeFileContent(filePath, newContent);
  } catch (err) {
    alert('Error saving file: ' + err.message);
    return;
  }

  const settings = await window.electronAPI.getSettings();
  const fileFormat = resolveViewFormat(filePath, viewMode, settings.file_format);
  if (fileFormat === 'Markdown') {
    const htmlContent = await window.electronAPI.renderMarkdown(newContent, filePath);
    $contentView.html(htmlContent);
  } else {
    $contentView.html(formatFileContent(newContent, fileFormat));
  }

  $editorContainer.hide();
  $contentView.show();
  $('#btn-fv-save').hide();
  $('#btn-fv-edit').show();
  fvModalEditMode = false;
}

export async function switchFileViewerView() {
  if (!fvModalContext) return;
  const { filePath, viewMode } = fvModalContext;
  const isHex = viewMode === 'hex';
  await openFileViewerModal(filePath, isHex ? 'text-plain' : 'hex');
}

export function hideFileViewerModal() {
  $('#file-viewer-modal').hide();
  $('#fv-info-bar').hide();
  $('#fv-panel-btns').empty();
  if (fvModalEditor) { fvModalEditor.dispose(); fvModalEditor = null; }
  fvModalEditMode = false;
  fvModalContext = null;
  $('#fv-content-view').empty().hide();
  $('#fv-editor-container').empty().hide();
  $('#btn-fv-edit').show();
  $('#btn-fv-save').hide();
}

