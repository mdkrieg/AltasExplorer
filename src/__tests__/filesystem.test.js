/**
 * Unit Tests for FilesystemService
 * 
 * This test suite demonstrates how to test file system operations WITHOUT
 * touching the real filesystem. We accomplish this by "mocking" the `fs` 
 * and `path` modules so Jest returns fake data instead of real file info.
 * 
 * KEY CONCEPTS:
 * 1. jest.mock() - Replaces a module with a fake version
 * 2. jest.fn() - Creates a fake function we can track and configure
 * 3. .mockReturnValue() - Tells a fake function what to return
 * 4. beforeEach() - Setup code that runs before each test
 * 5. describe() + it() - Organizes tests into groups
 */

// Mock the 'fs' module and logger
jest.mock('fs');
jest.mock('fs/promises');
jest.mock('../logger');

// Now require the service we want to test
// It will use our mocked 'fs' instead of the real one
const fs = require('fs');
const fsp = require('fs/promises');
const FilesystemService = require('../filesystem');

/**
 * TEST SUITE 1: readDirectory()
 * 
 * The readDirectory() method should:
 * - Call fs.readdirSync() to list directory contents
 * - Call fs.statSync() for each entry to get file metadata
 * - Separate folders from files
 * - Return folders first, then files
 */
describe('FilesystemService - readDirectory()', () => {
  /**
   * beforeEach() runs before EVERY test in this describe block.
   * It's the perfect place to reset mocks and set up common test data.
   */
  beforeEach(() => {
    // Clear all mock calls from previous tests
    // This ensures each test starts clean
    jest.clearAllMocks();
  });

  /**
   * TEST: Should return folders before files
   * 
   * This test verifies the sorting logic. We:
   * 1. Mock fs.readdirSync() to return 2 items: a.txt (file) and subfolder/ (folder)
   * 2. Mock fs.statSync() to identify which is a folder vs file
   * 3. Call readDirectory()
   * 4. Assert that folders come first in the result
   */
  it('should return folders before files', () => {
    const testPath = '/test/directory';

    // Mock fs.readdirSync() to return fake directory contents
    // When our code calls fs.readdirSync('/test/directory'), it gets this array
    fs.readdirSync.mockReturnValue(['a.txt', 'subfolder']);

    // Mock fs.statSync() - it's called twice (once per file)
    // We need to return different stats depending on which file is being checked
    // .mockImplementation() gives us more control than .mockReturnValue()
    fs.statSync.mockImplementation((filePath) => {
      // If this is the subfolder, return stats showing it's a directory
      if (filePath.includes('subfolder')) {
        return {
          ino: 1001,
          isDirectory: () => true,  // This is a folder
          size: 4096,
          mtime: new Date('2026-01-01'),
          birthtime: new Date('2025-12-01')
        };
      }
      // Otherwise it's a file
      return {
        ino: 1002,
        isDirectory: () => false,  // This is a file
        size: 1024,
        mtime: new Date('2026-01-02'),
        birthtime: new Date('2025-12-02')
      };
    });

    // Call the method we're testing
    const result = FilesystemService.readDirectory(testPath);

    // ASSERTIONS: Verify the behavior
    // toHaveLength(2) - Should have 2 items total
    expect(result).toHaveLength(2);
    
    // First item should be the folder (isDirectory is true)
    expect(result[0].isDirectory).toBe(true);
    expect(result[0].filename).toBe('subfolder');
    
    // Second item should be the file (isDirectory is false)
    expect(result[1].isDirectory).toBe(false);
    expect(result[1].filename).toBe('a.txt');
  });

  /**
   * TEST: Should include inode in file info
   * 
   * This test verifies that each file result includes the inode number,
   * which is crucial for your change detection system.
   */
  it('should include inode in file info', () => {
    const testPath = '/test/directory';

    fs.readdirSync.mockReturnValue(['document.pdf']);
    fs.statSync.mockReturnValue({
      ino: 5678,  // The inode number
      isDirectory: () => false,
      size: 2048,
      mtime: new Date('2026-01-01'),
      birthtime: new Date('2025-12-01')
    });

    const result = FilesystemService.readDirectory(testPath);

    // The inode should be converted to a string
    expect(result[0].inode).toBe('5678');
    expect(result[0].filename).toBe('document.pdf');
  });

  /**
   * TEST: Should handle individual file read errors gracefully
   * 
   * REAL-WORLD SCENARIO: User has a directory with a permission-denied file.
   * Our code should:
   * - Catch the error for that specific file
   * - Log it (for debugging)
   * - Continue processing other files
   * - Return the successfully-read files
   */
  it('should skip files that fail to read (permissions, etc.)', () => {
    const testPath = '/test/directory';

    // Directory contains 3 files
    fs.readdirSync.mockReturnValue(['good1.txt', 'bad.txt', 'good2.txt']);

    // Mock statSync to throw an error for the middle file
    fs.statSync.mockImplementation((filePath) => {
      if (filePath.includes('bad.txt')) {
        throw new Error('Permission denied');
      }
      return {
        ino: 1000,
        isDirectory: () => false,
        size: 100,
        mtime: new Date('2026-01-01'),
        birthtime: new Date('2025-12-01')
      };
    });

    // Create a logger mock to verify warnings are logged
    const logger = require('../logger');

    const result = FilesystemService.readDirectory(testPath);

    // Should only have 2 items (bad.txt was skipped)
    expect(result).toHaveLength(2);
    expect(result[0].filename).toBe('good1.txt');
    expect(result[1].filename).toBe('good2.txt');

    // Verify that a warning was logged (logger.warn called for the bad file)
    expect(logger.warn).toHaveBeenCalled();
  });
});

/**
 * TEST SUITE 2: isDirectory()
 * 
 * Tests the isDirectory() method which checks if a path is a directory.
 * This is simpler than readDirectory - it returns a boolean.
 */
describe('FilesystemService - isDirectory()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * TEST: Should return true for directories
   */
  it('should return true when path is a directory', () => {
    fs.statSync.mockReturnValue({
      isDirectory: () => true
    });

    const result = FilesystemService.isDirectory('/some/directory');
    expect(result).toBe(true);
  });

  /**
   * TEST: Should return false for files
   */
  it('should return false when path is a file', () => {
    fs.statSync.mockReturnValue({
      isDirectory: () => false
    });

    const result = FilesystemService.isDirectory('/some/file.txt');
    expect(result).toBe(false);
  });

  /**
   * TEST: Should return false when path doesn't exist
   * 
   * EDGE CASE: If fs.statSync() throws an error (file not found),
   * isDirectory() should catch it and return false.
   */
  it('should return false when path does not exist', () => {
    fs.statSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });

    const result = FilesystemService.isDirectory('/nonexistent/path');
    expect(result).toBe(false);
  });
});

/**
 * TEST SUITE 3: getStats()
 * 
 * Tests the getStats() method which retrieves metadata for a single file/folder.
 */
describe('FilesystemService - getStats()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * TEST: Should return complete file metadata
   */
  it('should return file stats with inode, size, and dates', () => {
    const mockDate1 = new Date('2026-01-01');
    const mockDate2 = new Date('2025-12-01');

    fs.statSync.mockReturnValue({
      ino: 9999,
      isDirectory: () => false,
      size: 5120,
      mtime: mockDate1,
      birthtime: mockDate2
    });

    const result = FilesystemService.getStats('/test/file.txt');

    // Verify all expected properties are present
    expect(result.inode).toBe('9999');
    expect(result.isDirectory).toBe(false);
    expect(result.size).toBe(5120);
    expect(result.dateModified).toBe(mockDate1.getTime());
    expect(result.dateCreated).toBe(mockDate2.getTime());
    expect(result.path).toBe('/test/file.txt');
  });

  /**
   * TEST: Should return null on error
   * 
   * IMPORTANT: getStats() returns null instead of throwing an error.
   * This is a defensive pattern - callers can check for null instead of
   * having to catch exceptions.
   */
  it('should return null when file cannot be accessed', () => {
    fs.statSync.mockImplementation(() => {
      throw new Error('Access denied');
    });

    const result = FilesystemService.getStats('/inaccessible/file.txt');
    expect(result).toBeNull();
  });
});

/**
 * TEST SUITE 4: isAncestorOrSelf()
 *
 * Pure function used to block dropping a folder into itself or a descendant
 * during drag-and-drop. Case-insensitive prefix check that respects path
 * separators on both Windows and POSIX.
 */
describe('FilesystemService - isAncestorOrSelf()', () => {
  it('should return true when paths are equal', () => {
    expect(FilesystemService.isAncestorOrSelf('/foo/bar', '/foo/bar')).toBe(true);
  });

  it('should return true for a descendant', () => {
    expect(FilesystemService.isAncestorOrSelf('/foo', '/foo/bar/baz')).toBe(true);
  });

  it('should be case-insensitive', () => {
    expect(FilesystemService.isAncestorOrSelf('/Foo', '/foo/bar')).toBe(true);
  });

  it('should not treat a sibling as a descendant', () => {
    expect(FilesystemService.isAncestorOrSelf('/foo/bar', '/foo/baz')).toBe(false);
  });

  it('should not treat a name-prefix match as a descendant', () => {
    // "/foo/bar" must NOT be considered an ancestor of "/foo/barbecue".
    expect(FilesystemService.isAncestorOrSelf('/foo/bar', '/foo/barbecue')).toBe(false);
  });

  it('should return false for empty inputs', () => {
    expect(FilesystemService.isAncestorOrSelf('', '/foo')).toBe(false);
    expect(FilesystemService.isAncestorOrSelf('/foo', '')).toBe(false);
    expect(FilesystemService.isAncestorOrSelf(null, '/foo')).toBe(false);
  });
});

/**
 * TEST SUITE 5: pathExists()
 *
 * Async helper that returns true iff the path is reachable via stat. Used by
 * the drag-and-drop pipeline to detect destination collisions.
 */
describe('FilesystemService - pathExists()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return true when stat succeeds', async () => {
    fsp.stat.mockResolvedValue({ ino: 1 });
    await expect(FilesystemService.pathExists('/exists')).resolves.toBe(true);
  });

  it('should return false when stat throws', async () => {
    fsp.stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await expect(FilesystemService.pathExists('/missing')).resolves.toBe(false);
  });

  it('should return false for falsy paths', async () => {
    await expect(FilesystemService.pathExists('')).resolves.toBe(false);
    await expect(FilesystemService.pathExists(null)).resolves.toBe(false);
  });
});

/**
 * TEST SUITE 6: pickNonCollidingPath()
 *
 * Generates "name (2).ext" style replacements when the destination already
 * has the same filename. Verifies that it preserves the extension and stops
 * at the first available index.
 */
describe('FilesystemService - pickNonCollidingPath()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should append " (2)" before the extension on the first collision', async () => {
    const path = require('path');
    // Only "/dir/foo (2).txt" is free.
    fsp.stat.mockImplementation(async (p) => {
      if (p === path.join('/dir', 'foo (2).txt')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { ino: 1 };
    });
    const result = await FilesystemService.pickNonCollidingPath('/dir', 'foo.txt');
    expect(result).toBe(path.join('/dir', 'foo (2).txt'));
  });

  it('should keep incrementing until it finds a free name', async () => {
    const path = require('path');
    fsp.stat.mockImplementation(async (p) => {
      // Collide for indices 2, 3; (4) is free.
      if (p.endsWith(' (4).txt')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { ino: 1 };
    });
    const result = await FilesystemService.pickNonCollidingPath('/dir', 'foo.txt');
    expect(result).toBe(path.join('/dir', 'foo (4).txt'));
  });

  it('should append " (2)" at the end when there is no extension (folders)', async () => {
    const path = require('path');
    fsp.stat.mockImplementation(async (p) => {
      if (p === path.join('/dir', 'myfolder (2)')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { ino: 1 };
    });
    const result = await FilesystemService.pickNonCollidingPath('/dir', 'myfolder');
    expect(result).toBe(path.join('/dir', 'myfolder (2)'));
  });
});

/**
 * TEST SUITE 7: moveItem()
 *
 * Verifies the rename path and the EXDEV cross-drive fallback (copy + remove).
 */
describe('FilesystemService - moveItem()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should reject when source or target is missing', async () => {
    await expect(FilesystemService.moveItem('', '/dst')).rejects.toThrow(/source and target/);
    await expect(FilesystemService.moveItem('/src', '')).rejects.toThrow(/source and target/);
  });

  it('should call fs.rename on the same drive', async () => {
    fsp.rename.mockResolvedValue(undefined);
    await FilesystemService.moveItem('/src/a.txt', '/dst/a.txt');
    expect(fsp.rename).toHaveBeenCalledWith('/src/a.txt', '/dst/a.txt');
    expect(fsp.cp).not.toHaveBeenCalled();
  });

  it('should fall back to copy + remove on EXDEV', async () => {
    fsp.rename.mockRejectedValue(Object.assign(new Error('cross-device link'), { code: 'EXDEV' }));
    fsp.cp.mockResolvedValue(undefined);
    fsp.rm.mockResolvedValue(undefined);

    await FilesystemService.moveItem('/srcDrive/folder', '/dstDrive/folder');

    expect(fsp.cp).toHaveBeenCalledWith(
      '/srcDrive/folder',
      '/dstDrive/folder',
      expect.objectContaining({ recursive: true })
    );
    expect(fsp.rm).toHaveBeenCalledWith('/srcDrive/folder', expect.objectContaining({ recursive: true, force: true }));
  });

  it('should re-throw non-EXDEV errors without copying', async () => {
    fsp.rename.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(FilesystemService.moveItem('/a', '/b')).rejects.toThrow(/EACCES/);
    expect(fsp.cp).not.toHaveBeenCalled();
  });
});

/**
 * TEST SUITE 8: copyItem()
 *
 * Recursive copy used by Ctrl-drag and (later) external drag-in.
 */
describe('FilesystemService - copyItem()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should reject when source or target is missing', async () => {
    await expect(FilesystemService.copyItem('', '/dst')).rejects.toThrow(/source and target/);
    await expect(FilesystemService.copyItem('/src', '')).rejects.toThrow(/source and target/);
  });

  it('should delegate to fs.cp with recursive + errorOnExist', async () => {
    fsp.cp.mockResolvedValue(undefined);
    await FilesystemService.copyItem('/src/folder', '/dst/folder');
    expect(fsp.cp).toHaveBeenCalledWith(
      '/src/folder',
      '/dst/folder',
      expect.objectContaining({ recursive: true, errorOnExist: true, force: false })
    );
  });

  it('should propagate fs.cp errors', async () => {
    fsp.cp.mockRejectedValue(new Error('disk full'));
    await expect(FilesystemService.copyItem('/a', '/b')).rejects.toThrow(/disk full/);
  });
});


