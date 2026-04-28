#!/usr/bin/env node
'use strict';

/**
 * server/build.js
 *
 * Produces server/dist/app/ — a fully self-contained web root for the
 * AtlasExplorer HTTP server.
 *
 * Steps:
 *   1.  Clean server/dist/
 *   2.  Copy public/{css,js,assets} → dist/app/{css,js,assets}
 *   3.  Copy vendor JS from node_modules → dist/app/js/vendor/
 *       (xterm.js, xterm addons, monaco-editor, jquery)
 *   4.  Patch notes.js: fix Monaco require.config path → /js/vendor/monaco/vs
 *   5.  Read public/index.html and patch:
 *         a. Replace node_modules/* paths with /js/vendor/* equivalents
 *         b. Inject <script src="/js/client-api.js"></script> before renderer.js
 *         c. Inject <script src="/js/thumbnail-renderer.js"></script> before renderer.js
 *         d. Add contextmenu prevention (already in client-api.js IIFE, nothing extra needed)
 *       Write patched HTML to dist/app/index.html
 *   6.  Append  `window.__atlasPanelState = panelState;`  to dist/app/js/renderer.js
 *       (panelState is a named export in renderer.js; this re-exports it to window
 *        so the thumbnail-renderer.js plain <script> can read it)
 *   7.  Copy server/client-api.js           → dist/app/js/client-api.js
 *   8.  Copy server/thumbnail-renderer.js   → dist/app/js/thumbnail-renderer.js
 *
 * Usage:  node server/build.js
 */

const fs   = require('fs');
const path = require('path');

const ROOT     = path.resolve(__dirname, '..');
const SERVER   = __dirname;
const DIST     = path.join(SERVER, 'dist', 'app');
const PUBLIC   = path.join(ROOT, 'public');
const NMODS    = path.join(ROOT, 'node_modules');

// ── Utilities ─────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`  [skip] ${src} does not exist`);
    return;
  }
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      copyFile(s, d);
    }
  }
}

function cleanDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  ensureDir(dir);
}

// ── Step 1: Clean ─────────────────────────────────────────────────────────────

console.log('[build] Cleaning dist/...');
cleanDir(DIST);

// ── Step 2: Copy public/ → dist/app/ ─────────────────────────────────────────

console.log('[build] Copying public/css ...');
copyDir(path.join(PUBLIC, 'css'),    path.join(DIST, 'css'));

console.log('[build] Copying public/js ...');
copyDir(path.join(PUBLIC, 'js'),     path.join(DIST, 'js'));

console.log('[build] Copying public/assets ...');
copyDir(path.join(PUBLIC, 'assets'), path.join(DIST, 'assets'));

// ── Step 3: Copy vendor JS from node_modules ──────────────────────────────────
// These packages live in the ROOT node_modules (not server/node_modules).
// On a Raspberry Pi / headless server you still need to run:
//   npm install --ignore-scripts
// once from the repo root so the vendor files are available for the build.
// (--ignore-scripts skips the Electron native-module rebuild.)

if (!fs.existsSync(NMODS)) {
  console.error(
    '\n[build] ERROR: root node_modules/ not found.\n' +
    '  Vendor JS/CSS (xterm, monaco, jquery) are copied from the root\n' +
    '  node_modules during the build. Run this once from the repo root:\n\n' +
    '    npm install --ignore-scripts\n\n' +
    '  Then re-run:  node server/build.js\n'
  );
  process.exit(1);
}

console.log('[build] Copying vendor libs...');

const VENDOR_JS = path.join(DIST, 'js', 'vendor');
ensureDir(VENDOR_JS);

// Helper: copy a vendor file only if the source exists; skip with a warning otherwise.
function copyVendorFile(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`  [warn] vendor file not found, skipping: ${src}`);
    return;
  }
  copyFile(src, dest);
}

// xterm.js core
const XTERM = path.join(NMODS, '@xterm', 'xterm');
// The CSS may live at css/xterm.css or directly at xterm.css depending on package version.
const xtermCssCandidates = [
  path.join(XTERM, 'css', 'xterm.css'),
  path.join(XTERM, 'xterm.css'),
];
const xtermCssSrc = xtermCssCandidates.find(p => fs.existsSync(p));
if (xtermCssSrc) {
  copyFile(xtermCssSrc, path.join(DIST, 'css', 'vendor', 'xterm.css'));
} else {
  console.warn(`  [warn] @xterm/xterm CSS not found (tried: ${xtermCssCandidates.join(', ')})`);
}
copyVendorFile(path.join(XTERM, 'lib', 'xterm.js'), path.join(VENDOR_JS, 'xterm.js'));

// xterm addons
copyVendorFile(
  path.join(NMODS, '@xterm', 'addon-fit',      'lib', 'addon-fit.js'),
  path.join(VENDOR_JS, 'addon-fit.js')
);
copyVendorFile(
  path.join(NMODS, '@xterm', 'addon-web-links', 'lib', 'addon-web-links.js'),
  path.join(VENDOR_JS, 'addon-web-links.js')
);

// jQuery
copyVendorFile(
  path.join(NMODS, 'jquery', 'dist', 'jquery.min.js'),
  path.join(VENDOR_JS, 'jquery.min.js')
);

// Monaco Editor — copy the whole min/ directory (it's large but self-referencing)
const monacoSrc = path.join(NMODS, 'monaco-editor', 'min');
if (!fs.existsSync(monacoSrc)) {
  console.warn('  [warn] monaco-editor not found in root node_modules, skipping');
} else {
  console.log('[build] Copying monaco-editor (this may take a moment)...');
  copyDir(monacoSrc, path.join(VENDOR_JS, 'monaco', 'min'));
}

// ── Step 4: Patch notes.js Monaco path ───────────────────────────────────────

console.log('[build] Patching notes.js monaco path...');
const notesJsPath = path.join(DIST, 'js', 'modules', 'notes.js');
if (fs.existsSync(notesJsPath)) {
  let notesJs = fs.readFileSync(notesJsPath, 'utf8');
  notesJs = notesJs.replace(
    /['"]\.\.\/node_modules\/monaco-editor\/min\/vs['"]/g,
    "'/js/vendor/monaco/min/vs'"
  );
  fs.writeFileSync(notesJsPath, notesJs, 'utf8');
} else {
  console.warn('  [warn] notes.js not found, skipping Monaco path patch');
}

// ── Step 5: Patch index.html ──────────────────────────────────────────────────

console.log('[build] Patching index.html...');
let html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

// 5a. Replace node_modules/* vendor paths with /js/vendor/* or /css/vendor/*

// xterm CSS
html = html.replace(
  /<link[^>]+@xterm\/xterm\/css\/xterm\.css[^>]*>/g,
  '<link rel="stylesheet" type="text/css" href="/css/vendor/xterm.css">'
);

// xterm scripts
html = html.replace(
  /<script[^>]+@xterm\/xterm\/lib\/xterm\.js[^>]*><\/script>/g,
  '<script src="/js/vendor/xterm.js"></script>'
);
html = html.replace(
  /<script[^>]+@xterm\/addon-fit\/lib\/addon-fit\.js[^>]*><\/script>/g,
  '<script src="/js/vendor/addon-fit.js"></script>'
);
html = html.replace(
  /<script[^>]+@xterm\/addon-web-links\/lib\/addon-web-links\.js[^>]*><\/script>/g,
  '<script src="/js/vendor/addon-web-links.js"></script>'
);

// Monaco loader
html = html.replace(
  /<script[^>]+monaco-editor\/min\/vs\/loader\.js[^>]*><\/script>/g,
  '<script src="/js/vendor/monaco/min/vs/loader.js"></script>'
);

// jQuery
html = html.replace(
  /<script[^>]+jquery\/dist\/jquery\.min\.js[^>]*><\/script>/g,
  '<script src="/js/vendor/jquery.min.js"></script>'
);

// 5b. Inject client-api.js and thumbnail-renderer.js immediately before renderer.js
const RENDERER_TAG = '<script type="module" src="js/renderer.js"></script>';
const RENDERER_REPLACEMENT =
  '<script src="/js/client-api.js"></script>\n' +
  '  <script src="/js/thumbnail-renderer.js"></script>\n' +
  '  <script type="module" src="/js/renderer.js"></script>';

html = html.replace(RENDERER_TAG, RENDERER_REPLACEMENT);

// 5c. Make all remaining relative asset paths absolute (src="js/ → src="/js/  etc.)
//     The renderer.js module import already uses ES modules; other paths like css/styles.css
//     are fine as-is because Express serves them from /.
//     Fix css/styles.css and css/vendor/w2ui.min.css to be absolute:
html = html.replace(/href="css\//g, 'href="/css/');
html = html.replace(/src="js\//g, 'src="/js/');

fs.writeFileSync(path.join(DIST, 'index.html'), html, 'utf8');

// ── Step 6: Append panelState window bridge to renderer.js ───────────────────

console.log('[build] Appending window.__atlasPanelState bridge to renderer.js...');
const rendererPath = path.join(DIST, 'js', 'renderer.js');
if (fs.existsSync(rendererPath)) {
  const bridge = `\n\n// ── server/build.js injection ──────────────────────────────────────────────────
// Expose panelState to plain <script> tags (thumbnail-renderer.js).
// panelState is an ES module export; we re-export it via window here.
import { panelState } from '/js/renderer.js';
// Wrap in a live setter so thumbnail-renderer.js always reads the current reference.
Object.defineProperty(window, '__atlasPanelState', {
  get() { return panelState; },
  configurable: true,
});
`;
  // Actually, renderer.js IS the module; we can't import itself.
  // Instead, append a direct assignment at the bottom of renderer.js (which IS the module).
  const simpleExpose = `\n\n// Expose panelState to window for server thumbnail-renderer.js\nwindow.__atlasPanelState = panelState;\n`;
  fs.appendFileSync(rendererPath, simpleExpose, 'utf8');
} else {
  console.warn('  [warn] renderer.js not found in dist — skipping panelState bridge');
}

// ── Step 7+8: Copy server-side client scripts ─────────────────────────────────

console.log('[build] Copying client-api.js and thumbnail-renderer.js...');
copyFile(path.join(SERVER, 'client-api.js'),         path.join(DIST, 'js', 'client-api.js'));
copyFile(path.join(SERVER, 'thumbnail-renderer.js'), path.join(DIST, 'js', 'thumbnail-renderer.js'));

// ── Done ──────────────────────────────────────────────────────────────────────

console.log('[build] Done. Output: server/dist/app/');
