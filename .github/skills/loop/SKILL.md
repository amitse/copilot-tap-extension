---
name: loop
description: "Create a prompt-based scheduled loop with copilot-channels-extension. Use for requests like '/loop 5m check the deploy' or any ask to run a prompt on a recurring interval."
argument-hint: "<interval> <prompt>"
user-invocable: true
---

Create a timed PromptEmitter with `tap_start_emitter`.

## Expected input

Interpret the invocation as:

1. The first argument is the repeat interval, using values like `30s`, `5m`, `2h`, or `1d`.
2. The rest of the input is the prompt that should be re-run on that schedule.

Example:

```text
/loop 5m check the deploy
```

means:

- `runInterval = "5m"`
- `prompt = "check the deploy"`

The emitter runs on a timed schedule. The first run fires immediately, then repeats on the interval.

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

PromptEmitter output is already delivered through two paths:

1. **`session.sendAndWait()`** -- the prompt runs inside the session, so Copilot processes and responds to it directly.
2. **Notification dispatcher** -- each result line is also enqueued via `handlePromptResult` and injected as a background event stream update via `session.send()`.

The `subscribe` flag controls a third layer: the **SessionInjector**. When enabled, it additionally pushes system-level messages (emitter started, stopped, errored) into the session.

For PromptEmitters, the main results already reach the session without the SessionInjector. Setting `subscribe = true` adds system noise on top of content that is already being delivered. Default to `false` to keep things clean.

For **CommandEmitters**, the SessionInjector matters more because it is the mechanism that delivers inject-outcome lines proactively. But even there, the notification dispatcher in the line router already handles inject outcomes directly.

In short: `subscribe` is about system messages and extra delivery, not about whether the user sees prompt results.

## If the input is incomplete

If the interval or prompt body is missing, ask the user for the missing piece instead of guessing.

## If the user asks for persistence

If the user explicitly asks to keep the emitter across sessions, set `lifespan = "persistent"` and say that it will be restored from config on the next session start.
