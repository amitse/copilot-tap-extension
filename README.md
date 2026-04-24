# copilot-channels-extension

Public starter repo for a **Copilot CLI Extension** that approximates a practical Claude-style workflow:

1. **Monitors** watch background commands.
2. **Classifiers** decide what enters a channel and what gets ignored.
3. **Subscriptions** decide which channels should proactively surface updates back to the agent.

This is built on **Copilot CLI Extensions** in `.github/extensions/`, not MCP servers or custom agents.

## Mental model

| Concept | Meaning in this repo |
| --- | --- |
| Monitor | A background shell command started by the extension |
| Channel | A named stream that stores accepted monitor lines and notes |
| Classifier | Per-monitor rules for `includePattern`, `excludePattern`, and `notifyPattern` |
| Subscription | Channel-level delivery mode for proactive updates: `important` or `all` |
| Temporary | Session-only state that disappears on `/clear` |
| Persistent | State written to `copilot-channels.config.json` and restored next session |

## How people actually use it

### Temporary watch

Use a monitor for one active task:

- Start a temporary monitor for a log, build, or poller
- Subscribe the channel for this session
- Tighten the classifier so only relevant lines enter the stream
- Let the extension surface only important matches

### Permanent watch

Use a persistent monitor for recurring signals:

- Save the monitor to config with `scope="persistent"`
- Save the channel subscription with `scope="persistent"`
- Save classifier rules with `scope="persistent"`
- The monitor is restored automatically next session if `autoStart` is true

### User-controlled vs model-controlled

Every subscription, monitor, and classifier has a `managedBy` field:

- `user`: protected by default; the model must pass `force=true` to override it
- `model`: safe for the model to adjust through tools during the session

That gives you a clean split between rules the user owns and rules the model can tune on the fly.

## Features

- Repo-scoped extension at `.github/extensions/copilot-channels-extension/extension.mjs`
- Session-only and persistent monitors
- Session-only and persistent channel subscriptions
- Per-monitor classifier rules:
  - `includePattern`
  - `excludePattern`
  - `notifyPattern`
- Batched agent notifications using subscribed channels
- Config-backed protection for `managedBy: "user"` resources
- Cross-platform monitor launching for Windows and macOS/Linux
- Demo heartbeat script so the repo works immediately

## Repo layout

```text
.github/extensions/copilot-channels-extension/extension.mjs
copilot-channels.config.example.json
examples/heartbeat.mjs
```

## Quick start

1. Copy `copilot-channels.config.example.json` to `copilot-channels.config.json`.
2. Open Copilot CLI in this repo.
3. Run `/clear` or `extensions_reload`.
4. Ask Copilot to list channels or monitors.

The example config creates a persistent `ops` channel, subscribes to it, and auto-starts a demo heartbeat monitor.

## Example config

```json
{
  "channels": [
    {
      "name": "ops",
      "description": "Operational events from background monitors",
      "subscription": {
        "enabled": true,
        "delivery": "important",
        "managedBy": "user"
      }
    }
  ],
  "monitors": [
    {
      "name": "heartbeat",
      "description": "Demo background status stream",
      "command": "node ./examples/heartbeat.mjs",
      "channel": "ops",
      "autoStart": true,
      "includeStderr": true,
      "managedBy": "user",
      "classifier": {
        "includePattern": "ready|healthy|warning|error",
        "excludePattern": "booting",
        "notifyPattern": "warning|error|ready",
        "managedBy": "user"
      }
    }
  ]
}
```

## Tools exposed by the extension

| Tool | Purpose |
| --- | --- |
| `copilot_channels_list_channels` | List channels plus subscription state |
| `copilot_channels_post` | Append a note to a channel |
| `copilot_channels_history` | Read recent channel history |
| `copilot_channels_subscribe` | Subscribe to a channel temporarily or persistently |
| `copilot_channels_unsubscribe` | Stop proactive delivery from a channel |
| `copilot_channels_list_monitors` | Show running monitors and persistent monitor definitions |
| `copilot_channels_start_monitor` | Start a temporary or persistent monitor, optionally subscribing the channel |
| `copilot_channels_set_classifier` | Update what a monitor admits into the stream and what notifies subscribers |
| `copilot_channels_stop_monitor` | Stop a running monitor; optionally remove the persistent definition |

## Suggested usage patterns

### Monitor a file temporarily

Start a session-only monitor with a strict classifier and a subscribed channel:

- `scope="temporary"`
- `subscribe=true`
- `delivery="important"`
- `includePattern="error|warning|ready"`

### Keep a deploy watcher permanently

Persist the monitor and subscription:

- `scope="persistent"`
- `autoStart=true`
- `managedBy="user"`

### Let the model tune noise

Use `managedBy="model"` on a temporary monitor so the agent can adjust `includePattern`, `excludePattern`, or `notifyPattern` during the task.

## Delivery behavior

1. A monitor emits a line.
2. The classifier decides whether that line enters the channel.
3. If the channel is subscribed:
   - `delivery="all"` pushes every accepted line
   - `delivery="important"` pushes only lines that match `notifyPattern`, or the built-in default signal regex when `notifyPattern` is omitted

This keeps the channel history richer than the live delivery stream.

Delivery is triggered directly from monitor output handling with `session.send()`. It does not wait for `user.message` or `assistant.message` transcript events.

## Limits compared with Claude Code

- This is an extension-level approximation, not a native runtime primitive.
- State held in memory is reset on `/clear`.
- Notifications are batched to reduce session spam.
- Monitors run with the extension's trust level, so only run commands you trust.

## Validate locally

```bash
npm run check
```

## Publish as a public GitHub repo

If `gh` is authenticated:

```bash
git init
git add .
git commit -m "Initial scaffold

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
gh repo create copilot-channels-extension --public --source=. --remote=origin --push
```
