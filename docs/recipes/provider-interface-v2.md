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
| **Session ends** | Removed from registry. Internal providers bound to it are stopped. External providers bound to it receive `session.lifecycle: shutdown`. Providers bound to `"all"` are unaffected. Gateway sends `sessions.updated` to all providers. |
| **Gateway-owning session ends** | If other sessions remain, gateway ownership transfers — the WS server keeps running. If no sessions remain, the gateway shuts down. |
| **All sessions end** | Gateway shuts down. WS server closes. External providers disconnect. |
| **External provider is bound to a session that ends** | Provider receives `session.lifecycle: shutdown`. Its tools are deregistered from that session. The provider stays connected and can re-bind to another session via a new `hello`. |

### Provider perspective

Providers never manage sessions. They see:

1. `sessions` message on connect — list of active sessions
2. `sessions.updated` when sessions come or go — updated list
3. They pick a session in `hello` (or `"all"`)
4. If their session ends, they get `session.lifecycle: shutdown` and can re-bind

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
Gateway sends: sessions (list of active sessions)
    │
    ▼
Provider sends: hello (name, session, instance, tools, hooks, context)
    │
    ▼
Gateway sends: hello.ack (reconnectToken, persistDir, session info)
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
  "persistDir": "/home/user/.copilot/providers/my-provider/",
  "pendingCalls": []
}
```

- `reconnectToken` — include in future `hello` to restore binding after disconnect
- `persistDir` — filesystem path for cross-session state (local providers only)
- `pendingCalls` — tool calls that were in-flight during a previous disconnection

### `tool.call` — Copilot invoked a provider's tool

```json
{
  "type": "tool.call",
  "id": "call-123",
  "tool": "my_tool",
  "args": { "query": "find active users" }
}
```

### `tool.cancel` — abort an in-flight tool call

```json
{
  "type": "tool.cancel",
  "id": "call-123",
  "reason": "timeout"
}
```

Sent when a tool call exceeds its timeout or the session is interrupted. Provider should abort and may send a `tool.result` with `errorCode: "CANCELLED"`.

### `gate.check` — a hook rule matched, provider evaluates

```json
{
  "type": "gate.check",
  "gateId": "check-before-push",
  "callId": "gate-456",
  "tool": "shell",
  "args": { "command": "git push origin main" }
}
```

Timeout: 5s. If no response, gateway allows the action.

### `transform.request` — dynamic transform callback

Sent during `onUserPromptSubmitted` when a provider registered a `"callback"` transform.

```json
{
  "type": "transform.request",
  "callId": "tx-789",
  "section": "custom_instructions",
  "current": "...existing section content..."
}
```

Timeout: 2s. Falls back to `current` unchanged if no response.

### `session.event` — forwarded session events (if subscribed)

```json
{
  "type": "session.event",
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
{ "type": "session.lifecycle", "state": "started" }
{ "type": "session.lifecycle", "state": "idle" }
{ "type": "session.lifecycle", "state": "shutdown.pending", "deadline": 10000 }
```

Always sent, no opt-in needed.

- `started` — session is ready
- `idle` — session is idle (no in-flight work). Providers can use this to trigger scheduled work.
- `shutdown.pending` — session is ending. Provider has `deadline` ms to do async cleanup, then send `shutdown.ready`. Gateway tears down after deadline even if no response.

### `stream.history` — response to stream query

```json
{
  "type": "stream.history",
  "queryId": "q-1",
  "streams": {
    "ci-watch": [
      { "ts": "2026-04-26T14:01:00Z", "event": "failure on test/auth.spec.ts" },
      { "ts": "2026-04-26T14:00:00Z", "event": "running" }
    ],
    "git-watch": [
      { "ts": "2026-04-26T14:00:30Z", "event": "behind=2" }
    ]
  }
}
```

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
| `event` | yes (unless `prompt`) | Event text to store/surface/inject. |
| `prompt` | no | When present, triggers a full AI turn via `session.send({ prompt })`. Use for PromptEmitter-style injections. |
| `level` | yes | `"inject"` = `session.send()`, triggers AI turn. `"surface"` = `session.log()`, visible in timeline. `"keep"` = store in EventStream only. |
| `metadata` | no | Structured data for display, deduplication, chaining. |

### `tools.update` — change tool definitions

```json
{
  "type": "tools.update",
  "tools": [
    { "name": "new_tool", "description": "Just appeared", "parameters": {} }
  ],
  "remove": ["old_tool"]
}
```

### `hooks.update` — change hook rules or transforms

```json
{
  "type": "hooks.update",
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

Setting a transform to `null` removes it. `"callback"` triggers `transform.request` round-trips.

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
  "streams": ["ci-watch", "git-watch", "deploy-watch"],
  "last": 10
}
```

Gateway responds with `stream.history`. Providers can query their own streams and streams from other providers in the same session.

### `shutdown.ready` — async cleanup complete

```json
{
  "type": "shutdown.ready"
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

### Gateway → Provider (10 message types)

| Message | When | Round-trip? |
|---|---|---|
| `sessions` | On connect | — |
| `sessions.updated` | Session starts/ends | — |
| `hello.ack` | After `hello` | — |
| `tool.call` | Copilot invokes a tool | Expects `tool.result` |
| `tool.cancel` | Tool timed out or session interrupted | — |
| `gate.check` | Hook rule matched with `action: "gate"` | Expects `gate.result` (5s) |
| `transform.request` | Prompt submitted, provider has callback transform | Expects `transform.result` (2s) |
| `session.event` | Session event (if subscribed) | — |
| `session.lifecycle` | Session state change | — |
| `stream.history` | Response to `stream.query` | — |

### Provider → Gateway (13 message types)

| Message | When |
|---|---|
| `hello` | On connect, after receiving `sessions` |
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
| `shutdown.ready` | Async cleanup complete |

### Total: 23 message types

---

## What a minimal provider looks like

### Node.js — 50 lines

```js
import WebSocket from "ws";

const ws = new WebSocket("ws://localhost:9400");

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

### Browser — injected via Detour, with session picker

```js
const ws = new WebSocket("ws://localhost:9400");
let sessions = [];

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);

  if (msg.type === "sessions" || msg.type === "sessions.updated") {
    sessions = msg.active;
    if (!registered) {
      if (sessions.length === 1) register(sessions[0].id);
      else showSessionPicker(sessions, (s) => register(s.id));
    }
    return;
  }

  if (msg.type === "tool.call") handleToolCall(msg);
  if (msg.type === "tool.cancel") handleCancel(msg);
};

let registered = false;
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
      { name: "screenshot", description: "Screenshot viewport", timeout: 15000, parameters: {} }
    ]
  }));
}

function handleToolCall(msg) {
  if (msg.tool === "page_title") {
    ws.send(JSON.stringify({ type: "tool.result", id: msg.id, data: document.title }));
  }
  if (msg.tool === "screenshot") {
    ws.send(JSON.stringify({ type: "tool.progress", id: msg.id, message: "Capturing..." }));
    html2canvas(document.body).then(canvas => {
      ws.send(JSON.stringify({
        type: "tool.result", id: msg.id,
        data: { image: canvas.toDataURL("image/png") }
      }));
    });
  }
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
