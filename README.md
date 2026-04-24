# copilot-tap-extension

Filtered background streams for Copilot CLI.

---

Copilot CLI can already run tasks in the background, but you have to check their output manually, and nothing flows back into your conversation. This extension adds **filtering and auto-injection**: background commands and agent prompts run continuously, an EventFilter decides what matters per line, and important events get pushed into your session automatically.

Single-file extension. Zero dependencies.

## Who is this for?

- You tail deploy logs and want failures injected into your session while you keep coding.
- You maintain a repo and want PR reviews, CI failures, and new issues surfaced without checking manually.
- You run long builds and want to know when they finish or break -- without watching.
- You poll an API or dashboard and want the agent to tell you when something changes.
- You re-ask the same prompt every few minutes and want it on a timer instead.

## Get started

```bash
git clone https://github.com/amitse/copilot-tap-extension
cd copilot-tap-extension
cp tap.config.example.json tap.config.json   # Windows: copy tap.config.example.json tap.config.json
copilot
```

Once inside the session, try a natural-language request:

> _"Watch my build logs and tell me if anything fails"_

> _"/loop 5m check for new PR review comments"_

> _"Tail the API logs, inject errors, drop health checks"_

The example config includes a demo heartbeat emitter that starts automatically, so you can see events flowing before you set up your own.

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

## What this adds to built-in background tasks

| Without the extension | With the extension |
| --- | --- |
| You check task output manually | Output is filtered and injected into your conversation |
| All output or nothing -- no filtering | EventFilter rules drop noise, keep context, inject signal |
| No scheduled re-checks | PromptEmitters re-run on an interval |
| Results sit until you look | Important lines interrupt your session as they arrive |

## Repo layout

```text
.github/extensions/tap/extension.mjs   # the extension
.github/copilot-instructions.md        # agent guidance
tap.config.example.json                 # starter config
examples/heartbeat.mjs                  # demo emitter
docs/                                   # detailed docs
```

## Further reading

| Document | Contents |
| --- | --- |
| [Reference](./docs/reference.md) | All tools, config schema, event pipeline, and vocabulary |
| [Use cases and patterns](./docs/use-cases.md) | Workflow recipes: deploy watchers, PR monitors, log tailers |
| [Evals](./docs/evals.md) | Smoke tests and the interactive eval runner |
| [Copilot instructions](./.github/copilot-instructions.md) | Guidance the agent follows when using this extension |
| [Implementation plan](./PLAN.md) | Design decisions and current roadmap |

## Contributing

The extension is a single `.mjs` file with zero dependencies. Before opening a PR, run the local checks:

```bash
npm run check              # syntax check
npm run evals:smoke        # smoke test
npm run evals:validate-modes  # interactive vs prompt-mode gap
```

See the [reference](./docs/reference.md) for the full API and config schema, and the [use cases](./docs/use-cases.md) for workflow patterns.
