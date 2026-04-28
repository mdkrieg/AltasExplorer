'use strict';

/**
 * server/src/server.js
 *
 * Creates and configures the Express application. Returns { app, httpServer }
 * so run.js can attach the WebSocket handler and call httpServer.listen().
 */

const http          = require('http');
const path          = require('path');
const os            = require('os');
const express       = require('express');
const helmet        = require('helmet');
const cookieParser  = require('cookie-parser');
const session       = require('express-session');

const auth       = require('./auth');
const apiRouter  = require('./api-router');
const fileServe  = require('./file-serve');
const wsHandler  = require('./ws-handler');

const DIST_APP = path.join(__dirname, '..', 'dist', 'app');

function createApp(config) {
  // Initialise auth module with config
  auth.init(config);

  const app = express();

  // ── Security headers ───────────────────────────────────────────────────────
  // Relax CSP for the Monaco editor and inline scripts/styles used by w2ui.
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:     ["'self'"],
        scriptSrc:      ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        scriptSrcAttr:  ["'unsafe-inline'"],
        styleSrc:       ["'self'", "'unsafe-inline'"],
        imgSrc:         ["'self'", 'data:', 'blob:'],
        fontSrc:        ["'self'", 'data:'],
        connectSrc:     ["'self'", 'ws:', 'wss:'],
        workerSrc:      ["'self'", 'blob:'],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  // ── Request parsing ────────────────────────────────────────────────────────
  app.use(cookieParser());
  app.use(express.json({ limit: '50mb' }));

  // ── Sessions ───────────────────────────────────────────────────────────────
  const sessionMiddleware = session({
    secret:            config.sessionSecret,
    resave:            false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure:   config.https && config.https.enabled,
      sameSite: 'strict',
      maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days
    },
  });
  app.use(sessionMiddleware);

  // ── Auth middleware + routes ───────────────────────────────────────────────
  app.use(auth.middleware);
  app.use('/auth', auth.router);

  // ── Default favicon from repo assets ─────────────────────────────────────
  const FAVICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.ico');
  app.get('/favicon.ico', (req, res) => res.sendFile(FAVICON_PATH));

  // ── User icons — served before the dist static so custom icons take effect ──
  app.use('/assets/icons', express.static(path.join(os.homedir(), '.atlasexplorer', 'icons')));

  // ── Static renderer build ─────────────────────────────────────────────────
  app.use(express.static(DIST_APP));

  // ── API (JSON-RPC) ─────────────────────────────────────────────────────────
  apiRouter.init(config);
  app.post('/api', apiRouter.handle);

  // ── File serving ───────────────────────────────────────────────────────────
  fileServe.init(config);
  app.use('/files', fileServe.router);

  // ── SPA fallback — send index.html for any unmatched GET ──────────────────
  app.get('*', (req, res) => {
    res.sendFile(path.join(DIST_APP, 'index.html'));
  });

  // ── Wrap in http.Server so ws-handler can attach ──────────────────────────
  const httpServer = http.createServer(app);
  wsHandler.attach(httpServer, config, sessionMiddleware);

  return { app, httpServer };
}

module.exports = { createApp };
