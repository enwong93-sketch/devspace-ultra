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
assert.match(server, /progressLivenessAdapter\.sendGoalRecovery/,
  "Goal Recovery must reuse the exact page-composer transport proven by interrupted-turn rescue");
assert.match(server, /sendRecovery:\s*sendExactGoalRecovery/);
assert.match(runtime, /recoverableWorkingRounds/);
assert.match(runtime, /claimRoundRecovery/);
assert.match(runtime, /DEVSPACE_GOAL_ROUND_RECOVERY/);
assert.match(runtime, /Do not call devspace_goal_round_begin/i);
assert.match(runtime, /recovery-already-dispatched/,
  "one successfully visible Goal recovery must close the current round recovery episode");
assert.match(bridge, /inspectWorkingRound/);
assert.match(bridge, /dispatchRoundRecovery/);
assert.match(bridge, /findExactConversationPage/);
assert.match(bridge, /classic-exact-page-composer/);
assert.match(bridge, /foregroundActivation:\s*false/);
assert.match(bridge, /pageNavigation:\s*false/);
const recoveryStart = bridge.indexOf("async dispatchRoundRecovery");
const recoveryEnd = bridge.indexOf("setBeforeRawDispatch", recoveryStart);
const recoveryBody = bridge.slice(recoveryStart, recoveryEnd);
assert.doesNotMatch(recoveryBody, /beforeDispatch|sendRaw|findConversationRelay|findMatchingCandidate/,
  "Goal Recovery must not run Primary repair, app-relay discovery, or raw host follow-up RPC");
assert.doesNotMatch(recoveryBody, /Page\.navigate|Page\.reload|bringToFront|activate|showWindow/i,
  "Goal Recovery must not navigate, foreground, or pop another conversation window");
assert.match(guard, /streamStatus/);
assert.match(guard, /COMPLETE/);
assert.match(guard, /generating/);
assert.match(guard, /chatMode/);
assert.match(guard, /deliveryTransportFailed/);
assert.match(guard, /deliveryTimeoutVisible/);
assert.match(guard, /retryVisible/);
assert.match(guard, /safetyCheckVisible/);
assert.match(guard, /currentTurnTransportFinished/,
  "normal recovery must not exhaust attempts while the current assistant turn is still visibly generating");
assert.match(guard, /sawCurrentRoundAssistant/,
  "a stale GUI stop control needs current-round assistant proof before recovery");
assert.match(runtime, /priorAttempts >= MAX_ROUND_RECOVERY_ATTEMPTS/,
  "transient failed recovery attempts must become eligible again after their cooldown");
assert.match(server, /ClassicTurnDeliveryEvidenceStore/);
assert.match(server, /onTurnTransportEvent/);

console.log(JSON.stringify({
  ok: true,
  gate: "goal-round-completion-static",
  sameRoundRecovery: true,
  noUserPromptRequired: true,
  chatModeOnly: true,
  nativeCompleteOrTransportFailureRequired: true,
  staleGuiGeneratingRequiresCurrentTurnProof: true,
  transientAttemptBurstCanRecover: true,
  guiAloneNeverAuthoritative: true,
  exactPageComposerTransport: true,
  oneVisibleRecoveryPerRound: true,
  foregroundActivation: false,
  pageNavigation: false,
}));
