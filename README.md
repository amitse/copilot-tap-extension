<p align="center">
  <img src="./tap.svg" width="80" height="80" alt="※ tap">
</p>

<h1 align="center">※ tap</h1>

<p align="center">
  <em>Background event filtering and injection for Copilot CLI.</em><br>
  <sub>Look here, this matters.</sub>
</p>

---

Copilot CLI already runs background tasks, but their output sits idle until you check it. This extension adds **filtering and auto-injection** on top of that capability.

Background commands and agent prompts produce output line by line. An EventFilter decides what to drop, what to store, and what to push into your session. Important events arrive without you asking.

| Without this extension | With it |
| --- | --- |
| You check background output manually | Important lines are pushed into your conversation |
| No way to filter noisy output | Rules drop noise, keep context, inject signal |
| No scheduled prompt re-runs | Prompts repeat on a timer or fire when idle |
| Output stays in the background task | Matched events arrive in your session as they happen |

## Who is this for?

- You tail logs and want failures injected into your session while you keep coding.
- You maintain a repo and want PR reviews, CI failures, or new issues surfaced automatically.
- You run long builds and want to know when they finish or break -- without watching.
- You poll an API or dashboard and want the agent to react when something changes.
- You re-ask the same prompt periodically and want it on a timer or running whenever idle.

## Get started

Prerequisites: [Node.js](https://nodejs.org/) ≥ 20 and [Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli).

> **Important:** This extension requires Copilot CLI to be running with **experiments enabled**. Extensions and background-task features are gated behind this flag.

**How to enable experiments:**

```bash
# Start Copilot CLI with experiments on
copilot --experimental
```

Or, if Copilot CLI is already running, type the following inside the session:

```
/experimental
```

Once enabled, the experimental state persists across sessions -- you only need to do this once. You can also disable it at any time with `copilot --no-experimental`.

### Install via npx (recommended)

```bash
# Install globally (available in all projects)
npx copilot-tap-extension

# Install locally (project-scoped, committed with your repo)
npx copilot-tap-extension --local
```

This installs the bundled extension, the `/loop` skill, and the agent instructions to the appropriate Copilot directory. Run `npx copilot-tap-extension --help` for all options.

To update to the latest version, re-run the same command with `--force`:

```bash
npx copilot-tap-extension --force
```

### Install from source

```bash
git clone https://github.com/amitse/copilot-tap-extension
cd copilot-tap-extension
npm install
cp tap.config.example.json tap.config.json
copilot
```

On Windows, replace `cp` with `copy`.

The config file tells the extension which emitters to auto-start. The example defines a heartbeat emitter:

```json
{
  "emitters": [
    {
      "name": "heartbeat",
      "command": "node ./examples/heartbeat.mjs",
      "autoStart": true,
      "eventFilter": [
        { "match": "booting", "outcome": "drop" },
        { "match": "warning|error", "outcome": "inject" },
        { "match": ".*", "outcome": "keep" }
      ]
    }
  ]
}
```

This runs the heartbeat script on session start, drops boot messages, injects warnings and errors, and keeps everything else in the stream.

Once inside the session, describe what you want in natural language. You can also use `/loop` to set up scheduled prompts directly:

> _"Watch my build logs and tell me if anything fails"_

> _"/loop 5m check for new PR review comments"_

> _"Tail the API logs, inject errors, drop health checks"_

The agent translates these into emitter and filter configurations behind the scenes.

## How it works

An **EventEmitter** is a background worker attached to your session. There are two kinds:

- A **CommandEmitter** runs a shell command and captures stdout line by line.
- A **PromptEmitter** runs an agent prompt -- once, on a recurring interval, or whenever the session is idle.

Each emitter writes to an **EventStream**, an in-memory log of accepted output. The stream is created automatically and shares the emitter's name.

For CommandEmitters, an **EventFilter** decides what happens to each line. It is an ordered list of regex rules -- first match wins:

| Outcome | What happens |
| --- | --- |
| **drop** | Discarded. Never enters the stream. |
| **keep** | Stored in the EventStream for later review. |
| **surface** | Stored and shown in the session timeline. |
| **inject** | Stored, shown, and pushed into your conversation. |

Outcomes are inclusive: **inject** implies **surface**, and **surface** implies **keep**. Only **drop** is outside this chain.

PromptEmitter output bypasses the filter and always injects.

A **SessionInjector** controls whether stream updates are pushed into your session proactively. Enable it when you want important events to arrive as they happen.

Filters are hot-swappable while the emitter runs. `ownership="modelOwned"` lets the agent tune rules; `ownership="userOwned"` locks them to your specification.

Emitters are **temporary** by default and last only for the current session. Set `lifespan="persistent"` to save an emitter to config and restore it next session.

Run schedules control timing: **continuous** (command runs until stopped), **timed** (repeats on an interval), **oneTime** (runs once), or **idle** (prompt re-runs when the session has nothing else to do).

## What you can do

**Watch something in the background**

Tell Copilot to watch a log, build, or command. It creates a CommandEmitter, filters the output, and only interrupts you when something needs attention.

```
"Start a deploy watcher that tails our CI logs.
 Drop health checks, inject any failures or rollbacks."
```

You keep coding. Twenty minutes later, Copilot interrupts: "Run 48291: deployment rollback triggered on prod."

**Loop a prompt on a schedule**

A PromptEmitter re-runs an agent prompt at a fixed interval. Useful for PR comments, CI status, or ticket queues.

```
/loop 15m Check for new failing CI runs or PR review comments.
         Summarize only actionable items.
```

Every 15 minutes the agent scans and reports back. No news means no interruption.

**Run a prompt when idle**

Use `/loop idle` to re-run a prompt whenever the session has nothing else to do. Set `maxRuns` to cap iterations.

```
/loop idle Scan for new issues labeled urgent. Summarize what changed.
```

The prompt fires immediately, then re-fires after each idle period. It stops after reaching the iteration limit.

**Tune the filter live**

The recommended approach is a **keep-all bootstrap**: start with no EventFilter rules so all output flows into the stream. Read the stream history to learn what the output looks like, then add rules progressively:

```
1. Drop the noise:    { "match": "health_check|heartbeat", "outcome": "drop" }
2. Inject the signal: { "match": "error|failure|rollback",  "outcome": "inject" }
3. Keep the rest:     { "match": ".*",                       "outcome": "keep" }
```

Rules can be added or changed while the emitter is running. You never need to restart it to adjust filtering.

## Repo layout

```text
.github/
  extensions/tap/extension.mjs  # extension entry point (loads the runtime)
  skills/loop/                  # /loop skill for scheduled and idle prompts
  copilot-instructions.md       # agent guidance for using this extension
src/
  emitter/                      # supervisor, lifecycle, spawn, line router
  streams/                      # EventStream store and notification dispatcher
  tools/                        # tool definitions (emitters, streams, filters)
  config/                       # persistent config store (tap.config.json)
  format/                       # display formatters for emitters and streams
  session/                      # session port abstraction
  util/                         # normalization, text, time, path helpers
  hooks.mjs                     # session lifecycle hooks
  tap-runtime.mjs               # runtime factory (wires everything together)
tap.svg                         # ※ mark — the tap icon
docs/
  evolution-of-tap-icon.html    # design evolution: 20 agents, 20 metaphors, one mark
examples/heartbeat.mjs          # demo CommandEmitter
evals/                          # eval harness and test cases
tap.config.example.json         # starter config (copy to tap.config.json)
PLAN.md                         # ubiquitous language and design decisions
```

## Further reading

| Document | When to read it |
| --- | --- |
| [Reference](./docs/reference.md) | Look up tool parameters, config fields, or the event pipeline |
| [Use cases and patterns](./docs/use-cases.md) | Recipes for deploy watchers, PR monitors, log tailers, and more |
| [Evals](./docs/evals.md) | Run or extend the automated test suite |
| [Copilot instructions](./src/copilot-instructions.md) | Understand or customize how the agent uses this extension |
| [Implementation plan](./PLAN.md) | Ubiquitous language and naming conventions for contributors |
| [Evolution of the ※ icon](./docs/evolution-of-tap-icon.html) | 20 metaphors, 10 variants, one mark — the design story behind ※ tap |

## Contributing

Before opening a PR, run the local checks:

```bash
npm run check              # syntax check
npm run evals:smoke        # smoke test
npm run evals:validate-modes  # interactive vs prompt-mode gap
```

The runtime has no production dependencies. Dev dependencies (`@github/copilot-sdk`, `yaml`) are used for the eval harness and extension loading.

If you add a new tool or change the event pipeline, update the [reference](./docs/reference.md). If you add a new workflow pattern, add it to [use cases](./docs/use-cases.md).

## License

[MIT](./LICENSE)
