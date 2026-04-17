const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const notesParser = require('./notesParser');
const logger = require('./logger');

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function flattenBlocksToItems(sections) {
  const items = [];
  for (const [sectionKey, sectionContent] of Object.entries(sections)) {
    if (!sectionContent) continue;
    const blocks = notesParser.parseTodoBlocks(sectionContent);
    blocks.forEach((block, groupIndex) => {
      block.items.forEach((item, itemIndex) => {
        items.push({
          section_key: sectionKey,
          group_label: block.label || '',
          group_index: groupIndex,
          item_index: itemIndex,
          level: item.level || 0,
          text: item.text,
          completed: !!item.completed,
          line_start: item.lineStart ?? null,
          text_hash: sha1(item.text)
        });
      });
    });
  }
  return items;
}

/**
 * Refresh aggregates for a single notes.txt. Creates or updates the
 * todo_notes_files row and replaces its todo_items rows.
 * If the file does not exist on disk, deletes any row keyed to that path.
 *
 * @param {string} notesPath  absolute path to notes.txt
 * @param {number} dirId      foreign key to dirs.id (owner directory)
 * @param {object} [opts]
 * @param {string} [opts.contentOverride] content already in memory
 * @returns {{ changed: boolean, notesFileId: number|null }}
 */
function ensureAndRefresh(notesPath, dirId, opts = {}) {
  try {
    if (!fs.existsSync(notesPath)) {
      const existing = db.getTodoNotesFile(notesPath);
      if (existing) {
        db.deleteTodoNotesFileByPath(notesPath);
        return { changed: true, notesFileId: null };
      }
      return { changed: false, notesFileId: null };
    }

    let content = opts.contentOverride;
    let mtimeMs;
    if (content == null) {
      const stat = fs.statSync(notesPath);
      mtimeMs = Math.floor(stat.mtimeMs);
      content = fs.readFileSync(notesPath, 'utf-8');
    } else {
      try {
        mtimeMs = Math.floor(fs.statSync(notesPath).mtimeMs);
      } catch {
        mtimeMs = Date.now();
      }
    }

    const contentHash = sha1(content);
    const existing = db.getTodoNotesFile(notesPath);
    if (existing && existing.content_hash === contentHash && existing.dir_id === dirId) {
      return { changed: false, notesFileId: existing.id };
    }

    const notesFileId = db.upsertTodoNotesFile(notesPath, dirId, mtimeMs, contentHash);
    const sections = notesParser.parseNotesFileSections(content);
    const items = flattenBlocksToItems(sections);
    db.replaceTodoItems(notesFileId, items);
    return { changed: true, notesFileId };
  } catch (err) {
    logger.warn(`todoAggregator: failed to refresh ${notesPath}: ${err.message}`);
    return { changed: false, notesFileId: null };
  }
}

/**
 * Refresh every notes.txt that currently has a row in todo_notes_files.
 * Does not discover new files — new rows are created by ensureAndRefresh
 * from directory-scan sites.
 */
function refreshAll() {
  const rows = db.getAllTodoNotesFiles();
  let changedCount = 0;
  for (const row of rows) {
    const res = ensureAndRefresh(row.notes_path, row.dir_id);
    if (res.changed) changedCount += 1;
  }
  return { total: rows.length, changed: changedCount };
}

/**
 * Shape aggregated items into the nested structure the sidebar expects:
 *   [ { groupLabel, sources: [ { notesPath, dirId, sectionKey, sourceDisplayName, items: [...] } ] } ]
 *
 * @param {object} [opts]
 * @param {boolean} [opts.includeCompleted=true]
 */
function getAggregates(opts = {}) {
  const includeCompleted = opts.includeCompleted !== false;
  const rows = db.getTodoAggregates({ includeCompleted });

  const groupMap = new Map();
  for (const row of rows) {
    const groupKey = row.group_label || '';
    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, { groupLabel: groupKey, sources: new Map() });
    }
    const group = groupMap.get(groupKey);
    const sourceKey = `${row.notes_path}::${row.section_key}`;
    if (!group.sources.has(sourceKey)) {
      const dirname = row.dirname || path.dirname(row.notes_path);
      const displayName = row.section_key === '__dir__'
        ? `${path.basename(dirname) || dirname}/`
        : row.section_key;
      group.sources.set(sourceKey, {
        notesPath: row.notes_path,
        dirId: row.dir_id,
        sectionKey: row.section_key,
        sourceDisplayName: displayName,
        items: []
      });
    }
    group.sources.get(sourceKey).items.push({
      id: row.id,
      text: row.text,
      completed: !!row.completed,
      level: row.level,
      lineStart: row.line_start,
      groupIndex: row.group_index,
      itemIndex: row.item_index,
      textHash: row.text_hash
    });
  }

  return Array.from(groupMap.values()).map(g => ({
    groupLabel: g.groupLabel,
    sources: Array.from(g.sources.values())
  }));
}

module.exports = {
  ensureAndRefresh,
  refreshAll,
  getAggregates
};
