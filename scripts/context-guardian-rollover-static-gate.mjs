import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const cdp = await readFile(new URL("../dist/context-guardian-cdp.js", import.meta.url), "utf8");
const rollover = await readFile(new URL("../dist/context-guardian-rollover.js", import.meta.url), "utf8");
const server = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");
const retiredLiveGate = await readFile(new URL("./context-guardian-main-rollover-live-gate.mjs", import.meta.url), "utf8");

// Legacy helper transforms may remain as testable pure functions while migration
// completes, but the live CDP adapter/control plane must not perform any page
// navigation/reload or invoke fresh-conversation rollover as Auto Compact.
assert.match(cdp, /captureNativeSnapshot\(\)[\s\S]*reload is forbidden/);
assert.match(cdp, /armUserTurnRollover\(\)[\s\S]*legacy-fresh-conversation-rollover-disabled/);
assert.match(cdp, /startHiddenRollover\(\)[\s\S]*Legacy fresh-conversation rollover is disabled/);
assert.doesNotMatch(cdp, /Page\.reload|Page\.navigate|location\.reload/, "Context Guardian CDP live path must contain zero automated page reload/navigation primitives");
assert.doesNotMatch(cdp, /button\.click\(\)/, "Context Guardian live path must not synthesize hidden Send clicks");
assert.match(cdp, /composerTextChars/);
assert.match(cdp, /lastTurnRequestObservedAt/);
assert.match(cdp, /ClassicTurnIdentityCorrelator/);

assert.match(rollover, /action:\s*"true-compact-required"/);
assert.match(rollover, /legacy-fresh-conversation-rollover-disabled/);
assert.match(rollover, /true-same-conversation-compact-required/);
assert.match(rollover, /Page refresh\/reload is forbidden/);
assert.doesNotMatch(rollover, /contextAdapter\.armUserTurnRollover/);
assert.doesNotMatch(rollover, /contextAdapter\.startHiddenRollover/);
assert.doesNotMatch(rollover, /nativeSnapshotRefreshEnabled/);
assert.doesNotMatch(rollover, /captureNativeSnapshot\(/);

assert.match(server, /new ContextGuardianRolloverCoordinator/);
assert.match(server, /contextRollover\.beforeGoalContinuation/);
assert.match(server, /contextRollover\.start/);
assert.match(server, /contextRollover\.close/);

assert.match(retiredLiveGate, /RETIRED_FRESH_CONVERSATION_ROLLOVER_GATE/);
assert.match(retiredLiveGate, /true same-conversation Auto Compact/);
assert.doesNotMatch(retiredLiveGate, /startHiddenRollover|Page\.navigate|Page\.reload/);

console.log(JSON.stringify({
  ok: true,
  gate: "context-guardian-rollover-static",
  checkpointOnlyAtPressure: true,
  trueSameConversationCompactRequired: true,
  freshConversationCompaction: false,
  automaticPageActionCount: 0,
}));
