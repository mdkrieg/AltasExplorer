# 1. Getting Started

← [Back to Contents](index.md)

---

## First Launch & Home Directory

Set your home directory in **Settings → Browser** so Atlas Explorer knows where to start when it opens. This is the root of your working world — you can still navigate anywhere on your system from there.

## Your Data & Files

Atlas Explorer stores its metadata (labels, history, monitoring rules) in a local SQLite database, but keeps your notes and label definitions as plain files you can open anywhere. Nothing is locked into the app — you can work with your files in Windows Explorer, on a phone, or on another machine, and Atlas will pick up the changes when you return.

User data lives in `%USERPROFILE%\.atlas-explorer\`:

| File / folder           | What it stores                                      |
|-------------------------|-----------------------------------------------------|
| `settings.json`         | Browser and app preferences                        |
| `categories/`           | One JSON file per category definition               |
| `tags/`                 | One JSON file per tag definition                    |
| `attributes/`           | One JSON file per custom attribute definition       |
| `auto-labels/`          | Auto-label rule definitions                         |
| `filetypes.json`        | File type → icon / open-with mappings               |
| `custom-actions.json`   | Right-click context menu script definitions         |
| `layouts/`              | Global `.aly` layout files                          |
| `hotkeys.json`          | Hotkey bindings (if customised)                     |

Because these are all plain JSON or text files, they are easy to back up, version-control, or share with another machine.
