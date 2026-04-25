---
name: loop
description: "Create a prompt-based scheduled loop with ※ tap. Use for requests like '/loop 5m check the deploy' or any ask to run a prompt on a recurring interval."
argument-hint: "<interval|idle> <prompt>"
user-invocable: true
---

Create a timed or idle PromptEmitter with `tap_start_emitter`.

## Expected input

Interpret the invocation as:

1. The first argument is the repeat interval, using values like `30s`, `5m`, `2h`, `1d`, or `idle`.
2. The rest of the input is the prompt that should be re-run on that schedule.

Example (timed):

```text
/loop 5m check the deploy
```

means:

- `runInterval = "5m"`
- `prompt = "check the deploy"`

Example (idle):

```text
/loop idle check the deploy
```

means:

- `every = "idle"` (re-runs whenever the session is idle)
- `prompt = "check the deploy"`

Timed emitters fire immediately, then repeat on the interval. Idle emitters fire immediately, then re-fire whenever the session becomes idle again (with a short delay between runs to avoid monopolizing the session).

## Max iterations

When the interval is `idle`, always ask the user for a max iteration count or default to a reasonable number (e.g. 10). Pass it as `maxRuns` to `tap_start_emitter`. This prevents runaway idle loops.

For timed intervals, `maxRuns` is optional. Only set it if the user explicitly requests a limit.

## Required behavior

When this skill is invoked:

1. Use `tap_start_emitter`.
2. Create a **PromptEmitter** with a timed schedule, not a CommandEmitter.
3. Default to:
   - `lifespan = "temporary"`
   - `subscribe = false`
4. Pick a concise emitter name (the EventStream is created automatically with the same name).
5. Do not invent extra EventFilter rules unless the user explicitly asks for them. PromptEmitter events always inject.
6. If the user explicitly asks to be notified, kept posted, or subscribed to updates, enable the SessionInjector:
   - `subscribe = true`
   - `delivery = "important"`
7. After creating the emitter, confirm:
   - emitter name
   - EventStream name
   - interval
   - scheduled prompt
8. After confirming the emitter, stop there. Do not immediately inspect EventStream history or react to background emitter output unless the user explicitly asks for that follow-up.

## Why subscribe defaults to false

PromptEmitter output is delivered through a single path:

1. **`session.send()`** -- the prompt is dispatched fire-and-forget; Copilot processes and responds to it directly inside the session.

The `subscribe` flag controls the **SessionInjector**. When enabled, it additionally pushes system-level messages (emitter started, stopped, errored) into the session.

For PromptEmitters, the main results already reach the session without the SessionInjector. Setting `subscribe = true` adds system noise on top of content that is already being delivered. Default to `false` to keep things clean.

For **CommandEmitters**, the SessionInjector matters more because it is the mechanism that delivers inject-outcome lines proactively. But even there, the notification dispatcher in the line router already handles inject outcomes directly.

In short: `subscribe` is about system messages and extra delivery, not about whether the user sees prompt results.

## If the input is incomplete

If the interval or prompt body is missing, ask the user for the missing piece instead of guessing.

## If the user asks for persistence

If the user explicitly asks to keep the emitter across sessions, set `lifespan = "persistent"` and say that it will be restored from config on the next session start.
