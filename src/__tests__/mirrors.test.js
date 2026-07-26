/**
 * @file Unit tests for src/mirrors.js — mirror items core.
 *
 * Strategy mirrors db.test.js: an in-memory better-sqlite3 connection is
 * plugged into the db singleton with the real schema. "Remote" paths are just
 * a second temp directory — the sync logic is path-agnostic, so UNC vs local
 * makes no difference to what's under test.
 */

jest.mock('../logger');
jest.mock('../categories');

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

const fs = require('fs');
const os = require('os');
const path = require('path');

const db = require('../db');
const mirrors = require('../mirrors');

function freshDb() {
  if (db.db) {
    try { db.db.close(); } catch (_) { /* ignore */ }
  }
  db.db = new Database(':memory:');
  db.createSchema();
}

let remoteDir;
let localDir;

function makeTempDirs() {
  remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-mirror-remote-'));
  localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-mirror-local-'));
}

function cleanTempDirs() {
  for (const d of [remoteDir, localDir]) {
    if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
  }
}

function writeRemote(name, content) {
  const p = path.join(remoteDir, name);
  fs.writeFileSync(p, content);
  return p;
}

function writeLocal(name, content) {
  const p = path.join(localDir, name);
  fs.writeFileSync(p, content);
  return p;
}

/** Wait until a mirror row reaches a status (fire-and-forget sync paths). */
async function waitForStatus(mirrorId, status, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const m = db.getMirrorById(mirrorId);
    if (m && m.sync_status === status) return m;
    await new Promise(r => setTimeout(r, 25));
  }
  return db.getMirrorById(mirrorId);
}

describeIfBinding('mirrors — validateEntries()', () => {
  const V = mirrors.SCHEMA_VERSION;

  it('rejects unsupported versions as a file-level error', () => {
    const res = mirrors.validateEntries({ version: 99, mirrors: [] });
    expect(res.fileError).toMatch(/unsupported version/);
    expect(res.valid).toHaveLength(0);
  });

  it('accepts bare-string entries as remotePath shorthand and defaults localName', () => {
    const res = mirrors.validateEntries({ version: V, mirrors: ['\\\\srv\\share\\a.pdf'] });
    expect(res.valid).toHaveLength(1);
    expect(res.valid[0].localName).toBe('a.pdf');
  });

  it('rejects entries individually without sinking siblings', () => {
    const res = mirrors.validateEntries({
      version: V,
      mirrors: [
        { remotePath: '\\\\srv\\share\\good.pdf' },
        { localName: 'no-remote.pdf' },
        { remotePath: '\\\\srv\\share\\bad-name.pdf', localName: 'sub\\dir.pdf' },
        { remotePath: '\\\\srv\\share\\bad-dir.pdf', direction: 'sideways' },
        42
      ]
    });
    expect(res.valid).toHaveLength(1);
    expect(res.rejected).toHaveLength(4);
    expect(res.rejected.map(r => r.reason).join('|')).toMatch(/missing remotePath/);
    expect(res.rejected.map(r => r.reason).join('|')).toMatch(/plain filename/);
    expect(res.rejected.map(r => r.reason).join('|')).toMatch(/invalid direction/);
  });

  it('rejects duplicate remotePaths (case-insensitive) and ignores unknown fields', () => {
    const res = mirrors.validateEntries({
      version: V,
      futureField: true,
      mirrors: [
        { remotePath: '\\\\srv\\share\\a.pdf', someFutureThing: 1 },
        { remotePath: '\\\\SRV\\share\\A.PDF' }
      ]
    });
    expect(res.valid).toHaveLength(1);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].reason).toMatch(/duplicate/);
  });
});

describeIfBinding('mirrors — diffSidecar()', () => {
  const V = mirrors.SCHEMA_VERSION;
  const file = (entries) => ({ version: V, mirrors: entries });

  it('classifies added, removed, and changed (keyed by remotePath)', () => {
    const cached = file([
      { remotePath: 'R:\\a.pdf', localName: 'a.pdf' },
      { remotePath: 'R:\\b.pdf', localName: 'b.pdf' }
    ]);
    const onDisk = file([
      { remotePath: 'R:\\a.pdf', localName: 'renamed.pdf' }, // changed, not remove+add
      { remotePath: 'R:\\c.pdf', localName: 'c.pdf' }        // added
      // b.pdf removed
    ]);
    const diff = mirrors.diffSidecar(onDisk, cached);
    expect(diff.added.map(e => e.remotePath)).toEqual(['R:\\c.pdf']);
    expect(diff.removed.map(e => e.remotePath)).toEqual(['R:\\b.pdf']);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].to.localName).toBe('renamed.pdf');
  });

  it('reports no differences for identical content', () => {
    const a = file([{ remotePath: 'R:\\a.pdf' }]);
    const diff = mirrors.diffSidecar(a, file([{ remotePath: 'R:\\a.pdf' }]));
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
  });
});

describeIfBinding('mirrors — guessDirection()', () => {
  it('covers the presence matrix', () => {
    expect(mirrors.guessDirection({ remoteExists: true, localExists: false }))
      .toEqual({ direction: 'remote-mirror', action: 'download' });
    expect(mirrors.guessDirection({ remoteExists: false, localExists: true }))
      .toEqual({ direction: 'local-mirror', action: 'upload' });
    expect(mirrors.guessDirection({ remoteExists: true, localExists: true }).action)
      .toBe('compare');
    expect(mirrors.guessDirection({ remoteExists: false, localExists: false }).action)
      .toBe('error');
  });
});

describeIfBinding('mirrors — createMirror()', () => {
  beforeEach(() => { freshDb(); makeTempDirs(); });
  afterEach(() => cleanTempDirs());
  afterAll(() => { try { db.db.close(); } catch (_) {} db.db = null; });

  it('downloads a remote-only file and lands in-sync with a projected sidecar', async () => {
    const remotePath = writeRemote('doc.pdf', 'remote-content');
    const res = await mirrors.createMirror({ origin: 'drag', remotePath, localDir });
    expect(res.ok).toBe(true);
    expect(res.initialStatus).toBe('in-sync');
    expect(fs.readFileSync(path.join(localDir, 'doc.pdf'), 'utf8')).toBe('remote-content');

    const sidecar = mirrors.readSidecar(localDir);
    expect(sidecar.ok).toBe(true);
    expect(sidecar.data.mirrors).toHaveLength(1);
    expect(sidecar.data.mirrors[0].state.status).toBe('in-sync');
  });

  it('links silently when both sides are identical (no transfer)', async () => {
    const remotePath = writeRemote('same.txt', 'identical');
    writeLocal('same.txt', 'identical');
    const res = await mirrors.createMirror({ origin: 'context-menu', remotePath, localDir });
    expect(res.ok).toBe(true);
    expect(res.initialStatus).toBe('in-sync');
    expect(res.mirror.last_synced_md5).toBeTruthy();
  });

  it('inserts born-in-conflict when both sides differ (no transfer, no data loss)', async () => {
    const remotePath = writeRemote('clash.txt', 'remote version');
    writeLocal('clash.txt', 'local version — different');
    const res = await mirrors.createMirror({ origin: 'drag', remotePath, localDir });
    expect(res.ok).toBe(true);
    expect(res.initialStatus).toBe('conflict');
    expect(fs.readFileSync(path.join(localDir, 'clash.txt'), 'utf8'))
      .toBe('local version — different');
  });

  it('refuses unconfirmed sidecar-origin declarations', async () => {
    const remotePath = writeRemote('a.txt', 'x');
    const res = await mirrors.createMirror({ origin: 'sidecar', remotePath, localDir });
    expect(res.ok).toBe(false);
    expect(res.needsConfirmation).toBe(true);
  });

  it('rejects duplicates, directories, and fully-missing pairs', async () => {
    const remotePath = writeRemote('dup.txt', 'x');
    await mirrors.createMirror({ origin: 'drag', remotePath, localDir });
    const dup = await mirrors.createMirror({ origin: 'drag', remotePath, localDir });
    expect(dup.ok).toBe(false);
    expect(dup.error).toMatch(/already exists/);

    const dirRes = await mirrors.createMirror({ origin: 'drag', remotePath: remoteDir, localDir });
    expect(dirRes.ok).toBe(false);
    expect(dirRes.error).toMatch(/directory/i);

    const ghost = await mirrors.createMirror({
      origin: 'drag', remotePath: path.join(remoteDir, 'nope.txt'), localDir
    });
    expect(ghost.ok).toBe(false);
    expect(ghost.error).toMatch(/neither/);
  });

  it('uploads local-only files when direction guesses local-mirror', async () => {
    writeLocal('out.txt', 'publish me');
    const remotePath = path.join(remoteDir, 'out.txt');
    const res = await mirrors.createMirror({ origin: 'drag', remotePath, localDir });
    expect(res.ok).toBe(true);
    expect(res.mirror.direction).toBe('local-mirror');
    expect(fs.readFileSync(remotePath, 'utf8')).toBe('publish me');
  });

  it('bootstraps "source follows this copy": downloads first, then local is authority', async () => {
    // Drag gesture: remote file exists, forced local-mirror direction. The
    // authoritative (local) side doesn't exist yet, so the initial transfer
    // must flow remote -> local (reverse bootstrap).
    const remotePath = writeRemote('boot.txt', 'seed content');
    const res = await mirrors.createMirror({
      origin: 'drag', remotePath, localDir, direction: 'local-mirror'
    });
    expect(res.ok).toBe(true);
    expect(res.mirror.direction).toBe('local-mirror');
    expect(res.initialStatus).toBe('in-sync');
    expect(fs.readFileSync(path.join(localDir, 'boot.txt'), 'utf8')).toBe('seed content');

    // After bootstrap, a local edit is the sync task (local is authority).
    fs.writeFileSync(path.join(localDir, 'boot.txt'), 'local authority v2');
    const evalRes = await mirrors.evaluateMirror(db.getMirrorById(res.mirror.id));
    expect(evalRes.status).toBe('local-newer');
    const sync = await mirrors.syncMirror(res.mirror.id);
    expect(sync.ok).toBe(true);
    expect(fs.readFileSync(remotePath, 'utf8')).toBe('local authority v2');
  });
});

describeIfBinding('mirrors — evaluateMirror() state matrix', () => {
  beforeEach(() => { freshDb(); makeTempDirs(); });
  afterEach(() => cleanTempDirs());
  afterAll(() => { try { db.db.close(); } catch (_) {} db.db = null; });

  async function mkSynced(name = 'f.txt', content = 'v1') {
    const remotePath = writeRemote(name, content);
    const res = await mirrors.createMirror({ origin: 'drag', remotePath, localDir });
    expect(res.initialStatus).toBe('in-sync');
    return db.getMirrorById(res.mirror.id);
  }

  it('in-sync when neither side changed', async () => {
    const m = await mkSynced();
    const r = await mirrors.evaluateMirror(m);
    expect(r.status).toBe('in-sync');
  });

  it('remote-newer when only the remote changed', async () => {
    const m = await mkSynced();
    // Size change avoids depending on mtime granularity in the cheap tier.
    fs.writeFileSync(m.remote_path, 'v2 — now longer');
    const r = await mirrors.evaluateMirror(m);
    expect(r.status).toBe('remote-newer');
  });

  it('local-newer when only the local copy changed (attention state)', async () => {
    const m = await mkSynced();
    fs.writeFileSync(path.join(m.local_dir, m.local_name), 'local edit!');
    const r = await mirrors.evaluateMirror(m);
    expect(r.status).toBe('local-newer');
  });

  it('conflict when both sides changed', async () => {
    const m = await mkSynced();
    fs.writeFileSync(m.remote_path, 'remote v2 longer');
    fs.writeFileSync(path.join(m.local_dir, m.local_name), 'local v2!');
    const r = await mirrors.evaluateMirror(m);
    expect(r.status).toBe('conflict');
  });

  it('tombstone when the authoritative remote vanishes — never deletes local', async () => {
    const m = await mkSynced();
    fs.unlinkSync(m.remote_path);
    const r = await mirrors.evaluateMirror(m);
    expect(r.status).toBe('tombstone');
    expect(fs.existsSync(path.join(m.local_dir, m.local_name))).toBe(true);
  });

  it('error with guidance when the local copy vanishes', async () => {
    const m = await mkSynced();
    fs.unlinkSync(path.join(m.local_dir, m.local_name));
    const r = await mirrors.evaluateMirror(m);
    expect(r.status).toBe('error');
    expect(r.errorMessage).toMatch(/local copy missing/);
  });
});

describeIfBinding('mirrors — sidecar absorption and projection discipline', () => {
  beforeEach(() => { freshDb(); makeTempDirs(); });
  afterEach(() => cleanTempDirs());
  afterAll(() => { try { db.db.close(); } catch (_) {} db.db = null; });

  it('hand-authored sidecar → adoption row, not silent mirrors; mtime not stamped until resolve', async () => {
    const remotePath = writeRemote('handoff.pdf', 'content');
    fs.writeFileSync(mirrors.sidecarPath(localDir),
      JSON.stringify({ version: 1, mirrors: [remotePath] }));

    const first = mirrors.maybeAbsorbSidecar(localDir);
    expect(first.pendingAdoption).toBeTruthy();
    expect(first.pendingAdoption.source).toBe('sidecar-new');
    expect(db.getMirrorsForDir(path.resolve(localDir))).toHaveLength(0);

    // Re-scan while unresolved: same pending adoption, no duplicates.
    const second = mirrors.maybeAbsorbSidecar(localDir);
    expect(second.pendingAdoption.id).toBe(first.pendingAdoption.id);
  });

  it('malformed JSON is skipped without stamping mtime (retries next browse)', () => {
    fs.writeFileSync(mirrors.sidecarPath(localDir), '{ not json');
    const res = mirrors.maybeAbsorbSidecar(localDir);
    expect(res.pendingAdoption).toBeUndefined();
    expect(db.getMirrorSidecar(path.resolve(localDir))).toBeNull();
  });

  it('adopting creates mirrors, transfers, and reprojects the sidecar', async () => {
    const remotePath = writeRemote('adopt.pdf', 'adopt-me');
    fs.writeFileSync(mirrors.sidecarPath(localDir),
      JSON.stringify({ version: 1, mirrors: [remotePath] }));

    const { pendingAdoption } = mirrors.maybeAbsorbSidecar(localDir);
    const entries = await mirrors.prepareAdoptionEntries(localDir, pendingAdoption.payload);
    expect(entries[0].guessedDirection).toBe('remote-mirror');

    const res = await mirrors.resolveAdoption(pendingAdoption.id, 'adopted',
      entries.map(e => ({ ...e, direction: e.guessedDirection })));
    expect(res.ok).toBe(true);
    expect(res.syncQueued).toHaveLength(1);

    const m = await waitForStatus(res.syncQueued[0].id, 'in-sync');
    expect(m.sync_status).toBe('in-sync');
    expect(fs.readFileSync(path.join(localDir, 'adopt.pdf'), 'utf8')).toBe('adopt-me');

    // After resolve+projection the scan must not re-prompt (own-write skip).
    const after = mirrors.maybeAbsorbSidecar(localDir);
    expect(after.pendingAdoption ?? null).toBeNull();
  });

  it('projectSidecar refuses to overwrite off-app edits (check-before-overwrite)', async () => {
    const remotePath = writeRemote('guard.txt', 'x');
    const created = await mirrors.createMirror({ origin: 'drag', remotePath, localDir });
    expect(created.ok).toBe(true);

    const tampered = '{"version":1,"mirrors":["Z:\\\\hand-edit.txt"]}';
    fs.writeFileSync(mirrors.sidecarPath(localDir), tampered);

    const res = mirrors.projectSidecar(localDir);
    expect(res.skipped).toBe(true);
    expect(res.offAppEdit).toBe(true);
    expect(fs.readFileSync(mirrors.sidecarPath(localDir), 'utf8')).toBe(tampered);

    // The tampered file surfaces as a diff adoption on the next scan.
    const scan = mirrors.maybeAbsorbSidecar(localDir);
    expect(scan.pendingAdoption).toBeTruthy();
    expect(scan.pendingAdoption.source).toBe('sidecar-diff');
  });

  it('deleting the whole sidecar off-app surfaces a sidecar-deleted adoption', async () => {
    const remotePath = writeRemote('gone.txt', 'x');
    await mirrors.createMirror({ origin: 'drag', remotePath, localDir });
    fs.unlinkSync(mirrors.sidecarPath(localDir));

    const scan = mirrors.maybeAbsorbSidecar(localDir);
    expect(scan.pendingAdoption).toBeTruthy();
    expect(scan.pendingAdoption.source).toBe('sidecar-deleted');
  });

  it('restore rewrites the sidecar from the cached copy', async () => {
    const remotePath = writeRemote('restore.txt', 'x');
    await mirrors.createMirror({ origin: 'drag', remotePath, localDir });
    const original = fs.readFileSync(mirrors.sidecarPath(localDir), 'utf8');

    fs.writeFileSync(mirrors.sidecarPath(localDir), '{"version":1,"mirrors":[]}');
    const { pendingAdoption } = mirrors.maybeAbsorbSidecar(localDir);
    const res = await mirrors.resolveAdoption(pendingAdoption.id, 'restored');
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(mirrors.sidecarPath(localDir), 'utf8')).toBe(original);
  });

  it('detaching the last mirror retires the sidecar', async () => {
    const remotePath = writeRemote('last.txt', 'x');
    const created = await mirrors.createMirror({ origin: 'drag', remotePath, localDir });
    expect(fs.existsSync(mirrors.sidecarPath(localDir))).toBe(true);

    const res = await mirrors.detachMirror(created.mirror.id, {});
    expect(res.ok).toBe(true);
    expect(fs.existsSync(mirrors.sidecarPath(localDir))).toBe(false);
    // Local copy stays — detach never deletes data unless asked.
    expect(fs.existsSync(path.join(localDir, 'last.txt'))).toBe(true);
  });
});

describeIfBinding('mirrors — syncMirror()', () => {
  beforeEach(() => { freshDb(); makeTempDirs(); });
  afterEach(() => cleanTempDirs());
  afterAll(() => { try { db.db.close(); } catch (_) {} db.db = null; });

  it('re-downloads after a remote change and realigns fingerprints', async () => {
    const remotePath = writeRemote('sync.txt', 'v1');
    const created = await mirrors.createMirror({ origin: 'drag', remotePath, localDir });

    fs.writeFileSync(remotePath, 'v2 with more bytes');
    const evalRes = await mirrors.evaluateMirror(db.getMirrorById(created.mirror.id));
    expect(evalRes.status).toBe('remote-newer');

    const sync = await mirrors.syncMirror(created.mirror.id);
    expect(sync.ok).toBe(true);
    expect(fs.readFileSync(path.join(localDir, 'sync.txt'), 'utf8')).toBe('v2 with more bytes');

    const after = await mirrors.evaluateMirror(db.getMirrorById(created.mirror.id));
    expect(after.status).toBe('in-sync');

    // No temp artifacts left behind.
    expect(fs.readdirSync(localDir).filter(f => f.startsWith('.atlas-tmp-'))).toHaveLength(0);
  });

  it('reports progress phases through onProgress', async () => {
    const remotePath = writeRemote('prog.txt', 'p'.repeat(300000));
    const created = await mirrors.createMirror({
      origin: 'drag', remotePath, localDir, skipInitialSync: true
    });
    const phases = [];
    const sync = await mirrors.syncMirror(created.mirror.id, {
      onProgress: p => phases.push(p.phase)
    });
    expect(sync.ok).toBe(true);
    expect(phases[0]).toBe('starting');
    expect(phases).toContain('verifying');
    expect(phases[phases.length - 1]).toBe('done');
  });
});
