import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [
  server,
  contract,
  rollover,
  cdp,
  continuity,
  goalRuntime,
  planRuntime,
  authority,
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
  readFile(new URL("../dist/goal-progress-narrator.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/classic-progress-narration-overlay.js", import.meta.url), "utf8"),
  readFile(new URL("../capabilities/devspace-auto-compact/devspace-plugin.json", import.meta.url), "utf8"),
  readFile(new URL("../capabilities/devspace-auto-compact/scripts/status.mjs", import.meta.url), "utf8"),
]);

assert.match(server, /ClassicExactUsageAuthority/);
assert.match(server, /BUILTIN_AUTO_COMPACT|devspace-auto-compact/i);
assert.match(server, /exactUsageAuthority/);
assert.match(server, /new ContextGuardianRolloverCoordinator/);
assert.match(server, /acceptVerifiedRollover|rebindConversation/);
assert.match(server, /noteVerifiedRollover/);
assert.match(server, /selective hidden-capsule continuation|selective-hidden-capsule-continuation/i);

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
assert.match(rollover, /rebindConversation/);
assert.match(rollover, /acceptVerifiedRollover/);
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
assert.match(narrator, /recentReports/);
assert.match(narrator, /lastRoundReport/);
assert.match(narrator, /round-report/);
assert.match(overlay, /recent Goal rounds|same Goal/i);
assert.match(overlay, /devspace-progress-scroll/);

const parsedManifest = JSON.parse(manifest);
assert.equal(parsedManifest.id, "devspace-auto-compact");
assert.equal(parsedManifest.tools?.[0]?.name, "auto-compact-status");
assert.equal(parsedManifest.env?.DEVSPACE_CONFIG_DIR, "${DEVSPACE_CONFIG_DIR}");
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
  builtInCapability: true,
  pageReloads: 0,
  syntheticUserMessages: 0,
}));
