'use strict';

/**
 * server/src/file-serve.js
 *
 * Serves actual filesystem files to the browser for:
 *   GET  /files/content?path=<encoded>  — raw file content (notes editor)
 *   GET  /files/preview?path=<encoded>  — file with correct Content-Type (image/pdf/video preview)
 *   POST /files/upload?dir=<encoded>    — multipart file upload (replaces OS drag-in)
 *
 * All routes path-jail every input before touching the filesystem.
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { jail, JailError } = require('./path-jail');

let _config = null;

function init(config) {
  _config = config;
}

// ── MIME type map (for preview) ───────────────────────────────────────────────

const MIME = {
  // Images
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.bmp':  'image/bmp',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  // Video
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.mov':  'video/quicktime',
  '.mkv':  'video/x-matroska',
  '.avi':  'video/x-msvideo',
  // Audio
  '.mp3':  'audio/mpeg',
  '.ogg':  'audio/ogg',
  '.wav':  'audio/wav',
  '.flac': 'audio/flac',
  // Documents
  '.pdf':  'application/pdf',
  // Text
  '.txt':  'text/plain',
  '.md':   'text/plain',
  '.json': 'application/json',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.html': 'text/html',
  '.xml':  'text/xml',
  '.csv':  'text/csv',
};

function getMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

// ── Router ────────────────────────────────────────────────────────────────────

const router = express.Router();

// GET /files/content?path=<encoded>
// Returns raw file content as text/plain. Used by the notes editor.
router.get('/content', (req, res) => {
  const rawPath = req.query.path;
  if (!rawPath) return res.status(400).json({ error: 'path query parameter required' });

  let safePath;
  try {
    safePath = jail(rawPath, _config, true);
  } catch (err) {
    return res.status(err.statusCode || 403).json({ error: err.message });
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.sendFile(safePath);
});

// GET /files/preview?path=<encoded>
// Serves a file with the correct Content-Type for in-browser preview.
// Includes Range support (required for video seek).
router.get('/preview', (req, res) => {
  const rawPath = req.query.path;
  if (!rawPath) return res.status(400).json({ error: 'path query parameter required' });

  let safePath;
  try {
    safePath = jail(rawPath, _config, true);
  } catch (err) {
    return res.status(err.statusCode || 403).json({ error: err.message });
  }

  const mime = getMime(safePath);
  res.setHeader('Content-Type', mime);
  // Allow video seek
  res.setHeader('Accept-Ranges', 'bytes');
  res.sendFile(safePath);
});

// POST /files/upload?dir=<encoded>
// Accepts a multipart/form-data upload and writes file(s) into the target directory.
// Replaces OS drag-in which is not available in a browser context.
// NOTE: This stub returns 501 until a multipart parser (e.g. multer) is wired up in Phase 2.
router.post('/upload', (req, res) => {
  const rawDir = req.query.dir;
  if (!rawDir) return res.status(400).json({ error: 'dir query parameter required' });

  let safeDir;
  try {
    safeDir = jail(rawDir, _config);
  } catch (err) {
    return res.status(err.statusCode || 403).json({ error: err.message });
  }

  // Phase 2: wire up multer here
  // const upload = multer({ dest: safeDir });
  return res.status(501).json({ error: 'File upload not yet implemented (Phase 2)' });
});

module.exports = { init, router };
