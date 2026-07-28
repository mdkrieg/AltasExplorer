#!/usr/bin/env node

/**
 * Reinitialize the database by removing all database files
 * and clearing cached data. The next app start will create a fresh database.
 *
 * Almost everything in the DB is recomputable from the filesystem, which is why
 * wiping it has always been safe. Board layouts are the exception: a board
 * arrangement is user intent with no other source, so it cannot be rebuilt by
 * rescanning. When boards exist this script renames the DB aside instead of
 * deleting it, so the arrangement survives even though nothing can read it back
 * yet. Import-from-backup is deliberately not built until the need is real —
 * see agent-docs/DECISIONS.md#board-storage.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.atlas-explorer');
const DB_PATH = path.join(CONFIG_DIR, 'data.sqlite');
const DB_WAL = path.join(CONFIG_DIR, 'data.sqlite-wal');
const DB_SHM = path.join(CONFIG_DIR, 'data.sqlite-shm');

const filesToRemove = [
  { path: DB_PATH, name: 'data.sqlite' },
  { path: DB_WAL, name: 'data.sqlite-wal' },
  { path: DB_SHM, name: 'data.sqlite-shm' },
];

/**
 * How many directories have a saved board layout.
 * Returns 0 when the DB is absent, unreadable, or predates the board tables —
 * all of which mean "nothing irreplaceable to lose here".
 */
function countBoards() {
  if (!fs.existsSync(DB_PATH)) return 0;
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    return 0;
  }
  let db;
  try {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dir_boards'"
    ).get();
    if (!table) return 0;
    return db.prepare('SELECT COUNT(*) AS n FROM dir_boards').get()?.n || 0;
  } catch {
    return 0;
  } finally {
    try { db?.close(); } catch { /* never opened */ }
  }
}

function backupDatabase() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(CONFIG_DIR, `data.sqlite.backup-${stamp}`);
  fs.renameSync(DB_PATH, backupPath);
  return backupPath;
}

console.log('🔄 Reinitializing database...\n');

const boardCount = countBoards();
let backupPath = null;

if (boardCount > 0) {
  console.log(`⚠ ${boardCount} board layout(s) found.`);
  console.log('  Board arrangements cannot be recovered by rescanning the filesystem,');
  console.log('  so the database will be renamed instead of deleted.\n');
  try {
    backupPath = backupDatabase();
    console.log(`✓ Backed up database to ${path.basename(backupPath)}`);
  } catch (error) {
    console.error('✗ Failed to back up the database:', error.message);
    console.error('  Aborting so board layouts are not destroyed.');
    process.exit(1);
  }
}

let removedCount = 0;
filesToRemove.forEach(({ path: filePath, name }) => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`✓ Removed ${name}`);
      removedCount++;
    }
  } catch (error) {
    console.error(`✗ Failed to remove ${name}:`, error.message);
    process.exit(1);
  }
});

if (removedCount === 0 && !backupPath) {
  console.log('ℹ No database files found to remove');
} else if (removedCount > 0) {
  console.log(`\n✓ Successfully removed ${removedCount} database file(s)`);
}

if (backupPath) {
  console.log(`\nℹ Your previous database is at:\n  ${backupPath}`);
}

console.log('\nThe database will be reinitialized on the next app start.');
process.exit(0);
