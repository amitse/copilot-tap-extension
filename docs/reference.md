# Reference

Technical reference for copilot-tap-extension. For a quick overview, see the [README](../README.md).

## Canonical vocabulary

These terms are used consistently across the code, tool descriptions, and config schema.

| Term | Meaning |
| --- | --- |
| `emitter` | A running background unit (CommandEmitter or PromptEmitter) |
| `stream` | Named EventStream storing accepted emitter output and notes |
| `sessionInjector` | Per-stream proactive delivery state |
| `eventFilter` | Ordered rule list on the emitter: `[{ match, outcome }]` |
| `emitterType` | Work source: `command` or `prompt` |
| `lifespan` | `temporary` (session-only) or `persistent` (written to config) |
| `ownership` | `userOwned` (protected) or `modelOwned` (agent can tune) |
| `runSchedule` | `continuous`, `timed`, or `oneTime` |
| `runInterval` | Repeat interval for timed work (e.g. `5m`, `2h`) |
| `autoStart` | Whether a persistent emitter starts automatically next session |

## Emitter types

| Type | Definition | Best for |
| --- | --- | --- |
| **Continuous Command** | `command` only | Log tails, watch scripts, long-running jobs |
| **Timed Command** | `command` + `runInterval` | API polling, recurring validators |
| **One-shot Prompt** | `prompt` only | Background agent check (runs once) |
| **Timed Prompt** | `prompt` + `runInterval` | `/loop`-style maintenance tasks |

## Event outcomes

Each EventFilter rule maps a regex to one of four outcomes (first match wins):

| Outcome | Behavior |
| --- | --- |
| `drop` | Discard — does not enter the EventStream |
| `keep` | Store in the EventStream |
| `surface` | Keep + show in session timeline via `session.log()` |
| `inject` | Keep + surface + inject into Copilot via `session.send()` |

PromptEmitter events always inject (bypass the EventFilter).

## Event processing pipeline

```
Emitter output
    |
    v
EventFilter (first match wins)
    |-- drop    → discarded
    |-- keep    → stored in EventStream
    |-- surface → stored + shown in timeline
    +-- inject  → stored + shown + injected into session
    |
    +-- no match → default: keep

PromptEmitter events always inject (bypass EventFilter)
```

Start with no filter rules (keep-all bootstrap), observe the stream with `tap_stream_history`, then progressively add rules to drop noise and inject signal.

## Tools

| Tool | What it does |
| --- | --- |
| `tap_start_emitter` | Start a background emitter (command, prompt, or timed) |
| `tap_stop_emitter` | Stop an emitter |
| `tap_list_emitters` | Show all running + persistent emitters |
| `tap_set_event_filter` | Update filter rules on a running emitter |
| `tap_stream_history` | Read recent EventStream entries |
| `tap_post` | Append a note to any EventStream |
| `tap_list_streams` | List all EventStreams + injector state |
| `tap_enable_injector` | Enable proactive session delivery |
| `tap_disable_injector` | Disable proactive delivery |

## Loop semantics

The extension supports session-scoped timed schedules:

- `runInterval: "5m"` re-runs work on a fixed interval
- Commands with `runInterval` re-run after each completion
- Timed PromptEmitters fire immediately, then repeat on the interval
- Prompts without `runInterval` run once
- Timed schedules do not catch up missed runs
- If a timed PromptEmitter fires while the session is busy, that run defers to the next interval
- Persistent config restores the emitter next session, but this is not a durable cloud scheduler

The repo also ships a **`loop` skill** (`src/skills/loop`) for quick setup:

```text
/loop 5m check the deploy
```

## Ownership model

Ownership lives on the EventEmitter only. EventStream and SessionInjector are derived.

- **`userOwned`** — protected; the model must pass `transferOwnership=true` to override
- **`modelOwned`** — safe for the model to adjust during the session

## Usage patterns

### Watch something temporarily

```
lifespan="temporary"
subscribe=true
EventFilter: [{ "match": "error|warning|ready", "outcome": "inject" }, { "match": ".*", "outcome": "drop" }]
```

### Persistent deploy watcher

```
lifespan="persistent"
autoStart=true
ownership="userOwned"
```

### Let the model tune noise

Use `ownership="modelOwned"` on a temporary emitter so the agent can adjust the EventFilter during the task.

## Example config

```json
{
  "streams": [
    {
      "name": "ops",
      "description": "Operational events from background emitters",
      "sessionInjector": {
        "enabled": true,
        "delivery": "important",
        "ownership": "userOwned"
      }
    },
    {
      "name": "repo-maintenance",
      "description": "Prompt-based maintenance loop",
      "sessionInjector": {
        "enabled": true,
        "delivery": "important",
        "ownership": "userOwned"
      }
    }
  ],
  "emitters": [
    {
      "name": "heartbeat",
      "description": "Demo background status stream",
      "command": "node ./examples/heartbeat.mjs",
      "stream": "ops",
      "autoStart": true,
      "includeStderr": true,
      "ownership": "userOwned",
      "eventFilter": [
        { "match": "booting", "outcome": "drop" },
        { "match": "ready|healthy", "outcome": "surface" },
        { "match": "warning|error", "outcome": "inject" },
        { "match": ".*", "outcome": "keep" }
      ]
    },
    {
      "name": "repo-maintenance",
      "description": "Prompt-based loop for repo health checks",
      "prompt": "Check whether there are new failing runs, PR review comments, or issue escalations worth addressing. Summarize only actionable changes.",
      "runInterval": "15m",
      "stream": "repo-maintenance",
      "autoStart": false,
      "ownership": "userOwned"
    }
  ]
}
```

## Limits

- Extension-level approximation, not a native runtime primitive.
- In-memory state resets on `/clear`.
- Notifications are batched to reduce spam.
- Emitters run with the extension's trust level — only run commands you trust.
