'use strict';

/**
 * src/mirrors.js
 *
 * Mirror items — individual files pinned to a concrete remote path with a
 * tracked local copy and per-item sync state. Design record:
 * private/prompts/atlas-explorer-virtual-sync-collection-handoff.md and
 * agent-docs/DECISIONS.md (#mirror-pinning-vs-queries, #sidecar-addressing,
 * #sidecar-cached-copy-diff, #mirror-comparison-basis).
 *
 * Sidecar file (one per directory containing mirrors):
 *   atlas-sync.<username>@<hostname>.json
 * The user@host suffix is ADDRESSING, not collision avoidance: each machine
 * writes only its own file, and only auto-picks-up files addressed to the
 * current user+machine. This makes OneDrive conflict copies structurally
 * impossible for the writer and prevents ambient adoption of another user's
 * WIP file in a shared ecosystem. Cross-machine adoption will be an explicit
 * import action (phase 2). Walked back from an un-suffixed atlas-sync.json —
 * see agent-docs/DECISIONS.md#sidecar-addressing.
 *
 * File format (schema version 1):
 * {
 *   "version": 1,
 *   "mirrors": [ {
 *     "remotePath": "\\\\server\\share\\Report.xlsx",   // required; pinned path
 *     "localName": "Report.xlsx",                        // optional, defaults to basename
 *     "direction": "remote-mirror" | "local-mirror",     // optional; guessed by presence
 *     "policy": null,                                    // reserved (phase-2 write-back policy)
 *     "state": { ... },                                  // projection of DB state; ignored on
 *                                                        // absorb except as recovery seed
 *     "tombstone": null | epochMs
 *   } ]
 * }
 * Minimum hand-authored file: {"version":1,"mirrors":["\\\\server\\share\\x.pdf"]}
 * (bare-string entries are remotePath shorthand).
 *
 * Ownership split (resolves the handoff doc's three-way sync problem):
 *  - Declarations (remotePath, localName, direction, policy) flow file -> DB,
 *    always gated by a visible adoption confirmation. Hand-authoring the
 *    sidecar is a supported, documented API.
 *  - State (sync status, last-synced fingerprints, tombstones) is
 *    DB-authoritative and projected DB -> file, on status TRANSITIONS only —
 *    projecting every evaluation tick would re-upload the sidecar through
 *    OneDrive on each browse. Volatile fields (last_evaluated_*) are never
 *    projected at all.
 *
 * Absorption strategy (cloned from src/atlasJson.js): lazy, triggered from
 * the directory scan. The mtime of the last written/absorbed sidecar is kept
 * in mirror_sidecars.sidecar_mtime; absorption only fires when the on-disk
 * file is newer. Unlike atlas.json, absorption NEVER writes to the DB
 * directly — it creates a mirror_adoptions row that the UI surfaces as an
 * inline review banner. The mtime is stamped only when the adoption is
 * resolved, so an ignored banner re-triggers on the next browse.
 *
 * Safety rules:
 *  - Every exported function is non-throwing; sidecar/remote-IO problems must
 *    never crash a scan.
 *  - Malformed JSON is skipped WITHOUT advancing the stored mtime (retry on
 *    next browse).
 *  - Check-before-overwrite: projection compares the on-disk sidecar against
 *    the cached last-written copy first; a mismatch means an off-app edit —
 *    legitimate by design, never "corruption" — and routes to the diff/review
 *    flow instead of clobbering. (Coexistence principle applied to Atlas
 *    itself; see DECISIONS.md#sidecar-cached-copy-diff.)
 *  - Deletion never propagates automatically: a missing remote produces a
 *    durable tombstone attention state, not a local delete (and vice versa).
 *
 * Phase-2 seams (deliberately not built yet):
 *  - retargetMirror(mirrorId, newRemotePath): the "flag as new revision"
 *    action once the successor watch exists.
 *  - evaluateMirror() is shaped so the active-monitoring batch queue can call
 *    it per pinned path.
 *  - policy is stored and projected but not interpreted (shared write-back
 *    policy mechanism).
 *  - Adoption source 'import' reserved for cross-machine sidecar import.
 */

const path   = require('path');
const os     = require('os');
const fsSync = require('fs');
const fsp    = require('fs').promises;
const crypto = require('crypto');

const logger     = require('./logger');
const db         = require('./db');
const checksum   = require('./checksum');
const categories = require('./categories');

const SCHEMA_VERSION = 1;
const VALID_DIRECTIONS = ['remote-mirror', 'local-mirror'];

// mtimes are compared with a tolerance: FAT/SMB stores mtimes at 2s
// granularity, and copies across filesystems can round them.
const MTIME_TOLERANCE_MS = 2000;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function getMirrorSettings() {
  try {
    const s = categories.getSettings();
    return {
      transferMaxConcurrent: Math.max(1, Math.min(4, Number(s.mirror_transfer_max_concurrent) || 2)),
      remoteStatTimeoutMs: Math.max(500, Number(s.mirror_remote_stat_timeout_ms) || 5000)
    };
  } catch {
    return { transferMaxConcurrent: 2, remoteStatTimeoutMs: 5000 };
  }
}

// ---------------------------------------------------------------------------
// Sidecar identity
// ---------------------------------------------------------------------------

function sidecarName() {
  let username = 'user';
  try { username = os.userInfo().username || 'user'; } catch { /* keep fallback */ }
  return `atlas-sync.${username}@${os.hostname()}.json`;
}

function sidecarPath(dirPath) {
  return path.join(dirPath, sidecarName());
}

/** True when filename is ANY atlas-sync sidecar (own or foreign). */
function isSidecarFilename(filename) {
  return /^atlas-sync\..+\.json$/i.test(filename || '');
}

// ---------------------------------------------------------------------------
// Stat helpers
// ---------------------------------------------------------------------------

/**
 * Stat with a timeout. The underlying libuv call cannot be canceled — on a
 * dead SMB share it finishes (or times out at the OS level) in the
 * background; the race only prevents US from hanging a scan or state update
 * on it. Losing the race reports 'timeout', not 'missing'.
 */
async function statWithTimeout(p, timeoutMs) {
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
  });
  const stat = fsp.stat(p).then(
    st => ({ status: 'ok', stat: st }),
    err => ({ status: err && err.code === 'ENOENT' ? 'missing' : 'error', error: err?.message })
  );
  const result = await Promise.race([stat, timeout]);
  clearTimeout(timer);
  return result;
}

/**
 * Has this side changed since the last sync?
 * Cheap tier first: size differs -> changed; mtime within tolerance -> not
 * changed. MD5 tiebreak only for the ambiguous case (same size, mtime moved):
 * mtimes get mangled by copies and OneDrive, and hashing over SMB is
 * expensive, so the hash runs only when the cheap tier cannot decide.
 * See agent-docs/DECISIONS.md#mirror-comparison-basis.
 */
async function sideChanged(stat, lastMtime, lastSize, lastMd5, filePath) {
  if (lastMtime === null || lastMtime === undefined) return true; // never synced
  if (stat.size !== lastSize) return true;
  if (Math.abs(stat.mtimeMs - lastMtime) <= MTIME_TOLERANCE_MS) return false;
  if (!lastMd5) return true; // can't tiebreak — assume changed (safe: surfaces attention)
  const { value } = await checksum.calculateMD5(filePath);
  return value !== lastMd5;
}

// ---------------------------------------------------------------------------
// Sidecar read / validate / diff
// ---------------------------------------------------------------------------

/** Tolerant read of this machine's own sidecar. Never throws. */
function readSidecar(dirPath) {
  const filePath = sidecarPath(dirPath);
  let raw;
  try {
    raw = fsSync.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { ok: false, missing: err.code === 'ENOENT', error: err.message };
  }
  try {
    return { ok: true, data: JSON.parse(raw), raw };
  } catch (err) {
    return { ok: false, missing: false, parseError: true, error: err.message, raw };
  }
}

/**
 * Validate a parsed sidecar. Per-entry rejection with a visible reason —
 * one bad entry must not sink its siblings. Unknown fields are ignored
 * (forward compatibility: the sidecar schema is a public, hand-authorable
 * API, so parsing is deliberately tolerant).
 */
function validateEntries(data) {
  const valid = [];
  const rejected = [];

  if (!data || typeof data !== 'object') {
    return { valid, rejected, fileError: 'not a JSON object' };
  }
  if (data.version !== SCHEMA_VERSION) {
    return { valid, rejected, fileError: `unsupported version ${JSON.stringify(data.version)} (expected ${SCHEMA_VERSION})` };
  }
  if (!Array.isArray(data.mirrors)) {
    return { valid, rejected, fileError: 'missing "mirrors" array' };
  }

  const seenKeys = new Set();
  for (const rawEntry of data.mirrors) {
    // Bare-string shorthand: the minimum hand-authored declaration is just a
    // remote path.
    const entry = typeof rawEntry === 'string' ? { remotePath: rawEntry } : rawEntry;

    if (!entry || typeof entry !== 'object') {
      rejected.push({ entry: rawEntry, reason: 'entry is not an object or string' });
      continue;
    }
    if (typeof entry.remotePath !== 'string' || !entry.remotePath.trim()) {
      rejected.push({ entry: rawEntry, reason: 'missing remotePath' });
      continue;
    }
    const remotePath = path.normalize(entry.remotePath.trim());

    let localName = entry.localName;
    if (localName !== undefined && localName !== null) {
      if (typeof localName !== 'string' || !localName.trim()) {
        rejected.push({ entry: rawEntry, reason: 'localName must be a non-empty string' });
        continue;
      }
      localName = localName.trim();
      if (localName !== path.basename(localName) || localName === '.' || localName === '..') {
        rejected.push({ entry: rawEntry, reason: 'localName must be a plain filename (no path separators)' });
        continue;
      }
    } else {
      localName = path.basename(remotePath);
    }

    if (entry.direction !== undefined && entry.direction !== null &&
        !VALID_DIRECTIONS.includes(entry.direction)) {
      rejected.push({ entry: rawEntry, reason: `invalid direction "${entry.direction}"` });
      continue;
    }

    const key = remotePath.toLowerCase();
    if (seenKeys.has(key)) {
      rejected.push({ entry: rawEntry, reason: 'duplicate remotePath in file' });
      continue;
    }
    seenKeys.add(key);

    valid.push({
      remotePath,
      localName,
      direction: entry.direction || null,
      policy: entry.policy || null,
      // state from the file is a recovery seed only — the DB is authoritative
      // whenever a row exists.
      seedState: (entry.state && typeof entry.state === 'object') ? entry.state : null
    });
  }

  return { valid, rejected };
}

/**
 * Diff two parsed sidecars, keyed by remotePath (the stable identity — a
 * localName edit shows as "changed", not remove+add).
 */
function diffSidecar(onDiskData, cachedData) {
  const toMap = (data) => {
    const map = new Map();
    const { valid } = validateEntries(data || { version: SCHEMA_VERSION, mirrors: [] });
    for (const e of valid) map.set(e.remotePath.toLowerCase(), e);
    return map;
  };
  const next = toMap(onDiskData);
  const prev = toMap(cachedData);

  const added = [];
  const removed = [];
  const changed = [];
  for (const [key, entry] of next) {
    const old = prev.get(key);
    if (!old) { added.push(entry); continue; }
    if (old.localName !== entry.localName ||
        (old.direction || null) !== (entry.direction || null) ||
        JSON.stringify(old.policy || null) !== JSON.stringify(entry.policy || null)) {
      changed.push({ from: old, to: entry });
    }
  }
  for (const [key, entry] of prev) {
    if (!next.has(key)) removed.push(entry);
  }
  return { added, removed, changed };
}

// ---------------------------------------------------------------------------
// Direction guessing
// ---------------------------------------------------------------------------

/**
 * Presence-based direction guess (pure; exported for tests).
 * The side that already has the file is the authority: remote-only means the
 * user is pulling a copy down (remote-mirror), local-only means they are
 * publishing outward (local-mirror). Both existing is ambiguous and resolved
 * by content comparison at the call site; neither existing is an error.
 */
function guessDirection({ remoteExists, localExists }) {
  if (remoteExists && !localExists) return { direction: 'remote-mirror', action: 'download' };
  if (!remoteExists && localExists) return { direction: 'local-mirror', action: 'upload' };
  if (remoteExists && localExists)  return { direction: 'remote-mirror', action: 'compare' };
  return { direction: null, action: 'error' };
}

// ---------------------------------------------------------------------------
// createMirror — the polymorphic entry point
// ---------------------------------------------------------------------------

/**
 * Create (or adopt) one mirror. Single entry point for every curation path —
 * origin is provenance plus confirmation semantics, not a behavior fork, so
 * future entry points (search results, monitoring actions, temp workflow)
 * plug in here without redesign.
 *
 * Confirmation rule: drag / context-menu gestures ARE the confirmation.
 * Sidecar-declared entries must arrive with confirmed=true only from the
 * adoption-resolve flow — hand-authored declarations never silently become
 * mirrors ("Atlas acts on what it observes" must stay predictable, and an
 * upload-direction declaration overwrites remote files).
 *
 * @param {object} req
 * @param {'drag'|'context-menu'|'sidecar'|'import'|'search'} req.origin
 * @param {string}  req.remotePath
 * @param {string}  req.localDir
 * @param {string}  [req.localName]     defaults to basename(remotePath)
 * @param {string}  [req.direction]     omitted -> guessDirection()
 * @param {boolean} [req.confirmed]
 * @param {object}  [req.policy]
 * @param {object}  [req.seedState]     recovery seed from a sidecar (DB rebuild case)
 * @param {boolean} [req.skipInitialSync]
 * @returns {Promise<{ok, mirror?, guessed?, needsConfirmation?, initialStatus?, error?}>}
 */
async function createMirror(req) {
  try {
    const origin = req.origin || 'unknown';
    if (origin === 'sidecar' && !req.confirmed) {
      return { ok: false, needsConfirmation: true, error: 'sidecar declarations require adoption confirmation' };
    }
    if (!req.remotePath || !req.localDir) {
      return { ok: false, error: 'remotePath and localDir are required' };
    }

    const remotePath = path.normalize(String(req.remotePath).trim());
    const localDir = path.resolve(String(req.localDir).trim());
    const localName = (req.localName && String(req.localName).trim()) || path.basename(remotePath);
    if (localName !== path.basename(localName) || localName === '.' || localName === '..') {
      return { ok: false, error: 'localName must be a plain filename' };
    }
    if (isSidecarFilename(localName) || isSidecarFilename(path.basename(remotePath))) {
      return { ok: false, error: 'sidecar files cannot themselves be mirrored' };
    }
    const localPath = path.join(localDir, localName);
    if (path.resolve(localPath) === path.resolve(remotePath)) {
      return { ok: false, error: 'remote and local paths are the same file' };
    }
    if (db.getMirrorByLocal(localDir, localName)) {
      return { ok: false, error: `a mirror named "${localName}" already exists in this directory` };
    }

    const { remoteStatTimeoutMs } = getMirrorSettings();
    const [remoteRes, localRes, localDirRes] = await Promise.all([
      statWithTimeout(remotePath, remoteStatTimeoutMs),
      statWithTimeout(localPath, remoteStatTimeoutMs),
      statWithTimeout(localDir, remoteStatTimeoutMs)
    ]);

    if (localDirRes.status !== 'ok' || !localDirRes.stat.isDirectory()) {
      return { ok: false, error: `local directory not accessible: ${localDir}` };
    }
    if (remoteRes.status === 'timeout') {
      return { ok: false, error: `remote source did not respond: ${remotePath}` };
    }
    if (remoteRes.status === 'ok' && remoteRes.stat.isDirectory()) {
      return { ok: false, error: 'directory mirrors are not supported yet (v1 is per-file)' };
    }
    if (localRes.status === 'ok' && localRes.stat.isDirectory()) {
      return { ok: false, error: `local target is a directory: ${localPath}` };
    }

    const remoteExists = remoteRes.status === 'ok';
    const localExists = localRes.status === 'ok';

    let direction = req.direction || null;
    let guessed = null;
    if (direction && !VALID_DIRECTIONS.includes(direction)) {
      return { ok: false, error: `invalid direction "${direction}"` };
    }
    if (!direction) {
      guessed = guessDirection({ remoteExists, localExists });
      if (!guessed.direction) {
        return { ok: false, error: 'neither remote nor local file exists' };
      }
      direction = guessed.direction;
    } else if (!remoteExists && !localExists) {
      return { ok: false, error: 'neither remote nor local file exists' };
    }

    // Both sides present: link silently when content is identical, otherwise
    // insert born-in-conflict with NO transfer — the user picks a side later.
    // Automatically preferring either side here would silently destroy data.
    let initialStatus = 'unknown';
    let linkState = null;
    if (remoteExists && localExists) {
      if (remoteRes.stat.size === localRes.stat.size) {
        const [rMd5, lMd5] = await Promise.all([
          checksum.calculateMD5(remotePath),
          checksum.calculateMD5(localPath)
        ]);
        if (rMd5.value && rMd5.value === lMd5.value) {
          const authStat = direction === 'remote-mirror' ? remoteRes.stat : localRes.stat;
          initialStatus = 'in-sync';
          linkState = {
            last_synced_at: Date.now(),
            last_synced_mtime: authStat.mtimeMs,
            last_synced_size: authStat.size,
            last_synced_md5: rMd5.value
          };
        } else {
          initialStatus = 'conflict';
        }
      } else {
        initialStatus = 'conflict';
      }
    } else if (req.seedState && typeof req.seedState.lastSyncedMtime === 'number') {
      // DB-rebuild recovery: trust the sidecar's projected state as a seed so
      // the first evaluation can classify changes instead of starting blind.
      linkState = {
        last_synced_at: req.seedState.lastSyncedAt || null,
        last_synced_mtime: req.seedState.lastSyncedMtime,
        last_synced_size: req.seedState.lastSyncedSize ?? null,
        last_synced_md5: req.seedState.lastSyncedMd5 || null
      };
      initialStatus = 'unknown';
    }

    const { id } = db.insertMirror({
      localDir, localName, remotePath, direction,
      policy: req.policy || null,
      syncStatus: initialStatus,
      origin
    });
    if (linkState) db.updateMirrorState(id, { ...linkState, sync_status: initialStatus });

    const mirror = db.getMirrorById(id);
    const needsTransfer = initialStatus === 'unknown' && (remoteExists || localExists);
    const authoritativeExists = direction === 'remote-mirror' ? remoteExists : localExists;
    const needsReverse = needsTransfer && !authoritativeExists;

    if (needsTransfer && !req.skipInitialSync) {
      const syncResult = await syncMirror(id, {
        onProgress: req.onProgress, emit: req.emit, reverse: needsReverse
      });
      projectSidecar(localDir);
      return { ok: true, mirror: db.getMirrorById(id), guessed, initialStatus: syncResult.status };
    }

    projectSidecar(localDir);
    return { ok: true, mirror, guessed, initialStatus, needsTransfer, needsReverse };
  } catch (err) {
    logger.error(`mirrors.createMirror failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Classify one mirror's sync state. No transfers, no writes — pure
 * observation plus classification. Shaped so the phase-2 monitoring batch
 * queue can call it per pinned path.
 */
async function evaluateMirror(mirror, { statTimeoutMs } = {}) {
  const timeout = statTimeoutMs || getMirrorSettings().remoteStatTimeoutMs;
  const localPath = path.join(mirror.local_dir, mirror.local_name);

  const [remoteRes, localRes] = await Promise.all([
    statWithTimeout(mirror.remote_path, timeout),
    statWithTimeout(localPath, timeout)
  ]);

  if (remoteRes.status === 'timeout' || remoteRes.status === 'error') {
    return { status: 'error', errorMessage: `remote unreachable: ${remoteRes.error || 'timed out'}`, remoteRes, localRes };
  }

  const isRemoteMirror = mirror.direction === 'remote-mirror';

  // Deletion never propagates: a vanished side becomes an attention state the
  // user resolves explicitly (restore / detach / delete), never an automatic
  // delete or re-download on the other side.
  if (remoteRes.status === 'missing' && isRemoteMirror) {
    return { status: 'tombstone', remoteRes, localRes };
  }
  if (localRes.status === 'missing' && !isRemoteMirror) {
    return { status: 'tombstone', remoteRes, localRes };
  }
  if (localRes.status === 'missing') {
    return { status: 'error', errorMessage: 'local copy missing — Sync Now restores it, or detach the mirror', remoteRes, localRes };
  }
  if (remoteRes.status === 'missing') {
    return { status: 'error', errorMessage: 'remote file missing — Sync Now re-uploads it, or detach the mirror', remoteRes, localRes };
  }
  if (localRes.status === 'timeout' || localRes.status === 'error') {
    return { status: 'error', errorMessage: `local copy unreadable: ${localRes.error || 'timed out'}`, remoteRes, localRes };
  }

  const m = mirror;
  const [remoteChanged, localChanged] = await Promise.all([
    sideChanged(remoteRes.stat, m.last_synced_mtime, m.last_synced_size, m.last_synced_md5, m.remote_path),
    sideChanged(localRes.stat, m.last_synced_mtime, m.last_synced_size, m.last_synced_md5, localPath)
  ]);

  let status;
  if (!remoteChanged && !localChanged) status = 'in-sync';
  else if (remoteChanged && localChanged) status = 'conflict';
  else if (remoteChanged) status = 'remote-newer';
  else status = 'local-newer';
  return { status, remoteRes, localRes };
}

// De-dup guard: one in-flight evaluation per directory. Rapid re-navigation
// must not stack remote stats against a slow share.
const _evalInFlight = new Map();

/**
 * Evaluate every mirror in a directory and persist results. Projection to
 * the sidecar happens only when a status actually transitions. Emits one
 * 'mirror-state-updated' at the end (emit is injected — this module stays
 * IPC-agnostic).
 */
async function evaluateMirrorsForDir(dirPath, { emit } = {}) {
  const normalized = path.resolve(dirPath);
  if (_evalInFlight.has(normalized)) return _evalInFlight.get(normalized);

  const job = (async () => {
    try {
      const mirrors = db.getMirrorsForDir(normalized);
      if (mirrors.length === 0) return { evaluated: 0 };

      let transitioned = false;
      for (const mirror of mirrors) {
        if (mirror.sync_status === 'syncing') continue; // transfer owns the row right now
        const result = await evaluateMirror(mirror);
        const patch = {
          last_evaluated_at: Date.now(),
          last_eval_remote_mtime: result.remoteRes?.stat?.mtimeMs ?? null,
          last_eval_remote_size: result.remoteRes?.stat?.size ?? null,
          error_message: result.errorMessage || null
        };
        if (result.status !== mirror.sync_status) {
          patch.sync_status = result.status;
          if (result.status === 'tombstone' && !mirror.tombstone_at) patch.tombstone_at = Date.now();
          if (result.status !== 'tombstone' && mirror.tombstone_at) patch.tombstone_at = null;
          transitioned = true;
        }
        db.updateMirrorState(mirror.id, patch);
      }

      if (transitioned) projectSidecar(normalized);
      if (typeof emit === 'function') {
        emit('mirror-state-updated', {
          dirPath: normalized,
          mirrors: db.getMirrorsForDir(normalized).map(m => ({
            id: m.id, localName: m.local_name, syncStatus: m.sync_status,
            remotePath: m.remote_path, direction: m.direction, errorMessage: m.error_message
          }))
        });
      }
      return { evaluated: mirrors.length };
    } catch (err) {
      logger.error(`mirrors.evaluateMirrorsForDir failed for ${dirPath}: ${err.message}`);
      return { evaluated: 0, error: err.message };
    } finally {
      _evalInFlight.delete(normalized);
    }
  })();

  _evalInFlight.set(normalized, job);
  return job;
}

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------

// Promise-semaphore (same shape as main.js acquireChecksumSlot): bounded
// concurrent transfers so a batch adoption doesn't saturate an SMB link.
let _activeTransfers = 0;
const _transferWaiters = [];
function acquireTransferSlot() {
  const max = getMirrorSettings().transferMaxConcurrent;
  if (_activeTransfers < max) {
    _activeTransfers++;
    return Promise.resolve(() => releaseTransferSlot());
  }
  return new Promise(resolve => {
    _transferWaiters.push(() => {
      _activeTransfers++;
      resolve(() => releaseTransferSlot());
    });
  });
}
function releaseTransferSlot() {
  _activeTransfers--;
  const next = _transferWaiters.shift();
  if (next) next();
}

/**
 * Copy authoritative side -> other side, verified.
 *
 * Uses fs.promises streams, NOT FilesystemService — its readdir/stat calls
 * are synchronous and a slow SMB share would freeze the whole main process.
 *
 * Writes to a temp name and renames into place after MD5 verification so a
 * dropped connection can never leave a half-written file under the real
 * name. The destination mtime is then set to the source's: after a sync both
 * sides share one fingerprint, which is what lets evaluateMirror detect
 * which side changed with a single stored (mtime,size,md5) triple.
 */
async function syncMirror(mirrorId, { onProgress, emit, reverse } = {}) {
  const mirror = db.getMirrorById(mirrorId);
  if (!mirror) return { ok: false, status: 'error', error: 'mirror not found' };
  if (mirror.sync_status === 'syncing') return { ok: false, status: 'syncing', error: 'transfer already in progress' };

  const localPath = path.join(mirror.local_dir, mirror.local_name);
  // reverse = bootstrap: the creation gesture declared which side will be the
  // authority, but only the OTHER side exists yet, so the first copy must
  // flow from the existing side (e.g. "source follows this copy" downloads
  // first; every later sync uploads).
  const copyFromRemote = (mirror.direction === 'remote-mirror') !== !!reverse;
  const srcPath = copyFromRemote ? mirror.remote_path : localPath;
  const destPath = copyFromRemote ? localPath : mirror.remote_path;
  const tmpPath = path.join(path.dirname(destPath), `.atlas-tmp-${path.basename(destPath)}`);

  const notify = (payload) => {
    if (typeof onProgress === 'function') { try { onProgress(payload); } catch { /* UI only */ } }
    if (typeof emit === 'function') {
      emit('mirror-transfer-progress', {
        mirrorId: mirror.id, dirPath: mirror.local_dir, localName: mirror.local_name, ...payload
      });
    }
  };

  const release = await acquireTransferSlot();
  const prevStatus = mirror.sync_status;
  db.updateMirrorState(mirror.id, { sync_status: 'syncing', error_message: null });
  notify({ phase: 'starting', bytesDone: 0, bytesTotal: 0 });

  const fail = (message) => {
    db.updateMirrorState(mirror.id, { sync_status: 'error', error_message: message });
    projectSidecar(mirror.local_dir);
    notify({ phase: 'error', error: message });
    logger.warn(`mirrors.syncMirror ${mirror.id} (${mirror.local_name}): ${message}`);
    return { ok: false, status: 'error', error: message };
  };

  try {
    const srcRes = await statWithTimeout(srcPath, getMirrorSettings().remoteStatTimeoutMs);
    if (srcRes.status !== 'ok') {
      return fail(`source not readable: ${srcPath} (${srcRes.status})`);
    }
    const bytesTotal = srcRes.stat.size;

    // Stream copy, hashing the source inline (the source hash comes free
    // during the copy; only the destination needs a separate read).
    const srcHash = crypto.createHash('md5');
    let bytesDone = 0;
    let lastNotify = 0;
    await new Promise((resolve, reject) => {
      const rs = fsSync.createReadStream(srcPath);
      const ws = fsSync.createWriteStream(tmpPath);
      rs.on('data', (chunk) => {
        srcHash.update(chunk);
        bytesDone += chunk.length;
        const now = Date.now();
        if (now - lastNotify > 250) {
          lastNotify = now;
          notify({ phase: 'copying', bytesDone, bytesTotal });
        }
      });
      rs.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', resolve);
      rs.pipe(ws);
    });
    const srcMd5 = srcHash.digest('hex');

    notify({ phase: 'verifying', bytesDone, bytesTotal });
    const destMd5 = await checksum.calculateMD5(tmpPath);
    if (!destMd5.value || destMd5.value !== srcMd5) {
      await fsp.unlink(tmpPath).catch(() => {});
      return fail('verification failed — copied bytes do not match source');
    }

    // Align the destination mtime with the source before the rename so both
    // sides carry the shared fingerprint.
    await fsp.utimes(tmpPath, srcRes.stat.atime, srcRes.stat.mtime).catch(() => {});

    // Windows rename() cannot overwrite an existing file, so the previous
    // copy is removed first. The window between unlink and rename is the
    // unavoidable cost of the verified-temp-file approach; the verified temp
    // file is already complete at this point, so a crash here loses nothing.
    try {
      await fsp.unlink(destPath).catch(err => { if (err.code !== 'ENOENT') throw err; });
      await fsp.rename(tmpPath, destPath);
    } catch (err) {
      await fsp.unlink(tmpPath).catch(() => {});
      return fail(`could not move verified copy into place: ${err.message}`);
    }

    const destStat = await fsp.stat(destPath).catch(() => null);
    db.updateMirrorState(mirror.id, {
      sync_status: 'in-sync',
      last_synced_at: Date.now(),
      last_synced_mtime: destStat ? destStat.mtimeMs : srcRes.stat.mtimeMs,
      last_synced_size: bytesTotal,
      last_synced_md5: srcMd5,
      tombstone_at: null,
      error_message: null
    });
    projectSidecar(mirror.local_dir);
    notify({ phase: 'done', bytesDone, bytesTotal });
    return { ok: true, status: 'in-sync', md5: srcMd5 };
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {});
    return fail(err.message);
  } finally {
    release();
    // If we bailed before any status write stuck, don't leave 'syncing' behind.
    const now = db.getMirrorById(mirror.id);
    if (now && now.sync_status === 'syncing') {
      db.updateMirrorState(mirror.id, { sync_status: prevStatus });
    }
  }
}

// ---------------------------------------------------------------------------
// Sidecar projection (DB -> file)
// ---------------------------------------------------------------------------

function buildSidecarData(dirPath) {
  const mirrors = db.getMirrorsForDir(dirPath);
  return {
    version: SCHEMA_VERSION,
    mirrors: mirrors.map(m => ({
      remotePath: m.remote_path,
      localName: m.local_name,
      direction: m.direction,
      policy: m.policy ? (() => { try { return JSON.parse(m.policy); } catch { return null; } })() : null,
      state: {
        status: m.sync_status,
        lastSyncedAt: m.last_synced_at,
        lastSyncedMtime: m.last_synced_mtime,
        lastSyncedSize: m.last_synced_size,
        lastSyncedMd5: m.last_synced_md5
      },
      tombstone: m.tombstone_at || null
    }))
  };
}

/**
 * Project DB state into this machine's sidecar. Callers invoke this on
 * status TRANSITIONS only — never per evaluation tick (OneDrive churn).
 *
 * Check-before-overwrite: if the on-disk sidecar doesn't match the cached
 * last-written copy, someone edited it off-app. That edit is legitimate user
 * input, so it routes to the diff/review flow and this write is skipped —
 * Atlas never clobbers a file it didn't write.
 */
function projectSidecar(dirPath) {
  try {
    const normalized = path.resolve(dirPath);
    const filePath = sidecarPath(normalized);
    const record = db.getMirrorSidecar(normalized);

    let onDiskRaw = null;
    try { onDiskRaw = fsSync.readFileSync(filePath, 'utf8'); }
    catch (err) { if (err.code !== 'ENOENT') { logger.warn(`mirrors.projectSidecar read ${filePath}: ${err.message}`); return { skipped: true }; } }

    const cached = record ? record.cached_copy : null;
    if (onDiskRaw !== null && onDiskRaw !== cached) {
      // Off-app edit (or a file we never wrote). Surface for review instead
      // of overwriting; maybeAbsorbSidecar creates the adoption row on the
      // next scan, we just refuse the write here.
      logger.info(`mirrors.projectSidecar: ${filePath} changed off-app; skipping projection`);
      return { skipped: true, offAppEdit: true };
    }

    const mirrors = db.getMirrorsForDir(normalized);
    if (mirrors.length === 0) {
      // Last mirror removed: retire the sidecar (safe — verified above that
      // the on-disk content is our own last write).
      if (onDiskRaw !== null) fsSync.unlinkSync(filePath);
      db.deleteMirrorSidecar(normalized);
      return { removed: true };
    }

    const text = JSON.stringify(buildSidecarData(normalized), null, 2);
    if (text === cached && onDiskRaw !== null) return { unchanged: true };
    fsSync.writeFileSync(filePath, text, 'utf8');
    const stat = fsSync.statSync(filePath);
    db.setMirrorSidecar(normalized, { mtime: stat.mtimeMs, cachedCopy: text });
    return { written: true };
  } catch (err) {
    logger.warn(`mirrors.projectSidecar failed for ${dirPath}: ${err.message}`);
    return { skipped: true, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Sidecar absorption (file -> adoption row -> DB)
// ---------------------------------------------------------------------------

/**
 * Called from the directory scan (same call site pattern as
 * atlasJson.maybeAbsorb). Cheap and local-only: one existsSync/statSync on
 * this machine's own sidecar; remote stats happen later, when the review
 * modal asks for enriched entries.
 *
 * Never writes mirror rows — discovery creates a mirror_adoptions row that
 * the UI surfaces as an inline banner. The stored mtime advances only when
 * the adoption resolves, so an ignored banner re-triggers next browse.
 */
function maybeAbsorbSidecar(dirPath) {
  try {
    const normalized = path.resolve(dirPath);
    const filePath = sidecarPath(normalized);
    const record = db.getMirrorSidecar(normalized);
    const exists = fsSync.existsSync(filePath);

    if (!exists) {
      // Whole-file deletion of a sidecar we previously wrote, while mirrors
      // still exist: full-scale off-app change — confirm release or restore.
      if (record && record.cached_copy && db.getMirrorsForDir(normalized).length > 0) {
        if (!db.getPendingAdoptionForDir(normalized)) {
          const { id } = db.createMirrorAdoption(normalized, 'sidecar-deleted', {
            entries: [],
            diff: diffSidecar(null, safeParse(record.cached_copy)),
            mirrorCount: db.getMirrorsForDir(normalized).length
          });
          return { pendingAdoption: db.getMirrorAdoptionById(id) };
        }
        return { pendingAdoption: db.getPendingAdoptionForDir(normalized) };
      }
      return { pendingAdoption: db.getPendingAdoptionForDir(normalized) };
    }

    let stat;
    try { stat = fsSync.statSync(filePath); } catch { return {}; }

    if (record && record.sidecar_mtime !== null && stat.mtimeMs <= record.sidecar_mtime) {
      return { pendingAdoption: db.getPendingAdoptionForDir(normalized) };
    }
    if (db.getPendingAdoptionForDir(normalized)) {
      return { pendingAdoption: db.getPendingAdoptionForDir(normalized) };
    }

    const read = readSidecar(normalized);
    if (!read.ok) {
      // Malformed JSON: skip WITHOUT stamping mtime so the next browse
      // retries once the user fixes the file.
      if (read.parseError) logger.warn(`mirrors.maybeAbsorbSidecar: parse error in ${filePath}: ${read.error}`);
      return {};
    }

    const { valid, rejected, fileError } = validateEntries(read.data);
    const cachedData = record ? safeParse(record.cached_copy) : null;
    const source = record && record.cached_copy ? 'sidecar-diff' : 'sidecar-new';
    const diff = diffSidecar(read.data, cachedData);

    if (!fileError && diff.added.length === 0 && diff.removed.length === 0 &&
        diff.changed.length === 0 && rejected.length === 0) {
      // Touched but semantically identical (e.g. re-saved without changes):
      // stamp so it doesn't re-prompt, nothing to review.
      db.setMirrorSidecar(normalized, { mtime: stat.mtimeMs, cachedCopy: record?.cached_copy ?? read.raw });
      return {};
    }

    const { id } = db.createMirrorAdoption(normalized, source, {
      entries: valid, rejected, fileError: fileError || null, diff
    });
    return { pendingAdoption: db.getMirrorAdoptionById(id) };
  } catch (err) {
    logger.warn(`mirrors.maybeAbsorbSidecar failed for ${dirPath}: ${err.message}`);
    return {};
  }
}

function safeParse(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Enrich adoption entries for the review modal: presence-based direction
 * guesses and per-entry notes. Async (stats both sides, remote included) —
 * runs when the modal opens, never during the scan.
 */
async function prepareAdoptionEntries(dirPath, payload) {
  const { remoteStatTimeoutMs } = getMirrorSettings();
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  const enriched = [];
  for (const entry of entries) {
    const localPath = path.join(dirPath, entry.localName);
    const existing = db.getMirrorByLocal(path.resolve(dirPath), entry.localName);
    const [remoteRes, localRes] = await Promise.all([
      statWithTimeout(entry.remotePath, remoteStatTimeoutMs),
      statWithTimeout(localPath, remoteStatTimeoutMs)
    ]);
    const remoteExists = remoteRes.status === 'ok' && !remoteRes.stat.isDirectory();
    const localExists = localRes.status === 'ok';
    const guess = guessDirection({ remoteExists, localExists });
    let note = null;
    if (existing) note = 'already mirrored in this directory';
    else if (remoteRes.status === 'timeout') note = 'remote source did not respond';
    else if (remoteRes.status === 'ok' && remoteRes.stat.isDirectory()) note = 'remote path is a directory (not supported in v1)';
    else if (guess.action === 'error') note = 'neither remote nor local file exists';
    else if (guess.action === 'compare') note = 'both sides exist — will link if identical, conflict if different';
    enriched.push({
      ...entry,
      guessedDirection: entry.direction || guess.direction,
      guessedAction: guess.action,
      remoteExists, localExists,
      alreadyMirrored: !!existing,
      note,
      valid: !existing && guess.action !== 'error' && remoteRes.status !== 'timeout' &&
             !(remoteRes.status === 'ok' && remoteRes.stat.isDirectory())
    });
  }
  return enriched;
}

/**
 * Resolve a pending adoption.
 *  - 'adopted': create mirrors for the approved entries (each already carries
 *    its user-confirmed direction), stamp the sidecar mtime, reproject.
 *    Initial transfers are queued fire-and-forget (bounded by the transfer
 *    semaphore) so a bulk adoption returns immediately.
 *  - 'restored': rewrite the sidecar from the cached last-written copy.
 *  - 'rejected': stamp mtime so this file version stops re-prompting; no DB
 *    changes.
 */
async function resolveAdoption(adoptionId, resolution, approvedEntries, { emit } = {}) {
  try {
    const adoption = db.getMirrorAdoptionById(adoptionId);
    if (!adoption) return { ok: false, error: 'adoption not found' };
    if (adoption.resolved_at) return { ok: false, error: 'adoption already resolved' };
    const dirPath = adoption.dir_path;
    const filePath = sidecarPath(dirPath);

    if (resolution === 'restored') {
      const record = db.getMirrorSidecar(dirPath);
      if (record && record.cached_copy) {
        fsSync.writeFileSync(filePath, record.cached_copy, 'utf8');
        const stat = fsSync.statSync(filePath);
        db.setMirrorSidecar(dirPath, { mtime: stat.mtimeMs, cachedCopy: record.cached_copy });
      }
      db.resolveMirrorAdoption(adoptionId, 'restored');
      return { ok: true, results: [] };
    }

    if (resolution === 'rejected') {
      // Keep the OLD cached copy: the new on-disk content was not adopted, so
      // later projections must keep refusing to overwrite it (mtime stamp
      // alone stops the re-prompt loop).
      try {
        const stat = fsSync.statSync(filePath);
        const record = db.getMirrorSidecar(dirPath);
        db.setMirrorSidecar(dirPath, { mtime: stat.mtimeMs, cachedCopy: record?.cached_copy ?? null });
      } catch {
        // sidecar-deleted case: clear the cached copy so the deletion stops
        // re-prompting; a later status transition may recreate the projection.
        db.setMirrorSidecar(dirPath, { mtime: null, cachedCopy: null });
      }
      db.resolveMirrorAdoption(adoptionId, 'rejected');
      return { ok: true, results: [] };
    }

    // 'adopted'
    const entries = Array.isArray(approvedEntries) ? approvedEntries : [];
    const results = [];
    const toSync = [];
    for (const entry of entries) {
      const res = await createMirror({
        origin: 'sidecar',
        confirmed: true,
        skipInitialSync: true,
        remotePath: entry.remotePath,
        localDir: dirPath,
        localName: entry.localName,
        direction: entry.direction || entry.guessedDirection || null,
        policy: entry.policy || null,
        seedState: entry.seedState || null
      });
      results.push({ remotePath: entry.remotePath, ...res });
      if (res.ok && res.needsTransfer) toSync.push({ id: res.mirror.id, reverse: !!res.needsReverse });
    }

    // Handle removals from a diff (entries the user confirmed as removed):
    // detach only — never delete the local file from an off-app edit.
    const removedPaths = Array.isArray(adoption.payload?.diff?.removed)
      ? adoption.payload.diff.removed.map(e => e.remotePath?.toLowerCase()).filter(Boolean)
      : [];
    if (removedPaths.length > 0 && (adoption.source === 'sidecar-diff' || adoption.source === 'sidecar-deleted')) {
      for (const m of db.getMirrorsForDir(dirPath)) {
        if (removedPaths.includes(m.remote_path.toLowerCase())) db.deleteMirror(m.id);
      }
    }

    db.resolveMirrorAdoption(adoptionId, 'adopted');
    // Adopting makes the on-disk (hand-authored) content trusted: cache it as
    // "our copy" so the projection below passes check-before-overwrite and
    // replaces it with the merged declarations+state form.
    try {
      const stat = fsSync.statSync(filePath);
      const onDisk = fsSync.readFileSync(filePath, 'utf8');
      db.setMirrorSidecar(dirPath, { mtime: stat.mtimeMs, cachedCopy: onDisk });
    } catch {
      db.setMirrorSidecar(dirPath, { mtime: null, cachedCopy: null });
    }
    projectSidecar(dirPath);

    for (const { id, reverse } of toSync) {
      syncMirror(id, { emit, reverse }).then(() => {
        if (typeof emit === 'function') {
          emit('mirror-state-updated', {
            dirPath,
            mirrors: db.getMirrorsForDir(dirPath).map(m => ({
              id: m.id, localName: m.local_name, syncStatus: m.sync_status,
              remotePath: m.remote_path, direction: m.direction, errorMessage: m.error_message
            }))
          });
        }
      }).catch(err => logger.warn(`mirrors.resolveAdoption initial sync ${id}: ${err.message}`));
    }

    return { ok: true, results, syncQueued: toSync };
  } catch (err) {
    logger.error(`mirrors.resolveAdoption failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Detach
// ---------------------------------------------------------------------------

/**
 * Remove the mirror relationship. deleteLocal additionally removes the local
 * copy — the remote side is NEVER touched here (deletion never propagates).
 */
async function detachMirror(mirrorId, { deleteLocal } = {}) {
  try {
    const mirror = db.getMirrorById(mirrorId);
    if (!mirror) return { ok: false, error: 'mirror not found' };
    db.deleteMirror(mirrorId);
    if (deleteLocal) {
      await fsp.unlink(path.join(mirror.local_dir, mirror.local_name))
        .catch(err => { if (err.code !== 'ENOENT') throw err; });
    }
    projectSidecar(mirror.local_dir);
    return { ok: true };
  } catch (err) {
    logger.error(`mirrors.detachMirror failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  SCHEMA_VERSION,
  sidecarName,
  sidecarPath,
  isSidecarFilename,
  readSidecar,
  validateEntries,
  diffSidecar,
  guessDirection,
  createMirror,
  evaluateMirror,
  evaluateMirrorsForDir,
  syncMirror,
  projectSidecar,
  maybeAbsorbSidecar,
  prepareAdoptionEntries,
  resolveAdoption,
  detachMirror,
  // internals exported for tests
  _statWithTimeout: statWithTimeout,
  _sideChanged: sideChanged,
  _buildSidecarData: buildSidecarData
};
