import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { decideGoalProgressNarration, goalRoundReportNarration } from "../dist/goal-progress-narrator.js";
import { conversationProgressNarrationMap } from "../dist/classic-progress-narration-overlay.js";

const [
  server,
  contract,
  rollover,
  cdp,
  continuity,
  goalRuntime,
  planRuntime,
  authority,
  authorityTransaction,
  narrator,
  overlay,
  manifest,
  pluginStatus,
] = await Promise.all([
  readFile(new URL("../dist/server.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/auto-compact-contract.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/context-guardian-rollover.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/context-guardian-cdp.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/conversation-continuity.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/goal-runtime.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/plan-runtime.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/classic-exact-usage-authority.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/auto-compact-authority-transaction.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/goal-progress-narrator.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/classic-progress-narration-overlay.js", import.meta.url), "utf8"),
  readFile(new URL("../capabilities/devspace-auto-compact/devspace-plugin.json", import.meta.url), "utf8"),
  readFile(new URL("../capabilities/devspace-auto-compact/scripts/status.mjs", import.meta.url), "utf8"),
]);

assert.match(server, /ClassicExactUsageAuthority/);
assert.match(server, /BUILTIN_AUTO_COMPACT|devspace-auto-compact/i);
assert.match(server, /exactUsageAuthority/);
assert.match(server, /new ContextGuardianRolloverCoordinator/);
assert.match(server, /applyVerifiedAutoCompactRollover/);
assert.match(server, /selective hidden-capsule continuation|selective-hidden-capsule-continuation/i);

assert.match(authorityTransaction, /conversationAuthority\.acceptVerifiedRollover/);
assert.match(authorityTransaction, /planRuntime\.rebindConversation/);
assert.match(authorityTransaction, /goalRuntime\.rebindConversation/);
assert.match(authorityTransaction, /goalRunProgress\.rebindConversation/);
assert.match(authorityTransaction, /hostOverlayProjection\?\.noteVerifiedRollover/);
assert.match(authorityTransaction, /auto-compact-rollback/);

assert.match(contract, /attachAutoCompactContract/);
assert.match(contract, /validateAutoCompactContinuation/);
assert.match(contract, /fullHistoryInherited/);
assert.match(contract, /zeroContextContinuation/);
assert.match(contract, /uiContinuityKey/);
assert.match(contract, /payloadByteRatio/);
assert.match(contract, /branchMessageRatio/);
assert.match(contract, /carryEstimatedTokens/);
assert.doesNotMatch(contract, /rawTranscript\s*:/i);

assert.match(rollover, /attachAutoCompactContract/);
assert.match(rollover, /validateAutoCompactContinuation/);
assert.match(rollover, /armUserTurnRollover/);
assert.match(rollover, /startHiddenRollover/);
assert.match(rollover, /verified-continuation/);
assert.match(rollover, /onVerifiedRollover/);
assert.match(rollover, /uiContinuityKey/);
assert.match(rollover, /sourceDescriptor/);
assert.doesNotMatch(rollover, /Page\.reload|Page\.navigate|location\.reload/);

assert.match(cdp, /is_context_truncation_continuation/);
assert.match(cdp, /branching_from_conversation_id/);
assert.match(cdp, /branching_from_message_id/);
assert.match(cdp, /devspace_ui_continuity_key/);
assert.match(cdp, /devspace_capsule_fingerprint/);
assert.match(cdp, /delete body\.conversation_id/);
assert.match(cdp, /is_visually_hidden_from_conversation:\s*true/);
assert.match(cdp, /visibleUserMessages/);
assert.match(cdp, /nativeConversationDescriptor/);
assert.doesNotMatch(cdp, /Page\.reload|Page\.navigate|location\.reload/);

assert.match(continuity, /continuity/);
assert.match(continuity, /compression/);
assert.match(continuity, /uiContinuityKey/);
assert.match(goalRuntime, /async rebindConversation/);
assert.match(planRuntime, /async rebindConversation/);
assert.match(authority, /classic-native-protocol/);
assert.match(authority, /estimatorFallbackUsed:\s*false/);
assert.match(authority, /ledgerFallbackUsed:\s*false/);
assert.match(authority, /domFallbackUsed:\s*false/);

assert.match(narrator, /goalRoundReportNarration/);
assert.match(narrator, /lastRoundReport/);
assert.match(narrator, /goal-round-report/);
// Round reports preserve the working Agent's words rather than relying on
// retired generated heading/status rows. Exercise the behavior directly.
const authoredParts = [
  "The isolated compression contract passed.",
  "Next verify only this conversation's continuation.",
];
const narrationGoal = {
  id: "static-canary-goal",
  conversationId: "static-canary-source",
  round: 2,
  lastRoundReport: {
    round: 2,
    reportedAt: "2026-09-21T00:00:00.000Z",
    summary: authoredParts.join("\n\n"),
  },
};
const narrationRows = goalRoundReportNarration(narrationGoal);
assert.deepEqual(narrationRows.map(({ text, conversationId, goalId, round, kind, source }) => ({
  text, conversationId, goalId, round, kind, source,
})), authoredParts.map((text) => ({
  text,
  conversationId: narrationGoal.conversationId,
  goalId: narrationGoal.id,
  round: 2,
  kind: "agent-round-report",
  source: "goal-round-report",
})), "Round narration must preserve Agent text and exact Goal/conversation scope.");
assert.ok(narrationRows.every((row) => typeof row.dedupeKey === "string" && row.dedupeKey.length > 0));
assert.equal(new Set(narrationRows.map((row) => row.dedupeKey)).size, narrationRows.length);
assert.deepEqual(goalRoundReportNarration({ ...narrationGoal, conversationId: null }), []);
assert.deepEqual(goalRoundReportNarration({ ...narrationGoal, lastRoundReport: null }), []);
assert.deepEqual(goalRoundReportNarration({
  ...narrationGoal,
  lastRoundReport: { ...narrationGoal.lastRoundReport, summary: "" },
}), []);
assert.equal(decideGoalProgressNarration(), null, "Telemetry must not generate narration.");

// Narration is durable conversation history, not a current-Goal/round window.
// Verify exact-conversation isolation and the real bounded output behavior.
const earlierReport = {
  text: "An earlier accepted result in the same conversation.",
  conversationId: narrationGoal.conversationId,
  goalId: "static-earlier-goal",
  round: 1,
  kind: "agent-round-report",
  source: "goal-round-report",
  at: "2026-09-01T00:00:00.000Z",
  dedupeKey: "static-earlier-report",
};
const foreignReport = {
  ...earlierReport,
  text: "A different conversation's report.",
  conversationId: "static-foreign-conversation",
  dedupeKey: "static-foreign-report",
};
const unverifiedReport = {
  ...earlierReport,
  text: "Unverified direct progress must never be projected.",
  source: "agent-progress-tool",
  dedupeKey: "static-unverified-report",
};
const fixtureMessages = [
  earlierReport,
  ...narrationRows.map((row) => ({ ...row, at: narrationGoal.lastRoundReport.reportedAt })),
  foreignReport,
  unverifiedReport,
];
const projectionArgs = {
  humanProgress: { messages: fixtureMessages },
  nowMs: Date.parse("2026-09-21T01:00:00.000Z"),
};
const projected = conversationProgressNarrationMap(projectionArgs);
assert.deepEqual(projected[narrationGoal.conversationId].messages.map((row) => row.text), [
  earlierReport.text, ...authoredParts,
]);
assert.deepEqual(projected[foreignReport.conversationId].messages.map((row) => row.text), [foreignReport.text]);
assert.deepEqual(conversationProgressNarrationMap({
  humanProgress: { messages: [unverifiedReport] },
}), {}, "Unverified direct progress must fail closed.");
assert.deepEqual(conversationProgressNarrationMap({
  ...projectionArgs, maxMessages: 1,
})[narrationGoal.conversationId].messages.map((row) => row.text), [authoredParts.at(-1)]);
assert.match(overlay, /devspace-progress-scroll/);

const parsedManifest = JSON.parse(manifest);
assert.equal(parsedManifest.id, "devspace-auto-compact");
assert.equal(parsedManifest.tools?.[0]?.name, "auto-compact-status");
assert.equal(parsedManifest.tools?.[0]?.env?.DEVSPACE_CONFIG_DIR, "${DEVSPACE_CONFIG_DIR}");
assert.match(pluginStatus, /selective-hidden-capsule-continuation/);
assert.match(pluginStatus, /fullHistoryInheritanceAllowed:\s*false/);
assert.match(pluginStatus, /zeroContextContinuationAllowed:\s*false/);
assert.match(pluginStatus, /rawCapsuleContentReturned:\s*false/);
assert.match(pluginStatus, /credentialsReturned:\s*false/);

console.log(JSON.stringify({
  ok: true,
  gate: "auto-compact-product-static",
  backendConversationIdMayChange: true,
  uiContinuityRequired: true,
  selectiveCompressionRequired: true,
  fullHistoryInheritanceAllowed: false,
  zeroContextContinuationAllowed: false,
  verifiedAuthorityMigration: true,
  exactUsageFailsClosed: true,
  roundReportsEnterNarrationHistory: true,
  agentAuthoredRoundReportsPreserved: true,
  narrationScopeVerified: true,
  automaticNarrationRejected: true,
  durableConversationHistoryPreserved: true,
  unverifiedNarrationRejected: true,
  narrationOutputBoundVerified: true,
  builtInCapability: true,
  pageReloads: 0,
  syntheticUserMessages: 0,
}));
