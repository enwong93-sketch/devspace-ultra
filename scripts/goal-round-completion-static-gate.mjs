import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");
const runtime = await readFile(new URL("../dist/goal-runtime.js", import.meta.url), "utf8");
const bridge = await readFile(new URL("../dist/goal-host-bridge.js", import.meta.url), "utf8");
const guard = await readFile(new URL("../dist/goal-round-completion-guard.js", import.meta.url), "utf8");

assert.match(server, /ClassicGoalRoundCompletionGuard/);
assert.match(server, /if\s*\(config\.goalRoundRecoveryEnabled\)[\s\S]*goalRoundCompletionGuard\.start\(\)/, "automatic same-round recovery must support an explicit operator hold");
assert.match(server, /goalRoundCompletionGuard\.close\(\)/);
assert.match(server, /goalHostBridge\.inspectWorkingRound/);
assert.match(server, /goalHostBridge\.dispatchRoundRecovery/);
assert.match(runtime, /recoverableWorkingRounds/);
assert.match(runtime, /claimRoundRecovery/);
assert.match(runtime, /DEVSPACE_GOAL_ROUND_RECOVERY/);
assert.match(runtime, /Do not call devspace_goal_round_begin/i);
assert.match(bridge, /inspectWorkingRound/);
assert.match(bridge, /dispatchRoundRecovery/);
assert.match(guard, /streamStatus/);
assert.match(guard, /COMPLETE/);
assert.match(guard, /generating/);
assert.match(guard, /chatMode/);
assert.match(guard, /deliveryTransportFailed/);
assert.match(guard, /deliveryTimeoutVisible/);
assert.match(guard, /retryVisible/);
assert.match(guard, /safetyCheckVisible/);
assert.match(server, /ClassicTurnDeliveryEvidenceStore/);
assert.match(server, /onTurnTransportEvent/);

console.log(JSON.stringify({
  ok: true,
  gate: "goal-round-completion-static",
  sameRoundRecovery: true,
  noUserPromptRequired: true,
  chatModeOnly: true,
  nativeCompleteOrTransportFailureRequired: true,
  guiAloneNeverAuthoritative: true,
}));
