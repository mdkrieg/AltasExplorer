/**
 * Notes Parser Utility Module
 *
 * Core abstraction for parsing and manipulating notes.txt files.
 * Handles file header format: @<filename>
 *
 * File Structure:
 * - Text before first @<filename> header → directory-level notes ('__dir__' key)
 * - Text after each @<filename> header → file-specific notes (filename as key)
 * - Each @<filename> must be on its own line and closed with > on the same line
 */

/**
 * Check if a line is a valid file header in the format @<filename>
 * @param {string} line - The line to check
 * @returns {boolean} True if line is a valid file header
 */
function isValidFileHeader(line) {
  return /^@<(.+)>$/.test(line);
}

/**
 * Extract the filename from a valid file header line
 * @param {string} line - A valid file header line (e.g., "@<config.json>")
 * @returns {string|null} The filename, or null if not a valid header
 */
function extractHeaderFilename(line) {
  const match = line.match(/^@<(.+)>$/);
  return match ? match[1] : null;
}

/**
 * Parse a notes.txt file into keyed sections.
 * Lines before the first @<filename> header go into '__dir__'.
 * Each subsequent section is keyed by filename.
 *
 * @param {string} content - Full contents of notes.txt
 * @returns {Object} Map of sectionKey -> content string
 */
function parseNotesFileSections(content) {
  const sections = {};
  let currentKey = '__dir__';
  sections[currentKey] = '';

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (isValidFileHeader(line)) {
      const filename = extractHeaderFilename(line);
      currentKey = filename;
      if (!(currentKey in sections)) {
        sections[currentKey] = '';
      }
    } else {
      sections[currentKey] = (sections[currentKey] || '') + line + '\n';
    }
  }

  // Trim single trailing newline added by the accumulation above
  for (const key of Object.keys(sections)) {
    if (sections[key].endsWith('\n')) {
      sections[key] = sections[key].slice(0, -1);
    }
  }

  return sections;
}

/**
 * Serialize a notes sections object back to a full notes.txt string,
 * replacing the entry for sectionKey with newContent.
 *
 * @param {string} existingContent - Current notes.txt content (may be empty)
 * @param {string} sectionKey      - '__dir__' for directory, or a filename string
 * @param {string} newContent      - The new content to write for this section
 * @returns {string} Updated full notes.txt content
 */
function writeNotesSection(existingContent, sectionKey, newContent) {
  const sections = parseNotesFileSections(existingContent);

  // Collect file section keys in original order
  const fileKeys = Object.keys(sections).filter(k => k !== '__dir__');

  // Update the target section
  sections[sectionKey] = newContent;
  // If it's a new file key not yet in the list, append it
  if (sectionKey !== '__dir__' && !fileKeys.includes(sectionKey)) {
    fileKeys.push(sectionKey);
  }

  // Re-serialize: directory block first, then file sections
  let result = sections['__dir__'] || '';

  for (const key of fileKeys) {
    const val = sections[key] || '';
    // Write the section if it has content (or it's the key we just wrote)
    if (val.trim() !== '' || key === sectionKey) {
      if (result.length > 0 && !result.endsWith('\n\n')) {
        if (!result.endsWith('\n')) result += '\n';
        result += '\n';
      }
      result += `@<${key}>\n${val}`;
    }
  }

  return result;
}

/**
 * Extract all file headers from notes.txt content.
 * Returns array of all filenames that have file header sections (excludes '__dir__').
 *
 * @param {string} content - Full contents of notes.txt
 * @returns {Array<string>} Array of filenames with headers
 */
function extractAllHeaders(content) {
  const sections = parseNotesFileSections(content);
  return Object.keys(sections).filter(k => k !== '__dir__');
}

/**
 * Extract directory-level notes from notes.txt content.
 * These are the notes that appear before any @<filename> headers.
 *
 * @param {string} content - Full contents of notes.txt
 * @returns {string} Directory-level notes, or empty string if none
 */
function extractDirectoryNotes(content) {
  const sections = parseNotesFileSections(content);
  return sections['__dir__'] || '';
}

/**
 * Extract file-specific notes from notes.txt content.
 *
 * @param {string} content - Full contents of notes.txt
 * @param {string} filename - The filename to extract notes for
 * @returns {string} Notes for the file, or empty string if not found
 */
function extractFileNotes(content, filename) {
  const sections = parseNotesFileSections(content);
  return sections[filename] || '';
}

/**
 * Get all sections from notes.txt content with metadata.
 * Useful for debugging or analyzing file structure.
 *
 * @param {string} content - Full contents of notes.txt
 * @returns {Array<{key: string, isDirectoryNotes: boolean, contentLength: number}>}
 */
function getAllSectionsInfo(content) {
  const sections = parseNotesFileSections(content);
  return Object.keys(sections).map(key => ({
    key,
    isDirectoryNotes: key === '__dir__',
    contentLength: sections[key].length,
    isEmpty: sections[key].trim().length === 0
  }));
}

// ---------------------------------------------------------------------------
// TODO block parsing & manipulation
// ---------------------------------------------------------------------------

const _TODO_HEADER_RE = /^TODO:(.*)$/;
const _BULLET_RE = /^(\s*)(\* |\[ \] |\[x\] |\[X\] )(.*)/;
const _COMMENT_RE = /^(\s*)COMMENT:(.*)/;
const _REPLY_RE   = /^(\s*)REPLY:(.*)/;

/**
 * Parse ALL TODO blocks found in a notes section.
 *
 * Each block starts with a line matching /^TODO:(.*)$/ (trimmed).
 * Optional text after the colon (trimmed) is the group label.
 * The block ends at the first blank line or end of content.
 *
 * Bullet items gain a `comments` array:
 *   comments: Array<{
 *     text: string,
 *     lineStart: number,   // -1 = synthetic (inserted for orphan REPLY, no real line)
 *     replies: Array<{ text: string, lineStart: number }>
 *   }>
 *
 * Indent level = Math.floor(expandedLeadingSpaces / 2)
 * where each \t counts as 2 spaces and odd leading spaces round down.
 *
 * @param {string} sectionContent
 * @returns {Array<{
 *   label: string,
 *   items: Array<{text:string, level:number, completed:boolean, lineStart:number,
 *                 comments: Array<{text:string, lineStart:number,
 *                                  replies: Array<{text:string, lineStart:number}>}>}>,
 *   todoHeaderLine: number,
 *   blockStartLine: number,
 *   blockEndLine: number
 * }>}
 */
function parseTodoBlocks(sectionContent) {
  const lines = sectionContent.split(/\r?\n/);
  const blocks = [];

  for (let i = 0; i < lines.length; i++) {
    const headerMatch = lines[i].trim().match(_TODO_HEADER_RE);
    if (!headerMatch) continue;

    const label = headerMatch[1].trim();
    const todoHeaderLine = i;
    const items = [];
    let blockEndLine = todoHeaderLine;
    let foundAnyItem = false;
    // Tracks what the last parsed element was for continuation handling
    let lastCtx = 'item'; // 'item' | 'comment' | 'reply'

    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') break; // blank line ends the block

      const bulletMatch = line.match(_BULLET_RE);
      const commentMatch = line.match(_COMMENT_RE);
      const replyMatch   = line.match(_REPLY_RE);

      if (bulletMatch) {
        const expanded = bulletMatch[1].replace(/\t/g, '  ');
        const level = Math.floor(expanded.length / 2);
        const completed = bulletMatch[2].toLowerCase() === '[x] ';
        items.push({ text: bulletMatch[3], level, completed, lineStart: j, comments: [] });
        foundAnyItem = true;
        blockEndLine = j;
        lastCtx = 'item';
      } else if (commentMatch && items.length > 0) {
        const text = commentMatch[2].trim();
        items[items.length - 1].comments.push({ text, lineStart: j, replies: [] });
        blockEndLine = j;
        lastCtx = 'comment';
      } else if (replyMatch && items.length > 0) {
        const text = replyMatch[2].trim();
        const lastItem = items[items.length - 1];
        // Auto-create a synthetic empty comment if there is none yet
        if (lastItem.comments.length === 0) {
          lastItem.comments.push({ text: '', lineStart: -1, replies: [] });
        }
        lastItem.comments[lastItem.comments.length - 1].replies.push({ text, lineStart: j });
        blockEndLine = j;
        lastCtx = 'reply';
      } else if (foundAnyItem && items.length > 0) {
        // Continuation line — append to last element based on context
        if (lastCtx === 'reply') {
          const lastItem = items[items.length - 1];
          if (lastItem.comments.length > 0) {
            const lastComment = lastItem.comments[lastItem.comments.length - 1];
            if (lastComment.replies.length > 0) {
              lastComment.replies[lastComment.replies.length - 1].text += ' ' + line.trim();
            } else {
              lastComment.text += ' ' + line.trim();
            }
          }
        } else if (lastCtx === 'comment') {
          const lastItem = items[items.length - 1];
          if (lastItem.comments.length > 0) {
            lastItem.comments[lastItem.comments.length - 1].text += ' ' + line.trim();
          }
        } else {
          items[items.length - 1].text += ' ' + line.trim();
        }
        blockEndLine = j;
      }
      // Non-bullet/comment/reply lines before first item are ignored
    }

    blocks.push({ label, items, todoHeaderLine, blockStartLine: i + 1, blockEndLine });
  }

  return blocks;
}

/**
 * Parse the FIRST TODO block found in a notes section (backward-compat wrapper).
 *
 * @param {string} sectionContent
 * @returns {{ label:string, items: Array<...>, todoHeaderLine:number, blockStartLine:number, blockEndLine:number }|null}
 */
function parseTodoBlock(sectionContent) {
  const blocks = parseTodoBlocks(sectionContent);
  return blocks.length > 0 ? blocks[0] : null;
}

/**
 * Count completed and total TODO items (bullets only) across ALL blocks in a section.
 *
 * @param {string} sectionContent
 * @returns {{ total: number, completed: number }}
 */
function countTodoItems(sectionContent) {
  const blocks = parseTodoBlocks(sectionContent);
  if (blocks.length === 0) return { total: 0, completed: 0 };
  let total = 0, completed = 0;
  for (const block of blocks) {
    total += block.items.length;
    completed += block.items.filter(item => item.completed).length;
  }
  return { total, completed };
}

/**
 * Normalize a TODO section on write-back:
 *  - Converts `* item` bullets → `[ ] item`
 *  - Coerces COMMENT: lines to (item_indent + 2) spaces
 *  - Coerces REPLY: lines to (item_indent + 4) spaces
 *  - Inserts an empty `COMMENT: ` line before any orphan REPLY: that has no preceding COMMENT:
 *
 * Content outside TODO blocks is left untouched.
 *
 * @param {string} sectionContent
 * @returns {string}
 */
function normalizeTodoBlock(sectionContent) {
  const lines = sectionContent.split(/\r?\n/);
  const output = [];
  let inBlock = false;
  let currentItemIndent = 0; // leading space count of the most-recent bullet
  let hasComment = false;    // whether current item has had at least one COMMENT:

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Start of a TODO block
    if (line.trim().match(_TODO_HEADER_RE)) {
      inBlock = true;
      currentItemIndent = 0;
      hasComment = false;
      output.push(line);
      continue;
    }

    // End of block at blank line
    if (inBlock && line.trim() === '') {
      inBlock = false;
      output.push(line);
      continue;
    }

    if (!inBlock) {
      output.push(line);
      continue;
    }

    // Inside a TODO block ---------------------------------------------------
    const bulletMatch = line.match(_BULLET_RE);
    const commentMatch = line.match(_COMMENT_RE);
    const replyMatch   = line.match(_REPLY_RE);

    if (bulletMatch) {
      currentItemIndent = bulletMatch[1].replace(/\t/g, '  ').length;
      hasComment = false;
      // Normalize * → [ ]
      output.push(line.replace(/^(\s*)\* /, '$1[ ] '));
    } else if (commentMatch) {
      const text = commentMatch[2].trimEnd();
      const indent = ' '.repeat(currentItemIndent + 2);
      output.push(indent + 'COMMENT:' + (text ? ' ' + text.trim() : ''));
      hasComment = true;
    } else if (replyMatch) {
      if (!hasComment) {
        // Insert synthetic empty COMMENT: before orphan REPLY:
        const cIndent = ' '.repeat(currentItemIndent + 2);
        output.push(cIndent + 'COMMENT:');
        hasComment = true;
      }
      const text = replyMatch[2].trimEnd();
      const indent = ' '.repeat(currentItemIndent + 4);
      output.push(indent + 'REPLY:' + (text ? ' ' + text.trim() : ''));
    } else {
      // Continuation or unknown line — keep as-is
      output.push(line);
    }
  }

  return output.join('\n');
}

/**
 * Toggle completion states of specific TODO items (by flat index across ALL
 * blocks, in document order) in a section.
 *
 * '[ ]' ↔ '[x]' depending on the completed flag in each update.
 *
 * @param {string} sectionContent
 * @param {Array<{itemIndex:number, completed:boolean}>} updates
 * @returns {string}
 */
function updateTodoItemStates(sectionContent, updates) {
  const blocks = parseTodoBlocks(sectionContent);
  if (blocks.length === 0) return sectionContent;

  // Build a single flat item list in document order
  const allItems = blocks.flatMap(b => b.items);
  if (allItems.length === 0) return sectionContent;

  const lines = sectionContent.split(/\r?\n/);

  for (const { itemIndex, completed } of updates) {
    const item = allItems[itemIndex];
    if (!item) continue;
    const li = item.lineStart;
    if (completed) {
      lines[li] = lines[li].replace(/^(\s*)(\[ \] |\* )/, '$1[x] ');
    } else {
      lines[li] = lines[li].replace(/^(\s*)\[x\] /i, '$1[ ] ');
    }
  }

  return lines.join('\n');
}

/**
 * Extract all @#tag references from a notes section.
 * A valid tag must be followed by whitespace or end-of-line.
 * Tags with illegal characters in the name are silently ignored.
 *
 * @param {string} sectionContent - Content of a single notes section
 * @returns {string[]} Deduplicated array of tag name strings (without the @# prefix)
 */
function extractNoteTags(sectionContent) {
  if (!sectionContent) return [];
  const TAG_PATTERN = /@#([a-zA-Z0-9_-]+)(?=[\s]|$)/gm;
  const found = new Set();
  let match;
  while ((match = TAG_PATTERN.exec(sectionContent)) !== null) {
    found.add(match[1]);
  }
  return Array.from(found);
}

/**
 * Demote a tag in a notes section: replace @#tagName with #tagName (archive).
 * Only replaces whole-word occurrences (not followed by word characters).
 *
 * @param {string} sectionContent - Content of a single notes section
 * @param {string} tagName - The tag name to demote (without any prefix)
 * @returns {string} Updated section content
 */
function demoteTagInSection(sectionContent, tagName) {
  if (!sectionContent) return sectionContent;
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return sectionContent.replace(new RegExp(`@#(${escaped})(?!\\w)`, 'g'), '#$1');
}

/**
 * Promote an archived tag in a notes section: replace #tagName with @#tagName.
 * Only promotes occurrences that are NOT already preceded by @.
 *
 * @param {string} sectionContent - Content of a single notes section
 * @param {string} tagName - The tag name to promote (without any prefix)
 * @returns {string} Updated section content
 */
function promoteTagInSection(sectionContent, tagName) {
  if (!sectionContent) return sectionContent;
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return sectionContent.replace(new RegExp(`(?<!@)#(${escaped})(?!\\w)`, 'g'), '@#$1');
}

// ---------------------------------------------------------------------------
// REMINDER block parsing & manipulation
// ---------------------------------------------------------------------------

// Matches a REMINDER line at the start of a line (after optional leading whitespace):
//   REMINDER (date): text
//   REMINDER: text
// Groups: [1]=leading whitespace, [2]=raw date string (or undefined), [3]=reminder text
const _REMINDER_HEADER_RE = /^(\s*)REMINDER\s*(?:\(([^)]*)\))?:(.*)/;

/**
 * Parse a forgiving ISO-like date/time string into a normalized form.
 *
 * Supported inputs (all case-insensitive):
 *   "YYYY-MM-DD"
 *   "YYYY-MM-DDTHH" or "YYYY-MM-DD HH" (T or 1+ spaces/tabs)
 *   "YYYY-MM-DD HH:MM" (minutes already present)
 *   "YYYY-MM-DD HH:MM:SS" (seconds are dropped, not rounded)
 *   "YYYY-MM-DD HH:MM AM/PM"  (converted to 24-hr)
 *   Mixed separators: T or any run of spaces/tabs (not newlines)
 *
 * Rules:
 *   - Omitted time → assumed 23:00
 *   - Omitted minutes → :00
 *   - AM/PM supported, coerced to 24-hr
 *   - Seconds removed
 *   - All separator variants coerced to a single space " "
 *
 * @param {string|null|undefined} raw  Raw string from inside the REMINDER() parens
 * @returns {{ isoDateTime: string|null, wasNormalized: boolean }}
 *   isoDateTime is "YYYY-MM-DD HH:MM" or null if the input is empty/unparseable.
 */
function parseReminderDate(raw) {
  if (!raw || !raw.trim()) return { isoDateTime: null, wasNormalized: false };

  // Normalise separator between date and time: T or 1+ whitespace (no newlines) → single space
  const cleaned = raw.trim().replace(/[T]|[ \t]+/g, ' ');

  // Regex: date mandatory; time optional; AM/PM optional
  const m = cleaned.match(
    /^(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?)?$/i
  );
  if (!m) return { isoDateTime: null, wasNormalized: false };

  const datePart  = m[1];
  let   hour      = m[2] !== undefined ? parseInt(m[2], 10) : null;
  let   minute    = m[3] !== undefined ? parseInt(m[3], 10) : 0;
  // m[4] = seconds (dropped intentionally)
  const ampm      = m[5] ? m[5].toLowerCase() : null;

  // Omitted time → 23:00
  if (hour === null) {
    hour = 23;
    minute = 0;
  }

  // AM/PM conversion
  if (ampm === 'am') {
    if (hour === 12) hour = 0;
  } else if (ampm === 'pm') {
    if (hour !== 12) hour = hour + 12;
  }

  const paddedHour   = String(hour).padStart(2, '0');
  const paddedMinute = String(minute).padStart(2, '0');
  const isoDateTime  = `${datePart} ${paddedHour}:${paddedMinute}`;

  // Determine if normalisation changed anything
  const wasNormalized = isoDateTime !== cleaned.replace(/\s+(am|pm)\s*$/i, '').trim();

  return { isoDateTime, wasNormalized };
}

/**
 * Format a normalized ISO datetime string for write-back.
 * Accepts "YYYY-MM-DD HH:MM" (already normalized) or null.
 * Returns the string as-is or null.
 *
 * @param {string|null} isoDateTime
 * @returns {string|null}
 */
function formatReminderDateTime(isoDateTime) {
  return isoDateTime || null;
}

/**
 * Parse standalone REMINDER blocks from a notes section (i.e. outside any TODO block).
 *
 * A standalone REMINDER line looks like:
 *   REMINDER (YYYY-MM-DD HH:MM): text
 *   REMINDER: text (no date)
 *
 * Rules:
 *  - The REMINDER keyword must be the first non-whitespace token on a line.
 *    If a REMINDER token appears later in a line (e.g. within a TODO item text),
 *    it is ignored and a User Warning is issued.
 *  - If the REMINDER line also contains TODO:, COMMENT:, or REPLY: tokens,
 *    a User Warning is issued and the line is treated solely as a REMINDER.
 *  - REMINDER lines inside a TODO block are NOT returned here (they are handled
 *    by parseTodoBlocksWithReminders instead).
 *  - Reminders do not have subitems; bullet lines under a standalone REMINDER
 *    are ignored and trigger a User Warning.
 *  - COMMENT: and REPLY: lines following a standalone REMINDER attach to it
 *    (same pattern as TODO items).
 *
 * @param {string} sectionContent
 * @param {function} [userWarn]  Optional warn callback; defaults to console.warn.
 * @returns {Array<{
 *   text: string,
 *   rawDate: string|null,
 *   parsedDate: string|null,
 *   lineStart: number,
 *   comments: Array<{text: string, lineStart: number, replies: Array<{text:string, lineStart:number}>}>
 * }>}
 */
function parseReminderBlocks(sectionContent, userWarn) {
  const warn = userWarn || ((msg, ctx) => console.warn('[User Warning]', msg, ctx));
  const lines = sectionContent ? sectionContent.split(/\r?\n/) : [];
  const reminders = [];

  // Determine TODO block ranges so we can skip lines inside them
  const todoRanges = []; // [{start, end}] inclusive line indices
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().match(_TODO_HEADER_RE)) {
      const rangeStart = i;
      let rangeEnd = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '') break;
        rangeEnd = j;
      }
      todoRanges.push({ start: rangeStart, end: rangeEnd });
    }
  }

  function isInsideTodoBlock(lineIdx) {
    return todoRanges.some(r => lineIdx >= r.start && lineIdx <= r.end);
  }

  let currentReminder = null;
  let lastCtx = 'reminder'; // 'reminder' | 'comment' | 'reply'

  for (let i = 0; i < lines.length; i++) {
    if (isInsideTodoBlock(i)) {
      currentReminder = null;
      continue;
    }

    const line = lines[i];
    const reminderMatch = line.match(_REMINDER_HEADER_RE);
    const commentMatch  = line.match(_COMMENT_RE);
    const replyMatch    = line.match(_REPLY_RE);
    const bulletMatch   = line.match(_BULLET_RE);

    if (reminderMatch) {
      // Warn if other keywords are also present in the remainder of this line
      const remainder = reminderMatch[3] || '';
      if (/\bTODO:|\bCOMMENT:|\bREPLY:/.test(remainder)) {
        warn('REMINDER line contains TODO:/COMMENT:/REPLY: keyword — treated as REMINDER only', {
          line: i, content: line.trim()
        });
      }

      const rawDate   = reminderMatch[2] ? reminderMatch[2].trim() : null;
      const { isoDateTime: parsedDate } = parseReminderDate(rawDate);
      const text      = remainder.trim();

      currentReminder = { text, rawDate, parsedDate, lineStart: i, comments: [] };
      reminders.push(currentReminder);
      lastCtx = 'reminder';

    } else if (commentMatch && currentReminder) {
      const text = commentMatch[2].trim();
      currentReminder.comments.push({ text, lineStart: i, replies: [] });
      lastCtx = 'comment';

    } else if (replyMatch && currentReminder) {
      const text = replyMatch[2].trim();
      if (currentReminder.comments.length === 0) {
        currentReminder.comments.push({ text: '', lineStart: -1, replies: [] });
      }
      currentReminder.comments[currentReminder.comments.length - 1].replies.push({
        text, lineStart: i
      });
      lastCtx = 'reply';

    } else if (bulletMatch && currentReminder) {
      warn('Bullet item found under a standalone REMINDER — reminders do not support subitems', {
        line: i, content: line.trim()
      });
      // Do not attach; keep currentReminder active for further COMMENT/REPLY

    } else if (currentReminder && line.trim() === '') {
      // Blank line ends the current reminder block
      currentReminder = null;

    } else if (currentReminder && lastCtx === 'reply') {
      // Continuation line for current reply
      const lastComment = currentReminder.comments[currentReminder.comments.length - 1];
      if (lastComment && lastComment.replies.length > 0) {
        lastComment.replies[lastComment.replies.length - 1].text += ' ' + line.trim();
      }
    } else if (currentReminder && lastCtx === 'comment') {
      // Continuation line for current comment
      const lastComment = currentReminder.comments[currentReminder.comments.length - 1];
      if (lastComment) lastComment.text += ' ' + line.trim();
    } else if (currentReminder && lastCtx === 'reminder') {
      // Continuation line for reminder text itself
      currentReminder.text += ' ' + line.trim();

    } else {
      // Check whether a REMINDER token appears mid-line (not as the first token)
      if (/\bREMINDER\s*(?:\([^)]*\))?:/.test(line) && !reminderMatch) {
        warn('REMINDER keyword appears mid-line and will be ignored', {
          line: i, content: line.trim()
        });
      }
    }
  }

  return reminders;
}

/**
 * Extended version of parseTodoBlocks that also recognises REMINDER lines inside
 * TODO blocks. A REMINDER line found between bullet items attaches to the most
 * recently parsed item as `item.cohabitatingReminder`.
 *
 * COMMENT/REPLY lines that follow a cohabitated REMINDER continue to attach to
 * the todo item as usual (they are shared by both the TODO item and the reminder).
 *
 * User Warnings are issued when:
 *  - A REMINDER keyword appears mid-line (not as the first token on the line)
 *  - A REMINDER line also contains TODO:/COMMENT:/REPLY: keywords
 *
 * All other behaviour is identical to parseTodoBlocks.
 *
 * @param {string} sectionContent
 * @param {function} [userWarn]
 * @returns {Array}  Same structure as parseTodoBlocks output, with optional
 *   `item.cohabitatingReminder = { text, rawDate, parsedDate, lineStart }` on items
 *   that have an associated REMINDER.
 */
function parseTodoBlocksWithReminders(sectionContent, userWarn) {
  const warn = userWarn || ((msg, ctx) => console.warn('[User Warning]', msg, ctx));
  if (!sectionContent) return [];

  const lines  = sectionContent.split(/\r?\n/);
  const blocks = [];

  for (let i = 0; i < lines.length; i++) {
    const headerMatch = lines[i].trim().match(_TODO_HEADER_RE);
    if (!headerMatch) continue;

    const label          = headerMatch[1].trim();
    const todoHeaderLine = i;
    const items          = [];
    let blockEndLine     = todoHeaderLine;
    let foundAnyItem     = false;
    let lastCtx          = 'item';

    for (let j = i + 1; j < lines.length; j++) {
      const line         = lines[j];
      if (line.trim() === '') break;

      const bulletMatch   = line.match(_BULLET_RE);
      const commentMatch  = line.match(_COMMENT_RE);
      const replyMatch    = line.match(_REPLY_RE);
      const reminderMatch = line.match(_REMINDER_HEADER_RE);

      if (bulletMatch) {
        const expanded  = bulletMatch[1].replace(/\t/g, '  ');
        const level     = Math.floor(expanded.length / 2);
        const completed = bulletMatch[2].toLowerCase() === '[x] ';
        items.push({ text: bulletMatch[3], level, completed, lineStart: j, comments: [] });
        foundAnyItem = true;
        blockEndLine = j;
        lastCtx = 'item';

      } else if (reminderMatch && items.length > 0) {
        // Warn if other primary keywords are also present
        const remainder = reminderMatch[3] || '';
        if (/\bTODO:|\bCOMMENT:|\bREPLY:/.test(remainder)) {
          warn('REMINDER line inside a TODO block contains TODO:/COMMENT:/REPLY: keyword', {
            line: j, content: line.trim()
          });
        }
        const rawDate   = reminderMatch[2] ? reminderMatch[2].trim() : null;
        const { isoDateTime: parsedDate } = parseReminderDate(rawDate);
        const text      = remainder.trim();
        // Attach to the most recent item (overwrite if already set)
        items[items.length - 1].cohabitatingReminder = {
          text, rawDate, parsedDate, lineStart: j
        };
        blockEndLine = j;
        lastCtx = 'reminder';

      } else if (commentMatch && items.length > 0) {
        const text = commentMatch[2].trim();
        items[items.length - 1].comments.push({ text, lineStart: j, replies: [] });
        blockEndLine = j;
        lastCtx = 'comment';

      } else if (replyMatch && items.length > 0) {
        const text     = replyMatch[2].trim();
        const lastItem = items[items.length - 1];
        if (lastItem.comments.length === 0) {
          lastItem.comments.push({ text: '', lineStart: -1, replies: [] });
        }
        lastItem.comments[lastItem.comments.length - 1].replies.push({ text, lineStart: j });
        blockEndLine = j;
        lastCtx = 'reply';

      } else if (foundAnyItem && items.length > 0) {
        // Continuation line
        if (lastCtx === 'reply') {
          const lastItem    = items[items.length - 1];
          const lastComment = lastItem.comments[lastItem.comments.length - 1];
          if (lastComment) {
            if (lastComment.replies.length > 0) {
              lastComment.replies[lastComment.replies.length - 1].text += ' ' + line.trim();
            } else {
              lastComment.text += ' ' + line.trim();
            }
          }
        } else if (lastCtx === 'comment') {
          const lastItem = items[items.length - 1];
          if (lastItem.comments.length > 0) {
            lastItem.comments[lastItem.comments.length - 1].text += ' ' + line.trim();
          }
        } else if (lastCtx === 'reminder') {
          // Continuation of the reminder text inside the TODO block
          const lastItem = items[items.length - 1];
          if (lastItem.cohabitatingReminder) {
            lastItem.cohabitatingReminder.text += ' ' + line.trim();
          }
        } else {
          items[items.length - 1].text += ' ' + line.trim();
        }
        blockEndLine = j;
      }

      // Check for mid-line REMINDER keyword (buried inside non-reminder line)
      if (!reminderMatch && /\bREMINDER\s*(?:\([^)]*\))?:/.test(line)) {
        warn('REMINDER keyword appears mid-line inside a TODO block and will be ignored', {
          line: j, content: line.trim()
        });
      }
    }

    blocks.push({ label, items, todoHeaderLine, blockStartLine: i + 1, blockEndLine });
  }

  return blocks;
}

/**
 * Normalize both TODO blocks and standalone REMINDER blocks in a section.
 *
 * TODO block normalization is identical to normalizeTodoBlock.
 * Additionally, within TODO blocks, any REMINDER line that appears after
 * COMMENT/REPLY lines for its parent item is hoisted to immediately after
 * the bullet line (order: bullet → REMINDER → COMMENT/REPLY...).
 *
 * Standalone REMINDER blocks:
 *   - Date is re-serialized to "YYYY-MM-DD HH:MM" (normalized form)
 *   - COMMENT/REPLY indentation is normalized (2 / 4 spaces relative to REMINDER indent)
 *
 * @param {string} sectionContent
 * @param {function} [userWarn]
 * @returns {string}
 */
function normalizeReminderSection(sectionContent, userWarn) {
  if (!sectionContent) return sectionContent;
  const warn = userWarn || ((msg, ctx) => console.warn('[User Warning]', msg, ctx));
  const lines  = sectionContent.split(/\r?\n/);
  const output = [];

  let inTodoBlock      = false;
  let inReminderBlock  = false;
  let currentItemIndent = 0;
  let hasComment       = false;

  // Buffer for a single TODO item's lines so we can hoist REMINDER before COMMENTs
  // Each entry: { kind: 'bullet'|'reminder'|'comment'|'reply'|'other', raw: string }
  let itemBuffer = [];

  function flushItemBuffer() {
    if (itemBuffer.length === 0) return;
    // Find bullet, reminder, comments/replies
    const bulletLines   = itemBuffer.filter(e => e.kind === 'bullet');
    const reminderLines = itemBuffer.filter(e => e.kind === 'reminder');
    const restLines     = itemBuffer.filter(e => e.kind !== 'bullet' && e.kind !== 'reminder');

    for (const e of bulletLines)   output.push(e.raw);
    for (const e of reminderLines) output.push(e.raw);
    for (const e of restLines)     output.push(e.raw);

    itemBuffer = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ---- Detect TODO block start ----
    if (line.trim().match(_TODO_HEADER_RE)) {
      flushItemBuffer();
      inTodoBlock       = true;
      inReminderBlock   = false;
      currentItemIndent = 0;
      hasComment        = false;
      output.push(line);
      continue;
    }

    // ---- Blank line ends any block ----
    if (line.trim() === '') {
      flushItemBuffer();
      inTodoBlock     = false;
      inReminderBlock = false;
      output.push(line);
      continue;
    }

    if (inTodoBlock) {
      const bulletMatch   = line.match(_BULLET_RE);
      const commentMatch  = line.match(_COMMENT_RE);
      const replyMatch    = line.match(_REPLY_RE);
      const reminderMatch = line.match(_REMINDER_HEADER_RE);

      if (bulletMatch) {
        flushItemBuffer();
        currentItemIndent = bulletMatch[1].replace(/\t/g, '  ').length;
        hasComment        = false;
        // Normalize * → [ ]
        const normalized = line.replace(/^(\s*)\* /, '$1[ ] ');
        itemBuffer.push({ kind: 'bullet', raw: normalized });

      } else if (reminderMatch) {
        // Re-normalize the date inside the parens
        const rawDate = reminderMatch[2] ? reminderMatch[2].trim() : null;
        const { isoDateTime } = parseReminderDate(rawDate);
        const text    = (reminderMatch[3] || '').trim();
        const indent  = reminderMatch[1] || '';
        let   rebuilt;
        if (isoDateTime) {
          rebuilt = `${indent}REMINDER (${isoDateTime}):${text ? ' ' + text : ''}`;
        } else {
          rebuilt = `${indent}REMINDER:${text ? ' ' + text : ''}`;
        }
        itemBuffer.push({ kind: 'reminder', raw: rebuilt });

      } else if (commentMatch) {
        const text   = commentMatch[2].trimEnd();
        const indent = ' '.repeat(currentItemIndent + 2);
        itemBuffer.push({ kind: 'comment', raw: indent + 'COMMENT:' + (text ? ' ' + text.trim() : '') });
        hasComment = true;

      } else if (replyMatch) {
        if (!hasComment) {
          const cIndent = ' '.repeat(currentItemIndent + 2);
          itemBuffer.push({ kind: 'comment', raw: cIndent + 'COMMENT:' });
          hasComment = true;
        }
        const text   = replyMatch[2].trimEnd();
        const indent = ' '.repeat(currentItemIndent + 4);
        itemBuffer.push({ kind: 'reply', raw: indent + 'REPLY:' + (text ? ' ' + text.trim() : '') });

      } else {
        // Continuation or unknown — keep as-is
        itemBuffer.push({ kind: 'other', raw: line });
      }
      continue;
    }

    // ---- Standalone REMINDER block ----
    const reminderMatch = line.match(_REMINDER_HEADER_RE);
    if (reminderMatch) {
      const rawDate    = reminderMatch[2] ? reminderMatch[2].trim() : null;
      const { isoDateTime } = parseReminderDate(rawDate);
      const text       = (reminderMatch[3] || '').trim();
      const baseIndent = reminderMatch[1] || '';
      let rebuilt;
      if (isoDateTime) {
        rebuilt = `${baseIndent}REMINDER (${isoDateTime}):${text ? ' ' + text : ''}`;
      } else {
        rebuilt = `${baseIndent}REMINDER:${text ? ' ' + text : ''}`;
      }
      output.push(rebuilt);
      inReminderBlock   = true;
      currentItemIndent = baseIndent.length;
      hasComment        = false;
      continue;
    }

    if (inReminderBlock) {
      const commentMatch = line.match(_COMMENT_RE);
      const replyMatch   = line.match(_REPLY_RE);

      if (commentMatch) {
        const text   = commentMatch[2].trimEnd();
        const indent = ' '.repeat(currentItemIndent + 2);
        output.push(indent + 'COMMENT:' + (text ? ' ' + text.trim() : ''));
        hasComment = true;
      } else if (replyMatch) {
        if (!hasComment) {
          output.push(' '.repeat(currentItemIndent + 2) + 'COMMENT:');
          hasComment = true;
        }
        const text   = replyMatch[2].trimEnd();
        const indent = ' '.repeat(currentItemIndent + 4);
        output.push(indent + 'REPLY:' + (text ? ' ' + text.trim() : ''));
      } else {
        output.push(line);
      }
      continue;
    }

    output.push(line);
  }

  flushItemBuffer();
  return output.join('\n');
}

// Export public API
const notesParserAPI = {
  parseNotesFileSections,
  writeNotesSection,
  isValidFileHeader,
  extractHeaderFilename,
  extractAllHeaders,
  extractDirectoryNotes,
  extractFileNotes,
  getAllSectionsInfo,
  parseTodoBlock,
  parseTodoBlocks,
  countTodoItems,
  normalizeTodoBlock,
  updateTodoItemStates,
  extractNoteTags,
  demoteTagInSection,
  promoteTagInSection,
  parseReminderDate,
  formatReminderDateTime,
  parseReminderBlocks,
  parseTodoBlocksWithReminders,
  normalizeReminderSection
};

if (typeof module !== 'undefined' && module.exports) {
  // Node.js environment
  module.exports = notesParserAPI;
} else {
  // Browser environment
  window.notesParser = notesParserAPI;
}
