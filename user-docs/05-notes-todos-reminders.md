# 5. Notes, TODOs & Reminders

← [Back to Contents](index.md)

---

## Viewing Notes for Multiple Items

When the properties panel shows multiple selected items, the Notes section displays one collapsible block per item. Items that already have notes are shown in **bold** in the summary line so you can see at a glance which items need attention. Expand any block to read or compare the note content. Editing individual notes from this view is not supported — open a single item's properties to edit.

---

## notes.txt

Every directory can have a `notes.txt` file containing free-form Markdown. Atlas Explorer renders it with full Markdown support — including tables, code blocks, and images — and lets you edit it directly in the app.

Because it's a plain text file, you can also read and edit it in any text editor, on another machine, or on a phone. Atlas picks up the changes the next time you browse that directory.

### Pasting Screenshots into Notes

When the notes editor is focused, you can **paste an image** (e.g. a screenshot from the clipboard) directly into the editor. Atlas automatically saves the image as a file inside a `notes_files/` subfolder of the current directory and inserts a Markdown image link at the cursor position. The image is rendered inline in the notes preview.

When a pasted image appears inside a **TODO item**, it is displayed as a thumbnail link rather than an inline image to keep the TODO list compact. Hovering the link shows a tooltip preview of the image.

### Markdown rendering notes

- A **single line break** in `notes.txt` is rendered as a line break (not collapsed into a paragraph)
- A **blank line** between paragraphs adds the normal extra spacing
- Web links in notes open in the system browser; they do not navigate inside the app

## Tags in Notes

Adding `@#tagname` anywhere on a line in `notes.txt` applies that tag to the directory:

```
This project is in progress. @#active @#priority
```

If you later remove the tag through the app's UI, it becomes **archived** in the notes file — the `@` prefix is stripped, leaving just `#tagname`. The text stays in the file as a historical record. If you later re-add the same tag through the UI, the `@` is restored automatically.

## Local Favorites in Notes

Any **valid filesystem path** that appears in `notes.txt` (one per line, plain text) is picked up as a **local favorite** for that directory. Local favorites appear in the sidebar while you are browsing the directory that contains the notes file. The sidebar shows a badge with the count of local favorites; the section starts collapsed.

## TODOs

TODO items in `notes.txt` follow a simple prefix convention:

```
* [ ] Something still to do
* [x] Something already done
```

Atlas Explorer aggregates these across all `notes.txt` files it finds in the open panels and displays them in the sidebar's **TODO** section. You can add comments and replies to individual items from within the app; the underlying file is updated accordingly.

## Reminders

Lines formatted as `REMINDER (date): text` are picked up as reminders:

```
REMINDER (2026-06-01): Renew SSL certificate
```

Reminders are aggregated across all known notes files and displayed in the sidebar's **Reminders** section, sorted into groups: Past Due, Today, Tomorrow, This Week, and Later. You can create or edit reminders by editing the `notes.txt` file directly — no special modal required.
