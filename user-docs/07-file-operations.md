# 7. File Operations

← [Back to Contents](index.md)

---

## Opening Files

Double-clicking a file opens it in its default application. The behavior can be overridden per file type in **Settings → File Types** — options include opening in the Atlas image viewer or the built-in editor.

## Viewing & Editing Files

Plain text and code files open in a Monaco-powered editor inside a panel. Images open in a built-in image viewer. Any file can be opened in hex view from the right-click context menu.

## New Folder

Press `Ctrl+Shift+N` to create a new folder. A modal prompts for the name — no inline editing, so there are no accidental creations from stray keypresses.

## Drag & Drop

Files and folders can be dragged between panels. The **Drag Tray** (`Ctrl+D`) opens a small always-on-top floating window you can use as a staging area when moving files between Atlas and other applications.

## Copy as Path

Right-click any file or folder and choose **Copy as Path** to copy the full filesystem path to the clipboard.

## Deleting Files

Select items and press `Delete`. A confirmation modal is shown before anything is removed.

## Custom Context Menu Actions

User-defined scripts or executables can be added to the right-click context menu. Each action can:

- Be scoped to specific file type patterns
- Run in a terminal (output visible) or in the background
- Pass the selected file path as an argument

Configure actions in **Settings → Custom Actions**.
