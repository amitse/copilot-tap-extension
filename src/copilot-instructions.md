# Copilot instructions for ※ tap

Use this extension as a background-awareness layer for long-running or polled signals.

## Mental model

- An **EventEmitter** is the only primary resource users define — a background shell command (CommandEmitter) or agent prompt (PromptEmitter).
- An **EventStream** is automatically created for each emitter (same name) and stores accepted output.
- An **EventFilter** is an ordered rule list owned by the emitter: `[{ match, outcome }]` — first match wins.
  - Outcomes: `drop` (discard), `keep` (store in EventStream), `surface` (keep + show in timeline), `inject` (keep + surface + inject into Copilot)
- A **SessionInjector** is derived automatically per EventStream and controls whether updates are proactively injected into the session.

PromptEmitter events always inject (no filter applied). CommandEmitter events go through the EventFilter. The EventFilter is hot-swappable while the emitter runs.

The extension injects EventStream updates directly from emitter output with `session.send()`. It does not depend on transcript events like `user.message` or `assistant.message`.

## When to use it

Reach for EventEmitters when the user wants to:

- watch something over time
- babysit a PR, build, issue queue, deploy, or inbox
- keep working while a background process or poller runs
- get interrupted only for important changes
- store short rolling history for a live stream

Reach for **PromptEmitters** when the user wants the agent itself to periodically re-check something, summarize changes, or perform maintenance without waiting for another manual prompt.

## Default operating pattern

1. Start with a **temporary** emitter (`lifespan="temporary"`) unless the workflow is obviously recurring across multiple agent sessions.
2. The EventStream is created automatically with the same name as the emitter.
3. Enable the SessionInjector if the emitter should proactively surface updates.
4. Start with a keep-all bootstrap policy (no EventFilter rules) to learn the stream shape.
5. Let a few events arrive.
6. Inspect EventStream history.
7. Tighten the EventFilter:
   - add `{ "match": "<noise>", "outcome": "drop" }` rules first
   - add `{ "match": "<signal>", "outcome": "inject" }` rules for important events
   - use `{ "match": ".*", "outcome": "keep" }` as a catch-all to store everything else
8. If the work should repeat inside the session, add `runInterval`.
9. If the emitter proves useful across sessions, persist it and switch ownership to `ownership="userOwned"` unless the user explicitly wants ongoing model control.

## Recommended tool sequence

Use these tools in roughly this order:

1. `tap_start_emitter` — create the EventEmitter
2. `tap_enable_injector` — enable the SessionInjector if the emitter should proactively surface updates
3. `tap_stream_history` — read EventStream history after a few events
4. `tap_set_event_filter` — update the EventFilter rules
5. `tap_post` — leave structured notes or summaries in the EventStream
6. `tap_stop_emitter` — stop the emitter when the task ends or if the stream is no longer useful

## Good defaults

### For unknown or noisy streams

- `lifespan="temporary"`
- `ownership="modelOwned"`
- `subscribe=true`
- No EventFilter rules initially (keep-all bootstrap policy)
- Let events accumulate, then add rules progressively

### For prompt-driven maintenance

- use `prompt` instead of `command` (creates a PromptEmitter)
- add `runInterval` for a fixed session-scoped timed schedule
- use oneTime PromptEmitter when the user wants a background check only once
- keep the first prompt concise and action-oriented

### For recurring team workflows

- `lifespan="persistent"`
- `ownership="userOwned"`
- `autoStart=true` only if the user wants it every session
- stable EventStream naming
- user-approved EventFilter rules

## Ownership rules

Ownership lives on the EventEmitter only. EventStream and SessionInjector are derived.

Treat these as **userOwned** by default:

- persistent emitters
- security, compliance, finance, or release-gating workflows
- email or external notification rules
- org-specific routing rules or thresholds

Treat these as safe for **modelOwned**:

- temporary emitters created for one task
- temporary SessionInjectors
- live EventFilter tuning to reduce noise
- exploratory emitters where the stream shape is not yet known

Never override a userOwned persistent emitter or its EventFilter unless the user explicitly asks. If the extension requires `transferOwnership=true`, use it only for an explicit user request.

## How to tighten EventFilters

The EventFilter is an ordered rule list — first match wins. Prefer this progression:

1. **Observe first.** Let the raw stream teach you the vocabulary (keep-all bootstrap).
2. **Drop obvious noise.** Add `{ "match": "<noise>", "outcome": "drop" }` rules for polling chatter, heartbeats, bot messages, deprecations, duplicate summaries.
3. **Inject important signals.** Add `{ "match": "<signal>", "outcome": "inject" }` for events that should interrupt the session.
4. **Surface useful context.** Add `{ "match": "<context>", "outcome": "surface" }` for events worth showing in the timeline.
5. **Catch-all.** End with `{ "match": ".*", "outcome": "keep" }` to store everything else in the EventStream.

Good examples:

- log tail: drop timestamps, retries, and health-check chatter; inject `error|fatal|panic`
- PR watcher: drop bot comments and repeated status updates; inject `changes requested|failed|approved`
- ticket queue: inject `sla-breach|high-priority|escalated`; keep everything else

## Temporary vs persistent

Use **temporary** (`lifespan="temporary"`) when:

- the user is debugging, triaging, or investigating
- the correct EventFilter is not obvious yet
- the stream exists only for one task, incident, PR, or release window
- the timed schedule should end with the session

Use **persistent** (`lifespan="persistent"`) when:

- the same workflow should come back next session
- the command and thresholds are stable
- the user wants a reusable operating pattern

## Everything is code

If no ready-made CLI exists, create or use a small script that prints one meaningful line per event. Good CommandEmitters are often:

- API pollers
- webhook log tails
- release-note fetchers
- GitHub CLI pollers
- local watch scripts
- validation scripts for builds, tests, deploys, ETL, or compliance

Prefer normalized output over raw dumps. EventFilters work much better when each line already carries a stable tag or status word.

If the work is mostly reasoning rather than data collection, prefer a PromptEmitter:

- prompt once for a background check (oneTime)
- prompt + `runInterval` for a fixed maintenance loop (timed)

This is the closest analogue to Claude's session-scoped `/loop` behavior in this extension.

## Borrow from the official SDK examples

When working on the extension itself, not just using its emitter tools, prefer these SDK patterns:

- use `session.log()` for user-visible diagnostics; never rely on `console.log()`
- use hooks such as `onUserPromptSubmitted`, `onPreToolUse`, `onPostToolUse`, and `onErrorOccurred` to shape behavior
- use `session.on(...)` listeners for tool lifecycle, assistant messages, session idle, and errors when you need event-driven behavior
- use `session.send()` for asynchronous follow-up prompts and `session.sendAndWait()` only when the extension must wait for an answer
- use `onPermissionRequest` and `onUserInputRequest` for guarded flows instead of custom ad hoc prompting
- use `fs.watch` or `watchFile` when the extension should react to manual file edits or workspace artifacts such as `plan.md`

Good non-emitter examples to adapt into this repo:

- after an edit tool runs, trigger a lint or test emitter automatically
- watch a config file and refresh the corresponding emitter when the user edits it
- add a helper tool that fetches one-shot data from an API while emitters continue to watch background streams
- log EventFilter updates and emitter lifecycle events to the timeline for observability

## What not to do

- Do not create one giant mixed EventStream for unrelated workflows.
- Do not make a noisy stream persistent before you understand it.
- Do not skip the keep-all bootstrap policy for chatty sources — observe first, then add rules.
- Do not mutate userOwned persistent emitters or their EventFilter without explicit permission.
- Do not use EventStreams as a transcript mirror; use them for emitter-driven context.

## A strong operating recipe

When the user says "watch this" and the stream shape is unclear:

1. Create a temporary EventEmitter (CommandEmitter or PromptEmitter).
2. Enable the SessionInjector.
3. Start with keep-all bootstrap (no EventFilter rules).
4. Wait for a few real events.
5. Read EventStream history.
6. Add EventFilter rules progressively (drop noise → inject signal → keep the rest).
7. If the workflow proves valuable, ask or decide to create the persistent, userOwned version.
