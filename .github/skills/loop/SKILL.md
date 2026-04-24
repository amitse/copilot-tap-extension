---
name: loop
description: "Create a prompt-based scheduled loop with copilot-channels-extension. Use for requests like '/loop 5m check the deploy' or any ask to run a prompt on a recurring interval."
argument-hint: "<interval> <prompt>"
user-invocable: true
---

Create a prompt-based looping monitor with `copilot_channels_start_monitor`.

## Expected input

Interpret the invocation as:

1. The first argument is the repeat interval, using values like `30s`, `5m`, `2h`, or `1d`.
2. The rest of the input is the prompt that should be re-run on that schedule.

Example:

```text
/loop 5m check the deploy
```

means:

- `every = "5m"`
- `prompt = "check the deploy"`

The loop is scheduled on that interval. For prompt-based loops, the first run happens after the first interval rather than immediately.

## Required behavior

When this skill is invoked:

1. Use `copilot_channels_start_monitor`.
2. Create a **prompt-based** loop, not a command monitor.
3. Default to:
   - `scope = "temporary"`
   - `subscribe = false`
4. Pick a concise monitor name and a matching channel name based on the task.
5. Do not invent extra classifier rules unless the user explicitly asks for them.
6. If the user explicitly asks to be notified, kept posted, or subscribed to updates, set:
   - `subscribe = true`
   - `delivery = "important"`
7. After creating the loop, confirm:
   - monitor name
   - channel name
   - interval
   - scheduled prompt
8. After confirming the loop, stop there. Do not immediately inspect channel history or react to background loop output unless the user explicitly asks for that follow-up.

## If the input is incomplete

If the interval or prompt body is missing, ask the user for the missing piece instead of guessing.

## If the user asks for persistence

If the user explicitly asks to keep the loop across sessions, set `scope = "persistent"` and say that it will be restored from config on the next session start.
