# Copilot instructions for copilot-channels-extension

Use this extension as a background-awareness layer for long-running or polled signals.

## Mental model

- A **monitor** is a background command or poller script.
- A **prompt work item** is a prompt sent back into the agent, once or on a loop.
- A **channel** is the stream where accepted monitor output lands.
- A **classifier** decides:
  - what enters the stream (`includePattern`)
  - what gets dropped (`excludePattern`)
  - what proactively interrupts the session (`notifyPattern`)
- A **subscription** decides whether the agent should proactively surface updates from a channel.

The extension inserts subscribed monitor updates directly from monitor output with `session.send()`. It does not depend on transcript events like `user.message` or `assistant.message`.

## When to use it

Reach for channels and monitors when the user wants to:

- watch something over time
- babysit a PR, build, issue queue, deploy, or inbox
- keep working while a background process or poller runs
- get interrupted only for important changes
- store short rolling history for a live stream

Reach for **prompt work items** when the user wants the agent itself to periodically re-check something, summarize changes, or perform maintenance without waiting for another manual prompt.

## Default operating pattern

1. Start with a **temporary** monitor unless the workflow is obviously recurring.
2. Choose a channel name that represents the concern, not the command.
3. Subscribe with `delivery="important"` unless the stream is naturally sparse.
4. Start the classifier broad enough to learn the stream shape.
5. Let a few events arrive.
6. Inspect channel history.
7. Tighten the classifier:
   - add `excludePattern` first
   - narrow `includePattern` only after you understand the stream
   - sharpen `notifyPattern` so the user is interrupted only for meaningful events
8. If the work should repeat inside the session, add `every`.
9. If the monitor proves useful across sessions, persist it and switch ownership to `managedBy="user"` unless the user explicitly wants ongoing model control.

## Recommended tool sequence

Use these tools in roughly this order:

1. `copilot_channels_start_monitor`
2. `copilot_channels_subscribe` if the monitor should proactively surface updates
3. `copilot_channels_history` after a few events
4. `copilot_channels_set_classifier` to tighten the stream
5. `copilot_channels_post` to leave structured notes or summaries in the channel
6. `copilot_channels_stop_monitor` when the task ends or if the stream is no longer useful

## Good defaults

### For unknown or noisy streams

- `scope="temporary"`
- `managedBy="model"`
- `subscribe=true`
- `delivery="important"`
- broad or empty `includePattern`
- empty `excludePattern`
- obvious `notifyPattern` such as `error|fail|warning|ready|success|changes requested`

### For prompt-driven maintenance

- use `prompt` instead of `command`
- add `every` for a fixed session-scoped loop
- use one-shot prompt work when the user wants a background check only once
- keep the first prompt concise and action-oriented

### For recurring team workflows

- `scope="persistent"`
- `managedBy="user"`
- `autoStart=true` only if the user wants it every session
- stable channel naming
- user-approved thresholds and classifier rules

## Ownership rules

Treat these as **user-controlled** by default:

- persistent monitors
- security, compliance, finance, or release-gating workflows
- email or external notification rules
- org-specific routing rules or thresholds

Treat these as safe for **model control**:

- temporary monitors created for one task
- temporary subscriptions
- live classifier tuning to reduce noise
- exploratory monitoring where the stream shape is not yet known

Never override a user-controlled persistent monitor, classifier, or subscription unless the user explicitly asks. If the extension requires `force=true`, use it only for an explicit user request.

## How to tighten classifiers

Prefer this progression:

1. **Observe first.** Let the raw stream teach you the vocabulary.
2. **Exclude obvious noise.** Polling chatter, heartbeats, bot messages, deprecations, duplicate summaries.
3. **Narrow inclusion only after step 2.** Do not accidentally cut off useful signal before you understand it.
4. **Use `notifyPattern` as the interruption gate.** A line can be worth keeping in history without being worth surfacing live.

Good examples:

- log tail: exclude timestamps, retries, and health-check chatter; notify on `error|fatal|panic`
- PR watcher: exclude bot comments and repeated status updates; notify on `changes requested|failed|approved`
- ticket queue: include all open/escalated items at first; notify only on `sla-breach|high-priority|escalated`

## Temporary vs persistent

Use **temporary** when:

- the user is debugging, triaging, or investigating
- the correct classifier is not obvious yet
- the stream exists only for one task, incident, PR, or release window
- the loop should end with the session

Use **persistent** when:

- the same workflow should come back next session
- the command and thresholds are stable
- the user wants a reusable operating pattern

## Everything is code

If no ready-made CLI exists, create or use a small script that prints one meaningful line per event. Good monitors are often:

- API pollers
- webhook log tails
- release-note fetchers
- GitHub CLI pollers
- local watch scripts
- validation scripts for builds, tests, deploys, ETL, or compliance

Prefer normalized output over raw dumps. Classifiers work much better when each line already carries a stable tag or status word.

If the work is mostly reasoning rather than data collection, prefer a prompt work item:

- prompt once for a background check
- prompt + `every` for a fixed maintenance loop

This is the closest analogue to Claude's session-scoped `/loop` behavior in this extension.

## Borrow from the official SDK examples

When working on the extension itself, not just using its monitor tools, prefer these SDK patterns:

- use `session.log()` for user-visible diagnostics; never rely on `console.log()`
- use hooks such as `onUserPromptSubmitted`, `onPreToolUse`, `onPostToolUse`, and `onErrorOccurred` to shape behavior
- use `session.on(...)` listeners for tool lifecycle, assistant messages, session idle, and errors when you need event-driven behavior
- use `session.send()` for asynchronous follow-up prompts and `session.sendAndWait()` only when the extension must wait for an answer
- use `onPermissionRequest` and `onUserInputRequest` for guarded flows instead of custom ad hoc prompting
- use `fs.watch` or `watchFile` when the extension should react to manual file edits or workspace artifacts such as `plan.md`

Good non-channel examples to adapt into this repo:

- after an edit tool runs, trigger a lint or test monitor automatically
- watch a config file and refresh the corresponding monitor when the user edits it
- add a helper tool that fetches one-shot data from an API while monitors continue to watch background streams
- log classifier updates and monitor lifecycle events to the timeline for observability

## What not to do

- Do not create one giant mixed channel for unrelated workflows.
- Do not make a noisy stream persistent before you understand it.
- Do not leave everything at `delivery="all"` for chatty sources.
- Do not mutate user-owned persistent rules without explicit permission.
- Do not use channels as a transcript mirror; use them for monitor-driven context.

## A strong operating recipe

When the user says "watch this" and the stream shape is unclear:

1. Create a temporary monitor.
2. Subscribe with `delivery="important"`.
3. Start broad.
4. Wait for a few real events.
5. Read history.
6. Tighten the classifier.
7. If the workflow proves valuable, ask or decide to create the persistent, user-controlled version.
