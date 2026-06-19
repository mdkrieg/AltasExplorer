'use strict';

/**
 * src/atlasJson.js
 *
 * atlas.json sync — writes and absorbs a human-readable metadata file in each
 * directory whose category has atlasJsonSync != 'disabled'.
 *
 * Modes (stored on the category, per-directory opt-in via category assignment):
 *   disabled   — no file is written or read (default)
 *   readonly   — file is written/overwritten whenever metadata changes; never read back
 *   full-sync  — file is written on change AND absorbed on directory open / explicit refresh
 *
 * File format (atlas.json, schema version 1):
 * {
 *   "version": 1,
 *   "category": "Project",       // only present when category is force-assigned
 *   "categoryForced": true,      // false means category came from pattern/inheritance
 *   "tags": ["important"],
 *   "attributes": { "rating": "5" }
 * }
 *
 * Absorption strategy: lazy, triggered on directory open and explicit Refresh.
 * The mtime of the last absorbed (or written) file is stored in dirs.atlas_json_mtime.
 * If the file's current mtime > stored mtime, absorption runs. This avoids
 * re-absorbing our own writes and eliminates the need for fs.watch.
 *
 * Safety rules:
 *  - Errors are logged and swallowed; atlas.json issues must never crash a scan.
 *  - Malformed JSON is skipped; the stale mtime is NOT updated so the next open retries.
 *  - Category absorption only occurs when categoryForced === true in the file;
 *    an un-forced category in the file is ignored so inherited/pattern categories
 *    are not silently overridden.
 */

const path   = require('path');
const fsSync = require('fs');

const logger     = require('./logger');
const db         = require('./db');
const categories = require('./categories');

const FILE_NAME      = 'atlas.json';
const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function atlasJsonPath(dirPath) {
  return path.join(dirPath, FILE_NAME);
}

/**
 * Return the atlasJsonSync mode for the category currently assigned to dirPath.
 * Falls back to 'disabled' on any error.
 */
function getSyncMode(dirPath) {
  try {
    const resolution = categories.getCategoryResolutionForDirectory(dirPath);
    return resolution.category?.atlasJsonSync || 'disabled';
  } catch (err) {
    logger.warn(`atlasJson.getSyncMode: ${dirPath}: ${err.message}`);
    return 'disabled';
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Write (or overwrite) atlas.json for dirPath.
 * No-op if the category's atlasJsonSync is 'disabled'.
 * Non-throwing.
 */
function writeAtlasJson(dirPath) {
  try {
    const mode = getSyncMode(dirPath);
    if (mode === 'disabled') return;

    const dirEntry = db.getDirectory(dirPath);
    if (!dirEntry) return;

    const resolution = categories.getCategoryResolutionForDirectory(dirPath);
    const categoryName  = resolution.categoryName || 'Default';
    const categoryForced = !!resolution.isForced;

    const rawTags = db.getTagsForDirectory(dirPath);
    const tags = rawTags
      ? (() => { try { return JSON.parse(rawTags); } catch { return []; } })()
      : [];

    const rawAttrs = db.getAttributesForDirectoryId(dirEntry.id);
    const attributes = rawAttrs
      ? (typeof rawAttrs === 'string'
          ? (() => { try { return JSON.parse(rawAttrs); } catch { return {}; } })()
          : rawAttrs)
      : {};

    const data = {
      version: SCHEMA_VERSION,
      category: categoryForced ? categoryName : undefined,
      categoryForced,
      tags,
      attributes
    };

    const filePath = atlasJsonPath(dirPath);
    fsSync.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');

    // Store the written file's mtime so absorption skips our own write
    const stat = fsSync.statSync(filePath);
    db.setAtlasJsonMtime(dirPath, stat.mtimeMs);
  } catch (err) {
    logger.warn(`atlasJson.writeAtlasJson failed for ${dirPath}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Absorb
// ---------------------------------------------------------------------------

/**
 * If the directory's category is 'full-sync' AND atlas.json is newer than the
 * stored mtime, absorb its contents into the DB.
 *
 * Called at the start of doScanDirectoryWithComparison (both on navigate and
 * on explicit Refresh, as requested).
 *
 * Returns true if absorption was performed, false otherwise.
 * Non-throwing.
 */
function maybeAbsorb(dirPath) {
  try {
    const mode = getSyncMode(dirPath);
    if (mode !== 'full-sync') return false;

    const filePath = atlasJsonPath(dirPath);
    if (!fsSync.existsSync(filePath)) return false;

    let stat;
    try { stat = fsSync.statSync(filePath); } catch { return false; }
    const fileMtime = stat.mtimeMs;

    const storedMtime = db.getAtlasJsonMtime(dirPath);
    if (storedMtime !== null && fileMtime <= storedMtime) return false;

    // Parse — skip on error but do NOT update stored mtime so next open retries
    let data;
    try {
      data = JSON.parse(fsSync.readFileSync(filePath, 'utf8'));
    } catch (parseErr) {
      logger.warn(`atlasJson.maybeAbsorb: parse error in ${filePath}: ${parseErr.message}`);
      return false;
    }

    // Absorb category — only when the file explicitly force-assigns it
    if (data.categoryForced === true && typeof data.category === 'string' && data.category) {
      try {
        db.setCategoryForDirectory(dirPath, data.category, true);
      } catch (catErr) {
        logger.warn(`atlasJson.maybeAbsorb: category absorption failed for ${dirPath}: ${catErr.message}`);
      }
    }

    // Absorb tags — replaces the directory's tag set
    if (Array.isArray(data.tags)) {
      try {
        const tagsJson = data.tags.length > 0 ? JSON.stringify(data.tags) : null;
        db.updateDirectoryTags(dirPath, tagsJson);
      } catch (tagErr) {
        logger.warn(`atlasJson.maybeAbsorb: tag absorption failed for ${dirPath}: ${tagErr.message}`);
      }
    }

    // Absorb attributes — merges into the directory's dot-file
    if (data.attributes && typeof data.attributes === 'object' && !Array.isArray(data.attributes)) {
      try {
        const dirEntry = db.getDirectory(dirPath);
        if (dirEntry) {
          const dotFile = db.getFileByFilename(dirEntry.id, '.');
          if (dotFile) {
            db.setFileAttributes(dotFile.inode, dirEntry.id, data.attributes);
          }
        }
      } catch (attrErr) {
        logger.warn(`atlasJson.maybeAbsorb: attribute absorption failed for ${dirPath}: ${attrErr.message}`);
      }
    }

    // Stamp the mtime so we don't re-absorb on the next open
    db.setAtlasJsonMtime(dirPath, fileMtime);

    logger.info(`atlasJson: absorbed ${filePath}`);
    return true;
  } catch (err) {
    logger.warn(`atlasJson.maybeAbsorb failed for ${dirPath}: ${err.message}`);
    return false;
  }
}

module.exports = { writeAtlasJson, maybeAbsorb, atlasJsonPath, getSyncMode };
