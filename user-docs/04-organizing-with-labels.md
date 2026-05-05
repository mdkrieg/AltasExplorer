# 4. Organizing with Labels

← [Back to Contents](index.md)

---

## Categories

Categories are applied to **directories** and give them a visual identity — a background color, text color, and optional icon initials. They influence:

- The color scheme of the path bar and grid header
- Whether gallery (thumbnail) mode is used by default
- Checksum monitoring behavior
- Inheritance rules for subdirectories

Manage categories in **Settings → Categories**. Each category is stored as a JSON file in your user profile and can be shared or version-controlled.

### Category Inheritance

A category can be configured to automatically apply to all subdirectories. This means a whole project tree can carry consistent styling and settings without manually labelling every folder. The inheritance setting is shown in category dropdowns throughout the app.

### Display Names

Directories can have a custom display name that appears in the app title and path bar, without renaming the actual folder on disk. Display names can also be set to inherit down to child directories, the same way initials do.

### Labels in Multi-Select

When multiple directories are selected in the properties panel, the **Initials** and **Display Name** fields reflect the shared value if all items agree, or show a placeholder if values differ. Saving either field applies the new value to every selected directory at once.

## Tags

Tags are short colored labels that can be applied to **files or directories**. They are searchable and appear as a column in the grid.

- Use the **`+` icon** in the tags column to quickly add a tag to any item
- Tags can also be defined in a directory's `notes.txt` file — see [Notes, TODOs & Reminders](05-notes-todos-reminders.md)
- Tag color (background and outline) is configured per tag in **Settings → Tags**

### Tags in Multi-Select

When the properties panel shows multiple selected items, tags are split into two groups:

- **Intersection tags** — held by every selected item. Displayed and removable as normal.
- **Some tags** — held by at least one but not all items. Displayed in a secondary row with a **`+` button inside each chip**. Clicking `+` promotes that tag to all selected items.

Adding a new tag through the tag editor applies it to every selected item simultaneously.

## Custom Attributes

Attributes are user-defined metadata fields that appear as columns in the grid. Supported types: text, number, yes/no, rating, selectable list, and more.

- Each attribute can be scoped to **files**, **directories**, or **both**
- Mark an attribute as **copyable** to add a one-click copy button in the grid column
- A global **Description** attribute is available by default

Manage attributes in **Settings → Custom Attributes**.

## Auto-Labels

Auto-label rules automatically suggest or apply categories and tags to items matching configured conditions (name patterns, regex, and others).

- Pending suggestions appear as a **badge count** on the Tagging button in the toolbar
- Opening the Tagging modal shows a summary of pending suggestions — you can accept, ignore, or skip individual items
- Ignored suggestions are remembered per-file so they won't reappear; adding a tag manually removes the item from the ignored list

Manage rules in **Settings → Auto-Labels**.
