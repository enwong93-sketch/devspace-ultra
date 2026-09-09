import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const cdp = await readFile(new URL("../dist/context-guardian-cdp.js", import.meta.url), "utf8");
const rollover = await readFile(new URL("../dist/context-guardian-rollover.js", import.meta.url), "utf8");
const server = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");
const retiredLiveGate = await readFile(new URL("./context-guardian-main-rollover-live-gate.mjs", import.meta.url), "utf8");

// Auto Compact may move to a fresh backend conversation id, but only by
// rewriting the next real user/hidden Goal continuation request with one
// selective hidden capsule. The live control plane must never reload/navigate
// ChatGPT, synthesize a visible user message, or copy the old mapping.
assert.match(cdp, /captureNativeSnapshot\(\)[\s\S]*reload is forbidden/);
assert.match(cdp, /armUserTurnRollover\(input\)[\s\S]*mode:\s*input\?\.mode \|\| "user-turn"/);
assert.match(cdp, /startHiddenRollover\(input\)[\s\S]*hidden-goal-continuation/);
assert.match(cdp, /delete body\.conversation_id/);
assert.match(cdp, /is_context_truncation_continuation = true/);
assert.match(cdp, /branching_from_conversation_id/);
assert.match(cdp, /devspace_ui_continuity_key/);
assert.match(cdp, /devspace_capsule_fingerprint/);
assert.doesNotMatch(cdp, /Page\.reload|Page\.navigate|location\.reload/, "Context Guardian CDP live path must contain zero automated page reload/navigation primitives");
assert.doesNotMatch(cdp, /button\.click\(\)/, "Context Guardian live path must not synthesize hidden Send clicks");
assert.match(cdp, /composerTextChars/);
assert.match(cdp, /lastTurnRequestObservedAt/);
assert.match(cdp, /ClassicTurnIdentityCorrelator/);
assert.match(cdp, /DEV Space Local Gateway/);
assert.doesNotMatch(cdp, /@DevSpace Ultra/, "Runtime connector selection must use the authoritative DEV Space Local Gateway name, not the GitHub product name");

assert.match(rollover, /attachAutoCompactContract/);
assert.match(rollover, /validateAutoCompactContinuation/);
assert.match(rollover, /action:\s*"armed-user-turn-auto-compact"/);
assert.match(rollover, /contextAdapter\.armUserTurnRollover/);
assert.match(rollover, /contextAdapter\.startHiddenRollover/);
assert.match(rollover, /uiContinuityKey/);
assert.match(rollover, /verified-continuation/);
assert.match(rollover, /continuityRuntime\.enabled !== true/);
assert.match(rollover, /action:\s*"auto-compact-disabled"/);
assert.match(rollover, /action:\s*"skipped-route-hydration"/);
assert.match(rollover, /routeHydrated === true/);
assert.doesNotMatch(rollover, /nativeSnapshotRefreshEnabled/);
assert.doesNotMatch(rollover, /captureNativeSnapshot\(/);

assert.match(server, /new ContextGuardianRolloverCoordinator/);
assert.match(server, /contextRollover\.beforeGoalContinuation/);
assert.match(server, /!config\.contextGuardianEnabled \|\| !config\.autoCompactEnabled/);
assert.match(server, /if \(config\.contextGuardianEnabled && config\.autoCompactEnabled\)[\s\S]*contextRollover\.start/);
assert.match(server, /contextRollover\.close/);

assert.match(retiredLiveGate, /RETIRED_FRESH_CONVERSATION_ROLLOVER_GATE/);
assert.match(retiredLiveGate, /true same-conversation Auto Compact/);
assert.doesNotMatch(retiredLiveGate, /startHiddenRollover|Page\.navigate|Page\.reload/);

console.log(JSON.stringify({
  ok: true,
  gate: "context-guardian-rollover-static",
  checkpointOnlyAtPressure: true,
  selectiveContinuationCompaction: true,
  backendConversationIdMayChange: true,
  uiContinuityRequired: true,
  fullHistoryInheritanceRejected: true,
  zeroContextRejected: true,
  automaticPageActionCount: 0,
  syntheticVisibleUserMessages: 0,
}));
