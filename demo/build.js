/**
 * demo/build.js
 * Builds the static GitHub Pages demo site into demo/dist/.
 * Run via: node demo/build.js  (or npm run build:demo)
 *
 * Output structure:
 *   demo/dist/
 *     index.html          ← from demo/site/index.html (landing page)
 *     app/
 *       index.html        ← patched public/index.html
 *       css/              ← public/css/ verbatim
 *       js/               ← public/js/ + injected demo scripts
 *       assets/           ← public/assets/ verbatim
 *       vendor/           ← extracted from node_modules
 *         vs/             ← monaco-editor/min/vs/
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const ROOT        = path.resolve(__dirname, '..');
const DEMO_DIR    = path.resolve(__dirname);
const DIST        = path.join(DEMO_DIR, 'dist');
const DIST_APP    = path.join(DIST, 'app');
const PUBLIC      = path.join(ROOT, 'public');
const NODE_MOD    = path.join(ROOT, 'node_modules');
const SITE        = path.join(DEMO_DIR, 'site');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
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

function patchFile(filePath, replacements) {
  let content = fs.readFileSync(filePath, 'utf8');
  for (const [from, to] of replacements) {
    if (content.includes(from)) {
      content = content.split(from).join(to);
    } else {
      console.warn(`  [WARN] patch target not found: "${from}"`);
    }
  }
  fs.writeFileSync(filePath, content, 'utf8');
}

// ---------------------------------------------------------------------------
// Step 1 — Clean output
// ---------------------------------------------------------------------------
console.log('[build] Cleaning demo/dist/...');
rmrf(DIST);
ensureDir(DIST_APP);

// ---------------------------------------------------------------------------
// Step 2 — Copy public/ assets verbatim
// ---------------------------------------------------------------------------
console.log('[build] Copying public/css, public/js, public/assets...');
copyDir(path.join(PUBLIC, 'css'),    path.join(DIST_APP, 'css'));
copyDir(path.join(PUBLIC, 'js'),     path.join(DIST_APP, 'js'));
copyDir(path.join(PUBLIC, 'assets'), path.join(DIST_APP, 'assets'));

// ---------------------------------------------------------------------------
// Step 3 — Extract vendor files from node_modules
// ---------------------------------------------------------------------------
console.log('[build] Extracting vendor files from node_modules...');
const VENDOR = path.join(DIST_APP, 'vendor');
ensureDir(VENDOR);

const vendorCopies = [
  ['@xterm/xterm/lib/xterm.js',                      'xterm.js'],
  ['@xterm/xterm/css/xterm.css',                     'xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js',               'addon-fit.js'],
  ['@xterm/addon-web-links/lib/addon-web-links.js',   'addon-web-links.js'],
  ['jquery/dist/jquery.min.js',                       'jquery.min.js'],
  ['markdown-it/dist/markdown-it.min.js',             'markdown-it.min.js'],
];

for (const [src, dest] of vendorCopies) {
  const srcPath = path.join(NODE_MOD, src);
  const destPath = path.join(VENDOR, dest);
  if (fs.existsSync(srcPath)) {
    copyFile(srcPath, destPath);
  } else {
    console.warn(`  [WARN] vendor source not found: ${srcPath}`);
  }
}

// Monaco: copy entire min/vs/ tree (~5MB)
const monacoSrc  = path.join(NODE_MOD, 'monaco-editor', 'min', 'vs');
const monacoDest = path.join(VENDOR, 'vs');
if (fs.existsSync(monacoSrc)) {
  console.log('[build] Copying monaco-editor/min/vs/ (may take a moment)...');
  copyDir(monacoSrc, monacoDest);
} else {
  console.warn('  [WARN] monaco-editor not found in node_modules');
}

// ---------------------------------------------------------------------------
// Step 4 — Patch notes.js monaco require.config path
// ---------------------------------------------------------------------------
console.log('[build] Patching js/modules/notes.js monaco path...');
const notesJsDest = path.join(DIST_APP, 'js', 'modules', 'notes.js');
if (fs.existsSync(notesJsDest)) {
  patchFile(notesJsDest, [
    // AMD require.config paths are resolved relative to the PAGE URL (/app/),
    // not the module file — so 'vendor/vs' is correct (not '../../vendor/vs').
    [`'../node_modules/monaco-editor/min/vs'`, `'vendor/vs'`],
    [`"../node_modules/monaco-editor/min/vs"`, `"vendor/vs"`],
  ]);
} else {
  console.warn('  [WARN] js/modules/notes.js not found — skipping monaco patch');
}

// ---------------------------------------------------------------------------
// Step 5 — Generate vfs-data.js from actual source tree
// ---------------------------------------------------------------------------
console.log('[build] Generating vfs-data.js from source tree...');

// Parse .gitignore for additional hard-coded-name exclusions.
// We only handle the simple "name/" and ".name/" patterns that appear in this
// repo's .gitignore (no glob, no negation needed for the VFS use-case).
function loadGitignoreNames(repoRoot) {
  const gitignorePath = path.join(repoRoot, '.gitignore');
  const names = new Set();
  if (!fs.existsSync(gitignorePath)) return names;
  for (const raw of fs.readFileSync(gitignorePath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // Strip leading/trailing slashes and glob stars — keep bare names only
    const name = line.replace(/^\//, '').replace(/\/$/, '').trim();
    // Skip patterns with wildcards or path separators (too complex for simple matching)
    if (name && !name.includes('*') && !name.includes('/')) {
      names.add(name);
    }
  }
  return names;
}

const GITIGNORE_NAMES = loadGitignoreNames(ROOT);

const VFS_EXCLUDES = new Set([
  'node_modules', '.git', 'dist', 'coverage', 'private',
  ...GITIGNORE_NAMES,
]);
const VFS_EXCLUDE_EXTS = new Set(['.sqlite', '.sqlite-shm', '.sqlite-wal']);

let inodeCounter = 0;
const vfsNodes = {};

function buildVfs(absPath, virtualPath) {
  const stat = fs.statSync(absPath);
  const isDir = stat.isDirectory();
  const ext   = path.extname(absPath).toLowerCase();

  if (!isDir && VFS_EXCLUDE_EXTS.has(ext)) return;

  inodeCounter++;
  vfsNodes[virtualPath] = {
    isDirectory:  isDir,
    size:         isDir ? 0 : stat.size,
    dateModified: stat.mtimeMs,
    dateCreated:  stat.birthtimeMs,
    inode:        String(inodeCounter),
  };

  if (isDir) {
    let children;
    try {
      children = fs.readdirSync(absPath, { withFileTypes: true });
    } catch {
      return; // skip unreadable dirs
    }
    for (const child of children) {
      if (VFS_EXCLUDES.has(child.name)) continue;
      // skip demo/dist to avoid recursing into our own output
      if (virtualPath === '/AtlasExplorer' && child.name === 'demo') {
        // still include demo/ folder itself and its source files, just not dist/
        const childVirtual = virtualPath + '/' + child.name;
        const childAbs     = path.join(absPath, child.name);
        buildVfsDemoFolder(childAbs, childVirtual);
        continue;
      }
      buildVfs(
        path.join(absPath, child.name),
        virtualPath + '/' + child.name,
      );
    }
  }
}

// Special handler for demo/ — include source files, exclude dist/
function buildVfsDemoFolder(absPath, virtualPath) {
  inodeCounter++;
  const stat = fs.statSync(absPath);
  vfsNodes[virtualPath] = {
    isDirectory:  true,
    size:         0,
    dateModified: stat.mtimeMs,
    dateCreated:  stat.birthtimeMs,
    inode:        String(inodeCounter),
  };
  let children;
  try {
    children = fs.readdirSync(absPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const child of children) {
    if (child.name === 'dist') continue; // exclude build output
    buildVfs(
      path.join(absPath, child.name),
      virtualPath + '/' + child.name,
    );
  }
}

buildVfs(ROOT, '/AtlasExplorer');

const vfsJs = `// Auto-generated by demo/build.js — do not edit manually.\nwindow.vfsData = ${JSON.stringify(vfsNodes, null, 2)};\n`;
fs.writeFileSync(path.join(DIST_APP, 'js', 'vfs-data.js'), vfsJs, 'utf8');
console.log(`  Generated ${Object.keys(vfsNodes).length} VFS nodes.`);

// ---------------------------------------------------------------------------
// Step 6 — Copy demo source scripts into dist/app/js/
// ---------------------------------------------------------------------------
console.log('[build] Copying demo scripts...');
for (const name of ['demo-api.js', 'db-seed.js']) {
  const src = path.join(DEMO_DIR, name);
  if (fs.existsSync(src)) {
    copyFile(src, path.join(DIST_APP, 'js', name));
  } else {
    console.warn(`  [WARN] demo/${name} not found`);
  }
}

// ---------------------------------------------------------------------------
// Step 7 — Patch public/index.html and write to dist/app/index.html
// ---------------------------------------------------------------------------
console.log('[build] Patching index.html...');
let indexHtml = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

// Replace node_modules paths with vendor/ paths
const htmlPatches = [
  [`../node_modules/@xterm/xterm/css/xterm.css`,                     `vendor/xterm.css`],
  [`../node_modules/@xterm/xterm/lib/xterm.js`,                      `vendor/xterm.js`],
  [`../node_modules/@xterm/addon-fit/lib/addon-fit.js`,               `vendor/addon-fit.js`],
  [`../node_modules/@xterm/addon-web-links/lib/addon-web-links.js`,   `vendor/addon-web-links.js`],
  [`../node_modules/monaco-editor/min/vs/loader.js`,                  `vendor/vs/loader.js`],
  [`../node_modules/jquery/dist/jquery.min.js`,                       `vendor/jquery.min.js`],
];

for (const [from, to] of htmlPatches) {
  if (indexHtml.includes(from)) {
    indexHtml = indexHtml.split(from).join(to);
  } else {
    console.warn(`  [WARN] HTML patch target not found: "${from}"`);
  }
}

// Add markdown-it vendor tag alongside jquery
indexHtml = indexHtml.replace(
  `<script src="vendor/jquery.min.js"></script>`,
  `<script src="vendor/jquery.min.js"></script>\n  <script src="vendor/markdown-it.min.js"></script>`,
);

// Inject demo scripts immediately before the renderer module script.
// Plain <script> tags run synchronously, so window.electronAPI is set
// before the deferred type="module" renderer.js executes.
const RENDERER_TAG = `<script type="module" src="js/renderer.js"></script>`;
const INJECT = [
  `<script src="js/vfs-data.js"></script>`,
  `<script src="js/db-seed.js"></script>`,
  `<script src="js/demo-api.js"></script>`,
  RENDERER_TAG,
].join('\n  ');

if (indexHtml.includes(RENDERER_TAG)) {
  indexHtml = indexHtml.replace(RENDERER_TAG, INJECT);
} else {
  console.warn('  [WARN] renderer.js script tag not found — demo scripts not injected');
}

// Inject a blank SVG favicon to suppress the browser's default favicon.ico 404.
// demo-api.js will later replace this href dynamically when panel 1 navigates.
const FAVICON_TAG = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'/%3E">`;
indexHtml = indexHtml.replace('</head>', `  ${FAVICON_TAG}\n</head>`);

fs.writeFileSync(path.join(DIST_APP, 'index.html'), indexHtml, 'utf8');

// ---------------------------------------------------------------------------
// Step 8 — Copy landing page from demo/site/
// ---------------------------------------------------------------------------
console.log('[build] Copying landing page...');
if (fs.existsSync(SITE)) {
  copyDir(SITE, DIST);
} else {
  console.warn('  [WARN] demo/site/ not found — no landing page copied');
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------
console.log('[build] Done. Output: demo/dist/');
