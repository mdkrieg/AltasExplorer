jest.mock('fs');
jest.mock('sharp', () => jest.fn());
jest.mock('../logger', () => ({
  warn: jest.fn(),
  error: jest.fn()
}));

const path = require('path');
const fs = require('fs');
const logger = require('../logger');

describe('IconService - bootstrap icon assets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates user icons directory and copies missing icon files', () => {
    fs.existsSync.mockImplementation((checkPath) => {
      if (checkPath.includes(`${path.sep}resources${path.sep}icons`)) {
        return true;
      }

      if (checkPath.includes(`${path.sep}.atlasexplorer${path.sep}icons${path.sep}`)) {
        return false;
      }

      if (checkPath.endsWith(`${path.sep}.atlasexplorer${path.sep}icons`)) {
        return false;
      }

      return false;
    });

    fs.readdirSync.mockImplementation((dirPath, options) => {
      if (dirPath.includes(`${path.sep}resources${path.sep}icons`)) {
        if (options && options.withFileTypes) {
          return [
            { name: 'folder.png', isFile: () => true },
            { name: 'README.md', isFile: () => true }
          ];
        }

        return ['folder.png', 'README.md'];
      }

      return [];
    });

    const icons = require('../icons');
    jest.clearAllMocks();
    icons.ensureIconAssets();

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining(`${path.sep}.atlasexplorer${path.sep}icons`),
      { recursive: true }
    );
    expect(fs.copyFileSync).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite icon files that already exist in user directory', () => {
    fs.existsSync.mockImplementation((checkPath) => {
      if (checkPath.includes(`${path.sep}resources${path.sep}icons`)) {
        return true;
      }

      if (checkPath.endsWith(`${path.sep}.atlasexplorer${path.sep}icons`)) {
        return true;
      }

      if (checkPath.endsWith(`${path.sep}folder.png`)) {
        return true;
      }

      return false;
    });

    fs.readdirSync.mockImplementation((dirPath, options) => {
      if (dirPath.includes(`${path.sep}resources${path.sep}icons`)) {
        if (options && options.withFileTypes) {
          return [
            { name: 'folder.png', isFile: () => true },
            { name: 'new-icon.png', isFile: () => true }
          ];
        }

        return ['folder.png', 'new-icon.png'];
      }

      return [];
    });

    const icons = require('../icons');
    jest.clearAllMocks();
    icons.ensureIconAssets();

    expect(fs.copyFileSync).toHaveBeenCalledTimes(1);
    expect(fs.copyFileSync.mock.calls[0][1]).toContain('new-icon.png');
  });

  it('logs a warning and skips copy when no bundled icon directory exists', () => {
    fs.existsSync.mockReturnValue(false);

    const icons = require('../icons');
    jest.clearAllMocks();
    icons.ensureIconAssets();

    expect(logger.warn).toHaveBeenCalledWith(
      'No bundled icons directory found; skipping icon asset bootstrap'
    );
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(fs.copyFileSync).not.toHaveBeenCalled();
  });
});
