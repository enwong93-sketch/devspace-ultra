# DevSpace Ultra v0.5.8 security and stability audit — 2026-09-21

This record separates reproduced findings, completed fixes, regression-only
evidence and still-open live boundaries. It contains no credentials or raw
conversation content. Package version and the user's production feature set
remain v0.5.8; Auto Compact remains disabled.

## Reproduced findings and corrections

### 1. Private owner credential inherited a sandbox-readable ACL

`auth.json` contains one non-empty `ownerToken` field. Before remediation its
Windows ACL inherited `ReadAndExecute` for `CodexSandboxUsers`. No raw token was
read into this audit output. The file was hardened immediately to mode 0600 and
an inheritance-free Windows ACL granting Full Control only to the current user,
SYSTEM and Administrators. A post-change `icacls` audit confirms inheritance is
removed and no broad sandbox read remains.

`writeDevspaceAuth()` now applies the same fail-closed hardening on every write.
The implementation has injected Windows/POSIX unit tests and a repeatable
operator command: `node scripts/harden-devspace-auth.mjs`.

### 2. Production dependency advisories were hidden by the default mirror

The configured `npmmirror.com` registry does not implement npm's audit endpoint
and returned HTTP 404. An explicit official-registry audit found two high and
two moderate production findings under shrinkwrapped
`@earendil-works/pi-coding-agent@0.80.10`: affected `undici@8.5.0`,
`protobufjs@7.6.4` and `brace-expansion@5.0.6`.

Top-level overrides could not replace those shrinkwrapped dependencies. The
reviewed package is now installed under the explicit alias
`@devspace/pi-coding-agent` at exact upstream version 0.86.1; the four DevSpace
imports use that alias. Actual installed versions are `undici@8.10.2`,
`protobufjs@7.6.6` and `brace-expansion@5.0.9`. Required ten exported APIs were
present and setup/capability/toolchain/workspace-memory suites passed. Official
npm audit now reports zero production and zero all-dependency vulnerabilities.

The deterministic `verify:security` gate pins these fix boundaries and never
uses network or lifecycle scripts. Installation used `--ignore-scripts`.
Because the old live Core had loaded a native clipboard DLL, npm could not
remove one old temporary package directory; it is not in package resolution and
must be deleted only after the old Core exits during the verified handover.

### 3. Handover labelled recoverable replay failures as permanent drops

Non-schema replay failures invalidated only the backend mapping and deliberately
kept the public descriptor for lazy resurrection on the next request, but the
operator result counted them as `droppedSessions`. This made availability
reports misleading and obscured real schema incompatibility.

Handover/recovery results now distinguish:

- `droppedSessions`: descriptor removed because its model/tool schema is stale;
- `deferredSessions`: descriptor retained, mapping cleared, next real request
  supplies current Authorization and performs lazy recovery;
- `replayFailureReasons`: bounded sanitized reason counts, never credentials or
  raw backend responses.

Proxy, controller, handover and schema-change tests cover both paths. Current
persisted session descriptors also have a hard cap of 512 and collapse older
entries with the same client fingerprint, preserving the newest descriptor.
The pre-fix production file held 111 descriptors, including 66 older than three
days; this was not yet an outage, but it demonstrated the absence of a durable
bound.

### 4. Repository and runtime secret leakage scan

A high-confidence tracked-file scan checks private-key blocks and common OpenAI,
GitHub, AWS and Slack token shapes without returning values. It scanned 864
tracked text files. Two fixed hashes are reviewed synthetic fixtures: one
redaction test and one generated syntax-highlighting asset. No unreviewed secret
candidate remains.

A separate runtime scan covered 752 bounded files under configured logs and
state. It found no Bearer token, owner-token assignment or JWT-shaped value.
Run it with `npm run audit:runtime-secrets`; it returns file/pattern counts only.

### 5. Startup and process inventory

Listeners 7678/7688 and all managed ChatGPT debugging ports are bound to
127.0.0.1. No listener exists on retired port 7676. Process inventory showed
one fixed-backend supervisor, one Gateway and one active Core; no second
`dist/cli.js serve` orphan was present.

Scheduled Task inspection found no 7676 or standalone legacy `cli.js serve`
action. Canonical startup, Stable Gateway, local ingress and identity-healing
tasks remain. Both Canonical Startup and Stable Gateway have logon triggers;
Stable Gateway uses `IgnoreNew`, and Canonical Startup calls that same task.
The Stable Gateway task has an old non-zero LastTaskResult, but current runtime
and listeners are healthy. This audit does not disable either task without a
fresh reproduced duplicate-start failure.

Package root, `dist`, `scripts` and package.json have no broad group write ACE.
Config/state metadata remains readable according to its existing policy; only
the owner credential file was changed because it contains the owner secret.

## Verification completed before final deployment

- Official npm audit, production and all dependencies: 0 findings.
- `verify:security`: dependency boundaries, private ACL tests, repository secret
  scan.
- `verify:setup`, `verify:capabilities`, `verify:toolchain`,
  `verify:workspace-memory`.
- Stable Gateway descriptor, proxy, controller, handover, rollback, degraded
  startup and static gates.
- Session replay tests prove transport/Core failures defer rather than falsely
  report permanent loss; schema drift still removes the stale session.

A final revision-specific `verify:ultra`, verified schema-unchanged handover and
post-handover visible narration/Goal/Plan checks are still required after this
record is committed. Do not treat this document alone as deployment evidence.

## Deliberately open boundaries

- Native UI invocation correlation counters remain zero in this Pro/background
  path. Admitted substantive DevSpace tools still update the exact
  conversation's Rescue activity timestamp. This is not proof of native UI
  transport correlation.
- No artificial twenty-minute interruption will be inflicted on the user's
  working chat merely to force Rescue. Pause/cancel/timeout/clock logic remains
  covered by deterministic and isolated gates; a future natural interruption
  can provide production evidence.
- The existing Goal remains active. Its current round must be reported only
  after the final deployment and evidence readback. `devspace_goal_turn_report`
  remains the last tool of that turn.
- No package is published and no remote branch is pushed by this audit.
