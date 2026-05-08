# 3. Navigating Your Files

← [Back to Contents](index.md)

---

## Panel Path Bar

Each panel has a path bar at the top, styled with the background and text colors of the directory's assigned category. Click it or press `Ctrl+L` to type a path directly; autocomplete suggestions appear as you type.

## Back, Forward & Up

Navigate history within a panel with `Alt+Left` (back) and `Alt+Right` (forward). Go to the parent directory with `Alt+Up`. The toolbar also exposes these as icon buttons.

## Grid View

The default directory view. Files and folders are listed in a sortable, filterable table.

- **Filter by name** — start typing anywhere in the grid to filter the visible list instantly
- **Sort** — click any column header to sort; right-click a column header for Sort Asc / Sort Desc / Filter / resize options
- **Show / hide columns** — right-click the icon-column header to open the column organiser; toggle a "Reorder columns" mode to drag columns into a new order
- **Resize columns** — drag column borders; percentile-fit resize is available per column type
- **Column memory** — column visibility, order, widths, and sort order are saved per directory

### Meta-directory pinning

`.` and `..` entries can be pinned to the top of the sort order regardless of the active sort column — configure this in **Settings → Browser**.

### Depth view

Directories can be browsed at depth > 0 to show the contents of subdirectories inline. Configure the depth in the toolbar.

## Deep Search

Deep Search lets you find files and folders anywhere inside a directory tree in one step. To start a search, focus the toolbar search box and press **Enter** (or click the search icon). While a deep search is active the depth control is hidden and two extra columns appear:

| Column | Description |
|--------|-------------|
| **Score** | Relevance score (0–100). Higher means a closer match. |
| **Path** | Path of the result relative to the search root. |

### How it works — two phases

**Phase 1 — database** (instant): The app queries the SQLite index for everything under the current directory that matches the search term in the **filename**, **tags**, or **custom attributes**. Results appear immediately before the filesystem walk begins.

**Phase 2 — filesystem walk** (progressive): A breadth-first scan of the directory tree finds any files or folders that are new or not yet indexed. New discoveries are highlighted in **blue** briefly as they arrive. Items found in Phase 1 are not duplicated.

At the end of the walk, any Phase 1 result whose path no longer exists on disk is flagged as an **orphan** — its row is styled distinctly to indicate the file has moved or been deleted.

### What is matched

| Source | Highlighted? |
|--------|-------------|
| Filename | Yes — matching characters are marked in the Name column |
| Tags | Yes — matching tag badges are highlighted |
| Notes content | Yes — the Notes cell is tinted when the query hit notes text |
| TODO content | Yes — the TODO cell is tinted when the query hit TODO text |
| Custom attributes | Values are shown as in normal browse; the attribute column is only present if the search root's known items use it |

### Scoring

Matches are ranked by score. The scoring tiers for filename matches are:

| Score | Meaning |
|-------|---------|
| 100 | Exact match (case-insensitive) |
| 90 | Prefix match — filename starts with the query |
| 80 | Contains — filename contains the query as a substring |
| 60 | Fuzzy full-name — Damerau-Levenshtein distance ≤ 1 |
| 50 | Word-break — query matches the start of any word in the filename |
| 40 | Word-break fuzzy — fuzzy match against a word in the filename |
| 25–35 | Tag, attribute, or notes-only match |

Bonus points are added when multiple sources (filename + tags + notes) all match.

### Navigation with Deep Search

- **Back / Forward** work across search results — pressing back after double-clicking into a subfolder returns you to the search.
- Navigating to a new directory (via the path bar, double-click, sidebar, or favorite) **exits** the search and resets the search bar.
- Re-pressing back from a directory you navigated to **restores** the search results.
- To stop a search without navigating away, click the **×** (stop) button that appears in the toolbar while searching.

## Gallery View

A thumbnail-based view for image-heavy directories. Enable it per category in **Settings → Categories**. The gallery view supports the same search/filter toolbar as the grid.

## Item Properties

Selecting an item in the grid shows its properties in the active panel's summary area — or as a dedicated panel view if configured. The summary includes:

- File metadata (size, dates, type)
- Assigned category, tags, and custom attribute values
- EXIF data (for image files that carry it)
- Change history (audit trail entries for this item)
- A button to open the full history modal

The summary updates as you move the selection. Press `Ctrl+Enter` to open the selected item in a new panel.

### Multi-Select Properties

Right-clicking while multiple items are selected and choosing **Properties (+n)** opens the properties view for all selected items at once. The header lists each item grouped by type (files / directories). The rest of the panel adapts to show combined information:

- **Tags** — intersection tags (shared by all items) are shown normally. Tags held by only *some* items appear in a separate row; each such tag has a **`+` button inside the chip** that promotes it to all items.
- **Category** — if all selected directories share one category, the normal picker is shown. If they differ, an **Assign Category** dropdown lets you apply a single category to all of them at once. Files display the category inherited from their parent directory (read-only).
- **Initials & Display Name** — saving applies to all selected directories.
- **Information** — shows the total size, the full list of parent directories, type breakdown (n files / n directories), and the date range spanned by the items' modified times.
- **EXIF** — hidden when multiple items are selected.
- **Notes** — one collapsible `<details>` block per item. Items that have existing notes are shown in **bold**; items with no notes show a grey placeholder.
- **History** — a merged timeline of all items' change events, sorted by time, with an Item column identifying the source. Panel-picker buttons (`P1`, `P2 …`) open the combined history in a dedicated panel, preserving the multi-select context.

The URI stored in the path bar and navigation history fully encodes the multi-select context (`?properties&auxitems=…`), so back/forward navigation and layout saves all work correctly for multi-select properties views.

## Built-in Terminal

Press `Ctrl+J` to open a terminal panel rooted at the active directory. Useful for running commands without leaving the app.

## Cycling Panels

Press `Tab` to cycle focus between open panels and the sidebar without touching the mouse.
