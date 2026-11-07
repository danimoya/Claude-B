# Queued blueprint source and isolated rollout acceptance

Sprinter: `7282b1a4de74`. Associated GitHub issue: none.

The CB-01 through CB-10 source changes are implemented in the canonical
repository and recorded in their individual backlog documents. The branch also
provides executable isolated acceptance and rollback rehearsal; actual live
cutover remains outside this request because production configuration, services,
credentials and the running daemon must remain untouched.

The built artifact acceptance command starts only candidate processes under new
temporary state and repositories, with a fake Claude executable and no inherited
provider or bot credentials. It exercises real IPC, REST, CLI, task receipts,
cancellation, delivery retry and crash recovery. The recovery check verifies that
a traced private executor no longer runs after the restarted daemon becomes
ready, and that interrupted work was not automatically executed again.

Rollback is a concrete filesystem and boot rehearsal. After stopping the isolated
candidate, the harness copies its private state, deliberately changes one
fixture receipt, restores the stopped-state backup and starts the candidate
against that restored state. It then verifies the original exact result,
preserved delivery identity and unchanged execution count before shutting down.
Only fixture-generated credentials and data are copied; every temporary state
copy and candidate process is cleaned up afterward.

Successful acceptance emits versioned proof JSON containing Node/platform,
SHA-256 hashes for all built artifacts, task/outbox/recovery/rollback outcomes
and explicit statements that no live service, external provider or publication
was changed. `CB_ACCEPTANCE_PROOF` optionally writes that receipt to a selected
file. Retain the proof with the exact source commit and actual CI result links.
The committed [isolated acceptance proof](evidence/isolated-acceptance-2026-11-07.json)
records the actual validated runtime artifact hashes and outcomes. Those hashes
match the independent complete-source build and staged release validation.
The [container acceptance proof](evidence/container-acceptance-2026-11-07.json)
records the final local image ID, verified non-root process inspection/native PTY,
exact task persistence and three-host Compose checks. No image was published.
The proof demonstrates that candidate's source and isolated runtime behavior;
it does not imply activation of an installed candidate or an existing registry
tag.

An actual cutover still requires operator identification of each host's service,
UID, immutable executable, state/workspace, active task, REST/proxy contract and
sole Telegram poller. Verify the selected published digest, registry permissions,
real dashboard compatibility and dedicated account entitlements, retention and
charge limits before scheduling handover. Preserve uncertain remote task
receipts without resubmitting work. OPERATIONS.md records the deployment and
rollback procedure.

No production restart, poller handover, credential rotation/copy, live message,
provider charge or publication is performed by these source or isolated tests.
The executing checkout's `dist` output is not used as a build destination.
