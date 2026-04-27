/**
 * demo/demo-api.js
 * Browser polyfill for window.electronAPI.
 *
 * Loaded as a plain <script> (not a module) so it runs synchronously before
 * the type="module" renderer.js, satisfying the guard at renderer.js line ~157.
 *
 * Depends on:
 *   window.vfsData  — set by vfs-data.js (auto-generated at build time)
 *   window.demoSeed — set by db-seed.js
 *
 * State is persisted to sessionStorage so it survives in-tab navigation
 * but resets when the tab is closed.
 */

(function () {
  'use strict';

  // ──────────────────────────────────────────────────────────────────────────
  // State persistence helpers
  // ──────────────────────────────────────────────────────────────────────────
  const STORAGE_KEY_STATE = 'atlas-demo-state';
  const STORAGE_KEY_VFS   = 'atlas-demo-vfs';

  function saveState() {
    try {
      sessionStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(demoState));
    } catch (_) {}
  }

  function saveVfs() {
    try {
      sessionStorage.setItem(STORAGE_KEY_VFS, JSON.stringify(demoVfs));
    } catch (_) {}
  }

  function loadStoredState() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY_STATE);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  function loadStoredVfs() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY_VFS);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Boot: initialise mutable VFS from sessionStorage or window.vfsData seed
  // ──────────────────────────────────────────────────────────────────────────
  let demoVfs = loadStoredVfs() || (window.vfsData ? JSON.parse(JSON.stringify(window.vfsData)) : {});

  // ──────────────────────────────────────────────────────────────────────────
  // Boot: initialise demoState from sessionStorage or demoSeed defaults
  // ──────────────────────────────────────────────────────────────────────────
  const seed = window.demoSeed || {};

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  let demoState = loadStoredState() || {
    settings:    deepClone(seed.settings   || {}),
    hotkeys:     deepClone(seed.hotkeys    || {}),
    favorites:   deepClone(seed.favorites  || []),
    categories:  deepClone(seed.categories || {}),
    tags:        deepClone(seed.tags       || {}),
    fileTypes:   deepClone(seed.fileTypes  || []),
    attributes:  deepClone(seed.attributes || {}),
    autoLabels:  [],
    gridLayouts: {},
    // dirs: dirPath → { id, category, category_force, initials, labels, tags }
    dirs:        deepClone(buildInitialDirs()),
    // files: `${inode}:${dir_id}` → { inode, dir_id, filename, dateModified, size, checksumValue, checksumStatus }
    files:       {},
    // tags applied to items: `${inode}:${dir_id}` → [tagName, ...]
    itemTags:    deepClone(seed.preAppliedTagsByKey || {}),
    // dir tags: dirPath → [tagName, ...]
    dirTags:     {},
    // notes content: path → string
    notesContent: deepClone(seed.notesContent || {}),
    // file history
    fileHistory: deepClone(seed.fileHistory || []),
    nextHistoryId: (seed.fileHistory || []).length + 1,
    nextDirId: 100,
    nextInodeCounter: 10000,
  };

  // Pre-apply item tags from seed.preAppliedTags (path-keyed)
  // We can't know dir_id at seed time, so we convert on first scan encounter
  // via a side table keyed by path.
  const pendingPathTags = deepClone(seed.preAppliedTags || {});

  function buildInitialDirs() {
    const result = {};
    let idCounter = 1;
    const assignments = seed.dirAssignments || {};
    // Create entries for every assignment
    for (const [dirPath, assignment] of Object.entries(assignments)) {
      result[dirPath] = {
        id: idCounter++,
        dirname: dirPath,
        inode: String(idCounter * 10),
        category: assignment.category,
        category_force: assignment.category_force ? 1 : 0,
        initials: null,
        labels: [],
        tags: [],
        display_name: null,
      };
    }
    return result;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // VFS helpers
  // ──────────────────────────────────────────────────────────────────────────
  function vfsNormalize(p) {
    // Normalise path separators to forward slash, remove trailing slash
    return p.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  }

  function vfsParent(p) {
    const norm = vfsNormalize(p);
    const idx = norm.lastIndexOf('/');
    if (idx <= 0) return '/';
    return norm.slice(0, idx);
  }

  function vfsBasename(p) {
    const norm = vfsNormalize(p);
    return norm.slice(norm.lastIndexOf('/') + 1);
  }

  function vfsChildren(dirPath) {
    const norm = vfsNormalize(dirPath) + '/';
    return Object.keys(demoVfs).filter(k => {
      if (!k.startsWith(norm)) return false;
      const rest = k.slice(norm.length);
      return rest.length > 0 && !rest.includes('/');
    });
  }

  function vfsToEntry(virtualPath) {
    const node = demoVfs[virtualPath];
    if (!node) return null;
    return {
      inode:       node.inode,
      filename:    vfsBasename(virtualPath),
      isDirectory: node.isDirectory,
      size:        node.size,
      dateModified: node.dateModified,
      dateCreated:  node.dateCreated,
      path:        virtualPath,
      mode:        null,
      perms:       { read: true, write: true },
      permError:   false,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Dir record helpers
  // ──────────────────────────────────────────────────────────────────────────
  function ensureDir(dirPath) {
    const norm = vfsNormalize(dirPath);
    if (!demoState.dirs[norm]) {
      const category = resolveCategory(norm);
      demoState.dirs[norm] = {
        id: demoState.nextDirId++,
        dirname: norm,
        inode: String(demoState.nextInodeCounter++),
        category: category,
        category_force: 0,
        initials: null,
        labels: [],
        tags: [],
        display_name: null,
      };
      saveState();
    }
    return demoState.dirs[norm];
  }

  function resolveCategory(dirPath) {
    const norm = vfsNormalize(dirPath);
    const dir = demoState.dirs[norm];
    if (dir && dir.category_force) return dir.category;
    // Pattern match against category patterns
    const basename = vfsBasename(norm);
    for (const [, cat] of Object.entries(demoState.categories)) {
      if (!cat.patterns || !cat.patterns.length) continue;
      for (const pattern of cat.patterns) {
        if (globMatch(basename, pattern)) return cat.name;
      }
    }
    return (dir && dir.category) ? dir.category : 'Default';
  }

  function globMatch(filename, pattern) {
    const re = '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
    return new RegExp(re, 'i').test(filename);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Event listener registries
  // ──────────────────────────────────────────────────────────────────────────
  const listeners = {
    terminalOutput:      [],
    terminalExit:        [],
    directoryChanged:    [],
    alertCountUpdated:   [],
    loadLayoutFromFile:  [],
    updateAvailable:     [],
    updateNotAvailable:  [],
    updateDownloadProgress: [],
    updateDownloaded:    [],
    updateError:         [],
    closeRequest:        [],
  };

  function emit(event, data) {
    (listeners[event] || []).forEach(cb => { try { cb(data); } catch (_) {} });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Canvas-based icon generation (PNG output — matches Electron native output,
  // works reliably in CSS background-image and <img src>)
  // ──────────────────────────────────────────────────────────────────────────

  // SVG path data inlined from public/assets/icons/folder.svg (viewBox 0 0 48 48)
  const FOLDER_SVG_PATH = 'M 39.20826,11.000022 H 25.44 L 24.8,7.7917619 C 23.949617,5.3864543 21.671188,4.9901874 19.12,5.0000223 H 8.7917396 C 5.4780312,5.0000223 4,6.4780532 4,9.7917616 V 38.208282 c 0,3.313708 1.4780311,4.79174 4.7917396,4.79174 H 39.20826 C 42.521968,43.000022 44,41.52199 44,38.208282 v -22.41652 c 0,-3.313708 -1.478032,-4.79174 -4.79174,-4.79174';

  function parseRgbToHex(colorStr) {
    if (!colorStr) return '#000000';
    const m = colorStr.match(/rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
    if (!m) return colorStr;
    return '#' + [m[1], m[2], m[3]].map(n => parseInt(n, 10).toString(16).padStart(2, '0')).join('');
  }

  function generateFolderIconDataUrl(bgColor, textColor, initials) {
    const SIZE = 24;
    const canvas = document.createElement('canvas');
    canvas.width  = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');

    const bg = parseRgbToHex(bgColor  || 'rgb(239,228,176)');
    const fg = parseRgbToHex(textColor || 'rgb(0,0,0)');

    // Scale SVG viewBox (48x48) → canvas (24x24)
    const scale = SIZE / 48;
    ctx.save();
    ctx.scale(scale, scale);
    const folderPath = new Path2D(FOLDER_SVG_PATH);
    ctx.fillStyle = bg;
    ctx.fill(folderPath);
    ctx.strokeStyle = fg;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke(folderPath);
    ctx.restore();

    // Overlay initials text in the lower body of the folder
    if (initials) {
      const label = initials.trim().slice(0, 2).toUpperCase();
      const fontSize = label.length > 1 ? 8 : 10;
      ctx.fillStyle = fg;
      ctx.font = `bold ${fontSize}px Verdana, sans-serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, SIZE / 2, SIZE * 0.66);
    }

    return canvas.toDataURL('image/png');
  }

  function generateTagIconDataUrl(bgColor, textColor) {
    const SIZE = 14;
    const canvas = document.createElement('canvas');
    canvas.width  = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = parseRgbToHex(bgColor || 'rgb(180,130,220)');
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 0.5, 0, Math.PI * 2);
    ctx.fill();
    return canvas.toDataURL('image/png');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Fake terminal (PTY emulation)
  // ──────────────────────────────────────────────────────────────────────────
  const ptyMap = new Map();
  let ptyIdCounter = 0;
  const RESET  = '\x1b[0m';
  const BOLD   = '\x1b[1m';
  const CYAN   = '\x1b[36m';
  const YELLOW = '\x1b[33m';
  const RED    = '\x1b[31m';
  const GREEN  = '\x1b[32m';
  const NL = '\r\n';

  function ptyWrite(id, text) {
    emit('terminalOutput', { id, data: text });
  }

  function ptyPrompt(session) {
    ptyWrite(session.id, `${GREEN}demo${RESET}:${CYAN}${session.cwd}${RESET}$ `);
  }

  function handleTerminalLine(session, line) {
    const trimmed = line.trim();
    if (!trimmed) { ptyPrompt(session); return; }

    const parts  = trimmed.split(/\s+/);
    const cmd    = parts[0].toLowerCase();
    const args   = parts.slice(1);

    switch (cmd) {
      case 'clear':
        ptyWrite(session.id, '\x1b[2J\x1b[H');
        ptyPrompt(session);
        break;

      case 'pwd':
        ptyWrite(session.id, session.cwd + NL);
        ptyPrompt(session);
        break;

      case 'echo':
        ptyWrite(session.id, args.join(' ') + NL);
        ptyPrompt(session);
        break;

      case 'cd': {
        const target = args[0] || '/AtlasExplorer';
        const resolved = target.startsWith('/')
          ? vfsNormalize(target)
          : vfsNormalize(session.cwd + '/' + target);
        if (demoVfs[resolved] && demoVfs[resolved].isDirectory) {
          session.cwd = resolved;
        } else if (target === '..') {
          session.cwd = vfsParent(session.cwd);
        } else {
          ptyWrite(session.id, `${RED}cd: ${target}: No such directory${RESET}${NL}`);
        }
        ptyPrompt(session);
        break;
      }

      case 'ls': {
        const target = args[0]
          ? (args[0].startsWith('/') ? vfsNormalize(args[0]) : vfsNormalize(session.cwd + '/' + args[0]))
          : session.cwd;
        const children = vfsChildren(target);
        if (!children.length && !demoVfs[target]) {
          ptyWrite(session.id, `${RED}ls: ${target}: No such directory${RESET}${NL}`);
        } else {
          const lines = children.map(c => {
            const node = demoVfs[c];
            const name = vfsBasename(c);
            return node.isDirectory ? `${BOLD}${CYAN}${name}/${RESET}` : name;
          });
          ptyWrite(session.id, lines.join('  ') + NL);
        }
        ptyPrompt(session);
        break;
      }

      case 'cat': {
        const target = args[0]
          ? (args[0].startsWith('/') ? vfsNormalize(args[0]) : vfsNormalize(session.cwd + '/' + args[0]))
          : null;
        if (!target) {
          ptyWrite(session.id, `${RED}cat: missing operand${RESET}${NL}`);
        } else if (!demoVfs[target] || demoVfs[target].isDirectory) {
          ptyWrite(session.id, `${RED}cat: ${args[0]}: No such file${RESET}${NL}`);
        } else {
          const content = demoState.notesContent[target];
          if (content) {
            ptyWrite(session.id, content.replace(/\n/g, NL) + NL);
          } else {
            ptyWrite(session.id, `${YELLOW}(binary or empty file — cat not supported in demo)${RESET}${NL}`);
          }
        }
        ptyPrompt(session);
        break;
      }

      case 'help':
        ptyWrite(session.id,
          `${BOLD}Available commands:${RESET}${NL}` +
          `  ${CYAN}ls [path]${RESET}     List directory contents${NL}` +
          `  ${CYAN}cd [path]${RESET}     Change directory (supports ..)${NL}` +
          `  ${CYAN}pwd${RESET}           Print working directory${NL}` +
          `  ${CYAN}cat [file]${RESET}    Print file contents (text files only)${NL}` +
          `  ${CYAN}echo [text]${RESET}   Print text${NL}` +
          `  ${CYAN}clear${RESET}         Clear the terminal${NL}` +
          `  ${CYAN}help${RESET}          Show this help${NL}` +
          `${YELLOW}Note: this is a demo terminal — only the commands above are available.${RESET}${NL}`,
        );
        ptyPrompt(session);
        break;

      default:
        ptyWrite(session.id, `${RED}${cmd}: command not found${RESET} ${YELLOW}(demo mode — try 'help')${RESET}${NL}`);
        ptyPrompt(session);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Markdown renderer (uses window.markdownit loaded from vendor/)
  // ──────────────────────────────────────────────────────────────────────────
  let _md = null;
  function getMarkdownit() {
    if (!_md) {
      if (window.markdownit) {
        _md = window.markdownit({ html: false, linkify: true, typographer: true });
      }
    }
    return _md;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Helper: wrap a value in a resolved Promise
  // ──────────────────────────────────────────────────────────────────────────
  function p(v) { return Promise.resolve(v); }

  // ──────────────────────────────────────────────────────────────────────────
  // The electronAPI polyfill
  // ──────────────────────────────────────────────────────────────────────────
  window.electronAPI = {

    // ── Filesystem: read operations ──────────────────────────────────────────

    readDirectory(dirPath) {
      const norm = vfsNormalize(dirPath);
      const children = vfsChildren(norm);
      return p(children.map(vfsToEntry).filter(Boolean));
    },

    getRootDrives() {
      return p([{ letter: '/AtlasExplorer', label: 'AtlasExplorer (Demo)', type: 'local' }]);
    },

    getParentDirectoryMetadata(dirPath) {
      const norm   = vfsNormalize(dirPath);
      const parent = vfsParent(norm);
      const node   = demoVfs[parent];
      if (!node) return p(null);
      return p({ path: parent, ...node });
    },

    isDirectory(dirPath) {
      const node = demoVfs[vfsNormalize(dirPath)];
      return p(!!(node && node.isDirectory));
    },

    getFilesInDirectory(dirPath) {
      const norm = vfsNormalize(dirPath);
      const children = vfsChildren(norm);
      return p(children.map(vfsToEntry).filter(e => e && !e.isDirectory));
    },

    getShortcutsInDirectory() { return p([]); },
    getBadgeCounts()          { return p({ success: true, orphanCount: 0, trashCount: 0 }); },
    getVirtualView()          { return p({ success: true, entries: [], orphanCount: 0, trashCount: 0, isVirtualView: true }); },

    // ── Filesystem: scan with comparison ─────────────────────────────────────

    scanDirectoryWithComparison(dirPath) {
      const norm    = vfsNormalize(dirPath);
      const dirNode = demoVfs[norm];
      if (!dirNode || !dirNode.isDirectory) {
        return p({ success: false, error: 'Not a directory: ' + norm });
      }

      const dir    = ensureDir(norm);
      const dirId  = dir.id;
      const catObj = demoState.categories[resolveCategory(norm)] || demoState.categories['Default'];

      // Build a map of files already known for this dir
      const knownByInode = {};
      for (const [key, f] of Object.entries(demoState.files)) {
        if (f.dir_id === dirId) knownByInode[f.inode] = f;
      }

      const childPaths  = vfsChildren(norm);
      const entriesOut  = [];

      for (const childPath of childPaths) {
        const node = demoVfs[childPath];
        if (!node) continue;

        const entry = vfsToEntry(childPath);
        const known = knownByInode[node.inode];
        let changeState = 'unchanged';

        if (!known) {
          changeState = 'new';
          // Persist the new file record
          demoState.files[`${node.inode}:${dirId}`] = {
            inode:        node.inode,
            dir_id:       dirId,
            filename:     entry.filename,
            dateModified: node.dateModified,
            dateCreated:  node.dateCreated,
            size:         node.size,
            checksumValue:  null,
            checksumStatus: null,
          };
          // Apply any pending path-based tags
          if (pendingPathTags[childPath]) {
            demoState.itemTags[`${node.inode}:${dirId}`] = pendingPathTags[childPath];
            delete pendingPathTags[childPath];
          }
        } else if (known.dateModified !== node.dateModified) {
          changeState = 'dateModified';
          known.dateModified = node.dateModified;
        }

        entriesOut.push({ ...entry, changeState, dir_id: dirId });
      }

      // Add '.' entry for the current directory itself.
      // panels.js reads dotEntry.resolvedInitials to call updateWindowIcon.
      const dirVfsNode = demoVfs[norm];
      const resolvedInitials = (dir && dir.initials) ? dir.initials : null;
      entriesOut.unshift({
        filename:         '.',
        isDirectory:      true,
        path:             norm,
        inode:            dirVfsNode ? dirVfsNode.inode : String(demoState.nextInodeCounter++),
        size:             0,
        dateModified:     dirVfsNode ? dirVfsNode.dateModified : Date.now(),
        dateCreated:      dirVfsNode ? dirVfsNode.dateCreated  : Date.now(),
        perms:            { read: true, write: true },
        permError:        false,
        changeState:      'unchanged',
        dir_id:           dirId,
        initials:         resolvedInitials,
        resolvedInitials: resolvedInitials,
        initialsIsInherited: false,
      });

      saveState();

      return p({
        success:       true,
        entries:       entriesOut,
        category:      catObj ? catObj.name : 'Default',
        categoryData:  catObj || null,
        hasChanges:    entriesOut.some(e => e.changeState !== 'unchanged'),
        alertsCreated: 0,
        orphanCount:   0,
        trashCount:    0,
        isVirtualView: false,
      });
    },

    // ── Filesystem: mutations ────────────────────────────────────────────────

    createFolder(parentPath, folderName) {
      const norm = vfsNormalize(parentPath);
      const newPath = norm + '/' + folderName;
      if (demoVfs[newPath]) {
        return p({ success: false, error: 'Folder already exists' });
      }
      demoVfs[newPath] = {
        isDirectory:  true,
        size:         0,
        dateModified: Date.now(),
        dateCreated:  Date.now(),
        inode:        String(demoState.nextInodeCounter++),
      };
      saveVfs(); saveState();
      return p({ success: true, path: newPath });
    },

    checkCollisions(items, targetDirPath) {
      const norm       = vfsNormalize(targetDirPath);
      const collisions = (items || []).filter(item => {
        const name  = vfsBasename(item.path || item);
        const dest  = norm + '/' + name;
        return !!demoVfs[dest];
      });
      return p({ collisions: collisions.map(i => i.path || i) });
    },

    moveItems(items, targetDirPath) {
      const normTarget = vfsNormalize(targetDirPath);
      const results    = [];
      for (const item of (items || [])) {
        const src  = vfsNormalize(item.path);
        const name = vfsBasename(src);
        const dest = normTarget + '/' + name;
        if (!demoVfs[src]) { results.push({ success: false, path: src, error: 'Not found' }); continue; }
        // Move the node and all descendants
        const toMove = Object.keys(demoVfs).filter(k => k === src || k.startsWith(src + '/'));
        for (const oldKey of toMove) {
          const newKey = dest + oldKey.slice(src.length);
          demoVfs[newKey] = demoVfs[oldKey];
          delete demoVfs[oldKey];
        }
        results.push({ success: true, oldPath: src, newPath: dest });
      }
      saveVfs();
      return p({ success: true, results });
    },

    copyItems(items, targetDirPath) {
      const normTarget = vfsNormalize(targetDirPath);
      for (const item of (items || [])) {
        const src  = vfsNormalize(item.path);
        const name = vfsBasename(src);
        const dest = normTarget + '/' + name;
        const toCopy = Object.keys(demoVfs).filter(k => k === src || k.startsWith(src + '/'));
        for (const oldKey of toCopy) {
          const newKey = dest + oldKey.slice(src.length);
          demoVfs[newKey] = Object.assign({}, demoVfs[oldKey], {
            inode: String(demoState.nextInodeCounter++),
            dateCreated: Date.now(),
          });
        }
      }
      saveVfs(); saveState();
      return p({ success: true });
    },

    deleteItems(items) {
      for (const item of (items || [])) {
        const norm = vfsNormalize(item.path);
        const toDelete = Object.keys(demoVfs).filter(k => k === norm || k.startsWith(norm + '/'));
        for (const k of toDelete) delete demoVfs[k];
      }
      saveVfs();
      return p({ success: true });
    },

    // ── Categories ───────────────────────────────────────────────────────────

    loadCategories()     { return p(deepClone(demoState.categories)); },
    getCategoriesList()  { return p(Object.values(demoState.categories).map(c => ({ name: c.name, bgColor: c.bgColor, textColor: c.textColor }))); },
    getCategory(name)    { return p(demoState.categories[name] || null); },

    createCategory(name, bgColor, textColor, patterns) {
      const cat = { name, bgColor, textColor, patterns: patterns || [], description: '', enableChecksum: false, attributes: [], autoAssignCategory: null, displayMode: 'details' };
      demoState.categories[name] = cat;
      saveState();
      return p(cat);
    },

    saveCategory(categoryData) {
      demoState.categories[categoryData.name] = Object.assign({}, demoState.categories[categoryData.name] || {}, categoryData);
      saveState();
      return p(demoState.categories[categoryData.name]);
    },

    updateCategory(name, categoryData) {
      demoState.categories[name] = Object.assign({}, demoState.categories[name] || {}, categoryData);
      saveState();
      return p(demoState.categories[name]);
    },

    deleteCategory(name) {
      if (name === 'Default') return p({ success: false, error: 'Cannot delete Default' });
      delete demoState.categories[name];
      saveState();
      return p({ success: true });
    },

    assignCategoryToDirectory(dirPath, categoryName) {
      const norm = vfsNormalize(dirPath);
      const dir  = ensureDir(norm);
      dir.category       = categoryName;
      dir.category_force = 1;
      saveState();
      return p({ success: true });
    },

    assignCategoryToDirectories(dirPaths, categoryName) {
      for (const dp of (dirPaths || [])) {
        const norm = vfsNormalize(dp);
        const dir  = ensureDir(norm);
        dir.category       = categoryName;
        dir.category_force = 1;
      }
      saveState();
      return p({ success: true });
    },

    getDirectoryAssignment(dirPath) {
      const dir = demoState.dirs[vfsNormalize(dirPath)];
      return p(dir ? { category: dir.category, category_force: dir.category_force } : null);
    },

    removeDirectoryAssignment(dirPath) {
      const dir = demoState.dirs[vfsNormalize(dirPath)];
      if (dir) { dir.category = 'Default'; dir.category_force = 0; saveState(); }
      return p({ success: true });
    },

    getCategoryForDirectory(dirPath) {
      const norm    = vfsNormalize(dirPath);
      const catName = resolveCategory(norm);
      return p(demoState.categories[catName] || demoState.categories['Default']);
    },

    // ── Tags ─────────────────────────────────────────────────────────────────

    loadTags()        { return p(deepClone(demoState.tags)); },
    getTagsList()     { return p(Object.values(demoState.tags)); },
    getTag(name)      { return p(demoState.tags[name] || null); },

    saveTag(tagData) {
      demoState.tags[tagData.name] = Object.assign({}, demoState.tags[tagData.name] || {}, tagData);
      saveState();
      return p(demoState.tags[tagData.name]);
    },

    updateTag(name, tagData) {
      demoState.tags[name] = Object.assign({}, demoState.tags[name] || {}, tagData);
      saveState();
      return p(demoState.tags[name]);
    },

    deleteTag(name) {
      delete demoState.tags[name];
      saveState();
      return p({ success: true });
    },

    addTagToItem(data) {
      const { tagName, inode, dir_id } = data;
      const key = `${inode}:${dir_id}`;
      if (!demoState.itemTags[key]) demoState.itemTags[key] = [];
      if (!demoState.itemTags[key].includes(tagName)) demoState.itemTags[key].push(tagName);
      saveState();
      return p({ success: true });
    },

    removeTagFromItem(data) {
      const { tagName, inode, dir_id } = data;
      const key = `${inode}:${dir_id}`;
      if (demoState.itemTags[key]) {
        demoState.itemTags[key] = demoState.itemTags[key].filter(t => t !== tagName);
        saveState();
      }
      return p({ success: true });
    },

    // ── File types ───────────────────────────────────────────────────────────

    getFileTypes()     { return p(deepClone(demoState.fileTypes)); },
    getFileTypeIcons() {
      const icons = {};
      for (const ft of demoState.fileTypes) {
        if (ft.icon) icons[ft.pattern] = ft.icon;
      }
      return p(icons);
    },

    addFileType(pattern, type, icon, openWith) {
      demoState.fileTypes.push({ pattern, type, icon, openWith });
      saveState();
      return p({ success: true });
    },

    updateFileType(pattern, newPattern, newType, icon, openWith) {
      const idx = demoState.fileTypes.findIndex(f => f.pattern === pattern);
      if (idx >= 0) {
        demoState.fileTypes[idx] = { pattern: newPattern || pattern, type: newType, icon, openWith };
        saveState();
      }
      return p({ success: true });
    },

    deleteFileType(pattern) {
      demoState.fileTypes = demoState.fileTypes.filter(f => f.pattern !== pattern);
      saveState();
      return p({ success: true });
    },

    // ── Attributes ───────────────────────────────────────────────────────────

    getAttributesList()             { return p(Object.values(demoState.attributes)); },
    saveAttribute(attrData)         { demoState.attributes[attrData.name] = attrData; saveState(); return p(attrData); },
    updateAttribute(name, attrData) { demoState.attributes[name] = attrData; saveState(); return p(attrData); },
    deleteAttribute(name)           { delete demoState.attributes[name]; saveState(); return p({ success: true }); },
    getFileAttributes(inode, dir_id){ return p({}); },
    setFileAttributes(inode, dir_id, attributes) { saveState(); return p({ success: true }); },

    // ── Settings ─────────────────────────────────────────────────────────────

    getSettings()         { return p(deepClone(demoState.settings)); },
    saveSettings(settings){ Object.assign(demoState.settings, settings); saveState(); return p({ success: true }); },

    // ── Favorites ────────────────────────────────────────────────────────────

    getFavorites()          { return p(deepClone(demoState.favorites)); },
    saveFavorites(favorites){ demoState.favorites = favorites; saveState(); return p({ success: true }); },

    // ── Hotkeys ──────────────────────────────────────────────────────────────

    getHotkeys()           { return p(deepClone(demoState.hotkeys)); },
    saveHotkeys(hotkeyData){ demoState.hotkeys = hotkeyData; saveState(); return p({ success: true }); },

    // ── Auto-labels ──────────────────────────────────────────────────────────

    loadAutoLabels()                  { return p(deepClone(demoState.autoLabels)); },
    getAutoLabel(id)                  { return p(null); },
    createAutoLabel(data)             { return p({ success: true, id: Date.now() }); },
    updateAutoLabel(id, data)         { return p({ success: true }); },
    deleteAutoLabel(id)               { return p({ success: true }); },
    evaluateAutoLabels(items)         { return p({ suggestions: [] }); },
    applyAutoLabelSuggestions(suggs)  { return p({ success: true }); },

    // ── Dir grid layouts ─────────────────────────────────────────────────────

    getDirGridLayout(dirname) {
      const layout = demoState.gridLayouts[vfsNormalize(dirname)] || null;
      return p({ success: true, layout });
    },
    saveDirGridLayout(dirname, columns, sortData) {
      demoState.gridLayouts[vfsNormalize(dirname)] = { columns, sortData };
      saveState();
      return p({ success: true });
    },

    // ── Directory labels / initials ───────────────────────────────────────────

    getDirectoryLabels(dirPath) {
      const dir = demoState.dirs[vfsNormalize(dirPath)];
      return p(dir ? (dir.labels || []) : []);
    },
    saveDirectoryLabels(dirPath, labels) {
      const dir = ensureDir(vfsNormalize(dirPath));
      // Partial update — only patch fields that are explicitly provided,
      // mirroring db.updateDirectoryLabels() field-by-field semantics.
      const l = labels || {};
      if (l.initials         !== undefined) dir.initials           = l.initials ? l.initials.slice(0, 2).toUpperCase() : null;
      if (l.initialsForce    !== undefined) dir.initials_force     = l.initialsForce    ? 1 : 0;
      if (l.initialsInherit  !== undefined) dir.initials_inherit   = l.initialsInherit  ? 1 : 0;
      if (l.displayName      !== undefined) dir.display_name       = l.displayName      || null;
      if (l.displayNameForce !== undefined) dir.display_name_force = l.displayNameForce ? 1 : 0;
      if (l.displayNameInherit !== undefined) dir.display_name_inherit = l.displayNameInherit ? 1 : 0;
      saveState();
      return p({ success: true });
    },
    getDirectoryInitials(dirPath) {
      const dir = demoState.dirs[vfsNormalize(dirPath)];
      return p(dir ? dir.initials : null);
    },
    saveDirectoryInitials(dirPath, initials) {
      const dir = ensureDir(vfsNormalize(dirPath));
      dir.initials = initials;
      saveState();
      return p({ success: true });
    },

    // ── Icon generation ───────────────────────────────────────────────────────

    generateFolderIcon(bgColor, textColor, initials) {
      return p(generateFolderIconDataUrl(bgColor, textColor, initials));
    },
    generateTagIcon(bgColor, textColor) {
      return p(generateTagIconDataUrl(bgColor, textColor));
    },
    updateWindowIcon(categoryName, initials) {
      try {
        const cat = demoState.categories[categoryName];
        const bg  = (cat && cat.bgColor)   || 'rgb(239,228,176)';
        const fg  = (cat && cat.textColor) || 'rgb(0,0,0)';
        const dataUrl = generateFolderIconDataUrl(bg, fg, initials || null);
        let link = document.querySelector('link[rel~="icon"]');
        if (!link) {
          link = document.createElement('link');
          link.rel  = 'icon';
          link.type = 'image/png';
          document.head.appendChild(link);
        }
        link.href = dataUrl;
      } catch (_) {}
      return p({ success: true });
    },

    // ── Terminal ──────────────────────────────────────────────────────────────

    terminalCreate(cwd) {
      const id      = String(++ptyIdCounter);
      const session = { id, cwd: vfsNormalize(cwd || '/AtlasExplorer'), inputBuf: '' };
      ptyMap.set(id, session);
      // Greet
      setTimeout(() => {
        ptyWrite(id, `${BOLD}AtlasExplorer Demo Terminal${RESET}${NL}`);
        ptyWrite(id, `${YELLOW}This is a simulated shell. Type 'help' for available commands.${RESET}${NL}${NL}`);
        ptyPrompt(session);
      }, 0);
      return p({ id });
    },

    terminalSendInput({ id, data }) {
      const session = ptyMap.get(id);
      if (!session) return p({ success: false });
      // Echo input and handle line buffering
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          ptyWrite(id, NL);
          const line = session.inputBuf;
          session.inputBuf = '';
          handleTerminalLine(session, line);
        } else if (ch === '\x7f' || ch === '\b') {
          // Backspace
          if (session.inputBuf.length > 0) {
            session.inputBuf = session.inputBuf.slice(0, -1);
            ptyWrite(id, '\b \b');
          }
        } else {
          session.inputBuf += ch;
          ptyWrite(id, ch); // echo
        }
      }
      return p({ success: true });
    },

    terminalResize()  { return p({ success: true }); },
    terminalDestroy({ id }) { ptyMap.delete(id); return p({ success: true }); },

    // ── Notes & Markdown ──────────────────────────────────────────────────────

    readFileContent(filePath) {
      const norm = vfsNormalize(filePath);
      const content = demoState.notesContent[norm];
      if (content !== undefined) return p(content);
      // Return a generic stub for files not in our content map
      return p(`(content of ${vfsBasename(norm)} — read-only in demo)`);
    },

    writeFileContent(filePath, content) {
      const norm = vfsNormalize(filePath);
      demoState.notesContent[norm] = content;
      saveState();
      return p({ success: true });
    },

    renderMarkdown(content) {
      const md = getMarkdownit();
      if (!md) return p('<pre>' + content + '</pre>');
      return p(md.render(content));
    },

    parseNotesFile(content)                      { return p({ sections: {}, rawLines: [] }); },
    writeNotesSection(existingContent, sectionKey, newContent) { return p({ success: true, content: existingContent }); },
    extractNotesHeaders(content)                 { return p([]); },
    extractDirectoryNotes(content)               { return p(''); },
    extractFileNotes({ content, filename })      { return p(''); },
    validateNotesHeader(line)                    { return p({ valid: true }); },
    parseTodoSection(sectionContent)             { return p({ items: [] }); },
    normalizeTodoSection(sectionContent)         { return p({ content: sectionContent }); },
    updateTodoItems(sectionContent, updates)     { return p({ content: sectionContent }); },
    getTodoAggregates()                          { return p({ aggregates: [] }); },
    refreshTodoAggregate(notesPath, dirId)       { return p({ success: true }); },
    refreshTodoAggregates()                      { return p({ success: true }); },

    // ── File history ──────────────────────────────────────────────────────────

    getItemHistory(item) {
      const inode  = item && item.inode;
      const dir_id = item && item.dir_id;
      const entries = demoState.fileHistory.filter(h => h.inode === inode && h.dir_id === dir_id);
      return p({ success: true, history: entries });
    },

    getFileHistory(inode) {
      return p(demoState.fileHistory.filter(h => h.inode === inode));
    },

    getFileRecordByPath(filePath) {
      const norm = vfsNormalize(filePath);
      const node = demoVfs[norm];
      if (!node) return p(null);
      return p({ inode: node.inode, filename: vfsBasename(norm), path: norm });
    },

    updateFileModificationDate(dirPath, inode, newDateModified) {
      const key = Object.keys(demoState.files).find(k => k.startsWith(inode + ':'));
      if (key) { demoState.files[key].dateModified = newDateModified; saveState(); }
      return p({ success: true });
    },

    updateHistoryComment(id, comment)    { return p({ success: true }); },
    updateDirHistoryComment(id, comment) { return p({ success: true }); },

    // ── Alerts / Monitoring ───────────────────────────────────────────────────

    getAlertsSummary()             { return p({ alerts: [] }); },
    getAlertsHistory()             { return p([]); },
    getUnacknowledgedAlertCount()  { return p(0); },
    acknowledgeAlerts()            { return p({ success: true }); },
    getAlertRules()                { return p([]); },
    saveAlertRule()                { return p({ success: true }); },
    deleteAlertRules()             { return p({ success: true }); },
    getMonitoringRules()           { return p([]); },
    saveMonitoringRule()           { return p({ success: true }); },
    deleteMonitoringRules()        { return p({ success: true }); },
    startActiveMonitoring()        { return p({ success: true }); },
    stopActiveMonitoring()         { return p({ success: true }); },
    acknowledgeDirOrphan()         { return p({ success: true }); },
    startBackgroundRefresh()       { return p({ success: true }); },
    stopBackgroundRefresh()        { return p({ success: true }); },
    registerWatchedPath()          { return p({ success: true }); },
    unregisterWatchedPath()        { return p({ success: true }); },

    // ── Custom actions ────────────────────────────────────────────────────────

    getCustomActions()                        { return p([]); },
    saveCustomAction()                        { return p({ success: true }); },
    deleteCustomAction()                      { return p({ success: true }); },
    verifyCustomAction()                      { return p({ valid: false, message: 'Not available in demo' }); },
    runCustomAction()                         { return p({ success: false, message: 'Not available in demo' }); },
    runCustomActionInTerminal()               { return p({ success: false, message: 'Not available in demo' }); },

    // ── Layouts ───────────────────────────────────────────────────────────────

    saveLayout()                              { return p({ success: true }); },
    saveLayoutToPath()                        { return p({ success: true }); },
    captureThumbnail()                        { return p(null); },
    loadLayout()                              { return p({ success: false }); },
    listLayouts()                             { return p([]); },
    loadLayoutFile()                          { return p({ success: false }); },
    deleteLayout()                            { return p({ success: true }); },

    // ── Item stats ────────────────────────────────────────────────────────────

    getItemStats(itemPath) {
      const node = demoVfs[vfsNormalize(itemPath)];
      if (!node) return p(null);
      return p({ size: node.size, dateModified: node.dateModified, dateCreated: node.dateCreated, isDirectory: node.isDirectory });
    },

    // ── Misc ──────────────────────────────────────────────────────────────────

    getAppVersion()           { return p('demo'); },
    checkForUpdates()         { return p({ success: false, message: 'Not available in demo' }); },
    downloadUpdate()          { return p({ success: false }); },
    quitAndInstall()          { return p(); },
    closeWindow()             { return p(); },
    setWindowTitle({ title }) { document.title = title || 'AtlasExplorer'; return p({ success: true }); },
    openInDefaultApp()        { return p({ success: true }); },
    openExternalLink(url)     { window.open(url, '_blank', 'noopener,noreferrer'); return p({ success: true }); },
    pickFile()                { return p({ filePath: null, canceled: true }); },
    reinitializeDatabase()    { return p({ success: true }); },
    calculateFileChecksum()   { return p({ success: false, status: 'not-available' }); },
    getExifData()             { return p({}); },
    getVideoThumbnail()       { return p(null); },

    invoke(channel) {
      console.warn('[demo-api] Unhandled invoke:', channel);
      return p({ success: true });
    },

    // ── Push-event listener registrations ─────────────────────────────────────

    onTerminalOutput(cb)          { listeners.terminalOutput.push(cb); },
    onTerminalExit(cb)            { listeners.terminalExit.push(cb); },
    onDirectoryChanged(cb)        { listeners.directoryChanged.push(cb); },
    onAlertCountUpdated(cb)       { listeners.alertCountUpdated.push(cb); },
    onLoadLayoutFromFile(cb)      { listeners.loadLayoutFromFile.push(cb); },
    onCloseRequest(cb)            { listeners.closeRequest.push(cb); },
    onUpdateAvailable(cb)         { listeners.updateAvailable.push(cb); },
    onUpdateNotAvailable(cb)      { listeners.updateNotAvailable.push(cb); },
    onUpdateDownloadProgress(cb)  { listeners.updateDownloadProgress.push(cb); },
    onUpdateDownloaded(cb)        { listeners.updateDownloaded.push(cb); },
    onUpdateError(cb)             { listeners.updateError.push(cb); },
  };

  // Suppress the browser's native context menu so the app's custom one
  // can take over without interference.
  document.addEventListener('contextmenu', e => e.preventDefault());

  console.log('[demo-api] window.electronAPI polyfill installed.');

})();
