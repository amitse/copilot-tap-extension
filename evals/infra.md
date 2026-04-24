# Real-Copilot eval infrastructure

This folder is for **end-to-end evals with a real Copilot CLI session**, not mocked tool tests.

The goal is to answer:

- does Copilot discover and use the extension correctly?
- does it choose the right work shape: command monitor, command loop, prompt once, or prompt loop?
- does it handle subscriptions, classifiers, and persistence well?
- does it respect `managedBy="user"` boundaries?
- does it tighten classifiers only after it has seen real stream data?

## Source of truth

- `evals/cases.yaml` is the case catalog
- this file describes how to run and score the cases
- `evals/run.mjs` is the programmatic runner

## Runner commands

```bash
npm run evals:list
node evals/run.mjs smoke
node evals/run.mjs run --case E001
node evals/run.mjs run --all
node evals/run.mjs run --case E001 --dry-run
npm run evals:validate-modes
node evals/run.mjs prepare-interactive --case E001
node evals/run.mjs judge-interactive --run-dir "<prepared-run-dir>"
```

The automated runner uses **one ACP server plus fresh SDK sessions**:

1. **Preflight session** checks whether `tap_*` tools are mounted into the ACP session.
2. **Executor session** runs the case prompt against the shared channels runtime.
3. **Judge session** reads the saved artifacts and returns a structured verdict.

Artifacts are written under `evals/results/<timestamp>/<case-id>/`.
The ACP path saves prompt, response, error, and full event transcript artifacts directly; it does not depend on `copilot --share`.
The runner also writes a `preflight/` folder once per run to record whether the shared channels runtime is available in the ACP session.

## What is under test

The current extension surface includes:

- continuous command monitors
- looped command work via `every`
- one-shot prompt work
- prompt loops via `prompt` + `every`
- channel subscriptions
- per-line classifier checks for running scripts
- per-line classifier checks for prompt responses after they are split into lines
- persistent config behavior
- user-controlled vs model-controlled ownership

## Test philosophy

These evals should feel like **real user requests** to Copilot, not direct API fixture calls.

Each case should test whether Copilot:

1. understands the user's intent
2. picks the right extension tool(s)
3. picks the right work shape
4. starts broad enough to learn the stream
5. tightens filtering only after observing output
6. avoids overriding user-owned persistent state without explicit permission

## Recommended environment

Automated ACP evals need:

- authenticated GitHub Copilot CLI
- this repo as the current working directory
- `npm install` completed so the SDK package is available locally
- a clean or intentionally prepared `tap.config.json`

Interactive loader checks additionally need:

- repo-scoped extension loaded with `/clear` or `extensions_reload`
- transcript capture enabled if possible

Recommended local context:

- OS: Windows (primary) plus one macOS/Linux spot check
- GitHub auth present for any `gh`-based cases
- Node available for `examples/heartbeat.mjs`

## Run model

Each automated eval is driven by the natural-language `user_prompt` from `cases.yaml`, but the runner now mounts the shared channels runtime directly into ACP sessions instead of asking `copilot -p` to discover `.github/extensions`.

That split is deliberate:

1. `run` and `smoke` test the real channel/monitor behavior through the shared runtime module.
2. `validate-modes` tests whether the actual repo-scoped extension loader attaches in prompt mode.
3. `prepare-interactive` plus `judge-interactive` remain the reference path for true foreground-extension checks.

For the specific interactive-vs-`-p` question, `validate-modes` is the dedicated check:

1. it runs a prompt-mode probe that asks Copilot to persist a unique channel subscription via `tap_enable_injector`
2. it inspects `tap.config.json` to see whether that probe channel was actually written
3. it cleans up the probe channel
4. it prints an interactive follow-up using the exact same prompt, plus an inspect command that verifies and cleans up the interactive run

## Current extension-loader limitation

On the current Windows setup used for this repo, repo-scoped extension tools may still be unavailable in headless or prompt-mode sessions even when the working directory is correct.

When that happens:

- `validate-modes` records that the real `.github/extensions` tools were not visible in `copilot -p`
- ACP runs can still exercise the same behavior because the shared runtime is injected directly through the SDK
- the interactive control path remains the reference check for actual extension discovery: open Copilot CLI in this repo, run `/clear` or `extensions_reload`, and retry manually

Because of that, the practical eval split is:

1. **ACP automated evals** for the feature logic
2. **interactive executor** for actual extension-loader behavior
3. **non-interactive judge** for scoring saved artifacts after the interactive run

`prepare-interactive` writes the exact executor prompt, captures the pre-run config snapshot, and gives you a `/share <path>` command for that case. `judge-interactive` then reads the shared transcript, any optional executor report, and the before/after config snapshots to produce the structured verdict through a tool-free ACP judge. If you keep one interactive session open across multiple cases, run `/clear` before each next case.

## Scoring rubric

Use a simple 0-2 score per dimension:

- **0** = failed
- **1** = partially correct
- **2** = correct

Dimensions:

1. **Intent match** — chose the right extension feature
2. **Work shape** — correct choice of command vs prompt vs loop
3. **Filter strategy** — did not over-constrain too early
4. **Ownership safety** — respected `managedBy="user"`
5. **Persistence choice** — chose temporary vs persistent appropriately
6. **Operational quality** — clean stop, useful channel naming, sensible subscription mode

## Minimum evidence per case

Record these for every run:

- case ID
- Copilot model/version if visible
- OS
- user prompt
- actual tool calls
- final monitor state
- final channel state
- pass/fail notes

## Pass criteria

A case passes when:

- Copilot uses the extension in the intended way
- output is routed into the expected channel
- line-level behavior matches the case expectation
- filters remain absent until explicitly added, where relevant
- loops or persistence behave as requested

## Important behavioral checks

These are regression-sensitive and should be checked often:

### 1. No hidden notify fallback

When no `notifyPattern` exists, the system should not apply a secret built-in regex. With `delivery="important"`, live delivery should stay quiet until a `notifyPattern` is introduced, while accepted lines still land in the channel.

### 2. Line granularity

For running commands:

- stdout is processed line-by-line
- stderr is processed line-by-line

For prompt work:

- the assistant response is split into lines
- each line is evaluated independently by the classifier

### 3. Loop semantics

Current loop behavior is intentionally simple:

- `every` creates a fixed interval loop
- the next run is scheduled after the current run completes
- there is no cron parser beyond `30s`, `5m`, `2h`, `1d`, and `every 5 minutes` style strings
- there is no catch-up for missed intervals
- loops are session-scoped, though persistent config recreates them on the next session

### 4. Ownership semantics

Persistent, user-owned resources should require explicit override intent before Copilot changes them.

## Suggested fixture usage

Use these built-in repo assets first:

- `examples/heartbeat.mjs` for streaming command tests
- `tap.config.example.json` as a seed for persistence tests

If a case needs a more specific line pattern, add a small dedicated fixture script under `evals/fixtures/` later rather than relying on ad hoc shell one-liners.

## Future harness ideas

Once the case list stabilizes, the next step can be:

- a lightweight runner that materializes per-case setup
- transcript capture and result bundling
- golden pass/fail snapshots
- nightly or pre-release eval sweeps against real Copilot
