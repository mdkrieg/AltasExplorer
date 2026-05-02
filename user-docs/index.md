# Atlas Explorer — User Documentation

Atlas Explorer is a file explorer built for power users who want richer tools atop their plain filesystem — labelling, notes, monitoring, and more — without locking files into a proprietary system.

---

## Contents

1. [Getting Started](#1-getting-started)
2. [The Interface](#2-the-interface)
3. [Navigating Your Files](#3-navigating-your-files)
4. [Organizing with Labels](#4-organizing-with-labels)
5. [Notes, TODOs & Reminders](#5-notes-todos--reminders)
6. [Monitoring & Alerts](#6-monitoring--alerts)
7. [File Operations](#7-file-operations)
8. [Layouts](#8-layouts)
9. [Settings Reference](#9-settings-reference)
10. [Keyboard Shortcuts](#10-keyboard-shortcuts)

---

## 1. Getting Started

### First Launch & Home Directory
Set your home directory in Settings → Browser so Atlas Explorer knows where to start when it opens. This is the root of your working world — you can still navigate anywhere on your system from there.

### Your Data & Files
Atlas Explorer stores its metadata (labels, history, monitoring rules) in a local database, but keeps your notes and label definitions as plain files you can open anywhere. Nothing is locked into the app — you can work with your files in Windows Explorer, on a phone, or on another machine, and Atlas will pick up the changes when you return.

---

## 2. The Interface

### Overview
The main window consists of a collapsible **sidebar** on the left and up to **four panels** filling the rest of the screen. The sidebar offers navigation aids (favorites, TODOs, reminders) while panels are where you browse and work with files.

### The Sidebar
The sidebar is not tied to any one panel — it serves all of them at once. It contains your favorites, aggregated TODOs, aggregated reminders, and quick-access navigation. It can be collapsed to icons to save space.

### Panels
Panels are the heart of the app. Each panel is an independent view that can show a directory, a file, or an item summary. Up to four panels can be open at the same time, letting you compare, copy between, or reference multiple locations simultaneously.

---

## 3. Navigating Your Files

### Panel Path Bar
Each panel has a path bar at the top, styled with the colors of the directory's assigned category. Click it or press `Ctrl+L` to type a path directly; autocomplete suggestions appear as you type.

### Back, Forward & Up
Navigate history within a panel with `Alt+Left` and `Alt+Right`. Go to the parent directory with `Alt+Up`. The toolbar also exposes these as buttons.

### Grid View
The default directory view. Files and folders are listed with sortable, filterable columns. Start typing to filter by name. Columns can be shown/hidden, reordered, and resized, and those preferences are saved per directory.

### Gallery View
A thumbnail-based view for image-heavy directories. Enabled per category — configure it in Settings → Categories.

### Item Properties
Selecting an item in the grid shows its properties (metadata, tags, attributes, history) in a panel-hosted summary view. This updates as you move the selection.

### Built-in Terminal
Press `Ctrl+J` to open a terminal panel rooted at the active directory. Useful for running commands without leaving the app.

### Cycling Panels
Press `Tab` to cycle focus between open panels and the sidebar without touching the mouse.

---

## 4. Organizing with Labels

### Categories
Categories are applied to **directories** and give them a visual identity — a background color, text color, and optional icon initials. They drive gallery mode, checksum monitoring, and inheritance rules. The path bar and grid header reflect the assigned category's colors.

### Category Inheritance
A category can be configured to automatically apply to all subdirectories, so a whole project tree can carry consistent styling and settings without manually labelling every folder.

### Display Names
Directories can have a custom display name that appears in the app title and path bar, without renaming the actual folder. Display names can also inherit down to child directories.

### Tags
Tags are short labels that can be applied to **files or directories**. They are colored, searchable, and can be set directly from the grid (using the `+` icon in the tags column) or from within a `notes.txt` file using the `@#tagname` syntax.

### Custom Attributes
Attributes are user-defined fields that add structured metadata to files or directories — text, numbers, yes/no toggles, ratings, dropdowns, and more. They appear as columns in the grid and are searchable. Attributes can be scoped to files, directories, or both.

### Auto-Labels
Auto-label rules automatically apply categories or tags to files and directories that match configured conditions (name patterns, regex, etc.). A badge on the Tagging button indicates pending auto-label suggestions waiting for your review.

---

## 5. Notes, TODOs & Reminders

### notes.txt
Every directory can have a `notes.txt` file with free-form Markdown content. Atlas Explorer renders it with full Markdown support and lets you edit it directly in the app. Because it's a plain text file, you can also read and edit it anywhere — a phone, another machine, a text editor.

### Tags in Notes
Adding `@#tagname` to a line in `notes.txt` applies that tag to the directory. If you later remove the tag through the app, it becomes "archived" in the notes file (prefixed with `#` only) so the history is preserved.

### Local Favorites in Notes
Any valid file path appearing in `notes.txt` is automatically picked up as a **local favorite** for that directory and shown in the sidebar when you're browsing it.

### TODOs
TODO items in `notes.txt` (prefixed with `* [ ]`, `* [x]`, etc.) are aggregated across all open panels and displayed in the sidebar's TODO section. Comments and replies can be added to individual items from within the app.

### Reminders
Lines in `notes.txt` formatted as `REMINDER (date): reminder text` are aggregated across all known notes files and displayed in the sidebar's Reminders section, grouped by due date (Past Due, Today, Tomorrow, This Week, etc.). You can set a reminder by editing a text file directly — no need to open the app.

---

## 6. Monitoring & Alerts

### Background Monitoring
Atlas Explorer can watch directories in the background for filesystem changes (files added, modified, deleted, renamed). Enable it in Settings → Browser and configure the refresh interval.

### Monitoring Rules
Monitoring rules define what to watch — a combination of category, tags, and attributes. When a matching change is detected, it is recorded in the audit trail and can trigger an alert.

### Alerts
Alerts fire when a monitoring rule condition is met. The alert configuration lets you define which categories, tags, and attributes should produce a notification, and what kind of change triggers it.

### Alert Summary
The alert summary shows all pending alerts and allows you to acknowledge or dismiss them in bulk (Select All supported).

### Audit Trail & History
Atlas Explorer records a history of changes as you browse — file additions, deletions, modifications, category changes, and more. The history for any item is accessible from its Item Properties view.

### Checksums
Checksum monitoring (SHA-based) can be enabled per category. When a file's checksum changes, that change is recorded in the audit trail and can trigger an alert.

---

## 7. File Operations

### Opening Files
Double-clicking a file opens it in the default application. Files can also be opened in a specific panel, in the built-in viewer/editor, or in the image viewer depending on the file type configuration.

### Viewing & Editing Files
Plain text and code files open in a Monaco-powered editor inside a panel. Images open in a built-in image viewer. Any file can be opened in hex view from the context menu.

### New Folder
Press `Ctrl+Shift+N` to create a new folder. A modal prompts for the folder name — the folder is not created inline to avoid accidental creations.

### Drag & Drop
Files and folders can be dragged between panels and to external applications. The **Drag Tray** (`Ctrl+D`) opens a small always-on-top window you can use as a staging area when moving files between applications.

### Copy as Path
Available in the right-click context menu on any file or folder. Copies the full path to the clipboard.

### Deleting Files
Press `Delete` to delete selected items. A confirmation is shown before the operation proceeds.

### Custom Context Menu Actions
User-defined scripts or executables can be added to the right-click context menu (configured in Settings → Custom Actions). Actions can target specific file types and run in a terminal or in the background.

---

## 8. Layouts

### What is a Layout?
A layout captures the current window state — which panels are open, which directories they're showing, the sidebar width, and optionally the grid column configuration. Layouts are saved as `.aly` files.

### Saving a Layout
Press `Ctrl+Shift+S` or use the Save button in the toolbar. Options include saving the grid layout (column arrangement and sort order), the window layout to the current directory, to any directory, or as a global default.

### Loading a Layout
Press `Ctrl+Shift+L` to load a layout, or simply double-click any `.aly` file in the grid to restore it.

---

## 9. Settings Reference

### Browser Settings
General app behavior: home directory, notes file format (Markdown or plain text), row height, whether to show `.` and `..` entries, whether to pin them to the top of the sort, background refresh interval, checksum concurrency, and title bar format.

### Categories
Create and manage directory categories. Each category has a name, background/text colors, optional icon initials, a description, a default display mode (details or gallery), and inheritance settings. Categories are stored as JSON files in your user profile and are shareable.

### Tags
Create and manage tags. Each tag has a name, a background color, and an outline color. Tags are also stored as JSON files in your user profile.

### Custom Attributes
Define custom metadata fields that appear as columns in the grid. Attribute types include text, number, yes/no, rating, selectable list, and more. Each attribute can be scoped to files, directories, or both, and can be marked as "copyable" to add a quick-copy button in the grid.

### Auto-Labels
Define rules that automatically suggest or apply categories and tags based on file or directory patterns. Rules support name matching, regex, and other conditions. Pending suggestions show as a badge on the Tagging button.

### File Types
Map filename patterns (e.g., `*.json`, `*.jpg`) to a named type. Each file type can have a custom icon and a configured "open with" behavior (system default, Atlas image viewer, or Atlas editor).

### Custom Actions
Add your own scripts or executables to the right-click context menu. Each action has a label, an executable path, optional arguments, a target file-pattern filter, an execution mode (terminal or background), and an optional timeout.

### Hotkeys
A full list of all keybindings. Most hotkeys can be rebound — click a row, press Edit, then press your new key combination. Some system-level bindings are locked. Changes take effect immediately.

---

## 10. Keyboard Shortcuts

| Action                    | Default         |
|---------------------------|-----------------|
| Navigate Back             | `Alt+Left`      |
| Navigate Forward          | `Alt+Right`     |
| Go to Parent Directory    | `Alt+Up`        |
| Focus Path Bar            | `Ctrl+L`        |
| Add Panel                 | `Ctrl+T`        |
| Close Active Panel        | `Ctrl+W`        |
| Reopen Last Closed Panel  | `Ctrl+Shift+T`  |
| Open Terminal Panel       | `Ctrl+J`        |
| Open Item (in new panel)  | `Ctrl+Enter`    |
| Cycle Panel Focus         | `Tab`           |
| Edit File                 | `Ctrl+E`        |
| Save File                 | `Ctrl+S`        |
| New Folder                | `Ctrl+Shift+N`  |
| Save Layout               | `Ctrl+Shift+S`  |
| Load Layout               | `Ctrl+Shift+L`  |
| Open Drag Tray            | `Ctrl+D`        |
| Grid Row Up / Down        | `↑` / `↓`       |

All hotkeys (except locked system bindings) can be rebound in **Settings → Hotkeys**.
