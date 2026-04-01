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

// Export public API
const notesParserAPI = {
  parseNotesFileSections,
  writeNotesSection,
  isValidFileHeader,
  extractHeaderFilename,
  extractAllHeaders,
  extractDirectoryNotes,
  extractFileNotes,
  getAllSectionsInfo
};

if (typeof module !== 'undefined' && module.exports) {
  // Node.js environment
  module.exports = notesParserAPI;
} else {
  // Browser environment
  window.notesParser = notesParserAPI;
}
