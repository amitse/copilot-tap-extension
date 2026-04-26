# Recipe: Browser Bridge — Copilot CLI ↔ Live Web Pages

Connect Copilot CLI to any browser tab via a local WebSocket relay and [Detour](https://chromewebstore.google.com/detail/detour/cinkplogkjggmgdkaflhlemcdhchninp) (a Chrome extension that injects scripts into pages).

## How it works

```
Copilot CLI (※ tap)  ◄─ws─►  Bridge Server  ◄─ws─►  Injected JS (via Detour)
                              ws://localhost:9400       running in page MAIN world
```

1. A standalone **bridge server** runs locally on a WebSocket port.
2. **Detour injects a client script** into target pages — no changes to Detour itself.
3. **tap tools** connect to the bridge, send requests, and return results to Copilot.

Detour already runs arbitrary JS in the MAIN world and bypasses CSP. The bridge client is just another script it injects.

## Architecture

### Bridge server (standalone)

A minimal Node.js WebSocket relay. Clients self-identify as `agent` (Copilot) or `browser` (injected page script). The bridge routes messages between them.

```
npx copilot-bridge
# or
node bridge/server.mjs
```

Zero knowledge of tap or Detour — it just relays JSON.

### Injected script (via Detour)

A self-contained JS file hosted locally or on a CDN. Added to Detour as a script injection rule on target pages. It:

- Connects to `ws://localhost:9400`
- Identifies as `browser`
- Handles action requests (screenshot, DOM query, JS exec)
- Pushes events (console, annotations) to the bridge

### tap integration

New tools in ※ tap that connect to the bridge on demand:

- `tap_browser_screenshot` — capture viewport
- `tap_browser_query` — querySelector, return HTML/text/attributes
- `tap_browser_react_context` — React component name, file, line, props
- `tap_browser_exec` — execute arbitrary JS, return result
- `tap_browser_navigate` — go to a URL

## Protocol

JSON over WebSocket. Request/response with correlation IDs.

### Handshake

```json
{ "type": "hello", "role": "agent", "name": "copilot-tap" }
{ "type": "hello", "role": "browser", "name": "detour-bridge-client" }
```

### Request → Response

```json
// agent sends
{ "type": "request", "id": "r1", "action": "screenshot", "params": {} }

// browser responds
{ "type": "response", "id": "r1", "data": { "image": "data:image/png;base64,..." } }
```

### Push (browser → agent, unsolicited)

```json
{ "type": "push", "action": "comment", "data": { "text": "Fix this button", "selector": "#submit-btn", "url": "https://..." } }
```

## Actions

| Action | Direction | What it does |
|---|---|---|
| `screenshot` | agent → browser | `html2canvas` or Canvas API capture of viewport |
| `dom.query` | agent → browser | `querySelector` → outerHTML, textContent, attributes |
| `dom.react` | agent → browser | React fiber walk → component name, file, line, props |
| `js.exec` | agent → browser | Run arbitrary JS in page context, return result |
| `page.info` | agent → browser | URL, title, meta, `document.readyState` |
| `comment` | browser → agent | User annotation from page → Copilot session |
| `console` | browser → agent | Intercepted `console.*` calls → tap emitter |
| `navigate` | agent → browser | `window.location.href = url` |

## Use cases

### Get a screenshot into Copilot

```
> take a screenshot of the current page
```

tap calls `tap_browser_screenshot` → bridge → injected script captures viewport → base64 flows back → Copilot sees the image.

### React component context (like react-grab)

```
> what React component renders the sidebar?
```

tap calls `tap_browser_query` with a selector or `tap_browser_react_context` → walks React fiber tree → returns component name, source file, line number, props → Copilot has full context without searching the codebase.

### Live console monitoring

A tap CommandEmitter connects to the bridge and streams `console` push events. EventFilter drops noise, injects errors:

```json
{ "match": "error|warn|uncaught", "outcome": "inject" }
{ "match": ".*", "outcome": "keep" }
```

### Page annotations → Copilot

User selects an element on the page, types a comment. The injected script pushes it to the bridge → tap injects it into the Copilot session. Like react-grab but the context goes straight into the conversation, not the clipboard.

### Copilot drives the browser

```
> click the submit button and tell me what happens
```

tap calls `tap_browser_exec` with `document.querySelector('#submit').click()` → injected script runs it → returns result or captures DOM changes.

## Phased delivery

| Phase | Scope |
|---|---|
| **1. Prove the round-trip** | Bridge server + injected client script + `screenshot` action + one tap tool |
| **2. DOM + React context** | `dom.query`, `dom.react`, `page.info` actions and tap tools |
| **3. Bidirectional** | `js.exec`, `comment` push, `console` push, `navigate` |
| **4. Polish** | Auto-reconnect, multi-tab targeting, annotation overlay UI, error handling |

## Open questions

- **Bridge as npm package?** `npx copilot-bridge` or should tap auto-start it?
- **Multi-tab** — target active tab by default, allow tab ID targeting?
- **Screenshot method** — `html2canvas` (full fidelity) vs Canvas API (faster)?
- **Security** — localhost-only binding, optional shared secret?
- **Image delivery** — base64 inline vs write to temp file and return path?
- **React context** — bundle react-grab extraction logic or write lightweight version?
