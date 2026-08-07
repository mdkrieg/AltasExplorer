# Replacing the `dir` shell-out for Windows file attributes

*Historical framing — see the status box below for what is actually true now.*

`FilesystemService.readWindowsAttributes` spawned `cmd` twice per directory to
learn which entries are hidden or system. It worked and was correct as written,
but it was a stopgap: it cost ~90ms per directory and it was the only place in
the codebase that depended on parsing the output of a shell builtin.

This documents why it existed, what it cost to get right, what replaced it, and
the one optimisation still on the table.

> **RESOLVED 2026-08-05 — the shell-out is gone.** Replaced by
> `FindFirstFileW`/`FindNextFileW` through **koffi**, with the full cleanup
> applied. A follow-on optimisation (Tier 1) also landed 2026-08-05.
>
> **→ If you are reading this to make a decision, start at §10.** It summarises
> where things stand and what is still open; §11 covers the one remaining
> question and the design tension behind it (two open decisions, D6 and D7).
>
> §§1–8 are the *original* problem statement and are kept only as the record of
> how the decision was reached — **they describe code that no longer exists**,
> including a `readWindowsAttributes` that shelled out to `cmd`. Do not read
> them as current.

Original findings: 2026-08-04, branch `master` at `812dece`.
Last updated: 2026-08-07.

---

## 1. Why it exists

Node exposes no Windows file attributes. Not partially — not at all:

| Probe | hidden+system junction | plain junction | plain directory |
|---|---|---|---|
| `accessSync(R_OK)` | true | true | true |
| `accessSync(W_OK)` | true | true | true |
| `lstat().mode` | `0o666` | `0o666` | `0o666` |
| `readdirSync` through it | `EPERM` | succeeds | succeeds |

Only the last row distinguishes anything, and it identifies *deny-listed
XP-compat junctions* rather than the hidden attribute — a proxy, not the answer.

### The data is fetched and then discarded

Verified against the libuv header shipped with this Electron version,
`~/.electron-gyp/33.4.11/include/node/uv.h`:

- **Listing.** `fs.readdir` → libuv → `NtQueryDirectoryFile`, whose
  `FILE_DIRECTORY_INFORMATION` records include `FileAttributes`. libuv reads
  that field to classify the entry, then drops it, because what it returns is:
  ```c
  struct uv_dirent_s {
    const char* name;
    uv_dirent_type_t type;
  };
  ```
  There is no field for a Windows-only bitmask in a struct that also has to
  describe Linux and macOS.

- **Stat.** `uv_stat_t` *does* carry it:
  ```c
  uint64_t st_flags;
  uint64_t st_gen;
  ```
  On Windows libuv populates `st_flags` by translating the file attributes,
  hidden and system included. Node's binding then copies a fixed subset into
  the array behind `fs.Stats`, and `st_flags` is not in it:
  ```
  dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks,
  atimeMs, mtimeMs, ctimeMs, birthtimeMs
  ```

So the bits survive the syscall and libuv, and stop one layer below JavaScript.
That is the whole reason for the subprocess.

---

## 2. Why it is `dir` and not `attrib`

`attrib` was tried first and is **wrong**, not merely slow. It opens each entry,
and the profile root's legacy junctions carry an `Everyone:(DENY)(RD)` ACE, so
it silently omits or misreports exactly the entries this feature exists to
handle:

| Directory | junctions present | `attrib` found |
|---|---|---|
| `C:\Users\user` | 10 | 3 |
| `C:\Users\user\Documents` | 3 | 0 |

`dir` reads attributes out of the directory entry via `FindFirstFile` — no open
— and gets all 13 right. **If anyone "simplifies" this back to `attrib`, the
feature breaks silently in the one place it matters.** The comment in the source
says so; this is the evidence behind it.

---

## 3. What the shell-out costs

Measured on this machine:

| | |
|---|---|
| `dir` spawn, cwd form | ~41ms |
| Two spawns per directory (hidden + system) | **~90ms** |
| Whole `lstat` loop for `C:\Users\user` (42 entries) | 3.0ms |

Attributes cost roughly **30× the entire rest of the listing**. It is tolerable
today only because of deliberate containment:

- opt-in per call (`options.withAttributes`), so only the scan pays;
- deep search, which walks thousands of directories, never asks;
- results persist to `files.attrs` / `dirs.attrs`, so the cached render is free;
- a 5s in-memory cache absorbs repeat scans of the same directory.

That containment is itself complexity that exists only because the call is
expensive. Most of it can be deleted along with the subprocess.

---

## 4. Two traps already hit — keep these as regression tests

Both were found by attacking the implementation, and both produced *silently
wrong answers* rather than errors.

**`%VAR%` expansion.** cmd expands environment variables before `dir` runs, and
`%` is legal in a directory name. `Build %VERSION%` resolved to something else
and reported no attributes at all — so hidden files there stayed visible with
the setting off. Fixed by passing the directory via `cwd` so cmd's parser never
sees the path.

**UNC working directory.** cmd refuses a UNC cwd and does not error:
```
'\\localhost\c$\Windows'
CMD.EXE was started with the above path as the current directory.
UNC paths are not supported.  Defaulting to Windows directory.
   ELAMBKUP, Installer, LanguageOverlayCache, ...
```
It lists `C:\Windows`. Browsing a network share would have applied the wrong
directory's flags. Hence the current split: cwd form locally, argument form for
UNC, each with the other's weakness documented.

**Injection is not among the traps.** Three payloads through `readWindowsAttributes`
never created a marker file. The argument form quotes the path, and `"` `<` `>`
`|` `:` `*` `?` are illegal in NTFS names, so a real path cannot close the
quote. The cwd form removes the question entirely. Worth stating explicitly so
nobody re-litigates it — the reason to remove the subprocess is cost and
fragility, not a vulnerability.

---

## 5. Replacement options

### (a) Native N-API addon — recommended

A `FindFirstFileW` / `FindNextFileW` loop returning `{ name, attributes }` for a
whole directory in one in-process pass. This is precisely what `dir` does, minus
the process, the parser, and cmd's string mangling.

- Expected cost: **~1ms** for a few hundred entries, vs 90ms.
- Kills the `%VAR%` trap, the UNC trap, and the parsing entirely.
- Not a new class of dependency here: `postinstall` already runs
  `electron-rebuild better-sqlite3 node-pty --build-from-source`, so the native
  toolchain and the ABI-rebuild step are established.
- Cost: a small amount of C++ to own, and contributors need a compiler.

### (b) FFI (`koffi`) calling `GetFileAttributesW`

No C++ to maintain, and koffi ships prebuilt binaries so no compiler is needed.

- One FFI call **per entry** rather than per directory — microseconds each, so
  still ~1000× better than the subprocess, but it scales with entry count where
  (a) does not.
- `GetFileAttributesW` opens by path. Needs checking against the deny-listed
  junctions before trusting it — that is the exact failure mode that killed
  `attrib`, and it must be tested, not assumed.

### (c) Leave it

Defensible while the feature is one pilot setting. Gets worse if attributes are
ever wanted on an interactive path or in deep search.

**Recommendation: (a).** (b) is a reasonable fallback if owning C++ is
unattractive, but §2 is a standing warning about any API that opens the file.

---

## 6. What the change touches

The interface was built to be replaceable, so the blast radius is small.

- **`readWindowsAttributes(dirPath)`** ([filesystem.js:61](../../src/filesystem.js#L61))
  — the only thing that must change. Same signature, same return shape
  (`{ hidden: Set, system: Set }`).
- **Nothing else needs to change to ship it.** `readDirectory`'s `attrsFor`
  helper, the `ATTR_HIDDEN`/`ATTR_SYSTEM` bits, the scanner's persistence and
  the renderer's `applyListingFilters` all sit behind that one function.

Simplifications that become available *afterwards*, each optional:

- Drop the `options.withAttributes` opt-in — at ~1ms, deep search can just have
  them, which would let deep search honour the filters too (it currently cannot).
- Drop the 5s `_attrCache`.
- Reconsider whether `files.attrs` / `dirs.attrs` still need to be persisted, or
  whether attributes can simply be read live. Persisting them is only worth it
  while reading them is expensive. **Note the migration already shipped**, so
  removing the columns is its own decision, not a freebie.
- Potentially fold the attribute read into the same directory walk as
  `readdirSync` + `lstatSync`, since `FindFirstFileW` already returns size,
  timestamps and attributes together — this could replace the per-entry
  `lstatSync` loop outright. Bigger change, larger payoff, worth measuring
  before committing to it.

---

## 7. Verification checklist

Reuse the matrix that caught the existing traps. All of these passed against
the current implementation and must still pass afterwards.

**Hostile-but-legal directory names** — a hidden file inside each must be
reported exactly once:

```
plain
has & amp
has %USERNAME% var      <- caught the cmd expansion bug
has ^ caret
has (parens)
has 'quote'
has !bang!
```

Build the fixtures with `execFileSync('attrib', ['+H', file])`, **not**
`execSync`. Going through cmd in the *setup* reproduces the very bug under test
and makes a working fix look broken — this happened.

**Real-world reparse points** — the case `attrib` failed:

```
C:\Users\user            expect 10 junctions flagged hidden+system
C:\Users\user\Documents  expect My Music, My Pictures, My Videos flagged
```

**UNC** — attributes for a network share must describe *that share*, never
`C:\Windows`.

**Injection** — payloads containing `&&` and `&` must not execute.

**Performance** — assert the per-directory cost drops from ~90ms to low
single-digit ms; that is the entire point of the change.

---

## 8. Decisions for you

**D1 — Which replacement?**
- [ ] (a) native N-API addon — *recommended*
- [ ] (b) koffi FFI, no C++ to own
- [ ] (c) leave the shell-out in place
- Notes: ______________________________________________

**D2 — If (a): own the addon in-tree, or find a maintained package?**
- [ ] In-tree, ~100 lines, no supply-chain surface
- [ ] Existing package (needs an audit — most Windows-attribute packages are unmaintained)
- Notes: ______________________________________________

**D3 — After it lands, drop the `withAttributes` opt-in so deep search can filter too?**
- [ ] Yes — deep search currently cannot honour show-hidden/show-system
- [ ] No — keep the opt-in
- Notes: ______________________________________________

**D4 — Keep persisting `files.attrs` / `dirs.attrs`?**
- [ ] Keep — cached renders stay free, no migration churn
- [ ] Drop — read live once it is cheap
- Notes: ______________________________________________

**D5 — Investigate folding attributes into the main directory walk (replacing the
per-entry `lstatSync`)?**
- [x] Yes, as a follow-up with before/after measurements — *Tier 1 done, Tier 2 open. See §10.*
- [ ] No, keep the change minimal
- Notes: ______________________________________________

---

## 9. Outcome (2026-08-05)

**Chosen: koffi + `FindFirstFileW`.** Not quite either option as written — (a)
assumed a native addon was needed for the one-pass API and (b) assumed FFI meant
per-entry `GetFileAttributesW`. koffi can define the `WIN32_FIND_DATAW` struct,
so the one-pass API is reachable without any C++.

### Measurements that decided it

Per-entry FFI turned out to be the wrong shape — 42µs per call means it *loses*
to the shell-out above ~2,000 entries:

| Directory | entries | shell-out | per-entry FFI | **FindFirstFileW** |
|---|---|---|---|---|
| `C:\Users\user` | 42 | ~90ms | 1.5ms | **1.54ms** |
| `Documents` | 6 | ~90ms | — | **0.20ms** |
| `System32` | 4710 | ~90ms | 198ms | **22.14ms** |

Whole-`readDirectory` timings after the change: 8.4ms for the profile root,
867ms for System32 — the latter dominated by the per-entry `lstatSync` loop,
not by attributes. **That is the open D5 item**: `FindFirstFileW` already
returns size, timestamps and attributes together, so the `lstatSync` loop is now
the bottleneck and could plausibly be removed entirely.

### Cleanup applied

- `files.attrs` / `dirs.attrs` columns, their migrations, and `setDirectoryAttrs` — removed.
- The `withAttributes` opt-in and the 5s `_attrCache` — removed. Attributes are
  always read, from the same pass that lists the directory.
- `getCachedDirectoryEntries` now resolves attributes live rather than from
  stored bits, so the cached render filters identically to the scan.
- **Deep search now honours the hidden/system/link filters** — the win that
  motivated the whole change. It could not before, because attributes were
  opt-in precisely because they were expensive.

A dev database from the brief window when the columns existed will still carry
two unused columns. Harmless; noted at [db.js:360](../../src/db.js#L360).

### Packaging notes for future maintainers

- koffi is N-API (`napi: 8`), so it loads under **both** plain Node (N-API 10)
  and Electron 33 (N-API 9) with no rebuild. No `electron-rebuild` entry needed,
  unlike `better-sqlite3` and `node-pty`.
- The binary does **not** ship in the koffi tarball. It arrives via the platform
  optional dependency `@koromix/koffi-win32-x64`, which is recorded in
  `package-lock.json` with `os`/`cpu` constraints, so a fresh install resolves
  it automatically.
- npm 12's `allowScripts` policy blocked koffi's install script; `package.json`
  now carries `"allowScripts": { "koffi@3.1.4": true }`. This may be
  unnecessary — the binary comes from the platform package, not the install
  script — and could be removed if a clean-clone install proves it is not
  needed. Pinned to the exact version, so a bump requires re-approval.
- koffi's prebuild step **exits 0 when its download fails**, producing no binary
  and no error. If attributes ever silently stop working, check for
  `node_modules/@koromix/koffi-*/win32_x64/koffi.node` before anything else.
- `getWin32Bindings()` is lazy and fails soft: if koffi cannot load, attributes
  are reported as unknown and everything stays visible. The app does not break.

### Verification

The §7 matrix passes in full: 9 hostile directory names (including the `%VAR%`
case), all 10 profile-root junctions and all 3 in Documents flagged hidden+system,
`NTUSER.DAT` hidden-not-system, missing directory returns null, empty directory
returns an empty map. Plus 16 suites / 316 tests, and the four filter
combinations driven through the real Settings UI in the running app.


---

## 10. Where this stands (2026-08-07)

Short version, for talking through out loud:

1. **The original problem is solved.** The `dir` subprocess is gone, replaced by
   an in-process Windows API call. Attributes now cost ~1.5ms per directory
   instead of ~90ms.
2. **A second, older cost then became visible.** `readDirectory` makes syscalls
   *per file* rather than per directory. That was always true; removing the
   subprocess just made it the biggest remaining number.
3. **Two thirds of that is now gone too** (Tier 1, below) — done and shipped.
4. **The last third is blocked on a genuine design tension** with how this app
   identifies files. The tension is *resolvable* — that has now been verified
   experimentally — but resolving it means writing meaningfully riskier code.
   That decision is open, and is what §11 is about.

Nothing here is broken or urgent. Tier 2 is a performance-and-scalability
choice, not a fix.

### The cost is per-file, and not specific to any directory

Per-entry cost is flat from 6 entries to 22,923, so a directory is slow purely
because it is large:

| Directory | entries | lstat | access x2 | us/entry |
|---|---|---|---|---|
| `Documents` | 6 | 0.8ms | 0.7ms | 251 |
| `C:\Users\user` | 42 | 6.0ms | 3.3ms | 220 |
| `Windows` | 106 | 6.2ms | 10.2ms | 154 |
| `Fonts` | 475 | 28.8ms | 43.3ms | 152 |
| `System32` | 4710 | 323ms | 477ms | 170 |
| `WinSxS` | 22923 | 3905ms | 2722ms | 289 |

`System32` is *below* average per entry. It is just big.

### Tier 1 - DONE: `perms` derived from the attribute word

`checkAccess`'s two `accessSync` calls were the larger half of the loop and
produced nothing the attribute word does not already contain:

- `R_OK` returned `true` for all 5362 entries probed, **including `My Documents`**,
  which carries an explicit `Everyone:(DENY)(RD)` ACE. On Windows it is an
  existence check.
- `W_OK` is false exactly when `FILE_ATTRIBUTE_READONLY` is set - **on files
  only**. Windows sets READONLY on folders to mean "customised". A naive
  `!READONLY` rule mismatched 15 of 5362 entries, all directories, among them
  `Downloads`, `Music`, `Favorites` and `OneDrive`. The directory-aware rule
  mismatched **0**.

Implemented as `permsFromAttributes()` in
[filesystem.js](../../src/filesystem.js), with `checkAccess` kept for the
fallback path (non-Windows, or koffi unavailable) and for the two single-path
callers where two syscalls do not matter.

Verified against a live `accessSync` probe on 5344 entries: **0 mismatches.**

| Directory | before | after |
|---|---|---|
| `C:\Users\user` | 8.4ms | **3.1ms** |
| `System32` | 867.3ms | **419.3ms** |

Worth saying plainly: this is exactly as accurate as before and **no more**.
Neither form consults ACLs, so neither can report that a file is genuinely
unreadable. If real permissions are ever wanted, that is a separate and much
more expensive feature.

---

## 11. Tier 2 - the inode tension, and what it would take

### The tension, in plain terms

This app identifies a file by its **inode** (on Windows, the NTFS file ID), not
by its name. That is a deliberate and load-bearing choice: it is what lets the
scanner tell "this file was renamed" apart from "one file vanished and a
different one appeared", and it is the whole basis of move, rename and
replacement detection.

The catch is that **the only way to learn a file's inode is to ask about that
file specifically** - one `lstat` call each. That is the per-entry cost.

Windows has a fast directory-listing API, `FindFirstFileW`, which is what
replaced the subprocess. It returns nearly everything per entry in one pass:
name, size, timestamps, attributes. But its record - `WIN32_FIND_DATAW` - has
**no file ID field**. So it cannot feed the identity model, and cannot replace
`lstat`.

That is the tension: the fast way to enumerate a directory does not return the
one value this app's design depends on.

### It is resolvable - now verified, not assumed

There is a second API, `GetFileInformationByHandleEx` with the
`FileIdBothDirectoryInfo` class, which returns the file ID **and** attributes,
sizes and timestamps, for every entry, in one pass over the directory.

The load-bearing question was whether its `FileId` is the same number Node
reports as `lstat().ino`. It is:

```
compared 622 entries across 4 directories
  FileId    === lstat.ino    : 622/622
  LastWrite === lstat.mtime  : 622/622
  EndOfFile === lstat.size   : 609/622
```

Reproduced across two runs. **The identity model is safe** - a one-pass
enumeration can supply the same inodes the scanner already keys on.

The 13 size differences are fully explained and benign: every one is a reparse
point, where `lstat` reports the *length of the target path string* and the API
reports 0 because the directory itself holds no data.

```
My Documents   DIR +reparse   lstat.size=23   EndOfFile=0    ("C:\Users\user\Documents" is 23 chars)
My Music       DIR +reparse   lstat.size=19   EndOfFile=0
```

Our link branch already forces `size: 0` for links, so this difference does not
reach any consumer.

### What it would actually cost to build

This is the real trade, and it is about **risk, not effort**.

`FindFirstFileW` hands back a fixed-size record that koffi can describe
declaratively - you write the struct once and koffi does the marshalling and the
bounds-checking. `FileIdBothDirectoryInfo` does not work that way. It fills a
raw byte buffer with **variable-length records chained by an offset field**, and
the filename is a variable-length array at the end of each record. Reading it
means parsing bytes by hand at hardcoded offsets:

```js
const next    = buf.readUInt32LE(off + 0);    // NextEntryOffset
const attrs   = buf.readUInt32LE(off + 56);   // FileAttributes
const nameLen = buf.readUInt32LE(off + 60);
const fileId  = buf.readBigUInt64LE(off + 96);
const name    = buf.toString('utf16le', off + 104, off + 104 + nameLen);
```

Those offsets assume x64 struct alignment. A wrong offset does not throw - it
returns plausible-looking garbage, which is the same silent-wrong-answer failure
mode that `attrib` and the `%VAR%` bug had. That is the argument for care here,
and the argument for a thorough correctness harness before trusting it.

Also needed:
- a fallback when the API or koffi is unavailable (the current `lstat` path);
- correct handling of directories and reparse points, which is where the
  differences above live;
- confirmation that `perms`, `isDirectory` and the link detection all still
  derive correctly from the new source.

### The anticipated benefit

**Structurally: `readDirectory` stops making syscalls per file and makes them
per directory.** Cost becomes a function of how many directories you visit
rather than how many files they contain.

Honest caveat on numbers: the machine was under heavy I/O contention when the
one-pass prototype was benchmarked, and the absolute figures are unusable - the
`lstat` loop measured 58s for System32 in the same session where it measured
323ms earlier. The *ratios* within each run were consistent, one-pass beating
the loop by **8x to 165x**, but a controlled re-measurement on a quiet machine
is a prerequisite before committing.

What can be said from the stable earlier numbers: after Tier 1, essentially all
of `readDirectory`'s remaining time is the `lstat` loop - 419ms of System32's
419ms, 3.1ms of the profile root's 3.1ms. Tier 2 targets all of it.

The more interesting benefit is the one the ratios hint at: **the advantage
grows precisely when the system is slow.** Per-entry syscalls multiply I/O
contention by the entry count; one pass does not. That means the win is largest
on network shares, on spinning disks, under antivirus scanning, and on very
large directories - exactly the situations where the app feels worst today, and
exactly the situations that are hardest to reproduce on demand.

### A separate, cheaper opportunity from the same work

`WIN32_FIND_DATAW.dwReserved0` - on the struct already being read today, no
Tier 2 required - holds the **reparse tag**, which Node never exposes:

```
My Documents      0xA0000003  MOUNT_POINT (junction)
OneDrive          0x9000701A  CLOUD (OneDrive)
Dropbox           0x9000F01A  cloud-provider tag
thunderbird.exe   0x8000001B  APPEXECLINK
```

This would let `linkKind` distinguish junction from symlink from AppExecLink
from cloud placeholder, instead of lumping them under `'symlink'` and inferring
AppExecLink from a failing `statSync`. The raw attribute word is already
retained in the map `readWindowsAttributes` returns, so surfacing this is a
small change, independent of the Tier 2 decision.

### Decision

**D6 - Build Tier 2?**
- [ ] Yes - one-pass enumeration replaces the per-entry `lstat` loop
- [ ] Not yet - re-measure on a quiet machine first, then decide
- [ ] No - the per-entry loop is acceptable; revisit if large directories become a real complaint
- Notes: ______________________________________________

**D7 - Surface the reparse tag now?** (independent of D6, small change)
- [ ] Yes - make `linkKind` precise
- [ ] No - no consumer needs it yet
- Notes: ______________________________________________
