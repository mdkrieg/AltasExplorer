/**
 * @file Unit tests for the file_content table (deep content search cache):
 * accessors, lifecycle cleanup, and the startup orphan sweep.
 *
 * Same strategy as db.test.js: plug an in-memory better-sqlite3 connection
 * into the singleton and run the real createSchema().
 */

jest.mock('../logger');

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

function insertFile(inode, dir_id, filename, dateModified = 1000) {
  const info = db.db.prepare(
    'INSERT INTO files (inode, dir_id, filename, size, dateModified) VALUES (?, ?, ?, 0, ?)'
  ).run(inode, dir_id, filename, dateModified);
  return info.lastInsertRowid;
}

function contentRowCount() {
  return db.db.prepare('SELECT COUNT(*) AS n FROM file_content').get().n;
}

describeIfBinding('DatabaseService - file_content accessors', () => {
  beforeEach(() => freshDb());
  afterAll(() => { try { db.db.close(); } catch (_) {} db.db = null; });

  it('upsertFileContent inserts then updates on conflict', () => {
    const dirId = insertDir('/docs');
    const fileId = insertFile('i1', dirId, 'a.txt');

    db.upsertFileContent({
      file_id: fileId, text: 'hello world', content_hash: 'h1',
      source_mtime: 1000, source_size: 11, extractor: 'text', status: 'extracted'
    });
    let row = db.db.prepare('SELECT * FROM file_content WHERE file_id = ?').get(fileId);
    expect(row.text).toBe('hello world');
    expect(row.status).toBe('extracted');

    db.upsertFileContent({
      file_id: fileId, text: 'updated text', content_hash: 'h2',
      source_mtime: 2000, source_size: 12, extractor: 'text', status: 'truncated'
    });
    row = db.db.prepare('SELECT * FROM file_content WHERE file_id = ?').get(fileId);
    expect(row.text).toBe('updated text');
    expect(row.content_hash).toBe('h2');
    expect(row.status).toBe('truncated');
    expect(contentRowCount()).toBe(1);
  });

  it('stores skipped/error rows with NULL text', () => {
    const dirId = insertDir('/docs');
    const fileId = insertFile('i1', dirId, 'big.pdf');
    db.upsertFileContent({
      file_id: fileId, text: null, content_hash: null,
      source_mtime: 1000, source_size: 99999999, extractor: 'pdf', status: 'skipped_size'
    });
    const row = db.getFileContentStatus(fileId);
    expect(row.status).toBe('skipped_size');
    expect(db.db.prepare('SELECT text FROM file_content WHERE file_id = ?').get(fileId).text).toBeNull();
  });

  it('getContentMetaForDir returns a map without touching text', () => {
    const dirId = insertDir('/docs');
    const f1 = insertFile('i1', dirId, 'a.txt');
    const f2 = insertFile('i2', dirId, 'b.txt');
    insertFile('i3', dirId, 'c.txt'); // no content row

    db.upsertFileContent({ file_id: f1, text: 'aaa', content_hash: 'ha', source_mtime: 111, source_size: 3, extractor: 'text', status: 'extracted' });
    db.upsertFileContent({ file_id: f2, text: null, content_hash: null, source_mtime: 222, source_size: 4, extractor: 'text', status: 'error', error: 'boom' });

    const meta = db.getContentMetaForDir(dirId);
    expect(meta.size).toBe(2);
    expect(meta.get(f1)).toEqual({ source_mtime: 111, status: 'extracted', content_hash: 'ha' });
    expect(meta.get(f2).status).toBe('error');
  });

  it('touchFileContent updates freshness without changing text', () => {
    const dirId = insertDir('/docs');
    const fileId = insertFile('i1', dirId, 'a.txt');
    db.upsertFileContent({ file_id: fileId, text: 'stable', content_hash: 'h', source_mtime: 100, source_size: 6, extractor: 'text', status: 'extracted' });

    db.touchFileContent(fileId, 500);
    const row = db.db.prepare('SELECT * FROM file_content WHERE file_id = ?').get(fileId);
    expect(row.source_mtime).toBe(500);
    expect(row.text).toBe('stable');
  });
});

describeIfBinding('DatabaseService - file_content lifecycle cleanup', () => {
  beforeEach(() => freshDb());
  afterAll(() => { try { db.db.close(); } catch (_) {} db.db = null; });

  function seed() {
    const dirId = insertDir('/docs');
    const fileId = insertFile('i1', dirId, 'a.txt');
    db.upsertFileContent({ file_id: fileId, text: 'x', content_hash: 'h', source_mtime: 1, source_size: 1, extractor: 'text', status: 'extracted' });
    return { dirId, fileId };
  }

  it('deleteFile removes the content row', () => {
    const { dirId } = seed();
    expect(contentRowCount()).toBe(1);
    db.deleteFile('i1', dirId);
    expect(contentRowCount()).toBe(0);
  });

  it('clearDirectory removes content rows for all files in the dir', () => {
    const { dirId } = seed();
    const f2 = insertFile('i2', dirId, 'b.txt');
    db.upsertFileContent({ file_id: f2, text: 'y', content_hash: 'h2', source_mtime: 1, source_size: 1, extractor: 'text', status: 'extracted' });
    expect(contentRowCount()).toBe(2);
    db.clearDirectory('/docs');
    expect(contentRowCount()).toBe(0);
  });

  it('replaceFileInode drops the stale content row', () => {
    const { fileId } = seed();
    db.replaceFileInode(fileId, 'i1-new', { filename: 'a.txt', dateModified: 2, dateCreated: 1, size: 5 });
    expect(contentRowCount()).toBe(0);
  });

  it('tombstoned (trashed) files keep their content row', () => {
    const { fileId } = seed();
    db.finalizeFileDeletion(fileId);
    expect(contentRowCount()).toBe(1);
  });

  it('createSchema startup sweep removes rows whose files row is gone', () => {
    const { fileId } = seed();
    // Bypass deleteFile to simulate a row left behind (FKs are unenforced).
    db.db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
    expect(contentRowCount()).toBe(1);
    db.createSchema();
    expect(contentRowCount()).toBe(0);
  });
});
