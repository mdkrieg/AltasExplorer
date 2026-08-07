# Explorer / common file dialog integration — findings

Investigation into whether AtlasExplorer could influence the Windows common file dialog
(Open/Save, used by other apps) or File Explorer's sidebar. Research only, nothing implemented.

## Full dialog replacement — ruled out

There is no supported OS extensibility point for swapping the common file dialog
system-wide. Every app calls `IFileDialog` / `GetOpenFileName` in its own process
(`comdlg32`/`shell32`). Replacing the shell (`Winlogon\Shell`) only swaps the
desktop/taskbar, not those in-process dialogs. Actually intercepting them would require
injecting a hook into every process (`AppInit_DLLs`-style, now deprecated/blocked for
signed binaries) and detouring the dialog APIs — fragile across Windows updates, defeated
by sandboxed/UWP and Protected Process Light apps, and behaviorally indistinguishable from
what AV/EDR flags as malware. Not pursued further.

## Option A: Quick Access pinning

Pin curated folders into Explorer's Quick Access via `Shell.Application` COM
(`Namespace(path).Self.InvokeVerb("pintohome")`). Quick Access is shared shell
namespace state, so pins also appear in the sidebar of the common Open/Save dialog in
other apps, not just Explorer.

**What it gets us:** curated paths surfaced in every app's file dialog sidebar, with a
single documented COM call. No registry writes, no DLL, no install-time footprint at all —
purely a runtime action.

**Limits:**
- **Ordering:** no supported API. Pin order is user-draggable and persisted in
  `%APPDATA%\Microsoft\Windows\Recent\AutomaticDestinations\f01b4d95cf55d32a.automaticDestinations-ms`,
  a compound-file jump list whose internal `DestList` stream controls order. That format
  is undocumented (known only from forensics/DFIR reverse-engineering), and it's a file
  Explorer owns and rewrites — hand-editing it would be fragile across OS updates and pin/unpin
  actions.
- **Separators:** not a Quick Access concept at all — just the built-in "Pinned"/"Recent"
  groups, no custom labeled grouping.
- **Custom icon:** only indirectly, via `desktop.ini` (`[.ShellClassInfo]` +
  `IconResource`) on the actual target folder — which reskins that folder everywhere
  (Explorer, every app's dialogs), not just the Quick Access entry. A per-pin icon distinct
  from the folder's real icon is theoretically possible (jump-list entries are shell links,
  which support `SetIconLocation`) but only by writing the same undocumented
  `AutomaticDestinations-ms` file as above.

**Assessment:** cheap, safe, fully reversible, zero install footprint. Good default option.

## Option B: Shell namespace extension (own sidebar node, like This PC / Network)

Implement `IShellFolder` (+ `IPersistFolder2`, `IEnumIDList`, an icon handler) and register
a CLSID so Explorer treats it as a first-class root node in the sidebar — own icon, own
children, own order, fully under our control. Also shows up inside the common file dialogs
since they share the shell namespace, so it solves the "curated paths everywhere" goal more
completely than Quick Access pinning.

**No-admin registration path confirmed:** the namespace-root entry
(`Explorer\Desktop\NameSpace\{CLSID}`) and the COM class registration
(`CLSID\{CLSID}\InprocServer32`) both have documented `HKEY_CURRENT_USER` equivalents
alongside the `HKEY_LOCAL_MACHINE` ones. Both are writable by a normal user process — no
elevation, no UAC prompt. This is Microsoft-documented behavior, not a workaround (see
sources). Registering per-user (`HKCU`) rather than per-machine (`HKLM`) fits an install
that already runs without elevation: the extension only appears for that one Windows
account, matching a per-user install to somewhere like `%LocalAppData%`.

**Caveats (non-elevation):**
- Explorer typically needs a restart, or the user needs to log off/on, to pick up a newly
  registered namespace root.
- The COM server DLL must be 64-bit, since `explorer.exe` is 64-bit-only on current Windows.
- Meaningfully bigger lift than Quick Access pinning: real COM implementation plus registry
  registration, vs. a single scripted COM call.

**Assessment:** the properly supported mechanism for a dedicated, fully-controlled sidebar
group (icon, ordering, separation from other pins). Confirmed feasible without breaking the
no-elevation install pattern. Worth keeping on the shelf as the "if we get serious about
this" option rather than doing now.

## Recommendation

Start with Quick Access pinning (Option A) if/when we want curated paths surfaced outside
AtlasExplorer. Treat the namespace extension (Option B) as a later option if we ever want
real control over ordering, icon, and grouping — it's more work but was confirmed feasible
without requiring admin rights.

## Sources
- https://learn.microsoft.com/en-us/windows/win32/shell/nse-junction
- https://learn.microsoft.com/en-us/previous-versions/windows/desktop/legacy/cc144096(v=vs.85)
- https://learn.microsoft.com/en-us/windows/win32/shell/reg-shell-exts
