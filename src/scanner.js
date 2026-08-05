'use strict';

/**
 * src/scanner.js
 *
 * Core directory-scan logic shared between the Electron main process
 * (main/main.js) and the standalone HTTP server (server/src/api-router.js).
 *
 * The only external dependency that differs between the two environments is
 * how push events are dispatched after a scan.  Callers supply a `notify`
 * callback with the signature:
 *
 *   notify(eventName)
 *
 * where eventName is one of:
 *   'todo-aggregates-changed'
 *   'reminder-aggregates-changed'
 *
 * Pass a no-op function when notifications are not needed.
 */

const path           = require('path');
const fsSync         = require('fs');

const logger             = require('./logger');
const db                 = require('./db');
const fs                 = require('./filesystem');
const categories         = require('./categories');
const notesParser        = require('./notesParser');
const todoAggregator     = require('./todoAggregator');
const reminderAggregator = require('./reminderAggregator');
const atlasJson          = require('./atlasJson');
const mirrors            = require('./mirrors');
// Top-level require is safe: contentExtractor lazy-requires its parsers, so
// only the extension map is loaded here (matters for the standalone server).
const contentExtractor   = require('./contentExtractor');

// ---------------------------------------------------------------------------
// Alert-rule helpers
// ---------------------------------------------------------------------------

function doesRuleMatchFilters(rule, category, tagsJson, attributesJson) {
  if (rule.categories !== 'ANY') {
    try {
      const ruleCategories = JSON.parse(rule.categories);
      if (!ruleCategories.includes(category)) return false;
    } catch {
      return false;
    }
  }

  if (rule.tags !== 'ANY') {
    try {
      const ruleTags = JSON.parse(rule.tags);
      const itemTags = tagsJson ? JSON.parse(tagsJson) : [];
      if (!ruleTags.some(tag => itemTags.includes(tag))) return false;
    } catch {
      return false;
    }
  }

  if (rule.attributes !== 'ANY') {
    try {
      const ruleAttrs = JSON.parse(rule.attributes);
      const itemAttrs = attributesJson ? JSON.parse(attributesJson) : {};
      const allMatch = ruleAttrs.every(attr => {
        if (attr.value === '' || attr.value === null || typeof attr.value === 'undefined') {
          return Object.prototype.hasOwnProperty.call(itemAttrs, attr.name);
        }
        return itemAttrs[attr.name] === attr.value;
      });
      if (!allMatch) return false;
    } catch {
      return false;
    }
  }

  return true;
}

function doesEventMatchRules(rules, eventType, category, dirTagsJson, fileAttributesJson) {
  for (const rule of rules) {
    if (!rule.enabled) continue;

    let events;
    try { events = JSON.parse(rule.events); } catch { continue; }
    if (!Array.isArray(events) || !events.includes(eventType)) continue;

    if (!doesRuleMatchFilters(rule, category, dirTagsJson, fileAttributesJson)) {
      continue;
    }

    return rule;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scan helpers
// ---------------------------------------------------------------------------

function getObservationSource(isManualNavigation, isBackgroundRefresh, options = {}) {
  return options.observationSource || (isManualNavigation ? 'manual' : isBackgroundRefresh ? 'background-refresh' : 'scan');
}

function getMonitoringObservationDeadTimeMs() {
  const settings = categories.getSettings();
  const value = Math.max(1, Number(settings.monitoring_observation_dead_time_value) || 1);
  const unit = settings.monitoring_observation_dead_time_unit || 'hours';

  switch (unit) {
    case 'minutes':
      return value * 60 * 1000;
    case 'days':
      return value * 24 * 60 * 60 * 1000;
    case 'hours':
    default:
      return value * 60 * 60 * 1000;
  }
}

/**
 * True for inodes this app synthesises rather than reads off the filesystem:
 * `link:<filename>` for symlinks/junctions, `-1:<filename>` for entries that
 * could not be stat'd.
 *
 * These encode a FILENAME, not filesystem identity, so the same string legally
 * appears in many directories at once. Any lookup that treats an inode as a
 * unique handle on one object — move detection above all — must skip them, or
 * every same-named link reads as the same file having moved.
 */
function isSyntheticInode(inode) {
  return typeof inode === 'string' && (inode.startsWith('link:') || inode.startsWith('-1:'));
}

/**
 * True when `p` exists on disk and is a symlink/junction. Used to tell "the
 * listing omits this on purpose" apart from "this is gone".
 */
function isExistingLink(p) {
  try {
    return fsSync.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function ensureDirectoryRecord(dirPath, inode, categoryName = 'Default') {
  const existingByPath = db.getDirectory(dirPath);
  if (existingByPath) {
    db.upsertDirectory(
      dirPath,
      inode,
      existingByPath.category || categoryName,
      existingByPath.description || null,
      existingByPath.initials || null,
      existingByPath.parent_id,
      existingByPath.category_force || 0
    );
    db.updateDirectoryParent(dirPath, db.getParentDirectoryId(dirPath));
    return { dir: db.getDirectory(dirPath), isNew: false, movedFrom: null };
  }

  // An inode match means "this directory was renamed/moved" ONLY if the path we
  // have on record is actually gone. Two live paths can legitimately share an
  // inode — a Windows junction reports its target's inode under fs.stat — and
  // rehoming the row on that basis makes the two paths fight over a single row,
  // renaming it back and forth once per scan and emitting a dirAdded every time.
  // (The `My Documents` → `Documents` junction in a user profile did exactly
  // this: 376 bogus history rows. See agent-docs/DECISIONS.md#junction-identity.)
  // When both paths exist we fall through and give this one its own row.
  const existingByInode = db.getDirectoryByInode(inode);
  if (existingByInode && !fsSync.existsSync(existingByInode.dirname)) {
    const parentId = db.getParentDirectoryId(dirPath);
    const previousPath = existingByInode.dirname;
    db.updateDirectoryPath(existingByInode.id, dirPath, parentId);
    return { dir: db.getDirectory(dirPath), isNew: true, movedFrom: previousPath };
  }

  const dirId = db.getOrCreateDirectory(dirPath, inode, categoryName);
  db.updateDirectoryParent(dirPath, db.getParentDirectoryId(dirPath));
  return { dir: db.getDirById(dirId), isNew: true, movedFrom: null };
}

function recordDirectoryObservation(dirEntry, eventType, source, hasChanges, fileChanges, dirChanges) {
  const detectedAt = Date.now();
  const latestObservation = db.getLatestDirectoryHistory(dirEntry.id);
  const deadTimeMs = getMonitoringObservationDeadTimeMs();
  let shouldInsert = true;

  if (!hasChanges && latestObservation && deadTimeMs > 0) {
    shouldInsert = (detectedAt - latestObservation.detectedAt) >= deadTimeMs;
  }

  db.updateDirectoryObservation(dirEntry.dirname, source, detectedAt);

  if (!shouldInsert) {
    return { id: null, detectedAt };
  }

  const result = db.insertDirHistory(dirEntry.id, eventType, {
    dirname: path.basename(dirEntry.dirname),
    source,
    hasChanges,
    fileChanges,
    dirChanges,
    status: hasChanges ? 'changed' : (eventType === 'dirOpened' ? 'opened' : eventType === 'dirSeen' ? 'seen' : 'observed')
  }, detectedAt);

  return { id: result.lastInsertRowid, detectedAt };
}

function createStandaloneDirHistory(dirEntry, source, fileChanges = 1, dirChanges = 0, status = 'manual') {
  const result = db.insertDirHistory(dirEntry.id, 'dirManual', {
    dirname: path.basename(dirEntry.dirname),
    source,
    hasChanges: true,
    fileChanges,
    dirChanges,
    status
  });

  return result.lastInsertRowid;
}

// ---------------------------------------------------------------------------
// Core scan
// ---------------------------------------------------------------------------

/**
 * Scan a directory, compare against the DB, record history & alerts.
 *
 * @param {string}   dirPath
 * @param {boolean}  [isManualNavigation=true]
 * @param {boolean}  [isBackgroundRefresh=false]
 * @param {object}   [options={}]
 * @param {function} [notify]  Called with event name when aggregates change.
 *                             Signature: notify(eventName: string) => void
 */
function doScanDirectoryWithComparison(dirPath, isManualNavigation = true, isBackgroundRefresh = false, options = {}, notify = () => {}) {
  try {
    if (!dirPath || typeof dirPath !== 'string') {
      logger.error(`scan-directory-with-comparison: Invalid path - received ${typeof dirPath}`);
      return { success: false, error: 'Directory path must be a valid string' };
    }

    const normalizedPath = dirPath.trim();
    if (!normalizedPath) {
      logger.error('scan-directory-with-comparison: Empty path provided');
      return { success: false, error: 'Directory path cannot be empty' };
    }

    // UNC server root (\\hostname) — can't be stat'd; enumerate shares and return early
    if (fs.isUncServerRoot(normalizedPath)) {
      const shareEntries = fs.readUncShares(normalizedPath);
      return {
        success: true,
        count: 0,
        entries: shareEntries.map(e => ({ ...e, changeState: 'unchanged' })),
        category: null,
        categoryData: null,
        hasChanges: false,
        alertsCreated: 0,
        orphanCount: 0,
        trashCount: 0,
      };
    }

    // Atlas JSON absorption: if this directory's category is 'full-sync', check
    // whether atlas.json has been edited externally and absorb it before we scan.
    // This runs on every navigate AND on explicit Refresh (which also calls this
    // function), so the user gets up-to-date data in both cases.
    atlasJson.maybeAbsorb(normalizedPath);

    // Mirror sidecar discovery follows the same lazy pattern, but never
    // writes mirrors directly — it surfaces a pending adoption for the UI.
    // Cheap and local-only (one stat on this machine's own sidecar); remote
    // evaluation is deferred to an async pass after the scan returns.
    const mirrorAbsorb = mirrors.maybeAbsorbSidecar(normalizedPath);

    const dirStats = fs.getStats(normalizedPath);
    if (!dirStats) {
      return { success: false, error: 'Unable to read directory stats' };
    }

    const dirInode = dirStats.inode;

    const category = categories.getCategoryForDirectory(normalizedPath);
    const categoryName = category ? category.name : 'Default';
    const observationSource = getObservationSource(isManualNavigation, isBackgroundRefresh, options);

    const currentDirInfo = ensureDirectoryRecord(normalizedPath, dirInode, categoryName);
    const dirId = currentDirInfo.dir.id;
    const initialObservation = !db.getLatestDirectoryObservation(dirId);
    const currentDirEventType = isManualNavigation ? 'dirOpened' : 'dirObserved';

    let alertRules = [];
    try { alertRules = db.getAlertRules(); } catch (e) { /* non-fatal */ }
    const dirTagsJson = db.getTagsForDirectoryId(dirId);
    let alertsCreated = 0;

    db.upsertFile({
      inode: dirInode,
      dir_id: dirId,
      filename: '.',
      dateModified: dirStats.dateModified,
      dateCreated: dirStats.dateCreated,
      size: 0,
      mode: dirStats.mode ?? null
    });

    const existingDbFiles = db.getFilesByDirId(dirId);
    const dbFileMap = new Map(existingDbFiles.map(f => [f.inode, f]));

    // Deep content search: one cheap metadata-only query per dir, only when
    // the category opts in. Extraction itself never runs on the scan path.
    const contentMeta = (category && category.deepSearchEnabled)
      ? db.getContentMetaForDir(dirId)
      : null;

    const ignoreFilenames = isBackgroundRefresh
      ? existingDbFiles.filter(f => f.inode.startsWith('-1:')).map(f => f.filename)
      : [];

    for (const filename of ignoreFilenames) {
      dbFileMap.delete(`-1:${filename}`);
    }

    // withAttributes: the scan is the one place that pays for Windows
    // hidden/system bits (~90ms per directory, in the background scan rather
    // than the interactive render). They are persisted onto the rows so the
    // cached render can filter without paying it again, and so deep search —
    // which walks thousands of directories — never has to.
    const entries = fs.readDirectory(normalizedPath, ignoreFilenames, { withAttributes: true });
    const entriesWithChanges = [];
    const pendingMissingFiles = [];
    const pendingMissingDirs = [];
    const pendingPermErrorEntries = [];
    const existingChildDirs = db.getDirectoryChildren(dirId);
    const childDirMap = new Map(existingChildDirs.map(child => [child.id, child]));

    for (const entry of entries) {
      if (entry.permError) {
        const permErrMode = -1;
        const existingPermErr = dbFileMap.get(entry.inode);

        db.upsertFile({
          inode: entry.inode,
          dir_id: dirId,
          filename: entry.filename,
          dateModified: null,
          dateCreated: null,
          size: 0,
          mode: permErrMode
        });

        const permErrFileRecord = db.getFileByInode(entry.inode, dirId);
        if (permErrFileRecord && (!existingPermErr || existingPermErr.mode !== permErrMode)) {
          pendingPermErrorEntries.push({
            inode: entry.inode,
            filename: entry.filename,
            fileId: permErrFileRecord.id,
            mode: permErrMode
          });
        }

        dbFileMap.delete(entry.inode);

        if (!isBackgroundRefresh) {
          entriesWithChanges.push({
            ...entry,
            changeState: 'permError',
            dir_id: dirId,
            mode: permErrMode
          });
        }
        continue;
      }

      // Links are listed but never traversed. They get a row in `files` (so
      // they persist and don't re-report as 'new' every scan) under their
      // synthetic path-stable inode, and nothing else: no dirs record even
      // when they point at a directory, so no recursion, no child-dir
      // bookkeeping, no checksum, no content extraction. Keeping them out of
      // the dirs table is what stops a junction from being scanned as though
      // it were a second copy of its target.
      if (entry.isLink) {
        const dbLink = dbFileMap.get(entry.inode);
        let changeState = 'unchanged';
        if (!dbLink) {
          changeState = 'new';
        } else if (dbLink.dateModified !== entry.dateModified) {
          changeState = 'dateModified';
        }

        db.upsertFile({
          inode: entry.inode,
          dir_id: dirId,
          filename: entry.filename,
          dateModified: entry.dateModified,
          dateCreated: entry.dateCreated,
          size: 0,
          mode: entry.mode ?? null,
          attrs: entry.attrs ?? null
        });

        entriesWithChanges.push({
          ...entry,
          changeState,
          dir_id: dirId,
          perms: entry.perms || { read: false, write: false },
          mode: entry.mode ?? null,
          tags: (dbLink && dbLink.tags) ? dbLink.tags : null,
          attributes: (dbLink && dbLink.attributes) ? dbLink.attributes : null
        });

        dbFileMap.delete(entry.inode);
        continue;
      }

      if (!entry.isDirectory) {
        const stalePermErrInode = `-1:${entry.filename}`;
        if (dbFileMap.has(stalePermErrInode)) {
          db.deleteFile(stalePermErrInode, dirId);
          dbFileMap.delete(stalePermErrInode);
        }

        const dbFile = dbFileMap.get(entry.inode);
        let changeState = 'unchanged';
        const wasRenamed = !!(dbFile && entry.filename !== dbFile.filename);

        if (!dbFile) {
          changeState = 'new';
        } else if (dbFile.dateModified !== entry.dateModified) {
          changeState = 'dateModified';
        } else if ((dbFile.mode ?? null) !== (entry.mode ?? null)) {
          changeState = 'modeChanged';
        }

        if (category && category.enableChecksum) {
          const needsChecksum = !dbFile ||
                                changeState === 'dateModified' ||
                                !dbFile.checksumValue;
          if (needsChecksum) {
            changeState = 'checksumPending';
          }
        }

        // Deep content search: a separate pending boolean (NOT a changeState —
        // a file can need both checksum and content extraction at once).
        let contentPending = false;
        let contentStatus = null;
        if (contentMeta && contentExtractor.isSupported(entry.filename)) {
          const meta = dbFile ? contentMeta.get(dbFile.id) : null;
          contentStatus = meta ? meta.status : null;
          if (!meta || meta.source_mtime !== entry.dateModified) {
            contentPending = true;
          }
        }

        entriesWithChanges.push({
          ...entry,
          changeState,
          contentPending,
          contentStatus,
          dir_id: dirId,
          checksumValue: (dbFile && dbFile.checksumValue) ? dbFile.checksumValue : null,
          checksumStatus: (dbFile && dbFile.checksumStatus) ? dbFile.checksumStatus : null,
          perms: entry.perms || { read: false, write: false },
          mode: entry.mode ?? null,
          tags: (dbFile && dbFile.tags) ? dbFile.tags : null,
          attributes: (dbFile && dbFile.attributes) ? dbFile.attributes : null,
          wasRenamed,
          previousFilename: wasRenamed ? dbFile.filename : null
        });

        dbFileMap.delete(entry.inode);
      } else {
        const subDirCategory = categories.getCategoryForDirectory(entry.path);
        const subDirCategoryName = subDirCategory ? subDirCategory.name : 'Default';
        const subDirInfo = ensureDirectoryRecord(entry.path, entry.inode, subDirCategoryName);
        const existingDir = subDirInfo.dir;
        // A child folder's hidden/system bits belong to THIS listing, but the
        // cached render reads child folders from `dirs`, so they are stored on
        // the child's own row.
        db.setDirectoryAttrs(entry.path, entry.attrs ?? null);
        let changeState = 'unchanged';

        if (subDirInfo.isNew) {
          changeState = 'new';
        }
        childDirMap.delete(existingDir.id);

        entriesWithChanges.push({
          ...entry,
          changeState,
          initials: existingDir ? (existingDir.initials || null) : null,
          resolvedInitials: existingDir ? (db.resolveDirectoryInitials(entry.path).value) : null,
          displayName: existingDir ? (existingDir.display_name || null) : null,
          perms: entry.perms || { read: true, write: false },
          mode: entry.mode ?? null,
          tags: existingDir ? db.getTagsForDirectory(entry.path) : null,
          attributes: (() => {
            if (!existingDir) return null;
            const dotFile = db.getFileByFilename(existingDir.id, '.');
            return (dotFile && dotFile.attributes) ? dotFile.attributes : null;
          })(),
          dir_id: existingDir.id
        });
      }
    }

    // Build filename→entry map for disk entries that arrived with an unknown inode.
    // Used below to detect the sync-replace pattern: same filename, rotated inode.
    const newDiskEntriesByFilename = new Map();
    for (const e of entriesWithChanges) {
      // Links are excluded: a link that appears where a real file of the same
      // name was deleted is a new link, not that file rotating its inode.
      if (!e.isDirectory && !e.isLink && e.changeState === 'new') {
        newDiskEntriesByFilename.set(e.filename, e);
      }
    }

    const orphanedEntries = [];
    const pendingMovedFiles = [];
    for (const [inode, dbFile] of dbFileMap) {
      try {
        if (dbFile.filename === '.') {
          continue;
        }

        // Sync-replace detection: same filename appeared on disk with a different inode.
        // OneDrive hydration and Excel's temp-file save both do delete+rename instead of
        // in-place write, rotating the inode while the path stays constant.
        const replacementEntry = newDiskEntriesByFilename.get(dbFile.filename);
        if (replacementEntry) {
          db.replaceFileInode(dbFile.id, replacementEntry.inode, replacementEntry);
          const updatedRecord = db.getFileByInode(replacementEntry.inode, dirId);
          if (updatedRecord) {
            db.insertFileHistory(replacementEntry.inode, dirId, updatedRecord.id, 'fileReplaced', {
              filename: dbFile.filename,
              oldInode: inode,
              newInode: replacementEntry.inode,
              dateModified: replacementEntry.dateModified,
              filesizeBytes: replacementEntry.size
            }, currentDirHistoryId);
            try {
              const replacedRule = doesEventMatchRules(alertRules, 'fileReplaced', categoryName, dirTagsJson, replacementEntry.attributes || null);
              if (replacedRule) {
                db.insertAlert(replacedRule.id, null, 'fileReplaced', dbFile.filename, categoryName, dirId, replacementEntry.inode, null, null);
                alertsCreated++;
              }
            } catch (alertErr) {
              logger.error(`Error creating fileReplaced alert for ${dbFile.filename}:`, alertErr.message);
            }
          }
          // Carry user-managed fields forward so the returned entry is consistent
          replacementEntry.changeState = 'fileReplaced';
          replacementEntry.oldInode = inode;
          replacementEntry.tags = dbFile.tags || null;
          replacementEntry.attributes = dbFile.attributes || null;
          replacementEntry.checksumValue = null;
          replacementEntry.checksumStatus = 'untracked';
          newDiskEntriesByFilename.delete(dbFile.filename);
          logger.info(`File ${dbFile.filename} inode replaced in ${dirPath} (${inode} → ${replacementEntry.inode})`);
          continue;
        }

        // Synthetic inodes encode a filename, so the same string exists in
        // every directory that happens to hold a link (or an unreadable entry)
        // by that name — `link:Desktop` is not one object that moved. Skipping
        // the lookup drops through to the orphan branch below, which is the
        // right answer: the link really is gone from THIS directory.
        const movedFileRecord = isSyntheticInode(inode)
          ? null
          : db.findInodeInOtherDirectories(inode, dirId);

        if (movedFileRecord) {
          const newDirId = movedFileRecord.dir_id_match;
          const orphanResult = db.createOrphan(dirId, dbFile.filename, inode);
          const orphanId = orphanResult.id;
          const transitioned = orphanResult.isNew || orphanResult.new_dir_id !== newDirId;
          if (transitioned) {
            db.updateOrphanNewLocation(orphanId, newDirId);
            pendingMovedFiles.push({ inode, dbFile, newDirId });
            logger.info(`File ${dbFile.filename} detected as moved from ${dirPath}`);
          }

          orphanedEntries.push({
            inode,
            filename: dbFile.filename,
            isDirectory: false,
            size: dbFile.size,
            dateModified: dbFile.dateModified,
            dateCreated: dbFile.dateCreated,
            mode: dbFile.mode ?? null,
            path: path.join(dirPath, dbFile.filename),
            changeState: 'moved',
            isStateTransition: transitioned,
            orphan_id: orphanId,
            new_dir_id: newDirId,
            dir_id: dirId
          });
        } else {
          const orphanResult = db.createOrphan(dirId, dbFile.filename, inode);
          const orphanId = orphanResult.id;

          orphanedEntries.push({
            inode,
            filename: dbFile.filename,
            isDirectory: false,
            size: dbFile.size,
            dateModified: dbFile.dateModified,
            dateCreated: dbFile.dateCreated,
            mode: dbFile.mode ?? null,
            path: path.join(dirPath, dbFile.filename),
            changeState: 'orphan',
            isStateTransition: !!orphanResult.isNew,
            orphan_id: orphanId,
            new_dir_id: null,
            dir_id: dirId
          });
          if (orphanResult.isNew) {
            pendingMissingFiles.push({ inode, dbFile });
            logger.info(`File ${dbFile.filename} marked as orphan in ${dirPath}`);
          }
        }
      } catch (err) {
        logger.error(`Error processing missing file ${dbFile.filename}:`, err.message);
      }
    }

    for (const childDir of childDirMap.values()) {
      try {
        const _cdRow = db.getDirById(childDir.id);
        if (!_cdRow || _cdRow.deleted_at) continue;

        // A link never gets a dirs row from a scan any more, but rows survive
        // from before that rule and from navigating straight into one. Such a
        // row has no matching `entries` item — links are tracked in `files`
        // now — so orphaning it would report a directory as missing while it
        // is sitting right there on disk.
        if (isExistingLink(childDir.dirname)) continue;

        const movedDirRecord = db.findDirectoryInOtherParents(childDir.inode, dirId);
        if (movedDirRecord) {
          const orphanResult = db.createDirOrphan(dirId, childDir.id, path.basename(childDir.dirname));
          const orphanId = orphanResult.id;
          const transitioned = orphanResult.isNew || orphanResult.new_dir_id !== movedDirRecord.id;
          if (transitioned) {
            db.updateDirOrphanNewLocation(orphanId, movedDirRecord.id);
          }

          entriesWithChanges.push({
            inode: childDir.inode,
            filename: path.basename(childDir.dirname),
            isDirectory: true,
            size: 0,
            dateModified: dirStats.dateModified,
            dateCreated: dirStats.dateCreated,
            mode: null,
            path: childDir.dirname,
            changeState: 'moved',
            isStateTransition: transitioned,
            dir_id: childDir.id,
            initials: childDir.initials || null,
            resolvedInitials: db.resolveDirectoryInitials(childDir.dirname).value,
            displayName: childDir.display_name || null,
            tags: db.getTagsForDirectoryId(childDir.id),
            attributes: db.getAttributesForDirectoryId(childDir.id),
            orphan_id: orphanId,
            new_dir_id: movedDirRecord.id
          });

          if (transitioned) {
            pendingMissingDirs.push({
              childDir,
              eventType: 'dirMoved',
              orphanId,
              newDirId: movedDirRecord.id
            });
          }
        } else {
          const orphanResult = db.createDirOrphan(dirId, childDir.id, path.basename(childDir.dirname));
          const orphanId = orphanResult.id;

          entriesWithChanges.push({
            inode: childDir.inode,
            filename: path.basename(childDir.dirname),
            isDirectory: true,
            size: 0,
            dateModified: dirStats.dateModified,
            dateCreated: dirStats.dateCreated,
            mode: null,
            path: childDir.dirname,
            changeState: 'orphan',
            isStateTransition: !!orphanResult.isNew,
            dir_id: childDir.id,
            initials: childDir.initials || null,
            resolvedInitials: db.resolveDirectoryInitials(childDir.dirname).value,
            displayName: childDir.display_name || null,
            tags: db.getTagsForDirectoryId(childDir.id),
            attributes: db.getAttributesForDirectoryId(childDir.id),
            orphan_id: orphanId,
            new_dir_id: null
          });

          if (orphanResult.isNew) {
            pendingMissingDirs.push({
              childDir,
              eventType: 'dirOrphaned',
              orphanId,
              newDirId: null
            });
          }
        }
      } catch (err) {
        logger.error(`Error processing missing directory ${childDir.dirname}:`, err.message);
      }
    }

    entriesWithChanges.push(...orphanedEntries);

    const isQuiescentOrphan = (entry) =>
      (entry.changeState === 'orphan' || entry.changeState === 'moved') &&
      entry.isStateTransition === false;
    const changedFileEntries = entriesWithChanges.filter(entry =>
      !entry.isDirectory && entry.changeState !== 'unchanged' && !isQuiescentOrphan(entry));
    const changedDirEntries = entriesWithChanges.filter(entry =>
      entry.isDirectory && entry.filename !== '.' && entry.changeState !== 'unchanged' && !isQuiescentOrphan(entry));
    const hasChanges = changedFileEntries.length > 0 || changedDirEntries.length > 0;
    const currentObservation = recordDirectoryObservation(
      currentDirInfo.dir,
      currentDirEventType,
      observationSource,
      hasChanges,
      changedFileEntries.length,
      changedDirEntries.length
    );
    const currentDirHistoryId = currentObservation.id;

    if (currentObservation.id) {
      try {
        const currentDirAttrsJson = db.getAttributesForDirectoryId(dirId);
        const dirRule = doesEventMatchRules(alertRules, currentDirEventType, categoryName, dirTagsJson, currentDirAttrsJson);
        if (dirRule) {
          db.insertAlert(dirRule.id, currentObservation.id, currentDirEventType, path.basename(normalizedPath), categoryName, dirId, dirInode, null, null);
          alertsCreated++;
        }
      } catch (alertErr) {
        logger.error(`Error creating ${currentDirEventType} alert for ${normalizedPath}:`, alertErr.message);
      }
    }

    for (const permErrEntry of pendingPermErrorEntries) {
      try {
        db.insertFileHistory(permErrEntry.inode, dirId, permErrEntry.fileId, 'fileModified', {
          filename: permErrEntry.filename,
          status: 'permError',
          mode: permErrEntry.mode
        }, currentDirHistoryId);
      } catch (err) {
        logger.error(`Error recording permission history for ${permErrEntry.filename}:`, err.message);
      }
    }

    for (const entry of entriesWithChanges) {
      if (entry.changeState === 'permError') continue;
      if (entry.changeState === 'moved' || entry.changeState === 'orphan') continue;
      if (entry.changeState === 'fileReplaced') continue;

      // Links were already persisted by the entry loop above and need nothing
      // from either branch below. The file branch would queue checksum and
      // content work against a link; the directory branch would write a
      // dot-entry row keyed on (inode, dir_id) — and because a link carries its
      // PARENT's dir_id (it has no dirs row of its own), that upsert lands on
      // the link's own row and renames it to '.', hiding it from every query
      // that filters the dot entry out.
      if (entry.isLink) continue;

      if (!entry.isDirectory) {
        const dbFile = existingDbFiles.find(f => f.inode === entry.inode);

        db.upsertFile({
          inode: entry.inode,
          dir_id: dirId,
          filename: entry.filename,
          dateModified: entry.dateModified,
          dateCreated: entry.dateCreated,
          size: entry.size,
          mode: entry.mode ?? null,
          attrs: entry.attrs ?? null
        });

        const fileRecord = db.getFileByInode(entry.inode, dirId);
        if (!fileRecord) {
          logger.error(`Failed to retrieve file record after upsert for ${entry.filename}`);
          continue;
        }

        if (!dbFile) {
          const eventType = initialObservation ? 'INITIAL' : 'fileAdded';
          try {
            db.insertFileHistory(entry.inode, dirId, fileRecord.id, eventType, {
              filename: entry.filename,
              dateModified: entry.dateModified,
              filesizeBytes: entry.size,
              mode: entry.mode ?? null
            }, currentDirHistoryId);
          } catch (err) {
            logger.error(`Error recording file history for new file ${entry.filename}:`, err.message);
          }
          try {
            const addedRule = doesEventMatchRules(alertRules, eventType, categoryName, dirTagsJson, entry.attributes || null);
            if (addedRule) {
              db.insertAlert(addedRule.id, null, eventType, entry.filename, categoryName, dirId, entry.inode, null, null);
              alertsCreated++;
            }
          } catch (alertErr) { logger.error(`Error creating ${eventType} alert for ${entry.filename}:`, alertErr.message); }
        } else {
          const modeChanged = (dbFile.mode ?? null) !== (entry.mode ?? null);
          const dateChanged = dbFile.dateModified !== entry.dateModified;

          if (dateChanged || modeChanged) {
            const historyPayload = {};
            if (dateChanged) historyPayload.dateModified = entry.dateModified;
            if (modeChanged) historyPayload.mode = entry.mode ?? null;

            try {
              db.insertFileHistory(entry.inode, dirId, fileRecord.id, 'fileModified', historyPayload, currentDirHistoryId);
            } catch (err) {
              logger.error(`Error recording file history for ${entry.filename}:`, err.message);
            }
          }
          if (dateChanged) {
            try {
              const modRule = doesEventMatchRules(alertRules, 'fileModified', categoryName, dirTagsJson, entry.attributes || null);
              if (modRule) {
                db.insertAlert(modRule.id, null, 'fileModified', entry.filename, categoryName, dirId, entry.inode, null, null);
                alertsCreated++;
              }
            } catch (alertErr) { logger.error(`Error creating fileModified alert for ${entry.filename}:`, alertErr.message); }
          }
          if (entry.wasRenamed) {
            try {
              const renameHistResult = db.insertFileHistory(entry.inode, dirId, fileRecord.id, 'fileRenamed', {
                filename: entry.filename,
                previousFilename: entry.previousFilename
              }, currentDirHistoryId);
              const renameRule = doesEventMatchRules(alertRules, 'fileRenamed', categoryName, dirTagsJson, entry.attributes || null);
              if (renameRule) {
                db.insertAlert(renameRule.id, renameHistResult.lastInsertRowid, 'fileRenamed', entry.filename, categoryName, dirId, entry.inode, entry.previousFilename, entry.filename);
                alertsCreated++;
              }
            } catch (alertErr) { logger.error(`Error creating fileRenamed alert for ${entry.filename}:`, alertErr.message); }
          }
        }

        if (!category || !category.enableChecksum) {
          const prevStatus = dbFile ? dbFile.checksumStatus : null;
          if (prevStatus === 'calculated' || prevStatus === 'error') {
            try {
              db.updateFileChecksum(entry.inode, dirId, null, 'untracked');
              db.insertFileHistory(entry.inode, dirId, fileRecord.id, 'fileModified', {
                checksumStatus: 'untracked'
              }, currentDirHistoryId);
            } catch (err) {
              logger.error(`Error marking checksum untracked for ${entry.filename}:`, err.message);
            }
          } else if (prevStatus === null) {
            try {
              db.updateFileChecksum(entry.inode, dirId, null, 'untracked');
            } catch (err) {
              logger.error(`Error initializing checksum as untracked for ${entry.filename}:`, err.message);
            }
          }
        }
      } else {
        const subDirId = entry.dir_id;
        const subDirCategory = categories.getCategoryForDirectory(entry.path) || category;

        db.upsertFile({
          inode: entry.inode,
          dir_id: subDirId,
          filename: '.',
          dateModified: entry.dateModified,
          dateCreated: entry.dateCreated,
          size: 0,
          mode: entry.mode ?? null
        });

        const dotFileRecord = db.getFileByInode(entry.inode, subDirId);
        if (dotFileRecord) {
          try {
            if (entry.changeState === 'new') {
              const dirEventType = initialObservation ? 'dirSeen' : 'dirAdded';
              db.insertDirHistory(subDirId, dirEventType, {
                dirname: path.basename(entry.path),
                category: subDirCategory ? subDirCategory.name : 'Default',
                parentDirname: path.basename(normalizedPath),
                source: observationSource,
                hasChanges: true,
                fileChanges: 0,
                dirChanges: 1,
                status: dirEventType === 'dirSeen' ? 'seen' : 'added'
              });

              const subDirTagsJson = db.getTagsForDirectoryId(subDirId);
              const subDirAttrsJson = db.getAttributesForDirectoryId(subDirId);
              const dirRule = doesEventMatchRules(
                alertRules,
                dirEventType,
                subDirCategory ? subDirCategory.name : 'Default',
                subDirTagsJson,
                subDirAttrsJson
              );
              if (dirRule) {
                db.insertAlert(dirRule.id, null, dirEventType, path.basename(entry.path), subDirCategory ? subDirCategory.name : 'Default', subDirId, entry.inode, null, null);
                alertsCreated++;
              }
            }
          } catch (err) {
            logger.error(`Error recording directory history for ${entry.path}:`, err.message);
          }
        }
      }
    }

    for (const missingFile of pendingMissingFiles) {
      try {
        db.insertFileHistory(missingFile.inode, dirId, missingFile.dbFile.id, 'fileRemoved', {
          filename: missingFile.dbFile.filename,
          status: 'orphan'
        }, currentDirHistoryId);

        const removedRule = doesEventMatchRules(alertRules, 'fileRemoved', categoryName, dirTagsJson, null);
        if (removedRule) {
          db.insertAlert(removedRule.id, null, 'fileRemoved', missingFile.dbFile.filename, categoryName, dirId, missingFile.inode, null, null);
          alertsCreated++;
        }
      } catch (err) {
        logger.error(`Error processing missing file ${missingFile.dbFile.filename}:`, err.message);
      }
    }

    for (const moved of pendingMovedFiles) {
      try {
        const newDir = db.getDirById(moved.newDirId);
        db.insertFileHistory(moved.inode, dirId, moved.dbFile.id, 'fileMoved', {
          filename: moved.dbFile.filename,
          status: 'moved',
          oldPath: path.join(dirPath, moved.dbFile.filename),
          newPath: newDir ? path.join(newDir.dirname, moved.dbFile.filename) : null
        }, currentDirHistoryId);

        const movedRule = doesEventMatchRules(alertRules, 'fileMoved', categoryName, dirTagsJson, null);
        if (movedRule) {
          db.insertAlert(movedRule.id, null, 'fileMoved', moved.dbFile.filename, categoryName, dirId, moved.inode, null, null);
          alertsCreated++;
        }
      } catch (err) {
        logger.error(`Error processing moved file ${moved.dbFile.filename}:`, err.message);
      }
    }

    for (const missingDir of pendingMissingDirs) {
      try {
        const childCategory = categories.getCategoryForDirectory(missingDir.childDir.dirname);
        const childCategoryName = childCategory ? childCategory.name : 'Default';
        const dirTags = db.getTagsForDirectoryId(missingDir.childDir.id);
        const dirAttrs = db.getAttributesForDirectoryId(missingDir.childDir.id);
        db.insertDirHistory(missingDir.childDir.id, missingDir.eventType, {
          dirname: path.basename(missingDir.childDir.dirname),
          source: observationSource,
          hasChanges: true,
          fileChanges: 0,
          dirChanges: 1,
          oldPath: missingDir.childDir.dirname,
          newPath: missingDir.newDirId ? (db.getDirById(missingDir.newDirId)?.dirname || null) : null,
          status: missingDir.eventType === 'dirMoved' ? 'moved' : 'orphaned'
        });

        const dirRule = doesEventMatchRules(alertRules, missingDir.eventType, childCategoryName, dirTags, dirAttrs);
        if (dirRule) {
          db.insertAlert(
            dirRule.id,
            null,
            missingDir.eventType,
            path.basename(missingDir.childDir.dirname),
            childCategoryName,
            missingDir.childDir.id,
            missingDir.childDir.inode,
            missingDir.eventType === 'dirMoved' ? missingDir.childDir.dirname : null,
            missingDir.newDirId ? (db.getDirById(missingDir.newDirId)?.dirname || null) : null
          );
          alertsCreated++;
        }
      } catch (err) {
        logger.error(`Error recording directory event for ${missingDir.childDir.dirname}:`, err.message);
      }
    }

    // Add the "." current directory entry
    const dotFileRecord = db.getFileByInode(dirInode, dirId);
    if (dotFileRecord && dotFileRecord.filename === '.') {
      const dirRecord = db.getDirectory(normalizedPath);
      const resolvedInitialsResult = db.resolveDirectoryInitials(normalizedPath);
      const resolvedDisplayNameResult = db.resolveDirectoryDisplayName(normalizedPath);
      entriesWithChanges.unshift({
        inode: dirInode,
        filename: '.',
        isDirectory: true,
        size: 0,
        dateModified: dirStats.dateModified,
        dateCreated: dirStats.dateCreated,
        mode: dirStats.mode ?? null,
        perms: dirStats.perms || { read: true, write: false },
        path: dirPath,
        changeState: 'unchanged',
        dir_id: dirId,
        initials: dirRecord ? (dirRecord.initials || null) : null,
        resolvedInitials: resolvedInitialsResult.value,
        displayName: dirRecord ? (dirRecord.display_name || null) : null,
        resolvedDisplayName: resolvedDisplayNameResult.value,
        displayNameIsInherited: resolvedDisplayNameResult.isInherited,
        displayNameSourceDir: resolvedDisplayNameResult.sourceDir,
        tags: dotFileRecord.tags || null,
        attributes: dotFileRecord.attributes || null,
        orphan_id: null,
        new_dir_id: null
      });
    }

    // Resolve notes and todo counts
    let filesWithNotes = new Set();
    let localNotesContent = '';
    let localNotesSections = {};
    let localNotesFilePath = null;
    try {
      const notesFilePath = path.join(normalizedPath, 'notes.txt');
      if (fsSync.existsSync(notesFilePath)) {
        const notesContent = fsSync.readFileSync(notesFilePath, 'utf-8');
        localNotesSections = notesParser.parseNotesFileSections(notesContent);
        localNotesContent = notesContent;
        localNotesFilePath = notesFilePath;
        const headersArray = notesParser.extractAllHeaders(localNotesContent);
        filesWithNotes = new Set(headersArray);
      }
    } catch (err) {
      logger.warn(`Error reading notes for directory ${normalizedPath}:`, err.message);
    }

    if (localNotesFilePath) {
      try {
        const aggResult = todoAggregator.ensureAndRefresh(localNotesFilePath, dirId, { contentOverride: localNotesContent });
        if (aggResult.changed) notify('todo-aggregates-changed');
      } catch (err) {
        logger.warn(`todoAggregator.ensureAndRefresh failed for ${localNotesFilePath}: ${err.message}`);
      }
      try {
        const remResult = reminderAggregator.ensureAndRefresh(localNotesFilePath, dirId, { contentOverride: localNotesContent });
        if (remResult.changed) notify('reminder-aggregates-changed');
      } catch (err) {
        logger.warn(`reminderAggregator.ensureAndRefresh failed for ${localNotesFilePath}: ${err.message}`);
      }
    } else {
      const notesFilePath = path.join(normalizedPath, 'notes.txt');
      const existing = db.getTodoNotesFile(notesFilePath);
      if (existing) {
        db.deleteTodoNotesFileByPath(notesFilePath);
        notify('todo-aggregates-changed');
      }
    }

    let todoAggChanged = false;
    for (const entry of entriesWithChanges) {
      if (entry.isDirectory) {
        let dirNotesContent = '';
        if (entry.filename !== '.') {
          const dirNotesFilePath = path.join(normalizedPath, entry.filename, 'notes.txt');
          if (fsSync.existsSync(dirNotesFilePath)) {
            try {
              dirNotesContent = fsSync.readFileSync(dirNotesFilePath, 'utf-8');
            } catch (err) {
              logger.warn(`Error reading notes for subdirectory ${entry.path}:`, err.message);
              dirNotesContent = '';
            }
            if (dirNotesContent && entry.dir_id) {
              try {
                const childAgg = todoAggregator.ensureAndRefresh(dirNotesFilePath, entry.dir_id, { contentOverride: dirNotesContent });
                if (childAgg.changed) todoAggChanged = true;
              } catch (err) {
                logger.warn(`todoAggregator child refresh failed for ${dirNotesFilePath}: ${err.message}`);
              }
              try {
                reminderAggregator.ensureAndRefresh(dirNotesFilePath, entry.dir_id, { contentOverride: dirNotesContent });
              } catch (err) {
                logger.warn(`reminderAggregator child refresh failed for ${dirNotesFilePath}: ${err.message}`);
              }
            }
          }
        } else {
          dirNotesContent = localNotesContent;
        }

        const directoryNotes = notesParser.extractDirectoryNotes(dirNotesContent);
        entry.hasNotes = !!directoryNotes && directoryNotes.trim().length > 0;

        const dirSection = entry.filename === '.'
          ? (localNotesSections['__dir__'] || directoryNotes)
          : notesParser.extractDirectoryNotes(dirNotesContent || '');
        const dirTodoCounts = notesParser.countTodoItems(dirSection);
        entry.todoCounts = dirTodoCounts.total > 0 ? dirTodoCounts : null;

        const noteDirTags = notesParser.extractNoteTags(dirSection);
        if (noteDirTags.length > 0) {
          const targetDirPath = entry.filename === '.' ? normalizedPath : entry.path;
          for (const tagName of noteDirTags) {
            try { db.addTagToDirectory(targetDirPath, tagName); } catch (err) {
              logger.warn(`notes-tag: failed to add tag '${tagName}' to dir '${targetDirPath}': ${err.message}`);
            }
          }
          entry.tags = db.getTagsForDirectoryId(entry.dir_id);
        }
      } else {
        entry.hasNotes = filesWithNotes.has(entry.filename);

        const fileSection = localNotesSections[entry.filename] || '';
        const fileTodoCounts = notesParser.countTodoItems(fileSection);
        entry.todoCounts = fileTodoCounts.total > 0 ? fileTodoCounts : null;

        const noteFileTags = notesParser.extractNoteTags(fileSection);
        if (noteFileTags.length > 0) {
          for (const tagName of noteFileTags) {
            try { db.addTagToFile(entry.inode, entry.dir_id, tagName); } catch (err) {
              logger.warn(`notes-tag: failed to add tag '${tagName}' to file '${entry.filename}': ${err.message}`);
            }
          }
          entry.tags = db.getFileByInode(entry.inode, entry.dir_id)?.tags || null;
        }
      }
    }

    if (todoAggChanged) notify('todo-aggregates-changed');

    const changedEntries = entriesWithChanges.filter(e =>
      e.changeState !== 'unchanged' && !isQuiescentOrphan(e));

    if (isManualNavigation || hasChanges) {
      logger.info(`Scanning directory: ${normalizedPath} - ${changedEntries.length} changes detected`);
    }

    const orphanCount = db.getOrphanCount(dirId, 1);
    const trashCount  = db.getTrashCount(dirId);

    return {
      success: true,
      count: entriesWithChanges.filter(e => !e.isDirectory).length,
      entries: entriesWithChanges,
      category: categoryName,
      categoryData: category,
      hasChanges,
      // Separate from hasChanges (which drives dir-history "changed" records):
      // signals the renderer to repopulate so the content queue sees the
      // pending rows even when nothing changed on disk.
      hasContentPending: entriesWithChanges.some(e => e.contentPending),
      alertsCreated,
      orphanCount,
      trashCount,
      // Cached mirror states paint instantly; fresh states arrive later via
      // the mirror-state-updated push (remote stats must not block a scan).
      mirrorInfo: {
        mirrors: db.getMirrorsForDir(path.resolve(normalizedPath)),
        pendingAdoption: mirrorAbsorb?.pendingAdoption || null
      },
    };
  } catch (err) {
    logger.error('Error scanning directory with comparison:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  doScanDirectoryWithComparison,
  ensureDirectoryRecord,
  recordDirectoryObservation,
  createStandaloneDirHistory,
  doesRuleMatchFilters,
  doesEventMatchRules,
  getObservationSource,
  getMonitoringObservationDeadTimeMs,
};
