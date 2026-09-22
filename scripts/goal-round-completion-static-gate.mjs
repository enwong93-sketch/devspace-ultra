import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");
const runtime = await readFile(new URL("../dist/goal-runtime.js", import.meta.url), "utf8");
const bridge = await readFile(new URL("../dist/goal-host-bridge.js", import.meta.url), "utf8");
const guard = await readFile(new URL("../dist/goal-round-completion-guard.js", import.meta.url), "utf8");

assert.match(server, /ClassicGoalRoundCompletionGuard/,
  "same-round recovery state remains durable for existing persisted Goals");
assert.match(server, /if \(config\.goalRoundRecoveryEnabled\)[\s\S]{0,260}goalRoundCompletionGuard\.start\(/,
  "production starts same-round recovery only behind the explicit hidden-recovery feature flag");
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
  "a committed hidden recovery remains exactly-once across restart");
assert.match(bridge, /inspectWorkingRound/);
assert.match(bridge, /dispatchRoundRecovery/);
assert.match(bridge, /transport:\s*"classic-hidden-round-recovery"/);
assert.match(bridge, /classic-hidden-round-recovery-native-reconciled/);
assert.match(bridge, /findExactConversationRelay/);
assert.match(bridge, /inspectComposer/);
assert.match(bridge, /clearOwnedComposer/);
assert.match(bridge, /hidden-goal-recovery-composer-exposure-cleared/);
assert.match(bridge, /backgroundAccepted:\s*true/);
assert.match(bridge, /visibleUserMessage:\s*false/);
assert.match(bridge, /composerMutation:\s*false/);
const recoveryStart = bridge.indexOf("async dispatchRoundRecovery");
const recoveryEnd = bridge.indexOf("setBeforeRawDispatch", recoveryStart);
const recoveryBody = bridge.slice(recoveryStart, recoveryEnd);
assert.match(recoveryBody, /findExactConversationRelay/);
assert.match(recoveryBody, /this\.sendRaw\(/,
  "same-round recovery must use the backend hidden host RPC");
assert.match(recoveryBody, /composerBefore[\s\S]{0,280}state !== "empty"/,
  "hidden recovery must require an empty composer before dispatch");
assert.match(recoveryBody, /composerAfter[\s\S]{0,500}exactOwnedPayload/,
  "any host regression that exposes Goal control text must be detected and cleaned only under exact ownership");
assert.doesNotMatch(recoveryBody, /beforeDispatch|sendRecovery|sendGoalRecovery|findExactConversationPage|Input\.insertText|send-button/,
  "hidden Goal Recovery must not run Primary repair or use the visible composer sender");
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
  visibleSameRoundRecoveryRetired: true,
  interruptedWorkingRoundUsesOrdinaryRescueWithoutRace: true,
  chatModeOnly: true,
  legacyStateReadable: true,
  guiAloneNeverAuthoritative: true,
  hiddenHostRecoveryTransport: true,
  visibleComposerTransport: false,
  hostRpcDispatch: true,
}));
