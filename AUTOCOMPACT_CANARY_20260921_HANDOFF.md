# Auto Compact isolated canary — 2026-09-21 checkpoint

## Latest verification — 2026-09-22 HKT: descriptor and late-poll repair

Audit: `autocompact-canary-20260922-descriptor`. Authoritative evidence: `AUTOCOMPACT_CANARY_20260922_DESCRIPTOR_EVIDENCE.json`; full native test output: `AUTOCOMPACT_CANARY_20260922_DESCRIPTOR.tap`. This section supersedes the earlier frontier below.

- Continued the same worktree and conversation; no new baseline or unrelated project/history import.
- Reproduced the missing `classicSourcePageIdentity` export while the existing CDP suite passed. Added real page-identity/stability helpers and integrated the guarded descriptor read into the session API. The public adapter now forwards descriptor options, including `force`.
- Descriptor coordination now supports paced starts, same-conversation singleflight, bounded non-retryable/transient failure cooldowns, bounded in-flight/cache state, generation invalidation on clear, and refusal to return stale cached success after failed forced refresh. Source/target identity is checked and returned cache values are independent copies.
- Existing tests had contradictory 429 scope expectations. The production default remains `rateLimitScope: "conversation"`; the shared-quota fixture now explicitly requests `rateLimitScope: "shared"`. No assertion was removed. The shared live coordinator uses a 2-second request-start gap but not a global 429 freeze. This is isolated code only, not deployed behavior.
- `Retry-After` no longer shortens a server interval to the former five-minute cap; integer seconds and HTTP dates are handled. References consulted: RFC 9110 section 10.2.3 and RFC 6585 section 4. The latter does not define a universal quota scope.
- Added 12 deterministic descriptor lifecycle cases: unstable source rejection, page/epoch/route/hydration changes, wrong boundary, late success/failure after clear, forced-refresh failure, independent cache values, concurrent pacing, queued shared-cooldown recheck, default conversation isolation, Retry-After parsing, and state bounds.
- Further reproduced a rollover race: a poll begun before a successful commit resumed afterward and armed the old source again (2 calls, expected 1). Added per-runtime preparation versions across awaited boundaries and checkpoint completion. New cases verify that a late pre-commit poll cannot re-arm/recreate prepared authority, and closing during a pending snapshot cannot arm afterward.
- Final audited run: **8 test files, 19 Node test entries passed, 0 failed/cancelled/skipped/todo, exit 0**. The 19 entries mix file-level legacy assertions with 12 named lifecycle tests; they are not 19 exhaustive product scenarios. `git diff --check` exited 0. Full output and source hashes are saved in the evidence files.
- Exact conversation remains `6aacc828-96f0-83e8-b368-a550e2c8ae27`; this turn's Plan is `plan_3114a058278b993f`. Direct progress reports succeeded. Production status was re-read: Auto Compact disabled, Context Guardian enabled; no live compression was attempted.
- No production deployment, service restart, global enablement, page navigation, or synthetic user message occurred. Current-turn source/test modifications are confined to this worktree. Earlier source-checkout test-only edits belong to earlier turns.

### Current remaining frontier

1. Durable failure/commit recovery across actual process restart is still unverified. `clear()`/close lifecycle tests do not establish restart persistence; current failure and preparation-version maps remain in-memory.
2. Native adapter arm/cancellation and transaction finalization under remaining overlapping operations still need targeted verification. Passing the listed interleavings does not prove every lifecycle race.
3. At a legitimate scoped idle canary boundary, verify selective compression and completed assistant continuation plus transactional Goal/Plan/MCP/progress/overlay migration and rollback. Do not enable global compact or alter another conversation to obtain a green result.
4. Do not repeat broad discovery or the canary baseline. Continue from these updated modules, hashes and the saved TAP record. Do not report the full product or live acceptance as complete.

## Earlier resumed verification — historical

Audit: `autocompact-canary-20260921-resume`. Evidence summary: `AUTOCOMPACT_CANARY_20260921_RESUME_EVIDENCE.json`.

- The latest inherited safety suite was actually executed and passed. The prior tool-execution blocker did not recur on the direct test command; no alternate execution path was used to bypass a denial.
- Further test coverage reproduced acceptance of a target descriptor naming a different conversation. The isolated runtime now checks target descriptor identity, serializes simultaneous completion events per runtime, prevents a new poll from preparing while that commit is active, and retains bounded failure entries keyed by runtime plus conversation across route round trips.
- Final executed command: `node --test dist/context-guardian-rollover-safety.test.js dist/context-guardian-rollover.test.js dist/context-guardian-structural-seed.test.js`. Result: **3 test files passed, 0 failed, exit 0**. These are in-process/fixture tests, not live compression proof.
- Separate `context-guardian-descriptor-coordinator.test.js` could not load because `context-guardian-cdp.js` does not export `classicSourcePageIdentity`. This gate remains failed; neither file was changed or the test weakened in this resume.
- `git diff --check` passed. Runtime SHA-256: `1d0999e2cc84fef73fb105d17919bbc65b9686dc12871de5e8abfa42cae5be8a`. Safety-test SHA-256: `f436c59f3d38ee3fa313250aab360082ae9fde18eb4e5b8971ed65f3cc5a0611`.
- Exact conversation is now resolved: `6aacc828-96f0-83e8-b368-a550e2c8ae27`, `main-06`, port `9736`. Earlier diagnostic searched only Main-01..03 and therefore did not locate it.
- Current-turn Plan: `plan_1d9c73b3a0a5ca2d`. A normal final response closes this bounded verification turn; do not reopen it as a new turn's active plan.
- The documented exact-conversation `progress` bridge confirmed the authored message in the store. A subsequent exact-page read confirmed `exact=true`, `progressCardMounted=true`, and matching progress conversation ID. A later **direct** `devspace_progress_report` succeeded with messageCount 4 at `2026-09-21T13:36:04.189Z`. This supersedes the earlier pending-card blocker.
- The exact page was still generating; no live compression was armed or attempted at that unsafe boundary. Global Auto Compact remains `enabled=false`, Context Guardian remains enabled. Its native exact token usage is unavailable; the 63-token ledger value is not total actual usage.
- Installed runtime SHA-256: `92383b31bb4b071264de59ae8c27d4f2d66f18e6d3230cf09d6d468552337eca`, different from the isolated patch. No production runtime change, service restart, global enablement, page navigation, or synthetic user message was performed in this resume.

### Remaining frontier

1. Resolve the descriptor-coordinator test/runtime export mismatch without weakening acceptance.
2. Verify remaining lifecycle races and restart behavior. The failure maps and commit guard are in-memory; persistence and all interleavings are not established by these tests.
3. Only at a verified idle and appropriately scoped live canary boundary, exercise selective compression and completed assistant continuation, including transactional Goal/Plan/MCP/progress/overlay migration and source preservation. Do not enable global Auto Compact to force a green result.
4. Do not redeploy, recreate the canary baseline, or repeat already completed broad discovery. Continue from these changed files and evidence.

## Earlier checkpoint (historical; latest section above takes precedence)

## Scope and authority

Continue only the conversation that began with the isolated Auto Compact baseline and received `CANARY_READY`. Do not import unrelated Blender/CTC work. No production deployment, service restart, global Auto Compact enablement, page navigation, or synthetic user turn was performed.

The current conversation ID remains unverified. Direct progress and Plan requests returned pending claims, not a confirmed card update or a usable Plan ID. Do not invent an identity or reuse another conversation's authority.

## Isolated runtime patch

- Worktree: `C:\Users\enwong\.devspace\worktrees\devspace-ae006673`
- Base: `e2ee59caa9622277fd3e63b143f11ab1715e6313`, detached worktree.
- Source checkout: `C:\Users\enwong\AppData\Roaming\npm\node_modules\@waishnav\devspace`.
- Modified here: `dist/context-guardian-rollover.js` and `dist/context-guardian-rollover-safety.test.js`.
- Runtime modifications exist only in this worktree and have NOT been deployed.

Reproduced defect: after a native descriptor read failed, two consecutive coordinator polls made two descriptor calls; the safety test expected one. A failure cooldown was absent.

Initial isolated repair added a bounded per-runtime/per-conversation descriptor failure cooldown, source-preserving compact failure circuits, cancellation of failed armed continuations, and rejection of explicit authority-rebind failure. The original safety scenarios and compression-contract test then passed with exit code 0.

Subsequent hardening added trusted prepared-capsule authority checks, fingerprint matching, stale/foreign/duplicate event rejection, explicit `{ok:false}` rebind rejection, and additional synthetic regression cases. The final expanded test command was blocked by the tool safety layer before execution. Therefore the LATEST patch is NOT fully regression-verified. Do not report all newly added cases as passed.

Latest successful non-executing verification: `git diff --check` exited 0. Runtime/test diff: 189 insertions and 25 deletions across two files, before this handoff file was added.

## Tests and operational observations

Passed before the final hardening edits:

- `auto-compact-contract`: nonempty selective capsules, source-to-carry ratios, rejection of raw/full-history and zero-context continuations.
- `auto-compact-structural-usage`: estimates remain explicitly non-exact and use no raw content.
- `auto-compact-plugin`: command adapter exercised using temporary isolated configuration/state; no production enablement.
- `auto-compact-product-static`: passed after obsolete narration-marker checks were replaced by behavior tests in the source checkout.
- `context-guardian-rollover-safety`: original cases passed after initial isolated runtime repair; latest expanded suite is pending execution.

Two TEST-ONLY source-checkout edits were also made and remain uncommitted:

1. `scripts/auto-compact-product-static-gate.mjs`: replaced obsolete generated-heading/status and round-window checks with Agent-text, exact-conversation isolation, durable history, unverified-row rejection and bounded-output behavior checks. This version passed. The worktree was created from HEAD and does not automatically include this uncommitted file.
2. `dist/context-guardian-rollover-safety.test.js`: aligned the old fixture to `continuityRuntime.enabled`, `enabled:false/action:auto-compact-disabled`, and `skipped-route-hydration`. This fixture exposed the real repeated-descriptor defect in the installed runtime. The equivalent fixture corrections are included in the worktree plus extra tests.

The production Auto Compact status adapter reported `enabled:false`, `contextGuardianEnabled:true`, and no selective capsule among its latest 64 inspected records (589 total). This is NOT proof that every historical capsule was checked. Current session-bound Chat Swarm continuation was not found.

## Unresolved gates

1. Execute the latest isolated regression suite through an authorized tool path. A test execution was blocked by the tool safety layer; do not repackage or route the same blocked operation through another tool to bypass it.
2. Review circuit behavior across route changes/restarts and verify the complete patch before proposing deployment. Current failure maps are in-memory; restart persistence is not established.
3. Obtain legitimate exact-page conversation binding. A live-page diagnostic was blocked; it was not bypassed.
4. Run the actual isolated selective-compaction and completed-assistant continuation acceptance once the live boundary is available. Confirm Goal/Plan/MCP/progress/overlay migration and source preservation with live evidence.

Passing mocks or static checks does not establish live UI continuation. Preserve completed tests and this worktree; do not restart the baseline or enable the global feature merely to obtain a green status.
