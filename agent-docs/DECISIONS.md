# Decision Log

Durable record of design decisions, especially **walked-back** ones. Atlas Explorer is
developed across many AI sessions with no persistent memory between them, so this file
exists to stop rejected approaches from being re-proposed.

Inline code comments carry the short WHY and link here with an anchor
(e.g. `See agent-docs/DECISIONS.md#board-storage`). This file carries the detail.

See `private/prompts/comment-philosophy.md` for the commenting rules this file supports.

Newest entries first.

---

## unified-context-menu-widget

**All custom right-click flyout menus share one widget (`public/js/modules/contextMenuWidget.js`)**

**Date:** 2026-07-29

**What was tried:** The hand-rolled `.custom-ctx-menu`/`.custom-ctx-item`/`.custom-ctx-submenu`
DOM pattern (hover highlighting, hover-activated submenu flyouts, outside-click/Escape
dismissal) was independently hand-copied four times: the file-grid menu (`contexts.js`, the
original — flat and tabbed), the Context Menu settings tab's group/item menus (`settings.js`),
the favorites sidebar menu (`sidebar.js`), and the terminal panel-picker menu (`renderer.js`).

**Why this was rejected:** The `settings.js` copy dropped a subtle-but-load-bearing detail
from the original: submenu dismissal must be scoped to "the mouse actually left the parent
row and its own flyout" (closure-scoped `activeSubEl` + a short hide-timer), not "any row
anywhere got a mouseenter." The clone instead did a global
`document.querySelectorAll('.custom-ctx-submenu').forEach(s => s.remove())` on every row's
mouseenter — which also fired for rows *inside* the open submenu, deleting it the instant the
cursor moved off the parent and into its own flyout. This was found empirically while
verifying the Context Menu settings tab live: submenus would never stay open. Separately,
`item.disabled` was set on several `contexts.js` registry entries (e.g. "Remove Tag" with no
tags, "Paste" with an empty clipboard) but no copy of the pattern ever actually read that
flag — disabled items were always fully clickable and hoverable, a second latent bug found
during the same review.

**What was chosen instead:** One shared module, `contextMenuWidget.js`, exporting
`buildMenuEl`/`buildTabbedMenuEl` (DOM construction) and `showContextMenu`/
`showTabbedContextMenu`/`hideContextMenu` (positioning + outside-click/Escape + show/hide).
It normalizes both item-shape conventions the four call sites had drifted into
(`{text}`/`text:'--'` from `contexts.js` vs. `{label}`/`{separator:true}` from `settings.js`),
accepts an optional `opts.defaultOnClick(item)` instead of hardcoding `contexts.js`'s
file-grid click-routing table, generalizes the sidebar's hardcoded `custom-ctx-item-danger`
class string into a per-item `danger` boolean, and now actually enforces `item.disabled`
(dimmed, no hover/click/submenu). `contexts.js` keeps its own tabbed-mode registry-bucketing
logic (grouping items by the persisted Context Menu config) since that's file-grid-specific
data prep, not part of the generic widget; it just hands the widget pre-built `tabDefs`.

**Consequence:** `contexts.js`'s exported `showCustomContextMenu(items, x, y, panelId,
pendingDefaultApp, pendingViewMode)` / `hideCustomContextMenu()` signatures are unchanged
(still used by `dragdrop.js`/`panels.js`) — only their internals now delegate to the widget.
Any new custom right-click menu should use the widget directly rather than hand-rolling the
pattern a fifth time.

---



**Renderer ES modules are unit-tested via `--experimental-vm-modules`, not Babel**

**Date:** 2026-07-28

**What was tried:** Importing `public/js/modules/viewTypes.js` from an ordinary Jest test.
Jest resolved it as CommonJS and failed with `SyntaxError: Unexpected token 'export'`.
Wrapping the dynamic import in `new Function` to hide it from Jest's rewrite did not help
either — Jest's decision is made at resolution time, not parse time.

**Why the obvious fix was rejected:** Adding `babel-jest` + `@babel/preset-env` is the
textbook answer, but installing devDependencies triggers this project's `postinstall`
(`electron-rebuild ... --build-from-source`), and a transform step means tests would run
against transpiled output rather than the code Electron actually executes.

**What was chosen instead:**

- `npm test` / `npm run test:coverage` invoke Jest through
  `node --experimental-vm-modules node_modules/jest/bin/jest.js`.
- `public/js/package.json` declares `{"type": "module"}`. This is simply true — those files
  are loaded by `<script type="module">` — and it is what makes Jest resolve them as ESM.
- Tests import them with a dynamic `import()` of a `file:///` URL.

**Consequence:** running bare `jest` (without the flag) makes the renderer suites fail to
parse. Use the npm scripts.

**Related:** `public/js/modules/boardGeometry.js` was split out of `board.js` for this
reason. `board.js` imports the live `panelState` binding from `renderer.js`, which drags the
whole renderer into any test that touches it; the geometry is a leaf module with no imports.

**Amended 2026-07-30 — non-leaf renderer modules need a `.test.mjs`:** the `file:///`
dynamic-import approach above only works for leaf modules. Testing `contexts.js` (which
imports panels/sidebar/terminal/renderer/w2ui) fails at import time with
`ReferenceError: Node is not defined`, because that graph expects a DOM. Neither escape
hatch applies: `jest-environment-jsdom` is a devDependency, which this project avoids for
the reason given above, and the `new Function` import trick deliberately bypasses Jest's
module registry, so `jest.unstable_mockModule` cannot intercept anything loaded through it.
The dependencies therefore have to be mocked, and `jest.unstable_mockModule` only sees
imports resolved through Jest's ESM registry — which Jest uses only when the *test file
itself* is ESM. Hence `jest.config.js` also matches `**/__tests__/**/*.test.mjs`; see
`src/__tests__/context-menu.test.mjs`. Note that namespace imports (`import * as panels`)
link against a partial mock fine, so those mocks only need the members actually reached;
named imports are checked at link time and need every binding present.

---

## board-storage

**Board layout is stored in SQLite, not in a flat file**

**Date:** 2026-07-28

**What was tried:** Two flat-file homes for board item coordinates, in sequence.

1. **`notes.txt` `@<filename>` sections.** The board's note bodies already read from these
   sections, so co-locating coordinates there looked like zero new storage.
2. **`atlas.json`.** The per-directory metadata sidecar (`src/atlasJson.js`), already the
   established flat-file escape hatch for directory tags, attributes, and forced category.

**Why it was tried:** The project's stated principle is "SQLite for speed, flat files for
accessibility." Board arrangement is user intent, and a flat file makes a folder portable —
hand someone the folder and they get the arrangement too.

**Why it was rejected:**

*notes.txt:*
- It is the human-readable phone/OneDrive accessibility artifact. Interleaving x/y
  coordinates with user prose degrades exactly the property that justifies its existence.
- `writeNotesSection` in `src/notesParser.js` re-serialises whole sections. Every drag
  would rewrite the user's prose, risking their text to a presentation-layer operation.
- The TODO and reminder aggregators (`main/main.js` ~L733-771) parse notes files. Writing
  at drag-rate would churn them continuously.

*atlas.json:*
- **Decisive:** `writeAtlasJson` rebuilds the entire object from the DB on every call — it
  is not read-modify-write. Five call sites in `main/main.js` fire on category/tag/attribute
  changes. A `board` key would have been **erased by the user's next tag edit**.
- It is opt-in per category (`atlasJsonSync`), so Board would have needed a whole gating
  apparatus: a CHANGE/CANCEL modal, a Settings deep-link, and a field-highlight capability —
  all of it existing purely to work around the storage choice.
- Drag-rate writes into a directory would churn OneDrive/network sync.
- Per-file keying inside a directory-level JSON blob was always a structural stretch, and
  became untenable once board items grew ordered detail levels with per-level heights and
  per-level field selections. A relational table is the honest shape.

**What replaced it:** Tables in `src/db.js` — `dir_boards`, `board_items`, `board_groups`,
`board_annotations` — modelled on the existing `dir_grid_layouts` table, which is already
the precedent for per-directory view state in SQLite.

**Justifying the deviation from "files are king":** That principle protects *user data* from
proprietary formats. Board geometry is presentation, not data; the files themselves are
untouched and no user work becomes inaccessible outside Atlas. Reframed: the DB exists as
scaffolding for exactly this — a durable record of the filesystem that accepts mutations.

**Accepted costs:**
- `npm run db:reinit` destroys boards. Mitigation: the reinit script warns when board rows
  exist and offers to back up the DB by renaming the existing file. Import-from-backup is
  deliberately **not** built yet — revisit once the pain is understood.
- Folder portability is lost. Export/import is deferred for the same reason.

---

## board-grid-size

**Snap grid is hardcoded at 16px, deliberately not derived from font metrics**

**Date:** 2026-07-28

**What was tried:** Deriving `gridSize` from the board font's computed line-height, so that
a one-unit detail level would be exactly one readable line of text.

**Why it was tried:** The bottom detail level clamps to a minimum of one grid unit. If that
unit is smaller than a line of text, the level's first line clips.

**Why it was rejected (user-stated constraint):** A font-size change — app setting, OS
accessibility scaling, or a CSS tweak — would silently re-flow the geometry of every saved
board and misalign every widget. That is a catastrophic, irreversible failure mode used to
fix a cosmetic one. Per the user: minor text clipping in a squeezed level box is an
acceptable scuff; board-wide geometry drift is not.

**What replaced it:** `DEFAULT_GRID_SIZE = 16`, a hard constant. It is still persisted
per-board in `dir_boards.grid_size`, so it remains adjustable, but it is never computed.

---

## board-no-overlap

**No-overlap is preserved by geometry-first UI, not by validation**

**Date:** 2026-07-28

**Decision:** Board cards never grow to fit their content. Every content region — note
bodies, previews, folder contents trees, the tray — is a bounded, scrollable, user-sized box.

**Why:** The obvious implementation of "items must not overlap" is a validation pass that
rejects or repairs collisions after they occur. That approach fails as soon as content can
change size, because content changes outside the app (a note edited on a phone, a file
replaced) would silently invalidate a saved layout the user never touched.

Instead the interaction model makes overlap unrepresentable:

- To add a detail level you must **first resize the card to create the space**. The space
  created by the resize *is* the space the level occupies. Detail can never force a card to
  grow into a neighbour.
- Collision during drag/resize is handled by **clamping** (see `board-collision`), so
  geometry is legal at every instant rather than being validated after the fact.

Any future change that lets content drive card geometry breaks this invariant.

---

## board-collision

**Collision resolution is clamp — not reject, not push**

**Date:** 2026-07-28

**Decision:** A dragged item advances along the drag vector until it touches an obstruction
and stops at the maximum legal position. Clamping is per-axis, so sliding along an
obstruction's edge still moves freely on the free axis.

**Alternatives rejected:**
- **Reject / snap back.** Loses the user's partial progress and feels like a dead input,
  which violates the project's "no dead clicks" rule.
- **Push neighbours.** Displacement cascades. Groups are rigid and clamp as a single unit
  (see `board-groups`), so one push can cascade through an arbitrarily large rigid body —
  and the user never asked for those items to move.

---

## board-groups

**Groups are rigid bodies**

**Date:** 2026-07-28

**Decision:** Group members hold fixed relative offsets and never re-flow. The group's own
bounding border is itself a rigid rect that cannot collide with any other item or group.
Collision tests run against the group rect, not member-by-member, and clamping applies to
the whole group as a unit.

**Why:** A group whose members can shift relative to each other is not a group — it is a
multi-select. Testing member-by-member would also allow another item to be positioned
*inside* the group's visual border while technically not overlapping any member, which
reads as a rendering bug.

---

## board-mode-contract

**Edit mode is geometry-only; view mode is content-only. Zero overlap.**

**Date:** 2026-07-28

**Decision:** In edit mode, every item interaction is geometric — move, resize, group,
add/remove levels. Nothing opens, navigates, or shows a content context menu. In view mode,
no geometry change is possible at all; items open, navigate, and offer their normal context
menus exactly as in List view.

**Why (user-stated):** The board is a place users will click around in constantly. If both
vocabularies were live at once, every click would carry a risk of silently rearranging a
layout the user spent real effort on — and there is no undo for that. Separating them means
a user in view mode *cannot* damage their arrangement no matter what they click.

Consequence: edit mode is an explicit toggle, off by default, and only one panel may hold it
at a time (`boardEditLock`).

---

## board-tray-overlay

**The docked tray overlays the canvas rather than shrinking it**

**Date:** 2026-07-28

**Decision:** Docking the tray to an edge does not reduce the canvas area. The tray floats
above it. The dock is collapsible, which is what makes overlaying acceptable.

**Why:** If docking shrank the canvas, every dock/undock and every dock-edge change would
alter the available coordinate space, and items near the far edge would need to move.
Board coordinates must be stable against a pure UI action.

**Related:** Nothing is ever auto-placed on the canvas. Files without coordinates go to the
tray and must be dragged out. Auto-placement would litter arrangements the user curated, and
there is no correct default position.

---

## merge-browse-not-ignore

**"Ignore artifact" was replaced by "Browse…"**

**Date:** 2026-07-28

**What was tried:** Giving the reconciliation modal an "ignore this artifact" action
alongside "ignore this candidate".

**Why it was rejected (user's own resolution):** Ignoring an *artifact* has no coherent
meaning. The artifact is the user's own metadata — notes, coordinates, tags — pointing at a
file that has moved. The user does not want it silenced; they want it *reconnected*.

**What replaced it:** **Browse…** — if the artifact belongs to none of the ranked
candidates, the user browses to any file and the artifact assumes that file's identity.

The remaining actions are Accept, Ignore-candidate (persistent, survives restart), and
Cancel ("keep asking"). Cancel is also the answer for temporarily-absent files — unmounted
drives, offline shares. A separate "park" action was considered and deliberately **not**
built.

---

## timeline-view-tabled

**Timeline was designed as a view type, then tabled**

**Date:** 2026-07-28

**What was tried:** A Timeline entry in the view registry alongside List, Gallery, and
Board — files arranged along a date axis.

**Why it was rejected:** It is a grouping and sort concern, not a view type. Everything
Timeline would do — bucket by date, order chronologically, show date headers — belongs
inside List and Gallery as a grouping option, where it composes with columns, filters, and
selection rather than duplicating them.

**What replaced it:** Nothing, deliberately. Board became the third registry entry and the
proof that the registry is extensible. If timeline-style browsing is wanted later, it should
be built as grouping/sort within existing views.

This entry exists only so the idea is not re-proposed as a view type.
