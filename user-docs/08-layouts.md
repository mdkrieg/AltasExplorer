# 8. Layouts

← [Back to Contents](index.md)

---

## What is a Layout?

A layout captures a snapshot of the current window state, saved as an `.aly` file. Layouts can record:

- **Window layout** — which panels are open, which directories they show, and the sidebar width
- **Grid layout** — column visibility, order, widths, and sort order for the active directory

Layouts let you restore a multi-panel workspace with one action — useful for recurring projects or switching between different working contexts.

## Saving a Layout

Click the **Save Layout** button in the toolbar (or press `Ctrl+Shift+S`) to open the save options:

| Option                    | What it saves                                                |
|---------------------------|--------------------------------------------------------------|
| Save grid layout          | Column config and sort order for the current directory only  |
| Save window layout here   | Full window state as an `.aly` file in the current directory |
| Save window layout to…    | Full window state saved to a directory you choose            |
| Save window layout global | Full window state saved to your Atlas user profile           |

## Loading a Layout

- Press `Ctrl+Shift+L` to open a layout picker
- Or **double-click any `.aly` file** in the grid to restore that layout immediately

Global layouts (saved to your user profile) are available from any directory. Directory-local `.aly` files are visible in the grid alongside your other files and can be opened the same way.
