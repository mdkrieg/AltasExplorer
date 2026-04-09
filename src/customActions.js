/**
 * Custom Actions Service
 *
 * Manages user-defined executable actions stored in ~/.atlasexplorer/custom-actions.json.
 * Each action specifies an executable, optional extra arguments, and optional file pattern
 * filters that control when the action appears in the context menu.
 *
 * Script-type executables (.bat, .cmd, .sh, .py) have their SHA-256 checksum recorded at
 * save time so that unexpected modifications can be detected before execution.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const crypto = require('crypto');

const ACTIONS_FILE = path.join(os.homedir(), '.atlasexplorer', 'custom-actions.json');

// Extensions whose content can be trivially modified in a text editor — checksum these.
// Binary executables (.exe, .com) are not checksummed; use OS Authenticode for those.
const SCRIPT_EXTENSIONS = new Set(['.bat', '.cmd', '.sh', '.py']);

function isScriptType(executable) {
  return SCRIPT_EXTENSIONS.has(path.extname(executable).toLowerCase());
}

function computeChecksum(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

class CustomActionService {
  /**
   * Return all configured custom actions, or [] if the file does not exist.
   */
  getCustomActions() {
    try {
      if (!fs.existsSync(ACTIONS_FILE)) return [];
      const content = fs.readFileSync(ACTIONS_FILE, 'utf8');
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Create or update a custom action entry.
   * Automatically (re-)computes the checksum for script-type executables.
   *
   * @param {object} entry - { id, label, executable, args, filePatterns }
   * @returns {object} The saved entry (with checksum fields populated).
   */
  saveCustomAction(entry) {
    const { id, label, executable, args, filePatterns } = entry;
    if (!id || !label || !executable) {
      throw new Error('id, label, and executable are required');
    }

    let checksum = null;
    let checksumUpdatedAt = null;
    if (isScriptType(executable) && fs.existsSync(executable)) {
      checksum = computeChecksum(executable);
      checksumUpdatedAt = new Date().toISOString();
    }

    const newEntry = {
      id,
      label,
      executable,
      args: Array.isArray(args) ? args : [],
      filePatterns: Array.isArray(filePatterns) ? filePatterns : [],
      checksum,
      checksumUpdatedAt
    };

    const actions = this.getCustomActions();
    const index = actions.findIndex(a => a.id === id);
    if (index >= 0) {
      actions[index] = newEntry;
    } else {
      actions.push(newEntry);
    }

    this._save(actions);
    return newEntry;
  }

  /**
   * Remove a custom action by id.
   */
  deleteCustomAction(id) {
    const actions = this.getCustomActions();
    const filtered = actions.filter(a => a.id !== id);
    this._save(filtered);
  }

  /**
   * Verify that a script-type executable's content matches its stored checksum.
   *
   * Returns:
   *   { valid: true,  current: hash,  isScriptType: true/false }  — unchanged or no-checksum-needed
   *   { valid: false, current: hash,  isScriptType: true }         — checksum mismatch (modified)
   *   { valid: null,  current: null,  isScriptType: true }         — file not found
   */
  verifyChecksum(entry) {
    if (!entry || !entry.executable) {
      return { valid: true, current: null, isScriptType: false };
    }
    if (!isScriptType(entry.executable)) {
      return { valid: true, current: null, isScriptType: false };
    }
    // Script type but no checksum stored yet — treat as trusted (user just configured it)
    if (!entry.checksum) {
      return { valid: true, current: null, isScriptType: true };
    }
    const current = computeChecksum(entry.executable);
    if (!current) {
      // File not found on disk
      return { valid: null, current: null, isScriptType: true };
    }
    return { valid: current === entry.checksum, current, isScriptType: true };
  }

  /**
   * Expose isScriptType for IPC handler use.
   */
  isScriptType(executable) {
    return isScriptType(executable);
  }

  _save(actions) {
    const dir = path.dirname(ACTIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ACTIONS_FILE, JSON.stringify(actions, null, 2));
  }
}

module.exports = new CustomActionService();
