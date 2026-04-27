'use strict';

/**
 * server/config.example.js
 *
 * Copy this file to server/config.js and fill in values before running.
 * Run `node server/hash-password.js <password>` to generate a passwordHash.
 */

module.exports = {
  // ── Network ──────────────────────────────────────────────────────────────
  port: 3000,

  // ── Data directory ───────────────────────────────────────────────────────
  // Where Atlas Explorer stores its data (categories, tags, DB, etc.)
  // Defaults to ~/.atlasexplorer on all platforms.
  dataDir: require('os').homedir() + '/.atlasexplorer',

  // ── Authentication ───────────────────────────────────────────────────────
  // Long random string used to sign session cookies. Change this.
  sessionSecret: 'CHANGE_ME_TO_A_LONG_RANDOM_STRING',

  // bcrypt hash of the login password. Generate with:
  //   node server/hash-password.js <yourpassword>
  passwordHash: '',

  // Set to true to also accept an Authorization: Bearer <token> header.
  // Useful for scripted API access alongside browser sessions.
  allowBearerToken: false,

  // The bearer token value (only used when allowBearerToken is true).
  bearerToken: '',

  // ── Custom Actions ───────────────────────────────────────────────────────
  // Shell execution over HTTP is a significant attack surface.
  // Set to true only if you understand the risk and trust all users with access.
  runCustomActionsEnabled: false,

  // ── Trash ────────────────────────────────────────────────────────────────
  // Where deleted items are moved. Defaults to XDG trash (~/.local/share/Trash)
  // which is visible to the system file manager on Linux.
  // Set to a custom path (e.g. ~/.atlasexplorer/trash) for app-local trash.
  trashDir: null, // null = use XDG default

  // ── HTTPS ────────────────────────────────────────────────────────────────
  // For production use, run behind a reverse proxy (nginx/caddy) with TLS,
  // or supply cert/key paths here.
  https: {
    enabled: false,
    certPath: '',  // path to fullchain.pem / cert.pem
    keyPath: '',   // path to privkey.pem
  },
};
