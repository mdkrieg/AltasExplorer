# Duplicate child-directory rows in the grid

A directory that is deleted and recreated at the same path renders **twice** in
the file grid from then on. The duplication is permanent — it survives restarts,
because the cause is two rows in the database, not a render glitch.

**Findings only — nothing in this document has been implemented.**

Found while verifying the symlink/junction listing work; it is unrelated to
links and reproduces with any ordinary folder. Status as of 2026-08-04,
branch `master` at `812dece`.

---

## 1. What you will see

Navigate to a directory whose subfolder was recreated, and the grid shows:

```
.
..
Sub          Default   -   25m   rw
Sub          Default   -    9m   rw     ← same name, different mtime
somefile.txt
```

Both rows are real, clickable, and navigate to the same place. The give-away is
the **Date Modified column: the two rows show different timestamps**, because
each row is carrying a different snapshot of the folder.

Note the duplicate appears on the **cached** render path, which is what you get
on any navigation after the first. A first-ever scan of a directory shows the
folder once, which is part of why this is confusing to catch.

---

## 2. Reproduction

Everything below is safe to run — it works in a throwaway folder.

### Step 1 — make a test tree

```powershell
$demo = "C:\Users\user\Desktop\dupdemo"
New-Item -ItemType Directory -Force "$demo\Sub" | Out-Null
"hello" | Out-File "$demo\marker.txt"
```

### Step 2 — let the app index it

Open AtlasExplorer and navigate a panel to `C:\Users\user\Desktop\dupdemo`.
You should see `Sub` and `marker.txt`, once each. This is the step that writes
the first `.` row for `Sub`.

### Step 3 — delete and recreate `Sub` at the same path

This is the whole trick. Windows gives the new directory a **new inode**, but
the path is unchanged.

```powershell
Remove-Item -Recurse -Force "$demo\Sub"
New-Item -ItemType Directory -Force "$demo\Sub" | Out-Null
```

### Step 4 — navigate away and back

In the app, navigate the panel to some other folder, then back to `dupdemo`.
(Navigating away and back is what makes it use the cached path.)

`Sub` now appears **twice**.

### Step 5 — confirm it in the database

Save this as `dupcheck.js` anywhere, then run it with the command below. It only
reads.

```js
const Database = require('c:/workspace/AtlasExplorer/node_modules/better-sqlite3');
const path = require('path');
const os = require('os');

const db = new Database(path.join(os.homedir(), '.atlas-explorer', 'data.sqlite'), { readonly: true });

// Every dirs row that has more than one '.' file row is a duplicate waiting to render.
const rows = db.prepare(`
  SELECT d.id, d.dirname, d.inode AS dir_inode, COUNT(f.id) AS dot_rows
  FROM dirs d
  JOIN files f ON f.dir_id = d.id AND f.filename = '.' AND f.deleted_at IS NULL
  WHERE d.deleted_at IS NULL
  GROUP BY d.id
  HAVING dot_rows > 1
  ORDER BY dot_rows DESC
`).all();

console.log(`directories with more than one '.' row: ${rows.length}`);
for (const r of rows) {
  console.log(`\n${r.dirname}  (dirs.inode = ${r.dir_inode}, ${r.dot_rows} dot rows)`);
  for (const f of db.prepare(
    "SELECT inode, dateModified FROM files WHERE dir_id = ? AND filename = '.' AND deleted_at IS NULL"
  ).all(r.id)) {
    const stale = f.inode !== r.dir_inode ? '   <-- STALE' : '';
    console.log(`   inode ${f.inode}  mtime ${new Date(f.dateModified).toISOString()}${stale}`);
  }
}
db.close();
```

Run it under Electron — `better-sqlite3` is built for Electron's ABI, so plain
`node` cannot open the database:

```bash
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe dupcheck.js
```

Expected output for `Sub`: two rows, one flagged `<-- STALE`, whose inode no
longer matches `dirs.inode`. The number of duplicate grid rows always equals the
number of `.` rows.

### Cleanup

```powershell
Remove-Item -Recurse -Force "C:\Users\user\Desktop\dupdemo"
```

The stale database rows stay behind after the folder is gone — see §4.

---

## 3. Mechanism

Three facts combine.

**A directory's `dirs` row is keyed by path.**
[`ensureDirectoryRecord`](../../src/scanner.js#L149) looks the directory up with
`db.getDirectory(dirPath)`. Recreating `Sub` at the same path therefore reuses
the same `dirs.id` and just updates `dirs.inode` to the new value.

**A directory's `.` file row is keyed by inode.**
[scanner.js:302](../../src/scanner.js#L302) writes the dot entry with
`db.upsertFile({ inode: dirInode, dir_id: dirId, filename: '.' })`, and `files`
is `UNIQUE(inode, dir_id)` ([db.js:67](../../src/db.js#L67)). A new inode means
`ON CONFLICT` does not fire, so this **inserts a second row** instead of
updating the first. Nothing ever deletes the old one.

**The cached read joins on filename alone.**
[`getCachedDirectoryEntries`](../../src/db.js#L1066-L1074):

```sql
LEFT JOIN files f ON f.dir_id = d.id AND f.filename = '.' AND f.deleted_at IS NULL
```

With two matching `.` rows the join **fans out** and emits the child directory
once per row. [main.js:1259](../../main/main.js#L1259) then pushes one grid entry
per joined row.

The scan path does not have this problem: it builds directory entries from
`readDirectory`, which returns one entry per real directory on disk.

### Why deleting the folder does not clean up

The orphan pass that would notice a missing child directory is skipped for the
`dirs` row while the path still exists, and once the folder is deleted the
stale `.` rows are simply never revisited. They accumulate.

---

## 4. Blast radius

- Any directory recreated at the same path duplicates permanently. Common with
  build output (`dist/`, `node_modules/`), sync clients that delete-and-replace,
  and anything restored from backup.
- More than two recreations produce more than two rows: N `.` rows render N times.
- The duplicate rows carry different `dateModified` values, so **sorting by date
  splits them apart** in the grid, which makes it look even less like a duplicate.
- Selecting one and acting on it acts on the real folder, so this is a display
  and trust bug rather than a data-loss bug.

---

## 5. Suggested fix

Two independent changes; the first is the actual fix, the second stops the
garbage accumulating.

**Fix the read — constrain the join to the directory's current inode.** One line
in [db.js:1069](../../src/db.js#L1069), and it immediately corrects every
already-affected directory without a migration:

```sql
LEFT JOIN files f
  ON f.dir_id = d.id AND f.filename = '.' AND f.inode = d.inode AND f.deleted_at IS NULL
```

**Fix the write — retire the previous dot row.** Where the dot entry is upserted
at [scanner.js:302](../../src/scanner.js#L302), drop any other `.` row for that
`dir_id` first:

```sql
DELETE FROM files WHERE dir_id = ? AND filename = '.' AND inode != ?
```

Worth checking before adopting the delete: whether any `file_history` rows
reference those stale dot rows and whether losing that history matters. The
read-side fix has no such question hanging over it, so it is the safer one to
land first.

**Do not** fix this by de-duplicating in the renderer. The duplication is real
data, and hiding it there leaves the same fan-out feeding anything else that
reads `getCachedDirectoryEntries`.
