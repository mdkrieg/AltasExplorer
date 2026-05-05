# 2. The Interface

← [Back to Contents](index.md)

---

## Overview

The main window consists of a collapsible **sidebar** on the left and up to **four panels** filling the rest of the screen. The sidebar offers navigation aids (favorites, TODOs, reminders) while panels are where you browse and work with files.

## The Sidebar

The sidebar is not tied to any one panel — it serves all of them at once. It contains:

- **Favorites** — pinned directories and files for quick access
- **Local Favorites** — paths found inside the current directory's `notes.txt`, shown only while you're browsing that directory; indicated with a badge showing the count
- **TODOs** — aggregated TODO items from all `notes.txt` files in open panels
- **Reminders** — aggregated reminders from all known `notes.txt` files, grouped by due date

The sidebar can be collapsed to icon-only mode to save screen space; all sections remain accessible as icon buttons.

### Targeting a Panel from Favorites

Right-clicking a favorite in the sidebar lets you choose which panel it opens in. This is useful when you want to navigate a specific panel without changing focus.

## Panels

Panels are the heart of the app. Each panel is an independent view that can show a directory, a file editor, or an item summary. Up to **four** panels can be open at the same time, letting you compare directories, copy between locations, or keep a reference file open alongside your work.

Open a new panel with `Ctrl+T`. Close the active panel with `Ctrl+W`. Reopen the last closed panel with `Ctrl+Shift+T`. Cycle focus between panels (and the sidebar) with `Tab`.

## The Toolbar

The toolbar runs across the top of each panel and contains:

- **Back / Forward** buttons (`Alt+Left` / `Alt+Right`)
- **Up** button — go to the parent directory (`Alt+Up`)
- **Path bar** — styled with the active directory's category colors; click or press `Ctrl+L` to edit
- **Search / filter** input — start typing to filter visible items by name
- **Tagging** button — opens the Tagging modal; badge shows pending auto-label suggestions
- **Save Layout** button — saves the current window or grid layout (see [Layouts](08-layouts.md))
- **Refresh** button

## Status Notifications

Settings saves and other non-critical operations show a brief inline status message rather than a popup alert. Popup alerts are reserved for errors that require attention.
