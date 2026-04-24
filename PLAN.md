# Ubiquitous Language

This document captures the **target mental model** we want to use when talking about the system. It is simpler than the current implementation vocabulary and is intended to guide future renaming.

## Core concepts

| Term | Definition | Aliases to avoid |
| ----------- | ------------------------------------------------------- | --------------------- |
| **EventEmitter** | A background worker that emits Events. An EventEmitter is either a CommandEmitter or a PromptEmitter. | Monitor |
| **CommandEmitter** | An EventEmitter backed by a shell command. The shell command may be a log tail, a server process, a watcher, or anything else that emits lines over time. | Command monitor |
| **PromptEmitter** | An EventEmitter backed by a prompt-based worker that is triggered once or by a configured timer. It re-runs the same prompt and emits the resulting output as events. | Prompt work item |
| **Event** | A single unit emitted by an EventEmitter. For a CommandEmitter, each emitted line is an Event. | Candidate line, message |
| **EventFilter** | A function owned by an EventEmitter that takes an Event and returns its outcome. In the preferred model it is an ordered rule list that maps an Event to Drop, Keep, Surface, or Inject. | Classifier |
| **EventStream** | The in-memory stream where kept events are stored. It contains all events that were not dropped. | Channel |
| **SessionInjector** | A resource attached to exactly one EventStream. It takes events from that EventStream and either surfaces them in Copilot or injects them into Copilot. | Subscription, EventReceiver |

## EventEmitter lifespan

| Term | Definition | Aliases to avoid |
| ----------- | ------------------------------------------------------- | --------------------- |
| **EventEmitterLifespan** | The persistence lifetime of an EventEmitter definition. | Scope |
| **TemporaryEmitter** | An EventEmitter definition that exists only for the current session. | Session-scoped emitter |
| **PersistentEmitter** | An EventEmitter definition that is saved and restored across sessions. | Saved emitter |
| **AutoStart** | A flag that only applies to a PersistentEmitter and causes it to start automatically when restored in a later session. | Auto-run |

## Run schedule

| Term | Definition | Aliases to avoid |
| ----------- | ------------------------------------------------------- | --------------------- |
| **RunSchedule** | How an EventEmitter runs over time. | executionMode |
| **Continuous** | Keep going until stopped. For a CommandEmitter, the process keeps running. For a PromptEmitter, the prompt re-runs when the session is idle. | Process |
| **Timed** | Run, complete, wait for an interval, and then run again. | Loop |
| **OneTime** | Run once and then stop. | Once |
| **RunInterval** | The repeat interval used only when RunSchedule is Timed, for example `30s`, `5m`, or `1h`. | every |

## Ownership

| Term | Definition | Aliases to avoid |
| ----------- | ------------------------------------------------------- | --------------------- |
| **Ownership** | The control setting that decides who is allowed to modify a resource by default. | managedBy |
| **UserOwned** | The ownership value that protects a resource for direct user control. | Human-owned, User |
| **ModelOwned** | The ownership value that allows the model to adjust a resource through tools. | Agent-owned, Model |
| **TransferOwnership** | An explicit override that changes or takes over a resource protected by a different owner. | force |

## Event outcomes

| Outcome | Meaning |
| ----------- | ------------------------------------------------------- |
| **Drop** | Discard the Event. It does not enter the EventStream. |
| **Keep** | Store the Event in the EventStream. |
| **Surface** | Keep the Event and surface it in the Copilot session timeline or visible session UI. |
| **Inject** | Keep the Event, surface it, and inject it back into Copilot. |

## Inclusive hierarchy

- Every **Inject** outcome also implies **Surface**.
- Every **Surface** outcome also implies **Keep**.
- Every **Keep** outcome originated as an **Event** emitted by an **EventEmitter**.
- **Drop** is outside that chain.
- In the target model, events from a **PromptEmitter** are always **Inject**.
- Every **EventEmitter** has an **EventEmitterLifespan**.
- **AutoStart** applies only to a **PersistentEmitter**.
- Every **EventEmitter** also has a **RunSchedule**.
- Every **EventEmitter** owns exactly one **EventFilter**.
- Every major resource also has an **Ownership**.
- Each **EventEmitter** writes to exactly one **EventStream**.
- Each **EventStream** has exactly one **SessionInjector**.
- Each **SessionInjector** belongs to exactly one **EventStream**.

## Event flow

1. An **EventEmitter** emits an **Event**.
2. If the emitter is a **CommandEmitter**, the **EventFilter** evaluates the Event and returns an outcome.
3. If the emitter is a **PromptEmitter**, the Event bypasses the EventFilter and becomes **Inject**.
4. Accepted events enter the **EventStream**.
5. The **SessionInjector** takes events from that EventStream.
6. The command-emitted Event becomes one of:
   - **Drop**
   - **Keep**
   - **Surface**
   - **Inject**
7. The **EventFilter** is dynamically reloadable. Each new Event is evaluated against the latest active EventFilter without restarting the EventEmitter.

## Current implementation mapping

| Current code term | Target term |
| ----------- | ------------------------------------------------------- |
| `monitor` | **EventEmitter** |
| `command` workType | **CommandEmitter** |
| `prompt` workType | **PromptEmitter** |
| `classifier` | **EventFilter** |
| `channel` | **EventStream** |
| `subscription` | **SessionInjector** |
| accepted channel entry | **Keep** |
| `session.log()` output | **Surface** |
| `session.send()` output | **Inject** |
| `temporary` scope | **TemporaryEmitter** |
| `persistent` scope | **PersistentEmitter** |
| `autoStart` | **AutoStart** |
| `executionMode="process"` | **RunSchedule=Continuous** |
| `executionMode="loop"` | **RunSchedule=Timed** |
| `executionMode="once"` | **RunSchedule=OneTime** |
| `every` | **RunInterval** |
| `managedBy` | **Ownership** |
| `user` | **UserOwned** |
| `model` | **ModelOwned** |
| `force` | **TransferOwnership** |

## Important implementation note

The current code does **not** yet model all four event outcomes as first-class configuration outcomes.

Today the implementation effectively has:

- **Drop** via `excludePattern` / `includePattern`
- **Keep** via `channels.append(...)`
- **Inject** via subscription delivery and `session.send()`

`session.log()` currently behaves as a **separate runtime logging side effect**, not as a first-class event classification outcome for normal monitor lines.

That means **Surface** is part of the target mental model, but not yet a cleanly configurable outcome in the implementation. It also means the current implementation still applies the classifier to prompt output, whereas the target model says **PromptEmitter** events should always be **Inject**.

## What would need to change

### 1. Rename the core runtime vocabulary

- `monitor` -> `eventEmitter`
- `channel` -> `eventStream`
- `subscription` -> `sessionInjector`
- `classifier` -> `eventFilter`
- `prompt work item` -> `promptEmitter`

### 2. Rename emitter variants

- `workType="command"` -> `emitterType="command"`
- `workType="prompt"` -> `emitterType="prompt"`

or keep the field name and only rename the human-facing terms.

### 3. Introduce EventEmitter lifespan terminology

- `scope="temporary"` -> **TemporaryEmitter**
- `scope="persistent"` -> **PersistentEmitter**
- `autoStart` remains **AutoStart**, but only applies to a **PersistentEmitter**

Persistence should mean:

- the EventEmitter definition survives across sessions
- the running process itself does not survive across sessions

### 4. Introduce Ownership terminology

- `managedBy` -> **Ownership**
- `user` -> **UserOwned**
- `model` -> **ModelOwned**
- `force` -> **TransferOwnership**

Ownership should apply consistently to:

- **EventEmitter**
- **EventStream**
- **SessionInjector**
- **EventFilter**

### 5. Introduce RunSchedule terminology

- `executionMode="process"` -> **RunSchedule=Continuous**
- `executionMode="loop"` -> **RunSchedule=Timed**
- `executionMode="once"` -> **RunSchedule=OneTime**
- `every` -> **RunInterval**

Recommended rules:

- **CommandEmitter** can be **Continuous**, **Timed**, or **OneTime**
- **PromptEmitter** can be **Continuous**, **Timed**, or **OneTime**
- For a **CommandEmitter**, **Continuous** means the process keeps running
- For a **PromptEmitter**, **Continuous** means re-run when the session is idle
- **RunInterval** is only valid for **Timed**

### 6. Make EventFilter explicit as an outcome function for command emitters

Preferred target model:

```json
{
  "eventFilter": [
    { "match": "heartbeat|trace|debug", "outcome": "drop" },
    { "match": "connected|healthy|ready", "outcome": "surface" },
    { "match": "warning|error|failed|urgent", "outcome": "inject" },
    { "match": ".*", "outcome": "keep" }
  ]
}
```

This means:

- the EventFilter is an **ordered rule list**
- the **first matching rule wins**
- each rule returns one explicit outcome:
  - **Drop**
  - **Keep**
  - **Surface**
  - **Inject**

Conceptually the EventFilter can be thought of as returning:

- `0` = Drop
- `1` = Keep
- `2` = Surface
- `3` = Inject

The exact encoding does not matter; the important point is that the filter returns an outcome.

Recommended bootstrap policy:

- start with **keep-all**
- do not inject everything by default
- add **Surface** rules for useful informational signals
- add **Inject** rules only for signals important enough to enter Copilot context
- add **Drop** rules as noise becomes obvious

Minimal starter filter:

```json
{
  "eventFilter": [
    { "match": ".*", "outcome": "keep" }
  ]
}
```

### 7. Separate CommandEmitter filtering from PromptEmitter injection

In the target model:

- **CommandEmitter** events go through the **EventFilter**
- **PromptEmitter** events are always **Inject**

That means prompt-driven work should no longer share the same classifier path as command-driven work.

### 8. Clarify Surface semantics

Right now, normal accepted events are recorded in the stream and some are injected, but monitor lines are not automatically mirrored to `session.log()`.

To make **Surface** real in code, we would need one of:

1. a new config field for session logging behavior, or
2. a rule that injected events are always session-logged first, or
3. a separate event-surface policy distinct from storage and injection

### 9. Support hot-swappable EventFilter updates

While an EventEmitter is active, AI should be able to update the EventFilter without restarting the emitter.

That means:

- the latest filter is applied to each new Event
- filter edits affect future Events only
- EventEmitter runtime and EventFilter evolution are decoupled

### 10. Update docs and tool descriptions

- README mental model
- tool descriptions in `src/tools/*.mjs`
- config examples
- `copilot-instructions.md`

### 11. SessionInjector is a resource

`SessionInjector` should be treated as a resource, not a role. The docs should describe it as:

> the Copilot-side injection resource attached to one EventStream

It is not a second stored stream. It is the resource that takes events from one EventStream for surface and injection behavior.

## Example dialogue

> **Dev:** "Is this a **CommandEmitter** or a **PromptEmitter**?"
> **Domain expert:** "Both are **EventEmitters**; they just produce events from different sources."
> **Dev:** "What is the difference between a **TemporaryEmitter** and a **PersistentEmitter**?"
> **Domain expert:** "A TemporaryEmitter exists only in the current session. A PersistentEmitter is restored in later sessions, and **AutoStart** decides whether it starts automatically."
> **Dev:** "How does the emitter run over time?"
> **Domain expert:** "That is the **RunSchedule**. A CommandEmitter can be Continuous, Timed, or OneTime. A PromptEmitter is usually Timed and may also be OneTime."
> **Dev:** "What does **Ownership** mean?"
> **Domain expert:** "Ownership decides whether a resource is controlled by **UserOwned** or **ModelOwned**, and **TransferOwnership** is the explicit override when control must change."
> **Dev:** "What does the **EventFilter** do?"
> **Domain expert:** "For a **CommandEmitter**, it decides whether the event is dropped, kept in the **EventStream**, surfaced in Copilot, or injected into Copilot."
> **Dev:** "How many injectors does an **EventStream** have?"
> **Domain expert:** "Exactly one. The model is one EventEmitter, one EventStream, and one SessionInjector."
> **Dev:** "How should the filter start?"
> **Domain expert:** "Start with keep-all, then let AI add Drop, Surface, and Inject rules as it learns the stream."
> **Dev:** "So Inject is the strongest outcome?"
> **Domain expert:** "Yes. It implies Keep and Surface, and then injects the event into the Copilot session."
> **Dev:** "What about a **PromptEmitter**?"
> **Domain expert:** "PromptEmitter events are already prompt results, so in the target model they are treated as **Inject**."

## Resolved decisions

- **Surface** is a real implementation concept. The **SessionInjector** handles it via `session.log()`.
- **EventFilter** uses ordered rules only. Each evaluated Event carries an `outcome` property (`drop`, `keep`, `surface`, or `inject`).
- **PromptEmitter** events always **Inject** — no EventFilter is applied.
- **Ownership** lives on the **EventEmitter** only — derived resources inherit it.
- **EventStream** and **SessionInjector** are derived automatically from the **EventEmitter**.
- **EventStream name = EventEmitter name** — one shared identifier, tools address everything by emitter name.
- **EventFilter** is hot-swappable while the emitter is running.
- Bootstrap policy: start with **keep-all**, then evolve.
