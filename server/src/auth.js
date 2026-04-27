'use strict';

/**
 * server/src/auth.js
 *
 * Session-based authentication middleware + login/logout routes.
 *
 * Supports two auth modes (configured in config.js):
 *   1. Session cookie  — browser login via /login form (default)
 *   2. Bearer token    — Authorization: Bearer <token> header (opt-in via config.allowBearerToken)
 *
 * Usage in server.js:
 *   const auth = require('./auth');
 *   auth.init(config);
 *   app.use(auth.middleware);
 *   app.use('/auth', auth.router);
 */

const express = require('express');
const bcrypt  = require('bcrypt');

let _config = null;

// Routes that bypass auth entirely
const PUBLIC_PATHS = new Set(['/auth/login', '/auth/logout']);

// ── Middleware ───────────────────────────────────────────────────────────────

function middleware(req, res, next) {
  // Allow public paths through
  if (PUBLIC_PATHS.has(req.path)) return next();

  // Bearer token check (optional)
  if (_config.allowBearerToken && _config.bearerToken) {
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      if (token === _config.bearerToken) return next();
    }
  }

  // Session cookie check
  if (req.session && req.session.authenticated) return next();

  // API calls get 401 JSON; browser navigation gets redirect
  if (req.path.startsWith('/api') || req.path.startsWith('/files') || req.path.startsWith('/ws')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return res.redirect('/auth/login');
}

// ── Login form HTML ──────────────────────────────────────────────────────────

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Atlas Explorer — Login</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      background: #1e1e2e; font-family: system-ui, sans-serif;
      color: #cdd6f4;
    }
    .card {
      background: #313244; border-radius: 10px; padding: 2.5rem 2rem;
      width: 100%; max-width: 360px; box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    h1 { margin: 0 0 1.5rem; font-size: 1.4rem; font-weight: 600; text-align: center; }
    label { display: block; font-size: 0.85rem; margin-bottom: 0.35rem; color: #a6adc8; }
    input[type="password"] {
      width: 100%; padding: 0.6rem 0.8rem; border-radius: 6px;
      border: 1px solid #45475a; background: #1e1e2e; color: #cdd6f4;
      font-size: 1rem; margin-bottom: 1.2rem; outline: none;
    }
    input[type="password"]:focus { border-color: #89b4fa; }
    button {
      width: 100%; padding: 0.7rem; border: none; border-radius: 6px;
      background: #89b4fa; color: #1e1e2e; font-size: 1rem; font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #b4befe; }
    .error {
      background: #f38ba8; color: #1e1e2e; border-radius: 6px;
      padding: 0.5rem 0.8rem; margin-bottom: 1rem; font-size: 0.9rem;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Atlas Explorer</h1>
    {{ERROR}}
    <form method="POST" action="/auth/login">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autofocus autocomplete="current-password">
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`;

// ── Router ───────────────────────────────────────────────────────────────────

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect('/');
  }
  res.send(LOGIN_HTML.replace('{{ERROR}}', ''));
});

router.post('/login', express.urlencoded({ extended: false }), async (req, res) => {
  const { password } = req.body;

  if (!password || !_config.passwordHash) {
    const html = LOGIN_HTML.replace('{{ERROR}}', '<div class="error">Server not configured — no password hash set.</div>');
    return res.status(401).send(html);
  }

  let valid = false;
  try {
    valid = await bcrypt.compare(password, _config.passwordHash);
  } catch (_) {
    valid = false;
  }

  if (!valid) {
    const html = LOGIN_HTML.replace('{{ERROR}}', '<div class="error">Incorrect password.</div>');
    return res.status(401).send(html);
  }

  req.session.authenticated = true;
  req.session.save(err => {
    if (err) return res.status(500).send('Session error');
    res.redirect('/');
  });
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/auth/login');
  });
});

// ── Init ─────────────────────────────────────────────────────────────────────

function init(config) {
  _config = config;
}

module.exports = { init, middleware, router };
