# Claude-B operations and release acceptance

## Validate isolated source and artifacts

Use supported Node.js 22 for new installations. CI also tests Node.js 20 for
compatibility. Never build in a directory referenced by a running service: the
build cleans `dist/`. Use a separate checkout or staged snapshot with its own
output directory and dependency installation.

```bash
npm ci
npm run typecheck
npm run lint
npm test
CB_NATIVE_TMUX=1 npm test -- src/tmux/native.test.ts
npm run build
npm run check:artifact
```

`npm test` runs once; `npm run test:watch` watches. Unit/integration tests isolate
state and homedir, substitute a deterministic Claude executable, suppress desktop
notifications, and reject external fetches. REST fixtures bind random loopback
ports. Native tmux tests are optional locally and required by CI: every command
uses its own random `tmux -L` namespace, creates only fixture processes and kills
only that private server. They exercise terminal transport and pane recycling,
not a live paid agent account.

`check:artifact` inspects `npm pack --dry-run`, enforces the package allowlist,
checks built CLI help/version/logs/stdin behavior, then starts the actual built
candidate daemon with disposable state, HOME and a fake Claude executable. Its
minimal environment inherits no provider, bot or registry credentials. Acceptance
covers IPC and REST task submission/result/cancellation, caller cwd and execution
policy, successful CLI termination, atomic result persistence, graceful shutdown,
crash recovery with verified orphan termination and no replay, durable webhook
delivery after restart, and a stopped-state backup/restore boot rehearsal. Local
recording receivers stay on random loopback ports. Cleanup is restricted to the
candidate's own processes and trace-verified fixture process groups.

The validation workflow runs Ubuntu with Node.js 20/22 and macOS with Node.js 22.
Release jobs depend on exact-source validation before publishing. Manual release
runs default to dry-run; tag publication remains an explicit operator action.
No local validation command publishes a package/image or touches a host daemon.
Successful built acceptance emits versioned JSON with artifact SHA-256 hashes,
Node/platform and explicit outcomes. Set `CB_ACCEPTANCE_PROOF` to save that
non-secret proof outside the disposable fixture state. A configured CI job is
not evidence of a completed CI run; retain its actual result link for a release
decision.

## Task state, results and cancellation

`CB_DATA_DIR` selects private state for both CLI and daemon. Relative and `~/`
paths are resolved by the caller; services should use explicit absolute paths.
Daemon ownership files and its socket are owner-only. Startup fails closed for
malformed ownership files, a live owner, an active unidentified socket or an
unresolved recovery guard. Inspect those files as the owner rather than deleting
them while another process may be running.

Each accepted task has an immutable ID and submission metadata. Task receipts
under `tasks/` use flushed atomic writes. Pending/running work becomes
`interrupted` after an abrupt daemon restart and is never automatically executed
again. Graceful shutdown cancels active and queued work before releasing its
socket. Obtain the original task receipt before deciding whether an uncertain
remote submission needs another attempt; reuse its idempotency key instead of
creating duplicate work.

Use `cb --tasks`, `cb --task <id>` and `cb --cancel <id>` for task control.
The authenticated REST equivalents are `POST /api/tasks` (HTTP 202 acceptance),
`GET /api/tasks/:id`, and `POST /api/tasks/:id/cancel`. Acceptance is separate
from completion. A stored terminal result remains addressable after session
cleanup and daemon restart. Invalid state is preserved and reported instead of
silently replacing it with an empty index.

The default execution policy keeps Claude's normal permissions. Bypass requires
an explicit policy selection for the intended session; task receipts retain the
policy used. A policy change is rejected while tasks/submissions are pending.
Caller repository identity is carried with submissions; an existing session from
another directory is not silently reused as the target.

## Notification delivery

`POST /api/notify` requires loopback plus the REST API key in `x-claude-b-key`.
Accepted events reach the durable outbox independently of Telegram availability.
Versioned outbox records retain stable event IDs/timestamps and disjoint
per-channel delivered, skipped and failed ledgers. Transient failures retry after
restart with a default budget of eight failed operational attempts per channel;
permanent failures and exhausted budgets remain in the failed ledger without
automatic replay. Shutdown aborts do not consume that retry budget. Invalid or
unknown receipt versions are preserved and reported. Delivery is at least once:
receivers must verify
webhook signatures and deduplicate event IDs as documented in README. Inbox
persistence deduplicates stable delivery IDs. Intentionally unconfigured optional
channels are skipped; configured unavailable channels retain retryable work.

Telegram pairing is private and owner-authorized. Message/session/result/pending
maps use chat plus message identity. Historical bare-ID notifications cannot be
assigned safely to an owner and are no longer reply/Listen targets. Pane routing
uses stable pane/process identity; changed or missing panes reject delivery.
Transcript fixtures cover native text envelopes without tool-result wrappers.
Never run two Telegram pollers for the same bot during acceptance or handover.

## Capture and deploy an immutable release

Record source commit, Node/npm versions, lockfile, build/test/native/artifact/CI
results and artifact hashes. Keep the current immutable release and compatible
private state backup for rollback. Historical blueprint candidate reports prove
only those candidates; verify that each change exists in the release source.

State includes credentials, session histories, task output, outbox payloads and
Telegram configuration. Back it up with owner-only access and restore permissions
before starting a candidate. Do not include real state, `.env`, `.npmrc`, logs,
keys or private fixtures in artifacts or public issues. A separate clone alone
does not isolate runtime state; always set its `CB_DATA_DIR`.

Before an actual deployment, identify the service/UID/launcher/state/proxy,
workspace ownership, active jobs and sole bot poller. Select the immutable
published version/digest and verify registry permissions. Test copied-state
adoption and rollback, dashboard compatibility and operator-specific access.
Dedicated Telegram/provider acceptance needs authorized accounts, capabilities,
charge budgets and retention decisions. Local fakes and terminal fixtures do not
prove those external entitlements.

Schedule the operator's actual service/poller handover only after that evidence
is available. Verify health, correct workspace/owner, retained receipts and
notification delivery; roll back to the recorded executable and compatible
snapshot if acceptance fails. Source validation does not authorize or perform a
production restart, credential rotation, provider charge or registry publication.
