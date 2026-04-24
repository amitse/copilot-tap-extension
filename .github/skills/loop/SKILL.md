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

The emitter runs on a timed schedule. For timed PromptEmitters, the first run happens after the first interval rather than immediately.

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

## If the input is incomplete

If the interval or prompt body is missing, ask the user for the missing piece instead of guessing.

## If the user asks for persistence

If the user explicitly asks to keep the emitter across sessions, set `lifespan = "persistent"` and say that it will be restored from config on the next session start.
