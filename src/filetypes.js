const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger');

const FILETYPES_FILE = path.join(os.homedir(), '.atlasexplorer', 'filetypes.json');

const DEFAULT_FILE_TYPES = [
  { pattern: 'notes.txt', type: 'Notes', locked: true },
  { pattern: '*.json', type: 'JSON' },
  { pattern: '*.csv', type: 'CSV' },
  { pattern: '*.png', type: 'Image' },
  { pattern: '*.txt', type: 'Text' }
];

class FileTypeService {
  constructor() {
    this.ensureFile();
  }

  /**
   * Ensure the filetypes.json file exists, seeding defaults if not
   */
  ensureFile() {
    const dir = path.dirname(FILETYPES_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(FILETYPES_FILE)) {
      fs.writeFileSync(FILETYPES_FILE, JSON.stringify(DEFAULT_FILE_TYPES, null, 2));
    }
  }

  /**
   * Load all file types
   */
  getFileTypes() {
    try {
      const content = fs.readFileSync(FILETYPES_FILE, 'utf8');
      const types = JSON.parse(content);
      // Always ensure the locked Notes entry is present and first
      const notesEntry = types.find(t => t.pattern === 'notes.txt');
      if (!notesEntry) {
        types.unshift({ pattern: 'notes.txt', type: 'Notes', locked: true });
        this._save(types);
      } else {
        // Ensure locked flag is set on the notes.txt entry
        notesEntry.locked = true;
      }
      return types;
    } catch (err) {
      logger.error('Error loading file types:', err.message);
      return [...DEFAULT_FILE_TYPES];
    }
  }

  /**
   * Add a new file type entry
   */
  addFileType(pattern, type, icon = null) {
    if (!pattern || !type) {
      throw new Error('Pattern and type are required');
    }
    const types = this.getFileTypes();
    if (types.find(t => t.pattern === pattern)) {
      throw new Error(`A file type with pattern "${pattern}" already exists`);
    }
    const entry = { pattern, type };
    if (icon) entry.icon = icon;
    types.push(entry);
    this._save(types);
    return entry;
  }

  /**
   * Update an existing file type entry
   */
  updateFileType(pattern, newPattern, newType, icon = null) {
    if (pattern === 'notes.txt') {
      throw new Error('The Notes file type cannot be modified');
    }
    if (!newPattern || !newType) {
      throw new Error('Pattern and type are required');
    }
    const types = this.getFileTypes();
    const index = types.findIndex(t => t.pattern === pattern);
    if (index === -1) {
      throw new Error(`File type with pattern "${pattern}" not found`);
    }
    // If pattern is changing, make sure new pattern doesn't conflict
    if (newPattern !== pattern && types.find(t => t.pattern === newPattern)) {
      throw new Error(`A file type with pattern "${newPattern}" already exists`);
    }
    const entry = { pattern: newPattern, type: newType };
    if (icon) entry.icon = icon;
    types[index] = entry;
    this._save(types);
    return types[index];
  }

  /**
   * Delete a file type entry
   */
  deleteFileType(pattern) {
    if (pattern === 'notes.txt') {
      throw new Error('The Notes file type cannot be deleted');
    }
    const types = this.getFileTypes();
    const index = types.findIndex(t => t.pattern === pattern);
    if (index === -1) {
      throw new Error(`File type with pattern "${pattern}" not found`);
    }
    types.splice(index, 1);
    this._save(types);
  }

  _save(types) {
    fs.writeFileSync(FILETYPES_FILE, JSON.stringify(types, null, 2));
  }
}

module.exports = new FileTypeService();
