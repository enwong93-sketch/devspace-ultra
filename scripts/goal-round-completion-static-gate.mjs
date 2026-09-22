import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");
const runtime = await readFile(new URL("../dist/goal-runtime.js", import.meta.url), "utf8");
const bridge = await readFile(new URL("../dist/goal-host-bridge.js", import.meta.url), "utf8");
const guard = await readFile(new URL("../dist/goal-round-completion-guard.js", import.meta.url), "utf8");

assert.match(server, /ClassicGoalRoundCompletionGuard/,
  "legacy recovery state remains readable for existing persisted Goals");
assert.doesNotMatch(server, /goalRoundCompletionGuard\.start\(/,
  "production must never start the retired same-round Goal recovery dispatcher");
assert.match(server, /goalRoundCompletionGuard\.close\(\)/);
assert.match(server, /goalHostBridge\.inspectWorkingRound/);
assert.match(server, /goalHostBridge\.dispatchRoundRecovery/);
assert.doesNotMatch(server, /progressLivenessAdapter\.sendGoalRecovery|sendRecovery:\s*sendExactGoalRecovery/,
  "Goal Recovery must never share interrupted-turn Rescue's visible page-composer transport");
assert.match(runtime, /recoverableWorkingRounds/);
assert.match(runtime, /claimRoundRecovery/);
assert.match(runtime, /DEVSPACE_GOAL_ROUND_RECOVERY/);
assert.match(runtime, /Do not call devspace_goal_round_begin/i);
assert.match(runtime, /recovery-already-dispatched/,
  "legacy persisted recovery state remains parseable even though production dispatch is retired");
assert.match(bridge, /inspectWorkingRound/);
assert.match(bridge, /dispatchRoundRecovery/);
assert.match(bridge, /state:\s*"visible-goal-recovery-transport-retired"/);
assert.match(bridge, /definiteFailure:\s*true/);
assert.match(bridge, /dispatchCommitted:\s*false/);
assert.match(bridge, /backgroundAccepted:\s*false/);
assert.match(bridge, /visibleUserMessage:\s*false/);
assert.match(bridge, /composerMutation:\s*false/);
const recoveryStart = bridge.indexOf("async dispatchRoundRecovery");
const recoveryEnd = bridge.indexOf("setBeforeRawDispatch", recoveryStart);
const recoveryBody = bridge.slice(recoveryStart, recoveryEnd);
assert.match(recoveryBody, /visible-goal-recovery-transport-retired/);
assert.doesNotMatch(recoveryBody, /beforeDispatch|sendRecovery|sendGoalRecovery|findExactConversationPage|findExactConversationRelay|this\.sendRaw\(|Input\.insertText|prompt-textarea|send-button/,
  "retired Goal Recovery must fail before page discovery, host RPC, Primary repair, or composer access");
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
  sameRoundRecovery: false,
  visibleSameRoundRecoveryRetired: true,
  interruptedWorkingRoundUsesOrdinaryRescue: true,
  chatModeOnly: true,
  legacyStateReadable: true,
  guiAloneNeverAuthoritative: true,
  hiddenHostRecoveryTransport: false,
  visibleComposerTransport: false,
  hostRpcDispatch: false,
}));
