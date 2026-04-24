# copilot-channels-extension

Public starter repo for a **Copilot CLI Extension** that approximates a practical Claude-style workflow:

- **EventEmitters** run background commands or agent prompts.
- **EventStreams** collect accepted output from emitters.
- **EventFilters** decide what gets dropped, kept, surfaced, or injected.
- **SessionInjectors** control whether EventStream updates are proactively injected into the Copilot session.

This is built on **Copilot CLI Extensions** in `.github/extensions/`, not MCP servers or custom agents.

## Mental model

| Concept | Meaning in this repo |
| --- | --- |
| EventEmitter | The ONLY primary resource users define — a background shell command or agent prompt |
| CommandEmitter | An EventEmitter backed by a shell command |
| PromptEmitter | An EventEmitter backed by a prompt sent into the agent |
| EventStream | A named stream that stores accepted emitter output and notes (auto-created, name = emitter name) |
| EventFilter | Ordered rule list on the emitter: `[{ match, outcome }]` — first match wins |
| SessionInjector | Controls whether EventStream updates are proactively delivered to the Copilot session (derived automatically) |
| Temporary | Session-only state that disappears on `/clear` (`lifespan="temporary"`) |
| Persistent | State written to `tap.config.json` and restored next session (`lifespan="persistent"`) |

## Canonical runtime vocabulary

This README follows the same vocabulary used in the code, tool descriptions, and config schema. If you are naming concepts in docs or discussions about the current implementation, prefer these terms:

| Code term | Meaning |
| --- | --- |
| `emitter` | A running background unit managed by the extension (CommandEmitter or PromptEmitter) |
| `stream` | The named EventStream where accepted emitter output and notes are stored |
| `sessionInjector` | Per-stream proactive delivery state |
| `eventFilter` | Ordered rule list on the emitter: `[{ match, outcome }]` |
| `emitterType` | Work source: `command` or `prompt` |
| `lifespan` | Lifecycle for config and runtime state: `temporary` or `persistent` |
| `ownership` | Ownership label: `userOwned` or `modelOwned` |
| `runSchedule` | Run schedule: `continuous`, `timed`, or `oneTime` |
| `runInterval` | Repeat interval for timed work |
| `autoStart` | Whether a persistent emitter starts automatically next session |

### Event outcomes

Each EventFilter rule maps a regex match to one of four outcomes:

| Outcome | Behavior |
| --- | --- |
| `drop` | Discard — does not enter the EventStream |
| `keep` | Store in the EventStream |
| `surface` | Keep + show in the Copilot session timeline via `session.log()` |
| `inject` | Keep + surface + inject into Copilot via `session.send()` |

PromptEmitter events always inject (no filter applied). CommandEmitter events go through the EventFilter.

## How people actually use it

### Temporary watch

Use an emitter for one active task:

- Start a temporary CommandEmitter for a log, build, or poller
- Enable the SessionInjector for this session
- Tighten the EventFilter so only relevant lines enter the stream
- Let the extension inject only important matches

### Permanent watch

Use a persistent emitter for recurring signals:

- Save the emitter to config with `lifespan="persistent"`
- Save the SessionInjector with `lifespan="persistent"`
- Save EventFilter rules with `lifespan="persistent"`
- The emitter is restored automatically next session if `autoStart` is true

### User-owned vs model-owned

Ownership lives on the EventEmitter only:

- `userOwned`: protected by default; the model must pass `transferOwnership=true` to override it
- `modelOwned`: safe for the model to adjust through tools during the session

That gives you a clean split between rules the user owns and rules the model can tune on the fly.

## Features

- Repo-scoped extension at `.github/extensions/tap/extension.mjs`
- Session-only and persistent EventEmitters
- One-shot and timed PromptEmitters
- Session-only and persistent SessionInjectors
- Per-emitter EventFilter rules as ordered `[{ match, outcome }]` lists (first match wins)
- Fixed-interval timed schedules with `runInterval: "5m"` style cadence
- Batched agent notifications using SessionInjectors
- Config-backed protection for `ownership: "userOwned"` resources
- Cross-platform emitter launching for Windows and macOS/Linux
- Demo heartbeat script so the repo works immediately

## Repo layout

```text
.github/extensions/tap/extension.mjs
.github/copilot-instructions.md
docs/use-cases.md
tap.config.example.json
examples/heartbeat.mjs
```

## Guides

- [Use cases and patterns](./docs/use-cases.md)
- [Copilot instruction file](./.github/copilot-instructions.md)
- [Implementation plan](./PLAN.md)
- [Real-Copilot eval infrastructure](./evals/infra.md)

## Emitter types

| Shape | How to define it | Best for |
| --- | --- | --- |
| Continuous CommandEmitter | `command` only | log tails, watch scripts, long-running jobs |
| Timed CommandEmitter | `command` + `runInterval` | polling APIs, recurring validators, periodic checks |
| OneTime PromptEmitter | `prompt` only | ask the agent to do a background check once |
| Timed PromptEmitter | `prompt` + `runInterval` | session-scoped `/loop`-style maintenance or re-check tasks |

## Quick start

1. Copy `tap.config.example.json` to `tap.config.json`.
2. Open Copilot CLI in this repo.
3. Run `/clear` or `extensions_reload`.
4. Ask Copilot to list EventStreams or EventEmitters.

The example config creates a persistent `ops` EventStream, enables its SessionInjector, and auto-starts a demo heartbeat emitter.

## Loop semantics

This extension now supports a lightweight, session-scoped timed schedule model inspired by Claude scheduled tasks:

- use `runInterval: "5m"` or similar to re-run work on an interval
- commands with `runInterval` re-run after each completion
- timed PromptEmitters wait for the first interval before their first run, then re-send the prompt after each completion
- prompts without `runInterval` run once
- timed schedules are tied to the session and do not try to catch up missed runs
- if a timed PromptEmitter fires while the current session is still busy, that run is deferred to the next interval instead of failing the emitter
- persistent config makes a timed emitter come back on the next session start, but this is still not a durable cloud scheduler

This repo also ships a **`loop` skill** under `.github/skills/loop` for skill-aware sessions. Use it when you want a fast scheduled prompt setup such as:

```text
/loop 5m check the deploy
```

The skill tells Copilot to create a timed PromptEmitter with `tap_start_emitter`, defaulting to a temporary emitter and only enabling the SessionInjector when you explicitly ask to be kept posted. Timed PromptEmitters start on their first interval rather than firing immediately.

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

## Tools exposed by the extension

| Tool | Purpose |
| --- | --- |
| `tap_list_streams` | List EventStreams plus SessionInjector state |
| `tap_post` | Append a note to an EventStream |
| `tap_stream_history` | Read recent EventStream history |
| `tap_enable_injector` | Enable a SessionInjector temporarily or persistently |
| `tap_disable_injector` | Disable proactive delivery from an EventStream |
| `tap_list_emitters` | Show running EventEmitters and persistent emitter definitions |
| `tap_start_emitter` | Start a CommandEmitter, PromptEmitter, or timed emitter, optionally enabling the SessionInjector |
| `tap_set_event_filter` | Update the EventFilter rules for an emitter |
| `tap_stop_emitter` | Stop a running emitter; optionally remove the persistent definition |

## Suggested usage patterns

### Watch a file temporarily

Start a session-only CommandEmitter with a strict EventFilter and an enabled SessionInjector:

- `lifespan="temporary"`
- `subscribe=true`
- EventFilter: `[{ "match": "error|warning|ready", "outcome": "inject" }, { "match": ".*", "outcome": "drop" }]`

### Keep a deploy watcher permanently

Persist the emitter and SessionInjector:

- `lifespan="persistent"`
- `autoStart=true`
- `ownership="userOwned"`

### Let the model tune noise

Use `ownership="modelOwned"` on a temporary emitter so the agent can adjust the EventFilter rules during the task.

## Event processing pipeline

1. An emitter produces a line.
2. The EventFilter evaluates each rule in order (first match wins):
   - `drop` — line is discarded
   - `keep` — line is stored in the EventStream
   - `surface` — stored + shown in session timeline via `session.log()`
   - `inject` — stored + surfaced + injected into Copilot via `session.send()`
3. If no rule matches, the bootstrap policy applies: **keep** (store in EventStream, no injection).

PromptEmitter events always inject — they bypass the EventFilter entirely.

The EventFilter is hot-swappable while the emitter runs. Start with a keep-all bootstrap policy, observe the stream, then add rules progressively.

## Limits compared with Claude Code

- This is an extension-level approximation, not a native runtime primitive.
- State held in memory is reset on `/clear`.
- Notifications are batched to reduce session spam.
- Emitters run with the extension's trust level, so only run commands you trust.

## Validate locally

```bash
npm run check
npm run evals:smoke
npm run evals:validate-modes
```

For automated evals, `evals/run.mjs` starts one ACP server, creates fresh SDK sessions, and mounts the shared runtime from `src/tap-runtime.mjs` directly into those sessions. That means `smoke` and `run` exercise the same EventStream/EventEmitter logic as the extension without depending on `.github/extensions` being discovered in a headless session. The runner writes prompt, response, error, and full event-transcript artifacts under `evals/results/...`.

**Caveat:** the reliable supported paths are **interactive foreground Copilot sessions** and **ACP/SDK sessions that mount the shared runtime directly**. Do **not** treat headless prompt-mode or other non-interactive repo-extension loading as reliable; use `validate-modes` when you need to prove that distinction.

The real repo-scoped extension loader is still validated separately. Run `npm run evals:validate-modes` to probe `copilot -p` with the actual `.github/extensions` entrypoint, then compare it with the same prompt in an interactive `copilot` session. That command is the explicit proof for the current prompt-mode versus interactive-mode gap.

For real extension-loader evals, use the interactive executor lane:

```bash
node evals/run.mjs prepare-interactive --case E001
# run the printed prompt inside an interactive `copilot` session
# then run the printed /share command
node evals/run.mjs judge-interactive --run-dir "<printed-run-dir>"
```

That flow keeps the executor in a foreground Copilot session where the actual extension can attach, uses `/share <path>` to persist the interactive transcript for the case, and then runs a tool-free ACP judge against the shared transcript plus the config snapshots. If you reuse one interactive session for multiple cases, run `/clear` before each next case.
