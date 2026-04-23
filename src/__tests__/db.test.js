/**
 * @file Unit tests for the move/copy DB helpers used by drag-and-drop.
 *
 * Strategy: instead of calling `db.initialize()` (which writes to ~/.atlasexplorer),
 * we plug an in-memory better-sqlite3 connection into the singleton and run the
 * service's own `createSchema()` so the tests use the real schema.
 */

jest.mock('../logger');

// better-sqlite3 ships a native binding that is rebuilt for Electron's Node
// ABI. When jest runs under plain Node and the binding doesn't match, skip the
// whole suite instead of producing noisy failures unrelated to this code.
let Database;
let bindingOk = true;
try {
  Database = require('better-sqlite3');
  const probe = new Database(':memory:');
  probe.close();
} catch (_) {
  bindingOk = false;
}

const describeIfBinding = bindingOk ? describe : describe.skip;

const db = require('../db');

function freshDb() {
  // Close any prior in-memory connection between tests for isolation.
  if (db.db) {
    try { db.db.close(); } catch (_) { /* ignore */ }
  }
  db.db = new Database(':memory:');
  db.createSchema();
}

function insertDir(dirname, parent_id = null, inode = '1000') {
  const info = db.db.prepare(
    'INSERT INTO dirs (inode, dirname, parent_id) VALUES (?, ?, ?)'
  ).run(inode, dirname, parent_id);
  return info.lastInsertRowid;
}

function insertFile(inode, dir_id, filename) {
  const info = db.db.prepare(
    'INSERT INTO files (inode, dir_id, filename, size) VALUES (?, ?, ?, 0)'
  ).run(inode, dir_id, filename);
  return info.lastInsertRowid;
}

describeIfBinding('DatabaseService - moveFileRow()', () => {
  beforeEach(() => freshDb());
  afterAll(() => { try { db.db.close(); } catch (_) {} db.db = null; });

  it('updates the files row, deletes orphans, and writes a fileMoved history entry', () => {
    const oldDir = insertDir('/src');
    const newDir = insertDir('/dst');
    const fileId = insertFile('inode-1', oldDir, 'a.txt');
    // Seed an orphan to verify it gets cleaned up.
    db.db.prepare('INSERT INTO orphans (inode, dir_id, name) VALUES (?, ?, ?)')
      .run('inode-1', oldDir, 'a.txt');

    const result = db.moveFileRow({
      inode: 'inode-1',
      old_dir_id: oldDir,
      new_dir_id: newDir,
      new_filename: 'a.txt',
      source_path: '/src/a.txt',
      target_path: '/dst/a.txt',
    });

    expect(result).toEqual({ file_id: fileId, filename: 'a.txt', moved: true });

    const movedRow = db.db.prepare('SELECT dir_id, filename, inode FROM files WHERE id = ?').get(fileId);
    expect(movedRow).toEqual({ dir_id: newDir, filename: 'a.txt', inode: 'inode-1' });

    const orphans = db.db.prepare('SELECT * FROM orphans').all();
    expect(orphans).toHaveLength(0);

    const history = db.db.prepare(
      "SELECT eventType, changeValue FROM file_history WHERE file_id = ?"
    ).all(fileId);
    expect(history).toHaveLength(1);
    expect(history[0].eventType).toBe('fileMoved');
    const change = JSON.parse(history[0].changeValue);
    expect(change).toMatchObject({
      filename: 'a.txt',
      oldPath: '/src/a.txt',
      newPath: '/dst/a.txt',
      source: 'user-app',
    });
  });

  it('captures previousFilename when the file is renamed during the move', () => {
    const oldDir = insertDir('/src');
    const newDir = insertDir('/dst');
    insertFile('inode-2', oldDir, 'old-name.txt');

    db.moveFileRow({
      inode: 'inode-2',
      old_dir_id: oldDir,
      new_dir_id: newDir,
      new_filename: 'new-name.txt',
      source_path: '/src/old-name.txt',
      target_path: '/dst/new-name.txt',
    });

    const change = JSON.parse(
      db.db.prepare("SELECT changeValue FROM file_history WHERE eventType = 'fileMoved'").get().changeValue
    );
    expect(change.previousFilename).toBe('old-name.txt');
    expect(change.filename).toBe('new-name.txt');
  });

  it('uses new_inode when provided (cross-device moves)', () => {
    const oldDir = insertDir('/src');
    const newDir = insertDir('/dst');
    const fileId = insertFile('inode-3', oldDir, 'x.txt');

    db.moveFileRow({
      inode: 'inode-3',
      old_dir_id: oldDir,
      new_dir_id: newDir,
      new_filename: 'x.txt',
      source_path: '/src/x.txt',
      target_path: '/dst/x.txt',
      new_inode: 'inode-3-new',
    });

    const row = db.db.prepare('SELECT inode FROM files WHERE id = ?').get(fileId);
    expect(row.inode).toBe('inode-3-new');
  });

  it('returns moved:false and writes no history when the source row is missing', () => {
    const oldDir = insertDir('/src');
    const newDir = insertDir('/dst');
    // No files row inserted — simulates a folder move or pre-scan state.
    db.db.prepare('INSERT INTO orphans (inode, dir_id, name) VALUES (?, ?, ?)')
      .run('ghost', oldDir, 'ghost.txt');

    const result = db.moveFileRow({
      inode: 'ghost',
      old_dir_id: oldDir,
      new_dir_id: newDir,
      new_filename: 'ghost.txt',
      source_path: '/src/ghost.txt',
      target_path: '/dst/ghost.txt',
    });

    expect(result).toEqual({ file_id: null, filename: null, moved: false });
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM file_history').get().n).toBe(0);
    // Orphan still gets cleaned up.
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM orphans').get().n).toBe(0);
  });
});

describeIfBinding('DatabaseService - moveDirectoryTree()', () => {
  beforeEach(() => freshDb());
  afterAll(() => { try { db.db.close(); } catch (_) {} db.db = null; });

  it('rewrites descendant paths (forward slash) and reparents the top row', () => {
    const parent = insertDir('/dst');
    const top = insertDir('/src/folder');
    insertDir('/src/folder/child', top);
    insertDir('/src/folder/child/grand', top);

    const result = db.moveDirectoryTree({
      old_dirname: '/src/folder',
      new_dirname: '/dst/folder',
      new_parent_id: parent,
    });

    expect(result.top_dir_id).toBe(top);

    const rows = db.db.prepare('SELECT dirname, parent_id FROM dirs WHERE id = ?').all(top);
    expect(rows[0].dirname).toBe('/dst/folder');
    expect(rows[0].parent_id).toBe(parent);

    const child = db.db.prepare("SELECT dirname FROM dirs WHERE dirname LIKE '/dst/folder/%'").all();
    const childPaths = child.map(r => r.dirname).sort();
    expect(childPaths).toEqual(['/dst/folder/child', '/dst/folder/child/grand']);

    const history = db.db.prepare(
      "SELECT eventType, changeValue FROM dir_history WHERE dir_id = ?"
    ).all(top);
    expect(history).toHaveLength(1);
    expect(history[0].eventType).toBe('folderMoved');
    expect(JSON.parse(history[0].changeValue)).toMatchObject({
      dirname: '/dst/folder',
      oldPath: '/src/folder',
      newPath: '/dst/folder',
      source: 'user-app',
    });
  });

  it('rewrites descendant paths that use backslashes (Windows)', () => {
    const parent = insertDir('C:\\dst');
    const top = insertDir('C:\\src\\folder');
    insertDir('C:\\src\\folder\\child', top);

    db.moveDirectoryTree({
      old_dirname: 'C:\\src\\folder',
      new_dirname: 'C:\\dst\\folder',
      new_parent_id: parent,
    });

    const child = db.db.prepare("SELECT dirname FROM dirs WHERE dirname LIKE 'C:\\dst\\folder%' ESCAPE '\\'").all();
    // top + 1 child.
    expect(child.map(r => r.dirname).sort()).toEqual(['C:\\dst\\folder', 'C:\\dst\\folder\\child']);
  });

  it('throws when either name is missing', () => {
    expect(() => db.moveDirectoryTree({ old_dirname: '', new_dirname: '/x', new_parent_id: null }))
      .toThrow(/old_dirname and new_dirname/);
    expect(() => db.moveDirectoryTree({ old_dirname: '/x', new_dirname: '', new_parent_id: null }))
      .toThrow(/old_dirname and new_dirname/);
  });
});

describeIfBinding('DatabaseService - insertCopiedFileRow()', () => {
  beforeEach(() => freshDb());
  afterAll(() => { try { db.db.close(); } catch (_) {} db.db = null; });

  it('inserts a new files row and writes a fileCopied history entry', () => {
    const dirId = insertDir('/dst');

    const result = db.insertCopiedFileRow({
      new_inode: 'copy-inode',
      new_dir_id: dirId,
      new_filename: 'copy.txt',
      source_path: '/src/orig.txt',
      target_path: '/dst/copy.txt',
      size: 1234,
      mode: 33188,
      dateModified: 111,
      dateCreated: 222,
    });

    expect(result.file_id).toBeGreaterThan(0);

    const fileRow = db.db.prepare('SELECT inode, dir_id, filename, size FROM files WHERE id = ?').get(result.file_id);
    expect(fileRow).toEqual({ inode: 'copy-inode', dir_id: dirId, filename: 'copy.txt', size: 1234 });

    const history = db.db.prepare("SELECT eventType, changeValue FROM file_history WHERE file_id = ?").all(result.file_id);
    expect(history).toHaveLength(1);
    expect(history[0].eventType).toBe('fileCopied');
    expect(JSON.parse(history[0].changeValue)).toMatchObject({
      filename: 'copy.txt',
      oldPath: '/src/orig.txt',
      newPath: '/dst/copy.txt',
      source: 'user-app',
    });
  });

  it('upserts when a row with the same (inode, dir_id) already exists', () => {
    const dirId = insertDir('/dst');
    const existingId = insertFile('dup-inode', dirId, 'old.txt');

    const result = db.insertCopiedFileRow({
      new_inode: 'dup-inode',
      new_dir_id: dirId,
      new_filename: 'new.txt',
      source_path: '/src/new.txt',
      target_path: '/dst/new.txt',
      size: 999,
    });

    expect(result.file_id).toBe(existingId);
    const row = db.db.prepare('SELECT filename, size FROM files WHERE id = ?').get(existingId);
    expect(row).toEqual({ filename: 'new.txt', size: 999 });

    // History row written even on the upsert path.
    const histCount = db.db.prepare(
      "SELECT COUNT(*) AS n FROM file_history WHERE file_id = ? AND eventType = 'fileCopied'"
    ).get(existingId).n;
    expect(histCount).toBe(1);
  });
});
