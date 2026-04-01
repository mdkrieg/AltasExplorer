const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');
const logger = require('./logger');

const DB_PATH = path.join(os.homedir(), '.atlasexplorer', 'data.sqlite');
const CONFIG_DIR = path.join(os.homedir(), '.atlasexplorer');

class DatabaseService {
  constructor() {
    this.db = null;
  }

  initialize() {
    // Ensure config directory exists
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }

    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.createSchema();
  }

  createSchema() {
    const schema = `
      CREATE TABLE IF NOT EXISTS dirs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inode TEXT NOT NULL,
        dirname TEXT NOT NULL UNIQUE,
        category TEXT DEFAULT 'Default',
        description VARCHAR(256),
        initials VARCHAR(8),
        tags TEXT
      );

      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inode TEXT NOT NULL,
        dir_id INTEGER NOT NULL,
        filename TEXT NOT NULL,
        dateModified INTEGER,
        dateCreated INTEGER,
        size INTEGER,
        mode INTEGER,
        checksumValue TEXT,
        checksumStatus TEXT,
        tags TEXT,
        FOREIGN KEY (dir_id) REFERENCES dirs(id),
        UNIQUE(inode, dir_id)
      );

      CREATE TABLE IF NOT EXISTS file_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inode TEXT NOT NULL,
        dir_id INTEGER NOT NULL,
        file_id INTEGER NOT NULL,
        changeValue TEXT NOT NULL,
        detectedAt INTEGER,
        acknowledgedAt INTEGER,
        FOREIGN KEY (dir_id) REFERENCES dirs(id),
        FOREIGN KEY (file_id) REFERENCES files(id)
      );

      CREATE TABLE IF NOT EXISTS orphans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inode TEXT NOT NULL,
        dir_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        new_dir_id INTEGER,
        FOREIGN KEY (dir_id) REFERENCES dirs(id),
        FOREIGN KEY (new_dir_id) REFERENCES dirs(id)
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        history_id INTEGER,
        type TEXT NOT NULL,
        filename TEXT,
        category TEXT,
        dir_id INTEGER,
        inode TEXT,
        old_value TEXT,
        new_value TEXT,
        created_at INTEGER,
        read_at INTEGER,
        FOREIGN KEY (history_id) REFERENCES file_history(id),
        FOREIGN KEY (dir_id) REFERENCES dirs(id)
      );

      CREATE INDEX IF NOT EXISTS idx_dirs_dirname ON dirs(dirname);
      CREATE INDEX IF NOT EXISTS idx_files_dir_id ON files(dir_id);
      CREATE INDEX IF NOT EXISTS idx_files_inode ON files(inode);
      CREATE INDEX IF NOT EXISTS idx_file_history_inode ON file_history(inode);
      CREATE INDEX IF NOT EXISTS idx_file_history_dir_id ON file_history(dir_id);
      CREATE INDEX IF NOT EXISTS idx_notifications_read_at ON notifications(read_at);
    `;

    this.db.exec(schema);

    // Runtime migration for existing databases created before files.mode existed
    const fileCols = this.db.prepare('PRAGMA table_info(files)').all();
    const hasModeCol = fileCols.some(col => col.name === 'mode');
    if (!hasModeCol) {
      this.db.exec('ALTER TABLE files ADD COLUMN mode INTEGER');
    }
  }

  /**
   * Upsert a directory entry
   */
  upsertDirectory(dirname, inode, category = 'Default', description = null, initials = null, tags = null) {
    const stmt = this.db.prepare(`
      INSERT INTO dirs (dirname, inode, category, description, initials, tags)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(dirname) DO UPDATE SET
        inode = excluded.inode,
        category = excluded.category,
        description = excluded.description,
        initials = excluded.initials,
        tags = excluded.tags
    `);

    return stmt.run(dirname, inode, category, description, initials, tags);
  }

  /**
   * Get or create a directory, returning its id
   */
  getOrCreateDirectory(dirname, inode, category = 'Default', description = null, initials = null) {
    // First, try to get existing directory
    const getStmt = this.db.prepare('SELECT id FROM dirs WHERE dirname = ?');
    const existing = getStmt.get(dirname);
    
    if (existing) {
      return existing.id;
    }

    // Create new directory
    this.upsertDirectory(dirname, inode, category, description, initials);
    
    // Return the id of the newly created directory
    const result = getStmt.get(dirname);
    return result.id;
  }

  /**
   * Get directory by dirname
   */
  getDirectory(dirname) {
    const stmt = this.db.prepare('SELECT * FROM dirs WHERE dirname = ?');
    return stmt.get(dirname);
  }

  /**
   * Get parent directory metadata for rendering ".." entry
   * Returns category and tags for the parent directory
   */
  getParentDirectoryInfo(currentDirPath) {
    const pathModule = require('path');
    const parentPath = pathModule.dirname(currentDirPath);
    
    // Check if at root (no parent)
    if (parentPath === currentDirPath) {
      return null;
    }
    
    return this.getDirectory(parentPath);
  }

  /**
   * Get directory by id
   */
  getDirById(id) {
    const stmt = this.db.prepare('SELECT * FROM dirs WHERE id = ?');
    return stmt.get(id);
  }

  /**
   * Update the initials label for a directory (max 2 chars)
   */
  updateDirectoryInitials(dirname, initials) {
    const stmt = this.db.prepare('UPDATE dirs SET initials = ? WHERE dirname = ?');
    return stmt.run(initials ? initials.slice(0, 2).toUpperCase() : null, dirname);
  }

  /**
   * Insert or update file metadata
   */
  upsertFile(fileData) {
    const stmt = this.db.prepare(`
      INSERT INTO files (inode, dir_id, filename, dateModified, dateCreated, size, mode, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(inode, dir_id) DO UPDATE SET
        filename = excluded.filename,
        dateModified = excluded.dateModified,
        dateCreated = excluded.dateCreated,
        size = excluded.size,
        mode = excluded.mode,
        tags = CASE WHEN excluded.tags IS NOT NULL THEN excluded.tags ELSE tags END
    `);

    return stmt.run(
      fileData.inode,
      fileData.dir_id,
      fileData.filename,
      fileData.dateModified || null,
      fileData.dateCreated || null,
      fileData.size || 0,
      fileData.mode ?? null,
      fileData.tags || null
    );
  }

  /**
   * Get all files in a directory by dir_id (before clearing)
   */
  getFilesByDirId(dir_id) {
    const stmt = this.db.prepare(`
      SELECT * FROM files WHERE dir_id = ?
    `);
    return stmt.all(dir_id);
  }

  /**
   * Get a file by inode and dir_id
   */
  getFileByInode(inode, dir_id) {
    const stmt = this.db.prepare(`
      SELECT * FROM files WHERE inode = ? AND dir_id = ?
    `);
    return stmt.get(inode, dir_id);
  }

  /**
   * Get a file by dir_id and filename
   */
  getFileByFilename(dir_id, filename) {
    const stmt = this.db.prepare(`
      SELECT * FROM files WHERE dir_id = ? AND filename = ?
    `);
    return stmt.get(dir_id, filename);
  }

  /**
   * Compare file state and return change metadata
   */
  compareFileState(currentEntry, dir_id) {
    const existingFile = this.getFileByInode(currentEntry.inode, dir_id);
    let changeState = 'unchanged';

    if (!existingFile) {
      // New file
      changeState = 'new';
    } else if (existingFile.dateModified !== currentEntry.dateModified) {
      // Date modified changed
      changeState = 'dateModified';
    }

    return {
      changeState
    };
  }

  /**
   * Update file modification date (for acknowledging changes)
   */
  updateFileModificationDate(inode, dir_id, newDateModified) {
    const stmt = this.db.prepare(`
      UPDATE files SET dateModified = ? WHERE inode = ? AND dir_id = ?
    `);
    return stmt.run(newDateModified, inode, dir_id);
  }

  /**
   * Update file checksum value and status
   */
  updateFileChecksum(inode, dir_id, checksumValue, checksumStatus) {
    const stmt = this.db.prepare(`
      UPDATE files SET checksumValue = ?, checksumStatus = ? WHERE inode = ? AND dir_id = ?
    `);
    return stmt.run(checksumValue, checksumStatus, inode, dir_id);
  }

  /**
   * Get previous checksum for a file
   */
  getFileChecksum(inode, dir_id) {
    const stmt = this.db.prepare(`
      SELECT checksumValue FROM files WHERE inode = ? AND dir_id = ?
    `);
    const result = stmt.get(inode, dir_id);
    return result ? result.checksumValue : null;
  }

  /**
   * Get all files in a directory (by dirname)
   */
  getFilesInDirectory(dirname) {
    const stmt = this.db.prepare(`
      SELECT f.*, d.category 
      FROM files f
      JOIN dirs d ON f.dir_id = d.id
      WHERE d.dirname = ?
      ORDER BY f.filename ASC
    `);
    return stmt.all(dirname);
  }

  /**
   * Delete all files for a directory (used before re-scanning)
   */
  clearDirectory(dirname) {
    const stmt = this.db.prepare(`
      DELETE FROM files WHERE dir_id = (SELECT id FROM dirs WHERE dirname = ?)
    `);
    return stmt.run(dirname);
  }

  /**
   * Delete a single file by inode and dir_id
   * Note: Does not delete file_history records to preserve audit trail
   */
  deleteFile(inode, dir_id) {
    const stmt = this.db.prepare(`
      DELETE FROM files WHERE inode = ? AND dir_id = ?
    `);
    return stmt.run(inode, dir_id);
  }

  /**
   * Get a single file by inode and dirname
   */
  getFile(inode, dirname) {
    const stmt = this.db.prepare(`
      SELECT f.*, d.category 
      FROM files f
      JOIN dirs d ON f.dir_id = d.id
      WHERE f.inode = ? AND d.dirname = ?
    `);
    return stmt.get(inode, dirname);
  }

  /**
   * Set category for a directory
   */
  setCategoryForDirectory(dirname, category) {
    const stmt = this.db.prepare('UPDATE dirs SET category = ? WHERE dirname = ?');
    return stmt.run(category, dirname);
  }

  /**
   * Get category for a directory
   */
  getCategoryForDirectory(dirname) {
    const stmt = this.db.prepare('SELECT category FROM dirs WHERE dirname = ?');
    const result = stmt.get(dirname);
    return result ? result.category : null;
  }

  /**
   * Add/update tags for a directory
   */
  updateDirectoryTags(dirname, tags) {
    const stmt = this.db.prepare('UPDATE dirs SET tags = ? WHERE dirname = ?');
    return stmt.run(tags, dirname);
  }

  /**
   * Update directory metadata (description, initials, tags)
   */
  updateDirectoryMetadata(dirname, { description = null, initials = null, tags = null } = {}) {
    const stmt = this.db.prepare('UPDATE dirs SET description = ?, initials = ?, tags = ? WHERE dirname = ?');
    return stmt.run(description, initials, tags, dirname);
  }

  /**
   * Add/update tags for a file
   */
  updateFileTags(inode, dir_id, tags) {
    const stmt = this.db.prepare('UPDATE files SET tags = ? WHERE inode = ? AND dir_id = ?');
    return stmt.run(tags, inode, dir_id);
  }

  /**
   * Add a tag to a directory (appends to existing tags JSON array, stored in files table dot entry)
   */
  addTagToDirectory(dirname, tagName) {
    const dirRow = this.db.prepare('SELECT id FROM dirs WHERE dirname = ?').get(dirname);
    if (!dirRow) return;
    const dir_id = dirRow.id;
    const row = this.db.prepare('SELECT tags FROM files WHERE dir_id = ? AND filename = ?').get(dir_id, '.');
    let current = [];
    if (row && row.tags) {
      try { current = JSON.parse(row.tags); } catch {}
      if (!Array.isArray(current)) current = [];
    }
    if (!current.includes(tagName)) current.push(tagName);
    this.db.prepare('UPDATE files SET tags = ? WHERE dir_id = ? AND filename = ?').run(JSON.stringify(current), dir_id, '.');
  }

  /**
   * Get tags for a directory (from files table dot entry)
   */
  getTagsForDirectory(dirname) {
    const dirRow = this.db.prepare('SELECT id FROM dirs WHERE dirname = ?').get(dirname);
    if (!dirRow) return null;
    const row = this.db.prepare('SELECT tags FROM files WHERE dir_id = ? AND filename = ?').get(dirRow.id, '.');
    return (row && row.tags) ? row.tags : null;
  }

  /**
   * Remove a tag from a file
   */
  removeTagFromFile(inode, dir_id, tagName) {
    const row = this.db.prepare('SELECT tags FROM files WHERE inode = ? AND dir_id = ?').get(inode, dir_id);
    let current = [];
    if (row && row.tags) {
      try { current = JSON.parse(row.tags); } catch {}
      if (!Array.isArray(current)) current = [];
    }
    current = current.filter(t => t !== tagName);
    const newTags = current.length > 0 ? JSON.stringify(current) : null;
    this.db.prepare('UPDATE files SET tags = ? WHERE inode = ? AND dir_id = ?').run(newTags, inode, dir_id);
  }

  /**
   * Remove a tag from a directory (from files table dot entry)
   */
  removeTagFromDirectory(dirname, tagName) {
    const dirRow = this.db.prepare('SELECT id FROM dirs WHERE dirname = ?').get(dirname);
    if (!dirRow) return;
    const dir_id = dirRow.id;
    const row = this.db.prepare('SELECT tags FROM files WHERE dir_id = ? AND filename = ?').get(dir_id, '.');
    let current = [];
    if (row && row.tags) {
      try { current = JSON.parse(row.tags); } catch {}
      if (!Array.isArray(current)) current = [];
    }
    current = current.filter(t => t !== tagName);
    const newTags = current.length > 0 ? JSON.stringify(current) : null;
    this.db.prepare('UPDATE files SET tags = ? WHERE dir_id = ? AND filename = ?').run(newTags, dir_id, '.');
  }

  /**
   * Add a tag to a file (appends to existing tags JSON array)
   */
  addTagToFile(inode, dir_id, tagName) {
    const row = this.db.prepare('SELECT tags FROM files WHERE inode = ? AND dir_id = ?').get(inode, dir_id);
    let current = [];
    if (row && row.tags) {
      try { current = JSON.parse(row.tags); } catch {}
      if (!Array.isArray(current)) current = [];
    }
    if (!current.includes(tagName)) current.push(tagName);
    this.db.prepare('UPDATE files SET tags = ? WHERE inode = ? AND dir_id = ?').run(JSON.stringify(current), inode, dir_id);
  }

  /**
   * Validate changeValue JSON against whitelist of allowed keys
   * Allowed keys: filename, dateModified, filesizeBytes, checksumValue, checksumStatus, dirname, category, status
   */
  validateChangeValue(changeValue) {
    const ALLOWED_KEYS = ['filename', 'dateModified', 'filesizeBytes', 'checksumValue', 'checksumStatus', 'dirname', 'category', 'status', 'mode'];
    
    // Check if it's valid JSON
    let obj;
    try {
      if (typeof changeValue === 'string') {
        obj = JSON.parse(changeValue);
      } else {
        obj = changeValue;
      }
    } catch (err) {
      throw new Error(`Invalid JSON in changeValue: ${err.message}`);
    }

    // Check that all keys are whitelisted
    const keys = Object.keys(obj);
    for (const key of keys) {
      if (!ALLOWED_KEYS.includes(key)) {
        throw new Error(`Invalid key in changeValue: ${key}. Allowed keys: ${ALLOWED_KEYS.join(', ')}`);
      }
    }

    // Ensure it's not empty
    if (keys.length === 0) {
      throw new Error('changeValue cannot be empty');
    }

    return obj;
  }

  /**
   * Insert a file history record
   * @param {string} inode - File inode
   * @param {number} dir_id - Directory ID
   * @param {number} file_id - File ID (foreign key to files table)
   * @param {object|string} changeValue - JSON object or string with file metadata/changes
   * @returns {object} Insert result with lastID
   */
  insertFileHistory(inode, dir_id, file_id, changeValue) {
    // Validate and stringify changeValue if needed
    const validatedChange = this.validateChangeValue(changeValue);
    const changeValueJson = typeof changeValue === 'string' ? changeValue : JSON.stringify(validatedChange);

    const stmt = this.db.prepare(`
      INSERT INTO file_history (inode, dir_id, file_id, changeValue, detectedAt)
      VALUES (?, ?, ?, ?, ?)
    `);

    return stmt.run(inode, dir_id, file_id, changeValueJson, Date.now());
  }

  /**
   * Update acknowledgedAt timestamp for a file history record
   * @param {number} historyId - ID of the file_history record to acknowledge
   * @returns {object} Update result
   */
  updateFileHistoryAcknowledgement(historyId) {
    const stmt = this.db.prepare(`
      UPDATE file_history SET acknowledgedAt = ? WHERE id = ?
    `);

    return stmt.run(Date.now(), historyId);
  }

  /**
   * Get the most recent file history record for an inode
   * @param {string} inode - File inode
   * @returns {object|null} Most recent history record
   */
  getLatestFileHistory(inode) {
    const stmt = this.db.prepare(`
      SELECT * FROM file_history WHERE inode = ? ORDER BY detectedAt DESC LIMIT 1
    `);
    return stmt.get(inode);
  }

  /**
   * Get all file history records for an inode, ordered by detectedAt DESC
   * @param {string} inode - File inode
   * @returns {array} Array of history records
   */
  getFileHistory(inode) {
    const stmt = this.db.prepare(`
      SELECT * FROM file_history WHERE inode = ? ORDER BY detectedAt DESC
    `);
    return stmt.all(inode);
  }

  /**
   * Check if an inode exists in any directory other than the excluded one
   * @param {string} inode - File inode
   * @param {number} exclude_dir_id - Directory ID to exclude from search
   * @returns {object|null} File record if found, null otherwise
   */
  findInodeInOtherDirectories(inode, exclude_dir_id) {
    const stmt = this.db.prepare(`
      SELECT f.*, d.id as dir_id_match FROM files f
      JOIN dirs d ON f.dir_id = d.id
      WHERE f.inode = ? AND f.dir_id != ?
      LIMIT 1
    `);
    return stmt.get(inode, exclude_dir_id);
  }

  /**
   * Create an orphan record for a file that was not found on filesystem
   * @param {number} dir_id - Directory ID where file was expected
   * @param {string} name - Filename of the orphan
   * @returns {object} Insert result with lastID
   */
  createOrphan(dir_id, name, inode) {
    const stmt = this.db.prepare(`
      INSERT INTO orphans (inode, dir_id, name, new_dir_id)
      VALUES (?, ?, ?, NULL)
    `);
    return stmt.run(inode, dir_id, name);
  }

  /**
   * Update an orphan record with the new directory location (when file move is detected)
   * @param {number} orphan_id - Orphan record ID
   * @param {number} new_dir_id - Directory ID where file was found
   * @returns {object} Update result
   */
  updateOrphanNewLocation(orphan_id, new_dir_id) {
    const stmt = this.db.prepare(`
      UPDATE orphans SET new_dir_id = ? WHERE id = ?
    `);
    return stmt.run(new_dir_id, orphan_id);
  }

  /**
   * Delete an orphan record (user acknowledgement)
   * @param {number} orphan_id - Orphan record ID to delete
   * @returns {object} Delete result
   */
  deleteOrphan(orphan_id) {
    const stmt = this.db.prepare(`
      DELETE FROM orphans WHERE id = ?
    `);
    return stmt.run(orphan_id);
  }

  /**
   * Get all orphan records for a directory
   * @param {number} dir_id - Directory ID
   * @returns {array} Array of orphan records
   */
  getOrphans(dir_id) {
    const stmt = this.db.prepare(`
      SELECT * FROM orphans WHERE dir_id = ?
    `);
    return stmt.all(dir_id);
  }

  // ============================================
  // Notifications
  // ============================================

  /**
   * Insert a notification record linked to a file_history entry
   */
  insertNotification(historyId, type, filename, category, dirId, inode, oldValue, newValue) {
    const stmt = this.db.prepare(`
      INSERT INTO notifications (history_id, type, filename, category, dir_id, inode, old_value, new_value, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(historyId, type, filename, category, dirId, inode, oldValue, newValue, Date.now());
  }

  /**
   * Get all notifications ordered by created_at DESC
   */
  getNotifications() {
    const stmt = this.db.prepare(`
      SELECT n.*, d.dirname
      FROM notifications n
      LEFT JOIN dirs d ON n.dir_id = d.id
      ORDER BY n.created_at DESC
    `);
    return stmt.all();
  }

  /**
   * Count unread notifications
   */
  getUnreadNotificationCount() {
    const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM notifications WHERE read_at IS NULL`);
    return stmt.get().count;
  }

  /**
   * Mark all notifications as read
   */
  markAllNotificationsRead() {
    const stmt = this.db.prepare(`UPDATE notifications SET read_at = ? WHERE read_at IS NULL`);
    return stmt.run(Date.now());
  }

  close() {
    if (this.db) {
      this.db.close();
    }
  }
}

module.exports = new DatabaseService();
