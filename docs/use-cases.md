# How to use copilot-channels-extension

This extension is most useful anywhere a user would otherwise say:

- "Keep an eye on this."
- "Tell me when this changes."
- "Only interrupt me for the important parts."
- "Watch it for now, and if it proves useful, keep it around."

The key idea is simple:

- **Monitor** = a background command, poller script, or prompt work item
- **Channel** = the named stream of accepted output
- **Classifier** = `includePattern`, `excludePattern`, and `notifyPattern`
- **Subscription** = whether the agent should proactively surface channel updates
- **Scope** = `temporary` for this session, `persistent` for future sessions
- **Control** = `managedBy="user"` for protected rules, `managedBy="model"` for live tuning

## Execution shapes

| Shape | Config | When to use it |
| --- | --- | --- |
| Continuous command monitor | `command` | Tail a log, run a watch task, or consume a streaming source |
| Looped command work | `command` + `every` | Poll an API, re-run validation, or check a recurring state |
| One-shot prompt work | `prompt` | Ask the agent to perform one background inspection or maintenance pass |
| Prompt loop | `prompt` + `every` | Re-run a prompt in a session-scoped `/loop` style workflow |

## The golden workflow

1. Start with a **temporary** monitor.
2. Subscribe the channel with `delivery="important"` unless the stream is naturally sparse.
3. Let the monitor produce a few real events.
4. Read channel history.
5. Tighten the classifier:
   - add `excludePattern` first to remove obvious noise
   - narrow `includePattern` only after you understand the stream
   - sharpen `notifyPattern` so only useful events interrupt the session
6. If the workflow is recurring, add `every` and make it a loop.
7. If the workflow is recurring across sessions, promote it to **persistent** and make it **user-controlled**.

## Command vs prompt

Use a **command** when the signal already exists outside the agent:

- CI logs
- GitHub CLI queries
- ticket APIs
- release feeds
- file tails

Use a **prompt** when the work is mainly reasoning, summarization, or maintenance:

- "check whether there are new review comments and summarize only actionable changes"
- "re-check the deploy and tell me whether it is safe to continue"
- "look for new urgent issues or failing runs and summarize what changed"
- "run a maintenance pass on the current branch"

Use `every` when either of those should repeat on a session-scoped interval.

## Pattern library

## 1. PR babysitting and code review

| Scenario | Monitor | Channel | Good defaults |
| --- | --- | --- | --- |
| Hot PR babysitter | Poll `gh pr view <n> --json reviews,comments,statusCheckRollup` | `pr-activity` | Start temporary; user-owned monitor; model-owned classifier; notify on `changes requested`, `failed`, `review submitted` |
| Reviewer response lag | Poll requested reviewers and timestamps | `pr-reviewers` | Persistent for team workflow; user-controlled; notify when a PR stays unreviewed too long |
| Merge conflict detector | Compare PR branch with base branch on an interval | `pr-conflicts` | Temporary; delivery `important`; exclude non-critical file paths after first run |
| Label and approval gate | Poll labels, approval count, blocking checks | `pr-gate` | Persistent; user-owned thresholds; notify on `approved`, `blocked`, `missing-review` |
| Auto-rerun watcher | Poll reruns or status changes in CI for a PR | `pr-ci` | Temporary; broad include at first; exclude bot chatter and duplicate check states |

## 2. CI, build, and test monitoring

| Scenario | Monitor | Channel | Good defaults |
| --- | --- | --- | --- |
| Failing test stream | Watch `npm test -- --watch`, `pytest -f`, or similar | `test-results` | Temporary; delivery `important`; notify on `FAIL`, `ERROR`, `TIMEOUT` |
| Typecheck watcher | Run `tsc --watch` or equivalent | `types` | Temporary or persistent; exclude dependency noise; notify on compiler errors only |
| Coverage regression tracker | Poll coverage output or parse report files | `coverage` | Persistent for mature repos; user-owned thresholds; notify on drops below target |
| Build artifact size drift | Run bundle analyzer or publish-size script | `build-artifacts` | Persistent; notify on threshold breaches, not on every successful build |
| Flaky test quarantine | Poll repeated test runs and state changes | `flaky-tests` | Persistent; history matters more than delivery; notify only on new or worsening flakes |

## 3. Issues, bugs, and backlog health

| Scenario | Monitor | Channel | Good defaults |
| --- | --- | --- | --- |
| Critical bug queue | Poll `gh issue list` for severity labels | `critical-bugs` | Persistent; user-owned monitor; notify on high-severity new issues |
| Untriaged issue queue | Poll issues with no assignee or no triage label | `triage-queue` | Persistent; delivery `all` if low volume, `important` if noisy |
| Stale backlog debt | Poll old issues or items untouched for 30+ days | `backlog-debt` | Persistent; notify only when stale items cross a threshold |
| Release blocker tracker | Poll blockers and post-mortem issues | `release-status` | Temporary per release, then archive; notify on open/closed transitions |
| Regression issue detector | Combine failing CI signals with issue creation | `regressions` | Temporary during active fire-fighting; model tunes the classifier aggressively |

## 4. Email, inboxes, and alert feeds

| Scenario | Monitor | Channel | Good defaults |
| --- | --- | --- | --- |
| Executive or escalation inbox | Poll IMAP or an email API through a script | `urgent-emails` | Persistent; user-controlled; notify on senders, subjects, or mailbox labels that matter |
| Personal inbox triage | Poll unread messages and normalize to one line per email | `inbox-digest` | Temporary first; broad include, then exclude newsletters and auto-replies |
| On-call alert bridge | Poll PagerDuty, Opsgenie, or similar | `oncall-alerts` | Persistent; notify on severity transitions; exclude maintenance-window noise |
| Mention aggregator | Poll Slack, Teams, GitHub, and email mentions into one stream | `mentions` | Temporary during focused work; notify only on direct, actionable mentions |
| Suspicious mail or phishing queue | Poll a mail security feed | `suspicious-mail` | Persistent and user-controlled; notify only on high-confidence signals |

## 5. Deployments, logs, and operations

| Scenario | Monitor | Channel | Good defaults |
| --- | --- | --- | --- |
| Kubernetes pod health | Run `kubectl get pods -w` or a poller | `k8s-health` | Persistent; notify on readiness failures and crash loops |
| Deployment rollout watcher | Monitor deploy script output or pipeline states | `deploy-ci` | Temporary during rollout; exclude info chatter quickly |
| Error-log tail | `tail -f` an error log or app log pipeline | `app-errors` | Temporary during incidents; start broad and tighten after first burst |
| DB lag or replica health | Poll replication lag or replica status | `db-replication` | Persistent; sparse stream; delivery can be `all` with notify on threshold breaches |
| Canary or rollback gate | Poll health endpoints or smoke checks | `health-gate` | Temporary; user-owned success criteria; notify on repeated failures only |

## 6. Local developer loops

| Scenario | Monitor | Channel | Good defaults |
| --- | --- | --- | --- |
| Local test watch | `jest --watch`, `vitest --watch`, etc. | `test-output` | Temporary; model-owned classifier okay; exclude timing and framework noise |
| Lint watch | `eslint --watch`, `ruff check --watch`, etc. | `lint` | Temporary; notify on errors; keep warnings in history if useful |
| Build watch | `npm run build -- --watch`, `cargo watch`, etc. | `build` | Temporary; exclude routine rebuild lines after first run |
| Integration harness | Run verbose integration suite or local environment harness | `integration` | Temporary; notify on failures and timeouts only |
| Multi-stream coding loop | Run tests, types, and lint in separate monitors | `types`, `lint`, `test-output` | Temporary; subscribe only to the most blocking stream |

## 7. Security and compliance

| Scenario | Monitor | Channel | Good defaults |
| --- | --- | --- | --- |
| Dependency vulnerability watch | Run `npm audit`, `pip-audit`, `cargo audit`, etc. | `deps-security` | Persistent; user-owned baseline; notify on high/critical or new CVEs |
| Secret scanning | Run `detect-secrets`, `trufflehog`, or a custom regex scanner | `secrets-scan` | Persistent; exclude known templates; notify on high-confidence leaks |
| License compliance drift | Run a license scanner | `license-compliance` | Persistent and user-controlled; notify only on banned or unknown licenses |
| Supply-chain verification | Poll signature/checksum verification output | `supply-chain-verify` | Persistent; notify on unsigned or mismatched artifacts |
| Policy audit stream | Run `checkov`, `tfsec`, `kube-bench`, SAST/DAST tools | `compliance-audit` | Persistent; keep full history; notify on critical failures only |

## 8. Support, customer feedback, and community

| Scenario | Monitor | Channel | Good defaults |
| --- | --- | --- | --- |
| Support backlog watcher | Poll a ticket API for open/SLA-breach tickets | `support-backlog` | Persistent; notify on SLA breaches and escalations only |
| Community signal monitor | Poll Discord, Slack, forums, or Reddit for keywords | `community-signals` | Start temporary; exclude jokes, bot chatter, and duplicate reposts |
| Feature request stream | Poll Discussions, forms, or webhook logs | `feature-requests` | Persistent; broad include, then exclude duplicates once the themes are known |
| Moderation queue | Poll flagged posts or moderation APIs | `moderation-queue` | Persistent and user-controlled; notify on severe content only |
| Incident communication queue | Poll support or community channels for outage chatter | `incident-comms` | Temporary during incidents; model tightens the classifier fast |

## 9. Research, docs, and knowledge monitoring

| Scenario | Monitor | Channel | Good defaults |
| --- | --- | --- | --- |
| Paper feed watcher | Poll arXiv or a research API | `research-feeds` | Persistent; broad include, notify on topics or authors that matter |
| Release-note tracker | Poll GitHub releases or changelog feeds | `releases` | Persistent; notify on breaking changes, deprecations, and security notes |
| Competitor news monitor | Poll blogs, RSS, or product feeds | `competitive-intel` | Persistent; exclude rumor/analysis posts after first week |
| Docs staleness detector | Scan docs by age or Git history | `doc-staleness` | Temporary during doc audits; notify on core docs only |
| Deadline and event calendar | Poll calendars or JSON feeds | `event-deadlines` | Persistent; notify only when deadlines are approaching |

## 10. Releases, scheduled jobs, and business processes

| Scenario | Monitor | Channel | Good defaults |
| --- | --- | --- | --- |
| Package publish watcher | Monitor `npm publish`, release scripts, or publishing logs | `publish-log` | Temporary on release day, then persist if recurring |
| Scheduled job health | Poll cron, DAG, or batch-job status | `jobs-status` | Persistent; notify on state transitions, not polling chatter |
| Data pipeline validation | Monitor ETL validator output | `data-pipeline` | Temporary for new pipelines, persistent for production checks |
| Artifact registry monitor | Poll for RCs or package versions in a registry | `release-artifacts` | Temporary during releases; notify on exact version matches |
| Reconciliation and finance checks | Poll reconciliation scripts or audit output | `reconciliation` | Persistent and user-controlled; notify on material mismatches only |

## How to decide temporary vs persistent

Choose **temporary** when:

- this is tied to one incident, one PR, or one debugging session
- you do not yet know the right classifier
- the stream shape is unknown and likely noisy
- the model should be free to tune things live
- the loop should stop when the current session ends

Choose **persistent** when:

- the same monitor is useful across sessions
- the command and thresholds are stable
- the rules encode team policy or operational practice
- the user wants the workflow to come back automatically

## How to split user control vs model control

Keep it **user-controlled** when:

- the monitor touches security, compliance, email, finance, or release gates
- the command embeds important org-specific assumptions
- the channel is now part of team workflow
- a mistaken change would create real risk

Let it be **model-controlled** when:

- this is a temporary investigative monitor
- the main problem is noise reduction, not policy
- the user wants the agent to learn what matters from the live stream
- classifier tuning is expected to change several times during one task

## Design tips

1. Prefer one concern per channel.
2. Normalize your monitor output so each line is meaningful.
3. Use `delivery="important"` for noisy streams and `delivery="all"` for sparse streams.
4. Exclude noise before narrowing inclusion.
5. If you are polling something repeatedly, prefer `every` over re-running it manually.
6. If you create the same monitor more than a few times, promote it to persistent config.
7. If the user cares about ownership, switch the persistent version to `managedBy="user"` after the workflow stabilizes.

## General SDK patterns worth borrowing

The official `@github/copilot-sdk` examples are useful even when a pattern is not specifically about channels or monitors. These are good extension ideas to combine with this repo's monitor model.

### 1. Log important extension state to the timeline

Use `session.log()` instead of `console.log()` to explain what the extension is doing:

- monitor started or stopped
- classifier updated
- config loaded
- retries or recoverable failures

Use `ephemeral: true` for noisy operational messages that should not stick around forever.

### 2. Use hooks to shape behavior around tool use

The SDK examples show several high-value hook patterns:

- `onUserPromptSubmitted` to add hidden context or trigger follow-up behavior
- `onPreToolUse` to deny risky commands or rewrite arguments
- `onPostToolUse` to add context after a tool finishes
- `onErrorOccurred` to retry, skip, or abort cleanly

For this repo, the natural extension is to combine hooks with channels:

- if a risky shell command appears, log it and post a note into an ops or audit channel
- after a code-edit tool runs, trigger a temporary build or lint monitor
- when a recurring failure happens, inject a short background follow-up with `session.send()`

### 3. Add custom helper tools next to the monitor tools

The official examples include simple tools that:

- run a shell command
- fetch data from an API
- copy text to the clipboard

That maps well to this repo. Good companion tools would be:

- `fetch_release_notes`
- `poll_ticket_queue_once`
- `summarize_channel`
- `snapshot_monitor_state`

Use monitors for ongoing signals and helper tools for one-shot actions.

### 4. React to session events, not just your own process output

The SDK examples show how to listen to session events such as:

- `tool.execution_start`
- `tool.execution_complete`
- `assistant.message`
- `session.idle`
- `session.error`

That is useful here even though monitors already push updates directly. Examples:

- start a temporary validation monitor after a build tool starts
- clear a transient classifier once the session goes idle
- attach extra context when a tool fails repeatedly
- mirror important lifecycle events into a channel for auditability

### 5. Watch files and workspace artifacts

The examples show `fs.watch` and `watchFile` patterns for:

- `plan.md`
- repo files edited manually by the user

That pairs well with this repo when a workflow mixes code changes and monitors:

- watch `plan.md` and post "plan changed" into a planning channel
- watch files under `logs/` and create a monitor automatically
- detect user edits to a config file and refresh the corresponding monitor

### 6. Use `session.send()` and `session.sendAndWait()` intentionally

Use:

- `session.send()` for fire-and-forget background nudges
- `session.sendAndWait()` only when the extension genuinely needs the agent's answer before continuing

For channel delivery, `session.send()` is usually the right fit. For a helper flow like "fetch data, then ask the agent to summarize it before updating config", `sendAndWait()` can make sense.

### 7. Build permission and user-input workflows into the extension

The SDK examples also show:

- custom permission logic via `onPermissionRequest`
- user questions via `onUserInputRequest`

These are powerful in this repo for guarded workflows:

- ask before persisting a new monitor
- deny destructive shell commands from helper tools
- request confirmation before overriding a user-controlled classifier
- collect thresholds or keywords interactively instead of hardcoding them

### 8. Keep it cross-platform

The examples call out Windows-specific concerns:

- detect Windows with `process.platform === "win32"`
- prefer the right shell and stderr redirection syntax
- use Windows-safe process launching

That is especially relevant here because monitors are shell-driven and this repo is intended to be copied into real projects on different operating systems.
