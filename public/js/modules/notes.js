/**
 * Notes module.
 * Owns notes modal behavior, panel file-view editing, and shared Monaco loader state.
 *
 * Originally scoped to notes.txt files; has grown into the generic file editor
 * shared with the panel file-view. The module name no longer fully fits — a
 * rename or split-out of the generic file-editor functionality is on the table
 * if/when it makes sense.
 *
 * notes.txt itself stays as a flat file (not in SQLite) because users must be
 * able to read and edit it on a phone, a thumbdrive, or any other device
 * without Atlas Explorer installed. See docs/architecture.md.
 */

import * as utils from './utils.js';
import * as panels from './panels.js';
import { w2popup, w2confirm } from './vendor/w2ui.es6.min.js';
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
let fvModalHost = null; // 'modal' | 1 | 2 | 3 | 4
let fvModalOriginalContent = ''; // content as loaded from disk; used for cancel dirty-check

export function getFileViewerHost() { return fvModalHost; }

async function moveFileViewerToPanel(targetPanelId) {
  if (targetPanelId > panels.visiblePanels) {
    const $newPanel = $(`#panel-${targetPanelId}`);
    panels.setVisiblePanels(targetPanelId);
    $newPanel.show();
    panels.attachPanelEventListeners(targetPanelId);
    panels.updatePanelLayout();
  }

  // Adopt widget into target panel BEFORE closing popup (prevents widget being destroyed)
  const $content = $(`#panel-${targetPanelId} .panel-content`);
  $content.find('.panel-landing-page, .panel-grid, .panel-gallery, .panel-file-view, .panel-terminal-view').hide();
  $content.append($('#fv-widget'));

  // Apply panel-fill styles
  $('#fv-widget').css({ width: '100%', height: '100%', flex: '1' });

  // Close the popup now that widget is safely outside it
  if ($('#w2ui-popup').length > 0 && w2popup.status !== 'closing') w2popup.close();

  // Panel-embedded: hide modal-only controls, make path label static
  $('#btn-fv-close').hide();
  $('#fv-panel-section').hide();
  $('#fv-path-display').css('cursor', 'default');

  // Adopt the category of the file's parent directory so the panel header uses its colour
  const filePath = fvModalContext.filePath;
  const parentDir = filePath.includes('\\')
    ? filePath.substring(0, filePath.lastIndexOf('\\'))
    : filePath;
  const parentCategory = await window.electronAPI.getCategoryForDirectory(parentDir);
  if (panelState[targetPanelId]) panelState[targetPanelId].currentCategory = parentCategory;

  // Update the panel's own path bar to show the hosted file path
  panels.updatePanelHeader(targetPanelId, filePath);

  // Re-layout Monaco after DOM move
  setTimeout(() => fvModalEditor && fvModalEditor.layout(), 50);

  fvModalHost = targetPanelId;
  panels.setActivePanelId(targetPanelId);
}

export async function openFileViewerModal(filePath, viewMode) {
  const wasInPanel = typeof fvModalHost === 'number';
  const alreadyModal = fvModalHost === 'modal';

  // If widget is currently embedded in a panel, restore that panel and move widget to storage
  if (wasInPanel) {
    const prevHost = fvModalHost;
    const $prevContent = $(`#panel-${prevHost} .panel-content`);
    $('#fv-widget-store').append($('#fv-widget'));
    if (panelState[prevHost]?.currentPath) {
      $prevContent.find('.panel-grid').show();
      panels.updatePanelHeader(prevHost); // restore header to previous directory path
    } else {
      $prevContent.find('.panel-landing-page').css('display', 'flex');
      panels.updatePanelHeader(prevHost, '');
    }
  }
  fvModalHost = 'modal';

  // Restore modal-only controls
  $('#btn-fv-close').show();
  $('#fv-panel-section').css('display', 'flex');
  $('#fv-path-display').css('cursor', 'pointer');

  fvModalContext = { filePath, viewMode };
  fvModalEditMode = false;

  const $editorContainer = $('#fv-editor-container');
  const $contentView = $('#fv-content-view');

  // Title: filename in display span, full path in input
  const filename = filePath.replace(/\\/g, '/').split('/').pop() || filePath;
  $('#fv-path-display').text(filename).attr('title', filePath);
  $('#fv-path-input').val(filePath);
  panelState[0].currentPath = filePath;

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
      await moveFileViewerToPanel(p);
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
      fvModalOriginalContent = content;
    } catch (_) {
      readError = true;
      fvModalOriginalContent = '';
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
      $('#btn-fv-cancel').show();
      fvModalEditMode = true;
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

  // Open w2popup if not already showing (first open, or returning from panel mode)
  if (!alreadyModal) {
    const pw = Math.min(Math.round(window.innerWidth * 0.85), 1100);
    const ph = Math.round(window.innerHeight * 0.82);
    w2popup.open({
      title: '',
      body: '',
      style: 'padding: 0; overflow: hidden; height: 100%;',
      width: pw,
      height: ph,
      showClose: false,
      keyboard: false,
      modal: true
    });
    // DOM is available synchronously; inject widget so content is visible during open animation
    $('#w2ui-popup .w2ui-popup-body').append($('#fv-widget'));
    // Ensure widget fills the popup body
    $('#fv-widget').css({ width: '100%', height: '100%', flex: '' });
  }
}

export async function cancelFileViewerEdit() {
  if (!fvModalContext || !fvModalEditMode) return;
  const { filePath, viewMode } = fvModalContext;
  const currentContent = fvModalEditor ? fvModalEditor.getValue() : '';
  const isDirty = currentContent !== fvModalOriginalContent;

  function doCancel() {
    const $editorContainer = $('#fv-editor-container');
    const $contentView = $('#fv-content-view');
    const settings = window.electronAPI.getSettings();
    settings.then(async (s) => {
      const fileFormat = resolveViewFormat(filePath, viewMode, s.file_format);
      if (fileFormat === 'Markdown') {
        const htmlContent = await window.electronAPI.renderMarkdown(fvModalOriginalContent, filePath);
        $contentView.html(htmlContent);
      } else {
        $contentView.html(formatFileContent(fvModalOriginalContent, fileFormat));
      }
      if (fvModalEditor) fvModalEditor.setValue(fvModalOriginalContent);
      $editorContainer.hide();
      $contentView.show();
      $('#btn-fv-save').hide();
      $('#btn-fv-cancel').hide();
      $('#btn-fv-edit').show();
      fvModalEditMode = false;
    });
  }

  if (isDirty) {
    w2confirm({
      msg: 'You have unsaved changes.<br><br>Click "Abandon" to discard them, or "Keep Editing" to go back.',
      title: 'Abandon Changes?',
      width: 420,
      height: 190,
      btn_yes: { text: 'Abandon', class: '', style: '' },
      btn_no: { text: 'Keep Editing', class: '', style: '' }
    }).yes(() => doCancel());
  } else {
    doCancel();
  }
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
    $('#btn-fv-cancel').show();
    fvModalEditMode = true;
    setTimeout(() => fvModalEditor && fvModalEditor.focus(), 50);
    return;
  }

  // Save
  const newContent = fvModalEditor ? fvModalEditor.getValue() : '';
  try {
    await window.electronAPI.writeFileContent(filePath, newContent);
    fvModalOriginalContent = newContent; // baseline updated after successful save
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
  $('#btn-fv-cancel').hide();
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
  const host = fvModalHost;
  const $widget = $('#fv-widget');
  if (typeof host === 'number') {
    // Panel mode: restore the panel's content view
    const $content = $(`#panel-${host} .panel-content`);
    if (panelState[host]?.currentPath) {
      $content.find('.panel-grid').show();
    } else {
      $content.find('.panel-landing-page').css('display', 'flex');
    }
  }

  // Return widget to storage BEFORE closing popup so it isn't destroyed with the popup DOM
  $('#fv-widget-store').append($widget);

  // Close popup if open
  if ($('#w2ui-popup').length > 0 && w2popup.status !== 'closing') {
    w2popup.close();
  }

  // Clean up widget state
  if (fvModalEditor) { fvModalEditor.dispose(); fvModalEditor = null; }
  fvModalEditMode = false;
  fvModalContext = null;
  fvModalHost = null;
  $('#fv-content-view').empty().hide();
  $('#fv-editor-container').empty().hide();
  $('#btn-fv-edit').show();
  $('#btn-fv-save').hide();
  $('#btn-fv-cancel').hide();
  $('#fv-info-bar').hide();
  $('#fv-panel-btns').empty();
}

/**
 * Wire up click-to-edit behaviour for the file viewer modal path bar.
 * Call once from renderer.js initialize().
 */
export function initFvPathInput() {
  const $display = $('#fv-path-display');
  const $input = $('#fv-path-input');

  $display.on('click', function () {
    // In panel-embedded mode the panel title bar handles navigation; don't open inline editor
    if (typeof fvModalHost === 'number') return;
    $display.hide();
    $input.show().select().focus();
  });

  async function submitPathInput() {
    const raw = $input.val().trim();
    $input.hide();
    $display.show();
    if (!raw || raw === fvModalContext?.filePath) return;

    // Parse #fragment then ?params (mirrors parseNavUri in panels.js)
    let fragment = null;
    let withoutHash = raw;
    const hashIdx = raw.indexOf('#');
    if (hashIdx !== -1) {
      fragment = raw.slice(hashIdx + 1).trim().toLowerCase() || null;
      withoutHash = raw.slice(0, hashIdx);
    }
    const qIdx = withoutHash.indexOf('?');
    const basePath = qIdx === -1 ? withoutHash : withoutHash.slice(0, qIdx);
    const viewMode = (qIdx !== -1 && withoutHash.slice(qIdx + 1).split('&').includes('hexview'))
      ? 'hex' : 'auto';

    await openFileViewerModal(basePath, viewMode);
    if (fragment === 'edit' && viewMode !== 'hex') {
      await toggleFileViewerEditMode();
    }
  }

  $input.on('keydown', async function (e) {
    if (e.key === 'Escape') {
      $input.val(fvModalContext?.filePath || '').hide();
      $display.show();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      await submitPathInput();
    }
  });

  $input.on('blur', async function () {
    await submitPathInput();
  });
}

/**
 * Open the notes viewer for a file path in a panel.
 * Reads the directory's notes.txt and shows the section for the given file.
 * @param {string} filePath  - Absolute path to the file
 * @param {number} panelId   - Panel to show the notes viewer in
 * @param {boolean} editMode - Whether to open in edit mode immediately
 */
export async function openNotesViewerForPath(filePath, panelId, editMode = false) {
  await initializeMonacoLoader();

  const normalizedPath = filePath.replace(/\\/g, '/');
  const lastSlash = Math.max(normalizedPath.lastIndexOf('/'), normalizedPath.lastIndexOf('\\'));
  const parentDir = lastSlash > 0 ? filePath.slice(0, lastSlash) : filePath;
  const fname = lastSlash > 0 ? filePath.slice(lastSlash + 1) : filePath;
  const sep = filePath.includes('\\') || (filePath[1] === ':') ? '\\' : '/';
  const notesPath = parentDir + sep + 'notes.txt';

  // Read notes.txt content
  let existingContent = '';
  try {
    existingContent = await window.electronAPI.readFileContent(notesPath);
  } catch (_) {
    // notes.txt may not exist yet — treat as empty
  }

  // Parse sections and extract the one for this file
  let sectionContent = '';
  try {
    const sections = await window.electronAPI.invoke('parse-notes-file', existingContent);
    sectionContent = (sections && sections[fname]) ? sections[fname] : '';
  } catch (_) {
    sectionContent = '';
  }

  const $panel = $(`#panel-${panelId}`);
  const $fileView = $panel.find('.panel-file-view');
  const $fileEditorContainer = $fileView.find('.file-editor-container');
  const $fileContentView = $fileView.find('.file-content-view');
  const $fileToolbar = $fileView.find('.w2ui-panel-title');

  // Hide other views, show file view
  $panel.find('.panel-landing-page').hide();
  $panel.find('.panel-grid').hide();
  $panel.find('.panel-gallery').removeClass('active');
  panels.hidePanelToolbar(panelId);
  $fileView.css('display', 'flex');

  // Set up path label
  $fileToolbar.find('.file-path').text('Notes: ' + fname);
  $fileToolbar.show();

  // Create a Monaco editor instance for this panel's file view
  if (!$fileEditorContainer.data('monaco-editor')) {
    const editor = monaco.editor.create($fileEditorContainer[0], {
      value: sectionContent,
      language: 'markdown',
      theme: 'vs',
      wordWrap: 'on',
      lineNumbers: 'on',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      fontSize: 13,
      fontFamily: 'Consolas, "Courier New", monospace'
    });
    $fileEditorContainer.data('monaco-editor', editor);
  } else {
    const editor = $fileEditorContainer.data('monaco-editor');
    editor.setValue(sectionContent);
  }

  // Wire Save button (re-attach each time to capture current fname/notesPath)
  const $saveBtn = $fileToolbar.find('.btn-file-save');
  const $editBtn = $fileToolbar.find('.btn-file-edit');
  $saveBtn.off('click.notesViewer').on('click.notesViewer', async function () {
    const editor = $fileEditorContainer.data('monaco-editor');
    const newContent = editor ? editor.getValue() : '';
    let latestContent = '';
    try { latestContent = await window.electronAPI.readFileContent(notesPath); } catch (_) {}
    const updated = await window.electronAPI.invoke('write-notes-section',
      { existingContent: latestContent, sectionKey: fname, newContent });
    try { await window.electronAPI.writeFileContent(notesPath, updated); } catch (err) {
      alert('Error saving notes: ' + err.message);
    }
    // Switch back to view mode
    $fileEditorContainer.hide();
    $fileContentView.html(utils.escapeHtml(newContent).replace(/\n/g, '<br>')).show();
    $editBtn.show();
    $saveBtn.hide();
  });
  $editBtn.off('click.notesViewer').on('click.notesViewer', function () {
    $fileContentView.hide();
    $fileEditorContainer.show();
    $editBtn.hide();
    $saveBtn.show();
    const editor = $fileEditorContainer.data('monaco-editor');
    if (editor) editor.focus();
  });

  if (editMode || sectionContent.trim() === '') {
    $fileContentView.hide();
    $fileEditorContainer.show();
    $editBtn.hide();
    $saveBtn.show();
    const editor = $fileEditorContainer.data('monaco-editor');
    if (editor) setTimeout(() => editor.focus(), 100);
  } else {
    $fileContentView.html(utils.escapeHtml(sectionContent).replace(/\n/g, '<br>')).show();
    $fileEditorContainer.hide();
    $editBtn.show();
    $saveBtn.hide();
  }

  panels.setActivePanelId(panelId);
}

