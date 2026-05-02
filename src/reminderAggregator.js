const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const db     = require('./db');
const notesParser = require('./notesParser');
const logger = require('./logger');

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

// In-memory cache: notesFileId → last content hash successfully written.
// Avoids redundant DB DELETE+INSERT when the file hasn't changed between scans.
const _lastHash = new Map();

/**
 * Flatten all reminder items from parsed notes sections into a flat array
 * suitable for DB insertion.
 *
 * Collects:
 *   - Standalone REMINDER blocks (from parseReminderBlocks)
 *   - Cohabitated REMINDERs embedded in TODO items (from parseTodoBlocksWithReminders)
 *
 * @param {object} sections  Map of sectionKey → sectionContent
 * @returns {Array}
 */
function flattenRemindersToItems(sections) {
  const items = [];

  for (const [sectionKey, sectionContent] of Object.entries(sections)) {
    if (!sectionContent) continue;

    // --- Standalone reminders ---
    const standaloneReminders = notesParser.parseReminderBlocks(sectionContent);
    for (const reminder of standaloneReminders) {
      items.push({
        section_key:      sectionKey,
        due_datetime:     reminder.parsedDate || null,
        text:             reminder.text,
        line_start:       reminder.lineStart,
        text_hash:        sha1(reminder.text + (reminder.parsedDate || '')),
        is_cohabitated:   false,
        linked_todo_line: null
      });
    }

    // --- Cohabitated reminders (embedded inside TODO blocks) ---
    const todoBlocks = notesParser.parseTodoBlocksWithReminders(sectionContent);
    for (const block of todoBlocks) {
      for (const item of block.items) {
        if (item.cohabitatingReminder) {
          const rem = item.cohabitatingReminder;
          items.push({
            section_key:      sectionKey,
            due_datetime:     rem.parsedDate || null,
            text:             rem.text,
            line_start:       rem.lineStart,
            text_hash:        sha1(rem.text + (rem.parsedDate || '')),
            is_cohabitated:   true,
            linked_todo_line: item.lineStart
          });
        }
      }
    }
  }

  return items;
}

/**
 * Refresh reminder aggregates for a single notes.txt.
 * Reuses the todo_notes_files row (the file registry is shared).
 *
 * @param {string} notesPath
 * @param {number} dirId
 * @param {object} [opts]
 * @param {string} [opts.contentOverride]
 * @returns {{ changed: boolean, notesFileId: number|null }}
 */
function ensureAndRefresh(notesPath, dirId, opts = {}) {
  try {
    if (!fs.existsSync(notesPath)) {
      return { changed: false, notesFileId: null };
    }

    let content = opts.contentOverride;
    if (content == null) {
      content = fs.readFileSync(notesPath, 'utf-8');
    }

    const contentHash = sha1(content);
    const existing    = db.getTodoNotesFile(notesPath);

    // Use the same notes_file_id that the todo aggregator uses so we share the registry.
    // We still refresh reminders even if the todo hash hasn't changed, because the
    // reminder aggregator maintains its own items separately.
    // Use a secondary hash stored on the reminder side: we'll just always refresh if
    // notes_file_id exists (the cost is minimal – it's a small replace transaction).
    if (!existing) {
      // The notes file hasn't been registered by the todo aggregator yet; skip for now.
      // The todo aggregator's ensureAndRefresh will upsert the row; the next call here
      // (e.g. from the notes-save path) will find it.
      return { changed: false, notesFileId: null };
    }

    const notesFileId = existing.id;

    // Skip expensive replace if nothing has changed since last refresh.
    if (_lastHash.get(notesFileId) === contentHash) {
      return { changed: false, notesFileId };
    }

    const sections = notesParser.parseNotesFileSections(content);
    const items    = flattenRemindersToItems(sections);
    db.replaceReminderItems(notesFileId, items);
    _lastHash.set(notesFileId, contentHash);
    return { changed: true, notesFileId };

  } catch (err) {
    logger.warn(`reminderAggregator: failed to refresh ${notesPath}: ${err.message}`);
    return { changed: false, notesFileId: null };
  }
}

/**
 * Refresh every notes.txt currently registered in todo_notes_files.
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

// ---------------------------------------------------------------------------
// Time-bucket helpers
// ---------------------------------------------------------------------------

/**
 * Return the calendar-week Monday (00:00 local) for a given Date.
 */
function weekMonday(d) {
  const m = new Date(d);
  const day = m.getDay(); // 0=Sun
  const diff = (day === 0) ? -6 : 1 - day; // shift to Monday
  m.setDate(m.getDate() + diff);
  m.setHours(0, 0, 0, 0);
  return m;
}

/**
 * Return the calendar-week Sunday (23:59:59.999 local) for a given Date.
 */
function weekSunday(d) {
  const monday = weekMonday(d);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return sunday;
}

/**
 * Assign a bucket label to a due_datetime string (or null for No Date).
 *
 * Buckets (in display order):
 *   No Date, Past Due, Today, Tomorrow, This Week, Next Week, Later
 */
function getBucket(dueDatetime) {
  const BUCKET_ORDER = [
    'No Date', 'Past Due', 'Today', 'Tomorrow', 'This Week', 'Next Week', 'Later'
  ];

  if (!dueDatetime) return 'No Date';

  const due  = new Date(dueDatetime.replace(' ', 'T')); // "YYYY-MM-DD HH:MM" → ISO
  const now  = new Date();

  // Today boundaries
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const todayEnd   = new Date(now); todayEnd.setHours(23, 59, 59, 999);

  // Tomorrow boundaries
  const tomorrowStart = new Date(todayStart); tomorrowStart.setDate(todayStart.getDate() + 1);
  const tomorrowEnd   = new Date(todayEnd);   tomorrowEnd.setDate(todayEnd.getDate() + 1);

  // This week (Mon–Sun of current week, excluding today + tomorrow if already captured above)
  const thisWeekMonday = weekMonday(now);
  const thisWeekSunday = weekSunday(now);

  // Next week
  const nextWeekMonday = new Date(thisWeekMonday); nextWeekMonday.setDate(thisWeekMonday.getDate() + 7);
  const nextWeekSunday = weekSunday(nextWeekMonday);

  if (due < todayStart)       return 'Past Due';
  if (due <= todayEnd)        return 'Today';
  if (due <= tomorrowEnd)     return 'Tomorrow';
  if (due <= thisWeekSunday)  return 'This Week';
  if (due <= nextWeekSunday)  return 'Next Week';
  return 'Later';
}

const BUCKET_ORDER = ['No Date', 'Past Due', 'Today', 'Tomorrow', 'This Week', 'Next Week', 'Later'];

/**
 * Return aggregated reminders grouped into time buckets.
 *
 * Return shape:
 *   [{
 *     bucketLabel: string,
 *     count: number,
 *     items: [{
 *       id, text, due_datetime, notesPath, dirId, sectionKey,
 *       isCohabitated, linkedTodoLine, lineStart, dirName
 *     }]
 *   }]
 *
 * Items within each bucket are sorted most-imminent first (ascending due_datetime).
 * No Date items are sorted by line_start ascending.
 */
function getAggregates() {
  const rows = db.getReminderAggregates();

  const bucketMap = new Map();
  for (const label of BUCKET_ORDER) {
    bucketMap.set(label, { bucketLabel: label, count: 0, items: [] });
  }

  for (const row of rows) {
    const label  = getBucket(row.due_datetime);
    const bucket = bucketMap.get(label);
    if (!bucket) continue;

    bucket.items.push({
      id:              row.id,
      text:            row.text,
      due_datetime:    row.due_datetime || null,
      notesPath:       row.notes_path,
      dirId:           row.dir_id,
      sectionKey:      row.section_key,
      isCohabitated:   !!row.is_cohabitated,
      linkedTodoLine:  row.linked_todo_line ?? null,
      lineStart:       row.line_start,
      dirName:         row.dirname || path.dirname(row.notes_path)
    });
    bucket.count += 1;
  }

  // Sort items within each bucket
  for (const bucket of bucketMap.values()) {
    bucket.items.sort((a, b) => {
      if (a.due_datetime && b.due_datetime) {
        return a.due_datetime.localeCompare(b.due_datetime);
      }
      if (!a.due_datetime && !b.due_datetime) {
        return (a.lineStart ?? 0) - (b.lineStart ?? 0);
      }
      return a.due_datetime ? -1 : 1;
    });
  }

  // Return only buckets that have items
  return Array.from(bucketMap.values()).filter(b => b.count > 0);
}

module.exports = {
  flattenRemindersToItems,
  ensureAndRefresh,
  refreshAll,
  getAggregates,
  getBucket
};
