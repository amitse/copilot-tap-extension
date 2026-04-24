# copilot-tap-extension

### Your Copilot CLI, but it watches things for you.

> **Background commands. Filtered output. Smart interrupts. You keep coding.**

[![Built for Copilot CLI](https://img.shields.io/badge/Copilot_CLI-Extension-blue?style=flat-square&logo=github)](https://github.com/features/copilot)
[![Zero Dependencies](https://img.shields.io/badge/deps-0-brightgreen?style=flat-square)](./package.json)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square)]()

---

Copilot CLI already has background tasks — but you have to manually check them, and their output doesn't flow back into your conversation. This extension adds **automatic filtering and injection**. Background commands and prompts run, a filter decides what matters, and important events get pushed into your session.

One `.github/extensions/` file. Zero dependencies.

## Who is this for?

- **You're debugging a deploy** and want to keep coding while logs stream in the background
- **You maintain a repo** and want PR comments, CI failures, and issues surfaced automatically
- **You run long builds** and don't want to babysit them
- **You poll APIs or dashboards** and want Copilot to tell you when something changes
- **You repeat the same prompt** every few minutes and want to automate it

If you've ever wished Copilot could _watch something for you_, this is that.

## Get started in 60 seconds

```bash
git clone https://github.com/amitse/copilot-tap-extension
cd copilot-tap-extension
cp tap.config.example.json tap.config.json
copilot
```

Then say any of these:

> _"Watch my build logs and tell me if anything fails"_

> _"/loop 5m check for new PR review comments"_

> _"Tail the API logs, inject errors, drop health checks"_

The example config auto-starts a demo heartbeat emitter so you see it working immediately.

## How it works

An **emitter** is a background process attached to your session. There are two kinds:

- A **CommandEmitter** runs a shell command and captures its stdout line by line.
- A **PromptEmitter** runs an agent prompt, optionally on a recurring interval.

Each emitter has an **EventFilter** -- an ordered list of regex rules that decides what happens to each line of output. First match wins:

| Outcome | What happens |
| --- | --- |
| **drop** | Discarded. Never stored. |
| **keep** | Stored in the event stream for later review. |
| **surface** | Stored and shown in the session timeline. |
| **inject** | Stored, shown, and pushed into your conversation. |

CommandEmitter output goes through the filter. PromptEmitter output always injects directly.

Filters are hot-swappable while the emitter runs. You control who can change them: `ownership="modelOwned"` lets the agent tune rules on its own, while `ownership="userOwned"` locks them to your exact specification.

## Three things you can do

**1. Watch something in the background**

Tell Copilot to watch a log, build, or command. It creates a CommandEmitter that runs alongside your session, filters the output, and only interrupts you when something needs attention.

```
"Start a deploy watcher that tails our CI logs.
 Drop health checks, inject any failures or rollbacks."

-> You keep coding for 20 minutes.
-> Copilot interrupts: "Run 48291: deployment rollback triggered on prod"
```

**2. Loop a prompt on a schedule**

A PromptEmitter re-runs an agent prompt every N minutes -- PR comments, CI status, ticket queues -- without you asking again.

```
/loop 15m Check for new failing CI runs or PR review comments.
         Summarize only actionable items.

-> Every 15 minutes, the agent scans and reports back.
-> No news = no interruption.
```

**3. Tune the filter live**

Start with no rules and let all output through so you can see the stream shape. Then tighten progressively:

```
1. Drop the noise:    { "match": "health_check|heartbeat", "outcome": "drop" }
2. Inject the signal: { "match": "error|failure|rollback",  "outcome": "inject" }
3. Keep the rest:     { "match": ".*",                       "outcome": "keep" }
```

## How is this different from built-in background tasks?

Copilot CLI can run tasks in the background. This extension layers on top:

| Built-in background tasks | With tap-extension |
| --- | --- |
| You check task output manually | Output is filtered and injected automatically |
| No filtering — you see everything or nothing | EventFilter rules drop noise, keep context, inject signal |
| No scheduled re-checks | Timed emitters re-run on an interval |
| Task results sit until you look | Important lines interrupt your session in real-time |

## Repo layout

```text
.github/extensions/tap/extension.mjs   # the extension
.github/copilot-instructions.md        # agent guidance
tap.config.example.json                 # starter config
examples/heartbeat.mjs                  # demo emitter
docs/                                   # detailed docs
```

## Go deeper

| Doc | What's in it |
| --- | --- |
| **[Reference](./docs/reference.md)** | Full vocabulary, all tools, config schema, event pipeline details |
| **[Use cases and patterns](./docs/use-cases.md)** | Real-world workflows and recipes |
| **[Evals](./docs/evals.md)** | Testing infrastructure, smoke tests, interactive eval runner |
| **[Copilot instructions](./.github/copilot-instructions.md)** | How the agent is told to use this extension |
| **[Implementation plan](./PLAN.md)** | Design decisions and roadmap |

## Validate locally

```bash
npm run check              # syntax check
npm run evals:smoke        # smoke test
npm run evals:validate-modes  # interactive vs prompt-mode gap
```

---

**Ready to try it?** Clone, copy the config, launch `copilot`, and ask it to watch something. You'll see the difference in under a minute.

**Want to contribute?** The extension is a single `.mjs` file with zero dependencies. Read the [reference](./docs/reference.md), explore the [use cases](./docs/use-cases.md), and open a PR.
