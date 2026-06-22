# Node-RED Integration — Planning Doc

**Status:** Proposal / planning. Not yet started.
**Branch:** to be developed on a dedicated long-lived branch (`feature/node-red`), merging `master` *in* periodically to avoid drift against [main/main.js](../main/main.js).
**Opt-in:** off by default. Nothing loads, listens, or binds a port unless the user enables it in Settings.

---

## Goal

Let power users drive Atlas from automation flows: react to things that happen in Atlas (a panel browse, a monitoring update, an alert) and act back on Atlas (raise an alert, navigate a panel, run a script), plus expose user-defined **context-menu items** and **hotkeys** that trigger flows.

The automation engine is **Node-RED**, but Atlas does **not** ship or embed it. The user runs **their own** Node-RED instance locally and installs an Atlas node package into it. This fits the target audience (the PLC / industrial crowd already lives in Node-RED) and keeps Atlas lean, fast, and free of an embedded web server + arbitrary-code engine + npm palette.

### Non-goals (v1)

- **No embedded Node-RED**, no bundling, no spawning the user's instance. (Both are kept as future options — see end.)
- **No synchronous interception.** Flows *react*; they do not block, veto, or transform an Atlas action mid-flight. See [Reactive-only](#reactive-only-for-v1).
- No remote / multi-machine operation. The integration is loopback-only by design.

---

## The core insight: build the bus, not the binding

The architectural investment is **not** Node-RED. It is a single internal event bus plus a **swappable transport adapter**. Once those exist, "external Node-RED" is just one transport — and "embedded Node-RED" or "any other local automation client" become drop-in alternatives later, with **no redesign**.

```
                         ┌─────────────── Atlas (main process) ───────────────┐
  monitoring pass ─┐     │                                                    │
  alert created ───┼────► AtlasBus  ◄──►  Transport adapter (WS @127.0.0.1) ◄═╗ │
  renderer events ─┘     │  (EventEmitter)        + token auth                ║ │
                         └────────────────────────────────────────────────────╫─┘
                                                                  JSON frames  ║
                          ┌──────── User's own Node-RED (their process) ───────╨─┐
                          │   node-red-contrib-atlas:                            │
                          │     Atlas Connection (config) + 6 nodes              │
                          └──────────────────────────────────────────────────────┘
```

The six nodes look identical to the user regardless of transport. Only their internal implementation differs (WS client now; in-process bus call if embedded later).

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
- **Token auth**: Atlas generates a token (stored with settings, shown in the Settings UI with a copy button). The Atlas Connection node must present it on connect.
- WS chosen because Node-RED nodes consume it trivially and it's bidirectional (push for events, frames for commands).

### 4. `node-red-contrib-atlas` package

Published to npm so it appears in the user's **own** Node-RED palette manager. (This deliberately moves the palette-security problem off Atlas and onto the user's instance.)

- **Atlas Connection (config node):** host (locked to localhost), port, token. Referenced by every Atlas node.
- **Input nodes:** `atlas-panel-browse`, `atlas-monitor-update`, `atlas-alert-in`. Subscribe over WS, emit `msg` into the flow.
- **Output nodes:** `atlas-alert-out`, `atlas-action` (navigate panel, label file, run script, …).
- **Trigger nodes:** `atlas-context-menu`, `atlas-hotkey`. On deploy they **register** with Atlas so Atlas knows to *show* the menu item / *bind* the hotkey; firing it pushes an event back to the node.

---

## Wire protocol

JSON frames over the WS, three families, with a **version field in the handshake** so the contract can evolve without breaking old node packages (the one new long-term liability of going cross-process):

| Family | Direction | Shape (sketch) |
|---|---|---|
| `hello` / `welcome` | both | `{type, protocolVersion, token}` → `{type, atlasVersion, capabilities}` |
| `event` | Atlas → node | `{type:'event', topic:'panel.browse', payload, ts}` |
| `command` | node → Atlas | `{type:'command', action:'createAlert', payload, correlationId?}` |
| `result` | Atlas → node | `{type:'result', correlationId, ok, payload}` (optional, for output nodes that want an ack) |
| `register` / `unregister` | node → Atlas | `{type:'register', kind:'contextMenu', id, label, filter}` |

### Ephemeral registrations

Trigger registrations (`atlas-context-menu`, `atlas-hotkey`) live only while that Node-RED is connected. A registered menu item **appears when the flow is live and vanishes on disconnect** — arguably a feature (no dead menu entries pointing at stopped flows), but Atlas must handle dynamic add/remove cleanly as connections come and go.

---

## The six nodes → bus events / app APIs

| Node | Kind | Bus topic / Atlas API |
|---|---|---|
| `atlas-panel-browse` | input | `panel.browse` (renderer → bus) |
| `atlas-monitor-update` | input | `monitor.observation` (from `runMonitoringPass`) |
| `atlas-alert-in` | input | `alert.created` |
| `atlas-alert-out` | output | `createAlert(payload)` |
| `atlas-context-menu` | trigger | `register{contextMenu}` → fires `contextMenu.triggered` |
| `atlas-hotkey` | trigger | `register{hotkey}` → fires `hotkey.triggered` |

`atlas-action` is the catch-all output node (navigate panel, apply label, run a configured script, etc.) and can grow over time without new node types.

---

## Ensuring the instance is local

**Mechanism: loopback binding.** Bind to `127.0.0.1`/`::1` and reject any non-loopback `remoteAddress`. By OS design nothing on the network can reach a loopback listener. Pair with the **token** → *local **and** authorized* (loopback alone would admit any local process).

**Honest caveat:** loopback guarantees the *connection arrives via loopback*, not that the *peer process physically runs here*. A user could SSH-port-forward a remote Node-RED to their own localhost and `remoteAddress` would still be `127.0.0.1`. This is not worth preventing — it is the user deliberately tunneling on their own machine, consistent with the "I'd rather be able to shoot myself in the foot" principle.

**Optional hardening (provably same-machine):** swap the WS-over-TCP transport for a **Windows named pipe**. No port exists, and `GetNamedPipeClientProcessId` yields the connecting PID so Atlas can verify same-user ownership. This is "local at the process level" vs. "local at the network level." Cost: a less copy-pasteable transport for the node. **Recommendation: ship loopback + token as the default; offer named-pipe as an opt-in hardening mode, not v1.**

Do **not** try to verify "the client is specifically Node-RED" — any local client speaking the protocol should be welcome (other local automation is a legitimate use), and process-name checks are spoofable theater.

---

## Reactive-only for v1

**Flows react; they do not intercept.** An Atlas action emits its event and proceeds immediately. Flows cannot block, veto, or rewrite an action mid-flight.

Why this is locked for v1: synchronous "wait for the flow to answer" across a cross-process WS link — with a user-managed peer that may be disconnected — requires request/response correlation, timeouts, and blocking UI against a peer Atlas does not control. That is a large, fragile jump. Interception can be added later behind a capability flag once the reactive model is proven.

> **This is the one assumption to confirm before building.** The plan below assumes reactive-only. If interception is required for v1, milestones change materially.

---

## Opt-in, settings, lifecycle

- **Settings toggle** "Enable Node-RED integration" (off by default). When off: no transport, no port, no listener — zero footprint, preserving the 200 ms startup philosophy.
- Settings surface: port, generated token (copy button, regenerate), connection status indicator, and (later) the named-pipe hardening toggle.
- **Connection state**: events with no connected subscriber simply go nowhere (the reactive model). Atlas must render a graceful "no automation client connected" state and never block on the absence of one.
- **Persistence**: token + settings follow the existing settings store. The user's flows live in *their* Node-RED, not in Atlas.

---

## Security considerations

Ties directly to the readme security notes ("ensure ALL http requests from the frontend are blocked… no internet functionality", [readme.md](../readme.md)):

- The "no frontend HTTP" rule is about the **renderer**. This feature adds a **main-process** localhost listener — a different trust boundary. **Document this explicitly in the security notes** so future-you doesn't read it as a contradiction.
- Loopback-only bind + non-loopback rejection + token auth.
- No npm palette inside Atlas — it lives in the user's Node-RED.
- The `atlas-action` "run script" capability executes within Atlas's privileges; gate it behind the same opt-in and consider a per-capability setting (e.g. allow events but disallow script execution).

---

## Open questions to pin before/while building

1. **Reactive vs. interceptive (v1).** Plan assumes reactive-only. Confirm.
2. **`run script` capability** — included in `atlas-action` v1, or deferred until the event-only surface is proven?
3. **Default transport** — loopback WS confirmed as default; named-pipe as later hardening?
4. **Node package naming / distribution** — `node-red-contrib-atlas` on public npm vs. a downloadable tarball from releases.

---

## Phased implementation plan

**Phase 0 — Foundation (no Node-RED yet)**
- Introduce `AtlasBus` (EventEmitter) in the main process.
- Migrate existing emits (alert count, monitoring) to publish through it; make `broadcast()` a subscriber.
- Add the single `atlas-bus-publish` ipc channel for renderer-originated events (start with `panel.browse`).
- *Outcome:* cleaner internal event flow, valuable on its own.

**Phase 1 — Transport adapter + WS server**
- Define the `Transport` interface.
- Implement the loopback WS server with token auth and non-loopback rejection.
- Settings toggle + token UI + connection-status indicator.
- Wire bus ↔ transport for **events only** (no commands yet).

**Phase 2 — Node package, input nodes**
- Scaffold `node-red-contrib-atlas` with the Atlas Connection config node.
- Implement the three input nodes (`atlas-panel-browse`, `atlas-monitor-update`, `atlas-alert-in`) end-to-end against Phase 1.
- *Milestone:* user can react to Atlas in their own Node-RED.

**Phase 3 — Output nodes (commands)**
- Add `command`/`result` to the protocol and transport.
- Implement `atlas-alert-out` and `atlas-action` (start with navigate-panel + apply-label; script execution per open question #2).
- *Milestone:* flows can act back on Atlas.

**Phase 4 — Trigger nodes (registration)**
- Add `register`/`unregister`; dynamic add/remove of context-menu items ([public/js/modules/contexts.js](../public/js/modules/contexts.js)) and hotkeys as connections come/go.
- Implement `atlas-context-menu` and `atlas-hotkey`.
- *Milestone:* user-defined menu items and hotkeys trigger flows.

**Phase 5 — Hardening + docs**
- Optional named-pipe transport + peer-PID check.
- Per-capability gating (e.g. disable script execution).
- User docs (a new `user-docs/` entry) + update security notes.

---

## Risks

- **main.js is a hot monolith** — the bus refactor touches it and will conflict with ongoing `master` work; merge `master` in often.
- **Protocol versioning** — once published, the node package and Atlas evolve independently; the handshake version field is mandatory from day one.
- **Cross-process lifecycle** — reconnect logic in nodes; Atlas must never assume a client is present.
- **Setup friction** — non-technical users must install Node.js + Node-RED + the palette + pair a token. Acceptable for an opt-in power-user feature; revisit with the "spawn-managed" future option if friction proves blocking.

---

## Future options (kept open by the adapter design)

- **Embedded Node-RED** — add an in-process transport implementing the same interface; the six nodes are unchanged for the user.
- **Atlas-spawned instance** — detect a locally installed Node-RED and launch it as a child process for near-one-click UX without bundling. Still the external model, plus lifecycle management.
- **Other local automation clients** — anything that speaks the protocol over loopback can integrate; Node-RED is just the first.
