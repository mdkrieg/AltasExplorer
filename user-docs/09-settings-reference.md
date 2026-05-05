# 9. Settings Reference

← [Back to Contents](index.md)

---

Settings are opened from the toolbar or via the keyboard shortcut. Changes take effect immediately and show a brief inline confirmation — there are no popup alerts for routine saves.

---

## Browser Settings

General app behavior:

| Setting                   | Description                                                              |
|---------------------------|--------------------------------------------------------------------------|
| Home directory            | The directory Atlas opens to on launch                                   |
| Notes file format         | Markdown (`.md`) or plain text (`.txt`)                                 |
| Row height                | Compact / normal / relaxed grid row sizing                               |
| Show `.` / `..` entries   | Whether to display the current- and parent-directory meta entries       |
| Pin `.` / `..` to top     | Keep meta-directories at the top regardless of active sort column        |
| Background refresh        | Enable filesystem monitoring and set the polling interval                |
| Checksum concurrency      | How many checksum calculations to run in parallel                        |
| Title bar format          | What to show in the window title (path, display name, category, etc.)   |

---

## Categories

Create and manage directory categories. Each category defines:

- **Name** — used in dropdowns and the grid context menu
- **Background / text colors** — applied to the path bar and grid header
- **Icon initials** — short text shown as the folder icon (can inherit to subdirectories)
- **Display name** — optional override shown in the app title (can inherit to subdirectories)
- **Default view** — details (grid) or gallery (thumbnails)
- **Inherits** — whether the category automatically applies to all subdirectories
- **Description** — free text, shown in dropdowns

Categories are stored as JSON files in `~/.atlasexplorer/categories/` and can be shared or backed up freely.

---

## Tags

Create and manage tags. Each tag defines:

- **Name**
- **Background color**
- **Outline color**

Tags are stored in `~/.atlasexplorer/tags/`.

---

## Custom Attributes

Define structured metadata fields that appear as columns in the grid.

| Setting       | Description                                              |
|---------------|----------------------------------------------------------|
| Name          | Column header label                                      |
| Type          | text, number, yes/no, rating, selectable list, …        |
| Applies to    | Files, directories, or both (default: directories)      |
| Copyable      | Adds a one-click copy button in the grid cell           |

A global **Description** attribute is available by default.

---

## Auto-Labels

Define rules that automatically suggest categories and tags for matching items. Each rule can target:

- Name patterns (wildcard or regex)
- File type
- Other conditions

Pending suggestions show as a badge on the **Tagging** button. Open the Tagging modal to review, accept, or ignore them. Ignored suggestions are tracked per-file and won't reappear unless you clear them.

---

## File Types

Map filename patterns (e.g. `*.jpg`, `*.json`) to named types. Each file type can set:

- A custom icon
- An "open with" behavior: system default, Atlas image viewer, or Atlas editor

---

## Custom Actions

Add scripts or executables to the right-click context menu.

| Field          | Description                                                  |
|----------------|--------------------------------------------------------------|
| Label          | Text shown in the context menu                               |
| Executable     | Path to the script or program                                |
| Arguments      | Optional arguments; `{path}` is replaced with the file path |
| File pattern   | Limit the action to matching file types                      |
| Execution mode | Terminal (output shown) or background (silent)               |
| Timeout        | Optional max run time                                        |

---

## Hotkeys

Lists all keybindings. Most can be rebound: click a row, press **Edit**, then press your desired key combination. A small number of system-level bindings are locked. Changes take effect immediately.

See [Keyboard Shortcuts](10-keyboard-shortcuts.md) for the default bindings.
