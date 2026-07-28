const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');
const logger = require('./logger');
const { normalizeLayer } = require('./gridLayoutStore');

const DB_PATH = path.join(os.homedir(), '.atlas-explorer', 'data.sqlite');
const CONFIG_DIR = path.join(os.homedir(), '.atlas-explorer');

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
    // Wait up to 5s for a lock instead of throwing SQLITE_BUSY immediately. The
    // app is single-process, but background work (monitoring, aggregators) and
    // the foreground can still briefly contend on writes.
    this.db.pragma('busy_timeout = 5000');
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
        initials_inherit INTEGER NOT NULL DEFAULT 0,
        initials_force INTEGER NOT NULL DEFAULT 0,
        display_name TEXT,
        display_name_inherit INTEGER NOT NULL DEFAULT 0,
        display_name_force INTEGER NOT NULL DEFAULT 0,
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
        original_path TEXT,
        staged_at INTEGER,
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

      CREATE TABLE IF NOT EXISTS todo_notes_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dir_id INTEGER NOT NULL,
        notes_path TEXT NOT NULL UNIQUE,
        mtime_ms INTEGER,
        content_hash TEXT,
        last_scanned_at INTEGER,
        FOREIGN KEY (dir_id) REFERENCES dirs(id)
      );

      CREATE TABLE IF NOT EXISTS todo_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        notes_file_id INTEGER NOT NULL,
        section_key TEXT NOT NULL,
        group_label TEXT NOT NULL DEFAULT '',
        group_index INTEGER NOT NULL DEFAULT 0,
        item_index INTEGER NOT NULL,
        level INTEGER NOT NULL DEFAULT 0,
        text TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        line_start INTEGER,
        text_hash TEXT NOT NULL,
        FOREIGN KEY (notes_file_id) REFERENCES todo_notes_files(id) ON DELETE CASCADE
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
      CREATE INDEX IF NOT EXISTS idx_todo_items_notes_file ON todo_items(notes_file_id);
      CREATE INDEX IF NOT EXISTS idx_todo_items_group_label ON todo_items(group_label);
      CREATE INDEX IF NOT EXISTS idx_todo_items_completed ON todo_items(completed);

      CREATE TABLE IF NOT EXISTS video_thumbnails (
        file_path TEXT NOT NULL UNIQUE,
        mtime INTEGER NOT NULL,
        thumbnail BLOB NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );

      CREATE TABLE IF NOT EXISTS dir_grid_layouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dirname TEXT NOT NULL UNIQUE,
        columns TEXT NOT NULL,
        sort_data TEXT NOT NULL DEFAULT '[]',
        saved_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );

      -- Board view geometry. Lives in SQLite rather than a flat sidecar; the
      -- reasoning (and the two flat-file approaches that were tried and rejected)
      -- is in agent-docs/DECISIONS.md#board-storage.
      --
      -- Unlike every other table here, these rows cannot be recomputed from the
      -- filesystem — a board arrangement is user intent with no other source.
      -- scripts/reinitialize-db.js must therefore back up before wiping.
      CREATE TABLE IF NOT EXISTS dir_boards (
        dirname TEXT PRIMARY KEY,
        grid_size INTEGER NOT NULL DEFAULT 16,
        tray_json TEXT NOT NULL DEFAULT '{}',
        saved_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );

      -- inode is stored alongside filename so a file renamed outside Atlas can be
      -- re-linked to its coordinates instead of orphaning them.
      CREATE TABLE IF NOT EXISTS board_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dirname TEXT NOT NULL,
        filename TEXT NOT NULL,
        inode TEXT,
        x INTEGER NOT NULL DEFAULT 0,
        y INTEGER NOT NULL DEFAULT 0,
        w INTEGER NOT NULL DEFAULT 0,
        h INTEGER NOT NULL DEFAULT 0,
        group_id INTEGER,
        levels_json TEXT NOT NULL DEFAULT '[]',
        UNIQUE(dirname, filename)
      );
      CREATE INDEX IF NOT EXISTS idx_board_items_dirname ON board_items(dirname);

      CREATE TABLE IF NOT EXISTS board_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dirname TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        collapsed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_board_groups_dirname ON board_groups(dirname);

      -- Annotations are the one board object that is not a file. They live on a
      -- separate layer, may overlap freely, and are non-interactive decoration.
      CREATE TABLE IF NOT EXISTS board_annotations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dirname TEXT NOT NULL,
        kind TEXT NOT NULL,
        points_json TEXT NOT NULL DEFAULT '[]',
        stroke TEXT NOT NULL DEFAULT '#333333',
        width INTEGER NOT NULL DEFAULT 2,
        z INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_board_annotations_dirname ON board_annotations(dirname);

      CREATE TABLE IF NOT EXISTS reminder_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        notes_file_id INTEGER NOT NULL,
        section_key TEXT NOT NULL,
        due_datetime TEXT,
        text TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        line_start INTEGER,
        text_hash TEXT NOT NULL,
        is_cohabitated INTEGER NOT NULL DEFAULT 0,
        linked_todo_line INTEGER,
        FOREIGN KEY (notes_file_id) REFERENCES todo_notes_files(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_reminder_items_notes_file ON reminder_items(notes_file_id);
      CREATE INDEX IF NOT EXISTS idx_reminder_items_due ON reminder_items(due_datetime);

      CREATE TABLE IF NOT EXISTS file_content (
        file_id INTEGER PRIMARY KEY,
        text TEXT,
        content_hash TEXT,
        source_mtime INTEGER,
        source_size INTEGER,
        extractor TEXT,
        status TEXT NOT NULL,
        error TEXT,
        extracted_at INTEGER NOT NULL,
        FOREIGN KEY (file_id) REFERENCES files(id)
      );

      CREATE TABLE IF NOT EXISTS mirrors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        local_dir   TEXT NOT NULL,
        local_name  TEXT NOT NULL,
        remote_path TEXT NOT NULL,
        direction   TEXT NOT NULL,
        policy      TEXT,
        sync_status       TEXT NOT NULL DEFAULT 'unknown',
        last_synced_at    INTEGER,
        last_synced_mtime INTEGER,
        last_synced_size  INTEGER,
        last_synced_md5   TEXT,
        tombstone_at      INTEGER,
        error_message     TEXT,
        last_evaluated_at      INTEGER,
        last_eval_remote_mtime INTEGER,
        last_eval_remote_size  INTEGER,
        origin     TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(local_dir, local_name)
      );
      CREATE INDEX IF NOT EXISTS idx_mirrors_local_dir   ON mirrors(local_dir);
      CREATE INDEX IF NOT EXISTS idx_mirrors_remote_path ON mirrors(remote_path);

      CREATE TABLE IF NOT EXISTS mirror_sidecars (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dir_path      TEXT NOT NULL UNIQUE,
        sidecar_mtime REAL,
        cached_copy   TEXT,
        updated_at    INTEGER
      );

      CREATE TABLE IF NOT EXISTS mirror_adoptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dir_path    TEXT NOT NULL,
        source      TEXT NOT NULL,
        payload     TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        resolved_at INTEGER,
        resolution  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mirror_adoptions_dir ON mirror_adoptions(dir_path);
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

    // Runtime migration: enforce one orphan row per (inode, dir_id).
    // Before adding the unique index we must collapse any existing duplicates that were
    // accumulated prior to the dedup fix. Keep the lowest-id row for each (inode, dir_id) pair.
    try {
      this.db.exec(`
        DELETE FROM orphans
        WHERE id NOT IN (
          SELECT MIN(id) FROM orphans GROUP BY inode, dir_id
        );
      `);
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orphans_inode_dir ON orphans(inode, dir_id);');
    } catch (err) {
      // Non-fatal: log and continue. Later createOrphan upserts will still avoid new duplicates.
      logger.error('Error migrating orphans uniqueness:', err.message);
    }
    // Same for dir_orphans: keep lowest id per (parent_dir_id, dir_id).
    try {
      this.db.exec(`
        DELETE FROM dir_orphans
        WHERE id NOT IN (
          SELECT MIN(id) FROM dir_orphans GROUP BY parent_dir_id, dir_id
        );
      `);
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_dir_orphans_parent_child ON dir_orphans(parent_dir_id, dir_id);');
    } catch (err) {
      logger.error('Error migrating dir_orphans uniqueness:', err.message);
    }

    // Runtime migration for existing databases created before reminder_items.completed existed
    const reminderItemCols = this.db.prepare('PRAGMA table_info(reminder_items)').all();
    const hasReminderCompletedCol = reminderItemCols.some(col => col.name === 'completed');
    if (!hasReminderCompletedCol) {
      this.db.exec('ALTER TABLE reminder_items ADD COLUMN completed INTEGER NOT NULL DEFAULT 0');
    }

    const alertRuleCols = this.db.prepare('PRAGMA table_info(alert_rules)').all();
    const hasAlertRuleNameCol = alertRuleCols.some(col => col.name === 'name');
    if (!hasAlertRuleNameCol) {
      this.db.exec('ALTER TABLE alert_rules ADD COLUMN name TEXT');
    }
    this.populateMissingAlertRuleNames();

    // Runtime migration: add label inheritance columns to dirs table
    const dirColNames = new Set(dirCols.map(c => c.name));
    if (!dirColNames.has('initials_inherit')) {
      this.db.exec('ALTER TABLE dirs ADD COLUMN initials_inherit INTEGER NOT NULL DEFAULT 0');
    }
    if (!dirColNames.has('initials_force')) {
      this.db.exec('ALTER TABLE dirs ADD COLUMN initials_force INTEGER NOT NULL DEFAULT 0');
    }
    if (!dirColNames.has('display_name')) {
      this.db.exec('ALTER TABLE dirs ADD COLUMN display_name TEXT');
    }
    if (!dirColNames.has('display_name_inherit')) {
      this.db.exec('ALTER TABLE dirs ADD COLUMN display_name_inherit INTEGER NOT NULL DEFAULT 0');
    }
    if (!dirColNames.has('display_name_force')) {
      this.db.exec('ALTER TABLE dirs ADD COLUMN display_name_force INTEGER NOT NULL DEFAULT 0');
    }

    // Tombstone migrations: dirs and files get a deleted_at timestamp instead
    // of being physically deleted. This keeps history/alert FK references valid
    // and enables the virtual ?trash view.
    if (!dirColNames.has('deleted_at')) {
      this.db.exec('ALTER TABLE dirs ADD COLUMN deleted_at INTEGER');
    }
    const fileColNames = new Set(this.db.prepare('PRAGMA table_info(files)').all().map(c => c.name));
    if (!fileColNames.has('deleted_at')) {
      this.db.exec('ALTER TABLE files ADD COLUMN deleted_at INTEGER');
    }

    // Migration: replace trash_staging table with inline columns on files.
    // original_path stores the absolute path at deletion time (needed for trash view display).
    // staged_at is set during the deletion window so crash recovery can finalize or roll back.
    if (!fileColNames.has('original_path')) {
      this.db.exec('ALTER TABLE files ADD COLUMN original_path TEXT');
    }
    if (!fileColNames.has('staged_at')) {
      this.db.exec('ALTER TABLE files ADD COLUMN staged_at INTEGER');
    }
    // If trash_staging still exists (pre-migration DB), copy its data into files and drop it.
    const hasStagingTable = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='trash_staging'"
    ).get();
    if (hasStagingTable) {
      this.db.exec(`
        UPDATE files
        SET original_path = (SELECT original_path FROM trash_staging WHERE file_id = files.id),
            staged_at     = (SELECT staged_at     FROM trash_staging WHERE file_id = files.id)
        WHERE id IN (SELECT file_id FROM trash_staging);
      `);
      // Restore dir_id from the sentinel back to the original directory
      this.db.exec(`
        UPDATE files
        SET dir_id = (SELECT original_dir_id FROM trash_staging WHERE file_id = files.id)
        WHERE id IN (SELECT file_id FROM trash_staging);
      `);
      this.db.exec('DROP TABLE trash_staging');
    }

    // Migration: add comment column to file_history and dir_history
    const fileHistoryColsNow = this.db.prepare('PRAGMA table_info(file_history)').all();
    const hasFileHistoryComment = fileHistoryColsNow.some(c => c.name === 'comment');
    if (!hasFileHistoryComment) {
      this.db.exec('ALTER TABLE file_history ADD COLUMN comment TEXT');
    }
    const dirHistoryCols = this.db.prepare('PRAGMA table_info(dir_history)').all();
    const hasDirHistoryComment = dirHistoryCols.some(c => c.name === 'comment');
    if (!hasDirHistoryComment) {
      this.db.exec('ALTER TABLE dir_history ADD COLUMN comment TEXT');
    }

    // Migration: XDG Trash support — soft-delete state machine columns.
    // trash_path  = absolute path inside ~/.local/share/Trash/files/ (NULL for legacy Windows deletes)
    // purged_at   = Unix ms timestamp when file was permanently wiped from disk (row kept for audit)
    // State machine:
    //   deleted_at=NULL  / trash_path=NULL  / purged_at=NULL  → Active
    //   deleted_at=set   / trash_path=NULL  / purged_at=NULL  → Legacy Windows delete (shell.trashItem)
    //   deleted_at=set   / trash_path=set   / purged_at=NULL  → Software trash (restorable)
    //   deleted_at=set   / trash_path=*     / purged_at=set   → Permanently deleted (audit row only)
    const latestFileCols  = new Set(this.db.prepare('PRAGMA table_info(files)').all().map(c => c.name));
    const latestDirCols   = new Set(this.db.prepare('PRAGMA table_info(dirs)').all().map(c => c.name));
    if (!latestFileCols.has('trash_path')) {
      this.db.exec('ALTER TABLE files ADD COLUMN trash_path TEXT');
    }
    if (!latestFileCols.has('purged_at')) {
      this.db.exec('ALTER TABLE files ADD COLUMN purged_at INTEGER');
    }
    if (!latestDirCols.has('trash_path')) {
      this.db.exec('ALTER TABLE dirs ADD COLUMN trash_path TEXT');
    }
    if (!latestDirCols.has('purged_at')) {
      this.db.exec('ALTER TABLE dirs ADD COLUMN purged_at INTEGER');
    }

    // Migration: atlas.json sync — stores the mtime of the last written/absorbed
    // atlas.json so the absorption check can skip files we wrote ourselves.
    if (!latestDirCols.has('atlas_json_mtime')) {
      this.db.exec('ALTER TABLE dirs ADD COLUMN atlas_json_mtime INTEGER');
    }

    // Startup sweep: file_content has no enforced FK (PRAGMA foreign_keys is
    // never enabled), so reclaim rows whose files row is gone.
    try {
      this.db.exec('DELETE FROM file_content WHERE file_id NOT IN (SELECT id FROM files)');
    } catch (err) {
      logger.error('Error sweeping orphaned file_content rows:', err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // atlas.json mtime tracking
  // ---------------------------------------------------------------------------

  /**
   * Store the mtime (ms) of the atlas.json most recently written or absorbed
   * for a directory.  Used by atlasJson.maybeAbsorb() to detect external edits.
   */
  setAtlasJsonMtime(dirname, mtime) {
    this.db.prepare('UPDATE dirs SET atlas_json_mtime = ? WHERE dirname = ?').run(mtime, dirname);
  }

  /**
   * Return the stored atlas.json mtime for a directory, or null if not set.
   */
  getAtlasJsonMtime(dirname) {
    const row = this.db.prepare('SELECT atlas_json_mtime FROM dirs WHERE dirname = ?').get(dirname);
    return row ? (row.atlas_json_mtime ?? null) : null;
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
   * Update all label fields for a directory (initials + display_name with inheritance flags)
   */
  updateDirectoryLabels(dirname, {
    initials = undefined,
    initialsInherit = undefined,
    initialsForce = undefined,
    displayName = undefined,
    displayNameInherit = undefined,
    displayNameForce = undefined
  } = {}) {
    const sets = [];
    const params = [];
    if (initials !== undefined) { sets.push('initials = ?'); params.push(initials ? initials.slice(0, 2).toUpperCase() : null); }
    if (initialsInherit !== undefined) { sets.push('initials_inherit = ?'); params.push(initialsInherit ? 1 : 0); }
    if (initialsForce !== undefined) { sets.push('initials_force = ?'); params.push(initialsForce ? 1 : 0); }
    if (displayName !== undefined) { sets.push('display_name = ?'); params.push(displayName || null); }
    if (displayNameInherit !== undefined) { sets.push('display_name_inherit = ?'); params.push(displayNameInherit ? 1 : 0); }
    if (displayNameForce !== undefined) { sets.push('display_name_force = ?'); params.push(displayNameForce ? 1 : 0); }
    if (sets.length === 0) return null;
    params.push(dirname);
    return this.db.prepare(`UPDATE dirs SET ${sets.join(', ')} WHERE dirname = ?`).run(...params);
  }

  /**
   * Resolve effective initials for a directory by walking up the ancestor chain.
   * Returns { value, isInherited, sourceDir } — fully recursive, broken only by
   * a forced value or an ancestor with initials_inherit = 0 that has initials.
   */
  resolveDirectoryInitials(dirPath) {
    const self = this.getDirectory(dirPath);
    if (!self) return { value: null, isInherited: false, sourceDir: null };

    // Forced: use own value regardless of ancestry
    if (self.initials_force) {
      return { value: self.initials || null, isInherited: false, sourceDir: dirPath };
    }

    // Walk up ancestor chain looking for an inheritable initials
    let current = path.dirname(dirPath);
    while (current && current !== dirPath) {
      const ancestor = this.getDirectory(current);
      if (ancestor) {
        if (ancestor.initials_force) {
          // Forced ancestor breaks the chain — only inherits if inherit is also on
          if (ancestor.initials_inherit && ancestor.initials) {
            return { value: ancestor.initials, isInherited: true, sourceDir: current };
          }
          break; // chain broken
        }
        if (ancestor.initials_inherit && ancestor.initials) {
          return { value: ancestor.initials, isInherited: true, sourceDir: current };
        }
        if (ancestor.initials && !ancestor.initials_inherit) {
          break; // ancestor has initials but doesn't inherit them — chain stops
        }
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }

    // Fall back to own stored value
    return { value: self.initials || null, isInherited: false, sourceDir: dirPath };
  }

  /**
   * Resolve effective display name for a directory by walking up the ancestor chain.
   * Returns { value, isInherited, sourceDir } — same walk-up rules as initials.
   */
  resolveDirectoryDisplayName(dirPath) {
    const self = this.getDirectory(dirPath);
    if (!self) return { value: null, isInherited: false, sourceDir: null };

    // Forced: use own value
    if (self.display_name_force) {
      return { value: self.display_name || null, isInherited: false, sourceDir: dirPath };
    }

    // Walk up
    let current = path.dirname(dirPath);
    while (current && current !== dirPath) {
      const ancestor = this.getDirectory(current);
      if (ancestor) {
        if (ancestor.display_name_force) {
          if (ancestor.display_name_inherit && ancestor.display_name) {
            return { value: ancestor.display_name, isInherited: true, sourceDir: current };
          }
          break;
        }
        if (ancestor.display_name_inherit && ancestor.display_name) {
          return { value: ancestor.display_name, isInherited: true, sourceDir: current };
        }
        if (ancestor.display_name && !ancestor.display_name_inherit) {
          break;
        }
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }

    return { value: self.display_name || null, isInherited: false, sourceDir: dirPath };
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
      SELECT * FROM files WHERE dir_id = ? AND deleted_at IS NULL
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
   * Update a file row's inode and metadata after an in-place sync replacement
   * (e.g. OneDrive hydration, Excel save dance). Tags, attributes, and all other
   * user-managed columns are preserved; checksum is reset since content changed.
   */
  replaceFileInode(fileId, newInode, fileData) {
    // Content changed with the replacement — drop the cached extraction so
    // the next scan re-marks it pending.
    this.db.prepare('DELETE FROM file_content WHERE file_id = ?').run(fileId);
    this.db.prepare(`
      UPDATE files
      SET inode = ?, filename = ?, dateModified = ?, dateCreated = ?, size = ?, mode = ?,
          checksumValue = NULL, checksumStatus = 'untracked'
      WHERE id = ?
    `).run(
      newInode,
      fileData.filename,
      fileData.dateModified || null,
      fileData.dateCreated || null,
      fileData.size || 0,
      fileData.mode ?? null,
      fileId
    );
  }

  getDirectoryChildren(parentDirId) {
    return this.db.prepare('SELECT * FROM dirs WHERE parent_id = ? AND deleted_at IS NULL ORDER BY dirname ASC').all(parentDirId);
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

  // ---------- Deep content search cache (file_content) ----------

  /**
   * Extraction metadata for every cached file in a directory, keyed by file_id.
   * Deliberately never selects the text column — this runs on the scan path
   * to derive contentPending, so it must stay cheap.
   * @returns {Map<number, { source_mtime: number, status: string, content_hash: string }>}
   */
  getContentMetaForDir(dirId) {
    const rows = this.db.prepare(`
      SELECT c.file_id, c.source_mtime, c.status, c.content_hash
      FROM file_content c
      JOIN files f ON f.id = c.file_id
      WHERE f.dir_id = ?
    `).all(dirId);
    const map = new Map();
    for (const row of rows) {
      map.set(row.file_id, { source_mtime: row.source_mtime, status: row.status, content_hash: row.content_hash });
    }
    return map;
  }

  /**
   * Insert or update the cached extracted text for a file.
   */
  upsertFileContent({ file_id, text, content_hash, source_mtime, source_size, extractor, status, error }) {
    return this.db.prepare(`
      INSERT INTO file_content (file_id, text, content_hash, source_mtime, source_size, extractor, status, error, extracted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_id) DO UPDATE SET
        text = excluded.text,
        content_hash = excluded.content_hash,
        source_mtime = excluded.source_mtime,
        source_size = excluded.source_size,
        extractor = excluded.extractor,
        status = excluded.status,
        error = excluded.error,
        extracted_at = excluded.extracted_at
    `).run(file_id, text ?? null, content_hash ?? null, source_mtime ?? null,
      source_size ?? null, extractor ?? null, status, error ?? null, Date.now());
  }

  /**
   * Refresh only the freshness columns after a no-op re-extraction (content
   * hash unchanged) so megabytes of identical text aren't rewritten into WAL.
   */
  touchFileContent(file_id, source_mtime) {
    return this.db.prepare(
      'UPDATE file_content SET source_mtime = ?, extracted_at = ? WHERE file_id = ?'
    ).run(source_mtime, Date.now(), file_id);
  }

  /**
   * Extraction status row for a single file (no text column).
   */
  getFileContentStatus(fileId) {
    return this.db.prepare(`
      SELECT file_id, content_hash, source_mtime, source_size, extractor, status, error, extracted_at
      FROM file_content WHERE file_id = ?
    `).get(fileId);
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
   * Return the raw DB rows needed to render a cached directory view without
   * hitting the filesystem.  Returns null when the directory has never been
   * scanned (i.e. no row in `dirs`).
   *
   * Row sets:
   *   dirRecord   — the dirs row for dirPath
   *   dotEntry    — the files row with filename='.' (stores the dir's own mtime)
   *   childDirs   — dirs rows whose parent_id matches, joined with their dot-entry
   *                 dates so callers don't need N extra queries
   *   files       — all non-dot file rows in this directory
   */
  getCachedDirectoryEntries(dirPath) {
    const dirRecord = this.getDirectory(dirPath);
    if (!dirRecord) return null;

    const dotEntry = this.db.prepare(
      `SELECT * FROM files WHERE dir_id = ? AND filename = '.' AND deleted_at IS NULL`
    ).get(dirRecord.id);

    const childDirs = this.db.prepare(`
      SELECT d.*,
             f.dateModified AS dir_date_modified,
             f.dateCreated  AS dir_date_created
      FROM dirs d
      LEFT JOIN files f ON f.dir_id = d.id AND f.filename = '.' AND f.deleted_at IS NULL
      WHERE d.parent_id = ? AND d.deleted_at IS NULL
      ORDER BY d.dirname ASC
    `).all(dirRecord.id);

    const files = this.db.prepare(
      `SELECT * FROM files WHERE dir_id = ? AND filename != '.' AND deleted_at IS NULL ORDER BY filename ASC`
    ).all(dirRecord.id);

    return { dirRecord, dotEntry, childDirs, files };
  }

  /**
   * Delete all files for a directory (used before re-scanning)
   */
  clearDirectory(dirname) {
    const clear = this.db.transaction((dirnameIn) => {
      this.db.prepare(`
        DELETE FROM file_content WHERE file_id IN (
          SELECT id FROM files WHERE dir_id = (SELECT id FROM dirs WHERE dirname = ?)
        )
      `).run(dirnameIn);
      return this.db.prepare(`
        DELETE FROM files WHERE dir_id = (SELECT id FROM dirs WHERE dirname = ?)
      `).run(dirnameIn);
    });
    return clear(dirname);
  }

  /**
   * Delete a single file by inode and dir_id
   * Note: Does not delete file_history records to preserve audit trail
   */
  deleteFile(inode, dir_id) {
    const del = this.db.transaction((inodeIn, dirIdIn) => {
      this.db.prepare(`
        DELETE FROM file_content WHERE file_id IN (
          SELECT id FROM files WHERE inode = ? AND dir_id = ?
        )
      `).run(inodeIn, dirIdIn);
      return this.db.prepare(`
        DELETE FROM files WHERE inode = ? AND dir_id = ?
      `).run(inodeIn, dirIdIn);
    });
    return del(inode, dir_id);
  }

  // ---------- Trash staging (user-initiated deletions) ----------
  //
  // Files pending in-app deletion are tombstoned in-place using the deleted_at
  // column. The original path is stored on the files row itself (original_path)
  // so the trash view can display it without a separate table. staged_at marks
  // the window between "trashItem started" and "deletion finalised" so crash
  // recovery can roll back or complete the operation on next startup.

  /**
   * Tombstone a directory row: set deleted_at on the dirs row and all files
   * within it, clean up derived orphan/dir-orphan records (whose FK targets
   * are the dirs row). All history/alert rows that reference this dir_id are
   * left intact — the dirs row itself is kept as a tombstone so those FK
   * references remain valid forever.
   *
   * Does NOT recursively tombstone child dirs — the scanner will detect them
   * as orphaned on the next pass (their parent's dirs row now has deleted_at
   * set so getDirectoryChildren will exclude it; they remain undeleted and
   * will be flagged as dir orphans if also missing from the filesystem).
   */
  tombstoneDirectoryRow(dirId, deletedAt = Date.now()) {
    const tombstone = this.db.transaction((id, ts) => {
      this.db.prepare('UPDATE dirs SET deleted_at = ? WHERE id = ?').run(ts, id);
      this.db.prepare('UPDATE files SET deleted_at = ? WHERE dir_id = ? AND deleted_at IS NULL').run(ts, id);
      // Remove derived orphan rows — these point at the deleted dir and would
      // cause FK-constraint errors or stale orphan view entries.
      this.db.prepare('DELETE FROM orphans WHERE dir_id = ?').run(id);
      this.db.prepare('DELETE FROM dir_orphans WHERE parent_dir_id = ? OR dir_id = ?').run(id, id);
      this.db.prepare('DELETE FROM todo_notes_files WHERE dir_id = ?').run(id);
    });
    tombstone(dirId, deletedAt);
  }

  /**
   * @deprecated Use tombstoneDirectoryRow. Left as an alias so any stale
   * callers outside this session don't crash. Will be removed in a future
   * cleanup pass.
   */
  purgeDirectoryRow(dirId) {
    this.tombstoneDirectoryRow(dirId);
  }

  /**
   * Stage a file for deletion: record the original path on the files row and
   * set staged_at to mark the in-progress window for crash recovery.
   * dir_id is NOT moved — it stays at the original directory.
   * Returns { file_id, filename } with the same shape as the old implementation.
   */
  stageFileForDeletion(inode, original_dir_id, original_path) {
    const stage = this.db.transaction((inodeIn, origDirId, origPath) => {
      const fileRow = this.db.prepare(
        'SELECT id, filename FROM files WHERE inode = ? AND dir_id = ?'
      ).get(inodeIn, origDirId);
      if (!fileRow) {
        throw new Error(`File row not found for inode=${inodeIn} dir_id=${origDirId}`);
      }
      this.db.prepare(
        'UPDATE files SET original_path = ?, staged_at = ? WHERE id = ?'
      ).run(origPath, Date.now(), fileRow.id);
      return { file_id: fileRow.id, filename: fileRow.filename };
    });
    return stage(inode, original_dir_id, original_path);
  }

  /**
   * Revert a staged deletion: clear staged_at and original_path.
   * Used when shell.trashItem fails after staging.
   * Returns { reverted: true } always (no sentinel dir to restore).
   */
  rollbackFileDeletion(file_id) {
    this.db.prepare(
      'UPDATE files SET staged_at = NULL, original_path = NULL WHERE id = ?'
    ).run(file_id);
    return { reverted: true };
  }

  /**
   * Finalize a staged deletion: set deleted_at and clear staged_at.
   * original_path is kept permanently for trash view display.
   * The file_history audit entry is written by the caller.
   */
  finalizeFileDeletion(file_id, deletedAt = Date.now()) {
    this.db.prepare(
      'UPDATE files SET deleted_at = ?, staged_at = NULL WHERE id = ?'
    ).run(deletedAt, file_id);
  }

  /**
   * List files currently staged for deletion (staged_at IS NOT NULL, not yet
   * tombstoned). Used at startup to finalize or roll back any in-flight
   * deletions from a previous crash.
   * Returns the same property names as the old trash_staging-based query so
   * the reconciliation code in main.js needs no changes.
   */
  getPendingDeletions() {
    return this.db.prepare(`
      SELECT id          AS file_id,
             inode,
             dir_id      AS original_dir_id,
             filename    AS original_filename,
             original_path,
             staged_at
      FROM files
      WHERE staged_at IS NOT NULL AND deleted_at IS NULL
    `).all();
  }

  // ---------- Drag & drop: move / copy ----------
  //
  // These transactions mirror the trash-staging pattern: callers perform the
  // filesystem operation first (or after staging) and invoke these helpers to
  // keep files/dirs rows consistent and to emit audit history entries tagged
  // with source: 'user-app'.

  /**
   * Reparent a files row to a new directory, optionally renaming it, and emit a
   * `fileMoved` file_history entry. The caller must ensure the destination
   * `dirs` row exists (use getOrCreateDirectory). Also clears any matching
   * orphan rows that may have been created by a background scan that already
   * observed the move.
   *
   * @param {object} params
   * @param {string} params.inode            File inode (unchanged by a same-drive rename).
   * @param {number} params.old_dir_id       Source dir id.
   * @param {number} params.new_dir_id       Destination dir id.
   * @param {string} params.new_filename     Destination filename (may equal the original).
   * @param {string} params.source_path      Absolute source path (for audit).
   * @param {string} params.target_path      Absolute destination path (for audit).
   * @param {string} [params.new_inode]      Destination inode when a cross-drive copy changed it.
   * @returns {{ file_id: number|null, filename: string|null, moved: boolean }}
   */
  moveFileRow({ inode, old_dir_id, new_dir_id, new_filename, source_path, target_path, new_inode }) {
    const run = this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT id, filename FROM files WHERE inode = ? AND dir_id = ?'
      ).get(inode, old_dir_id);
      if (!row) {
        // No row to move (e.g. folder, or the scan hadn't recorded it yet). Still
        // record an orphan cleanup so the UI stays consistent.
        this.db.prepare('DELETE FROM orphans WHERE inode = ? AND dir_id = ?').run(inode, old_dir_id);
        return { file_id: null, filename: null, moved: false };
      }
      const effectiveInode = new_inode || inode;
      this.db.prepare(
        'UPDATE files SET dir_id = ?, filename = ?, inode = ? WHERE id = ?'
      ).run(new_dir_id, new_filename, effectiveInode, row.id);
      this.db.prepare('DELETE FROM orphans WHERE inode = ? AND dir_id = ?').run(inode, old_dir_id);
      this.insertFileHistory(effectiveInode, new_dir_id, row.id, 'fileMoved', {
        filename: new_filename,
        previousFilename: row.filename,
        oldPath: source_path,
        newPath: target_path,
        source: 'user-app'
      });
      return { file_id: row.id, filename: row.filename, moved: true };
    });
    return run();
  }

  /**
   * Rewrite a dirs row (and every descendant dirs row) after a folder move on
   * disk. Updates `dirname` by prefix-replacement and re-parents the top-level
   * row. Emits a `folderMoved` dir_history entry. Safe to call even when the
   * descendant rows are many — all changes are inside a single transaction.
   *
   * @param {object} params
   * @param {string} params.old_dirname     Source absolute path (matches dirs.dirname).
   * @param {string} params.new_dirname     Destination absolute path.
   * @param {number|null} params.new_parent_id Parent dir id of the destination.
   */
  moveDirectoryTree({ old_dirname, new_dirname, new_parent_id }) {
    if (!old_dirname || !new_dirname) {
      throw new Error('moveDirectoryTree: old_dirname and new_dirname are required');
    }
    const run = this.db.transaction(() => {
      const topRow = this.db.prepare('SELECT id FROM dirs WHERE dirname = ?').get(old_dirname);
      // Descendant rewrite: match both '/' and '\' separators defensively.
      const oldPrefixFwd = old_dirname.replace(/[\\/]+$/, '') + '/';
      const oldPrefixBwd = old_dirname.replace(/[\\/]+$/, '') + '\\';
      const newPrefixFwd = new_dirname.replace(/[\\/]+$/, '') + '/';
      const newPrefixBwd = new_dirname.replace(/[\\/]+$/, '') + '\\';
      // Two passes so we can update each prefix independently without double-replacement.
      this.db.prepare(`
        UPDATE dirs
        SET dirname = ? || substr(dirname, length(?) + 1)
        WHERE dirname LIKE ? ESCAPE '\\'
      `).run(newPrefixFwd, oldPrefixFwd, oldPrefixFwd.replace(/[%_\\]/g, '\\$&') + '%');
      this.db.prepare(`
        UPDATE dirs
        SET dirname = ? || substr(dirname, length(?) + 1)
        WHERE dirname LIKE ? ESCAPE '\\'
      `).run(newPrefixBwd, oldPrefixBwd, oldPrefixBwd.replace(/[%_\\]/g, '\\$&') + '%');
      if (topRow) {
        this.db.prepare('UPDATE dirs SET dirname = ?, parent_id = ? WHERE id = ?')
          .run(new_dirname, new_parent_id, topRow.id);
        try {
          this.insertDirHistory(topRow.id, 'folderMoved', {
            dirname: new_dirname,
            oldPath: old_dirname,
            newPath: new_dirname,
            source: 'user-app'
          });
        } catch (_) { /* history is best-effort */ }
      }
      return { top_dir_id: topRow ? topRow.id : null };
    });
    return run();
  }

  /**
   * Insert a files row for a freshly-copied file and emit a `fileCopied`
   * file_history entry. The caller provides the new inode reported by the
   * filesystem after the copy.
   */
  insertCopiedFileRow({ new_inode, new_dir_id, new_filename, source_path, target_path, size = 0, mode = null, dateModified = null, dateCreated = null }) {
    const run = this.db.transaction(() => {
      const info = this.db.prepare(`
        INSERT INTO files (inode, dir_id, filename, dateModified, dateCreated, size, mode, tags)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(inode, dir_id) DO UPDATE SET
          filename = excluded.filename,
          dateModified = excluded.dateModified,
          dateCreated = excluded.dateCreated,
          size = excluded.size,
          mode = excluded.mode
      `).run(new_inode, new_dir_id, new_filename, dateModified, dateCreated, size, mode);
      const fileRow = this.db.prepare(
        'SELECT id FROM files WHERE inode = ? AND dir_id = ?'
      ).get(new_inode, new_dir_id);
      const fileId = fileRow ? fileRow.id : (info && info.lastInsertRowid) || null;
      if (fileId) {
        this.insertFileHistory(new_inode, new_dir_id, fileId, 'fileCopied', {
          filename: new_filename,
          oldPath: source_path,
          newPath: target_path,
          source: 'user-app'
        });
      }
      return { file_id: fileId };
    });
    return run();
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
    const ALLOWED_KEYS = ['filename', 'dateModified', 'filesizeBytes', 'checksumValue', 'checksumStatus', 'dirname', 'category', 'status', 'mode', 'previousFilename', 'source', 'hasChanges', 'fileChanges', 'dirChanges', 'newPath', 'oldPath', 'parentDirname', 'tags'];
    
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
    const ALLOWED_KEYS = ['dirname', 'source', 'hasChanges', 'fileChanges', 'dirChanges', 'status', 'category', 'oldPath', 'newPath', 'parentDirname', 'tags'];

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

  insertDirHistory(dirId, eventType, changeValue, detectedAt = Date.now(), comment = null) {
    const validatedChange = this.validateDirHistoryChangeValue(changeValue);
    const changeValueJson = typeof changeValue === 'string' ? changeValue : JSON.stringify(validatedChange);

    return this.db.prepare(`
      INSERT INTO dir_history (dir_id, eventType, changeValue, detectedAt, comment)
      VALUES (?, ?, ?, ?, ?)
    `).run(dirId, eventType, changeValueJson, detectedAt, comment || null);
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
  insertFileHistory(inode, dir_id, file_id, eventType, changeValue, dirHistoryId = null, comment = null) {
    // Validate and stringify changeValue if needed
    const validatedChange = this.validateChangeValue(changeValue);
    const changeValueJson = typeof changeValue === 'string' ? changeValue : JSON.stringify(validatedChange);

    const stmt = this.db.prepare(`
      INSERT INTO file_history (inode, dir_id, file_id, dir_history_id, eventType, changeValue, detectedAt, comment)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    return stmt.run(inode, dir_id, file_id, dirHistoryId, eventType, changeValueJson, Date.now(), comment || null);
  }

  updateHistoryComment(id, comment) {
    return this.db.prepare('UPDATE file_history SET comment = ? WHERE id = ?').run(comment || null, id);
  }

  updateDirHistoryComment(id, comment) {
    return this.db.prepare('UPDATE dir_history SET comment = ? WHERE id = ?').run(comment || null, id);
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
      WHERE f.inode = ? AND f.dir_id != ? AND f.deleted_at IS NULL
      LIMIT 1
    `);
    return stmt.get(inode, exclude_dir_id);
  }

  /**
   * Create an orphan record for a file that was not found on filesystem.
   * Idempotent: if an orphan row already exists for (inode, dir_id) returns the
   * existing row with isNew=false. Returns { id, isNew, new_dir_id } so callers
   * can emit history/alerts only on first detection.
   * @param {number} dir_id - Directory ID where file was expected
   * @param {string} name - Filename of the orphan
   * @param {string} inode - File inode
   * @returns {{id:number, isNew:boolean, new_dir_id:number|null}}
   */
  createOrphan(dir_id, name, inode) {
    const insert = this.db.prepare(`
      INSERT INTO orphans (inode, dir_id, name, new_dir_id)
      VALUES (?, ?, ?, NULL)
      ON CONFLICT(inode, dir_id) DO NOTHING
    `);
    const result = insert.run(inode, dir_id, name);
    if (result.changes > 0) {
      return { id: result.lastInsertRowid, isNew: true, new_dir_id: null };
    }
    const existing = this.db.prepare(
      'SELECT id, new_dir_id FROM orphans WHERE inode = ? AND dir_id = ?'
    ).get(inode, dir_id);
    return existing
      ? { id: existing.id, isNew: false, new_dir_id: existing.new_dir_id }
      : { id: null, isNew: false, new_dir_id: null };
  }

  /**
   * Delete an orphan record by the file it represents. Used when the user
   * deletes a file from within the app so the scan doesn't leave a stale
   * orphan row behind.
   */
  deleteOrphanByFile(inode, dir_id) {
    return this.db.prepare(
      'DELETE FROM orphans WHERE inode = ? AND dir_id = ?'
    ).run(inode, dir_id);
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
    const insert = this.db.prepare(`
      INSERT INTO dir_orphans (parent_dir_id, dir_id, name, new_dir_id, created_at)
      VALUES (?, ?, ?, NULL, ?)
      ON CONFLICT(parent_dir_id, dir_id) DO NOTHING
    `);
    const result = insert.run(parentDirId, dirId, name, Date.now());
    if (result.changes > 0) {
      return { id: result.lastInsertRowid, isNew: true, new_dir_id: null };
    }
    const existing = this.db.prepare(
      'SELECT id, new_dir_id FROM dir_orphans WHERE parent_dir_id = ? AND dir_id = ?'
    ).get(parentDirId, dirId);
    return existing
      ? { id: existing.id, isNew: false, new_dir_id: existing.new_dir_id }
      : { id: null, isNew: false, new_dir_id: null };
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
   * Merge attribute values for a file into the existing stored attributes.
   * String values are trimmed; keys set to '', null, or undefined are removed.
   * An empty result is stored as NULL.
   */
  setFileAttributes(inode, dir_id, attributes) {
    const existing = this.getFileAttributes(inode, dir_id);
    const merged = { ...existing, ...(attributes || {}) };
    for (const key of Object.keys(merged)) {
      const val = merged[key];
      if (val === null || val === undefined) {
        delete merged[key];
      } else if (typeof val === 'string') {
        const trimmed = val.trim();
        if (trimmed === '') delete merged[key];
        else merged[key] = trimmed;
      }
    }
    const json = Object.keys(merged).length > 0 ? JSON.stringify(merged) : null;
    this.db.prepare('UPDATE files SET attributes = ? WHERE inode = ? AND dir_id = ?').run(json, inode, dir_id);
  }

  // ============================================
  // TODO Aggregation
  // ============================================

  getTodoNotesFile(notesPath) {
    return this.db.prepare('SELECT * FROM todo_notes_files WHERE notes_path = ?').get(notesPath);
  }

  getAllTodoNotesFiles() {
    return this.db.prepare('SELECT * FROM todo_notes_files ORDER BY notes_path ASC').all();
  }

  upsertTodoNotesFile(notesPath, dirId, mtimeMs, contentHash) {
    const now = Date.now();
    const existing = this.getTodoNotesFile(notesPath);
    if (existing) {
      this.db.prepare(`
        UPDATE todo_notes_files SET dir_id = ?, mtime_ms = ?, content_hash = ?, last_scanned_at = ? WHERE id = ?
      `).run(dirId, mtimeMs, contentHash, now, existing.id);
      return existing.id;
    }
    const result = this.db.prepare(`
      INSERT INTO todo_notes_files (dir_id, notes_path, mtime_ms, content_hash, last_scanned_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(dirId, notesPath, mtimeMs, contentHash, now);
    return result.lastInsertRowid;
  }

  deleteTodoNotesFileByPath(notesPath) {
    const row = this.getTodoNotesFile(notesPath);
    if (!row) return;
    this.db.prepare('DELETE FROM todo_items WHERE notes_file_id = ?').run(row.id);
    this.db.prepare('DELETE FROM todo_notes_files WHERE id = ?').run(row.id);
  }

  replaceTodoItems(notesFileId, items) {
    const del = this.db.prepare('DELETE FROM todo_items WHERE notes_file_id = ?');
    const ins = this.db.prepare(`
      INSERT INTO todo_items
        (notes_file_id, section_key, group_label, group_index, item_index, level, text, completed, line_start, text_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = this.db.transaction((fileId, rows) => {
      del.run(fileId);
      for (const r of rows) {
        ins.run(
          fileId,
          r.section_key,
          r.group_label || '',
          r.group_index || 0,
          r.item_index,
          r.level || 0,
          r.text,
          r.completed ? 1 : 0,
          r.line_start ?? null,
          r.text_hash
        );
      }
    });
    tx(notesFileId, items);
  }

  getTodoAggregates({ includeCompleted = true } = {}) {
    const whereCompleted = includeCompleted ? '' : 'WHERE ti.completed = 0';
    return this.db.prepare(`
      SELECT
        ti.id, ti.notes_file_id, ti.section_key, ti.group_label, ti.group_index,
        ti.item_index, ti.level, ti.text, ti.completed, ti.line_start, ti.text_hash,
        tnf.notes_path, tnf.dir_id,
        d.dirname AS dirname
      FROM todo_items ti
      JOIN todo_notes_files tnf ON ti.notes_file_id = tnf.id
      LEFT JOIN dirs d ON tnf.dir_id = d.id
      ${whereCompleted}
      ORDER BY ti.group_label ASC, tnf.notes_path ASC, ti.section_key ASC, ti.group_index ASC, ti.item_index ASC
    `).all();
  }

  // ============================================
  // Reminder Items
  // ============================================

  replaceReminderItems(notesFileId, items) {
    const del = this.db.prepare('DELETE FROM reminder_items WHERE notes_file_id = ?');
    const ins = this.db.prepare(`
      INSERT INTO reminder_items
        (notes_file_id, section_key, due_datetime, text, completed, line_start, text_hash, is_cohabitated, linked_todo_line)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = this.db.transaction((fileId, rows) => {
      del.run(fileId);
      for (const r of rows) {
        ins.run(
          fileId,
          r.section_key,
          r.due_datetime || null,
          r.text,
          r.completed ? 1 : 0,
          r.line_start ?? null,
          r.text_hash,
          r.is_cohabitated ? 1 : 0,
          r.linked_todo_line ?? null
        );
      }
    });
    tx(notesFileId, items);
  }

  getReminderAggregates({ includeCompleted = true } = {}) {
    const whereCompleted = includeCompleted ? '' : 'WHERE ri.completed = 0';
    return this.db.prepare(`
      SELECT
        ri.id, ri.notes_file_id, ri.section_key, ri.due_datetime,
        ri.text, ri.completed, ri.line_start, ri.text_hash, ri.is_cohabitated, ri.linked_todo_line,
        tnf.notes_path, tnf.dir_id,
        d.dirname AS dirname
      FROM reminder_items ri
      JOIN todo_notes_files tnf ON ri.notes_file_id = tnf.id
      LEFT JOIN dirs d ON tnf.dir_id = d.id
      ${whereCompleted}
      ORDER BY ri.due_datetime ASC NULLS LAST, ri.line_start ASC
    `).all();
  }

  getCachedVideoThumbnail(filePath, mtime) {
    return this.db.prepare(
      'SELECT thumbnail FROM video_thumbnails WHERE file_path = ? AND mtime = ?'
    ).get(filePath, mtime) || null;
  }

  saveCachedVideoThumbnail(filePath, mtime, jpegBuffer) {
    this.db.prepare(
      'INSERT OR REPLACE INTO video_thumbnails (file_path, mtime, thumbnail) VALUES (?, ?, ?)'
    ).run(filePath, mtime, jpegBuffer);
  }

  // ============================================
  // Grid Layout (per-directory column/sort state)
  // ============================================

  // Stores a sparse v2 layer object (see gridLayoutStore.normalizeLayer) in the
  // `columns` column. `sort_data` is kept only to satisfy NOT NULL on legacy rows.
  saveDirGridLayout(dirname, layer) {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(
      `INSERT INTO dir_grid_layouts (dirname, columns, sort_data, saved_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(dirname) DO UPDATE SET
         columns = excluded.columns,
         sort_data = excluded.sort_data,
         saved_at = excluded.saved_at`
    ).run(dirname, JSON.stringify(layer), '[]', now);
  }

  getDirGridLayout(dirname) {
    const row = this.db.prepare(
      'SELECT columns, sort_data FROM dir_grid_layouts WHERE dirname = ?'
    ).get(dirname);
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.columns);
      // Legacy rows store a bare columns array with sort in sort_data
      if (Array.isArray(parsed)) {
        return normalizeLayer({ columns: parsed, sortData: JSON.parse(row.sort_data) });
      }
      return normalizeLayer(parsed);
    } catch (err) {
      logger.error('Error parsing dir grid layout row:', err.message);
      return null;
    }
  }

  deleteDirGridLayout(dirname) {
    this.db.prepare('DELETE FROM dir_grid_layouts WHERE dirname = ?').run(dirname);
  }

  // ============================================
  // Board layout (per-directory item geometry)
  // ============================================

  /**
   * Read a directory's whole board in one call. Returns null when the directory
   * has never been arranged, which callers treat as "everything is unplaced" —
   * an empty board and a nonexistent board are the same thing to the renderer.
   * @param {string} dirname
   * @returns {{gridSize:number, tray:object, items:object[], groups:object[], annotations:object[]}|null}
   */
  getDirBoard(dirname) {
    const board = this.db.prepare(
      'SELECT grid_size, tray_json FROM dir_boards WHERE dirname = ?'
    ).get(dirname);
    if (!board) return null;

    const items = this.db.prepare(
      `SELECT filename, inode, x, y, w, h, group_id AS groupId, levels_json
       FROM board_items WHERE dirname = ?`
    ).all(dirname);

    const groups = this.db.prepare(
      'SELECT id, label, collapsed FROM board_groups WHERE dirname = ?'
    ).all(dirname);

    const annotations = this.db.prepare(
      `SELECT id, kind, points_json, stroke, width, z
       FROM board_annotations WHERE dirname = ? ORDER BY z ASC`
    ).all(dirname);

    // A malformed JSON column must not take down the whole board — an item that
    // loses its detail levels is recoverable, an unrenderable directory is not.
    const safeParse = (raw, fallback) => {
      try { return JSON.parse(raw); } catch { return fallback; }
    };

    return {
      gridSize: board.grid_size,
      tray: safeParse(board.tray_json, {}),
      items: items.map(it => ({
        filename: it.filename,
        inode: it.inode,
        x: it.x, y: it.y, w: it.w, h: it.h,
        groupId: it.groupId,
        levels: safeParse(it.levels_json, [])
      })),
      groups: groups.map(g => ({ id: g.id, label: g.label, collapsed: !!g.collapsed })),
      annotations: annotations.map(a => ({
        id: a.id, kind: a.kind, points: safeParse(a.points_json, []),
        stroke: a.stroke, width: a.width, z: a.z
      }))
    };
  }

  /**
   * Replace a directory's board wholesale.
   *
   * Delete-then-insert rather than a per-row diff: a board is small (tens of
   * items) and always saved as a complete snapshot from the renderer, so a diff
   * would add reconciliation bugs for no measurable gain. Wrapped in a
   * transaction so a partial write can never leave a half-arranged board.
   *
   * @param {string} dirname
   * @param {{gridSize?:number, tray?:object, items?:object[], groups?:object[], annotations?:object[]}} boardData
   */
  saveDirBoard(dirname, boardData) {
    const {
      gridSize = 16, tray = {}, items = [], groups = [], annotations = []
    } = boardData || {};
    const now = Math.floor(Date.now() / 1000);

    const write = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO dir_boards (dirname, grid_size, tray_json, saved_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(dirname) DO UPDATE SET
           grid_size = excluded.grid_size,
           tray_json = excluded.tray_json,
           saved_at = excluded.saved_at`
      ).run(dirname, gridSize, JSON.stringify(tray), now);

      this.db.prepare('DELETE FROM board_items WHERE dirname = ?').run(dirname);
      this.db.prepare('DELETE FROM board_groups WHERE dirname = ?').run(dirname);
      this.db.prepare('DELETE FROM board_annotations WHERE dirname = ?').run(dirname);

      const insItem = this.db.prepare(
        `INSERT INTO board_items (dirname, filename, inode, x, y, w, h, group_id, levels_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const it of items) {
        insItem.run(
          dirname, it.filename, it.inode ?? null,
          it.x | 0, it.y | 0, it.w | 0, it.h | 0,
          it.groupId ?? null, JSON.stringify(it.levels || [])
        );
      }

      const insGroup = this.db.prepare(
        'INSERT INTO board_groups (id, dirname, label, collapsed) VALUES (?, ?, ?, ?)'
      );
      for (const g of groups) {
        insGroup.run(g.id ?? null, dirname, g.label || '', g.collapsed ? 1 : 0);
      }

      const insAnn = this.db.prepare(
        `INSERT INTO board_annotations (dirname, kind, points_json, stroke, width, z)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const a of annotations) {
        insAnn.run(dirname, a.kind, JSON.stringify(a.points || []), a.stroke || '#333333', a.width | 0 || 2, a.z | 0);
      }
    });

    write();
  }

  deleteDirBoard(dirname) {
    const wipe = this.db.transaction(() => {
      this.db.prepare('DELETE FROM board_items WHERE dirname = ?').run(dirname);
      this.db.prepare('DELETE FROM board_groups WHERE dirname = ?').run(dirname);
      this.db.prepare('DELETE FROM board_annotations WHERE dirname = ?').run(dirname);
      this.db.prepare('DELETE FROM dir_boards WHERE dirname = ?').run(dirname);
    });
    wipe();
  }

  /**
   * Count arranged directories. Used by scripts/reinitialize-db.js to decide
   * whether wiping the DB would destroy unrecoverable user intent.
   * @returns {number}
   */
  countDirBoards() {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM dir_boards').get();
    return row?.n || 0;
  }

  // ---------- Virtual view helpers ----------
  //
  // These methods power the ?orphans and ?trash URI query-param views. They
  // return entry arrays shaped like the scan result entries so the renderer
  // grid can consume them without special-casing.

  /**
   * Return all file orphan rows within `dirId` (and, if depth > 1, all
   * descendant dirs up to `depth` levels). Each entry has changeState:
   * 'orphan' or 'moved'. Tombstoned files are excluded.
   *
   * @param {number} dirId
   * @param {number} [depth=1]
   * @returns {object[]}
   */
  getOrphanViewEntries(dirId, depth = 1) {
    // Collect the set of dir IDs to include via a recursive walk limited by depth.
    const dirIds = this._collectDescendantDirIds(dirId, depth);

    const entries = [];

    // File orphans (missing files within collected dirs)
    const fileOrphans = this.db.prepare(`
      SELECT o.id AS orphan_id, o.inode, o.name AS filename, o.new_dir_id,
             f.size, f.dateModified, f.dateCreated, f.mode, f.id AS file_id,
             f.dir_id, f.tags, f.attributes
      FROM orphans o
      JOIN files f ON f.inode = o.inode AND f.dir_id = o.dir_id
      WHERE o.dir_id IN (${dirIds.map(() => '?').join(',')})
        AND f.deleted_at IS NULL
    `).all(...dirIds);

    for (const r of fileOrphans) {
      entries.push({
        inode: r.inode,
        filename: r.filename,
        isDirectory: false,
        size: r.size,
        dateModified: r.dateModified,
        dateCreated: r.dateCreated,
        mode: r.mode ?? null,
        path: this._buildFilePath(r.dir_id, r.filename),
        changeState: r.new_dir_id ? 'moved' : 'orphan',
        isStateTransition: false,
        orphan_id: r.orphan_id,
        new_dir_id: r.new_dir_id,
        dir_id: r.dir_id,
        tags: r.tags || null,
        attributes: r.attributes || null,
      });
    }

    // Dir orphans (missing sub-directories within collected dirs)
    const dirOrphans = this.db.prepare(`
      SELECT do.id AS orphan_id, do.name AS filename, do.new_dir_id,
             d.id AS dir_id, d.inode, d.dirname, d.initials, d.display_name
      FROM dir_orphans do
      JOIN dirs d ON d.id = do.dir_id
      WHERE do.parent_dir_id IN (${dirIds.map(() => '?').join(',')})
        AND d.deleted_at IS NULL
    `).all(...dirIds);

    for (const r of dirOrphans) {
      entries.push({
        inode: r.inode,
        filename: r.filename,
        isDirectory: true,
        size: 0,
        dateModified: null,
        dateCreated: null,
        mode: null,
        path: r.dirname,
        changeState: r.new_dir_id ? 'moved' : 'orphan',
        isStateTransition: false,
        orphan_id: r.orphan_id,
        new_dir_id: r.new_dir_id,
        dir_id: r.dir_id,
        initials: r.initials || null,
        resolvedInitials: this.resolveDirectoryInitials(r.dirname).value,
        displayName: r.display_name || null,
        tags: this.getTagsForDirectoryId(r.dir_id),
        attributes: this.getAttributesForDirectoryId(r.dir_id),
      });
    }

    return entries;
  }

  /**
   * Return scalar orphan count for badge display.
   * @param {number} dirId
   * @param {number} [depth=1]
   * @returns {number}
   */
  getOrphanCount(dirId, depth = 1) {
    const dirIds = this._collectDescendantDirIds(dirId, depth);
    const fileCount = this.db.prepare(
      `SELECT COUNT(*) AS n FROM orphans WHERE dir_id IN (${dirIds.map(() => '?').join(',')})`
    ).get(...dirIds).n;
    const dirCount = this.db.prepare(
      `SELECT COUNT(*) AS n FROM dir_orphans WHERE parent_dir_id IN (${dirIds.map(() => '?').join(',')})`
    ).get(...dirIds).n;
    return fileCount + dirCount;
  }

  /**
   * Return all tombstoned files and dirs that were originally children of
   * `dirId`. Each entry has changeState: 'deleted'.
   *
   * @param {number} dirId
   * @returns {object[]}
   */
  getTrashViewEntries(dirId) {
    const entries = [];

    // Tombstoned files in the original directory. original_path is stored
    // directly on the files row (set during stageFileForDeletion).
    const deletedFiles = this.db.prepare(`
      SELECT f.id AS file_id, f.inode, f.filename, f.size, f.dateModified,
             f.dateCreated, f.mode, f.tags, f.attributes, f.deleted_at,
             f.dir_id, f.original_path, f.staged_at
      FROM files f
      WHERE f.dir_id = ? AND f.deleted_at IS NOT NULL
    `).all(dirId);

    for (const r of deletedFiles) {
      entries.push({
        inode: r.inode,
        filename: r.filename,
        isDirectory: false,
        size: r.size,
        dateModified: r.dateModified,
        dateCreated: r.dateCreated,
        mode: r.mode ?? null,
        path: r.original_path || this._buildFilePath(r.dir_id, r.filename),
        changeState: 'deleted',
        isStateTransition: false,
        orphan_id: null,
        new_dir_id: null,
        dir_id: r.dir_id,
        deleted_at: r.deleted_at,
        staged_at: r.staged_at || null,
        tags: r.tags || null,
        attributes: r.attributes || null,
      });
    }

    // Tombstoned direct child dirs
    const deletedDirs = this.db.prepare(`
      SELECT d.id AS dir_id, d.inode, d.dirname, d.initials, d.display_name, d.deleted_at
      FROM dirs d
      WHERE d.parent_id = ? AND d.deleted_at IS NOT NULL
    `).all(dirId);

    for (const r of deletedDirs) {
      entries.push({
        inode: r.inode,
        filename: path.basename(r.dirname),
        isDirectory: true,
        size: 0,
        dateModified: null,
        dateCreated: null,
        mode: null,
        path: r.dirname,
        changeState: 'deleted',
        isStateTransition: false,
        orphan_id: null,
        new_dir_id: null,
        dir_id: r.dir_id,
        deleted_at: r.deleted_at,
        initials: r.initials || null,
        resolvedInitials: this.resolveDirectoryInitials(r.dirname).value,
        displayName: r.display_name || null,
        tags: this.getTagsForDirectoryId(r.dir_id),
        attributes: this.getAttributesForDirectoryId(r.dir_id),
      });
    }

    return entries;
  }

  /**
   * Return scalar trash count for badge display.
   * @param {number} dirId
   * @returns {number}
   */
  getTrashCount(dirId) {
    const fileCount = this.db.prepare(
      'SELECT COUNT(*) AS n FROM files WHERE dir_id = ? AND deleted_at IS NOT NULL'
    ).get(dirId).n;
    const dirCount = this.db.prepare(
      'SELECT COUNT(*) AS n FROM dirs WHERE parent_id = ? AND deleted_at IS NOT NULL'
    ).get(dirId).n;
    return fileCount + dirCount;
  }

  /**
   * Collect the dirId itself plus all descendant dir IDs up to `maxDepth`
   * levels deep (skipping tombstoned rows). Used internally for orphan
   * view scoping.
   * @private
   */
  _collectDescendantDirIds(rootDirId, maxDepth = 1) {
    const ids = [rootDirId];
    if (maxDepth <= 1) return ids;
    let frontier = [rootDirId];
    for (let d = 1; d < maxDepth; d++) {
      if (frontier.length === 0) break;
      const next = this.db.prepare(
        `SELECT id FROM dirs WHERE parent_id IN (${frontier.map(() => '?').join(',')}) AND deleted_at IS NULL`
      ).all(...frontier).map(r => r.id);
      ids.push(...next);
      frontier = next;
    }
    return ids;
  }

  /**
   * Build an absolute file path from a dir_id and filename. Used as a
   * fallback when no original_path is recorded on the files row.
   * @private
   */
  _buildFilePath(dirId, filename) {
    const dir = this.getDirById(dirId);
    return dir ? path.join(dir.dirname, filename) : filename;
  }

  // ============================================
  // Mirror items (see src/mirrors.js and agent-docs/DECISIONS.md)
  // ============================================
  //
  // mirrors.local_dir is a plain path string, deliberately NOT a dirs(id) FK:
  // the sidecar file is the recovery seed after a DB rebuild, so mirror rows
  // must be reconstructable without the dirs table surviving.

  getMirrorsForDir(dirPath) {
    return this.db.prepare(
      'SELECT * FROM mirrors WHERE local_dir = ? ORDER BY local_name ASC'
    ).all(dirPath);
  }

  getMirrorByLocal(dirPath, localName) {
    return this.db.prepare(
      'SELECT * FROM mirrors WHERE local_dir = ? AND local_name = ?'
    ).get(dirPath, localName) || null;
  }

  getMirrorById(id) {
    return this.db.prepare('SELECT * FROM mirrors WHERE id = ?').get(id) || null;
  }

  getAllMirrorDirs() {
    return this.db.prepare('SELECT DISTINCT local_dir FROM mirrors').all().map(r => r.local_dir);
  }

  insertMirror(decl) {
    const result = this.db.prepare(`
      INSERT INTO mirrors (local_dir, local_name, remote_path, direction, policy,
                           sync_status, origin, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decl.localDir, decl.localName, decl.remotePath, decl.direction,
      decl.policy ? JSON.stringify(decl.policy) : null,
      decl.syncStatus || 'unknown', decl.origin || null, Date.now()
    );
    return { id: result.lastInsertRowid };
  }

  /**
   * Patch state columns on a mirror row. Whitelisted so callers can't touch
   * declaration columns through the state path — declarations only change via
   * the adoption flow (updateMirrorDeclaration).
   */
  updateMirrorState(id, patch) {
    const allowed = [
      'sync_status', 'last_synced_at', 'last_synced_mtime', 'last_synced_size',
      'last_synced_md5', 'tombstone_at', 'error_message',
      'last_evaluated_at', 'last_eval_remote_mtime', 'last_eval_remote_size'
    ];
    const cols = Object.keys(patch).filter(k => allowed.includes(k));
    if (cols.length === 0) return;
    const setClause = cols.map(c => `${c} = ?`).join(', ');
    this.db.prepare(`UPDATE mirrors SET ${setClause} WHERE id = ?`)
      .run(...cols.map(c => patch[c]), id);
  }

  updateMirrorDeclaration(id, patch) {
    const allowed = ['local_name', 'remote_path', 'direction', 'policy'];
    const cols = Object.keys(patch).filter(k => allowed.includes(k));
    if (cols.length === 0) return;
    const setClause = cols.map(c => `${c} = ?`).join(', ');
    this.db.prepare(`UPDATE mirrors SET ${setClause} WHERE id = ?`)
      .run(...cols.map(c => patch[c]), id);
  }

  deleteMirror(id) {
    return this.db.prepare('DELETE FROM mirrors WHERE id = ?').run(id);
  }

  getMirrorSidecar(dirPath) {
    return this.db.prepare('SELECT * FROM mirror_sidecars WHERE dir_path = ?').get(dirPath) || null;
  }

  /**
   * Upsert sidecar bookkeeping: the mtime of the last file we wrote/absorbed
   * (atlasJson-style self-write skip) and the full text of the last-written
   * copy. Full text — not a hash — because the off-app-edit flow needs to
   * diff AND restore the previous content, not merely detect a change.
   */
  setMirrorSidecar(dirPath, { mtime, cachedCopy }) {
    this.db.prepare(`
      INSERT INTO mirror_sidecars (dir_path, sidecar_mtime, cached_copy, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(dir_path) DO UPDATE SET
        sidecar_mtime = excluded.sidecar_mtime,
        cached_copy   = excluded.cached_copy,
        updated_at    = excluded.updated_at
    `).run(dirPath, mtime ?? null, cachedCopy ?? null, Date.now());
  }

  deleteMirrorSidecar(dirPath) {
    return this.db.prepare('DELETE FROM mirror_sidecars WHERE dir_path = ?').run(dirPath);
  }

  createMirrorAdoption(dirPath, source, payload) {
    const result = this.db.prepare(`
      INSERT INTO mirror_adoptions (dir_path, source, payload, created_at)
      VALUES (?, ?, ?, ?)
    `).run(dirPath, source, JSON.stringify(payload), Date.now());
    return { id: result.lastInsertRowid };
  }

  getPendingAdoptionForDir(dirPath) {
    const row = this.db.prepare(`
      SELECT * FROM mirror_adoptions
      WHERE dir_path = ? AND resolved_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(dirPath);
    if (!row) return null;
    try { row.payload = JSON.parse(row.payload); } catch { row.payload = null; }
    return row;
  }

  getMirrorAdoptionById(id) {
    const row = this.db.prepare('SELECT * FROM mirror_adoptions WHERE id = ?').get(id);
    if (!row) return null;
    try { row.payload = JSON.parse(row.payload); } catch { row.payload = null; }
    return row;
  }

  resolveMirrorAdoption(id, resolution) {
    return this.db.prepare(
      'UPDATE mirror_adoptions SET resolved_at = ?, resolution = ? WHERE id = ?'
    ).run(Date.now(), resolution, id);
  }

  close() {
    if (this.db) {
      this.db.close();
    }
  }
}

module.exports = new DatabaseService();
