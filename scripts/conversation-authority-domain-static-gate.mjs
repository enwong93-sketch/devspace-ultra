import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");
const requestContext = await readFile(new URL("../dist/mcp-conversation-request-context.js", import.meta.url), "utf8");
const correlation = await readFile(new URL("../dist/classic-mcp-call-correlation.js", import.meta.url), "utf8");
const invocationStream = await readFile(new URL("../dist/classic-tool-invocation-stream.js", import.meta.url), "utf8");
const progressProof = await readFile(new URL("../dist/progress-ownership-proof.js", import.meta.url), "utf8");
const progressOverlay = await readFile(new URL("../dist/classic-progress-narration-overlay.js", import.meta.url), "utf8");
const liveness = await readFile(new URL("../dist/conversation-progress-liveness.js", import.meta.url), "utf8");
const livenessCdp = await readFile(new URL("../dist/conversation-progress-liveness-cdp.js", import.meta.url), "utf8");
const transportObserver = await readFile(new URL("../dist/classic-turn-transport-observer.js", import.meta.url), "utf8");
const progressClaims = await readFile(new URL("../dist/progress-claim-registry.js", import.meta.url), "utf8");
const progressRelay = await readFile(new URL("../dist/ui/progress-claim-relay.html", import.meta.url), "utf8");

assert.match(server, /const resolveCapabilityConversationAuthority = async \(extra\) =>/);
assert.match(server, /const resolveProgressConversationAuthority = async \(extra\) =>/);
assert.match(server, /const resolveConversationAuthority = resolveCapabilityConversationAuthority;/);
assert.match(server, /const resolveConversation = resolveCapabilityConversationAuthority;/);
assert.match(server, /const resolveProgressConversation = resolveProgressConversationAuthority;/);
assert.match(server, /registerAppTool\(server, "devspace_progress_report"[\s\S]*const resolved = await resolveProgressConversation\(extra\);/);
assert.match(server, /resourceUri:\s*PROGRESS_CLAIM_RELAY_URI/);
assert.match(server, /resourceUri:\s*PROGRESS_CLAIM_RELAY_URI,[\s\S]{0,800}visibility:\s*\["model",\s*"app"\]/,
  "the progress relay must be callable by the exact page MCP App as well as the model");
assert.match(server, /progressClaimRegistry\.create\(\{ message:\s*reportMessage, kind \}\)/);
assert.match(server, /claimId:\s*z\.string\(\)\.min\(16\)\.max\(200\)\.optional\(\)/);
assert.match(server, /progressClaimRegistry\.claim\(/);

const progressResolverStart = server.indexOf("const resolveProgressConversationAuthority = async (extra) =>");
const progressResolverEnd = server.indexOf("const resolveConversationAuthority = resolveCapabilityConversationAuthority", progressResolverStart);
assert.ok(progressResolverStart >= 0 && progressResolverEnd > progressResolverStart);
const progressResolver = server.slice(progressResolverStart, progressResolverEnd);
assert.doesNotMatch(progressResolver, /capabilityAuthority|resolveFingerprint|resolveMcpExtra|waitForFingerprint/,
  "progress narration may consume only its current request-scoped authority domain");

assert.match(server, /let progressAuthority = null;/);
assert.match(server, /onToolInvocation:\s*\(event\)/,
  "page-local tool invocation evidence must drive exact direct-call correlation");
assert.match(server, /mcpCallCorrelator\.noteNative\(event\)/);
assert.match(server, /const gatewayCorrelationId = callFingerprint \? randomUUID\(\) : null/,
  "resolved call evidence must stay attached to one exact Gateway request");
assert.match(server, /gatewayRequestId:\s*gatewayCorrelationId/);
assert.match(server, /progressLivenessAdapter\.find\(\{[\s\S]*conversationId:\s*candidate\.conversationId/);
assert.match(server, /page\.runtimeKey !== candidateRuntimeKey/);
assert.match(server, /page\.progressCardMounted === true && page\.progressConversationId !== candidate\.conversationId/);
assert.match(server, /resolved\?\.pageVerified !== true \|\| !resolved\?\.runtimeKey \|\| !resolved\?\.callFingerprint/,
  "progress writes require exact page plus canonical tool invocation proof");
assert.match(server, /ownershipProof:\s*EXACT_CONVERSATION_REQUEST_PROOF/);
assert.match(progressClaims, /exact page-verified conversation authority/);
assert.match(progressClaims, /another conversation page/);
assert.match(progressClaims, /durableConversationOwners:\s*0/);
assert.match(progressRelay, /window\.openai\.callTool\("devspace_progress_report"/);
assert.doesNotMatch(progressRelay, /sendFollowUpMessage|prompt-textarea|composer/);

assert.doesNotMatch(server, /resolveVerifiedDirectSession\(|persistVerifiedDirectSessionIdentity|directRequestAuthorityRegistry/,
  "durable direct-session and direct-trace authority is retired");
assert.doesNotMatch(server, /conversationAuthority\.waitForFingerprint\(sessionFingerprint/,
  "progress must not wait for a reusable session owner");
assert.doesNotMatch(server, /runtimeKeyHint:\s*persistedRuntimeKey|sessionFingerprintHint:\s*sessionFingerprint/,
  "Runtime and host session are not conversation owners");
assert.doesNotMatch(server, /activeTurnRegistry\.(?:resolveGatewayCall|waitForIdentity)\(/,
  "browser turn traces cannot authorize direct MCP tools; exact page-local tool invocation evidence is required");
assert.doesNotMatch(server, /verifyProgressConversationAuthority/,
  "the retired session/page fallback module must not remain wired");

assert.match(requestContext, /capabilityAuthority/);
assert.match(requestContext, /progressAuthority/);
assert.match(requestContext, /progressAuthorityPromise/);
assert.match(requestContext, /AsyncLocalStorage/);
assert.match(correlation, /if \(!distributedTraces\.length && !trace\) return null/);
assert.doesNotMatch(correlation, /correlationKind = "session"|correlationKind = "session-alias"|correlationKind = "runtime-tool"/);
assert.doesNotMatch(correlation, /ClassicDirectRequestAuthorityRegistry/);
assert.match(correlation, /gatewayRequestId/,
  "resolved canonical calls may be reused only by the exact Gateway request that created them");
assert.match(correlation, /candidatePairs/);
assert.match(correlation, /unique\.size !== 1/);

assert.match(invocationStream, /recipient === "api_tool\.call_tool"/);
assert.match(invocationStream, /fingerprintMcpToolCall\("tools\/call"/);
assert.match(invocationStream, /rawArgumentsPersisted:\s*false/);
assert.match(transportObserver, /Network\.streamResourceContent/);
assert.match(transportObserver, /Network\.dataReceived/);
assert.match(progressProof, /exact-conversation-request-v1/);
assert.match(progressProof, /exact-page-compatibility-bridge-v1/);
assert.match(progressOverlay, /isProjectableProgressMessage/,
  "unproved historic messages cannot be projected into a card");
assert.match(liveness, /isProjectableProgressMessage/,
  "unproved historic messages cannot update rescue timing");
assert.match(liveness, /persistedVersion >= 4/,
  "pre-fix rescue episodes are disarmed during migration");

assert.doesNotMatch(server, /conversationProgressLiveness\.noteToolActivity|consumeToolReminder/,
  "liveness may not wrap, delay, or mutate arbitrary tool handlers");
assert.doesNotMatch(liveness, /noteToolActivity|consumeToolReminder|lastToolReminderAt/);
assert.doesNotMatch(liveness, /runtime-owner-conflict|record\.runtimeKey|runtimeKey:\s*record\.runtimeKey/,
  "liveness ownership remains conversation-only");
assert.match(liveness, /authorityKey:\s*"conversationId"/);
assert.match(liveness, /runtimeBinding:\s*false/);
assert.match(liveness, /adapter\?\.find\?\.\(\{ conversationId \}\)/);
assert.match(livenessCdp, /for \(const runtimeKey of this\.runtimeKeys\)/);
assert.match(livenessCdp, /duplicate-conversation-pages/);
assert.doesNotMatch(liveness, /adapter\?\.sendReminder|adapter\?\.projectReminder|conversation-reminder-sent|conversation-reminder-projected/);
assert.doesNotMatch(livenessCdp, /async sendReminder\(|async projectReminder\(|purpose:\s*"progress-reminder"|進度旁白提醒/);
assert.match(liveness, /tenMinuteAutomaticReminder:\s*false/);
assert.match(liveness, /tenMinuteSyntheticUserTurn:\s*false/);
assert.match(liveness, /twentyMinuteInterruptedTurnRescueOnly:\s*true/);
assert.match(liveness, /normalCompletionDisarms:\s*true/);
assert.match(livenessCdp, /export const INTERRUPTED_TURN_RESCUE_TEXT = "- 繼續"/);
assert.match(transportObserver, /kind:\s*"failed"[\s\S]{0,300}canceled:\s*params\?\.canceled === true/);

console.log(JSON.stringify({
  ok: true,
  gate: "conversation-authority-domain-static",
  progressAuthorityIsolated: true,
  capabilityAuthorityIsolated: true,
  exactPageInvocationJoin: true,
  exactGatewayRequestBinding: true,
  exactPageClaimRelay: true,
  durableSessionAuthorityRetired: true,
  runtimeAuthorityRetired: true,
  legacyProgressRowsDiagnosticOnly: true,
  preFixRescueEpisodesDisarmed: true,
  narrationAuthorityKey: "conversationId",
  narrationRuntimeBinding: false,
  tenMinuteAutomaticReminder: false,
  twentyMinuteInterruptedTurnRescueOnly: true,
  rescueText: "- 繼續",
  normalCompletionDisarms: true,
}));
