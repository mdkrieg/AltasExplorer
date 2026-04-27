'use strict';

/**
 * server/src/path-jail.js
 *
 * Validates that a filesystem path is within an allowed root before any
 * mutation operation. Every route that reads or writes files must call this.
 *
 * Throws a JailError (subclass of Error) if the resolved path escapes the
 * allowed roots. Callers should catch JailError and return HTTP 403.
 */

const path = require('path');
const os   = require('os');

class JailError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JailError';
    this.statusCode = 403;
  }
}

/**
 * Resolve and validate that `inputPath` sits inside at least one allowed root.
 *
 * @param {string} inputPath    - Raw path from API request
 * @param {object} config       - Server config object
 * @param {boolean} [mustExist] - If true, also throws if path does not exist on disk
 * @returns {string}            - The resolved absolute path (safe to use)
 * @throws {JailError}          - If path escapes the jail
 */
function jail(inputPath, config, mustExist = false) {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new JailError('Path must be a non-empty string');
  }

  const resolved = path.resolve(inputPath);

  // Build the list of allowed roots from config
  const allowedRoots = new Set();
  if (config.dataDir) {
    allowedRoots.add(path.resolve(config.dataDir));
  }
  allowedRoots.add(path.resolve(os.homedir()));

  // On Windows, also allow all drive roots so users can browse their own machine.
  // On Linux/macOS (Pi), home dir is typically the intended root.
  // Additional roots can be added via config.allowedRoots = ['...', '...'].
  if (Array.isArray(config.allowedRoots)) {
    for (const r of config.allowedRoots) {
      allowedRoots.add(path.resolve(r));
    }
  }

  let allowed = false;
  for (const root of allowedRoots) {
    // Ensure we compare with a trailing separator to prevent
    // /home/pi-evil from matching /home/pi
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (resolved === root || resolved.startsWith(rootWithSep)) {
      allowed = true;
      break;
    }
  }

  if (!allowed) {
    throw new JailError(`Access denied: path outside allowed roots: ${resolved}`);
  }

  if (mustExist) {
    const fs = require('fs');
    if (!fs.existsSync(resolved)) {
      const e = new JailError(`Path does not exist: ${resolved}`);
      e.statusCode = 404;
      throw e;
    }
  }

  return resolved;
}

module.exports = { jail, JailError };
