# Architecture

## Tech stack

- **Electron** — desktop shell.
- **Node.js** — backend logic.
- **SQLite** (`better-sqlite3`) — local database.
- **w2ui** — UI library (see [Design Principles](design-principles.md) for why it's preferred).
- **Monaco** — embedded code editor.
- **node-pty** — built-in terminal.

### Why Electron

- HTML/JS is the most publicly documented frontend stack — best for future contributors.
- Cross-platform (Linux/Mac ports easier than C++/Tkinter/Fyne alternatives).
- The same UI ports cleanly to a typical HTTP server architecture (proof-of-concept already exists). This is useful for homebrew NAS setups on Raspberry Pi or small Linux servers.
- The accepted drawback is responsiveness — addressed through deliberate UX rules, not framework choice (see [Design Principles](design-principles.md)).

## The SQLite vs flat-file split

This is **the** architectural decision in Atlas Explorer. It comes down to:

> **Speed (SQLite) vs. accessibility (flat files).**

When deciding where new data should live, ask: *"do we need speed for this, or do we need accessibility?"*

### What lives in SQLite (speed)

- File system cache.
- Audit trail.
- Applied label associations — *which* directories have *which* categories/tags.
- Search indices.

The killer use case is search. Large file servers with inconsistent organization make Windows search painfully slow. Atlas can answer queries against a local DB without hitting the file server at all — and because of the audit history, results can include files that *used to be there but are currently missing*.

### What lives in flat files (accessibility)

- **`notes.txt` per directory.** Readable on a phone via OneDrive/SharePoint, on a thumbdrive backup, anywhere — without Atlas Explorer installed. Atlas reads the same notes and surfaces TODOs and REMINDERs from them.
- **Category and tag *definitions*** — JSON files in the user's home directory. A user may want to share their collection of categories and tags, so the definitions stay portable.
- The *associations* (which directories carry which categories/tags) live in the DB — they have to, both for search performance and so we don't pollute shared file servers with hidden metadata.

### Settings, favorites, applied labels

For user configuration data, the rule is "whatever makes sense for the architecture." Sharing-across-users → flat file. Searchable / heavily queried → DB.

## The user-control principle

Users must be able to work *outside* Atlas Explorer and have their work persist:

- Edit `notes.txt` in any text editor.
- Drop a file in via Windows Explorer.
- Restore from backup.
- Use a file on a different machine entirely.

Atlas reconciles when the user returns. **This is non-negotiable.** Do not introduce features that hide data inside the app, use proprietary blob formats, or break the user's ability to work outside the app.

## `main/` vs `public/` (Electron split)

Standard Electron split:

- **`main/main.js`** — Electron main process. Owns the BrowserWindow, IPC routing, and orchestrates backend services.
- **`src/`** — Backend logic: DB access, filesystem operations, scanning, aggregation, custom actions, layouts.
- **`public/`** — Renderer: UI, panels, sidebar, modals.
- **`public/js/modules/`** — Renderer-side feature modules (panels, sidebar, contexts, notes, etc.).

Aggregation (TODOs, REMINDERs from notes files) *must* live on the backend (`src/`) because it has to read filesystem files and report a single dataset.

See the [Module Map](modules.md) for what each file owns.

## Known issues (as of 2026-05)

- Setting an alert to ANY/ANY - File Added triggers alerts on initial folder browse. INITIAL events should be treated separately.
