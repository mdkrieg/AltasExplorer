# Module Map

This map describes what each major source file owns and — equally important — what should *not* live in it. If you find yourself adding code that violates one of these "should not" rules, that's a signal to step back and consider where it really belongs.

## Top-level layout

```
main/main.js              Electron main process; IPC; orchestrates backend services
src/                      Backend logic (Node-side, no DOM)
public/                   Renderer (UI side)
public/js/renderer.js     Page-building and inter-module wiring
public/js/modules/        Renderer-side feature modules
```

## Backend (`src/`)

### `src/db.js`
SQLite access layer. Schema, queries, migrations.

### `src/filesystem.js`
Filesystem operations the renderer can't do directly.

### `src/scanner.js`
Background scanning / monitoring of watched directories.

### `src/categories.js`, `src/tags.js`
Category and tag definition I/O. Definitions live as flat JSON in the user's home directory; associations live in SQLite.

### `src/notesParser.js`
Parses `notes.txt` files into structured sections. Used by both aggregators.

### `src/reminderAggregator.js`
Aggregates REMINDER items across all known notes files into a single, deduplicated, date-bucketed dataset.

**Why backend (not renderer):** must read filesystem files; must report a single dataset to the UI; must be cache-aware to avoid redundant DB writes when content hasn't changed.

### `src/todoAggregator.js`
Same shape as the reminder aggregator, for TODO items.

### `src/checksum.js`, `src/attributes.js`, `src/icons.js`, `src/filetypes.js`
Per-file metadata: hashes, attributes, icons, file-type detection.

### `src/customActions.js`
User-configurable context-menu actions.

### `src/layouts.js`, `src/autoLabels.js`
Saved panel layouts; auto-tagging rules.

### `src/preload.js`
Electron preload bridge. Defines what the renderer can call via IPC.

## Electron main (`main/main.js`)

Owns:
- BrowserWindow lifecycle.
- IPC handler registration (renderer ↔ backend).
- Wiring backend modules into IPC routes.
- File-association handling (file passed on command line / "Open with").
- Auto-updater wiring.

Should not:
- Hold renderer-side state.
- Contain feature logic — that belongs in `src/` modules.

## Renderer entry (`public/js/renderer.js`)

The **primary orchestrator**. Owns:
- Page-building.
- Inter-module wiring.
- Top-level state (panel state, selected-item state, w2layout instance).

Should not become:
- A home for individual feature implementations. Onclick handlers and feature logic belong in their respective modules. If you see them here, it's a refactor smell.

## Renderer modules (`public/js/modules/`)

### `panels.js`
Panel state, grid management, navigation, layout switching, and item properties. Implements the [P1-Pn+1 pattern](concepts.md#the-p1-pn1-pattern).

**Note:** Panels is *the* heart of the app. It's gotten a bit bloated and may benefit from extraction in the future. When extracting, preserve the panel definition rules in [Core Concepts](concepts.md#panels).

### `sidebar.js`
Sidebar navigation, tree, favorites, sidebar collapse, and sidebar focus management.

**Coupling:** the sidebar serves *all* panels — it is intentionally not tied to a single panel. Don't introduce code that breaks this.

### `contexts.js`
Right-click context menus on the file grid: menu generation, click routing, custom flyout menus.

**Note:** "context" here means right-click context menus. Don't conflate with "logical context" used in plain English elsewhere in the codebase.

**Possible refactor target:** this was extracted early; whether it should stay separate is open for reconsideration.

### `notes.js`
Originally for notes-file editing; has grown into a generic file editor (Monaco-backed) shared with the panel file-view.

**Possible refactor target:** the name no longer fits. Renaming or splitting out the generic file-editor functionality is on the table.

### `reminders.js`
The REMINDER modal: edit reminder text/date/time, push-buttons (+1 hr, → 15:00, Tomorrow, Next week), cohabitation panel for reminders embedded in TODOs, comment/reply annotations.

### `sidebarReminders.js`
Sidebar REMINDERS section renderer. Buckets reminders by due date (Past Due / Today / Tomorrow / This Week / Next Week / Later / No Date).

**Why split from `reminders.js`:** the modal owns *editing* one reminder; the sidebar section owns *displaying the aggregate*. They render at different times, react to different events, and should not share state.

### `todos.js`, `sidebarTodos.js`
Same split as reminders — modal vs. sidebar section.

### `panels.js`, `notes.js`, `contexts.js` (already covered above)

### `alerts.js`
Alert badge and alert modal.

### `history.js`
History modal and per-file change summaries (audit trail UI).

### `settings.js`
Settings modal — categories, tags, hotkeys.

### `terminal.js`
Built-in terminal (node-pty backed).

### `dragdrop.js`, `path-autocomplete.js`, `auto-labels.js`, `notifications.js`, `userWarnings.js`, `annotationHelpers.js`, `utils.js`
Supporting modules. `utils.js` holds pure utilities (formatBytes, escapeHtml, etc.) — no DOM dependencies.

### `vendor/`
Third-party UI libraries (currently w2ui). Don't modify; if a behavior gap is found, consider a back-contribution to w2ui upstream (see [Design Principles](design-principles.md#use-w2ui-in-the-standard-way)).

## Drag tray (`public/drag-tray.html`, `public/js/drag-tray-renderer.js`)

A separate small window for drag-and-drop operations.
