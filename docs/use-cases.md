# How to use copilot-channels-extension

This extension is most useful anywhere a user would otherwise say:

- "Keep an eye on this."
- "Tell me when this changes."
- "Only interrupt me for the important parts."
- "Watch it for now, and if it proves useful, keep it around."

The key idea is simple:

- **EventEmitter** = the ONLY primary resource users define — a background command (CommandEmitter) or prompt (PromptEmitter)
- **EventStream** = auto-created named stream of accepted output (same name as the emitter)
- **EventFilter** = ordered rule list: `[{ match, outcome }]` — first match wins
- **SessionInjector** = derived automatically; controls whether EventStream updates are proactively injected
- **Lifespan** = `temporary` for this session, `persistent` for future sessions
- **Ownership** = `userOwned` for protected emitters, `modelOwned` for live tuning

### Event outcomes

| Outcome | Behavior |
| --- | --- |
| `drop` | Discard — does not enter the EventStream |
| `keep` | Store in the EventStream |
| `surface` | Keep + show in Copilot session timeline via `session.log()` |
| `inject` | Keep + surface + inject into Copilot via `session.send()` |

PromptEmitter events always inject (no filter applied). CommandEmitter events go through the EventFilter.

## Execution shapes

| Shape | Config | When to use it |
| --- | --- | --- |
| Continuous CommandEmitter | `command` | Tail a log, run a watch task, or consume a streaming source |
| Timed CommandEmitter | `command` + `runInterval` | Poll an API, re-run validation, or check a recurring state |
| OneTime PromptEmitter | `prompt` | Ask the agent to perform one background inspection or maintenance pass |
| Timed PromptEmitter | `prompt` + `runInterval` | Re-run a prompt in a session-scoped `/loop` style workflow |

## The golden workflow

1. Start with a **temporary** EventEmitter (`lifespan="temporary"`).
2. Enable the SessionInjector unless the stream is naturally sparse.
3. Let the emitter produce a few real events (keep-all bootstrap — no EventFilter rules yet).
4. Read EventStream history.
5. Add EventFilter rules progressively:
   - add `{ "match": "<noise>", "outcome": "drop" }` first to remove obvious noise
   - add `{ "match": "<signal>", "outcome": "inject" }` for important events
   - end with `{ "match": ".*", "outcome": "keep" }` as a catch-all
6. If the workflow is recurring, add `runInterval` and make it timed.
7. If the workflow is recurring across sessions, promote it to **persistent** and make it **userOwned**.

The EventFilter is hot-swappable while the emitter runs. Start broad, observe, then tighten.

## Command vs prompt

Use a **CommandEmitter** when the signal already exists outside the agent:

- CI logs
- GitHub CLI queries
- ticket APIs
- release feeds
- file tails

Use a **PromptEmitter** when the work is mainly reasoning, summarization, or maintenance:

- "check whether there are new review comments and summarize only actionable changes"
- "re-check the deploy and tell me whether it is safe to continue"
- "look for new urgent issues or failing runs and summarize what changed"
- "run a maintenance pass on the current branch"

Use `runInterval` when either of those should repeat on a session-scoped interval. Timed PromptEmitters begin on their first interval instead of firing immediately, which avoids colliding with the active session turn that created them.

## Pattern library

## 1. PR babysitting and code review

| Scenario | Emitter | EventStream | Good defaults |
| --- | --- | --- | --- |
| Hot PR babysitter | Poll `gh pr view <n> --json reviews,comments,statusCheckRollup` | `pr-activity` | Start temporary; userOwned emitter; modelOwned EventFilter; inject on `changes requested`, `failed`, `review submitted` |
| Reviewer response lag | Poll requested reviewers and timestamps | `pr-reviewers` | Persistent for team workflow; userOwned; inject when a PR stays unreviewed too long |
| Merge conflict detector | Compare PR branch with base branch on an interval | `pr-conflicts` | Temporary; inject important signals; drop non-critical file paths after first run |
| Label and approval gate | Poll labels, approval count, blocking checks | `pr-gate` | Persistent; userOwned thresholds; inject on `approved`, `blocked`, `missing-review` |
| Auto-rerun watcher | Poll reruns or status changes in CI for a PR | `pr-ci` | Temporary; keep-all at first; drop bot chatter and duplicate check states |

## 2. CI, build, and test monitoring

| Scenario | Emitter | EventStream | Good defaults |
| --- | --- | --- | --- |
| Failing test stream | Watch `npm test -- --watch`, `pytest -f`, or similar | `test-results` | Temporary; inject `FAIL`, `ERROR`, `TIMEOUT` |
| Typecheck watcher | Run `tsc --watch` or equivalent | `types` | Temporary or persistent; drop dependency noise; inject compiler errors only |
| Coverage regression tracker | Poll coverage output or parse report files | `coverage` | Persistent for mature repos; userOwned thresholds; inject on drops below target |
| Build artifact size drift | Run bundle analyzer or publish-size script | `build-artifacts` | Persistent; inject on threshold breaches, not on every successful build |
| Flaky test quarantine | Poll repeated test runs and state changes | `flaky-tests` | Persistent; history matters more than injection; inject only on new or worsening flakes |

## 3. Issues, bugs, and backlog health

| Scenario | Emitter | EventStream | Good defaults |
| --- | --- | --- | --- |
| Critical bug queue | Poll `gh issue list` for severity labels | `critical-bugs` | Persistent; userOwned emitter; inject on high-severity new issues |
| Untriaged issue queue | Poll issues with no assignee or no triage label | `triage-queue` | Persistent; keep-all if low volume, add EventFilter if noisy |
| Stale backlog debt | Poll old issues or items untouched for 30+ days | `backlog-debt` | Persistent; inject only when stale items cross a threshold |
| Release blocker tracker | Poll blockers and post-mortem issues | `release-status` | Temporary per release, then archive; inject on open/closed transitions |
| Regression issue detector | Combine failing CI signals with issue creation | `regressions` | Temporary during active fire-fighting; model tunes the EventFilter aggressively |

## 4. Email, inboxes, and alert feeds

| Scenario | Emitter | EventStream | Good defaults |
| --- | --- | --- | --- |
| Executive or escalation inbox | Poll IMAP or an email API through a script | `urgent-emails` | Persistent; userOwned; inject on senders, subjects, or mailbox labels that matter |
| Personal inbox triage | Poll unread messages and normalize to one line per email | `inbox-digest` | Temporary first; keep-all, then drop newsletters and auto-replies |
| On-call alert bridge | Poll PagerDuty, Opsgenie, or similar | `oncall-alerts` | Persistent; inject on severity transitions; drop maintenance-window noise |
| Mention aggregator | Poll Slack, Teams, GitHub, and email mentions into one stream | `mentions` | Temporary during focused work; inject only on direct, actionable mentions |
| Suspicious mail or phishing queue | Poll a mail security feed | `suspicious-mail` | Persistent and userOwned; inject only on high-confidence signals |

## 5. Deployments, logs, and operations

| Scenario | Emitter | EventStream | Good defaults |
| --- | --- | --- | --- |
| Kubernetes pod health | Run `kubectl get pods -w` or a poller | `k8s-health` | Persistent; inject on readiness failures and crash loops |
| Deployment rollout watcher | Monitor deploy script output or pipeline states | `deploy-ci` | Temporary during rollout; drop info chatter quickly |
| Error-log tail | `tail -f` an error log or app log pipeline | `app-errors` | Temporary during incidents; start with keep-all and tighten after first burst |
| DB lag or replica health | Poll replication lag or replica status | `db-replication` | Persistent; sparse stream; keep-all with inject on threshold breaches |
| Canary or rollback gate | Poll health endpoints or smoke checks | `health-gate` | Temporary; userOwned success criteria; inject on repeated failures only |

## 6. Local developer loops

| Scenario | Emitter | EventStream | Good defaults |
| --- | --- | --- | --- |
| Local test watch | `jest --watch`, `vitest --watch`, etc. | `test-output` | Temporary; modelOwned EventFilter okay; drop timing and framework noise |
| Lint watch | `eslint --watch`, `ruff check --watch`, etc. | `lint` | Temporary; inject on errors; keep warnings in history if useful |
| Build watch | `npm run build -- --watch`, `cargo watch`, etc. | `build` | Temporary; drop routine rebuild lines after first run |
| Integration harness | Run verbose integration suite or local environment harness | `integration` | Temporary; inject on failures and timeouts only |
| Multi-stream coding loop | Run tests, types, and lint in separate emitters | `types`, `lint`, `test-output` | Temporary; enable SessionInjector only for the most blocking stream |

## 7. Security and compliance

| Scenario | Emitter | EventStream | Good defaults |
| --- | --- | --- | --- |
| Dependency vulnerability watch | Run `npm audit`, `pip-audit`, `cargo audit`, etc. | `deps-security` | Persistent; userOwned baseline; inject on high/critical or new CVEs |
| Secret scanning | Run `detect-secrets`, `trufflehog`, or a custom regex scanner | `secrets-scan` | Persistent; drop known templates; inject on high-confidence leaks |
| License compliance drift | Run a license scanner | `license-compliance` | Persistent and userOwned; inject only on banned or unknown licenses |
| Supply-chain verification | Poll signature/checksum verification output | `supply-chain-verify` | Persistent; inject on unsigned or mismatched artifacts |
| Policy audit stream | Run `checkov`, `tfsec`, `kube-bench`, SAST/DAST tools | `compliance-audit` | Persistent; keep full history; inject on critical failures only |

## 8. Support, customer feedback, and community

| Scenario | Emitter | EventStream | Good defaults |
| --- | --- | --- | --- |
| Support backlog watcher | Poll a ticket API for open/SLA-breach tickets | `support-backlog` | Persistent; inject on SLA breaches and escalations only |
| Community signal emitter | Poll Discord, Slack, forums, or Reddit for keywords | `community-signals` | Start temporary; drop jokes, bot chatter, and duplicate reposts |
| Feature request stream | Poll Discussions, forms, or webhook logs | `feature-requests` | Persistent; keep-all, then drop duplicates once the themes are known |
| Moderation queue | Poll flagged posts or moderation APIs | `moderation-queue` | Persistent and userOwned; inject on severe content only |
| Incident communication queue | Poll support or community channels for outage chatter | `incident-comms` | Temporary during incidents; model tightens the EventFilter fast |

## 9. Research, docs, and knowledge monitoring

| Scenario | Emitter | EventStream | Good defaults |
| --- | --- | --- | --- |
| Paper feed watcher | Poll arXiv or a research API | `research-feeds` | Persistent; keep-all, inject on topics or authors that matter |
| Release-note tracker | Poll GitHub releases or changelog feeds | `releases` | Persistent; inject on breaking changes, deprecations, and security notes |
| Competitor news emitter | Poll blogs, RSS, or product feeds | `competitive-intel` | Persistent; drop rumor/analysis posts after first week |
| Docs staleness detector | Scan docs by age or Git history | `doc-staleness` | Temporary during doc audits; inject on core docs only |
| Deadline and event calendar | Poll calendars or JSON feeds | `event-deadlines` | Persistent; inject only when deadlines are approaching |

## 10. Releases, scheduled jobs, and business processes

| Scenario | Emitter | EventStream | Good defaults |
| --- | --- | --- | --- |
| Package publish watcher | Monitor `npm publish`, release scripts, or publishing logs | `publish-log` | Temporary on release day, then persist if recurring |
| Scheduled job health | Poll cron, DAG, or batch-job status | `jobs-status` | Persistent; inject on state transitions, not polling chatter |
| Data pipeline validation | Monitor ETL validator output | `data-pipeline` | Temporary for new pipelines, persistent for production checks |
| Artifact registry emitter | Poll for RCs or package versions in a registry | `release-artifacts` | Temporary during releases; inject on exact version matches |
| Reconciliation and finance checks | Poll reconciliation scripts or audit output | `reconciliation` | Persistent and userOwned; inject on material mismatches only |

## How to decide temporary vs persistent

Choose **temporary** (`lifespan="temporary"`) when:

- this is tied to one incident, one PR, or one debugging session
- you do not yet know the right EventFilter rules
- the stream shape is unknown and likely noisy
- the model should be free to tune things live
- the timed schedule should stop when the current session ends

Choose **persistent** (`lifespan="persistent"`) when:

- the same emitter is useful across sessions
- the command and thresholds are stable
- the rules encode team policy or operational practice
- the user wants the workflow to come back automatically

## How to split userOwned vs modelOwned

Keep it **userOwned** when:

- the emitter touches security, compliance, email, finance, or release gates
- the command embeds important org-specific assumptions
- the EventStream is now part of team workflow
- a mistaken change would create real risk

Let it be **modelOwned** when:

- this is a temporary investigative emitter
- the main problem is noise reduction, not policy
- the user wants the agent to learn what matters from the live stream
- EventFilter tuning is expected to change several times during one task

## Design tips

1. Prefer one concern per EventStream (one emitter per concern).
2. Normalize your emitter output so each line is meaningful.
3. Use the EventFilter outcome hierarchy: drop noise → inject signal → keep the rest.
4. Drop noise before narrowing what gets injected.
5. If you are polling something repeatedly, prefer `runInterval` over re-running it manually.
6. If you create the same emitter more than a few times, promote it to persistent config.
7. If the user cares about ownership, switch the persistent version to `ownership="userOwned"` after the workflow stabilizes.

## General SDK patterns worth borrowing

The official `@github/copilot-sdk` examples are useful even when a pattern is not specifically about EventStreams or EventEmitters. These are good extension ideas to combine with this repo's emitter model.

### 1. Log important extension state to the timeline

Use `session.log()` instead of `console.log()` to explain what the extension is doing:

- emitter started or stopped
- EventFilter updated
- config loaded
- retries or recoverable failures

Use `ephemeral: true` for noisy operational messages that should not stick around forever.

### 2. Use hooks to shape behavior around tool use

The SDK examples show several high-value hook patterns:

- `onUserPromptSubmitted` to add hidden context or trigger follow-up behavior
- `onPreToolUse` to deny risky commands or rewrite arguments
- `onPostToolUse` to add context after a tool finishes
- `onErrorOccurred` to retry, skip, or abort cleanly

For this repo, the natural extension is to combine hooks with EventStreams:

- if a risky shell command appears, log it and post a note into an ops or audit EventStream
- after a code-edit tool runs, trigger a temporary build or lint emitter
- when a recurring failure happens, inject a short background follow-up with `session.send()`

### 3. Add custom helper tools next to the emitter tools

The official examples include simple tools that:

- run a shell command
- fetch data from an API
- copy text to the clipboard

That maps well to this repo. Good companion tools would be:

- `fetch_release_notes`
- `poll_ticket_queue_once`
- `summarize_stream`
- `snapshot_emitter_state`

Use emitters for ongoing signals and helper tools for one-shot actions.

### 4. React to session events, not just your own process output

The SDK examples show how to listen to session events such as:

- `tool.execution_start`
- `tool.execution_complete`
- `assistant.message`
- `session.idle`
- `session.error`

That is useful here even though emitters already push updates directly. Examples:

- start a temporary validation emitter after a build tool starts
- clear a transient EventFilter once the session goes idle
- attach extra context when a tool fails repeatedly
- mirror important lifecycle events into an EventStream for auditability

### 5. Watch files and workspace artifacts

The examples show `fs.watch` and `watchFile` patterns for:

- `plan.md`
- repo files edited manually by the user

That pairs well with this repo when a workflow mixes code changes and emitters:

- watch `plan.md` and post "plan changed" into a planning EventStream
- watch files under `logs/` and create an emitter automatically
- detect user edits to a config file and refresh the corresponding emitter

### 6. Use `session.send()` and `session.sendAndWait()` intentionally

Use:

- `session.send()` for fire-and-forget background nudges
- `session.sendAndWait()` only when the extension genuinely needs the agent's answer before continuing

For EventStream injection, `session.send()` is usually the right fit. For a helper flow like "fetch data, then ask the agent to summarize it before updating config", `sendAndWait()` can make sense.

### 7. Build permission and user-input workflows into the extension

The SDK examples also show:

- custom permission logic via `onPermissionRequest`
- user questions via `onUserInputRequest`

These are powerful in this repo for guarded workflows:

- ask before persisting a new emitter
- deny destructive shell commands from helper tools
- request confirmation before overriding a userOwned EventFilter
- collect thresholds or keywords interactively instead of hardcoding them

### 8. Keep it cross-platform

The examples call out Windows-specific concerns:

- detect Windows with `process.platform === "win32"`
- prefer the right shell and stderr redirection syntax
- use Windows-safe process launching

That is especially relevant here because emitters are shell-driven and this repo is intended to be copied into real projects on different operating systems.
