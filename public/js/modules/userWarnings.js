/**
 * User Warning system.
 *
 * Currently writes warnings to the console. In the future this will also surface
 * warnings in the UI (e.g. a transient toast or a warnings panel).
 *
 * Usage:
 *   import { warnUser } from './userWarnings.js';
 *   warnUser('REMINDER keyword found on same line as TODO:', { line: 5, content: '...' });
 */

/**
 * Issue a user-visible warning.
 *
 * @param {string} message  Human-readable description of the problem.
 * @param {object} [context] Optional structured details (line numbers, file path, etc.)
 */
export function warnUser(message, context = {}) {
  // TODO(future): surface this in the UI (toast notification / warnings panel)
  console.warn('[User Warning]', message, context);
}
