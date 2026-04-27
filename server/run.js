'use strict';

/**
 * server/run.js
 *
 * Entry point for the Atlas Explorer server.
 *
 * Usage:
 *   node server/run.js
 *   node server/run.js --config /path/to/config.js
 *
 * From repo root (after adding npm scripts):
 *   npm run server
 */

const path = require('path');
const os   = require('os');

// ── Config loading ────────────────────────────────────────────────────────────

function loadConfig() {
  const args = process.argv.slice(2);
  const configIdx = args.indexOf('--config');
  const configPath = configIdx !== -1
    ? path.resolve(args[configIdx + 1])
    : path.join(__dirname, 'config.js');

  let config;
  try {
    config = require(configPath);
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      console.error(`Config file not found: ${configPath}`);
      console.error('Run `node server/install.js` to set up, or copy server/config.example.js to server/config.js');
      process.exit(1);
    }
    throw err;
  }

  // Apply defaults
  config.port    = config.port    || 3000;
  config.dataDir = config.dataDir || path.join(os.homedir(), '.atlasexplorer');
  return config;
}

// ── Service module initialisation ─────────────────────────────────────────────
// Mirror the initialisation sequence in main/main.js

function initServices(config) {
  const db         = require('../src/db');
  const categories = require('../src/categories');
  const tags       = require('../src/tags');
  const filetypes  = require('../src/filetypes');
  const icons      = require('../src/icons');
  const checksum   = require('../src/checksum');
  const attributes = require('../src/attributes');
  const autoLabels = require('../src/autoLabels');
  const layouts    = require('../src/layouts');
  const customActions = require('../src/customActions');
  const logger     = require('../src/logger');

  logger.initialize(config.dataDir);
  db.initialize(config.dataDir);
  categories.initialize(config.dataDir);
  tags.initialize(config.dataDir);
  filetypes.initialize(config.dataDir);
  icons.initialize(config.dataDir);
  attributes.initialize(config.dataDir);
  autoLabels.initialize(config.dataDir);
  layouts.initialize(config.dataDir);
  customActions.initialize(config.dataDir);

  return { db, categories, tags, filetypes, icons, checksum, attributes, autoLabels, layouts, customActions, logger };
}

// ── HTTPS or HTTP server ───────────────────────────────────────────────────────

function startServer(config) {
  const { createApp } = require('./src/server');
  const { httpServer } = createApp(config);

  if (config.https && config.https.enabled) {
    const fs     = require('fs');
    const https  = require('https');
    const sslOpts = {
      cert: fs.readFileSync(config.https.certPath),
      key:  fs.readFileSync(config.https.keyPath),
    };
    // Replace the plain http server with an https server sharing the same app
    const { app } = createApp(config);
    const secureServer = https.createServer(sslOpts, app);
    secureServer.listen(config.port, () => {
      console.log(`Atlas Explorer server running at https://localhost:${config.port}`);
    });
  } else {
    httpServer.listen(config.port, () => {
      const url = `http://localhost:${config.port}`;
      console.log(`Atlas Explorer server running at ${url}`);
      console.log(`Visit ${url} in your browser.`);
    });
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const config = loadConfig();
initServices(config);
startServer(config);
