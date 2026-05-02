# Core Concepts

## Panels

**Panels are the heart of Atlas Explorer.** They are what allow the user to work on and reference multiple things at once. Anything that lives inside a panel is **panel-hosted**.

### Panel anatomy

- A panel **always** has an editable path-bar on top, colored with the assigned category of the displayed directory (or the nearest parent directory if a file or other item is shown).
- A panel can display:
  - A directory (grid or gallery view).
  - A file viewer/editor.
  - A file properties summary.
  - Other panel-hosted views in the future.
- Anything in a panel is identifiable by a **URI** (see below).
- A modal popup may also act as a panel-like surface (its exact role is still being shaped).

### Hard cap: 4 panels

There is a fixed maximum of **4 panels** (the modal is not counted). The cap is intentional — don't introduce a 5th slot without explicitly revisiting this constraint.

## URIs

Atlas Explorer uses a URI scheme borrowed from HTTP to identify panel content and sub-state. When code or documentation refers to a "URI" in this app, this is what's meant — *not* a network URL.

A URI can include:

- A **path** (the resource — directory, file, etc.).
- A **query string** (`?param1=...&param2=...`) for parameters.
- A **fragment** (`#edit`, etc.) for sub-states like edit mode.

The URI is the canonical handle for "what is this panel showing right now."

## The P1-Pn+1 pattern

This is a recurring UI pattern for any action that targets a panel. It governs how those actions are presented in the interface.

### The variables

- `n` — the number of currently opened panels (modal not counted).
- `P1..Pn` — buttons (or menu items) corresponding to each currently open panel.
- `Pn+1` — one extra slot that **opens a new panel** and applies the action there.

### The full pattern: P1-Pn+1

Used when "open in a new panel" is a sensible additional option.

- When `n < 4`, the array shows P1, P2, ..., Pn, and one Pn+1 slot.
- When `n = 4`, the +1 slot is hidden — there's no room for a new panel.

### The capped pattern: P1-Pn

Used when offering "open in a new panel" would be inappropriate. No +1 slot.

### Label style depends on orientation

- **Horizontal** layouts (toolbars, button rows) → succinct labels:
  - `P1`, `P2`, `P3`, `P4`
  - The new-panel slot uses something like `P2+` to denote it opens a *new* panel.
- **Vertical** layouts (context menus, dropdowns) → long labels:
  - `Open in Panel 1`, `Open in Panel 2`, ...
  - The new-panel slot uses something like `Open in new Panel 2`.

Whatever the form, the Pn+1 slot must visually denote that it opens a new panel.

## Sidebar (intentionally not panel-bound)

The sidebar is **not** tied to any single panel — it's a helper for *all* panels. This is a deliberate UX decision.

- The sidebar aggregates **LOCAL FAVORITES** (Windows shortcuts) from all opened panels.
- Any favorite can be pushed to any panel.
- TODOs and REMINDERs are aggregated from notes files in all opened panels.
- A **Tab-key focus pattern** trades focus between panels and the sidebar, supporting mouseless interaction.

When adding sidebar features, do *not* couple them to a single panel.

## Categories and tags

Both are user-defined labels applied to directories (and files where applicable). They are the practical realization of the "labels, not folders" insight (see [Vision](vision.md)).

- **Definitions** live in flat JSON files (shareable across users).
- **Associations** (which directory has which label) live in SQLite (searchable, doesn't pollute shared file servers).

See [Architecture](architecture.md) for the full SQLite-vs-flat-file split.

## Notes, TODOs, and REMINDERs

Each directory may have a `notes.txt`. The format is plain text — readable in any editor, on a phone via OneDrive, on a thumbdrive backup.

Atlas parses these files and surfaces:

- **TODOs** — items the user wants to track.
- **REMINDERs** — items in the form `REMINDER (date): reminder text`. Aggregated across all known notes files, bucketed by due date, with breadcrumbs back to the source directory.

Aggregation is a backend concern — it has to read filesystem files and report a single dataset to the renderer. See [`src/reminderAggregator.js`](../src/reminderAggregator.js) and [`src/todoAggregator.js`](../src/todoAggregator.js).

Users can set a reminder by editing a text file — they don't even need to open the app. Once they do open it, the reminder shows up in the aggregated view.
