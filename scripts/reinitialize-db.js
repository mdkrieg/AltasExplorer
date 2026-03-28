#!/usr/bin/env node

/**
 * Reinitialize the database by removing all database files
 * and clearing cached data. The next app start will create a fresh database.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.atlasexplorer');
const DB_PATH = path.join(CONFIG_DIR, 'data.sqlite');
const DB_WAL = path.join(CONFIG_DIR, 'data.sqlite-wal');
const DB_SHM = path.join(CONFIG_DIR, 'data.sqlite-shm');

const filesToRemove = [
  { path: DB_PATH, name: 'data.sqlite' },
  { path: DB_WAL, name: 'data.sqlite-wal' },
  { path: DB_SHM, name: 'data.sqlite-shm' },
];

console.log('🔄 Reinitializing database...\n');

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

if (removedCount === 0) {
  console.log('ℹ No database files found to remove');
} else {
  console.log(`\n✓ Successfully removed ${removedCount} database file(s)`);
}

console.log('\nThe database will be reinitialized on the next app start.');
process.exit(0);
