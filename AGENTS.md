# Atlas Explorer — Agent Guide

Atlas Explorer is a desktop file explorer (Electron + Node.js + SQLite) that sits as a richer layer atop the plain filesystem. Read this file first, then follow the links below for depth.

## Essential reading

| Doc | When to read it |
|-----|-----------------|
| [agent-docs/index.md](agent-docs/index.md) | Overview and how the docs fit together |
| [agent-docs/vision.md](agent-docs/vision.md) | What the app is for and who it's for |
| [agent-docs/design-principles.md](agent-docs/design-principles.md) | What "done" looks like — read before touching any UI |
| [agent-docs/concepts.md](agent-docs/concepts.md) | Panels, URIs, the P1-Pn+1 pattern, sidebar rules |
| [agent-docs/architecture.md](agent-docs/architecture.md) | SQLite vs flat files, Electron split, user-control principle |
| [agent-docs/modules.md](agent-docs/modules.md) | Which file owns which responsibility |

> **These docs are the authoritative source of design intent.** They are updated as design decisions are made in chat. When a new constraint or rationale surfaces in a conversation, add it to the relevant doc.

## Commands

```
npm start                   # run the app
npm run dev                 # run with --dev flag
npm test                    # run tests (watch mode)
npm run test:coverage       # run tests with coverage report
npm run db:reinit           # wipe and reinitialize the SQLite DB
npm run sync-assets         # sync assets
npm run build               # package with electron-builder
npm run debug:port          # start app with remote debugging on port 9222
node debug-electron.js      # connect to the running app for live UI inspection
```

After `npm install`, native modules (`better-sqlite3`, `node-pty`) are rebuilt automatically via `postinstall`.

### Live UI inspection

Start the app with `npm run debug:port`, then run `node debug-electron.js` to connect via the Chrome DevTools Protocol. The app must already be running before connecting. Available helpers:

| Helper | Purpose |
|--------|---------|
| `screenshot()` | Save a screenshot of the current UI |
| `getDOM(selector)` | Get outerHTML of an element |
| `inspectElement(selector)` | Log tag, classes, and computed styles |
| `executeJS(code)` | Evaluate arbitrary JS in the renderer |
| `findElements(selector)` | List all matching elements with positions |
| `monitorConsole()` | Stream console output in real-time |
| `getErrors()` | Snapshot of recent JS errors |

## Project layout (quick reference)

```
main/main.js          Electron main process — IPC routing, window lifecycle
src/                  Backend logic (Node-side, no DOM)
public/               Renderer (HTML/JS/CSS)
public/js/renderer.js Primary orchestrator — page-building and inter-module wiring
public/js/modules/    Feature modules: panels, sidebar, contexts, notes, reminders, todos, …
agent-docs/           Design documentation — see table above
```

## Non-negotiables

- **Files are files, files are king.** Never hide user data in proprietary formats or blobs. Users must be able to work outside the app.
- **Geometry first, content second.** UI must assume its final shape immediately. Geometry must not shift after lazy-loaded content arrives.
- **No dead clicks.** Every input must produce immediate visual feedback.
- **No `alert()`.** Inline validation only. Modals for confirmations, never for error popups.
- **SQLite for speed (search, indices, associations). Flat files for accessibility (notes, label definitions, settings that users may want to share or access outside the app).**
- **The sidebar is not tied to any single panel.** Do not introduce panel-coupling in sidebar code.
- **Hard cap of 4 panels.** Do not add a 5th slot without explicitly revisiting this constraint.

## Tests

Tests live in `__tests__/` directories or `*.test.js` files alongside source. Coverage is collected from `src/**/*.js` (excluding `src/preload.js`). Test environment is Node (not jsdom).

---

In case I forgot to say it in the prompt, Please and Thank You!