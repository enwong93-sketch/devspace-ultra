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
const startClaims = await readFile(new URL("../dist/conversation-start-claim-registry.js", import.meta.url), "utf8");
const progressRelay = await readFile(new URL("../dist/ui/progress-claim-relay.html", import.meta.url), "utf8");
const claimCdp = await readFile(new URL("../dist/conversation-start-claim-cdp.js", import.meta.url), "utf8");

assert.match(server, /const resolveCapabilityConversationAuthority = async \(extra\) =>/);
assert.match(server, /const resolveProgressConversationAuthority = async \(extra\) =>/);
assert.match(server, /const resolveConversationAuthority = resolveCapabilityConversationAuthority;/);
assert.match(server, /const resolveConversation = resolveCapabilityConversationAuthority;/);
assert.match(server, /const resolveProgressConversation = resolveProgressConversationAuthority;/);
assert.match(server, /registerAppTool\(server, "devspace_progress_report"[\s\S]*const resolved = await resolveProgressConversation\(extra\);/);
assert.match(server, /resourceUri:\s*PROGRESS_CLAIM_RELAY_URI/);
assert.match(server, /resourceUri:\s*PROGRESS_CLAIM_RELAY_URI,[\s\S]{0,800}visibility:\s*\["model",\s*"app"\]/,
  "the progress relay must be callable by the exact page MCP App as well as the model");
assert.match(server, /progressClaimRegistry\.create\(\{[\s\S]{0,260}message:\s*reportMessage,[\s\S]{0,180}kind,[\s\S]{0,260}requestBinding:[\s\S]{0,180}sessionFingerprint:\s*currentRequestContext\?\.sessionFingerprint/,
  "pending progress must retain only the hashed request session needed for a short-lived cached-schema bootstrap lease");
assert.match(server, /claimId:\s*z\.string\(\)\.min\(16\)\.max\(200\)\.optional\(\)/);
assert.match(server, /progressClaimRegistry\.claim\(/);
assert.match(server, /ConversationStartClaimCdpResolver/,
  "pending narration must recover exact page ownership from the mounted claim iframe when app callTool has no request correlation");
assert.match(server, /resolveProgressClaimPage\?\.\(relayClaimId\)/);
assert.match(server, /EXACT_PAGE_CLAIM_PROOF/);
assert.match(server, /claimPendingProgressFromExactPage/,
  "pending Agent narration must complete from exact iframe-parent authority even when app callTool fails");
assert.match(server, /void claimPendingProgressFromExactPage\(progressClaim\)/);
assert.match(server, /progressClaimRegistry\.pendingClaims\(\{ limit: 8 \}\)/,
  "a bounded background sweep must keep resolving claims that mount after the initial tool handler has returned");
assert.match(server, /setInterval\(\(\) => \{ void sweepPendingProgressClaims\(\); \}, 1_000\)/);
assert.match(server, /conversationStartClaimRegistry\.pendingClaims\(\{ limit: 8 \}\)/,
  "Goal\/Plan bootstrap claims must also be swept only from bounded exact-page pending state");
assert.match(server, /setInterval\(\(\) => \{ void sweepPendingConversationStartClaims\(\); \}, 1_000\)/);
assert.match(server, /new ProgressBootstrapAuthorityRegistry\(\)/,
  "cached Goal\/Plan bootstrap must use a bounded short-lived in-memory registry");
assert.match(server, /progressBootstrapAuthority\?\.register\?\.\(\{[\s\S]{0,300}sessionFingerprint:\s*bootstrapSessionFingerprint/,
  "only a successfully persisted exact progress report may mint a cached-schema bootstrap lease");
assert.match(server, /progressBootstrapAuthority\?\.consume\?\.\(\{[\s\S]{0,200}sessionFingerprint:\s*requestContext\?\.sessionFingerprint,[\s\S]{0,120}toolName/,
  "Goal\/Plan bootstrap must consume the lease through the current request's hashed session only");
assert.match(server, /outputSchema:[\s\S]{0,1200}progressClaim:\s*z\.object\(/,
  "progress tool must declare the structured claim output so ChatGPT can hydrate the relay App");
assert.match(server, /"devspace\/progressClaim":\s*progressClaim/,
  "pending progress must mirror only the opaque claim descriptor into app-only result metadata");

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
assert.match(server, /acceptVerifiedAuthority\(await verifyCorrelatedIdentity\(correlated, \{ requireGenerating: false \}\)\)/,
  "an exact canonical page-local tool invocation must not be rejected only because the visible generating affordance dropped at a tool boundary");
assert.match(server, /acceptVerifiedAuthority\(await verifyCorrelatedIdentity\(activeTurn, \{ requireGenerating: true \}\)\)/,
  "weaker active-turn/session fallback evidence must still require a currently generating exact page");
assert.match(server, /mcpCallCorrelator\.waitForIdentity\([\s\S]{0,700}verifyCorrelatedIdentity\(identity, \{ requireGenerating: false \}\)/,
  "a delayed exact invocation join must use the same idle-tool-boundary rule as the immediate join");
assert.match(server, /progressLivenessAdapter\.find\(\{[\s\S]*conversationId:\s*candidate\.conversationId/);
assert.match(server, /page\.runtimeKey !== candidateRuntimeKey/);
assert.match(server, /page\.progressCardMounted === true && page\.progressConversationId !== candidate\.conversationId/);
assert.match(server, /const exactPageClaim = Boolean\(/);
assert.match(server, /const exactRequest = Boolean\(/);
assert.match(server, /ownershipProof,\s*ownershipSource:\s*resolved\.source/);
assert.match(progressClaims, /exact page-verified conversation authority/);
assert.match(progressClaims, /another conversation page/);
assert.match(progressClaims, /durableConversationOwners:\s*0/);
assert.match(progressRelay, /toolName:\s*"devspace_progress_report"/);
assert.match(progressRelay, /startClaim\.toolName === "devspace_goal_start"/);
assert.match(progressRelay, /startClaim\.toolName === "devspace_plan_start"/);
assert.match(progressRelay, /window\.openai\.callTool\(action\.toolName, action\.arguments\)/);
assert.match(progressRelay, /window\.openai\?\.toolResponseMetadata/,
  "claim relay must accept result metadata when toolOutput is null");
assert.match(progressRelay, /window\.openai\?\.requestClose/,
  "failed one-shot relay iframes must retire instead of exhausting ChatGPT app render slots");
assert.match(progressRelay, /devspace\/conversationStartClaim/);
assert.match(startClaims, /devspace_goal_start/);
assert.match(startClaims, /devspace_plan_start/);
assert.match(startClaims, /exact page-verified conversation authority/);
assert.match(startClaims, /rawInputsExposed:\s*false/);
assert.match(claimCdp, /chooseAppContext/);
assert.match(claimCdp, /classic-exact-page-progress-claim-cdp-page-verified/);
assert.match(claimCdp, /classic-exact-page-start-claim-cdp-page-verified/);
assert.match(claimCdp, /parentId/);
assert.doesNotMatch(claimCdp, /Page\.navigate|Page\.reload|location\.href\s*=/,
  "exact-page claim recovery must remain read-only and never navigate a Main");
assert.match(server, /conversationStartClaimRelay/,
  "Goal\/Plan relay retries must bypass the ordinary substantive-tool progress gate");
assert.doesNotMatch(progressRelay, /sendFollowUpMessage|prompt-textarea|composer/);

assert.doesNotMatch(server, /resolveVerifiedDirectSession\(|persistVerifiedDirectSessionIdentity|directRequestAuthorityRegistry/,
  "durable direct-session and direct-trace authority is retired");
assert.doesNotMatch(server, /conversationAuthority\.waitForFingerprint\(sessionFingerprint/,
  "progress must not wait for a reusable session owner");
assert.doesNotMatch(server, /runtimeKeyHint:\s*persistedRuntimeKey/,
  "Runtime is not a conversation owner");
assert.match(server, /activeTurnRegistry\.resolveGatewayCall\(/,
  "the request may correlate to one unique currently active browser turn");
assert.match(server, /activeTurnRegistry\.waitForIdentity\(/,
  "active-turn correlation must remain bounded to the current request");
assert.match(server, /sessionCorrelationFingerprintsFromHeaders\(req\?\.headers \|\| \{\}\)/,
  "only request-owned hashed session aliases may be used as fallback evidence");
assert.match(server, /conversationAuthority\.resolveFingerprint\(sessionFingerprint\)/,
  "exact native ChatGPT session history may be reused only as an input to current page verification");
assert.match(server, /requireCurrentSession:\s*true[\s\S]*source:\s*"classic-native-session-page-verified"/,
  "native session recovery must verify the current request and exact page before entering any authority domain");
assert.doesNotMatch(server, /verifyProgressConversationAuthority/,
  "the retired session/page fallback module must not remain wired");

assert.match(requestContext, /capabilityAuthority/);
assert.match(requestContext, /progressAuthority/);
assert.match(requestContext, /progressAuthorityPromise/);
assert.match(requestContext, /AsyncLocalStorage/);
assert.match(correlation, /requestSessionAliases/);
assert.match(correlation, /correlationKind = "active-session-alias"/);
assert.doesNotMatch(correlation, /correlationKind = "runtime-tool"/);
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
assert.match(liveness, /restart-interrupted/,
  "an active exact-conversation episode restored after Core replacement must carry restart interruption evidence");
assert.match(liveness, /restartRestoresActiveEpisodeAsInterrupted:\s*true/);
assert.match(liveness, /stalledGeneratingSilenceRescue:\s*true/,
  "twenty minutes of exact-page generating silence must become bounded stalled-generation rescue evidence");
assert.match(liveness, /substantiveToolActivityResetsRescueClock:\s*true/,
  "fresh substantive tool activity must reset only that conversation's rescue clock");
assert.match(liveness, /"stalled-generating"/);
assert.match(liveness, /record\.interruptedAt = value\?\.interruptedAt[\s\S]{0,260}value\?\.lastActivityAt/,
  "Core restart evidence must preserve the pre-restart activity anchor instead of restarting the twenty-minute clock");
assert.match(liveness, /event\?\.transportOnly === true[\s\S]{0,500}conversation-turn-transport-finished-nonterminal/,
  "HTTP transport completion must remain non-terminal for long tool-using assistant turns");
assert.match(liveness, /resetInterruptedGeneration/,
  "an authoritative interrupted turn may reset one stale generating affordance only after the twenty-minute rescue gate");
assert.match(livenessCdp, /async resetInterruptedGeneration\(/);
assert.match(livenessCdp, /stale-generating-stop-clicked/);
assert.match(livenessCdp, /export const INTERRUPTED_TURN_RESCUE_TEXT = "- 繼續"/);
assert.match(transportObserver, /kind:\s*"failed"[\s\S]{0,300}canceled:\s*params\?\.canceled === true/);

console.log(JSON.stringify({
  ok: true,
  gate: "conversation-authority-domain-static",
  progressAuthorityIsolated: true,
  capabilityAuthorityIsolated: true,
  exactPageInvocationJoin: true,
  exactGatewayRequestBinding: true,
  exactInvocationMayCrossIdleToolBoundary: true,
  exactPageClaimRelay: true,
  activeTurnSessionAliasBounded: true,
  exactNativeSessionPageRecovery: true,
  durableSessionAuthorityRetired: true,
  runtimeAuthorityRetired: true,
  legacyProgressRowsDiagnosticOnly: true,
  preFixRescueEpisodesDisarmed: true,
  narrationAuthorityKey: "conversationId",
  narrationRuntimeBinding: false,
  tenMinuteAutomaticReminder: false,
  twentyMinuteInterruptedTurnRescueOnly: true,
  transportOnlyCompletionNonTerminal: true,
  staleGeneratingInterruptedTurnRecoverable: true,
  stalledGeneratingSilenceRecoverable: true,
  substantiveToolActivityResetsRescueClock: true,
  coreRestartPreservesElapsedRescueClock: true,
  restartRestoresActiveEpisodeAsInterrupted: true,
  rescueText: "- 繼續",
  normalCompletionDisarms: true,
}));
