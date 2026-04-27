---
name: provider
description: "Scaffold a ※ tap provider — an external process that registers tools with Copilot via WebSocket. Use when the user wants to create a provider, extend tap with custom tools, or connect an external service."
argument-hint: "<description of what the provider should do>"
user-invocable: true
---

Create a provider process that connects to the ※ tap gateway and registers tools with the Copilot session.

## What is a provider?

A provider is any external process that speaks the ※ tap WebSocket protocol. It connects to the gateway on `ws://localhost:9400`, authenticates with a token, and registers tools. Copilot can then invoke those tools, and calls are routed through the gateway to the provider.

Providers know nothing about the Copilot SDK. They just handle JSON messages over WebSocket.

## Protocol overview

```
Provider connects → sends auth → receives sessions → sends hello (with tools) → receives hello.ack → BOUND
```

### Connection state machine

```
AwaitAuth ──auth──► AwaitHello ──hello──► Bound ──goodbye/disconnect──► Disconnected
```

### Message types (10)

| Direction | Type | Purpose |
|---|---|---|
| Provider → Gateway | `auth` | First message — send `TAP_PROVIDER_TOKEN` |
| Gateway → Provider | `sessions` | Available sessions — pick one |
| Provider → Gateway | `hello` | Register name, protocol version, session, and tools |
| Gateway → Provider | `hello.ack` | Confirmation — provider is now bound |
| Gateway → Provider | `tool.call` | Copilot invokes a tool — provider must respond |
| Provider → Gateway | `tool.result` | Tool response (exactly one per call) |
| Gateway → Provider | `tool.cancel` | Cancel a pending call — respond with CANCELLED |
| Gateway → Provider | `session.lifecycle` | Session state changes (started/idle/shutdown.pending) |
| Gateway → Provider | `error` | Something went wrong |
| Provider → Gateway | `goodbye` | Clean disconnect |

### Tool definitions

Each tool in the `hello` message:

```json
{
  "name": "tool_name",
  "description": "What the tool does",
  "parameters": {
    "type": "object",
    "properties": {
      "arg1": { "type": "string", "description": "..." }
    },
    "required": ["arg1"]
  }
}
```

- `name` (required) — unique, must not conflict with tap tools or other providers
- `description` (required) — what the tool does
- `parameters` (required) — JSON Schema for arguments
- `timeout` (optional) — max execution time in ms
- Max 100 tools per provider

### Tool results

Success:
```json
{ "type": "tool.result", "id": "<call-id>", "data": "result string or JSON" }
```

Failure:
```json
{ "type": "tool.result", "id": "<call-id>", "error": "message", "errorCode": "NOT_FOUND" }
```

Error codes: `NOT_FOUND`, `TIMEOUT`, `CANCELLED`, `INTERNAL`

### Payload limits

- `tool.result`: max 5 MB
- All other messages: max 2 MB

### Error codes from gateway

| Code | Fatal? | Meaning |
|---|---|---|
| `AUTH_FAILED` | Yes | Bad token — close connection |
| `UNSUPPORTED_VERSION` | Yes | Wrong protocolVersion — close |
| `INVALID_SESSION` | No | Unknown session ID |
| `TOOL_CONFLICT` | No | Tool name already taken |
| `PAYLOAD_TOO_LARGE` | No | Message exceeds limit |

### Forward compatibility

- Ignore unknown fields in incoming messages
- Ignore unknown gateway→provider message types (log and discard)

## Required behavior

When this skill is invoked:

1. **Ask the user** what the provider should do if the input is vague. Get clarity on:
   - What tools should it expose?
   - What does each tool do?
   - What language? (default to Node.js if not specified)
   - Does it need external APIs or libraries?

2. **Generate a complete, runnable provider** that:
   - Reads `TAP_PROVIDER_TOKEN` from the environment
   - Connects to `ws://localhost:9400`
   - Sends `auth` with the token
   - On `sessions`, picks the first session and sends `hello` with tool definitions
   - On `hello.ack`, logs that it's registered
   - On `tool.call`, dispatches to the right handler and sends `tool.result`
   - On `tool.cancel`, responds with `{ error: "Cancelled", errorCode: "CANCELLED" }`
   - On `session.lifecycle` with `shutdown.pending`, sends `goodbye` and closes
   - On `error`, logs it; if fatal (`AUTH_FAILED`, `UNSUPPORTED_VERSION`), closes
   - Ignores unknown message types (forward compatibility)
   - Reconnects on disconnect (with backoff)

3. **Place the file** in `providers/<name>/` at the project root, or wherever the user specifies.

4. **After generating**, tell the user how to run it:
   ```
   # Grab the token from the Copilot session environment:
   echo $TAP_PROVIDER_TOKEN   # macOS/Linux
   echo %TAP_PROVIDER_TOKEN%  # Windows

   # Run the provider:
   TAP_PROVIDER_TOKEN=<token> node providers/<name>/index.mjs
   ```

5. **Explain** that once connected, the tools appear in Copilot automatically — no restart needed.

## Templates

### Node.js skeleton

```js
import WebSocket from "ws";

const TOKEN = process.env.TAP_PROVIDER_TOKEN;
if (!TOKEN) {
  console.error("TAP_PROVIDER_TOKEN not set");
  process.exit(1);
}

const PROVIDER_NAME = "{{name}}";
const TOOLS = [
  {{#each tools}}
  {
    name: "{{this.name}}",
    description: "{{this.description}}",
    parameters: {
      type: "object",
      properties: { {{this.properties}} },
      required: [{{this.required}}]
    }
  },
  {{/each}}
];

function handleToolCall(toolName, args) {
  switch (toolName) {
    {{#each tools}}
    case "{{this.name}}":
      // TODO: implement {{this.name}}
      return `{{this.name}} called with ${JSON.stringify(args)}`;
    {{/each}}
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

function connect() {
  const ws = new WebSocket("ws://localhost:9400");

  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "auth", token: TOKEN }));
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);

    switch (msg.type) {
      case "sessions":
        if (!msg.active.length) { ws.close(); return; }
        ws.send(JSON.stringify({
          type: "hello",
          name: PROVIDER_NAME,
          protocolVersion: 2,
          session: msg.active[0].id,
          tools: TOOLS
        }));
        break;

      case "hello.ack":
        console.log(`✅ ${PROVIDER_NAME} registered as ${msg.providerId}`);
        break;

      case "tool.call": {
        let result;
        try {
          const data = handleToolCall(msg.tool, msg.args);
          result = { type: "tool.result", id: msg.id, data };
        } catch (err) {
          result = { type: "tool.result", id: msg.id, error: err.message, errorCode: "INTERNAL" };
        }
        ws.send(JSON.stringify(result));
        break;
      }

      case "tool.cancel":
        ws.send(JSON.stringify({
          type: "tool.result", id: msg.id,
          error: "Cancelled", errorCode: "CANCELLED"
        }));
        break;

      case "session.lifecycle":
        if (msg.state === "shutdown.pending") {
          ws.send(JSON.stringify({ type: "goodbye", reason: "session ending" }));
          ws.close();
        }
        break;

      case "error":
        console.error(`❌ [${msg.code}]: ${msg.message}`);
        if (msg.code === "AUTH_FAILED" || msg.code === "UNSUPPORTED_VERSION") ws.close();
        break;

      default:
        break; // forward compat: ignore unknown types
    }
  });

  ws.on("close", () => {
    console.log("Disconnected. Reconnecting in 5s...");
    setTimeout(connect, 5000);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
}

connect();
```

### Python skeleton

```python
import asyncio, json, os, websockets

TOKEN = os.environ.get("TAP_PROVIDER_TOKEN")
if not TOKEN:
    raise SystemExit("TAP_PROVIDER_TOKEN not set")

PROVIDER_NAME = "{{name}}"
TOOLS = [
    # {{#each tools}}
    {
        "name": "{{this.name}}",
        "description": "{{this.description}}",
        "parameters": {
            "type": "object",
            "properties": { {{this.properties}} },
            "required": [{{this.required}}],
        },
    },
    # {{/each}}
]

def handle_tool_call(tool_name, args):
    # TODO: implement tool handlers
    return f"{tool_name} called with {json.dumps(args)}"

async def connect():
    while True:
        try:
            async with websockets.connect("ws://localhost:9400") as ws:
                await ws.send(json.dumps({"type": "auth", "token": TOKEN}))

                async for raw in ws:
                    msg = json.loads(raw)

                    if msg["type"] == "sessions":
                        if not msg["active"]:
                            return
                        await ws.send(json.dumps({
                            "type": "hello",
                            "name": PROVIDER_NAME,
                            "protocolVersion": 2,
                            "session": msg["active"][0]["id"],
                            "tools": TOOLS,
                        }))

                    elif msg["type"] == "hello.ack":
                        print(f"✅ {PROVIDER_NAME} registered as {msg['providerId']}")

                    elif msg["type"] == "tool.call":
                        try:
                            data = handle_tool_call(msg["tool"], msg["args"])
                            result = {"type": "tool.result", "id": msg["id"], "data": data}
                        except Exception as e:
                            result = {"type": "tool.result", "id": msg["id"], "error": str(e), "errorCode": "INTERNAL"}
                        await ws.send(json.dumps(result))

                    elif msg["type"] == "tool.cancel":
                        await ws.send(json.dumps({
                            "type": "tool.result", "id": msg["id"],
                            "error": "Cancelled", "errorCode": "CANCELLED",
                        }))

                    elif msg["type"] == "session.lifecycle":
                        if msg["state"] == "shutdown.pending":
                            await ws.send(json.dumps({"type": "goodbye", "reason": "session ending"}))
                            return

                    elif msg["type"] == "error":
                        print(f"❌ [{msg['code']}]: {msg['message']}")
                        if msg["code"] in ("AUTH_FAILED", "UNSUPPORTED_VERSION"):
                            return

        except (ConnectionError, websockets.ConnectionClosed):
            print("Disconnected. Reconnecting in 5s...")
            await asyncio.sleep(5)

asyncio.run(connect())
```

## If the user asks about an existing provider

If the user mentions a running provider or asks about connected providers, use `tap_list_streams` and check if the gateway has active connections rather than scaffolding a new one.

## Language support

The protocol is plain JSON over WebSocket. Generate providers in whatever language the user prefers. The templates above cover Node.js and Python. For other languages (Go, Rust, C#, etc.), follow the same message flow and adapt to that language's WebSocket library.
