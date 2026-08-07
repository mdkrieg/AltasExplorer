# Cascading settings: local → category → global

Proposal and tech-debt inventory for generalising the layered-settings pattern
that `gridLayoutSettings` already implements, so that other options (starting
with Explorer-style *show hidden* / *show system*) can use it.

**Findings and questions only — nothing here has been implemented.** Status as
of 2026-08-04, branch `master` at `812dece`.

There is a **Decisions for you** section at the end with blanks to fill in.

---

## 1. Summary

The codebase already has five layered-resolution mechanisms. They were each
built independently, they disagree about what "layered" means, and only one of
them has a UI that shows the layers. Widening the pattern is the right call, but
the first job is not writing a resolver — it is **deciding which of two
different cascade shapes you actually want**, because the existing five are
split across both and they do not compose.

The near-term case (show hidden / show system) is a good pilot: small, clearly
scoped, and it exercises the full stack.

---

## 2. What exists today

| Concern | Cascade axis | Tiers, strongest first | Resolver | Layer-aware UI? |
|---|---|---|---|---|
| **Grid layout** | scope | session → local (dir) → category → global | [`get-grid-layout-layers`](../../main/main.js#L4242) | **Yes** — [gridLayoutSettings.js](../../public/js/modules/gridLayoutSettings.js), 692 lines |
| **Directory initials** | ancestry | self → parent → … (via `initials_force` / `initials_inherit`) | [`resolveDirectoryInitials`](../../src/db.js#L663) | Partial — inline labels editor shows "Inherited from X" |
| **Display name** | ancestry | same walk-up rules | `resolveDirectoryDisplayName` ([db.js:703](../../src/db.js#L703)) | Partial — same editor |
| **Category assignment** | override + pattern | dir override (`category_force`) → auto-assign patterns → `Default` | `categories.getCategoryForDirectory` | No |
| **View type** (`displayMode`) | scope | panel state → category | ad hoc | No |
| **The other 26 settings** | none | global only | `categories.getSettings` | [settings.js](../../public/js/modules/settings.js), 3433 lines |

### Storage is already spread across four backends

- `~/.atlas-explorer/settings.json` — 26 flat global keys
- `~/.atlas-explorer/categories/<Name>.json` — 11 keys per category (`name`,
  `bgColor`, `textColor`, `patterns`, `description`, `enableChecksum`,
  `deepSearchEnabled`, `attributes`, `autoAssignCategory`, `displayMode`,
  `atlasJsonSync`), plus an optional default grid layout
- `data.sqlite` `dirs` table — the per-directory tier (`initials`,
  `initials_force`, `initials_inherit`, `display_name` + its flags, `category`,
  `category_force`), plus dir-scoped layout and board tables
- In-memory panel state — `sessionDirLayouts`, the ephemeral tier nothing else has

---

## 3. The finding: these are two different patterns wearing one name

**Axis A — scope cascade.** `local → category → global`. Tiers are *kinds of
place a value can live*. A directory either has its own value or it doesn't;
there is no walking. Grid layout works this way.

**Axis B — ancestry cascade.** `self → parent → grandparent → …`. Tiers are
*positions in the directory tree*, discovered by walking, with per-node
`_force` and `_inherit` flags controlling propagation and chain-breaking.
Initials and display name work this way.

These are orthogonal, and a value could in principle need both — "inherit from
my parent directory, but only if my category doesn't override it." Deciding
whether the unified scheme supports A, B, or A×B is **the** decision in this
document; nearly everything else follows from it.

My read: **support Axis A now, and treat Axis B as a separate feature that a few
directory-identity options opt into.** Axis A covers show-hidden, show-system,
and the large majority of the 26 existing settings. Axis B is genuinely useful
but only for things a folder *is* (its initials, its label), not for how the app
behaves. Merging them produces a resolver where every read is a tree walk, which
is both slower and much harder to explain in a UI.

### A related ambiguity: what "local" means

Grid layout has *two* local tiers — persisted per-directory and ephemeral
per-panel-session — and they behave differently. Any unified scheme needs an
explicit answer for whether "local" is one tier or two, because "why did my
setting revert when I reopened the panel?" is the bug this produces.

---

## 4. What a unified scheme needs

A registry, a resolver, and a writer.

**Registry.** Each option declares what it supports, rather than every call site
knowing:

```js
{
  key: 'show_hidden_entries',
  type: 'boolean',
  default: false,
  scopes: ['global', 'category', 'local'],   // which tiers may hold a value
  axis: 'scope',                             // 'scope' | 'ancestry'
  label: 'Show hidden entries',
  group: 'Listing'
}
```

**Resolver.** One call returns both the answer and the provenance, because the
UI needs the provenance to render honestly:

```js
resolve('show_hidden_entries', { dirPath, categoryName })
// → { value: true, source: 'category', layers: { global: false, category: true, local: null } }
```

This is the shape [`get-grid-layout-layers`](../../main/main.js#L4242) already
returns. Generalising that handler is the natural starting point.

**Writer.** Scope-addressed, mirroring the existing `set-grid-layout-layer`:
`set(key, scope, scopeKey, value)`, where a `null` value clears the layer rather
than storing a falsy one. **Clearing must be distinct from setting-to-false** —
this is the single most common way layered settings go wrong, because `false`
and "not set" are both falsy in JS and the distinction gets lost the first time
someone writes `if (!value)`.

---

## 5. Tech debt this implies

Ordered by how much it would hurt to discover late.

1. **No settings change notification.** Nothing broadcasts when a setting
   changes; every consumer reads on demand via IPC. Two surfaces editing the
   same value will not see each other's writes. The good news is the mechanism
   already exists and is proven — `broadcast()` at
   [main.js:56](../../main/main.js#L56) is used for `todo-aggregates-changed`,
   `alert-count-updated` and others. It just needs a `setting-changed` channel.
   **This is the direct cause of the de-sync you are worried about, and it is
   the cheapest thing on this list to fix.**

2. **Consumers read raw storage, not an effective value.** `getSettings()`
   returns the whole flat blob and callers index into it
   (`settings.hide_dot_directory` in [panels.js:6613](../../public/js/modules/panels.js#L6613)
   and similar). Every such site is a place the cascade would be bypassed. These
   need to become resolver calls before any option gains extra tiers, or the
   tiers will be silently ignored in exactly the places users look first.

3. **Defaults are applied at read time, per key, by hand.** `getSettings` has 22
   consecutive `if (typeof settings.x === 'undefined')` blocks. A registry with
   declared defaults replaces all of it, but until it does, "unset" and
   "explicitly set to the default" are indistinguishable — which the cascade
   needs to tell apart.

4. **Category storage has no schema.** Adding per-category settings means either
   free-form keys in the category JSON or a nested `settings: {}` block. Worth
   choosing deliberately; free-form keys will be regretted once two features
   want the same name.

5. **No migration story.** Existing global values must become the global tier
   without users noticing. Straightforward for scalars, less so for
   `context_menu_order` and `attributes`, which are structured.

6. **Per-directory rows are created lazily.** A `dirs` row exists only once a
   directory has been scanned, so a local-tier write may need to create one for
   a directory the user has merely pointed at. Grid layout already deals with
   this; the general resolver will inherit the problem.

7. **`.aly` layout files sit outside all of this.** Named layouts are a
   *fourth* concept alongside the three tiers. Worth deciding whether they are a
   preset mechanism (applied *into* a tier) or a tier of their own.

---

## 6. The frontend question

Your concern — a unified backend without a unified frontend — is the right one,
and I'd put it more strongly: **a unified backend with a non-unified frontend is
worse than no unification**, because the existing controls would keep writing
the global tier while the resolver reads the local one, and the app would
appear to ignore settings.

Three ways to sequence it:

**(a) Second-tier surface only.** Existing per-feature controls keep editing
global; a new layered surface handles the tiers. Cheapest, but two ways to edit
one value with different semantics, which is the de-sync you named.

**(b) Existing controls become tier-aware in place.** Every control grows a
scope selector. Most faithful, most invasive, and it makes the settings dialog
significantly busier — the intimidating outcome you want to avoid.

**(c) Existing controls stay simple but write through the resolver — recommended.**
Each control keeps its current appearance and edits **one declared scope**
(global for app-wide preferences, local for the panel toolbar). It reads the
*effective* value and shows a small provenance affordance when the value it
displays did not come from the scope it writes — the same "Inherited from X"
idiom the labels editor already uses. The second-tier surface is then the only
place showing the full matrix, and it is not a competing editor but a superset.

Under (c), de-sync is prevented structurally: there is one write path and one
read path, and the `setting-changed` broadcast keeps both surfaces live.

### What the second-tier surface should look like

Do not design it from scratch. [gridLayoutSettings.js](../../public/js/modules/gridLayoutSettings.js)
is already this surface for one option, and it has solved the hard parts: a
matrix of layers as columns, a "live" reference column, per-layer dirty
tracking, per-layer clear, and a non-interrupting armed-inline discard instead
of a modal confirm. Generalising it from "columns of a grid layout" to "rows of
registry-declared options" is a smaller job than it looks, and it means the
interaction model is one users may already know.

On intimidation: the reason a layered settings UI feels heavy is usually that it
shows every tier for every option all the time. The mitigation is to make the
matrix **the drill-down, not the default** — the ordinary settings dialog shows
one value with a small provenance chip, and clicking the chip opens the matrix
for that one option. Users who never care never see a tier.

---

## 7. Decisions for you

*Fill in; I'll work from whatever you land on.*

**D1 — Which axis does the unified scheme support?**
- [ ] Axis A only (scope: local → category → global) — *recommended*
- [ ] Axis B only (ancestry walk)
- [ ] Both, composed
- Notes: ______________________________________________

**D2 — Is "local" one tier or two?**
- [ ] One: per-directory, persisted
- [ ] Two: per-directory persisted, plus per-panel session above it
- Notes: ______________________________________________

**D3 — Do all 26 existing settings become layerable, or only some?**
- [ ] All, mechanically
- [ ] Only those where per-directory meaning is sensible (a curated list)
- [ ] Opt-in, one at a time as need arises
- Notes: ______________________________________________
- *(Some are clearly global-only — `monitoring_scheduler_interval`,
  `auto_update_check_interval_hours`, `mirror_transfer_max_concurrent`. Making
  those layerable would be meaningless at best.)*

**D4 — Frontend sequencing?**
- [ ] (a) second-tier surface only
- [ ] (b) every control becomes tier-aware
- [ ] (c) controls write one declared scope, matrix is the drill-down — *recommended*
- Notes: ______________________________________________

**D5 — Where do per-category settings live?**
- [ ] Free-form keys alongside `bgColor` etc.
- [ ] A nested `settings: {}` block in the category JSON
- [ ] A new table in `data.sqlite`
- Notes: ______________________________________________

**D6 — Do `.aly` layout files become presets, or a tier?**
- [ ] Preset — applied into a tier, not consulted at resolve time
- [ ] A tier of their own
- Notes: ______________________________________________

**D7 — Pilot scope.** Ship show-hidden / show-system as layered from the start,
or ship them global-only and convert later?
- [ ] Layered from the start — proves the whole stack on a small surface
- [ ] Global-only first, convert with everything else
- Notes: ______________________________________________

---

## 8. Suggested phasing

1. **`setting-changed` broadcast.** Independently useful, tiny, and removes the
   de-sync hazard before anything else lands. Worth doing even if the rest is
   deferred indefinitely.
2. **Registry + resolver for a two-option pilot** (show hidden, show system),
   reusing the `get-grid-layout-layers` handler shape.
3. **Convert the read sites** for those two options only, so the blast radius of
   getting the resolver wrong is small.
4. **Generalise the layout matrix UI** into a registry-driven surface.
5. **Migrate remaining settings** per D3, in batches, each with its read sites.

Steps 1 and 2 are small enough to do alongside other work. Step 4 is the large
one and is where the intimidation risk lives, so it benefits most from the
pilot's evidence about what people actually reach for.

---

## 9. Note on the motivating case

Show hidden / show system is a good pilot for a reason beyond size: **the values
are not currently obtainable.** Node exposes no Windows file attributes —
`accessSync` and `lstat().mode` return identical results for a hidden+system
junction and a plain one — so implementing these settings needs a way to read
`FILE_ATTRIBUTE_HIDDEN` / `_SYSTEM` first. The one Node-only signal
found so far is that enumerating a deny-listed legacy junction throws `EPERM`,
which identifies the XP-compat junctions specifically but is **not** a general
hidden-attribute test. A general implementation likely needs a native call or a
shelled-out `attrib`, and that decision is independent of the cascade work — it
should not block it, but it will gate the pilot actually shipping.
