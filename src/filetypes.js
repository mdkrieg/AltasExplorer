const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger');

const FILETYPES_FILE = path.join(os.homedir(), '.atlasexplorer', 'filetypes.json');

const DEFAULT_FILE_TYPES = [
  { pattern: 'notes.txt', type: 'Notes', locked: true },
  { pattern: '*.aly', type: 'Atlas Layout', icon: 'layout.svg', openWith: 'aly-layout', locked: true },
  { pattern: '*.json', type: 'JSON' },
  { pattern: '*.csv', type: 'CSV' },
  { pattern: '*.png', type: 'Image' },
  { pattern: '*.jpg', type: 'Image', icon: 'user-image.png' },
  { pattern: '*.jpeg', type: 'Image', icon: 'user-image.png' },
  { pattern: '*.gif', type: 'Image', icon: 'user-image.png' },
  { pattern: '*.webp', type: 'Image', icon: 'user-image.png' },
  { pattern: '*.bmp', type: 'Image', icon: 'user-image.png' },
  { pattern: '*.tiff', type: 'Image', icon: 'user-image.png' },
  { pattern: '*.svg', type: 'Image', icon: 'user-image.png' },
  { pattern: '*.txt', type: 'Text' },
  { pattern: '*.mp4', type: 'Video', icon: 'user-video.svg' },
  { pattern: '*.mov', type: 'Video', icon: 'user-video.svg' },
  { pattern: '*.avi', type: 'Video', icon: 'user-video.svg' },
  { pattern: '*.mkv', type: 'Video', icon: 'user-video.svg' },
  { pattern: '*.webm', type: 'Video', icon: 'user-video.svg' },
  { pattern: '*.m4v', type: 'Video', icon: 'user-video.svg' },
  { pattern: '*.wmv', type: 'Video', icon: 'user-video.svg' },
  { pattern: '*.flv', type: 'Video', icon: 'user-video.svg' },
  { pattern: '*.mpg', type: 'Video', icon: 'user-video.svg' },
  { pattern: '*.mpeg', type: 'Video', icon: 'user-video.svg' }
];

// Entries to add to existing installs that pre-date them being in DEFAULT_FILE_TYPES
const MIGRATION_TYPES = [
  { pattern: '*.aly', type: 'Atlas Layout', icon: 'layout.svg', openWith: 'aly-layout', locked: true },
  { pattern: '*.jpg', type: 'Image', icon: 'user-image.png' },
  { pattern: '*.jpeg', type: 'Image', icon: 'user-image.png' },
  { pattern: '*.gif', type: 'Image', icon: 'user-image.png' },
  { pattern: '*.webp', type: 'Image', icon: 'user-image.png' },
  { pattern: '*.bmp', type: 'Image', icon: 'user-image.png' },
  { pattern: '*.tiff', type: 'Image', icon: 'user-image.png' },
  { pattern: '*.svg', type: 'Image', icon: 'user-image.png' },
  { pattern: '*.mp4', type: 'Video', icon: 'user-video.svg' },
  { pattern: '*.mov', type: 'Video', icon: 'user-video.svg' },
  { pattern: '*.avi', type: 'Video', icon: 'user-video.svg' },
  { pattern: '*.mkv', type: 'Video', icon: 'user-video.svg' },
  { pattern: '*.webm', type: 'Video', icon: 'user-video.svg' },
  { pattern: '*.m4v', type: 'Video', icon: 'user-video.svg' },
  { pattern: '*.wmv', type: 'Video', icon: 'user-video.svg' },
  { pattern: '*.flv', type: 'Video', icon: 'user-video.svg' },
  { pattern: '*.mpg', type: 'Video', icon: 'user-video.svg' },
  { pattern: '*.mpeg', type: 'Video', icon: 'user-video.svg' }
];

class FileTypeService {
  constructor() {
    this.ensureFile();
    this.migrateFileTypes();
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
        notesEntry.locked = true;
      }
      // Ensure the *.aly entry is always present and locked
      const alyEntry = types.find(t => t.pattern === '*.aly');
      if (!alyEntry) {
        // Insert after notes.txt
        const notesIdx = types.findIndex(t => t.pattern === 'notes.txt');
        types.splice(notesIdx + 1, 0, { pattern: '*.aly', type: 'Atlas Layout', icon: 'layout.svg', openWith: 'aly-layout', locked: true });
        this._save(types);
      } else {
        alyEntry.locked = true;
        alyEntry.icon = 'layout.svg';
        alyEntry.openWith = 'aly-layout';
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
  addFileType(pattern, type, icon = null, openWith = null) {
    if (!pattern || !type) {
      throw new Error('Pattern and type are required');
    }
    const types = this.getFileTypes();
    if (types.find(t => t.pattern === pattern)) {
      throw new Error(`A file type with pattern "${pattern}" already exists`);
    }
    const entry = { pattern, type };
    if (icon) entry.icon = icon;
    if (openWith) entry.openWith = openWith;
    types.push(entry);
    this._save(types);
    return entry;
  }

  /**
   * Update an existing file type entry
   */
  updateFileType(pattern, newPattern, newType, icon = null, openWith = null) {
    if (pattern === 'notes.txt' || pattern === '*.aly') {
      throw new Error('This file type cannot be modified');
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
    if (openWith) entry.openWith = openWith;
    types[index] = entry;
    this._save(types);
    return types[index];
  }

  /**
   * Delete a file type entry
   */
  deleteFileType(pattern) {
    if (pattern === 'notes.txt' || pattern === '*.aly') {
      throw new Error('This file type cannot be deleted');
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

  /**
   * Additive migration: append any MIGRATION_TYPES entries not yet in the file.
   * Preserves all existing user customisations.
   */
  migrateFileTypes() {
    try {
      const content = fs.readFileSync(FILETYPES_FILE, 'utf8');
      const types = JSON.parse(content);
      const existingPatterns = new Set(types.map(t => t.pattern.toLowerCase()));
      let changed = false;
      for (const entry of MIGRATION_TYPES) {
        if (!existingPatterns.has(entry.pattern.toLowerCase())) {
          types.push({ ...entry });
          existingPatterns.add(entry.pattern.toLowerCase());
          changed = true;
        }
      }
      // Always enforce *.aly properties even if entry already existed
      const alyMigEntry = types.find(t => t.pattern === '*.aly');
      if (alyMigEntry) {
        if (alyMigEntry.icon !== 'layout.svg' || alyMigEntry.openWith !== 'aly-layout' || !alyMigEntry.locked) {
          alyMigEntry.icon = 'layout.svg';
          alyMigEntry.openWith = 'aly-layout';
          alyMigEntry.locked = true;
          changed = true;
        }
      }
      // Migrate obsolete openWith values to new viewWith semantics
      const OBSOLETE_VALUES = {
        'os-default': 'auto-detect',
        'item-properties': 'auto-detect',
        'none': 'auto-detect',
        'builtin-editor': 'text-editor-markdown'
      };
      for (const entry of types) {
        if (entry.locked) continue;
        const old = entry.openWith;
        if (old && OBSOLETE_VALUES[old]) {
          entry.openWith = OBSOLETE_VALUES[old];
          changed = true;
        }
      }
      if (changed) {
        this._save(types);
      }
    } catch (err) {
      logger.error('Error migrating file types:', err.message);
    }
  }
}

module.exports = new FileTypeService();
