# Design Principles

These are the rules that define what "done" *feels* like. A feature isn't done when it works — it's done when it works *and* it feels right. These principles are how we get there.

## Geometry first, content second

When an action is triggered, the UI must assume its **final shape immediately**, even if the data isn't ready yet.

- A button can appear disabled while a permission check resolves.
- An image can render empty but at the correct size while it loads.
- A context menu can appear instantly with placeholder labels that fill in once a default-app lookup completes.

**The cardinal sin of UX is geometry shifting after lazy-loaded content arrives.** A user reading the interface and reaching for a target shouldn't have that target move out from under them. They may end up clicking the wrong thing through no fault of their own — that is unacceptable in this app.

This rule is why the file grid context menu appears immediately on right-click, with default-app names filled in afterward.

## No dead clicks

Every registered input must produce **immediate** visual feedback — a loading overlay, a highlight, a spinner, anything.

If the app sits silent after a click or keypress, the user has no way to tell whether their input registered. Sometimes inputs really don't register — a misclick on the edge of a target, a too-slow double-click, a key that didn't go all the way down. If we don't acknowledge inputs immediately, the user retries, and now we've wasted their attention.

This rule is why grid navigation shows a loading overlay the moment a navigation is triggered.

## No alert popups

Inline form validation only. Red borders, error text under the field. **Never `alert()`** for validation or user feedback.

The only acceptable use of a popup or modal for an error is a near-crash, app-critical scenario.

Modal *dialogs* are still fine for confirmations, multi-field forms, and other interactions — that's different from `alert()`-style error popups. Modern web UX is the expectation.

## Hotkeys are first-class

Always be looking for ways to expand hotkey coverage. The app is for power users; expect them to learn keys.

When a confirmation modal is shown:

- **Enter must select the default option.**
- The default option must be **visually distinguishable** — brighter or more saturated than the alternative — so the user instantly knows what Enter will do.

## Keyboard event ownership

**The focused panel or opened modal captures most key events.** Key events belong to whatever surface the user is currently interacting with and should stop there.

### Global exceptions (always propagate)

A small set of keys are intentionally global — they should fire regardless of focus state, but must be **blocked when a modal is open**:

| Key | Action |
|---|---|
| `Ctrl+Shift+S` | Save layout |
| `Ctrl+Shift+L` | Load layout |

`Ctrl+W` is the sole exception to the modal-blocking rule: it closes a panel under normal circumstances, but when a modal is open it should **close the modal instead** (prompting for abort-edit confirmation if applicable). This is the correct behaviour because "close what I'm looking at" is the semantic meaning of `Ctrl+W`. *Note: as of May 2026, `Ctrl+W` incorrectly closes the panel behind an open modal rather than the modal itself.*

## Refresh is a deeper look

Normal browse/navigate prioritizes snappiness — caches are used aggressively so repeated visits to the same directory or file types feel instant.

There are two distinct kinds of refresh, and they must never be conflated:

### Explicit Refresh (toolbar button)

The user is explicitly asking for a fresh perspective. This signals intent qualitatively different from just navigating to the same path again. Explicit Refresh should:

- Clear in-memory caches that hold data which could have changed between user actions (e.g. OS file-type icons, which change when apps are installed or uninstalled).
- Trigger a full re-scan rather than relying on cached results.
- Show the full loading overlay (same as navigating to the directory fresh).

**Rule for new features:** If you add a cache that holds data sourced from outside the app (OS, shell, external services), hook its invalidation to the Refresh button. The implementation pattern is:
1. Clear the main-process cache via an IPC call (fire-and-forget, no `await` needed in the click handler).
2. Clear the renderer-side cache Map directly.
3. Then proceed with the existing navigate/reload call.

### Background Refresh (automatic timer)

Background refresh is a **soft, passive scan** that runs on a timer while the app is open. Its purpose is to detect filesystem changes silently — it must never be disruptive.

Rules:
- **Never clear the grid or show a loading overlay.** The geometry of the current view must not change because of a background refresh.
- **Update in-place.** Modified or removed entries have their row fields updated directly (`grid.refreshRow(recid)`) without moving their position in the list. Scroll position and row order are preserved.
- **Append new items at the bottom.** New entries are appended after existing rows (`grid.add(records)`), never inserted in the middle.
- **Show a brief text notification only.** A small dismissing banner (e.g. "Background refresh: 2 modified items detected") fades in over the grid footer and auto-dismisses after ~4 seconds. No modal, no alert, no overlay.
- **The banner must be `position: absolute`.** It overlays the panel without shifting any flex/grid siblings.

This means background refresh is strictly a DB-comparison pass + in-place UI patch. It does NOT clear any caches (that is the Refresh button's job).

### Sidebar-owned keys

Some keys appear to act on panels but are actually in service of the currently focused sidebar item. Left/Right arrow keys while a favorites item is keyboard-focused cycle the **target panel** for that item — the action is owned by the sidebar context, not the panels. This means:

- The keys have no meaning (and should do nothing) if the corresponding sidebar item is not highlighted.
- They should not be treated as "panel navigation" globally; they only apply when the sidebar has keyboard focus on a `fav-item`.

This is a useful mental model for deciding where a new keyboard action belongs: ask *what surface gives this key its meaning*, then bind it there.

## Multiple discoverable paths to the same task

Users won't read docs for a file explorer.

- The mechanism of any task should be obvious.
- Having *multiple* obvious ways to do the same thing increases the odds the user discovers one on their own.

Yes, this means more code paths. It's worth it.

## Use w2ui in the standard way

w2ui is the chosen UI library, and we should use its features in the standard way unless there's a concrete reason they don't fit.

Reasons:

- w2ui is highly polished with a rich feature set.
- Future contributors will recognize standard patterns.
- Gaps we find may become back-contributions to w2ui itself.

When you find yourself reaching for a custom UI control, check w2ui first. Only deviate with a *concrete* reason — not a stylistic preference.

## Done feels right

A feature is not done when it functions. It's done when:

- The function is correct.
- The interaction obeys geometry-first and no-dead-clicks.
- Hotkeys are wired where they belong.
- It doesn't break any existing path to a task.
- It feels right.

Be patient with iteration on the minutiae of how the interface responds. That part is the product.
