const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('./logger');

/**
 * Returns true if the path is a UNC server root (e.g. \\hostname with no share component).
 */
function isUncServerRoot(p) {
  if (!p || !p.startsWith('\\\\')) return false;
  const rest = p.slice(2).replace(/\\+$/, '');
  return rest.length > 0 && !rest.includes('\\');
}

/**
 * Probe read and write access for a path without throwing.
 * Returns { read: bool, write: bool }.
 */
function checkAccess(fullPath) {
  let read = false;
  let write = false;
  try { fs.accessSync(fullPath, fs.constants.R_OK); read = true; } catch {}
  try { fs.accessSync(fullPath, fs.constants.W_OK); write = true; } catch {}
  return { read, write };
}

class FilesystemService {
  constructor() {
    this.driveCache = [];
    this.driveCacheExpiry = 0;
    this.CACHE_TTL = 60000; // 60 seconds in milliseconds
    this.DRIVE_CHECK_TIMEOUT = 500; // 500ms timeout per drive
  }

  /**
   * Read directory contents and return file/folder info with inode and stats
   */
  readDirectory(dirPath, ignoreFilenames = []) {
    // Validate path before proceeding
    if (!dirPath || typeof dirPath !== 'string') {
      logger.error(`readDirectory: Invalid path type - received ${typeof dirPath}`);
      return [];
    }
    
    const normalizedPath = dirPath.trim();
    if (!normalizedPath) {
      logger.error('readDirectory: Empty path provided');
      return [];
    }
    
    const entries = fs.readdirSync(normalizedPath);
    const files = [];
    const folders = [];

    for (const entry of entries) {
      if (ignoreFilenames.includes(entry)) continue;
      try {
        const fullPath = path.join(normalizedPath, entry);
        const stats = fs.statSync(fullPath);
        const inode = stats.ino.toString(); // Get inode
        const perms = checkAccess(fullPath);

        const fileInfo = {
          inode,
          filename: entry,
          isDirectory: stats.isDirectory(),
          size: stats.size,
          dateModified: stats.mtime.getTime(),
          dateCreated: stats.birthtime.getTime(),
          path: fullPath,
          mode: stats.mode,
          perms,
          permError: false
        };

        if (stats.isDirectory()) {
          folders.push(fileInfo);
        } else {
          files.push(fileInfo);
        }
      } catch (err) {
        logger.warn(`Error reading ${entry}:`, err.message);
        // Include the entry as a permission-error item so it renders in the grid
        files.push({
          inode: '-1:' + entry,
          filename: entry,
          isDirectory: false,
          size: 0,
          dateModified: null,
          dateCreated: null,
          path: path.join(normalizedPath, entry),
          mode: null,
          perms: { read: false, write: false },
          permError: true,
          permErrorCode: err.code || 'UNKNOWN'
        });
      }
    }

    // Return folders first, then files
    return [...folders, ...files];
  }

  /**
   * Get stats for a single path
   */
  getStats(filePath) {
    try {
      const stats = fs.statSync(filePath);
      return {
        inode: stats.ino.toString(),
        isDirectory: stats.isDirectory(),
        size: stats.size,
        dateModified: stats.mtime.getTime(),
        dateCreated: stats.birthtime.getTime(),
        path: filePath,
        mode: stats.mode,
        perms: checkAccess(filePath),
        permError: false
      };
    } catch (err) {
      logger.warn(`Error getting stats for ${filePath}:`, err.message);
      return null;
    }
  }

  /**
   * Get metadata for the parent directory of a given path
   * Returns null if at root (no parent exists)
   */
  getParentDirectoryMetadata(dirPath) {
    try {
      const parentPath = path.dirname(dirPath);
      
      // Check if we're at root (no parent)
      if (parentPath === dirPath) {
        // logger.info(`[DEBUG] getParentDirectoryMetadata - At root: ${dirPath}`);
        return null;
      }

      // UNC server root (\\hostname) can't be stat'd normally — return synthetic entry
      if (isUncServerRoot(parentPath)) {
        return {
          inode: `unc-root:${parentPath}`,
          filename: '..',
          isDirectory: true,
          size: 0,
          dateModified: Date.now(),
          dateCreated: Date.now(),
          path: parentPath,
          mode: null,
          perms: { read: true, write: false },
          permError: false
        };
      }

      const stats = fs.statSync(parentPath);
      const perms = checkAccess(parentPath);

      const result = {
        inode: stats.ino.toString(),
        filename: '..',
        isDirectory: true,
        size: 0,
        dateModified: stats.mtime.getTime(),
        dateCreated: stats.birthtime.getTime(),
        path: parentPath,
        mode: stats.mode,
        perms,
        permError: false
      };
      // logger.info(`[DEBUG] getParentDirectoryMetadata - Returning:`, result);
      return result;
    } catch (err) {
      logger.warn(`Error getting parent directory metadata for ${dirPath}:`, err.message);
      return null;
    }
  }

  /**
   * Check if path exists and is a directory
   */
  isUncServerRoot(p) {
    return isUncServerRoot(p);
  }

  isDirectory(filePath) {
    if (isUncServerRoot(filePath)) return true;
    try {
      const stats = fs.statSync(filePath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Enumerate SMB shares on a UNC server root (e.g. \\hostname) using `net view`.
   * Returns an array of entries in the same shape as readDirectory().
   */
  readUncShares(uncServerPath) {
    try {
      const output = execSync(`net view "${uncServerPath}"`, { encoding: 'utf8', timeout: 10000, windowsHide: true });
      const lines = output.split(/\r?\n/);
      let pastSeparator = false;
      const shares = [];
      for (const line of lines) {
        if (!pastSeparator) {
          if (/^-+/.test(line.trim())) pastSeparator = true;
          continue;
        }
        const trimmed = line.trim();
        if (!trimmed || /^the command/i.test(trimmed)) continue;
        const shareName = trimmed.split(/\s+/)[0];
        if (shareName) shares.push(shareName);
      }
      const now = Date.now();
      return shares.map(name => ({
        inode: `unc-share:${name}`,
        filename: name,
        isDirectory: true,
        size: 0,
        dateModified: now,
        dateCreated: now,
        path: `${uncServerPath}\\${name}`,
        mode: null,
        perms: { read: true, write: false },
        permError: false,
      }));
    } catch (err) {
      logger.warn(`Could not enumerate UNC shares for ${uncServerPath}: ${err.message}`);
      return [];
    }
  }

  /**
   * Get absolute path, resolving relative paths
   */
  resolvePath(filePath) {
    return path.resolve(filePath);
  }

  /**
   * Helper: Check if a drive is accessible within a timeout
   * @private
   */
  async checkDriveWithTimeout(drive) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        logger.warn(`Drive ${drive} timed out after ${this.DRIVE_CHECK_TIMEOUT}ms`);
        resolve(null);
      }, this.DRIVE_CHECK_TIMEOUT);

      try {
        const fullPath = drive + '\\';
        if (fs.existsSync(fullPath)) {
          // const stats = fs.statSync(fullPath);
          clearTimeout(timeout);
          logger.info(`Found drive: ${drive}`);
          resolve({
            label: drive,
            path: fullPath,
            isRemovable: false,
            isReady: true
          });
        } else {
          logger.info(`Drive ${drive} does not exist`);
          clearTimeout(timeout);
          resolve(null);
        }
      } catch (err) {
        clearTimeout(timeout);
        logger.warn(`Drive ${drive} check failed: ${err.message}`);
        resolve(null);
      }
    });
  }

  /**
   * Get all drives with timeout protection
   * @private
   */
  async getDrivesWithTimeout() {
    logger.info('Scanning drives with timeout protection...');
    const drives = [];
    
    // Check all drive letters C-Z in parallel with timeout
    const drivePromises = [];
    for (let i = 67; i <= 90; i++) { // ASCII codes for C-Z
      const drive = String.fromCharCode(i) + ':';
      drivePromises.push(this.checkDriveWithTimeout(drive));
    }

    const results = await Promise.all(drivePromises);
    for (const result of results) {
      if (result) {
        drives.push(result);
      }
    }

    logger.info(`Found ${drives.length} accessible drives`);
    return drives;
  }

  /**
   * Refresh the drive cache asynchronously
   * Called periodically in the background
   */
  async refreshDrivesCache() {
    logger.info('Refreshing drive cache...');
    try {
      const drives = await this.getDrivesWithTimeout();
      this.driveCache = drives;
      this.driveCacheExpiry = Date.now() + this.CACHE_TTL;
      logger.info(`Drive cache updated with ${drives.length} drives`);
    } catch (err) {
      logger.error('Error refreshing drive cache:', err.message);
    }
  }

  /**
   * Check if the drive cache is still valid
   * @private
   */
  isCacheValid() {
    return Date.now() < this.driveCacheExpiry && this.driveCache.length > 0;
  }

  /**
   * Get root drives (Windows drive letters and removable media)
   * Returns cached results immediately. If cache is stale, triggers background refresh.
   */
  async getRootDrives() {
    // If cache is valid, return it immediately
    if (this.isCacheValid()) {
      logger.info(`Returning cached drives (${this.driveCache.length} drives)`);
      return this.driveCache;
    }

    // If cache is empty or expired, refresh it
    logger.info('Drive cache invalid or expired, refreshing...');
    await this.refreshDrivesCache();
    return this.driveCache;
  }

  // ---------- Move / Copy helpers (drag-and-drop) ----------

  /**
   * Async existence check. Returns true iff the path is reachable via stat.
   */
  async pathExists(p) {
    if (!p || typeof p !== 'string') return false;
    try {
      await fsp.stat(p);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Case-insensitive "is `candidate` the same path as `ancestor` or a descendant?"
   * Works with forward or backward slashes; used to block dropping a folder into
   * itself or its own descendants. Both inputs should be absolute.
   */
  isAncestorOrSelf(ancestor, candidate) {
    if (!ancestor || !candidate) return false;
    const norm = (s) => path.resolve(s).replace(/[\\/]+$/, '').toLowerCase();
    const a = norm(ancestor);
    const c = norm(candidate);
    if (a === c) return true;
    const sep = path.sep.toLowerCase();
    return c.startsWith(a + sep) || c.startsWith(a + '/') || c.startsWith(a + '\\');
  }

  /**
   * Produce a non-colliding destination path by appending " (2)", " (3)", ...
   * before the extension (files) or at the end of the name (folders).
   */
  async pickNonCollidingPath(targetDir, baseName) {
    const ext = path.extname(baseName);
    const stem = ext ? baseName.slice(0, -ext.length) : baseName;
    let n = 2;
    while (n < 10000) {
      const candidate = path.join(targetDir, `${stem} (${n})${ext}`);
      // eslint-disable-next-line no-await-in-loop
      if (!(await this.pathExists(candidate))) return candidate;
      n += 1;
    }
    throw new Error('Too many name collisions while resolving rename');
  }

  /**
   * Recursively remove a directory or file. Used after a cross-device copy
   * fallback when rename(2) returns EXDEV.
   */
  async _removeRecursive(p) {
    await fsp.rm(p, { recursive: true, force: true });
  }

  /**
   * Move a file or folder. Uses fs.rename when possible; on EXDEV (cross-drive)
   * falls back to recursive copy + delete so folder moves across drives work.
   * Caller is responsible for collision handling (pass a target that does not
   * yet exist).
   */
  async moveItem(sourcePath, targetPath) {
    if (!sourcePath || !targetPath) throw new Error('moveItem: source and target are required');
    try {
      await fsp.rename(sourcePath, targetPath);
      return;
    } catch (err) {
      if (err && err.code === 'EXDEV') {
        await fsp.cp(sourcePath, targetPath, { recursive: true, errorOnExist: true, force: false });
        await this._removeRecursive(sourcePath);
        return;
      }
      throw err;
    }
  }

  /**
   * Recursively copy a file or folder. Caller is responsible for collision
   * handling (pass a target that does not yet exist).
   */
  async copyItem(sourcePath, targetPath) {
    if (!sourcePath || !targetPath) throw new Error('copyItem: source and target are required');
    await fsp.cp(sourcePath, targetPath, { recursive: true, errorOnExist: true, force: false });
  }
}

module.exports = new FilesystemService();
