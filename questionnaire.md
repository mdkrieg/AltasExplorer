# AtlasExplorer Context Questionnaire

The purpose of this file is to capture the *why* behind the code—decisions, constraints, intentions, and principles—so that future work (yours or AI-assisted) doesn't have to re-derive context from scratch.

## How to use this
- Fill in what you know; leave the rest. You don't have to answer everything at once.
- Specific beats vague. "Because users want X" beats "for usability."
- Mention what was rejected. "I tried X but it caused Y" is gold for future decisions.
- Once filled, answers will be migrated into in-code comments (where they apply locally) or into the memory system (where they're project-wide).
- This file can stay in the repo as a living document, or be deleted once its content is distributed—your call.

---

## 1. Project Vision

**What is AtlasExplorer fundamentally for?**
>

**What problem does it solve that existing file explorers don't?**
>

**What's the eventual public vision—who would use this, and why would they pick it over alternatives?**
>

**What does success look like in 1 year? In 3 years?**
>

---

## 2. Target User

**Who is the primary user today vs. eventually?**
>

**What workflows are you optimizing for?**
>

**What workflows are explicitly out of scope?**
>

**What does "power user" mean in this app's context?**
>

---

## 3. Architectural Choices

### Tech stack rationale

**Why Electron? What did you consider and reject?**
>

**Why SQLite + flat files instead of one or the other?**
>

**Why the `main/` vs. `public/` (renderer) split as it currently stands?**
>

**Are there libraries or frameworks you intentionally avoid? Why?**
>

### Data model

**What lives in SQLite vs. flat files, and why each?**
>

**How important is data portability / user control over their own data? Where does that constraint show up in code?**
>

---

## 4. Module-by-Module Intent

For each module: what it owns, what constraints matter, and what should *not* live in it.

### `main/main.js` (Electron main process)
**What belongs here vs. in the renderer?**
>

**IPC patterns you want kept consistent:**
>

### `public/js/renderer.js`
**Role and responsibilities:**
>

**What it should never become:**
>

### `public/js/modules/contexts.js`
**What is a "context" in this app?**
>

**Why is it a separate module?**
>

### `public/js/modules/notes.js`
**Purpose:**
>

**Relationship to reminders and contexts:**
>

### `public/js/modules/panels.js`
**Purpose:**
>

**Coupling with sidebar/renderer:**
>

### `public/js/modules/reminders.js` and `sidebarReminders.js`
**Why are these split? What does each own?**
>

### `public/js/modules/sidebar.js`
**Purpose:**
>

### `src/reminderAggregator.js`
**Why does aggregation live in `src/` rather than `public/js/modules/`?**
>

**What does it aggregate, and for whom?**
>

---

## 5. Design Principles

**UX principles you don't want broken** (already noted: no alert popups—inline validation only):
>

**Code patterns you want reinforced** (naming, file organization, module boundaries):
>

**Tradeoffs you've made deliberately** (e.g., favoring read speed over write optimization, simplicity over flexibility):
>

**What does "done" look like for a feature?**
>

---

## 6. Anti-Patterns and Non-Goals

**Things you've tried that didn't work, and why:**
>

**Patterns that should never be reintroduced:**
>

**Features people (or models) might suggest that you've decided against, and why:**
>

**Complexity you're deliberately keeping out of the project:**
>

---

## 7. Known Fragility and Tech Debt

**Areas you know are fragile—touch with care:**
>

**Coupling between modules that is intentional vs. accidental:**
>

**Things you'd refactor if you had time:**
>

**Things that look weird but are weird for a reason** (don't "fix" these):
>

---

## 8. Future Direction

**Features planned but not yet implemented:**
>

**Capabilities you want the architecture to support eventually** (even if not built yet):
>

**Things deliberately deferred—and why now isn't the time:**
>

---

## 9. Anything Else

**What context would have been most useful to a model or new contributor walking into this codebase blind?**
>

**What's a question you wish this questionnaire had asked?**
>
