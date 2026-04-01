const fs = require('fs');
const path = require('path');
const logger = require('./logger');

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
        logger.info(`[DEBUG] getParentDirectoryMetadata - At root: ${dirPath}`);
        return null;
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
      logger.info(`[DEBUG] getParentDirectoryMetadata - Returning:`, result);
      return result;
    } catch (err) {
      logger.warn(`Error getting parent directory metadata for ${dirPath}:`, err.message);
      return null;
    }
  }

  /**
   * Check if path exists and is a directory
   */
  isDirectory(filePath) {
    try {
      const stats = fs.statSync(filePath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Get absolute path, resolving relative paths
   */
  resolvePath(filePath) {
    return path.resolve(filePath);
  }

  /**
   * Get root drives (Windows drive letters and removable media)
   */
  getRootDrives() {
    const drives = [];
    
    // On Windows, check for drive letters C:, D:, E:, etc.
    for (let i = 67; i <= 90; i++) { // ASCII codes for C-Z
      const drive = String.fromCharCode(i) + ':';
      try {
        const fullPath = drive + '\\';
        // Try to access the drive
        if (fs.existsSync(fullPath)) {
          const stats = fs.statSync(fullPath);
          drives.push({
            label: drive,
            path: fullPath,
            isRemovable: false,
            isReady: true
          });
        }
      } catch (err) {
        // Drive not accessible, skip it
        logger.warn(`Drive ${drive} not accessible: ${err.message}`);
      }
    }
    
    logger.info(`Found ${drives.length} root drives`);
    return drives;
  }
}

module.exports = new FilesystemService();
