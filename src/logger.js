/**
 * Centralized Logging Service
 * 
 * Provides structured logging with:
 * - Multiple log levels (INFO, WARN, ERROR)
 * - Source tracking (MAIN process or RENDERER)
 * - File-based persistence to ~/.bestexplorer/logs/app-YYYY-MM-DD.log
 * - Timestamps on every entry
 * 
 * Usage:
 *   const logger = require('./logger');
 *   logger.info('Application started');
 *   logger.warn('File not found (expected)');
 *   logger.error('Database connection failed');
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_DIR = path.join(os.homedir(), '.bestexplorer', 'logs');

class Logger {
  constructor() {
    this.ensureLogDirectory();
  }

  /**
   * Ensure the log directory exists
   * Creates ~/.bestexplorer/logs if it doesn't exist
   */
  ensureLogDirectory() {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
  }

  /**
   * Get current log file path based on today's date
   * Format: app-2026-03-26.log
   */
  getLogFilePath() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const filename = `app-${year}-${month}-${day}.log`;
    return path.join(LOG_DIR, filename);
  }

  /**
   * Format timestamp as HH:MM:SS
   */
  getTimestamp() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  }

  /**
   * Internal method to write a log entry
   * 
   * @param {string} source - Where the log came from: [MAIN] or [RENDERER]
   * @param {string} level - Log level: INFO, WARN, or ERROR
   * @param {string} message - Main log message
   * @param {*} args - Additional arguments to include
   */
  _writeLog(source, level, message, args) {
    try {
      const timestamp = this.getTimestamp();
      
      // Format: [HH:MM:SS] [SOURCE] [LEVEL] message
      let logEntry = `[${timestamp}] [${source}] [${level}] ${message}`;
      
      // If additional args provided, append them
      if (args && args.length > 0) {
        const argsStr = args.map(arg => {
          // Convert objects to readable JSON
          if (typeof arg === 'object') {
            try {
              return JSON.stringify(arg);
            } catch {
              return String(arg);
            }
          }
          return String(arg);
        }).join(' ');
        logEntry += ` ${argsStr}`;
      }
      
      logEntry += '\n';
      
      // Also log to console for immediate feedback (except in tests)
      // This allows users to see logs in real-time while also having file persistence
      if (process.env.NODE_ENV !== 'test') {
        const consoleMethod = level === 'ERROR' ? 'error' : (level === 'WARN' ? 'warn' : 'log');
        console[consoleMethod](`[${source}] ${level}:`, message, ...args);
      }
      
      // Append to log file
      const logFilePath = this.getLogFilePath();
      fs.appendFileSync(logFilePath, logEntry, 'utf8');
    } catch (err) {
      // Fallback: if file write fails, at least log to console
      console.error('Logger write failed:', err.message);
    }
  }

  /**
   * Log an INFO level message (normal operation)
   * 
   * @param {string} message - The log message
   * @param {...*} args - Additional arguments
   * 
   * Example:
   *   logger.info('Starting directory scan', dirPath);
   */
  info(message, ...args) {
    this._writeLog('MAIN', 'INFO', message, args);
  }

  /**
   * Log a WARN level message (expected edge cases, not errors)
   * 
   * Use for situations where:
   * - File not found (expected if user navigates to a deleted folder)
   * - Permission denied (expected for system files)
   * - Empty directory (not an error, just a state)
   * 
   * @param {string} message - The log message
   * @param {...*} args - Additional arguments
   * 
   * Example:
   *   logger.warn('File not found, continuing with fallback', filename);
   */
  warn(message, ...args) {
    this._writeLog('MAIN', 'WARN', message, args);
  }

  /**
   * Log an ERROR level message (actual problems)
   * 
   * Use for situations where:
   * - Database connection failed
   * - Unexpected exceptions
   * - System resource exhaustion
   * 
   * @param {string} message - The log message
   * @param {...*} args - Additional arguments
   * 
   * Example:
   *   logger.error('Database query failed:', err.message);
   */
  error(message, ...args) {
    this._writeLog('MAIN', 'ERROR', message, args);
  }

  /**
   * Log from the renderer process (browser)
   * Called via IPC when renderer wants to log
   * 
   * @param {string} level - INFO, WARN, or ERROR
   * @param {string} message - The log message
   * @param {*} args - Additional arguments
   * 
   * This is typically called from preload.js via IPC
   */
  rendererLog(level, message, ...args) {
    this._writeLog('RENDERER', level, message, args);
  }
}

// Export singleton instance
module.exports = new Logger();
