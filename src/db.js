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
        parent_id INTEGER,
        category TEXT DEFAULT 'Default',
        category_force INTEGER NOT NULL DEFAULT 0,
        description VARCHAR(256),
        initials VARCHAR(8),
        last_observed_at INTEGER,
        last_observed_source TEXT,
        FOREIGN KEY (parent_id) REFERENCES dirs(id)
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

      CREATE TABLE IF NOT EXISTS dir_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dir_id INTEGER NOT NULL,
        eventType TEXT NOT NULL,
        changeValue TEXT NOT NULL,
        detectedAt INTEGER NOT NULL,
        acknowledgedAt INTEGER,
        FOREIGN KEY (dir_id) REFERENCES dirs(id)
      );

      CREATE TABLE IF NOT EXISTS file_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inode TEXT NOT NULL,
        dir_id INTEGER NOT NULL,
        file_id INTEGER NOT NULL,
        dir_history_id INTEGER,
        eventType TEXT NOT NULL DEFAULT 'legacy',
        changeValue TEXT NOT NULL,
        detectedAt INTEGER,
        acknowledgedAt INTEGER,
        FOREIGN KEY (dir_id) REFERENCES dirs(id),
        FOREIGN KEY (file_id) REFERENCES files(id),
        FOREIGN KEY (dir_history_id) REFERENCES dir_history(id)
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

      CREATE TABLE IF NOT EXISTS dir_orphans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_dir_id INTEGER NOT NULL,
        dir_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        new_dir_id INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (parent_dir_id) REFERENCES dirs(id),
        FOREIGN KEY (dir_id) REFERENCES dirs(id),
        FOREIGN KEY (new_dir_id) REFERENCES dirs(id)
      );

      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER,
        history_id INTEGER,
        type TEXT NOT NULL,
        filename TEXT,
        category TEXT,
        dir_id INTEGER,
        inode TEXT,
        old_value TEXT,
        new_value TEXT,
        created_at INTEGER,
        acknowledged_at INTEGER,
        acknowledged_comment TEXT,
        FOREIGN KEY (rule_id) REFERENCES alert_rules(id),
        FOREIGN KEY (history_id) REFERENCES file_history(id),
        FOREIGN KEY (dir_id) REFERENCES dirs(id)
      );

      CREATE TABLE IF NOT EXISTS alert_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        categories TEXT NOT NULL DEFAULT 'ANY',
        tags TEXT NOT NULL DEFAULT 'ANY',
        attributes TEXT NOT NULL DEFAULT 'ANY',
        events TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS monitoring_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        categories TEXT NOT NULL DEFAULT 'ANY',
        tags TEXT NOT NULL DEFAULT 'ANY',
        attributes TEXT NOT NULL DEFAULT 'ANY',
        interval_value INTEGER NOT NULL,
        interval_unit TEXT NOT NULL,
        max_depth INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dirs_dirname ON dirs(dirname);
      CREATE INDEX IF NOT EXISTS idx_dirs_parent_id ON dirs(parent_id);
      CREATE INDEX IF NOT EXISTS idx_dirs_last_observed_at ON dirs(last_observed_at);
      CREATE INDEX IF NOT EXISTS idx_files_dir_id ON files(dir_id);
      CREATE INDEX IF NOT EXISTS idx_files_inode ON files(inode);
      CREATE INDEX IF NOT EXISTS idx_dir_history_dir_id ON dir_history(dir_id);
      CREATE INDEX IF NOT EXISTS idx_file_history_inode ON file_history(inode);
      CREATE INDEX IF NOT EXISTS idx_file_history_dir_id ON file_history(dir_id);
      CREATE INDEX IF NOT EXISTS idx_file_history_dir_history_id ON file_history(dir_history_id);
      CREATE INDEX IF NOT EXISTS idx_dir_orphans_parent_dir_id ON dir_orphans(parent_dir_id);
      CREATE INDEX IF NOT EXISTS idx_alerts_acknowledged_at ON alerts(acknowledged_at);
    `;

    this.db.exec(schema);

    const dirCols = this.db.prepare('PRAGMA table_info(dirs)').all();
    const hasCategoryForceCol = dirCols.some(col => col.name === 'category_force');
    if (!hasCategoryForceCol) {
      this.db.exec('ALTER TABLE dirs ADD COLUMN category_force INTEGER NOT NULL DEFAULT 0');
      this.db.exec("UPDATE dirs SET category_force = CASE WHEN category IS NOT NULL AND category != 'Default' THEN 1 ELSE 0 END");
    }

    // Runtime migration for existing databases created before files.mode existed
    const fileCols = this.db.prepare('PRAGMA table_info(files)').all();
    const hasModeCol = fileCols.some(col => col.name === 'mode');
    if (!hasModeCol) {
      this.db.exec('ALTER TABLE files ADD COLUMN mode INTEGER');
    }
    // Runtime migration for attributes column
    const hasAttributesCol = fileCols.some(col => col.name === 'attributes');
    if (!hasAttributesCol) {
      this.db.exec('ALTER TABLE files ADD COLUMN attributes TEXT');
    }

    const fileHistoryCols = this.db.prepare('PRAGMA table_info(file_history)').all();
    const hasDirHistoryIdCol = fileHistoryCols.some(col => col.name === 'dir_history_id');
    if (!hasDirHistoryIdCol) {
      this.db.exec('ALTER TABLE file_history ADD COLUMN dir_history_id INTEGER');
    }
    const hasEventTypeCol = fileHistoryCols.some(col => col.name === 'eventType');
    if (!hasEventTypeCol) {
      this.db.exec("ALTER TABLE file_history ADD COLUMN eventType TEXT NOT NULL DEFAULT 'legacy'");
    }

    const alertRuleCols = this.db.prepare('PRAGMA table_info(alert_rules)').all();
    const hasAlertRuleNameCol = alertRuleCols.some(col => col.name === 'name');
    if (!hasAlertRuleNameCol) {
      this.db.exec('ALTER TABLE alert_rules ADD COLUMN name TEXT');
    }
    this.populateMissingAlertRuleNames();
  }

  normalizeAlertRuleName(name) {
    return String(name || '').trim();
  }

  getAlertRuleNameSet(excludeId = null) {
    const rows = excludeId
      ? this.db.prepare('SELECT name FROM alert_rules WHERE id != ?').all(excludeId)
      : this.db.prepare('SELECT name FROM alert_rules').all();

    return new Set(
      rows
        .map(row => this.normalizeAlertRuleName(row.name).toLowerCase())
        .filter(Boolean)
    );
  }

  alertRuleNameExists(name, excludeId = null) {
    const normalizedName = this.normalizeAlertRuleName(name);
    if (!normalizedName) return false;

    const row = excludeId
      ? this.db.prepare('SELECT id FROM alert_rules WHERE id != ? AND lower(name) = lower(?) LIMIT 1').get(excludeId, normalizedName)
      : this.db.prepare('SELECT id FROM alert_rules WHERE lower(name) = lower(?) LIMIT 1').get(normalizedName);

    return !!row;
  }

  generateUniqueAlertRuleName(excludeId = null) {
    const existingNames = this.getAlertRuleNameSet(excludeId);
    let suffix = 1;

    while (existingNames.has(`alert ${suffix}`)) {
      suffix += 1;
    }

    return `Alert ${suffix}`;
  }

  populateMissingAlertRuleNames() {
    const rows = this.db.prepare('SELECT id, name FROM alert_rules ORDER BY id ASC').all();
    if (rows.length === 0) return;

    const updateStmt = this.db.prepare('UPDATE alert_rules SET name = ? WHERE id = ?');
    const existingNames = new Set(
      rows
        .map(row => this.normalizeAlertRuleName(row.name).toLowerCase())
        .filter(Boolean)
    );

    let suffix = 1;
    rows.forEach(row => {
      const currentName = this.normalizeAlertRuleName(row.name);
      if (currentName) return;

      while (existingNames.has(`alert ${suffix}`)) {
        suffix += 1;
      }

      const generatedName = `Alert ${suffix}`;
      updateStmt.run(generatedName, row.id);
      existingNames.add(generatedName.toLowerCase());
      suffix += 1;
    });
  }

  /**
   * Upsert a directory entry
   */
  upsertDirectory(dirname, inode, category = 'Default', description = null, initials = null, parentId = null, categoryForce = 0) {
    const stmt = this.db.prepare(`
      INSERT INTO dirs (dirname, inode, parent_id, category, category_force, description, initials)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dirname) DO UPDATE SET
        inode = excluded.inode,
        parent_id = excluded.parent_id,
        category = CASE WHEN dirs.category_force = 1 THEN dirs.category ELSE excluded.category END,
        category_force = CASE WHEN dirs.category_force = 1 THEN dirs.category_force ELSE excluded.category_force END,
        description = excluded.description,
        initials = excluded.initials
    `);

    return stmt.run(dirname, inode, parentId, category, categoryForce, description, initials);
  }

  /**
   * Get or create a directory, returning its id
   */
  getOrCreateDirectory(dirname, inode, category = 'Default', description = null, initials = null, categoryForce = 0) {
    // First, try to get existing directory
    const getStmt = this.db.prepare('SELECT id FROM dirs WHERE dirname = ?');
    const existing = getStmt.get(dirname);
    
    if (existing) {
      return existing.id;
    }

    // Create new directory
    const parentId = this.getParentDirectoryId(dirname);
    this.upsertDirectory(dirname, inode, category, description, initials, parentId, categoryForce);
    
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

  getDirectoryByInode(inode) {
    return this.db.prepare('SELECT * FROM dirs WHERE inode = ? LIMIT 1').get(inode);
  }

  getParentDirectoryId(dirname) {
    const parentPath = path.dirname(dirname);
    if (!parentPath || parentPath === dirname) {
      return null;
    }
    const parent = this.db.prepare('SELECT id FROM dirs WHERE dirname = ?').get(parentPath);
    return parent ? parent.id : null;
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

  updateDirectoryObservation(dirname, source, observedAt = Date.now()) {
    const stmt = this.db.prepare('UPDATE dirs SET last_observed_at = ?, last_observed_source = ? WHERE dirname = ?');
    return stmt.run(observedAt, source || null, dirname);
  }

  updateDirectoryPath(dirId, dirname, parentId = null) {
    const stmt = this.db.prepare('UPDATE dirs SET dirname = ?, parent_id = ? WHERE id = ?');
    return stmt.run(dirname, parentId, dirId);
  }

  updateDirectoryParent(dirname, parentId) {
    const stmt = this.db.prepare('UPDATE dirs SET parent_id = ? WHERE dirname = ?');
    return stmt.run(parentId, dirname);
  }

  getDirectoriesByParentId(parentId) {
    return this.db.prepare('SELECT * FROM dirs WHERE parent_id = ? ORDER BY dirname ASC').all(parentId);
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

  getDirectoryChildren(parentDirId) {
    return this.db.prepare('SELECT * FROM dirs WHERE parent_id = ? ORDER BY dirname ASC').all(parentDirId);
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
  setCategoryForDirectory(dirname, category, isForced = true) {
    const stmt = this.db.prepare('UPDATE dirs SET category = ?, category_force = ? WHERE dirname = ?');
    return stmt.run(category, isForced ? 1 : 0, dirname);
  }

  /**
   * Clear explicit category assignment for a directory
   */
  clearCategoryForDirectory(dirname) {
    const stmt = this.db.prepare("UPDATE dirs SET category = 'Default', category_force = 0 WHERE dirname = ?");
    return stmt.run(dirname);
  }

  /**
   * Get explicit category assignment metadata for a directory
   */
  getDirectoryCategoryAssignment(dirname) {
    const stmt = this.db.prepare('SELECT category, category_force FROM dirs WHERE dirname = ?');
    const result = stmt.get(dirname);
    if (!result) {
      return null;
    }

    return {
      category: result.category || 'Default',
      isForced: Boolean(result.category_force)
    };
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
    const dirRow = this.db.prepare('SELECT id, inode FROM dirs WHERE dirname = ?').get(dirname);
    if (!dirRow) return null;
    const existingDot = this.db.prepare('SELECT id FROM files WHERE dir_id = ? AND filename = ?').get(dirRow.id, '.');
    if (existingDot) {
      return this.db.prepare('UPDATE files SET tags = ? WHERE dir_id = ? AND filename = ?').run(tags, dirRow.id, '.');
    }
    return this.db.prepare('INSERT INTO files (inode, dir_id, filename, dateModified, dateCreated, size, mode, tags) VALUES (?, ?, ".", NULL, NULL, 0, NULL, ?)').run(dirRow.inode, dirRow.id, tags);
  }

  /**
   * Update directory metadata (description, initials, tags)
   */
  updateDirectoryMetadata(dirname, { description = null, initials = null } = {}) {
    const stmt = this.db.prepare('UPDATE dirs SET description = ?, initials = ? WHERE dirname = ?');
    return stmt.run(description, initials, dirname);
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
    const dirRow = this.db.prepare('SELECT id, inode FROM dirs WHERE dirname = ?').get(dirname);
    if (!dirRow) return;
    const { id: dir_id, inode } = dirRow;
    const row = this.db.prepare('SELECT tags FROM files WHERE dir_id = ? AND filename = ?').get(dir_id, '.');
    let current = [];
    if (row && row.tags) {
      try { current = JSON.parse(row.tags); } catch {}
      if (!Array.isArray(current)) current = [];
    }
    if (!current.includes(tagName)) current.push(tagName);
    const newTags = JSON.stringify(current);
    if (row) {
      this.db.prepare('UPDATE files SET tags = ? WHERE dir_id = ? AND filename = ?').run(newTags, dir_id, '.');
    } else {
      // Dot-entry doesn't exist yet (directory not yet scanned) — create it
      this.db.prepare('INSERT INTO files (inode, dir_id, filename, dateModified, dateCreated, size, mode, tags) VALUES (?, ?, \'.\', NULL, NULL, 0, NULL, ?)').run(inode, dir_id, newTags);
    }
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

  getTagsForDirectoryId(dirId) {
    const row = this.db.prepare('SELECT tags FROM files WHERE dir_id = ? AND filename = ?').get(dirId, '.');
    return (row && row.tags) ? row.tags : null;
  }

  getAttributesForDirectoryId(dirId) {
    const row = this.db.prepare('SELECT attributes FROM files WHERE dir_id = ? AND filename = ?').get(dirId, '.');
    return (row && row.attributes) ? row.attributes : null;
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
    if (!row) return; // No dot-entry means no tags to remove
    let current = [];
    if (row.tags) {
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
    const ALLOWED_KEYS = ['filename', 'dateModified', 'filesizeBytes', 'checksumValue', 'checksumStatus', 'dirname', 'category', 'status', 'mode', 'previousFilename', 'source', 'hasChanges', 'fileChanges', 'dirChanges', 'newPath', 'oldPath', 'parentDirname'];
    
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

  validateDirHistoryChangeValue(changeValue) {
    const ALLOWED_KEYS = ['dirname', 'source', 'hasChanges', 'fileChanges', 'dirChanges', 'status', 'category', 'oldPath', 'newPath', 'parentDirname'];

    let obj;
    try {
      obj = typeof changeValue === 'string' ? JSON.parse(changeValue) : changeValue;
    } catch (err) {
      throw new Error(`Invalid JSON in dir history changeValue: ${err.message}`);
    }

    const keys = Object.keys(obj || {});
    for (const key of keys) {
      if (!ALLOWED_KEYS.includes(key)) {
        throw new Error(`Invalid key in dir history changeValue: ${key}. Allowed keys: ${ALLOWED_KEYS.join(', ')}`);
      }
    }

    if (keys.length === 0) {
      throw new Error('dir history changeValue cannot be empty');
    }

    return obj;
  }

  insertDirHistory(dirId, eventType, changeValue, detectedAt = Date.now()) {
    const validatedChange = this.validateDirHistoryChangeValue(changeValue);
    const changeValueJson = typeof changeValue === 'string' ? changeValue : JSON.stringify(validatedChange);

    return this.db.prepare(`
      INSERT INTO dir_history (dir_id, eventType, changeValue, detectedAt)
      VALUES (?, ?, ?, ?)
    `).run(dirId, eventType, changeValueJson, detectedAt);
  }

  getDirectoryHistory(dirId) {
    return this.db.prepare(`
      SELECT * FROM dir_history WHERE dir_id = ? ORDER BY detectedAt DESC, id DESC
    `).all(dirId);
  }

  getLatestDirectoryHistory(dirId) {
    return this.db.prepare(`
      SELECT * FROM dir_history WHERE dir_id = ? ORDER BY detectedAt DESC, id DESC LIMIT 1
    `).get(dirId);
  }

  getLatestDirectoryObservation(dirId) {
    return this.db.prepare(`
      SELECT *
      FROM dir_history
      WHERE dir_id = ? AND eventType = 'dirOpened'
      ORDER BY detectedAt DESC, id DESC
      LIMIT 1
    `).get(dirId);
  }

  /**
   * Insert a file history record
   * @param {string} inode - File inode
   * @param {number} dir_id - Directory ID
   * @param {number} file_id - File ID (foreign key to files table)
   * @param {string} eventType - Event type identifier
   * @param {object|string} changeValue - JSON object or string with file metadata/changes
   * @param {number|null} dirHistoryId - Optional linked directory history row
   * @returns {object} Insert result with lastID
   */
  insertFileHistory(inode, dir_id, file_id, eventType, changeValue, dirHistoryId = null) {
    // Validate and stringify changeValue if needed
    const validatedChange = this.validateChangeValue(changeValue);
    const changeValueJson = typeof changeValue === 'string' ? changeValue : JSON.stringify(validatedChange);

    const stmt = this.db.prepare(`
      INSERT INTO file_history (inode, dir_id, file_id, dir_history_id, eventType, changeValue, detectedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    return stmt.run(inode, dir_id, file_id, dirHistoryId, eventType, changeValueJson, Date.now());
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
  getLatestFileHistory(inode, dirId = null) {
    if (dirId === null || typeof dirId === 'undefined') {
      return this.db.prepare(`
        SELECT * FROM file_history WHERE inode = ? ORDER BY detectedAt DESC, id DESC LIMIT 1
      `).get(inode);
    }

    return this.db.prepare(`
      SELECT * FROM file_history WHERE inode = ? AND dir_id = ? ORDER BY detectedAt DESC, id DESC LIMIT 1
    `).get(inode, dirId);
  }

  /**
   * Get all file history records for an inode, ordered by detectedAt DESC
   * @param {string} inode - File inode
   * @returns {array} Array of history records
   */
  getFileHistory(inode, dirId = null) {
    if (dirId === null || typeof dirId === 'undefined') {
      return this.db.prepare(`
        SELECT * FROM file_history WHERE inode = ? ORDER BY detectedAt DESC, id DESC
      `).all(inode);
    }

    return this.db.prepare(`
      SELECT * FROM file_history WHERE inode = ? AND dir_id = ? ORDER BY detectedAt DESC, id DESC
    `).all(inode, dirId);
  }

  findDirectoryInOtherParents(inode, excludeParentId) {
    return this.db.prepare(`
      SELECT *
      FROM dirs
      WHERE inode = ? AND COALESCE(parent_id, -1) != COALESCE(?, -1)
      LIMIT 1
    `).get(inode, excludeParentId);
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

  createDirOrphan(parentDirId, dirId, name) {
    return this.db.prepare(`
      INSERT INTO dir_orphans (parent_dir_id, dir_id, name, new_dir_id, created_at)
      VALUES (?, ?, ?, NULL, ?)
    `).run(parentDirId, dirId, name, Date.now());
  }

  updateDirOrphanNewLocation(orphanId, newDirId) {
    return this.db.prepare(`
      UPDATE dir_orphans SET new_dir_id = ? WHERE id = ?
    `).run(newDirId, orphanId);
  }

  deleteDirOrphan(orphanId) {
    return this.db.prepare('DELETE FROM dir_orphans WHERE id = ?').run(orphanId);
  }

  getDirOrphans(parentDirId) {
    return this.db.prepare(`
      SELECT * FROM dir_orphans WHERE parent_dir_id = ?
    `).all(parentDirId);
  }

  // ============================================
  // Alerts
  // ============================================

  /**
   * Insert an alert record linked to a file_history entry
   */
  insertAlert(ruleId, historyId, type, filename, category, dirId, inode, oldValue, newValue) {
    const stmt = this.db.prepare(`
      INSERT INTO alerts (rule_id, history_id, type, filename, category, dir_id, inode, old_value, new_value, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(ruleId, historyId, type, filename, category, dirId, inode, oldValue, newValue, Date.now());
  }

  /**
   * Get unacknowledged alerts (Summary tab)
   */
  getAlertsSummary() {
    const stmt = this.db.prepare(`
      SELECT a.*, d.dirname, ar.name AS rule_name
      FROM alerts a
      LEFT JOIN dirs d ON a.dir_id = d.id
      LEFT JOIN alert_rules ar ON a.rule_id = ar.id
      WHERE a.acknowledged_at IS NULL
      ORDER BY a.created_at DESC
    `);
    return stmt.all();
  }

  /**
   * Get acknowledged alerts (History tab)
   */
  getAlertsHistory() {
    const stmt = this.db.prepare(`
      SELECT a.*, d.dirname, ar.name AS rule_name
      FROM alerts a
      LEFT JOIN dirs d ON a.dir_id = d.id
      LEFT JOIN alert_rules ar ON a.rule_id = ar.id
      WHERE a.acknowledged_at IS NOT NULL
      ORDER BY a.acknowledged_at DESC
    `);
    return stmt.all();
  }

  /**
   * Count unacknowledged alerts
   */
  getUnacknowledgedAlertCount() {
    const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM alerts WHERE acknowledged_at IS NULL`);
    return stmt.get().count;
  }

  /**
   * Acknowledge a set of alerts by ID with an optional comment
   */
  acknowledgeAlerts(ids, comment) {
    if (!ids || ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    const now = Date.now();
    const commentVal = comment || null;
    const stmt = this.db.prepare(
      `UPDATE alerts SET acknowledged_at = ?, acknowledged_comment = ? WHERE id IN (${placeholders})`
    );
    return stmt.run(now, commentVal, ...ids);
  }

  // ============================================
  // Alert Rules
  // ============================================

  /**
   * Get all alert rules
   */
  getAlertRules() {
    return this.db.prepare('SELECT * FROM alert_rules ORDER BY id ASC').all();
  }

  /**
   * Save an alert rule (insert if no id, update if id provided)
   */
  saveAlertRule(rule) {
    const { id, categories, tags, attributes, events, enabled } = rule;
    const providedName = this.normalizeAlertRuleName(rule.name);
    const name = providedName || (!id ? this.generateUniqueAlertRuleName() : '');

    if (!name) {
      throw new Error('Alert rule name is required.');
    }

    if (this.alertRuleNameExists(name, id || null)) {
      throw new Error(`An alert named "${name}" already exists.`);
    }

    if (id) {
      this.db.prepare(
        'UPDATE alert_rules SET name=?, categories=?, tags=?, attributes=?, events=?, enabled=? WHERE id=?'
      ).run(name, categories, tags, attributes, events, enabled ? 1 : 0, id);
      return { id };
    } else {
      const result = this.db.prepare(
        'INSERT INTO alert_rules (name, categories, tags, attributes, events, enabled, created_at) VALUES (?,?,?,?,?,?,?)'
      ).run(name, categories, tags, attributes, events, enabled ? 1 : 0, Date.now());
      return { id: result.lastInsertRowid };
    }
  }

  /**
   * Delete alert rules by array of ids
   */
  deleteAlertRules(ids) {
    if (!ids || ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM alert_rules WHERE id IN (${placeholders})`).run(...ids);
  }

  getMonitoringRules() {
    return this.db.prepare('SELECT * FROM monitoring_rules ORDER BY id ASC').all();
  }

  saveMonitoringRule(rule) {
    const {
      id,
      categories,
      tags,
      attributes,
      interval_value,
      interval_unit,
      max_depth,
      enabled
    } = rule;

    if (id) {
      this.db.prepare(
        'UPDATE monitoring_rules SET categories=?, tags=?, attributes=?, interval_value=?, interval_unit=?, max_depth=?, enabled=? WHERE id=?'
      ).run(categories, tags, attributes, interval_value, interval_unit, max_depth, enabled ? 1 : 0, id);
      return { id };
    }

    const result = this.db.prepare(
      'INSERT INTO monitoring_rules (categories, tags, attributes, interval_value, interval_unit, max_depth, enabled, created_at) VALUES (?,?,?,?,?,?,?,?)'
    ).run(categories, tags, attributes, interval_value, interval_unit, max_depth, enabled ? 1 : 0, Date.now());
    return { id: result.lastInsertRowid };
  }

  deleteMonitoringRules(ids) {
    if (!ids || ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM monitoring_rules WHERE id IN (${placeholders})`).run(...ids);
  }

  getDirectoriesForMonitoring() {
    return this.db.prepare(`
      SELECT d.*, f.tags AS dot_tags, f.attributes AS dot_attributes
      FROM dirs d
      LEFT JOIN files f ON f.dir_id = d.id AND f.filename = '.'
      ORDER BY COALESCE(d.last_observed_at, 0) ASC, d.dirname ASC
    `).all();
  }

  /**
   * Get attribute values for a file
   */
  getFileAttributes(inode, dir_id) {
    const row = this.db.prepare('SELECT attributes FROM files WHERE inode = ? AND dir_id = ?').get(inode, dir_id);
    if (!row || !row.attributes) return {};
    try { return JSON.parse(row.attributes); } catch { return {}; }
  }

  /**
   * Set all attribute values for a file (replaces existing)
   */
  setFileAttributes(inode, dir_id, attributes) {
    const json = attributes && Object.keys(attributes).length > 0 ? JSON.stringify(attributes) : null;
    this.db.prepare('UPDATE files SET attributes = ? WHERE inode = ? AND dir_id = ?').run(json, inode, dir_id);
  }

  close() {
    if (this.db) {
      this.db.close();
    }
  }
}

module.exports = new DatabaseService();
