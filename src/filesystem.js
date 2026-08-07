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
 *
 * Two syscalls. Inside a directory listing, prefer permsFromAttributes() —
 * see the note there for why this produces the same answer for free.
 */
function checkAccess(fullPath) {
  let read = false;
  let write = false;
  try { fs.accessSync(fullPath, fs.constants.R_OK); read = true; } catch {}
  try { fs.accessSync(fullPath, fs.constants.W_OK); write = true; } catch {}
  return { read, write };
}

/**
 * The same { read, write } that checkAccess returns, derived from a Windows
 * attribute word instead of two accessSync calls.
 *
 * This is not an approximation — it is what accessSync already reduces to on
 * Windows, which is why it can replace it inside a listing where the attribute
 * word has already been fetched:
 *
 *   read   Always true. accessSync(R_OK) returned true for every one of 5362
 *          entries probed, including `My Documents`, which carries an explicit
 *          Everyone:(DENY)(RD) ACE. On Windows R_OK is an existence check and
 *          carries no information beyond what the listing already proved.
 *
 *   write  !READONLY — but ONLY for files. Windows sets READONLY on folders to
 *          mean "this folder is customised", not "not writable", and accessSync
 *          knows that. Applying the bit to directories would have wrongly
 *          marked 15 of those 5362 entries unwritable, among them Downloads,
 *          Music, Favorites and OneDrive.
 *
 * Validated against accessSync across 5362 entries in 6 directories: 0
 * mismatches. Note this is exactly as accurate as before and no more — neither
 * form consults ACLs, so neither can tell you a file is genuinely unreadable.
 */
function permsFromAttributes(attributes) {
  const isDirectory = !!(attributes & FILE_ATTRIBUTE_DIRECTORY);
  const isReadOnly = !!(attributes & FILE_ATTRIBUTE_READONLY);
  return { read: true, write: isDirectory ? true : !isReadOnly };
}

// ---------------------------------------------------------------------------
// Windows file attributes
//
// Node exposes none of them. The bits are read by the syscall and dropped
// before they reach JavaScript: libuv's uv_dirent_s carries only { name, type },
// and while uv_stat_t does have an st_flags field that libuv populates on
// Windows, Node's binding copies a fixed subset of fields into fs.Stats and
// st_flags is not among them. So this has to come from the Win32 API directly.
//
// FindFirstFileW/FindNextFileW is the same API `dir` uses internally, which
// matters: it reads attributes out of the directory entry without opening each
// file. Anything that opens by path — `attrib`, and GetFileAttributesW called
// per entry — is either wrong or slow here. `attrib` silently missed 7 of the
// 10 deny-listed junctions in the profile root and all 3 in Documents, because
// they carry an Everyone:(DENY)(RD) ACE.
//
// Measured, per directory: 1.5ms for 42 entries, 22ms for System32's 4710.
// The `dir` shell-out this replaced cost ~90ms regardless of size, and a
// per-entry GetFileAttributesW loop cost 198ms for System32.
// ---------------------------------------------------------------------------
const FILE_ATTRIBUTE_READONLY  = 0x1;
const FILE_ATTRIBUTE_HIDDEN    = 0x2;
const FILE_ATTRIBUTE_SYSTEM    = 0x4;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;

// Lazily initialised so a koffi load failure degrades to "no attributes known"
// instead of taking down app startup. Attributes are an enhancement; every
// consumer treats "unknown" as visible.
let _win32 = undefined; // undefined = not tried, null = unavailable

function getWin32Bindings() {
  if (_win32 !== undefined) return _win32;
  if (process.platform !== 'win32') {
    _win32 = null;
    return _win32;
  }
  try {
    const koffi = require('koffi');
    const kernel32 = koffi.load('kernel32.dll');

    const FILETIME = koffi.struct('AE_FILETIME', {
      dwLowDateTime: 'uint32',
      dwHighDateTime: 'uint32'
    });
    const FIND_DATA = koffi.struct('AE_WIN32_FIND_DATAW', {
      dwFileAttributes: 'uint32',
      ftCreationTime: FILETIME,
      ftLastAccessTime: FILETIME,
      ftLastWriteTime: FILETIME,
      nFileSizeHigh: 'uint32',
      nFileSizeLow: 'uint32',
      dwReserved0: 'uint32',
      dwReserved1: 'uint32',
      cFileName: koffi.array('char16', 260, 'String'),
      cAlternateFileName: koffi.array('char16', 14, 'String')
    });

    _win32 = {
      koffi,
      FindFirstFileW: kernel32.func('void* __stdcall FindFirstFileW(str16 lpFileName, _Out_ AE_WIN32_FIND_DATAW *lpFindFileData)'),
      FindNextFileW: kernel32.func('bool __stdcall FindNextFileW(void* hFindFile, _Out_ AE_WIN32_FIND_DATAW *lpFindFileData)'),
      FindClose: kernel32.func('bool __stdcall FindClose(void* hFindFile)')
    };
  } catch (err) {
    logger.warn('Windows attribute lookup unavailable (koffi failed to load):', err.message);
    _win32 = null;
  }
  return _win32;
}

class FilesystemService {
  constructor() {
    this.driveCache = [];
    this.driveCacheExpiry = 0;
    this.CACHE_TTL = 60000; // 60 seconds in milliseconds
    this.DRIVE_CHECK_TIMEOUT = 500; // 500ms timeout per drive
  }

  /**
   * Windows hidden/system attributes for every entry in one directory.
   *
   * Returns a Map of filename → { hidden, system }, or null when attributes
   * cannot be determined (non-Windows, or koffi unavailable). Callers must
   * treat null and "absent from the map" as "not hidden, not system" — an
   * unknown attribute must never hide a file.
   *
   * See the block comment above for why this is FindFirstFileW rather than
   * `attrib`, `dir`, or a per-entry GetFileAttributesW loop.
   */
  readWindowsAttributes(dirPath) {
    const win32 = getWin32Bindings();
    if (!win32) return null;

    const { koffi, FindFirstFileW, FindNextFileW, FindClose } = win32;
    const out = new Map();
    let handle = null;

    try {
      const data = {};
      handle = FindFirstFileW(dirPath.replace(/[\\/]+$/, '') + '\\*', data);

      // FindFirstFileW returns INVALID_HANDLE_VALUE (-1) on failure — an
      // unreadable or missing directory. Not an error worth logging: callers
      // already handle a null result as "attributes unknown".
      const addr = koffi.address(handle);
      if (addr === -1 || addr === 0xFFFFFFFFFFFFFFFFn || addr === 0n || addr === 0) {
        return null;
      }

      do {
        const name = data.cFileName;
        if (name && name !== '.' && name !== '..') {
          // Keep the raw word as well as the decoded flags: `perms` is derived
          // from it here, and dwReserved0 (the reparse tag, available on this
          // struct) is the obvious next thing to surface from it.
          out.set(name, {
            attributes: data.dwFileAttributes,
            hidden: !!(data.dwFileAttributes & FILE_ATTRIBUTE_HIDDEN),
            system: !!(data.dwFileAttributes & FILE_ATTRIBUTE_SYSTEM)
          });
        }
      } while (FindNextFileW(handle, data));
    } catch (err) {
      logger.warn(`Error reading attributes for ${dirPath}:`, err.message);
      return null;
    } finally {
      if (handle) {
        try { FindClose(handle); } catch (_) { /* best effort */ }
      }
    }

    return out;
  }

  /**
   * Read directory contents and return file/folder info with inode and stats.
   * Every entry carries `isHidden` / `isSystem` where they can be determined.
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

    // One FindFirstFileW pass for the whole directory — cheap enough (1.5ms for
    // 42 entries) that there is no longer any reason to make it opt-in.
    const winAttrs = this.readWindowsAttributes(normalizedPath);
    const attrsFor = (name) => {
      if (!winAttrs) return null;
      const a = winAttrs.get(name);
      return { isHidden: !!(a && a.hidden), isSystem: !!(a && a.system) };
    };

    // perms from the attribute word we already have, instead of two accessSync
    // calls per entry. Those two calls were the larger half of this loop —
    // 477ms of System32's 800ms, 2.7s of WinSxS's 6.6s — and produced nothing
    // the attribute word does not already say. See permsFromAttributes.
    // Falls back to the syscalls when attributes are unavailable (non-Windows,
    // or koffi failed to load), so behaviour is unchanged there.
    const permsFor = (name, fullPath) => {
      const a = winAttrs ? winAttrs.get(name) : null;
      return a ? permsFromAttributes(a.attributes) : checkAccess(fullPath);
    };

    for (const entry of entries) {
      if (ignoreFilenames.includes(entry)) continue;
      try {
        const fullPath = path.join(normalizedPath, entry);
        // lstat, not stat: stat follows reparse points, so a link reports its
        // TARGET's inode and every consumer keyed on inode (change detection,
        // move detection, dir identity) confuses the link with the real thing.
        // For everything that survives the filter below, lstat === stat.
        const stats = fs.lstatSync(fullPath);
        const perms = permsFor(entry, fullPath);

        // Symlinks, Windows junctions and AppExecLink stubs all report as
        // S_IFLNK here — Node collapses every reparse tag it recognises into
        // isSymbolicLink() and never exposes the tag itself, so these three
        // cannot be told apart at this level.
        //
        // They ARE real directory entries, so they are listed: hiding them
        // makes the grid disagree with the filesystem, which is the one thing
        // this app has to get right. (It also hid every Store app alias in
        // %LOCALAPPDATA%\Microsoft\WindowsApps, whose targets live in a
        // protected directory the user cannot reach by any other path.)
        //
        // What they are NOT is safe to identify by inode or to walk into:
        //   - identity: a link's own inode is meaningless to callers that key
        //     on it (change detection, move detection, dir identity), and
        //     following it to the target's inode makes the link and the target
        //     indistinguishable. Links get a synthetic, path-stable identity.
        //   - traversal: walking them doubles scan/index work and lets deep
        //     search walk in circles through the profile root's legacy aliases
        //     (`My Documents`, `Application Data`, … all alias each other).
        // `isLink` is the flag downstream code uses to honour both.
        if (stats.isSymbolicLink()) {
          let targetIsDirectory = false;
          let targetReachable = true;
          try {
            // statSync follows the link — the only way to learn whether it
            // should render as a folder or a file.
            targetIsDirectory = fs.statSync(fullPath).isDirectory();
          } catch {
            // Broken link, or an AppExecLink whose target sits in a protected
            // store directory (EACCES). Not traversable either way; still
            // listed, because it really is there.
            targetReachable = false;
          }

          const linkInfo = {
            inode: `link:${entry}`,
            filename: entry,
            isDirectory: targetIsDirectory,
            isLink: true,
            linkTargetReachable: targetReachable,
            size: 0,
            dateModified: stats.mtime.getTime(),
            dateCreated: stats.birthtime.getTime(),
            path: fullPath,
            mode: stats.mode,
            perms,
            permError: false,
            ...(attrsFor(entry) || {})
          };

          // Sorted with folders when it points at one, so a junction sits
          // where Explorer puts it.
          if (targetIsDirectory) {
            folders.push(linkInfo);
          } else {
            files.push(linkInfo);
          }
          continue;
        }

        const inode = stats.ino.toString(); // Get inode

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
          permError: false,
          ...(attrsFor(entry) || {})
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
