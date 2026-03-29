const fs = require('fs');
const path = require('path');
const logger = require('./logger');

class FilesystemService {
  /**
   * Read directory contents and return file/folder info with inode and stats
   */
  readDirectory(dirPath) {
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
    
    // Log the actual path being read for debugging future edge cases
    logger.info(`Reading directory contents from: ${normalizedPath}`);
    
    const entries = fs.readdirSync(normalizedPath);
    const files = [];
    const folders = [];

    for (const entry of entries) {
      try {
        const fullPath = path.join(normalizedPath, entry);
        const stats = fs.statSync(fullPath);
        const inode = stats.ino.toString(); // Get inode

        const fileInfo = {
          inode,
          filename: entry,
          isDirectory: stats.isDirectory(),
          size: stats.size,
          dateModified: stats.mtime.getTime(),
          dateCreated: stats.birthtime.getTime(),
          path: fullPath
        };

        if (stats.isDirectory()) {
          folders.push(fileInfo);
        } else {
          files.push(fileInfo);
        }
      } catch (err) {
        logger.warn(`Error reading ${entry}:`, err.message);
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
        path: filePath
      };
    } catch (err) {
      logger.warn(`Error getting stats for ${filePath}:`, err.message);
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
        logger.debug(`Drive ${drive} not accessible: ${err.message}`);
      }
    }
    
    logger.info(`Found ${drives.length} root drives`);
    return drives;
  }
}

module.exports = new FilesystemService();
