# DevSpace Ultra v0.5.8 stabilization — 2026-09-20

## Round 2: Goal continuation closure (latest work)

### Deployment preflight uncovered a Gateway authorization defect

Core-only handover `185a9b6b-63d0-4e2a-9639-5cb35b9e0cb7` failed safely at
13:35:26Z: all three retained authorizations were rejected by schema probes,
while ordinary MCP tools still worked. No replacement Core was promoted.
Inspection found that the Gateway updated retained session authorization
BEFORE Core accepted the incoming request. An actual HTTP regression with a
401-rejected fake token reproduced replacement of the previously valid token.
The proxy now updates replay authorization only after Core returns 2xx.
The same test verifies a valid token refresh is retained and replay succeeds.
This is a demonstrated defect; the identities of historical failing callers
or the earlier one-session replay error have not been guessed.

This fix requires loading the Gateway, not merely a Core handover. The
canonical whole-restart helper was strengthened to wait for three quiet
observations (no active requests or activities), recheck exact process
creation identities immediately before stopping, and verify Core readiness
as well as Gateway readiness afterwards. A bounded PRE-stop quiet timeout
cancels without touching work; startup itself still has no kill deadline.
Main/Blender processes are never in its targeted PID list. A zero-listener
cold start remains supported. All changes require a final audit before that
single controlled Gateway/Core replacement.

The final process safety probe found the existing Job contains Gateway,
Core and all three Blender PIDs, with limitFlags=0 (no kill-on-job-close).
Therefore the original Stop-ScheduledTask method MUST NOT be used. The
canonical replacement helper now leaves the Job and task untouched, waits
for quiet, rechecks creation identities, stops ONLY the exact Gateway/Core
PIDs and starts the unchanged canonical launcher directly. Its helper is a
detached process in the surviving Job, not another Task Scheduler kill scope.
It refuses replacement unless the Job-limit probe succeeds and confirms
kill-on-job-close is false. The generated PowerShell is syntax-checked by the
real PowerShell parser in regression tests. No production change has been
performed by these probes or tests.

The user asked to finish stabilization, explicitly prioritizing Goal Mode.
The real Goal was still round 1 / reported / continuation pending more than
three hours after its final response. It was manually redeemed into round 2
at 12:51:30Z; that manual redemption is NOT automatic-continuation evidence.

Confirmed defects and narrow fixes:

- Normal Goal continuation previously depended entirely on the hidden relay
  App calling an app-only tool. Missing/hung Apps left it pending forever.
  A singleton, passive-aware backend supervisor now captures the report's
  source user message, waits for a NEW visible final with native completion,
  obtains an exclusive runtime lease, journals before sending one minimal
  `- 繼續`, verifies it on-page, then redeems the next working round. Existing
  app dispatch delegates to the same owner rather than creating another send.
- The old visible-report gate accepted the previous assistant text while the
  newest message was a user request. It now requires an assistant final.
- A single conversation shown in two windows is not two conversation owners.
  Exact opaque claims now collapse identical conversation ownership while
  checking EVERY batch, exact https://chatgpt.com host and refreshed parent
  routes. Different conversation IDs still fail closed.
- The two current displays have different visible user boundaries: Main-01
  is stale, Main-02 owns the current request. A recently revalidated opaque
  progress receipt plus the current request trace may therefore locate the
  report's actual page. Without that proof, conflicting displays remain
  unarmed; the driver never picks a conversation merely by activity/runtime.
- The canary composer retained an app mention pill. Previously this looked
  like user draft text and blocked sending. A DOM-copy text extractor ignores
  ONLY recognized plugin mention pills, keeps genuine text/attachments
  protected, preserves the actual mention, and places inserted text at the
  editor end. The final click rechecks route, source turn and exact inserted
  text. A lost click acknowledgement is never labeled safe-to-retry.
- An uncertain send is durably quarantined across restart and can only be
  reconciled from the exact source-user -> final-assistant -> next-control-user
  message sequence, without sending again. Pause/stop/new human input wins.

Real isolated acceptance:

- Used only the pre-existing Main-06 canary
  `6aacc828-96f0-83e8-b368-a550e2c8ae27`, after verifying idle CANARY_READY and
  no user draft. No production Goal store, other Main, Blender, setting or
  navigation was changed by the harness.
- `scripts/goal-continuation-canary.mjs --execute` passed at 13:13:42.212Z,
  with exactly one visible control send and the isolated Goal at round 2 /
  working. Result is in the system Temp folder
  `devspace-goal-continuation-canary-xagu0k/result.json`.
- Subsequently the canary produced an actual new assistant final
  `2fa0149c-acb4-48b3-a728-162d7397abfd`. Its existing production Rescue
  record was completed/armed=false at 13:16:17Z. The canary did not modify
  global settings; it reported Auto Compact correctly still disabled.
- This proves the real composer/send/resume path and normal-completion
  disarm. The own-production Goal report -> automatic next assistant turn
  must still be checked AFTER the upcoming controlled deployment/final.

New modules: `goal-continuation-supervisor.js`, `classic-composer-draft.js`.
The progress relay had an additional lifetime mismatch: it closed on success
or only 1.2s after failed host calls, even though backend scans could take
longer and the next Goal/Plan tool must revalidate the same receipt. It now
retains the invisible receipt only until its declared two-minute expiry, with
cleanup scheduled independently of a hung host call. Two executable HTML/VM
regressions failed before the fix and pass after it. No message is authored
by that cleanup timer and no unrelated iframe is closed.
New tests cover source final gating, stale/multiple displays, pause races,
restart, lost acknowledgements, single-send transport, draft protection and
actual report/app production wiring; they are included in verify:goal.
Preliminary full audit `ebd79d43-73f1-443a-be77-992071248272` passed 162 named
gates. Later refinements require a final committed-revision audit.

Historical one-session replay failure has no surviving reason in the bounded
logs inspected. Existing replay/lazy-resurrection/no-5xx-replay tests pass.
Do not invent its cause or restart Gateway just to add diagnostic fields.
The temporary Gateway-only diagnostics experiment was reverted; no such
Gateway change is part of this Core-only deployment.

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
