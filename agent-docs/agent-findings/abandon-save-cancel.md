# Abandon / Save / Cancel — audit findings

Audit of every user-interactable surface that can hold unsaved state, and what
happens to that state when the surface is dismissed. **Findings only — nothing
in this document has been implemented.** (The Ctrl+Enter half of the audit *has*
been implemented; see `public/js/modules/commitKeys.js`.)

Status as of the audit: 2026-07-31, branch `master` at `42eff69`.

---

## 1. Three idioms already exist for the same job

Worth picking one before adding more, because all three are currently in use:

| Idiom | Where | Shape |
|---|---|---|
| `w2confirm` popup | [notes.js:976](../../public/js/modules/notes.js#L976) | Modal dialog: "Abandon" / "Keep Editing" |
| `w2utils.message` anchored in-panel | [notes.js:963](../../public/js/modules/notes.js#L963) | Same buttons, rendered inside the panel instead of over the app |
| Armed inline button | [gridLayoutSettings.js:173](../../public/js/modules/gridLayoutSettings.js#L173) | Cancel becomes "Discard changes?" for 2.5s; a second click discards. No popup at all. |

**Recommendation: standardise on the armed-inline-button idiom.** It is the only
one that does not interrupt, which matches the design principle that the app
should not stop you to ask questions. It also degrades gracefully — if you ignore
it, it disarms itself and nothing happened.

The `w2utils.message` variant is a reasonable second choice where the surface is
panel-hosted and an inline button has nowhere to live.

---

## 2. Guarded today (working correctly)

- **File viewer edit, Cancel button** — [`cancelFileViewerEdit()`](../../public/js/modules/notes.js#L959).
  Abandon / Keep Editing, with a panel-hosted variant when the viewer is docked
  in a panel rather than a modal.
- **Panel close and app close with notes in edit mode** —
  [`closeActivePanel()` / `handleCloseRequest()`](../../public/js/modules/panels.js#L8261).
  "Save & Close" / "Keep Editing", and "Exit Anyway" / "Cancel" respectively.
  Note this is the only place that offers **Save** as well as Abandon.
- **Grid Layout Settings** — armed Cancel, and it correctly guards the backdrop
  click too ([gridLayoutSettings.js:647](../../public/js/modules/gridLayoutSettings.js#L647)).

---

## 3. Missing, ordered by what it costs the user

### 3.1 Notes modal — highest impact

[`hideNotesModal()`](../../public/js/modules/notes.js#L683) discards
unconditionally. Reachable three ways, none guarded:

- Escape — [renderer.js:1116](../../public/js/renderer.js#L1116)
- X button — [renderer.js:1718](../../public/js/renderer.js#L1718)
- **Backdrop click** — [renderer.js:1731](../../public/js/renderer.js#L1731)

This is the worst one because the modal **auto-enters edit mode when the section
is empty** ([notes.js:602-608](../../public/js/modules/notes.js#L602-L608)). So
the flow "open notes on a file that has none, type a paragraph, click slightly
outside the box" destroys the paragraph with no warning and no undo.

### 3.2 File viewer — the guard has two doors, one unlocked

`cancelFileViewerEdit()` confirms properly, but
[`hideFileViewerModal()`](../../public/js/modules/notes.js#L1042) has no dirty
check at all, and it is what Escape ([renderer.js:1111](../../public/js/renderer.js#L1111))
and `#btn-fv-close` ([renderer.js:1738](../../public/js/renderer.js#L1738)) call.

Same protection, same content, two exits — one asks, one doesn't. Fixing this is
cheap: route both through `cancelFileViewerEdit()`'s dirty check first.

### 3.3 Item properties widget

[`hideItemPropsWidget()`](../../public/js/modules/panels.js#L9703) resets
`attrEditMode` and `notesEditMode` and disposes the notes Monaco editor with no
check. Reached by Escape ([renderer.js:1096](../../public/js/renderer.js#L1096))
and `#btn-ip-close`. Loses both in-progress attribute edits and note text.

### 3.4 TODO modal

`closeTodoModal()` on the Cancel button **and on backdrop click**
([todos.js:865](../../public/js/modules/todos.js#L865)). Discards pending items,
comments, replies, and any active inline edit.

Partially mitigated now: `saveTodo()` auto-confirms rows still in edit mode and
(as of the Ctrl+Enter work) also flushes text typed into add fields but never
submitted. That protects the **save** path — the **cancel/backdrop** path still
drops everything silently.

### 3.5 Reminder modal

Same shape as the TODO modal —
[reminders.js:471-474](../../public/js/modules/reminders.js#L471-L474) wires both
Cancel and backdrop straight to `closeReminderModal()`.

### 3.6 Settings modal

Backdrop click ([renderer.js:1575](../../public/js/renderer.js#L1575)) and the
Close button, with a possibly half-filled category / tag / attribute / file-type
/ custom-action / hotkey form underneath. No dirty tracking exists for any of
these forms, so implementing this needs the forms to track dirty state first —
this is the most expensive item on the list.

### 3.7 Tagging modal and Alerts modal

Backdrop click on both ([renderer.js:1560](../../public/js/renderer.js#L1560),
[renderer.js:1770](../../public/js/renderer.js#L1770)) plus their Close buttons.
The Alerts rule editors in particular can hold a substantially filled-in rule.

---

## 4. The cross-cutting fix

**Backdrop click is the single most dangerous exit in the app.** It is wired on
notes, todo, reminder, settings, tagging, alerts, history, item-tag-create, and
grid-layout-settings — and only grid-layout-settings guards it.

It is also the exit most likely to be hit *by accident*, since it requires no
intent beyond a slightly-off mouse click. Escape and the X button are at least
deliberate.

**Cheapest high-value change:** make backdrop click never discard unsaved state.
Either ignore it entirely while the surface is dirty, or route it through the
same `requestClose()` path the Cancel button uses. One change, and it closes the
accidental-loss case on every modal at once — without needing per-form dirty
tracking everywhere first, if "dirty" starts out coarse (any edit mode active).

Suggested order of work:

1. Backdrop-click guard across all modals (coarse dirty check).
2. Notes modal + file viewer Escape/X paths (3.1, 3.2) — real content loss, small fix.
3. Item properties widget (3.3).
4. TODO / Reminder cancel paths (3.4, 3.5).
5. Settings / Tagging / Alerts (3.6, 3.7) — needs per-form dirty tracking, do last.

---

## 5. Where this pattern should NOT apply

Flagging these explicitly so they don't get swept up in a blanket change — in
each case the confirmation would cost more than the loss it prevents:

- **History modal, image viewer, load-layout, aly-open** — read-only or pure
  selection. Nothing to abandon.
- **Board edit mode** — writes flush continuously
  ([board.js:81](../../public/js/modules/board.js#L81)). There is no unsaved
  state, so a prompt would be pure noise.
- **Paste text / paste image modals** — the source is still on the clipboard.
  Re-pasting is cheaper than a dialog.
- **New folder / rename** — single field, Escape is the obvious undo, and the
  "loss" is a few characters of typing.
- **Terminal drawer** — no.

---

## 6. Open questions

1. Is the armed-inline-button idiom the one to standardise on, or should the
   popup stay for genuinely expensive cases (abandoning a long note)?
2. Should the confirm ever offer **Save** as a third option? Right now only the
   panel/app-close path does ("Save & Close"); everywhere else it is a binary
   Abandon / Keep Editing. Three-way is more useful but carries more visual
   weight — and this is exactly the "cost of an undo" judgement call.
3. For the Settings modal — is per-form dirty tracking worth building, or is a
   coarse "any form has been touched since this tab opened" flag good enough?

---

## Appendix — unrelated bug found while verifying

`src/scanner.js` throws `Cannot access 'currentDirHistoryId' before
initialization` when processing a missing file. It is used at
[scanner.js:460](../../src/scanner.js#L460) but not declared until
[scanner.js:640](../../src/scanner.js#L640) — a temporal-dead-zone error in the
main process. Reproduces on startup when the home directory contains a file the
scanner treats as missing (seen with `.claude.json`). Pre-existing, unrelated to
this audit.
