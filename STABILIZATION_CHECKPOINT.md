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

Verify normal narration through the actual visible card after controlled
deployment. Verify Goal/Plan exact start and continuation in the current chat,
then independent Rescue timing and cancellation in an isolated canary. The
full feature suite covers capabilities, Blender isolation, Computer Use,
workers, memory/logging, setup, Gateway sessions and transport regressions;
it does not imply that every production UI path has received a live test.
Investigate persistent upstream delivery failures using timestamps and
endpoint evidence rather than reducing safeguards or reenabling Auto Compact.
