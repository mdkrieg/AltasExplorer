# External Automation Integration — Planning Doc

**Status:** Proposal / planning. Not yet started.
**Branch:** to be developed on a dedicated long-lived branch (`feature/automation`), merging `master` *in* periodically to avoid drift against [main/main.js](../main/main.js).
**Opt-in:** off by default. Nothing loads, listens, or binds a port unless the user enables it in Settings.

---

## Goal

Let power users drive Atlas from external automation: react to things that happen in Atlas (a panel browse, a monitoring update, an alert) and act back on Atlas (raise an alert, navigate a panel, run a script), plus expose user-defined **context-menu items** and **hotkeys** that trigger automation.

**The product is a protocol, not an integration.** Atlas exposes a single documented, language-agnostic contract — the **Atlas Automation Protocol (AAP)**: JSON frames over a loopback WebSocket. Anything that speaks AAP integrates: Node-RED, Python, Go, a shell one-liner with `websocat`. Atlas owns the bus + transport + protocol; it does **not** own N integrations.

The two **reference clients** shipped alongside the protocol:

- **`node-red-contrib-atlas`** — a Node-RED node package. Fits the PLC / industrial crowd, who already live in Node-RED.
- **A Python SDK** (`pip install atlas-explorer`) — pure-Python, no Node.js required. Fits the scripting / data / **photo** crowd (Pillow + exif is a Python world, not a Node-RED one), and demolishes the setup-friction concern of requiring a Node-RED install.

Atlas itself ships **neither** Node-RED nor Python — the user runs their own client locally. This keeps Atlas lean, fast, and free of an embedded web server, arbitrary-code engine, or npm palette.

### Non-goals (v1)

- **No embedded engine**, no bundling, no spawning the user's client. (Kept as future options — see end.)
- **No synchronous interception.** Clients *react*; they do not block, veto, or transform an Atlas action mid-flight. See [Reactive-only](#reactive-only-for-v1).
- No remote / multi-machine operation. The integration is loopback-only by design.
- **No client-specific logic in Atlas.** Atlas knows only the protocol. Node-RED and Python are just the first two clients; nothing in Atlas should special-case either.

---

## The core insight: build the bus + the protocol, not the integration

The architectural investment is **not** Node-RED. It is (1) a single internal event bus and (2) a **documented protocol** exposed over a swappable transport. Once those exist, every client is a plugin Atlas never has to know about. Node-RED is the first client; Python is the second; a Go service or a `websocat` script is the third — all with **no change to Atlas**.

```
                         ┌─────────────── Atlas (main process) ───────────────┐
  monitoring pass ─┐     │                                                    │
  alert created ───┼────► AtlasBus  ◄──►  Transport (WS @127.0.0.1)  ◄════════╗ │
  renderer events ─┘     │  (EventEmitter)   + token auth   speaks AAP        ║ │
                         └────────────────────────────────────────────────────╫─┘
                                                          AAP: JSON frames     ║
        ┌──────────────────────────┬───────────────────────────┬──────────────╨──┐
        │  Node-RED                 │  Python SDK               │  anything that   │
        │  node-red-contrib-atlas   │  pip install atlas-       │  speaks AAP      │
        │  (config node + 6 nodes)  │  explorer (async client)  │  (Go, shell, …)  │
        └──────────────────────────┴───────────────────────────┴─────────────────┘
```

Each client looks idiomatic in its own world (visual nodes; Python decorators) but maps to the **same three message families**. Atlas treats them identically.

---

## Components

### 1. AtlasBus (internal event bus) — the real refactor

A single `EventEmitter` in the main process. Existing subsystems **publish domain events** to it instead of emitting ad hoc at their call sites.

- Today, events fire scattered through [main/main.js](../main/main.js): `broadcast('alert-count-updated', …)` ([main/main.js:51](../main/main.js#L51)), the monitoring pass at [main/main.js:185](../main/main.js#L185), etc.
- Refactor these to publish to the bus; `broadcast()` to the renderer becomes one of the bus's subscribers, not the origin.
- This pays off **independently of Node-RED** — it untangles event flow in a 5k-line file.

**Renderer-originated events** (panel browse, context-menu trigger, hotkey trigger) come from [public/js/modules/](../public/js/modules/) (`panels.js`, `contexts.js`, hotkeys). They flow renderer → **one new `ipcMain` channel** → bus. Do not add a channel per event type; funnel through a single typed `atlas-bus-publish` channel.

### 2. Transport adapter interface

A thin interface the bus talks to, so transports are swappable:

```
interface Transport {
  start(): void                       // bind / listen (only when feature enabled)
  stop(): void
  onCommand(cb)                       // node → Atlas (actions)
  onRegister(cb) / onUnregister(cb)   // node → Atlas (menu/hotkey registration)
  publish(event)                      // Atlas → connected clients
  reply(correlationId, result)        // optional, for command results
}
```

v1 ships exactly one implementation: the WS server below.

### 3. WebSocket transport server

- **WebSocket bound to `127.0.0.1` (and `::1`)**, started only when the feature is enabled.
- Default port configurable in Settings (propose `1818`); reject any socket whose `remoteAddress` is not loopback.
- **Token auth**: Atlas generates a token (stored with settings, shown in the Settings UI with a copy button). Every client must present it on connect.
- **WS chosen because it is the most language-universal transport** — trivial clients exist in Python, Go, Rust, C#, Java, browser JS, and the shell (`websocat`). Genericity is the whole point, so the default transport must be the one *every* ecosystem can speak. (This also sharpens the named-pipe tradeoff below: hardening costs genericity.)

### 4. Reference clients

Atlas ships the protocol; these two clients are reference implementations, distributed through their own ecosystems (not bundled in Atlas).

**`node-red-contrib-atlas`** — published to npm so it appears in the user's **own** Node-RED palette manager. (This deliberately moves the palette-security problem off Atlas and onto the user's instance.)

- **Atlas Connection (config node):** host (locked to localhost), port, token. Referenced by every Atlas node.
- **Input nodes:** `atlas-panel-browse`, `atlas-monitor-update`, `atlas-alert-in`. Subscribe over WS, emit `msg` into the flow.
- **Output nodes:** `atlas-alert-out`, `atlas-action` (navigate panel, label file, run script, …).
- **Trigger nodes:** `atlas-context-menu`, `atlas-hotkey`. On deploy they **register** with Atlas so Atlas knows to *show* the menu item / *bind* the hotkey; firing it pushes an event back to the node.

**Python SDK** (`pip install atlas-explorer`) — pure-Python (one dependency: a WS lib), no Node.js. An async client with decorators for inputs/triggers and methods for commands:

```python
from atlas import AtlasClient

client = AtlasClient(token="…", port=1818)

@client.on("panel.browse")
async def _(evt):
    print(evt.path)

@client.context_menu("Convert to PNG", filter="*.heic")   # register → triggered
async def _(evt):
    await client.action("run_script", path=evt.path)
    await client.alert(level="info", message="done")

client.run()
```

Both clients map onto the identical three message families below; only the ergonomics differ.

---

## Atlas Automation Protocol (AAP)

AAP is a **first-class, versioned artifact** with its own spec doc — not an appendix to the Node-RED package. Because multiple language ecosystems depend on it, backward compatibility is a real obligation; the handshake `protocolVersion` carries that weight from day one.

JSON frames, three families:

| Family | Direction | Shape (sketch) |
|---|---|---|
| `hello` / `welcome` | both | `{type, protocolVersion, token}` → `{type, atlasVersion, capabilities}` |
| `event` | Atlas → client | `{type:'event', topic:'panel.browse', payload, ts}` |
| `command` | client → Atlas | `{type:'command', action:'createAlert', payload, correlationId?}` |
| `result` | Atlas → client | `{type:'result', correlationId, ok, payload}` (optional ack) |
| `register` / `unregister` | client → Atlas | `{type:'register', kind:'contextMenu', id, label, filter}` |

### Payload neutrality (the rule that keeps it language-agnostic)

No JS-isms may leak into the wire format. Specifically:

- **JSON only.** No Buffers, no class instances, no functions.
- **Timestamps as ISO-8601 strings**, not epoch numbers or `Date` objects.
- **Enums as strings.**
- **Paths, not bytes.** Never ship file contents or thumbnails over AAP — pass a path and let the client read it. (Keeps frames small and avoids base64/encoding cross-language pain.)
- **Language-neutral error codes** in `result`, not thrown-exception text.

### Capability negotiation

The handshake advertises a **capability set**, not just a version number. A 20-line Python script and a full Node-RED palette both connect and use *subsets*. Atlas advertises what it supports; clients opt into what they need. New capabilities are additive and gated, so old clients keep working.

### Ephemeral registrations

Trigger registrations (`contextMenu`, `hotkey`) live only while that client is connected. A registered menu item **appears when the client is live and vanishes on disconnect** — arguably a feature (no dead menu entries pointing at stopped automation), but Atlas must handle dynamic add/remove cleanly as connections come and go.

### Conformance / echo mode

Atlas ships a tiny **protocol echo/conformance mode** so a new-language client can self-verify it speaks AAP correctly (handshake, each frame family, error shapes) without needing a full flow set up. This is what makes "any language" a real promise rather than an aspiration.

---

## Capabilities → bus events / app APIs

These are protocol-level capabilities, surfaced by each client in its own idiom (a Node-RED node, a Python decorator/method, …):

| Capability | Kind | Bus topic / Atlas API |
|---|---|---|
| panel browse | input | `panel.browse` (renderer → bus) |
| monitor update | input | `monitor.observation` (from `runMonitoringPass`) |
| alert in | input | `alert.created` |
| alert out | command | `createAlert(payload)` |
| context menu | trigger | `register{contextMenu}` → fires `contextMenu.triggered` |
| hotkey | trigger | `register{hotkey}` → fires `hotkey.triggered` |

A generic **action** command (navigate panel, apply label, run a configured script, …) is the catch-all and can grow over time without new protocol families — just new `action` values gated by capability.

---

## Ensuring the instance is local

**Mechanism: loopback binding.** Bind to `127.0.0.1`/`::1` and reject any non-loopback `remoteAddress`. By OS design nothing on the network can reach a loopback listener. Pair with the **token** → *local **and** authorized* (loopback alone would admit any local process).

**Honest caveat:** loopback guarantees the *connection arrives via loopback*, not that the *peer process physically runs here*. A user could SSH-port-forward a remote client to their own localhost and `remoteAddress` would still be `127.0.0.1`. This is not worth preventing — it is the user deliberately tunneling on their own machine, consistent with the "I'd rather be able to shoot myself in the foot" principle.

**Optional hardening (provably same-machine):** swap the WS-over-TCP transport for a **Windows named pipe**. No port exists, and `GetNamedPipeClientProcessId` yields the connecting PID so Atlas can verify same-user ownership. This is "local at the process level" vs. "local at the network level." **Cost: it sacrifices genericity** — named pipes are clunky from Python/other languages on Windows, undermining the whole point of a universal protocol. **Recommendation: ship loopback WS + token as the default (the generic path); offer named-pipe as an opt-in hardening mode for users who only run a Node client and want maximum assurance.**

Do **not** try to verify *which* client connected — any local client speaking AAP should be welcome (that is the entire design), and process-name checks are spoofable theater. "Local + authorized" is the bar, not "is this Node-RED."

---

## Reactive-only for v1

**Clients react; they do not intercept.** An Atlas action emits its event and proceeds immediately. A client cannot block, veto, or rewrite an action mid-flight.

Why this is locked for v1: synchronous "wait for the client to answer" across a cross-process WS link — with a user-managed peer that may be disconnected — requires request/response correlation, timeouts, and blocking UI against a peer Atlas does not control. That is a large, fragile jump. Interception can be added later as a negotiated capability once the reactive model is proven.

> **This is the one assumption to confirm before building.** The plan below assumes reactive-only. If interception is required for v1, milestones change materially.

---

## Opt-in, settings, lifecycle

- **Settings toggle** "Enable external automation" (off by default). When off: no transport, no port, no listener — zero footprint, preserving the 200 ms startup philosophy.
- Settings surface: port, generated token (copy button, regenerate), connected-clients indicator (a client may identify itself in `hello` for display only — never for trust), and (later) the named-pipe hardening toggle.
- **Connection state**: events with no connected subscriber simply go nowhere (the reactive model). Atlas must render a graceful "no automation client connected" state and never block on the absence of one. Multiple clients may connect at once (e.g. Node-RED *and* a Python script) — Atlas fans events out to all and accepts commands/registrations from each.
- **Persistence**: token + settings follow the existing settings store. The user's flows/scripts live in *their* client, not in Atlas.

---

## Security considerations

Ties directly to the readme security notes ("ensure ALL http requests from the frontend are blocked… no internet functionality", [readme.md](../readme.md)):

- The "no frontend HTTP" rule is about the **renderer**. This feature adds a **main-process** localhost listener — a different trust boundary. **Document this explicitly in the security notes** so future-you doesn't read it as a contradiction.
- Loopback-only bind + non-loopback rejection + token auth.
- No npm palette inside Atlas — it lives in the user's own client.
- The "run script" action executes within Atlas's privileges; gate it behind the same opt-in and consider a per-capability setting (e.g. allow events but disallow script execution). Because any-language clients can connect, capability gating is enforced **at the protocol/Atlas layer**, never assumed to be enforced by a particular client.

---

## Open questions to pin before/while building

1. **Reactive vs. interceptive (v1).** Plan assumes reactive-only. Confirm.
2. **`run script` capability** — included in the `action` command v1, or deferred until the event-only surface is proven?
3. **Default transport** — loopback WS confirmed as default; named-pipe as later (genericity-sacrificing) hardening?
4. **Reference-client scope for v1** — ship Node-RED *and* Python together, or land Node-RED first and follow with Python? (The protocol must be designed for both regardless; the question is only distribution timing.)
5. **Distribution** — `node-red-contrib-atlas` on public npm + `atlas-explorer` on PyPI, vs. downloadable artifacts from releases.

---

## Phased implementation plan

**Phase 0 — Foundation (no clients yet)**
- Introduce `AtlasBus` (EventEmitter) in the main process.
- Migrate existing emits (alert count, monitoring) to publish through it; make `broadcast()` a subscriber.
- Add the single `atlas-bus-publish` ipc channel for renderer-originated events (start with `panel.browse`).
- *Outcome:* cleaner internal event flow, valuable on its own.

**Phase 1 — Transport + AAP spec (events)**
- Write the AAP spec doc: handshake, capability set, the three frame families, payload-neutrality rules.
- Define the `Transport` interface; implement the loopback WS server with token auth and non-loopback rejection.
- Ship the conformance/echo mode (lets any client be validated from day one).
- Settings toggle + token UI + connected-clients indicator.
- Wire bus ↔ transport for **events only** (no commands yet).

**Phase 2 — First reference client + input capabilities**
- Scaffold `node-red-contrib-atlas` (Atlas Connection config node + the three input nodes) against Phase 1.
- In parallel (or close behind), the Python SDK's event/`on` side against the *same* protocol — proves AAP is genuinely language-agnostic, not Node-shaped. Per open question #4.
- *Milestone:* user can react to Atlas from their own client (Node-RED and/or Python).

**Phase 3 — Commands (act back on Atlas)**
- Add `command`/`result` to AAP and the transport.
- Implement `createAlert` + the generic `action` (start with navigate-panel + apply-label; script execution per open question #2), surfaced in both reference clients.
- *Milestone:* clients can act back on Atlas.

**Phase 4 — Triggers (registration)**
- Add `register`/`unregister`; dynamic add/remove of context-menu items ([public/js/modules/contexts.js](../public/js/modules/contexts.js)) and hotkeys as connections come/go.
- Surface context-menu + hotkey capabilities in both reference clients.
- *Milestone:* user-defined menu items and hotkeys trigger automation.

**Phase 5 — Hardening + docs**
- Optional named-pipe transport + peer-PID check (Node-leaning hardening; documents the genericity tradeoff).
- Per-capability gating enforced at the Atlas layer (e.g. disable script execution).
- User docs (a new `user-docs/` entry per client) + the published AAP spec + update security notes.

---

## Risks

- **main.js is a hot monolith** — the bus refactor touches it and will conflict with ongoing `master` work; merge `master` in often.
- **Protocol ownership is a bigger commitment than a node package.** Once AAP is public, multiple language ecosystems depend on backward compat. Mitigate with the version + capability handshake (mandatory from day one) and a precise spec — but accept the bar is higher than internal APIs.
- **Cross-process lifecycle** — reconnect logic in clients; Atlas must never assume a client is present, and must tolerate several at once.
- **Setup friction** — *mitigated* by the Python path (no Node.js needed for the scripting/photo crowd). Node-RED users still install Node + Node-RED + the palette; revisit with the "spawn-managed" future option if that proves blocking.

---

## Future options (kept open by the protocol-first design)

- **More language SDKs** — Go, C#, Rust, etc. Pure documentation + a thin client; no Atlas change. The conformance mode is what makes this cheap.
- **Embedded engine** — add an in-process transport implementing the same interface; clients that ship inside Atlas are unchanged for the user.
- **Atlas-spawned client** — detect a locally installed Node-RED (or a Python venv) and launch it as a child process for near-one-click UX without bundling. Still the external model, plus lifecycle management.
- **Interception capability** — synchronous veto/transform, negotiated in the handshake, once the reactive model is proven.
