# DevSpace Ultra v0.5.8 stabilization — 2026-09-20

## Round 3: complete control-plane loss and survivability — 2026-09-23

### Incident evidence and recovery

- Incident capture: `C:\Users\enwong\Desktop\devspace-recovery-20260923-053541`.
  The captured process list contained no DevSpace fixed-backend launcher,
  Stable Gateway or Core, and ports 7678/7688/7689 had no listener. This was a
  complete backend-process loss, not merely a stale narration overlay.
- No Windows Resource-Exhaustion Event 2004 or Node heap/OOM crash was found in
  the captured hour. A group of WER LiveKernelEvent 141 records appeared around
  05:21 HKT, consistent with a GPU/display timeout, but DevSpace's prior Core
  log stopped around 04:22. CPU/GPU pressure remains a plausible environment
  stressor, NOT a proven cause of the earlier DevSpace disappearance.
- The old whole-restart executable failed before any mutation because it
  required breakaway permission even when ZERO Gateway/Core listeners existed.
  It correctly stopped no process, but consequently could not cold-start a
  fully dead backend.
- The canonical `DevSpace-Stable-Gateway` Scheduled Task restored production at
  05:44 HKT. Verified state: Gateway 7678/PID 64248, sole Core 7688/PID 804,
  Gateway active PID 804, fatal=false, admission open, active/queued requests
  0/0, retired 7676/7677 absent. No Main or Blender was stopped; Blender PID
  17000 remained alive.

### Demonstrated product defects and fixes

1. **Dead-backend cold start.** Commit `2f6fd95` classifies an empty listener
   topology before the Windows Job breakaway probe. `--preflight-only` now
   proves a zero-mutation cold start; `--execute` starts the canonical Scheduled
   Task and requires Gateway health plus exactly one Core whose listener PID
   matches `/__devspace/memory/status`. Orphan-Core and invalid topologies still
   fail closed. An isolated alternate-port preflight returned
   `cold-start-preflight-verified`, breakawayRequired=false, stoppedPids=0 and
   created no listener.
2. **Launcher supervision.** The foreground fixed-backend launcher now treats
   any disappeared Gateway as failure even when the child reports exit code 0,
   allowing Task Scheduler restart. A real competing healthy Gateway is the
   only accepted zero-exit race. The exit listener is installed immediately so
   a fast child failure cannot be missed.
3. **CPU-saturation scheduling.** The Task and launcher/Core are Normal; the
   small Gateway control plane is AboveNormal. High and Realtime are prohibited.
   The running processes were changed in place without a restart: launcher
   65716 BelowNormal->Normal, Gateway 64248 BelowNormal->AboveNormal, Core 804
   BelowNormal->Normal.
4. **Persistent restart policy.** The main Task now has restartCount=999,
   interval=PT1M, MultipleInstances=IgnoreNew, Priority=4, no execution limit.
   Commit `4b36a38` adds a separate one-minute watchdog Task instead of
   repeatedly triggering the healthy long-running Task. The watchdog only
   starts the main Task when health is down and it is not already running; it
   never stops a running process tree. A real watchdog run returned 0 while
   Gateway/Core PIDs remained unchanged and health stayed true.

### Acceptance

- Focused Stable Gateway, Goal, Rescue/liveness and Classic safety suites pass.
- Clean-revision full audit `87365529-fc2e-45a4-b5b6-b736430ead78` on
  `4b36a38e5b801b91d41f1f1e4cba892ff39ea1c5` passed 174 named gates, exit 0,
  with an empty tracked diff.
- The exact conversation progress marker was persisted and read from the real
  floating card (`cardAcceptancePassed=true`); all five observed Main runtimes
  were connected/synced, including Main-05 on its observed port 19735.
- Production remains package 0.5.8 and Auto Compact remains OFF. Goal/Plan,
  Rescue, Context Guardian, Host Overlay and Stream Recovery state was retained.

### Boundary

The live production backend was recovered manually through the canonical Task
before this source fix. The new no-listener `--execute` branch was not tested by
deliberately destroying production again; its isolated no-mutation preflight,
the same canonical Task start path, exhaustive tests and the actual manual Task
recovery are the current evidence. Do not state that CPU, OOM or LiveKernelEvent
141 definitely caused the outage without a future process-exit/resource event.

## Round 3: long-run Goal/Rescue compatibility — 2026-09-22

### Deployed revision and exact acceptance

- Product revision: `d2eb86e4b4a4e3d83ca8a3ef7f14248e421bc81f`
  (`fix: sustain Goal and Rescue across long runs`). Package remains `0.5.8`.
- Clean-revision full audit: `32866092-d48f-469d-8ee8-7966033740b4`,
  exit `0`, 169 named gates, completed 2026-09-22T15:12:38Z.
- Normal compatible handover `5ceb819d-a350-4f77-b48a-969920312ff3`
  failed closed at candidate schema. No Core was promoted by that attempt.
- The passive candidate fingerprint was independently measured as
  `e450ec8cc5190bbf20327225a432a680408521d8ffcc7455805669428fb629c8`;
  tool count stayed 119. The difference was the corrected Goal/Rescue model
  contract, so a semantic fresh-session handover was required.
- Verified semantic handover `4faa1a22-3342-4ff8-a82a-4a4bcb42ffe6`
  completed with active slot `b`, Core PID `57824`, no rollback, a fresh
  verifier session and the same 119-tool catalogue. It replayed one session,
  deferred three and dropped TWO old-schema sessions (`schema-stale`: 2,
  `initialize-failed`: 3). Never report this handover as zero-session impact.
- Gateway remained healthy and admission reopened. Auto Compact remains OFF.
  `goalRoundRecoveryEnabled`, Rescue/liveness, Context Guardian, Host Overlay,
  Stream Recovery, plugins, skills and artifacts are enabled.
- Main PIDs observed after handover: Main-02 1796, Main-03 6412, Main-04 5884,
  Main-06 1812. Their runtime controllers report no Primary restart. The one
  currently online Blender remains PID 17000 / port 9879; no Blender runtime
  was started, stopped or transferred by this work.

### Why a Goal could work for several rounds and then stop

No hard three-round limit exists. Production already contains a Goal at
round 13. Two independent long-run faults were demonstrated and repaired:

1. GoalRuntime, PlanRuntime and GoalContinuationSupervisor chained every
   persistence operation directly from the preceding Promise. One transient
   rejected disk write permanently poisoned every later save. Their queues now
   reject the failed caller but recover for the next fresh snapshot; Goal and
   Plan use atomic JSON writes. A failed pre-send continuation journal releases
   its exclusive lease before any host transport and can retry once after the
   bounded backoff without duplicate sends.
2. Hidden Goal continuations correctly keep the same latest user message ID.
   Liveness previously reused the prior Rescue episode, so one earlier Rescue
   could exhaust all later Goal rounds. Every unique hidden continuation ID now
   creates one fresh Rescue episode. Duplicate/reconciled notifications are
   idempotent and never reset the twenty-minute clock. Current Goal/branch
   evidence is rechecked before notifying liveness, so stale historical driver
   records cannot rearm Rescue after restart.

Executable evidence includes 160 consecutive post-report Goal continuations
through journal pruning, periodic driver restarts, duplicate displays and
acknowledgement loss (final round 161); three distinct Goal-round Rescue
episodes across a Core restart; recoverable injected persistence failures; and
64 rounds of exactly-once same-round recovery. Bounded `recentReports` length
32 and driver record pruning are storage bounds, NOT round limits.

### Same-round recovery and Rescue arbitration

Disabling the unsafe visible recovery sender entirely caused another stop:
when a physical assistant turn completed normally but omitted
`devspace_goal_turn_report`, Rescue correctly disarmed on normal completion,
while post-report continuation never armed. The Goal remained `Active /
Working` forever.

Same-round recovery is now restored only as a backend hidden assistant turn:

- exact conversation plus exact page/relay are required;
- composer must be empty before dispatch and throughout native confirmation;
- no user message, page navigation, foreground activation or Primary repair;
- any exact-owned leaked Goal control draft is detected and removed, and that
  committed attempt is never retried;
- acknowledgement loss is reconciled from the native conversation branch;
- one committed recovery permanently closes that Goal round's recovery episode;
- round 1 is recoverable as well as later rounds;
- if ordinary interrupted-turn Rescue owns or has committed the episode,
  hidden Goal recovery waits or delegates rather than racing it. Rescue remains
  the only path allowed to emit visible text, exactly `- 繼續`.

Reserved Main-06 live canary passed after the implementation: one hidden
same-round recovery send; user-message count 5 -> 5; composer empty before and
after; at least one new assistant node; no page navigation; the second guard
poll produced no second send; temp Goal recovery state became `dispatched`.
The earlier normal hidden-continuation canary likewise proved one assistant
turn, no user message, an empty composer and round advancement.

### Post-handover observations and remaining boundaries

The current real Goal automatically redeemed its Round-2 continuation and is
now Round 3 / working with Plan `plan_2cf98fb844a5d59b`. No user message or
composer text was created for that transition.

Immediately after semantic handover, Main-03 timed out even on a trivial CDP
Runtime.evaluate and its progress projection reported 3/4 synced. It recovered
without restart after a bounded 20-second wait; a direct read then completed in
30 ms and the next overlay poll reported all four Mains connected/synced. This
transient is recorded, not reclassified as a permanent fix. All observed Main
composers were subsequently empty with no Goal recovery/continuation prefix.

Two unrelated Auto Compact working-tree files were stashed during the clean
audit and restored afterwards unchanged:
`dist/context-guardian-rollover-safety.test.js` and
`scripts/auto-compact-product-static-gate.mjs`. Do not mix them into this
stabilization commit. V0.6/Auto Compact remains a separate gate and stays OFF
until its own source, restart and live-continuation acceptance is complete.

## Round 2: Goal continuation closure (latest work)

### Latest resumed work — 2026-09-20 16:04Z onward

The deployed Gateway/Core are now 38708/16796, not the older PIDs below.
The Goal is still round 2 / working. No current-turn Plan was created: its
pending claim expired. Do not treat that pending result as a Plan ID.

During inspection, invoking the old whole-restart script with `--status`
unexpectedly scheduled a replacement because it ignored unsupported flags.
The newly spawned worker 9288 was cancelled while its saved phase was still
`waiting-for-quiet`; original Gateway 38708 and Core 16796 were both alive
and were NOT stopped. The saved waiting record is therefore stale, not an
active replacement. The CLI now parses every argument BEFORE any side effect:
status reads only, no args show help, unknown/conflicting flags reject, and
actual replacement requires --execute. `verify:stable-gateway:whole-restart`
now means --preflight-only; `restart:stable-gateway` is the explicit execute
command. An actual child-process test verifies --status leaves its sentinel
record's bytes/mtime and directory unchanged.

The current Pro/background turn publishes an async placeholder (tool author
`a8km123`) to the main conversation, but its internal MCP receipts do not
appear in the page's mounted Apps or native conversation snapshot during the
turn. This was observed in both read-only iframe and bounded native probes.
Do not keep waiting for a receipt that the host has not published.

Official OpenAI Plugins reference identifies `_meta["openai/session"]` as
an anonymized CONVERSATION id, not reusable `mcp-session-id`. New code keeps
these distinct. It keys the authenticated provider id with OAuth client,
resource, subject and organization; no legacy session maps are imported.
Initial binding requires a real exact-page receipt or a direct-loopback
owner-authorized bootstrap using the ORIGINAL pending claim. The bootstrap
does not accept raw provider identity or replacement prose from callers.
Subsequent requests recheck the live exact page. Conflicts quarantine instead
of overwriting; raw metadata and credentials are not stored. This permits
Pro to keep its own context without weakening transport/session isolation.
Reference: https://developers.openai.com/plugins/reference

The pending causal-display Goal patch was also hardened: two distinct
unfinished user branches at report time cannot race for continuation. Without
an exact receipt, only one captured unfinished source plus a genuinely new
native-complete final may authorize the single send; new human input cancels.

Preliminary combined full audit e1b89950-dcd2-4eb8-ad0f-f70e91d5bd64 passed
162 named gates. A final committed revision audit and Core-only handover are
still needed. The current Pro card uses the exact compatibility bridge until
the new provider binding is loaded and verified with ordinary progress calls.

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

The detached PowerShell helper exited without a result before touching either
service, so the executable replacement path now uses the same persistent
Node-worker pattern as the existing Core reload. It atomically records every
phase, waits for quiet, revalidates creation identities and the surviving Job,
terminates only the two exact service PIDs, then starts the existing canonical
launcher. A real non-destructive `--preflight-only` run completed successfully
at 2026-09-20T14:03:58.793Z. No scheduled task or Job is stopped. The generated
PowerShell remains an inspected compatibility artifact, not the executed
replacement path. Repeated calls must inspect the saved phase first.

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

## 2026-09-22 Project conversation route hotfix

The user reported that reopening Goal conversation
`6aacf595-b3d0-83ee-a31f-043786b41e85` repeatedly returned Main-02 to the
ComfyUI Project root and that the Goal/Plan surface therefore appeared inert.
Backend state was not lost: `goal_9ddde493694349b9` remained active in round 3
and `plan_2cf98fb844a5d59b` remained active. Authority evidence showed Main-02
on the exact conversation at `2026-09-22T07:48:45.784Z`, followed later by the
Project-root URL, while the new progress report stayed a pending exact-page
claim.

The hidden progress/start claim relay still called the ChatGPT host UI-close
API at claim expiry. That host-level operation was introduced to retire stale
iframes and later delayed to the claim lifetime, but it is unsafe for a hidden
ownership receipt on the current Desktop Project surface. Hotfix `8dd574b`
removes every host-close request from the relay. Expiry now only marks the
one-shot relay retired and detaches its `openai:set_globals` and `message`
listeners; it performs no navigation, reload, foreground activation or host UI
closure.

Verification passed for `verify:visible-progress`, `verify:progress-liveness`,
`verify:goal`, `verify:host-overlay`, `verify:classic-safety`, the exact-page
claim registry/conversation isolation tests and `git diff --check`. Stable
Gateway handover `192684db-4403-4c19-aa3f-8d1123b419f6` completed without a
schema change or Gateway/Main/Blender restart; active Core PID became 27924.
The deployed file was read back with `requestClose` absent and local retirement
present. Auto Compact remains OFF.

Do not mark the incident fully accepted yet. Main-02 was still at the Project
root after deployment, because that was the pre-hotfix destination. The next
manual entry into the exact conversation must be observed read-only and kept
open beyond the two-minute claim TTL; then verify the Goal strip, Plan HUD and
one ordinary narration-card readback. Do not remount Goal/Plan or emit another
progress relay merely to manufacture the test condition, and do not navigate
ChatGPT programmatically.
