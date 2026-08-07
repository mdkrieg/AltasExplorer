# Proposed test suite for `src/scanner.js`

`scanner.js` is the largest untested module in the codebase and the one where
bugs are hardest to see, because its failures are silent: a row quietly acquires
the wrong filename, an entry is quietly attributed to the wrong directory, a
file is quietly reported as having moved. Nothing throws.

**Proposal only — no tests written yet.** Status as of 2026-08-04, branch
`master` at `812dece`.

Motivating example: the link rows written during the symlink work were being
renamed to `.` by a later pass in the same function. All 16 existing suites
passed; the bug was only found by driving the running app and reading the
database by hand. Every test below is chosen because it would have caught a bug
of that shape.

---

## 1. Why there isn't one yet

`scanDirectory` pulls in nine collaborators — `db`, `filesystem`, `categories`,
`notesParser`, `atlasJson`, `mirrors`, `todoAggregator`, `reminderAggregator`,
`contentExtractor` — and writes to six tables. Mocking all of that produces a
test that asserts on mock call order rather than on behaviour, which is exactly
the kind of test that would *not* have caught the rename bug.

## 2. Recommended strategy: real database, real fixture directories

The repo already has the right pattern in
[db.test.js](../../src/__tests__/db.test.js): plug an in-memory `better-sqlite3`
connection into the `db` singleton and run the service's own `createSchema()`,
so tests exercise the real schema rather than a mock of it.

Extend that idea:

- **Database** — in-memory SQLite via the existing `freshDb()` helper. Assert on
  actual rows, not on mock calls. Reuse the `describeIfBinding` guard, and note
  that this suite must be run under Electron (see §5).
- **Filesystem** — real temp directories under `os.tmpdir()`, created and torn
  down per test. Real directories are what make junction, permission and inode
  behaviour testable at all, and none of it can be faked convincingly on Windows.
- **Mock only the leaves** — `logger`, `notesParser`, `atlasJson`, `mirrors`,
  `todoAggregator`, `reminderAggregator`, `contentExtractor`. These are
  peripheral to scan bookkeeping and mocking them keeps each test readable.
- **`categories`** — stub `getCategoryForDirectory` to return a fixed category
  object. Give it a knob for `enableChecksum` / `deepSearchEnabled` so the
  branches that depend on them are reachable.

A `scanTwice(dir)` helper — scan, mutate the fixture, scan again, return both
results — will carry most of these tests, because nearly every interesting bug
is a *second-scan* bug.

---

## 3. Recommended tests

### 3.1 Row identity and persistence

The core invariant: **one filesystem entry, one `files` row, with the right
name.** This group would have caught the rename bug directly.

1. A plain file gets exactly one `files` row, with its real filename.
2. A subdirectory gets a `dirs` row and a `.` row in its **own** `dir_id`, not
   the parent's.
3. A second scan with nothing changed leaves every row's filename, inode and
   `dir_id` untouched — assert on a full row snapshot, not on a count.
4. **A link's row keeps its own filename after a full scan.** A directory-link
   must not end up named `.`, and must not acquire a `dirs` row.
5. A directory holding both a link and a real folder produces one `dirs` row,
   not two.

### 3.2 Change-state classification

6. Unmodified file → `unchanged`.
7. Touched file → `dateModified`.
8. New file → `new`, and only that file is `new`.
9. Deleted file → `orphan`, with an `orphans` row created once and not
   re-created on subsequent scans.
10. Renamed file (same inode, new name) → `wasRenamed` with `previousFilename`
    set.

### 3.3 Identity edge cases — the highest-value group

These are the ones that have actually produced bugs.

11. **Same-named links in two different directories are independent.** Two
    junctions both called `Recent`, in different folders, must not be reported
    as one link that moved. This is the `link:<filename>` collision guard.
12. **Same-named unreadable entries in two directories are independent** — the
    identical hazard for `-1:<filename>` permission-error rows, which existed
    silently before the link work.
13. **Two hardlinks to one file in the same directory.** They share an inode, so
    `UNIQUE(inode, dir_id)` collapses them to one row. Pin down whatever the
    intended behaviour is — currently both render but share a row, and a scan
    sees the other name and computes a spurious rename.
14. **Inode rotation at a constant path** → `fileReplaced`, not
    delete-plus-create. This is the OneDrive-hydration and Excel-save path.
15. **A directory recreated at the same path** must not leave two `.` rows.
    Currently it does — see
    [duplicate-child-directory-rows.md](duplicate-child-directory-rows.md).
    Write this test against the intended behaviour and let it fail until that
    is fixed.
16. A file moved between two scanned directories is reported `moved` once, not
    on every subsequent scan.

### 3.4 Traversal boundaries

17. A junction pointing at a sibling directory does not cause that directory's
    contents to be scanned twice.
18. A junction loop (A contains a junction to B, B contains one to A) terminates.
19. Links are excluded from checksum and content-extraction queues even when the
    category enables both.

### 3.5 Permission and error handling

20. An entry that cannot be stat'd becomes a `permError` row with a `-1:` inode
    and still appears in the returned entries.
21. On a background refresh, existing `permError` entries are passed as
    `ignoreFilenames` and are not re-orphaned.
22. A `permError` entry that becomes readable loses its `-1:` row and gains a
    real one.

### 3.6 Regressions worth pinning

23. Scanning a directory twice does not grow any table — the tightest available
    proxy for "no churn", and it would have caught the original symlink churn.
24. `entriesWithChanges` and the persisted rows agree: every returned entry has
    a row, and every row has an entry.

---

## 4. Suggested order

Do §3.1 and §3.3 first. Together they cover row identity, which is where every
bug found so far has lived, and §3.1.4 plus §3.3.11 lock down the link work
specifically. §3.2 is straightforward but lower yield. §3.4 needs real junctions
and so is the slowest to write.

---

## 5. Practical notes

- **Junction fixtures need no elevation** — `cmd /c mklink /J` works as a normal
  user, unlike `/D` and file symlinks, which require Developer Mode or admin.
  Prefer junctions for link fixtures so the suite runs anywhere.
- **Tear down junctions with `rmdir`, never `rm -rf`.** Recursive delete can
  follow the junction and destroy the target's contents.
- **This suite must run under Electron**, because it opens a real database:
  ```bash
  ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe \
    --experimental-vm-modules ./node_modules/jest/bin/jest.js --ci --roots "<rootDir>/src"
  ```
  Under plain `node` the `describeIfBinding` guard turns the whole thing into
  `describe.skip`, which reads almost identically to "passed" in the summary
  line. Whoever writes these should confirm the new suite actually *ran* — check
  the suite count goes from 16 to 17, not just that the run is green.
- **Windows inode caveat**: the `ino` from `lstat` is the NTFS file ID and is
  stable across renames but not across delete-and-recreate. Tests that need a
  changed inode should delete and recreate; tests that need a stable one should
  rename.
