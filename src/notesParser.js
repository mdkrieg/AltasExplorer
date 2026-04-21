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
  promoteTagInSection
};

if (typeof module !== 'undefined' && module.exports) {
  // Node.js environment
  module.exports = notesParserAPI;
} else {
  // Browser environment
  window.notesParser = notesParserAPI;
}
