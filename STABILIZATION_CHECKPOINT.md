# DevSpace Ultra v0.5.8 stabilization — 2026-09-20

## Non-negotiable operating state

Keep package version 0.5.8. Auto Compact remains off. Do not disable Goal,
Plan, narration, Rescue, Context Guardian, capabilities or worker support to
make a test pass. Do not navigate or restart other Main/Blender processes.
Do not publish or overwrite the v0.5.8 tag. Use the current registered workspace.

## What is verified, rather than inferred

- The September 20 investigation reproduced two MCP `Connection failed`
  responses on read-only calls. The service then recovered without restart.
- Core PID 43592 remained alive with more than 18 hours uptime. These failures
  do not establish a Core crash or identify the upstream network fault.
- One progress bridge call returned `TimeoutError`, but its exact report was
  persisted at 2026-09-20T08:45:14.585Z. Never replay mutations solely because
  an acknowledgement timed out. Read back the postcondition first.
- The same chat is displayed by Main-01 and Main-02. A fresh opaque progress
  claim was present only in Main-02, and the combined resolver returned that
  exact page correctly. Duplicate displays alone are not a proven root cause.
- Normal progress reports subsequently persisted successfully, while both
  actual floating cards still displayed the older bridge report. A later
  bridge report changed both cards. Persistence and `mounted=true` are NOT
  sufficient UI acceptance. The live projector's old proof filtering/loaded
  state needs deployment-time diagnosis and exact text readback.
- Native tool invocation correlation was still zero. Do not report native
  authority or all cross-turn Goal/Rescue behavior as production-validated.
- The attempted Plan bootstrap returned pending; no Plan ID was confirmed.
  Do not reuse unrelated Plan/Goal IDs from earlier conversations.

## Code safety corrections

The previous cached-schema bootstrap trusted short-lived session affinity.
Five additional executable regressions failed on that implementation: a
different request sharing a session could inherit an owner, absent current
page evidence was accepted, stale/unverified evidence could be refreshed,
duplicate claims replenished grants, and expiry during verification was not
checked. The corrected path requires a current request trace, the original
opaque progress claim on its live parent page, fresh evidence, and one atomic
post-verification consumption. It does not change public tool schemas.

The unreviewed automatic iframe cleanup was preserved in git stash under
`rescue-unreviewed-relay-cleanup-20260920`, not deployed. It omitted claiming
records and all but the first 32 pending records, and lacked passive-Core
protection. Do not apply that stash wholesale.

## Reproducible acceptance and interruption recovery

`node scripts/devspace-stability-run.mjs run` creates one audit id immediately,
stores bounded logs plus atomic state in the system temporary directory, and
runs `npm run verify:ultra` once. Read its status after an interrupted tool
response; do not start a duplicate suite. It never reloads production.

First full audit id: `ffe25343-7848-4991-acd2-7322cc9abfaa`.
Result: exit 0, 162 distinct named gates, 2026-09-20T09:01:20.438Z.
This covered the bootstrap fix before the subsequent projection diagnostic
and probe refinements. A final revision-specific audit is still required.

`node scripts/devspace-stability-probe.mjs --conversation-id <exact-id> --needle <own-report-marker>`
compares persistence with real rendered text and ownership in every matching
open display. Exit 2 means card acceptance failed despite healthy endpoints.
The probe does not click, type, reload, navigate or stop an application.

Before deployment, commit the reviewed files and finish all regressions.
Use `reload:fixed-backend` only at its quiet boundary without allowing schema
changes. Record the returned handover id and inspect its final result. A
pending handover is not success and is not permission to kill active work.

## Remaining product-level work

### Latest deployed checkpoint (supersedes earlier pending-deployment notes)

- Deployed code: `6dfd5683699efad6f83bdc7d17aff8d31924c3a9`, following
  `616c4cb5c56cbdaea43c99209a28ebe8357cbab4`; package remains 0.5.8.
- Final code audit: `81286203-bd16-4655-85a7-52cc1271b03a`, exit 0,
  162 named gates, completed 2026-09-20T09:15:46.087Z. It includes the new
  bootstrap and real HTTP lifecycle tests through the full suite.
- Quiet handover `7d8802a1-60b5-4d16-8f7c-9f77f892848c` completed at
  09:16:54.937Z. Active Core is 36960, slot b; Gateway stayed running.
  Schema unchanged, no fresh initialize required, no rollback. Two sessions
  replayed and ONE did not replay. Its cause/impact is not yet established;
  never summarize this handover as zero dropped sessions.
- Normal progress marker `POST-HANDOVER` persisted at 09:17:49.553Z and was
  confirmed in actual visible text in both exact matching Main displays.
  `cardAcceptancePassed=true`, not merely `mounted=true`.
- Current persistent Goal: `goal_9ddde493694349b9`, exact conversation
  `6aacf595-b3d0-83ee-a31f-043786b41e85`, created via ordinary MCP start
  at 09:18:14.555Z. Keep it active pending further end-to-end verification.
- Current round Plan: `plan_54f8742f1566f14b`, same conversation, created
  09:19:56.507Z. One earlier expired-preflight start was pending; a readback
  established there was no active Plan before the successful retry. Do not
  reuse this Plan after it becomes completed.
- Read-only Blender inventory still reports three online runtimes:
  production 9879/PID17000, bust QA 9880/PID19444, unseen-body 9881/PID33232.
  The old offline registry records were not started, stopped or deleted.
- Auto Compact remains OFF; Goal Recovery, progress/liveness, Context
  Guardian, Host Overlay, Stream Recovery, plugins, skills and artifacts
  remain enabled. Nothing was published or pushed.

Remaining: actual next-round Goal continuation and isolated Rescue behavior;
native request-correlation still reports zero; characterize the one unreplayed
session and intermittent upstream Connection failed/TimeoutError. Do not
disable safeguards or reintroduce session-only authority to make these pass.

### Confirmed display root cause, 2026-09-20T09:11Z

An additional orphan process PID 32416 ran the exact relative command
`node dist/cli.js serve` with cwd equal to this DevSpace installation.
It had no listening socket, no living parent, no child process, and 22 active
CDP connections to Main pages. A process search restricted to absolute
`devspace` command-line paths or listening port 7676 missed it. Its old
projector continuously held the priority-100 lease and accepted bridge
reports but not newer claim proofs.

After rechecking its creation time, cwd, exact command, parent, children,
listeners and exclusion from the live Gateway's active Core PID, only that
orphan was terminated. Official Core 43592 and Gateway 40548 stayed running;
no Main or Blender was stopped. A normal `devspace_progress_report` then
persisted at 09:11:40.288Z and rendered the `ORPHAN-CLEARED` marker in BOTH
matching displays. Their producer changed from `c9061953-...` to
`60882623-...`. This is real UI evidence of the orphan projector conflict,
not just a unit-test inference. It does not prove the upstream MCP transport
outage had the same cause.

Prevention patch: bind each CLI/server HTTP listener's close/error to its
own idempotent runtime cleanup; stop claim sweeps before store/transport
shutdown; suppress those sweeps entirely in passive candidate Cores.
No sweep may write after shutdown while an asynchronous page check finishes.

Revision 616c4cb audit `06033506-b4dd-4b25-bd69-8f7f948b261a` completed with
exit 0 and 162 named gates. The subsequent lifecycle patch needs its own
final audit and controlled production handover.

Verify normal narration through the actual visible card after controlled
deployment. Verify Goal/Plan exact start and continuation in the current chat,
then independent Rescue timing and cancellation in an isolated canary. The
full feature suite covers capabilities, Blender isolation, Computer Use,
workers, memory/logging, setup, Gateway sessions and transport regressions;
it does not imply that every production UI path has received a live test.
Investigate persistent upstream delivery failures using timestamps and
endpoint evidence rather than reducing safeguards or reenabling Auto Compact.
