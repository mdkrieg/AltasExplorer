const fs = require('fs');
const path = require('path');

class FilesystemService {
  /**
   * Read directory contents and return file/folder info with inode and stats
   */
  readDirectory(dirPath) {
    const entries = fs.readdirSync(dirPath);
    const files = [];
    const folders = [];

    for (const entry of entries) {
      try {
        const fullPath = path.join(dirPath, entry);
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
        console.error(`Error reading ${entry}:`, err.message);
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
      console.error(`Error getting stats for ${filePath}:`, err.message);
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
}

module.exports = new FilesystemService();
