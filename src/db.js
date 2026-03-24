const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');

const DB_PATH = path.join(os.homedir(), '.bestexplorer', 'data.sqlite');
const CONFIG_DIR = path.join(os.homedir(), '.bestexplorer');

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
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inode TEXT NOT NULL,
        dirname TEXT NOT NULL,
        filename TEXT NOT NULL,
        dateModified INTEGER,
        dateCreated INTEGER,
        size INTEGER,
        categoryName TEXT DEFAULT 'Default',
        UNIQUE(inode, dirname)
      );

      CREATE INDEX IF NOT EXISTS idx_dirname ON files(dirname);
      CREATE INDEX IF NOT EXISTS idx_inode ON files(inode);
    `;

    this.db.exec(schema);
  }

  /**
   * Insert or update file metadata
   */
  upsertFile(fileData) {
    const stmt = this.db.prepare(`
      INSERT INTO files (inode, dirname, filename, dateModified, dateCreated, size, categoryName)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(inode, dirname) DO UPDATE SET
        filename = excluded.filename,
        dateModified = excluded.dateModified,
        dateCreated = excluded.dateCreated,
        size = excluded.size,
        categoryName = excluded.categoryName
    `);

    return stmt.run(
      fileData.inode,
      fileData.dirname,
      fileData.filename,
      fileData.dateModified || null,
      fileData.dateCreated || null,
      fileData.size || 0,
      fileData.categoryName || 'Default'
    );
  }

  /**
   * Get all files in a directory
   */
  getFilesInDirectory(dirname) {
    const stmt = this.db.prepare('SELECT * FROM files WHERE dirname = ? ORDER BY filename ASC');
    return stmt.all(dirname);
  }

  /**
   * Delete all files for a directory (used before re-scanning)
   */
  clearDirectory(dirname) {
    const stmt = this.db.prepare('DELETE FROM files WHERE dirname = ?');
    return stmt.run(dirname);
  }

  /**
   * Get a single file by inode and dirname
   */
  getFile(inode, dirname) {
    const stmt = this.db.prepare('SELECT * FROM files WHERE inode = ? AND dirname = ?');
    return stmt.get(inode, dirname);
  }

  /**
   * Batch update category for files matching a directory pattern
   */
  updateCategoryForDirectory(dirname, categoryName) {
    const stmt = this.db.prepare('UPDATE files SET categoryName = ? WHERE dirname = ?');
    return stmt.run(categoryName, dirname);
  }

  close() {
    if (this.db) {
      this.db.close();
    }
  }
}

module.exports = new DatabaseService();
