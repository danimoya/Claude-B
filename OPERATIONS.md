# Claude-B operations and release acceptance

## Validate an isolated checkout

Use Node.js 20 or 22. Do not build in a directory referenced by a running
service: the build cleans `dist/` before writing its output. Use a separate
checkout or staged snapshot, with its own output directory.

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run check:artifact
```

`npm test` runs once. `npm run test:watch` starts watch mode. Tests substitute
a deterministic local Claude executable, use disposable state and homedir
values, suppress desktop notifications, and reject non-loopback `fetch`
requests. REST integration tests bind to random loopback ports. Tests do not
prove real provider access, Telegram delivery, or native tmux behavior.

Artifact checks inspect `npm pack --dry-run` without publishing, validate the
package allowlist, check daemon JavaScript syntax, and execute CLI help/version
with a disposable `CB_DATA_DIR`. They never start a daemon or send a prompt.
The validation workflow runs these checks on Node.js 20 and 22; it does not
publish an npm package or container image.

## Capture a release candidate

Record the source commit, Node/npm versions, lockfile, build/test output and
artifact hashes outside the running installation. Keep the current immutable
release and state backup available for rollback. Treat historical blueprint
candidate reports as evidence for those candidates, not proof that the same
changes are present on `main`.

`CB_DATA_DIR` selects state for the CLI and daemon. Use an absolute path. State
contains credentials, session histories, notification content and Telegram
configuration; back it up with owner-only access. Do not copy live credentials
into fixtures, PRs or build artifacts. A clone alone does not isolate state if
the CLI or daemon falls back to the operator's default state directory.

## Gates before an operator-approved deployment

1. Identify each real service, UID, launcher, immutable executable path, state
   directory, REST/proxy path, workspace ownership and active job. Confirm
   which process is the sole Telegram poller for each bot. Record metadata
   without printing credentials or private histories.
2. Select the exact release version and registry destination, confirm publish
   permissions, and verify the built artifact against the recorded commit.
3. Test migration, state adoption and rollback using copies of state with
   private values removed. Preserve active jobs and result receipts; avoid
   replaying uncertain remote submissions.
4. Use a dedicated authorized Telegram bot/provider account for live acceptance.
   Confirm provider capabilities, charge budget and data retention first. Use
   native Claude/Codex/OpenCode tmux fixtures and a macOS runner for platform
   claims. Validate dashboard compatibility separately.
5. Schedule the actual service/poller handover with the operator. Verify health,
   owner/workspace identity, state preservation and notification delivery.
   Roll back to the recorded executable and compatible state snapshot if
   acceptance fails; do not run two pollers during rollback.

Local unit/integration checks do not satisfy these deployment gates. No service
restart, configuration migration, credential rotation, provider charge or
publication is implied by a successful local validation.

## Diagnosing notification delivery

`POST /api/notify` requires a loopback caller and the current REST API key in
`x-claude-b-key`. Accepted completion/error events go to the inbox and matching
hooks independently of Telegram availability. Delivery errors are logged per
channel. Webhook receivers should verify signatures and deduplicate event IDs
as documented in the README. The current retry queue is in memory; a daemon
restart can lose pending deliveries, so durable delivery requires separate work.

Inspect logs under the selected state directory without copying tokens or
private notification text into public issues. Check hook registration, event
and session filters, receiver status codes, Telegram configuration and sole
poller ownership before changing a running service. Use copied transcripts for
context parsing diagnostics; a cold in-memory transcript cache is expected
until the first notification after daemon startup.
