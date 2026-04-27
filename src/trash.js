'use strict';

/**
 * src/trash.js
 *
 * XDG Trash specification implementation for the server layer (Linux/Raspberry Pi).
 * https://specifications.freedesktop.org/trash-spec/trashspec-1.0.html
 *
 * Designed as a shared module that benefits both:
 *   - The HTTP server (primary user)
 *   - Future Linux/macOS Electron builds (replaces shell.trashItem() there too)
 *
 * Windows Electron continues using shell.trashItem() — this module is never
 * called in that path. The `trash_path` column stays NULL for legacy Windows
 * deletes, preserving full backward compatibility.
 *
 * Exports:
 *   getTrashDir(config?)           → absolute path to Trash/files/
 *   moveToTrash(srcPath, config?)  → { trashPath, trashInfoPath }
 *   restoreFromTrash(trashPath)    → { restoredPath }
 *   permanentDelete(trashPath)     → void (removes file + .trashinfo)
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── XDG Trash directory ───────────────────────────────────────────────────────

/**
 * Returns the absolute path of the Trash/files/ directory.
 * config.trashDir overrides the XDG default when set.
 */
function getTrashDir(config = {}) {
  if (config && config.trashDir) {
    return path.resolve(config.trashDir);
  }
  // XDG default: $XDG_DATA_HOME/Trash or ~/.local/share/Trash
  const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdgData, 'Trash', 'files');
}

function getTrashInfoDir(config = {}) {
  if (config && config.trashDir) {
    // Sibling info/ next to the configured files/ dir
    return path.join(path.dirname(path.resolve(config.trashDir)), 'info');
  }
  const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdgData, 'Trash', 'info');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a unique name inside the Trash/files/ directory.
 * If <name> is already taken, append _1, _2, etc.
 */
function uniqueTrashName(trashFilesDir, originalName) {
  let candidate = originalName;
  let counter   = 0;
  while (fs.existsSync(path.join(trashFilesDir, candidate))) {
    counter++;
    const ext  = path.extname(originalName);
    const base = path.basename(originalName, ext);
    candidate  = `${base}_${counter}${ext}`;
  }
  return candidate;
}

/**
 * Format a Date as the ISO 8601 local-time string required by the spec:
 *   YYYY-MM-DDTHH:MM:SS  (no timezone suffix)
 */
function formatTrashDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    date.getFullYear() + '-' +
    pad(date.getMonth() + 1) + '-' +
    pad(date.getDate()) + 'T' +
    pad(date.getHours()) + ':' +
    pad(date.getMinutes()) + ':' +
    pad(date.getSeconds())
  );
}

/**
 * Write a .trashinfo file.
 * @param {string} infoDir  — Trash/info/ directory
 * @param {string} trashName — basename used in Trash/files/
 * @param {string} origPath  — original absolute path
 */
function writeTrashInfo(infoDir, trashName, origPath) {
  fs.mkdirSync(infoDir, { recursive: true });
  const infoPath = path.join(infoDir, trashName + '.trashinfo');
  const content  =
    '[Trash Info]\n' +
    `Path=${origPath}\n` +
    `DeletionDate=${formatTrashDate(new Date())}\n`;
  fs.writeFileSync(infoPath, content, 'utf8');
  return infoPath;
}

/**
 * Parse a .trashinfo file and return { origPath }.
 */
function readTrashInfo(infoPath) {
  try {
    const text = fs.readFileSync(infoPath, 'utf8');
    const match = text.match(/^Path=(.+)$/m);
    return { origPath: match ? match[1].trim() : null };
  } catch {
    return { origPath: null };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Move a file or directory to the XDG Trash.
 *
 * @param {string}  srcPath  Absolute path to the item to trash.
 * @param {object}  config   Optional server config (for custom trashDir).
 * @returns {{ trashPath: string, trashInfoPath: string }}
 *   trashPath is the absolute path inside Trash/files/ — store this in the
 *   DB column `trash_path` so the item can later be restored.
 */
function moveToTrash(srcPath, config = {}) {
  const trashFilesDir = getTrashDir(config);
  const trashInfoDir  = getTrashInfoDir(config);

  fs.mkdirSync(trashFilesDir, { recursive: true });
  fs.mkdirSync(trashInfoDir,  { recursive: true });

  const originalName = path.basename(srcPath);
  const trashName    = uniqueTrashName(trashFilesDir, originalName);
  const trashPath    = path.join(trashFilesDir, trashName);
  const infoPath     = writeTrashInfo(trashInfoDir, trashName, srcPath);

  fs.renameSync(srcPath, trashPath);

  return { trashPath, trashInfoPath: infoPath };
}

/**
 * Restore a trashed item to its original location.
 *
 * @param {string} trashPath  Absolute path inside Trash/files/ (the value
 *                             stored in the DB `trash_path` column).
 * @returns {{ restoredPath: string }}
 * @throws {Error} if the .trashinfo is missing, the original path is unknown,
 *                 or the destination already exists.
 */
function restoreFromTrash(trashPath) {
  const trashName   = path.basename(trashPath);
  const trashDir    = path.dirname(trashPath);               // Trash/files/
  const infoDir     = path.join(path.dirname(trashDir), 'info');
  const infoPath    = path.join(infoDir, trashName + '.trashinfo');

  const { origPath } = readTrashInfo(infoPath);
  if (!origPath) {
    throw new Error(`Cannot restore: .trashinfo missing or has no Path= for ${trashName}`);
  }

  if (fs.existsSync(origPath)) {
    throw new Error(`Cannot restore: destination already exists: ${origPath}`);
  }

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(origPath), { recursive: true });

  fs.renameSync(trashPath, origPath);

  // Remove the .trashinfo
  try { fs.unlinkSync(infoPath); } catch { /* ignore */ }

  return { restoredPath: origPath };
}

/**
 * Permanently delete a trashed item from disk (file AND .trashinfo).
 * The DB row must have already had its `purged_at` column set by the caller
 * before this function is invoked — this function only touches the filesystem.
 *
 * @param {string} trashPath  Absolute path inside Trash/files/.
 */
function permanentDelete(trashPath) {
  const trashName = path.basename(trashPath);
  const trashDir  = path.dirname(trashPath);              // Trash/files/
  const infoDir   = path.join(path.dirname(trashDir), 'info');
  const infoPath  = path.join(infoDir, trashName + '.trashinfo');

  // Remove the file/directory
  if (fs.existsSync(trashPath)) {
    const stat = fs.statSync(trashPath);
    if (stat.isDirectory()) {
      fs.rmSync(trashPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(trashPath);
    }
  }

  // Remove the .trashinfo
  try { fs.unlinkSync(infoPath); } catch { /* ignore */ }
}

module.exports = { getTrashDir, moveToTrash, restoreFromTrash, permanentDelete };
