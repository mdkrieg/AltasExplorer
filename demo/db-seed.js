/**
 * demo/db-seed.js
 * Provides window.demoSeed — the initial state for all in-memory stores
 * used by demo-api.js.  Loaded as a plain <script> before demo-api.js.
 */

window.demoSeed = {

  // ── Settings ──────────────────────────────────────────────────────────────
  settings: {
    home_directory: '/AtlasExplorer',
    file_format: 'Markdown',
    hide_dot_directory: false,
    hide_dot_dot_directory: false,
    show_folder_name_with_dot_entries: false,
    pin_meta_dirs: false,
    record_height: 28,
    background_refresh_enabled: false,
    background_refresh_interval: 30,
    checksum_max_concurrent: 1,
    title_default_format: 'folder-name',
    title_display_name_format: 'name-relative-path',
    monitoring_enabled: false,
    monitoring_scheduler_interval: 15,
    monitoring_max_dirs_per_pass: 10,
    monitoring_inter_scan_delay_ms: 50,
    monitoring_observation_dead_time_value: 1,
    monitoring_observation_dead_time_unit: 'hours',
    auto_update_check_enabled: false,
    auto_update_check_interval_hours: 24,
  },

  // ── Hotkeys ───────────────────────────────────────────────────────────────
  hotkeys: {
    'Panel Navigation': {
      navigate_back:    { label: 'Navigate Back',          key: 'Alt+Left',       default: 'Alt+Left' },
      navigate_forward: { label: 'Navigate Forward',       key: 'Alt+Right',      default: 'Alt+Right' },
      navigate_up:      { label: 'Go to Parent',           key: 'Alt+Up',         default: 'Alt+Up' },
      add_panel:        { label: 'Add Panel',              key: 'Ctrl+t',         default: 'Ctrl+t' },
      open_terminal:    { label: 'Open Terminal Panel',    key: 'Ctrl+j',         default: 'Ctrl+j' },
      close_panel:      { label: 'Close Active Panel',     key: 'Ctrl+w',         default: 'Ctrl+w' },
      reopen_panel:     { label: 'Reopen Last Closed Panel', key: 'Ctrl+Shift+t', default: 'Ctrl+Shift+t' },
      open_item:        { label: 'Open Item',              key: 'Ctrl+Enter',     default: 'Ctrl+Enter' },
      cycle_panel:      { label: 'Cycle Panel Focus',      key: 'Tab',            default: 'Tab' },
      focus_path_bar:   { label: 'Focus Path Bar',         key: 'Ctrl+l',         default: 'Ctrl+l' },
      enter_path:       { label: 'Enter Path',             key: 'Enter',          default: 'Enter' },
      cancel_path:      { label: 'Cancel Path',            key: 'Escape',         default: 'Escape' },
    },
    'File': {
      edit_file:  { label: 'Edit File',   key: 'Ctrl+e',       default: 'F2' },
      save_file:  { label: 'Save File',   key: 'Ctrl+s',       default: 'Ctrl+s' },
      new_folder: { label: 'New Folder',  key: 'Ctrl+Shift+n', default: 'Ctrl+Shift+n' },
    },
    'Layouts': {
      save_layout: { label: 'Save Layout', key: 'Ctrl+Shift+s', default: 'Ctrl+Shift+s' },
      load_layout: { label: 'Load Layout', key: 'Ctrl+Shift+l', default: 'Ctrl+Shift+l' },
    },
    'Grid Navigation': {
      grid_row_up:   { label: 'Navigate Row Up',   key: 'ArrowUp',   default: 'ArrowUp',   locked: true },
      grid_row_down: { label: 'Navigate Row Down', key: 'ArrowDown', default: 'ArrowDown', locked: true },
    },
  },

  // ── Favorites ─────────────────────────────────────────────────────────────
  favorites: [
    { path: '/AtlasExplorer',        label: 'AtlasExplorer (root)' },
    { path: '/AtlasExplorer/src',    label: 'src' },
    { path: '/AtlasExplorer/public', label: 'public' },
    { path: '/AtlasExplorer/main',   label: 'main' },
  ],

  // ── Categories ────────────────────────────────────────────────────────────
  categories: {
    Default: {
      name: 'Default',
      bgColor: 'rgb(239, 228, 176)',
      textColor: 'rgb(0, 0, 0)',
      patterns: [],
      description: '',
      enableChecksum: false,
      attributes: [],
      autoAssignCategory: null,
      displayMode: 'details',
    },
    Project: {
      name: 'Project',
      bgColor: 'rgb(173, 216, 255)',
      textColor: 'rgb(0, 40, 90)',
      patterns: ['*.js', '*.json', 'package.json'],
      description: 'Active project directories',
      enableChecksum: false,
      attributes: [],
      autoAssignCategory: null,
      displayMode: 'details',
    },
    Repository: {
      name: 'Repository',
      bgColor: 'rgb(180, 255, 180)',
      textColor: 'rgb(0, 60, 0)',
      patterns: ['*.js', '*.json', '*.md'],
      description: 'Source code repositories',
      enableChecksum: false,
      attributes: [],
      autoAssignCategory: null,
      displayMode: 'details',
    },
    Archive: {
      name: 'Archive',
      bgColor: 'rgb(210, 210, 210)',
      textColor: 'rgb(80, 80, 80)',
      patterns: ['*.zip', '*.tar', '*.gz'],
      description: 'Archived or read-only directories',
      enableChecksum: false,
      attributes: [],
      autoAssignCategory: null,
      displayMode: 'details',
    },
  },

  // ── Directory → category assignments ──────────────────────────────────────
  // dir.category_force = true means the assignment was explicit (not pattern-matched)
  dirAssignments: {
    '/AtlasExplorer':               { category: 'Repository', category_force: true },
    '/AtlasExplorer/src':           { category: 'Repository', category_force: true },
    '/AtlasExplorer/main':          { category: 'Project',    category_force: true },
    '/AtlasExplorer/public':        { category: 'Project',    category_force: true },
    '/AtlasExplorer/public/js':     { category: 'Project',    category_force: true },
    '/AtlasExplorer/public/css':    { category: 'Project',    category_force: true },
    '/AtlasExplorer/public/assets': { category: 'Default',    category_force: false },
    '/AtlasExplorer/demo':          { category: 'Project',    category_force: true },
  },

  // ── Tags ──────────────────────────────────────────────────────────────────
  tags: {
    important: {
      name: 'important',
      bgColor: 'rgb(255, 100, 100)',
      textColor: 'rgb(255, 255, 255)',
      description: 'High-priority items',
    },
    review: {
      name: 'review',
      bgColor: 'rgb(180, 130, 220)',
      textColor: 'rgb(255, 255, 255)',
      description: 'Needs review',
    },
    wip: {
      name: 'wip',
      bgColor: 'rgb(255, 165, 0)',
      textColor: 'rgb(255, 255, 255)',
      description: 'Work in progress',
    },
  },

  // ── Pre-applied item tags (path → [tagName, ...]) ─────────────────────────
  preAppliedTags: {
    '/AtlasExplorer/src/db.js':         ['important'],
    '/AtlasExplorer/src/filesystem.js': ['review'],
    '/AtlasExplorer/main/main.js':      ['important', 'wip'],
    '/AtlasExplorer/public/js/renderer.js': ['wip'],
  },

  // ── File types ────────────────────────────────────────────────────────────
  fileTypes: [
    { pattern: 'notes.txt',  type: 'Notes',        locked: true },
    { pattern: '*.aly',      type: 'Atlas Layout',  icon: 'layout.svg', openWith: 'aly-layout', locked: true },
    { pattern: '*.js',       type: 'JavaScript' },
    { pattern: '*.json',     type: 'JSON' },
    { pattern: '*.md',       type: 'Markdown' },
    { pattern: '*.html',     type: 'HTML' },
    { pattern: '*.css',      type: 'CSS' },
    { pattern: '*.txt',      type: 'Text' },
    { pattern: '*.csv',      type: 'CSV' },
    { pattern: '*.png',      type: 'Image' },
    { pattern: '*.jpg',      type: 'Image',   icon: 'user-image.png' },
    { pattern: '*.jpeg',     type: 'Image',   icon: 'user-image.png' },
    { pattern: '*.gif',      type: 'Image',   icon: 'user-image.png' },
    { pattern: '*.svg',      type: 'Image',   icon: 'user-image.png' },
    { pattern: '*.mp4',      type: 'Video',   icon: 'user-video.svg' },
    { pattern: '*.mov',      type: 'Video',   icon: 'user-video.svg' },
    { pattern: '*.webm',     type: 'Video',   icon: 'user-video.svg' },
  ],

  // ── Attributes (custom metadata fields) ──────────────────────────────────
  attributes: {},

  // ── Demo notes content keyed by virtual path ─────────────────────────────
  // Any path ending in notes.txt will serve this content
  notesContent: {
    '/AtlasExplorer/notes.txt': `# AtlasExplorer Demo

Welcome to the **AtlasExplorer** interactive demo!

## What you can do here

- Browse the virtual filesystem (this is the actual AtlasExplorer source tree)
- Assign categories to folders using right-click → Set Category
- Add and remove tags on files and folders
- Create new folders, move and delete items
- Open the terminal (Ctrl+J) and run: \`ls\`, \`cd\`, \`pwd\`, \`echo\`, \`cat\`, \`help\`
- Edit this notes file using Ctrl+E

## About this demo

This demo runs entirely in your browser. Changes persist for your current
session but reset when you close the tab.
`,
    '/AtlasExplorer/src/notes.txt': `# src/

Core service modules for AtlasExplorer.

## Files

- **db.js** — SQLite database layer (better-sqlite3)
- **filesystem.js** — Filesystem abstraction with inode tracking
- **categories.js** — Category and settings management
- **tags.js** — Tag CRUD operations
- **filetypes.js** — File type icon/open-with registry
`,
  },

  // ── Demo file history entries ─────────────────────────────────────────────
  // Pre-seeded so history modal isn't empty on first open
  fileHistory: [
    {
      id: 1, inode: '5', dir_id: 2,
      changeValue: JSON.stringify({ filename: 'db.js', dateModified: Date.now() - 86400000, filesizeBytes: 18432 }),
      detectedAt: Date.now() - 86400000,
      acknowledgedAt: null,
    },
    {
      id: 2, inode: '6', dir_id: 2,
      changeValue: JSON.stringify({ filename: 'filesystem.js', dateModified: Date.now() - 172800000, filesizeBytes: 9216 }),
      detectedAt: Date.now() - 172800000,
      acknowledgedAt: Date.now() - 86400000,
    },
    {
      id: 3, inode: '7', dir_id: 3,
      changeValue: JSON.stringify({ filename: 'main.js', dateModified: Date.now() - 43200000, filesizeBytes: 65536 }),
      detectedAt: Date.now() - 43200000,
      acknowledgedAt: null,
    },
  ],
};
