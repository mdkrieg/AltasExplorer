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
> I personally have two use cases for it:
> Primary - I work as a PLC programmer, which I find to be a bit of a muddy middle-space of the software design profession. We deal with lots of files which don't lend themselves easily to the standard productivity tools of Microsoft Office nor do they lend themselves to typical Software productivity tools like git. In addition, there is not a shared appetite for any sort of grand management suite or anything fancy; "Just put it on the [SMB] server" files are files, and files are king. So the primary goal of this app is to be a standalone kingdom of files - deliver as much of the awesome "grand suite" functionality while not stepping on the toes of anyone who just wants to "put it on the server". To put it plainly: The app must sit atop our plain filesystem and act as a layer which offers much richer functionality than just the underlying folders and files.
> Secondary - I also have a lot of photos in my camera roll and keep telling myself I will organize them one day. I think there is a lot of overlap with my primary needs here so we may as well cover that use case as well.

**What problem does it solve that existing file explorers don't?**
> The first word that comes to mind is Labelling. I had an epiphany one day at work when I realized that we basically use folders as hashtags. Folders named this such as "inProgress" or "underReview" or "toCustomer" nested into layers full of duplicated trees don't really act so much as collections as they do labels which can change. Then consider that perhaps these directory trees are copied from a template and you're looking at more empty folders than you are actual files - it becomes clear that there's a benefit to flattening this structure and merely applying and swapping labels.

**What's the eventual public vision—who would use this, and why would they pick it over alternatives?**
> The public vision is whoever wants it will know it when they see it. I've tried a few other alternatives but none of them really go far enough outside the box for me to ditch Windows File Explorer.

**What does success look like in 1 year? In 3 years?**
> I'll start with a month, by then I'd like to be using this app at work daily because it makes my life easier. By a year I should not be able to live without it and maybe some public users are starting to love it too. In three years, I don't know, maybe it'll be perfect by then, who knows? (footnote: keeping the code logical and coherent after a year and three years is a priority, I want to be able to still get in there and tweak things myself)

---

## 2. Target User

**Who is the primary user today vs. eventually?**
> Today: me, and solely me, but on two or three devices
> Eventually: anyone who has to work with files but for one reason or another does not have access to anything fancy

**What workflows are you optimizing for?**
> Remember "files are files, and files are king"

**What workflows are explicitly out of scope?**
> 

**What does "power user" mean in this app's context?**
> Power user, in the context of whom this app is for, means someone who knows a thing or two about computers. Someone who knows why they might want to track a checksum and have an audit history of any change seen among their files. Also someone who is willing to sit there and configure alert/monitoring/tagging rules and can create from scratch a rule stack that works to their benefit.

---

## 3. Architectural Choices

### Tech stack rationale

**Why Electron? What did you consider and reject?**
> Honestly I didn't consider much else. I have not used a great deal of front-end frameworks except tkinter for python and a little bit of fyne for golang. I considered that those two (or just vibe-coding some C++) may give me better performance but I personally am not as skilled in them as I am with HTML and javascript.
> However I saw Electron as an excellent fit for the following reasons:
> * HTML is perhaps the most publicly documented frontend framework there is with a huge base of potential contributors
> * Electron is cross-platform so future Linux or Mac OS ports are easier
> * Doing the front-end in HTML means it can also be ported to the typical HTTP server architecture (proof of concept already done) - which I think has solid use cases for homebrewers running a raspberry pi or simple linux server (as a NAS, for example)
> The one drawback I imagine is just the speed / responsiveness of the frontend. It will be an uphill battle but I think with smart choices we can still make the app feel snappy enough for the toughest critic (me).

**Why SQLite + flat files instead of one or the other?**
> That's an easy one, speed (SQLite) vs accessibility (flat files)
> The perfect illustration for accessibility is in the notes.txt file - sometimes I want to look up information on my phone which has OneDrive and Sharepoint. If the information I need is in a text file I can view it easily (editing may be another story but we will cross that bridge another day). Or, I may have a backup of files I took off of a lab PC with a thumbdrive, and maybe I have some notes and a TODO list I kept in a text file there and look at that! Atlas Explorer can read those same notes and knows I have some TODOs in there, and now I can move on with my work without worrying about how to capture the state of what was completed on the lab PC.
> The place we need speed primarily comes down to search. We have large file servers that have inconsistent organization, it takes a while to use windows search here and it primarily involves running four or five simultaneous searches on various different file servers. If we configured our monitoring rules smartly, we have a database that has been kept up-to-date and can just query our local db without even hitting the file server. In fact, we even have an audit history and my results can include files that were previously there but are currently missing!
> I feel the distinction is really that simple, do we need speed, or do we need accessibility.
> There is sortof a third case of user configuration (settings, favorites, applied labels, etc) and that in my opinion comes down to whatever makes sense for the architecture. The label definitions are in individual JSON files because I can see a case where two users may want to share their collection of categories and tags they've defined. Meanwhile the directories they are attached to lives in the db because it has to - it is an attribute that a user may want to search by and we also can't go polluting shared fileservers.

**Why the `main/` vs. `public/` (renderer) split as it currently stands?**
> 

**Are there libraries or frameworks you intentionally avoid? Why?**
>

### Data model

**What lives in SQLite vs. flat files, and why each?**
> I think my previous answer covers this well.

**How important is data portability / user control over their own data? Where does that constraint show up in code?**
> It's very important, defer to previous answer.

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
> Primary orchestrator, page-building and inter-module wiring belongs here

**What it should never become:**
> Not a place for individual features, I see there are some onclick handlers here which to me should be a refactor smell

### `public/js/modules/contexts.js`
**What is a "context" in this app?**
> Should be for context menus

**Why is it a separate module?**
> It was refactored out early on, though I am open to reconsidering this.

### `public/js/modules/notes.js`
**Purpose:**
> Originally for just the notes files but has morphed to hold a generic file editor since then. I would be all in favor of renaming this file or separating out some functionality if it makes sense.

**Relationship to reminders and contexts:**
> Reminders are parsed from notes and shown in the app separately. The hits I see for "context" here I think are just logical contexts, there aren't really any right-click context menus associated with notes or file editors.

### `public/js/modules/panels.js`
**Purpose:**
> Managing the panels. Panels are really the heart of this app, it's what allows the user to work on and reference multiple things at once. I do think that perhaps panels has gotten a bit bloated and could use a refactor if it makes sense.
> Let me define a panel:
> * A panel ALWAYS has an editable path-bar on top which bears the user-defined colors of the assigned category (of the displayed dir, or nearest parent dir if a file or other item)
> * A panel can display a directory (grid or gallery view), a file viewer/editor, a file properties summary, and potentially others in the future. I will refer to things that live in panels as being panel-hosted.
> * Anything that goes into a panel will be identifiable by a URI (borrowing ideas from HTTP, like the query ?param1&param2 and fragment #edit) to help drive the panel to any sub-states which might be useful. When I refer to a URI, this is what I'm talking about.
> * There is also a modal popup that could be considered a panel, though its true role is still being fleshed out in my head.
> NOTE: There is a recurring pattern here that I refer to as P1-Pn+1 - here n is the number of opened panels (not including the modal) so P1-Pn+1 refers to an array of something (usually of buttons) that correspond to all opened panels (P1-Pn) plus one more (Pn+1) which will open a new panel and perform whatever action is using the pattern.
> * There is a hard limit of 4 panels, so unless that changes, P1-Pn+1 will ALWAYS cap itself at panel 4 (P1-P4).
> * If for any reason I don't want the pattern to offer a new panel option, this will be referred to as P1-Pn
> * If the items are horizontally spaced then use the succinct labels (P1, P2, P3, P4) - if it is a vertically spaced item like a context menu or dropdown then long labels are okay (Open in Panel 1, etc...)
> * The Pn+1 (new panel) item should have something the label to denote that it will open a new panel - (ie, P2+ for succinct, Open in new Panel 2 for long)

**Coupling with sidebar/renderer:**
> The sidebar in UX terms is not tied to any one panel, it is there as a helper for all panels. There is a Tab(key)-to-focus pattern that trades focus between panels to aid in mouseless interaction. The sidebar also picks up "LOCAL FAVORITES" (windows shortcuts) from all opened panels, any favorite can also be pushed to any panel, and the TODOs and Reminders are also aggregated from the notes files in any opened panels.

### `public/js/modules/reminders.js` and `sidebarReminders.js`
**Why are these split? What does each own?**
>

### `public/js/modules/sidebar.js`
**Purpose:**
> 

### `src/reminderAggregator.js`
**Why does aggregation live in `src/` rather than `public/js/modules/`?**
> Aggregation should happen on the backend because it has to read notes files to find the reminders and report them as a single dataset

**What does it aggregate, and for whom?**
> Reminders from notes in the general form of "REMINDER (date): reminder text" all get scraped and aggregated into one list of reminders grouped by date in the app. It is for the user only, so they can set a reminder (without even opening the app, just setting a text file!) and have them all in one place with a breadcrumb leading them back to the relevant directory or file.

---

## 5. Design Principles

**UX principles you don't want broken** (already noted: no alert popups—inline validation only):
> Correct, no alert popups, inline validations.
> Hotkeys are important, always be thinking about how to improve hotkey coverage. For example, if a confirmation modal is offered then Enter should select the default option (which should be more brightly colored than the non-default)
> Responsiveness - Geometry first, content second: when an action is triggered, the UI should assume its final shape as soon as possible even if the data is not ready. For example we applied this with the file grid context menu - the menu should appear immediately after right click, then in the background we are looking up the default app that opens a file type to fill its name into the already-visible context menu once that data is ready. Furthermore, even if a button has to appear but be disabled or if an image has to load empty but with the right size - that is FAR better than prepending it into the DOM late - because the user at least knows the shape of they are looking at and will need time to process it anyway. The absolute sin of UX is having the geometry of an interface change because something loaded lazily and has now shifted the contents down - this leads to the user potentially clicking on the wrong thing through no fault of their own and is absolutely frustrating and it shall not happen in this application!
> To continue on the above point - No "dead clicks"! Meaning, once it is determined that an action was triggered (as in YES, a click was registered, a key was pressed, etc) - there should be some IMMEDIATE reaction to let the user know their input was received. For example we applied this with the file grid navigation, once a navigation is triggered a loading overlay appears while all the files are enumerating in the background. The reason this must not happen is that sometimes inputs just aren't registered for one reason or another - maybe I missed the clickable area, maybe my double click was too slow, maybe I didn't press the key all the way down. And if the app sits there with no feedback it makes the user doubt if the input was received and they may respond by attempting the same input again. Clearly that would be a waste of user thought process if the input was indeed received but the app is just silently thinking in the background.
> Multiple ways to accomplish a task in the app is a good thing - I know it makes our lives more difficult, but this I feel is important. I don't expect a user to read the docs on a file explorer app, so it is good if the mechanism of a task is obvious, but it also helps if there are multiple obvious ways to do something. This increases the odds that a user will discover how to do the task on their own which is good usability in my opinion.

**Code patterns you want reinforced** (naming, file organization, module boundaries):
> I would like to use w2ui features as much as possible - and in the "standard" way as much as possible - unless there is a concrete reason that they do not fit our goal. The w2ui library is extremely polished in my opinion with a rich feature set, and not only will this make contributing to our app more accessible but may potentially lead to back-contributions to the w2ui project if we find suspected gaps in coverage.

**Tradeoffs you've made deliberately** (e.g., favoring read speed over write optimization, simplicity over flexibility):
>

**What does "done" look like for a feature?**
> At a minimum it has to do its intended function of course, but it also has to "feel" right. As I mentioned above, the navigation needs to be smooth throughout the app and visual cues are everything. So please bear with me if I am a bit picky about the minutiae of how the interface responds.

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
