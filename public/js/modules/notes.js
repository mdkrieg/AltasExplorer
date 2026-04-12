/**
 * Notes module.
 * Owns notes modal behavior, panel file-view editing, and shared Monaco loader state.
 */

import * as utils from './utils.js';
import * as panels from './panels.js';
import { panelState, setFileEditMode, setSelectedItemState } from '../renderer.js';

let monacoLoaded = false;
export let monacoEditor = null;

let notesModalEditor = null;
let notesModalEditMode = false;
let notesModalContext = null;

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

export async function showFileView(panelId, filePathOverride) {
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
    const fileFormat = settings.file_format || 'Markdown';

    createMonacoEditorInstance($fileEditorContainer[0]);

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
      const htmlContent = await window.electronAPI.renderMarkdown(content);
      $fileContentView.html(htmlContent);
    } else {
      const htmlContent = formatFileContent(content, fileFormat);
      $fileContentView.html(htmlContent);
    }

    $(`#panel-${panelId} .panel-landing-page`).hide();
    $(`#panel-${panelId} .panel-grid`).hide();
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
      const fileFormat = settings.file_format || 'Markdown';
      const language = getLanguageForFormat(fileFormat);
      monaco.editor.setModelLanguage(monacoEditor.getModel(), language);
    }
    $fileContentView.html('');

    $(`#panel-${panelId} .panel-landing-page`).hide();
    $(`#panel-${panelId} .panel-grid`).hide();
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
      const htmlContent = await window.electronAPI.renderMarkdown(content);
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

  const fileFormat = settings.file_format || 'Markdown';
  const $contentView = $('#notes-content-view');
  if (fileFormat === 'Markdown') {
    const htmlContent = await window.electronAPI.renderMarkdown(sectionContent);
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
    const htmlContent = await window.electronAPI.renderMarkdown(newContent);
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
