# Provider Interface v2 — The Contract Between Gateway and Providers

## The split

```
Extension (Gateway)                   Provider (tap, browser, anything)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━        ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Owns the Copilot SDK sessions         Knows nothing about Copilot SDK
Runs the WS server on :9400           Connects as WS client
Calls registerTools() per session     Announces tool definitions
Executes hooks in-process             Sends hook rules (declarative)
Holds EventStreams                    Pushes events, queries streams
Manages session lifecycle             Stateless (can reconnect anytime)
Tracks multiple sessions              Optionally picks a session
```

One extension, installed once. Unlimited providers, no install needed.

## Transport abstraction

The provider interface is a message contract, not a wire format. Two transports implement it:

```
Gateway process
├── WsProviderTransport   → JSON over WebSocket (external providers)
├── LocalProviderTransport → direct function calls (in-process providers)
└── tap runtime (uses LocalProviderTransport — same contract, no serialization)
```

External providers connect via `ws://localhost:9400`. In-process providers (like tap) use direct method calls with the same message shapes. The gateway treats both identically for registration, tool dispatch, and hook evaluation.

---

## Multi-session model

### The problem

Multiple Copilot CLI sessions can run simultaneously on the same machine (different terminals, different projects). Each session loads the gateway extension. Only one can bind the WS port.

### The solution: shared gateway with session registry

```
Terminal 1: copilot (project-foo)
  └─ Gateway extension starts
       └─ Tries to bind :9400 → success → becomes the gateway owner
       └─ Registers session "abc" (cwd: /code/foo)

Terminal 2: copilot (project-bar)
  └─ Gateway extension starts
       └─ Tries to bind :9400 → EADDRINUSE
       └─ Connects to existing gateway as an internal client
       └─ Registers session "def" (cwd: /code/bar)

Both sessions are now managed by the single gateway on :9400.
```

### Session registry

The gateway maintains a registry of active sessions:

```json
[
  { "id": "abc", "label": "PR #42 review", "cwd": "/code/foo", "foreground": true },
  { "id": "def", "label": "feature/auth", "cwd": "/code/bar", "foreground": false }
]
```

### What happens when sessions come and go

| Event | Gateway behavior |
|---|---|
| **New session registers** | Added to registry. Gateway sends `sessions.updated` to all connected providers. Internal providers spawned from that session's config are bound to it. |
| **Session ends** | Removed from registry. Internal providers bound to it are stopped. External providers bound to it receive `session.lifecycle: shutdown.pending` with a deadline. Providers bound to `"all"` are unaffected. Gateway sends `sessions.updated` to all providers. |
| **Gateway-owning session ends** | If other sessions remain, gateway ownership transfers — the WS server keeps running. If no sessions remain, the gateway shuts down. |
| **All sessions end** | Gateway shuts down. WS server closes. External providers disconnect. |
| **External provider is bound to a session that ends** | Provider receives `session.lifecycle: shutdown.pending`. Its tools are deregistered from that session. The provider stays connected and can re-bind to another session via a new `hello`. |

### Provider perspective

Providers never manage sessions. They see:

1. `sessions` message on connect — list of active sessions
2. `sessions.updated` when sessions come or go — updated list
3. They pick a session in `hello` (or `"all"`)
4. If their session ends, they get `session.lifecycle: shutdown.pending` and can re-bind

---

## Session binding

| Provider type | Session binding | Who decides |
|---|---|---|
| **Internal** (spawned by gateway from project config) | Bound to the session that started it | Automatic — gateway stamps it |
| **External** (self-connects via WS) | Picks a session, or `"all"` | Provider decides, using session list from gateway |
| **In-process** (tap, via LocalProviderTransport) | Bound to its session | Automatic — same process |

### What "bound to a session" means

- Provider's tools are registered only in that session's `registerTools()` call
- Provider's `push` events are injected into that session only
- Provider's hook rules apply to that session only
- Provider's transforms apply to that session only
- When `session: "all"`, everything is registered in every active session

---

## Provider lifecycle

```
Provider connects via WS
    │
    ▼
Provider sends: auth (gateway secret)
    │
    ▼
Gateway sends: sessions (list of active sessions)
    │
    ▼
Provider sends: hello (name, session, instance, tools, hooks, context)
    │
    ▼
Gateway sends: hello.ack (reconnectToken, persistDir)
    │
    ▼
Gateway registers tools + hook rules in the bound session(s)
    │
    ├─── Copilot calls a tool ──► Gateway sends: tool.call
    │                              Provider sends: tool.result
    │
    ├─── Transform needed ──► Gateway sends: transform.request
    │                          Provider sends: transform.result
    │
    ├─── Gate check needed ──► Gateway sends: gate.check
    │                           Provider sends: gate.result
    │
    ├─── Provider pushes event ──► Gateway routes to session
    │
    ├─── Provider updates tools ──► Gateway re-registers
    │
    ├─── Sessions change ──► Gateway sends: sessions.updated
    │
    ▼
Session ending:
    Gateway sends: session.lifecycle (shutdown.pending, deadline)
    Provider does async cleanup
    Provider sends: shutdown.ready
    Gateway proceeds with teardown

Disconnect (or crash):
    Gateway removes provider's tools + hook rules from bound session(s)
```

---

## Protocol rules

### Authentication

The gateway generates a one-time **gateway secret** on first startup, written to `$COPILOT_HOME/.tap-gateway-secret`. All WS connections must include the secret as the first message:

```json
{ "type": "auth", "secret": "gw-a8f3..." }
```

Gateway responds with `sessions` on success, or closes the socket on failure. Internal providers (LocalProviderTransport) skip auth. The gateway spawns project providers with the secret as env var `TAP_GATEWAY_SECRET`.

**External provider bootstrap:** The gateway also serves a one-shot HTTP endpoint at `http://localhost:9400/secret` that returns the secret. This endpoint only responds to requests from `127.0.0.1`/`::1`. No origin or CORS restrictions — any local process or injected page script can fetch it. The security boundary is localhost network access, not origin.

### Session IDs and correlation IDs

All `id` and `callId` values are **globally unique** (UUIDs or equivalent). A provider can safely correlate responses without `sessionId` because IDs never collide across sessions.

All session-scoped gateway→provider messages include `sessionId`:

- `session.lifecycle`, `session.event`, `tool.call`, `tool.cancel`, `gate.check`, `transform.request`

Provider→gateway responses do NOT need `sessionId` — the gateway correlates via the globally unique `id`/`callId`. Exception: `shutdown.ready` includes `sessionId` because it's not a response to a specific call.

### Error responses

The gateway sends `error` for any invalid message:

```json
{
  "type": "error",
  "code": "INVALID_SESSION",
  "message": "Session def456 does not exist",
  "replyTo": "hello"
}
```

Error codes: `INVALID_JSON`, `UNKNOWN_TYPE`, `INVALID_SESSION`, `AUTH_FAILED`, `DUPLICATE_INSTANCE`, `TOOL_CONFLICT`, `RATE_LIMITED`, `PAYLOAD_TOO_LARGE`.

### Tool name collisions

- Two providers CANNOT register the same tool name in the same session. Second registration gets `error` with code `TOOL_CONFLICT`.
- Multi-instance providers (same `name`, different `instance`) share tool names — the gateway merges them with auto-injected `target` parameter (see Multi-instance section).
- Provider tool names MUST NOT start with `list_` followed by another provider's name (reserved for auto-generated meta-tools).

### Terminal message ordering for tool calls

A tool call has one terminal state. The first terminal message wins:

- `tool.result` arrives → call is complete. Any later `tool.result` for the same `id` is ignored.
- `tool.cancel` sent → provider MUST respond with `tool.result { errorCode: "CANCELLED" }` as the terminal state. If a non-cancelled `tool.result` arrives after `tool.cancel`, gateway ignores it.
- Provider disconnects with in-flight calls → gateway returns `errorCode: "DISCONNECTED"` to Copilot. The call is NOT replayed on reconnect.

### Gate timeout behavior: fail closed

Gates default to **deny** on timeout, not allow. A provider that registers a gate is asserting safety invariants. Silence = don't proceed.

```
gate.check sent → 5s timeout → no gate.result → permissionDecision: "deny"
  reason: "Gate provider 'ci-watcher' did not respond in time."
```

Providers can opt into fail-open per gate rule: `{ "action": "gate", "gateId": "...", "failOpen": true }`.

If a provider **disconnects** with a pending `gate.check`, the gate is denied (fail closed). Pending `transform.request` calls fall back to `current` content unchanged on disconnect.

### Reconnect protocol

1. Gateway generates `reconnectToken` in `hello.ack`. Token is valid for 30 seconds.
2. On reconnect, provider includes `reconnectToken` in `hello`. Gateway:
   - Invalidates the old connection (if still open)
   - Restores provider binding (session, tools, hooks)
3. Any in-flight `tool.call` at disconnect time is **failed** with `errorCode: "DISCONNECTED"` (not replayed). The provider starts clean — no `pendingCalls`.
4. Token expires after 30s — reconnect after that is a fresh `hello`.
5. Only one active connection per `name` + `instance`. New connection with same identity kills the old one.

### Push loop prevention

The gateway enforces push budgets scoped by **(provider, sessionId)**:
- Max 10 `push` messages per second per (provider, session).
- A `push` with `level: "inject"` triggers an AI turn. The gateway will not deliver another `inject`-level push from the same provider to the same session until that session becomes idle.
- After 3 consecutive inject→response→inject cycles from the same provider in the same session, the gateway pauses that provider's inject pushes to that session and logs a warning.

### Stream access control

- Providers can query their **own** streams via `stream.query` by default.
- To query another provider's streams, the `hello` must include `"streamAccess": "all"`. The gateway logs cross-provider stream reads for auditability.
- `filter.set` only works on the provider's own streams. A provider cannot set filters on another provider's streams.

### Payload limits

- Max message size: **5 MB** for `tool.result` messages (screenshots, large outputs). **2 MB** for all other messages.
- For payloads exceeding 5 MB, local providers should write to `persistDir` and return a file reference:
  ```json
  { "type": "tool.result", "id": "call-123", "file": { "path": "/home/user/.copilot/providers/browser/screenshot-abc.png", "mimeType": "image/png", "size": 8421000, "ttl": 300 } }
  ```
  - `path` — absolute path on the local filesystem. Must be within the provider's `persistDir`.
  - `mimeType` — MIME type for the gateway to pass to Copilot.
  - `size` — byte size.
  - `ttl` — seconds until the provider may delete the file. Gateway must read it before TTL expires.
  - Browser providers cannot use file refs (no filesystem access). Browser screenshots should be downscaled or compressed to stay within the 5 MB inline limit.
- Max tools per provider: **100**.
- Max hook rules per provider: **50**.
- Max streams per provider: **20**.
- EventStream retention: **200 events** per stream (oldest evicted).
- `stream.query` max `last`: **100**.

### `"all"` binding and session churn

When a provider is bound to `"all"`:
- Its tools and context are registered in all **currently active** sessions at `hello` time.
- When a new session starts, the gateway registers the provider's tools and context in the new session. **Fail-closed gate rules are NOT activated** until the provider receives `sessions.updated` and has a chance to initialize session-specific state. Gates become active after a 5s grace period or after the provider sends `hooks.update` for that session.
- When a session ends, the provider receives `session.lifecycle: shutdown.pending` with that session's `sessionId`. After cleanup, provider sends `shutdown.ready` with the same `sessionId`. The provider remains connected for other sessions.

### Gateway process model

The gateway runs as a **detached background process**, not inside any single Copilot session's extension process.

1. First Copilot session starts → extension checks if gateway is running (attempts WS connect to `:9400`).
2. Not running → extension spawns the gateway as a detached process (survives session end). Extension connects to it as an internal client registering its session.
3. Already running → extension connects and registers its session.
4. Gateway exits when the last session disconnects (after a **30s** grace period — matches reconnect token TTL, so reconnecting providers and late-arriving sessions have time).

### Regex execution safety

- `match.args` patterns are compiled with a **1ms execution timeout** (per match attempt). Catastrophic backtracking is terminated.
- Stringification format for args: `JSON.stringify(args)`. Deterministic across runtimes.
- `filter.set` rules use the same regex engine with the same timeout.

---

## Messages: Gateway → Provider

### `sessions` — active session list (sent on connect)

```json
{
  "type": "sessions",
  "active": [
    { "id": "abc123", "label": "PR #42 review", "cwd": "/code/foo" },
    { "id": "def456", "label": "feature/auth", "cwd": "/code/bar" }
  ]
}
```

### `sessions.updated` — session list changed

Same shape as `sessions`. Sent when a session starts or ends.

### `hello.ack` — registration acknowledged

```json
{
  "type": "hello.ack",
  "reconnectToken": "tok-xyz789",
  "persistDir": "/home/user/.copilot/providers/my-provider/"
}
```

- `reconnectToken` — include in future `hello` to restore binding after disconnect
- `persistDir` — filesystem path for cross-session state (local providers only)

### `tool.call` — Copilot invoked a provider's tool

```json
{
  "type": "tool.call",
  "id": "call-123",
  "sessionId": "abc123",
  "tool": "my_tool",
  "args": { "query": "find active users" }
}
```

### `tool.cancel` — abort an in-flight tool call

```json
{
  "type": "tool.cancel",
  "id": "call-123",
  "sessionId": "abc123",
  "reason": "timeout"
}
```

Sent when a tool call exceeds its timeout or the session is interrupted. Provider should abort and send `tool.result` with `errorCode: "CANCELLED"` as the terminal state.

### `gate.check` — a hook rule matched, provider evaluates

```json
{
  "type": "gate.check",
  "gateId": "check-before-push",
  "callId": "gate-456",
  "sessionId": "abc123",
  "tool": "shell",
  "args": { "command": "git push origin main" }
}
```

Timeout: 5s. If no response, gateway **denies** the action (fail closed). See Protocol Rules.

### `transform.request` — dynamic transform callback

Sent during `onUserPromptSubmitted` when a provider registered a `"callback"` transform.

```json
{
  "type": "transform.request",
  "callId": "tx-789",
  "sessionId": "abc123",
  "section": "custom_instructions",
  "current": "...existing section content..."
}
```

Timeout: 2s. Falls back to `current` unchanged if no response.

### `session.event` — forwarded session events (if subscribed)

```json
{
  "type": "session.event",
  "sessionId": "abc123",
  "event": "user.message",
  "data": { "content": "fix the auth bug" }
}
```

#### Event payload shapes

| Event | Payload |
|---|---|
| `user.message` | `{ content: string }` |
| `assistant.message` | `{ content: string, toolRequests?: [{ name, args }] }` |
| `tool.execution_complete` | `{ tool: string, provider?: string, args: object, result: { type: "success"\|"failure", output?: string }, durationMs: number }` |
| `assistant.intent` | `{ intent: string }` |

Providers opt into events in `hello.subscribe`:

```json
{ "subscribe": ["user.message", "assistant.message", "tool.execution_complete"] }
```

### `session.lifecycle` — session state changes

```json
{ "type": "session.lifecycle", "sessionId": "abc123", "state": "started" }
{ "type": "session.lifecycle", "sessionId": "abc123", "state": "idle" }
{ "type": "session.lifecycle", "sessionId": "abc123", "state": "shutdown.pending", "deadline": 10000 }
```

Always sent, no opt-in needed.

- `started` — session is ready
- `idle` — session is idle (no in-flight work). Providers can use this to trigger scheduled work.
- `shutdown.pending` — session is ending. Provider has `deadline` milliseconds to do async cleanup, then send `shutdown.ready`. Gateway tears down after deadline even if no response.

### Rebinding (repeat `hello` on existing connection)

A provider can send a new `hello` on an existing connection to change its session binding (e.g., after its session ends). Behavior:

1. Gateway atomically removes the provider's tools/hooks/context from the old session(s).
2. Gateway cancels any in-flight `tool.call`, `gate.check`, or `transform.request` for this provider.
3. Gateway processes the new `hello` as a fresh registration (validates session, registers tools).
4. Gateway sends a new `hello.ack` with a new `reconnectToken`.
5. If the new `hello` fails validation, gateway sends `error` and the provider remains unbound (connected but not registered to any session).

### `stream.history` — response to stream query

```json
{
  "type": "stream.history",
  "queryId": "q-1",
  "streams": {
    "ci-watch@ci-watcher": [
      { "ts": "2026-04-26T14:01:00Z", "event": "failure on test/auth.spec.ts" },
      { "ts": "2026-04-26T14:00:00Z", "event": "running" }
    ],
    "git-watch@guardian": [
      { "ts": "2026-04-26T14:00:30Z", "event": "behind=2" }
    ]
  }
}
```

Stream keys use `stream@provider` format matching the query.

---

## Messages: Provider → Gateway

### `hello` — register as a provider

```json
{
  "type": "hello",
  "name": "my-provider",
  "session": "abc123",
  "instance": "tab-a3f8",
  "reconnectToken": "tok-xyz789",
  "startup_context": "Provider loaded. Monitoring 3 endpoints.",
  "metadata": {
    "url": "https://app.example.com",
    "title": "Dashboard"
  },
  "tools": [
    {
      "name": "my_tool",
      "description": "Does something useful",
      "timeout": 15000,
      "parameters": {
        "type": "object",
        "properties": {
          "query": { "type": "string" }
        },
        "required": ["query"]
      }
    }
  ],
  "hooks": {
    "onPreToolUse": [
      {
        "match": { "tool": "shell", "args": "git push" },
        "action": "gate",
        "gateId": "check-before-push"
      }
    ],
    "transforms": {
      "code_change_rules": { "action": "callback" },
      "custom_instructions": {
        "action": "append",
        "content": "This repo uses pnpm, not npm."
      }
    }
  },
  "subscribe": ["user.message", "assistant.message"],
  "context": "CI is currently passing. No active deploys."
}
```

| Field | Required | Description |
|---|---|---|
| `name` | yes | Provider identity |
| `session` | no | Session to bind to. Omit for internal providers (gateway auto-stamps). `"all"` for broadcast. |
| `instance` | no | Unique instance ID for multi-instance providers (e.g., browser tabs). Gateway uses `name` + `instance` as compound key. |
| `reconnectToken` | no | Token from previous `hello.ack` to restore binding after disconnect. |
| `startup_context` | no | Injected into session start context (not per-prompt). |
| `metadata` | no | Provider-specific info exposed to Copilot for routing decisions. |
| `tools` | no | Tool definitions with JSON Schema parameters. `timeout` (ms) per tool is optional. |
| `hooks` | no | Hook rules and transform declarations. |
| `subscribe` | no | Session event types to receive. |
| `streamAccess` | no | `"own"` (default) or `"all"`. Controls whether `stream.query` can read other providers' streams. |
| `context` | no | Ambient context injected on every user prompt. |

### `tool.result` — respond to a tool invocation

Success:
```json
{
  "type": "tool.result",
  "id": "call-123",
  "data": { "user": "alice", "role": "admin" }
}
```

Failure:
```json
{
  "type": "tool.result",
  "id": "call-123",
  "error": "Element not found: #submit-btn",
  "errorCode": "NOT_FOUND",
  "retryable": false
}
```

Error codes: `NOT_FOUND`, `TIMEOUT`, `CANCELLED`, `DISCONNECTED`, `UNAUTHORIZED`, `INTERNAL`. `retryable` hints whether the gateway should retry on another instance.

### `tool.progress` — incremental status for slow tools

```json
{
  "type": "tool.progress",
  "id": "call-123",
  "message": "Capturing viewport... 60%"
}
```

Gateway surfaces via `session.log()`. Final result still comes via `tool.result`.

### `gate.result` — respond to a hook gate check

```json
{
  "type": "gate.result",
  "gateId": "check-before-push",
  "callId": "gate-456",
  "decision": "deny",
  "reason": "CI is failing on this branch. Fix tests first."
}
```

`decision`: `"allow"` | `"deny"` | `"context"` (allow but inject `reason` as additional context).

### `transform.result` — respond to a transform callback

```json
{
  "type": "transform.result",
  "callId": "tx-789",
  "content": "...existing content plus dynamic additions based on live state..."
}
```

### `push` — send an event into the session

```json
{
  "type": "push",
  "stream": "ci-watch",
  "event": "CI failed on test/auth.spec.ts",
  "level": "inject",
  "metadata": { "kind": "ci-failure", "runId": 12345 }
}
```

| Field | Required | Description |
|---|---|---|
| `stream` | no | Named stream. Defaults to provider name if omitted. One provider can manage multiple streams. |
| `sessionId` | no | Target session. Required for `"all"`-bound providers to target a specific session. Omit to target all bound sessions. Single-session providers can always omit. |
| `event` | yes (unless `prompt`) | Event text to store/surface/inject. |
| `prompt` | no | When present, triggers a full AI turn via `session.send({ prompt })`. Use for PromptEmitter-style injections. |
| `level` | yes | `"inject"` = `session.send()`, triggers AI turn. `"surface"` = `session.log()`, visible in timeline. `"keep"` = store in EventStream only. |
| `metadata` | no | Structured data for display, deduplication, chaining. |

### `tools.update` — change tool definitions

```json
{
  "type": "tools.update",
  "sessionId": "abc123",
  "tools": [
    { "name": "new_tool", "description": "Just appeared", "parameters": {} }
  ],
  "remove": ["old_tool"]
}
```

`sessionId` is optional. Omit to apply to all bound sessions. `"all"`-bound providers use it to update tools in one session only.

### `hooks.update` — change hook rules or transforms

```json
{
  "type": "hooks.update",
  "sessionId": "abc123",
  "onPreToolUse": [
    {
      "match": { "tool": "edit", "file": "*.sql" },
      "action": "context",
      "content": "This is a migration file. Ensure backward compatibility."
    }
  ],
  "transforms": {
    "code_change_rules": { "action": "callback" },
    "custom_instructions": null
  }
}
```

Setting a transform to `null` removes it. `"callback"` triggers `transform.request` round-trips. `sessionId` is optional — omit to apply to all bound sessions.

### `context.update` — change ambient context

```json
{
  "type": "context.update",
  "context": "CI is now passing. Deploy v2.4.3 completed."
}
```

### `filter.set` — set gateway-side EventFilter for a stream

```json
{
  "type": "filter.set",
  "stream": "git-watch",
  "rules": [
    { "match": "behind=0", "outcome": "drop" },
    { "match": "conflicts=[1-9]", "outcome": "inject" },
    { "match": ".*", "outcome": "keep" }
  ]
}
```

When a filter exists, the gateway applies it to `push` events on that stream. The `level` field on `push` is overridden by the filter outcome. First-match wins.

### `stream.query` — read EventStream history

```json
{
  "type": "stream.query",
  "queryId": "q-1",
  "sessionId": "abc123",
  "streams": ["ci-watch@ci-watcher", "git-watch@guardian"],
  "last": 10
}
```

`sessionId` is optional for single-session providers, required for `"all"`-bound providers.

Stream names use the format `stream@provider` to avoid collisions. Omit `@provider` to query your own streams. Cross-provider reads require `streamAccess: "all"` in `hello`.

### `shutdown.ready` — async cleanup complete

```json
{
  "type": "shutdown.ready",
  "sessionId": "abc123"
}
```

Sent after `session.lifecycle: shutdown.pending`. Tells the gateway this provider is done cleaning up.

### `goodbye` — graceful disconnect

```json
{
  "type": "goodbye",
  "reason": "shutting down"
}
```

---

## Multi-instance providers (browser tabs)

When multiple providers share the same `name` (e.g., 5 browser tabs), the gateway:

1. Uses `name` + `instance` as the compound key
2. Registers **one** copy of each shared tool with an auto-injected `target` parameter
3. Generates a meta-tool `list_{name}_instances` from connected instances + metadata
4. Routes `tool.call` to the matching instance via `target`
5. If `target` is omitted, routes to the most recently active instance

```json
// Auto-generated tool schema (gateway creates this)
{
  "name": "browser_screenshot",
  "description": "Screenshot the viewport",
  "parameters": {
    "type": "object",
    "properties": {
      "target": {
        "type": "string",
        "description": "Tab instance ID. Available: tab-a3f8 (Dashboard — MyApp), tab-b2c1 (Settings)"
      }
    }
  }
}
```

```json
// Auto-generated meta-tool
{
  "name": "list_browser_instances",
  "description": "List connected browser tab instances",
  "handler": "returns instance IDs + metadata for all connected browser providers"
}
```

---

## Hook rules — declarative API

Providers declare rules, gateway evaluates them in-process.

### onPreToolUse rules

| Action | Behavior | Round-trip? |
|---|---|---|
| `"deny"` | Block the tool call with `reason` | No (static) |
| `"context"` | Allow but inject `content` as additional context | No (static) |
| `"gate"` | Ask the provider to evaluate via `gate.check`/`gate.result` | Yes (5s timeout) |

```json
{
  "match": { "tool": "shell", "args": "git push" },
  "action": "gate",
  "gateId": "check-ci-status"
}
```

`match.tool` is the tool name. `match.args` is a regex tested against stringified args. `match.provider` scopes to a specific provider's tools (omit for all tools).

### Transform rules

| Action | Behavior | Round-trip? |
|---|---|---|
| `"append"` | Append static `content` to section | No |
| `"prepend"` | Prepend static `content` to section | No |
| `"replace"` | Replace section with static `content` | No |
| `"callback"` | Ask provider at prompt time via `transform.request`/`transform.result` | Yes (2s timeout) |

Multiple providers can append to the same section. Gateway concatenates in registration order.

---

## Summary: the complete interface

### Gateway → Provider (11 message types)

| Message | When | Round-trip? |
|---|---|---|
| `sessions` | On connect (after auth) | — |
| `sessions.updated` | Session starts/ends | — |
| `hello.ack` | After `hello` | — |
| `error` | Invalid message from provider | — |
| `tool.call` | Copilot invokes a tool | Expects `tool.result` |
| `tool.cancel` | Tool timed out or session interrupted | — |
| `gate.check` | Hook rule matched with `action: "gate"` | Expects `gate.result` (5s, fail closed) |
| `transform.request` | Prompt submitted, provider has callback transform | Expects `transform.result` (2s) |
| `session.event` | Session event (if subscribed) | — |
| `session.lifecycle` | Session state change (includes `sessionId`) | — |
| `stream.history` | Response to `stream.query` | — |

### Provider → Gateway (14 message types)

| Message | When |
|---|---|
| `auth` | First message on connect |
| `hello` | After receiving `sessions` |
| `goodbye` | Graceful disconnect |
| `tool.result` | Responding to `tool.call` |
| `tool.progress` | Incremental status for slow tools |
| `gate.result` | Responding to `gate.check` |
| `transform.result` | Responding to `transform.request` |
| `push` | Unsolicited event or prompt |
| `tools.update` | Add/remove tools |
| `hooks.update` | Change hook rules or transforms |
| `context.update` | Change ambient context |
| `filter.set` | Set/update EventFilter rules on a stream |
| `stream.query` | Read EventStream history |
| `shutdown.ready` | Async cleanup complete (includes `sessionId`) |

### Total: 25 message types

---

## What a minimal provider looks like

### Node.js — 50 lines

```js
import WebSocket from "ws";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const secret = process.env.TAP_GATEWAY_SECRET
  || readFileSync(join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), ".tap-gateway-secret"), "utf8").trim();

const ws = new WebSocket("ws://localhost:9400");

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "auth", secret }));
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw);

  if (msg.type === "sessions") {
    ws.send(JSON.stringify({
      type: "hello",
      name: "hello-provider",
      session: msg.active[0]?.id ?? "all",
      tools: [{
        name: "say_hello",
        description: "Says hello to someone",
        parameters: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"]
        }
      }]
    }));
  }

  if (msg.type === "tool.call" && msg.tool === "say_hello") {
    ws.send(JSON.stringify({
      type: "tool.result",
      id: msg.id,
      data: `Hello, ${msg.args.name}!`
    }));
  }
});
```

### Browser — injected via Detour, with session picker and auth

```js
const GATEWAY = "localhost:9400";
let ws, sessions = [], registered = false, secret;

// Step 1: fetch auth secret from gateway HTTP endpoint
fetch(`http://${GATEWAY}/secret`)
  .then(r => r.text())
  .then(s => { secret = s.trim(); connect(); })
  .catch(() => showOverlay("No Copilot session — start one to connect"));

function connect() {
  ws = new WebSocket(`ws://${GATEWAY}`);

  ws.onopen = () => {
    // Step 2: authenticate
    ws.send(JSON.stringify({ type: "auth", secret }));
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    // Step 3: receive session list
    if (msg.type === "sessions" || msg.type === "sessions.updated") {
      sessions = msg.active;
      if (!registered) {
        if (sessions.length === 0) showOverlay("Waiting for Copilot session...");
        else if (sessions.length === 1) register(sessions[0].id);
        else showSessionPicker(sessions, (s) => register(s.id));
      }
      return;
    }

    if (msg.type === "tool.call") handleToolCall(msg);
    if (msg.type === "tool.cancel") handleCancel(msg);
  };

  ws.onclose = () => {
    registered = false;
    setTimeout(connect, 5000); // auto-reconnect
  };
}

function register(sessionId) {
  registered = true;
  ws.send(JSON.stringify({
    type: "hello",
    name: "browser",
    instance: "tab-" + Math.random().toString(36).slice(2, 6),
    session: sessionId,
    metadata: { url: location.href, title: document.title },
    tools: [
      { name: "page_title", description: "Get page title", parameters: {} },
      { name: "screenshot", description: "Screenshot viewport (downscaled to <5MB)", timeout: 15000, parameters: {} }
    ]
  }));
}

function handleToolCall(msg) {
  if (msg.tool === "page_title") {
    ws.send(JSON.stringify({ type: "tool.result", id: msg.id, data: document.title }));
  }
  if (msg.tool === "screenshot") {
    ws.send(JSON.stringify({ type: "tool.progress", id: msg.id, message: "Capturing..." }));
    html2canvas(document.body, { scale: 0.5 }).then(canvas => {
      ws.send(JSON.stringify({
        type: "tool.result", id: msg.id,
        data: { image: canvas.toDataURL("image/jpeg", 0.7) }
      }));
    });
  }
}

function handleCancel(msg) {
  // Best-effort: send CANCELLED result
  ws.send(JSON.stringify({
    type: "tool.result", id: msg.id,
    error: "Cancelled", errorCode: "CANCELLED", retryable: false
  }));
}
```

### Python — 35 lines

```python
import asyncio, json, websockets

async def provider():
    async with websockets.connect("ws://localhost:9400") as ws:
        async for raw in ws:
            msg = json.loads(raw)

            if msg["type"] == "sessions":
                await ws.send(json.dumps({
                    "type": "hello",
                    "name": "python-provider",
                    "session": msg["active"][0]["id"] if msg["active"] else "all",
                    "tools": [{
                        "name": "compute",
                        "description": "Evaluate a Python expression",
                        "parameters": {
                            "type": "object",
                            "properties": {"expr": {"type": "string"}},
                            "required": ["expr"]
                        }
                    }]
                }))

            if msg["type"] == "tool.call" and msg["tool"] == "compute":
                try:
                    result = eval(msg["args"]["expr"])
                except Exception as e:
                    result = str(e)
                await ws.send(json.dumps({
                    "type": "tool.result",
                    "id": msg["id"],
                    "data": result
                }))

asyncio.run(provider())
```
