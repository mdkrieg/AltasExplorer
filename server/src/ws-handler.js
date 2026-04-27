'use strict';

/**
 * server/src/ws-handler.js
 *
 * Attaches a WebSocket server to the raw http.Server (not Express).
 * Handles two concerns:
 *   1. Terminal sessions (node-pty) — bidirectional streaming
 *   2. Push events (server → all clients) — todo/reminder/alert/dir-change notifications
 *
 * Message format (both directions): JSON { type: string, ...payload }
 *
 * Client → Server types:
 *   terminal:create  { cwd }
 *   terminal:input   { id, data }
 *   terminal:resize  { id, cols, rows }
 *   terminal:destroy { id }
 *
 * Server → Client types:
 *   terminal:output  { id, data }
 *   terminal:exit    { id, code }
 *   push:todoAggregatesChanged
 *   push:reminderAggregatesChanged
 *   push:alertCountUpdated    { count }
 *   push:directoryChanged     { dirPath }
 *   push:setWindowTitle       { title }
 *   error                     { message }
 */

const { WebSocketServer } = require('ws');
const cookie  = require('cookie');

let _config     = null;
let _wss        = null;

// Active PTY sessions keyed by { wsClient => Map<id, ptyProcess> }
const clientPtys = new WeakMap();
let   ptyIdCounter = 0;

// ── Session cookie validation ─────────────────────────────────────────────────
// We need to verify the session before accepting a WS upgrade.
// express-session stores the session ID in a signed cookie; we parse it here.

function getSessionFromRequest(req, sessionMiddleware) {
  return new Promise((resolve) => {
    // Create a fake response object — express-session only needs req/res/next
    const fakeRes = {
      getHeader: () => {},
      setHeader: () => {},
      end: () => {},
    };
    sessionMiddleware(req, fakeRes, () => {
      resolve(req.session);
    });
  });
}

// ── PTY helpers ───────────────────────────────────────────────────────────────

function createPty(ws, cwd) {
  let pty;
  try {
    pty = require('node-pty');
  } catch {
    send(ws, { type: 'error', message: 'node-pty is not available' });
    return null;
  }

  const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || 'bash');
  const id    = String(++ptyIdCounter);

  const proc = pty.spawn(shell, [], {
    name:  'xterm-256color',
    cols:  80,
    rows:  24,
    cwd:   cwd || process.env.HOME || '/',
    env:   process.env,
  });

  proc.onData(data => {
    send(ws, { type: 'terminal:output', id, data });
  });

  proc.onExit(({ exitCode }) => {
    send(ws, { type: 'terminal:exit', id, code: exitCode });
    const ptys = clientPtys.get(ws);
    if (ptys) ptys.delete(id);
  });

  if (!clientPtys.has(ws)) clientPtys.set(ws, new Map());
  clientPtys.get(ws).set(id, proc);

  return id;
}

function destroyClientPtys(ws) {
  const ptys = clientPtys.get(ws);
  if (!ptys) return;
  for (const [, proc] of ptys) {
    try { proc.kill(); } catch { /* ignore */ }
  }
  ptys.clear();
}

// ── Message helpers ───────────────────────────────────────────────────────────

function send(ws, obj) {
  try {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  } catch { /* ignore closed socket */ }
}

function broadcast(type, payload = {}) {
  if (!_wss) return;
  const msg = JSON.stringify({ type, ...payload });
  for (const client of _wss.clients) {
    if (client.readyState === client.OPEN) {
      try { client.send(msg); } catch { /* ignore */ }
    }
  }
}

// ── Message dispatcher ────────────────────────────────────────────────────────

function handleMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    send(ws, { type: 'error', message: 'Invalid JSON' });
    return;
  }

  const { type, id, data, cwd, cols, rows } = msg;
  const ptys = clientPtys.get(ws) || new Map();

  switch (type) {
    case 'terminal:create': {
      const newId = createPty(ws, cwd);
      if (newId) send(ws, { type: 'terminal:created', id: newId });
      break;
    }
    case 'terminal:input': {
      const proc = ptys.get(id);
      if (proc) proc.write(data);
      break;
    }
    case 'terminal:resize': {
      const proc = ptys.get(id);
      if (proc) proc.resize(Number(cols) || 80, Number(rows) || 24);
      break;
    }
    case 'terminal:destroy': {
      const proc = ptys.get(id);
      if (proc) {
        try { proc.kill(); } catch { /* ignore */ }
        ptys.delete(id);
      }
      break;
    }
    default:
      send(ws, { type: 'error', message: `Unknown message type: ${type}` });
  }
}

// ── Attach ────────────────────────────────────────────────────────────────────

function attach(httpServer, config) {
  _config = config;

  _wss = new WebSocketServer({ noServer: true });

  // The session middleware needs to be re-created here for WS auth.
  // We reconstruct it from config for consistency with server.js.
  const session      = require('express-session');
  const cookieParser = require('cookie-parser');

  const sessionMiddleware = session({
    secret:            config.sessionSecret,
    resave:            false,
    saveUninitialized: false,
  });

  httpServer.on('upgrade', async (req, socket, head) => {
    // Only handle /ws
    if (req.url !== '/ws') {
      socket.destroy();
      return;
    }

    // Populate req.session via the session middleware
    const sess = await getSessionFromRequest(req, sessionMiddleware);

    // Check bearer token as fallback
    let authenticated = !!(sess && sess.authenticated);
    if (!authenticated && config.allowBearerToken && config.bearerToken) {
      const cookies = cookie.parse(req.headers.cookie || '');
      const authHeader = req.headers.authorization || '';
      if (authHeader.startsWith('Bearer ') && authHeader.slice(7) === config.bearerToken) {
        authenticated = true;
      }
    }

    if (!authenticated) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    _wss.handleUpgrade(req, socket, head, (ws) => {
      _wss.emit('connection', ws, req);
    });
  });

  _wss.on('connection', (ws) => {
    ws.on('message', (raw) => handleMessage(ws, raw.toString()));
    ws.on('close', () => destroyClientPtys(ws));
    ws.on('error', () => destroyClientPtys(ws));
  });
}

// ── Public push API (called from api-router.js when state changes) ────────────

module.exports = {
  attach,
  broadcast,
  pushTodoAggregatesChanged:    () => broadcast('push:todoAggregatesChanged'),
  pushReminderAggregatesChanged: () => broadcast('push:reminderAggregatesChanged'),
  pushAlertCountUpdated:        (count) => broadcast('push:alertCountUpdated', { count }),
  pushDirectoryChanged:         (dirPath) => broadcast('push:directoryChanged', { dirPath }),
  pushSetWindowTitle:           (title) => broadcast('push:setWindowTitle', { title }),
};
