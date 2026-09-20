import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");
const authority = await readFile(new URL("../dist/classic-conversation-authority.js", import.meta.url), "utf8");
const observer = await readFile(new URL("../dist/classic-turn-transport-observer.js", import.meta.url), "utf8");
const toolStream = await readFile(new URL("../dist/classic-tool-invocation-stream.js", import.meta.url), "utf8");
const correlation = await readFile(new URL("../dist/classic-mcp-call-correlation.js", import.meta.url), "utf8");
const progressProof = await readFile(new URL("../dist/progress-ownership-proof.js", import.meta.url), "utf8");
const progressOverlay = await readFile(new URL("../dist/classic-progress-narration-overlay.js", import.meta.url), "utf8");
const progressLiveness = await readFile(new URL("../dist/conversation-progress-liveness.js", import.meta.url), "utf8");
const requestContext = await readFile(new URL("../dist/mcp-conversation-request-context.js", import.meta.url), "utf8");

assert.match(server, /new ClassicMcpCallCorrelator\(\)/,
  "every direct tool request must use the bounded canonical call correlator");
assert.match(server, /onToolInvocation:\s*\(event\)/,
  "the exact page-local ChatGPT tool stream must feed native correlation evidence");
assert.match(server, /mcpCallCorrelator\.noteNative\(event\)/);
assert.match(server, /fingerprintMcpToolCall\(req\?\.body\)/,
  "Gateway calls must use the same canonical tool-name/arguments hash as the page stream");
assert.match(server, /progressLivenessAdapter\.find\(\{[\s\S]*conversationId:\s*candidate\.conversationId/,
  "correlated authority must still verify one globally unique exact conversation page");
assert.match(server, /page\.runtimeKey !== candidateRuntimeKey/,
  "Runtime may verify the physical locator but cannot select the owner");
assert.match(server, /page\.progressCardMounted === true && page\.progressConversationId !== candidate\.conversationId/,
  "a card mounted for another conversation must fail closed");
assert.match(server, /page\.generating !== true/,
  "stale idle pages cannot authorize a new direct tool call");
assert.match(server, /mcpCallCorrelator\.waitForIdentity\(/,
  "late page-local invocation evidence may satisfy only the current bounded request waiter");
assert.match(server, /activeTurnRegistry\.resolveGatewayCall\(/,
  "one unique request-owned active-turn session alias may resolve direct tools when browser trace headers are absent");
assert.match(server, /activeTurnRegistry\.waitForIdentity\(/,
  "active-turn session correlation must remain bounded to the current request");
assert.match(server, /sessionCorrelationFingerprintsFromHeaders\(req\?\.headers \|\| \{\}\)/,
  "the direct request must contribute only hashed session aliases to active-turn correlation");
assert.match(server, /const nativeSession = conversationAuthority\.resolveFingerprint\(sessionFingerprint\)/,
  "a previously exact native ChatGPT session mapping may recover server-side connector calls");
assert.match(server, /source:\s*"classic-native-session-page-verified"/,
  "native session recovery must still pass exact live-page verification");
const nativeSessionRecoveryStart = server.indexOf("const nativeSession = conversationAuthority.resolveFingerprint(sessionFingerprint)");
const nativeSessionRecoveryEnd = server.indexOf("if (!capabilityAuthority?.conversationId && !progressAuthority?.conversationId)", nativeSessionRecoveryStart + 1);
assert.ok(nativeSessionRecoveryStart >= 0 && nativeSessionRecoveryEnd > nativeSessionRecoveryStart);
const nativeSessionRecovery = server.slice(nativeSessionRecoveryStart, nativeSessionRecoveryEnd);
assert.doesNotMatch(nativeSessionRecovery, /observeNativeTurn|waitForFingerprint|observeVerifiedDirectSession/,
  "a direct Gateway request must never create, refresh, or wait for native session ownership");
assert.match(server, /requestConversationContext\.run\(/,
  "verified authority must remain request-scoped through AsyncLocalStorage");
assert.match(server, /EXACT_CONVERSATION_REQUEST_PROOF/,
  "progress writes must carry a verifiable exact-conversation ownership proof");
assert.match(server, /EXACT_PAGE_CLAIM_PROOF/,
  "the v0.5.8 compatibility relay must preserve a distinct exact-page claim proof instead of weakening direct request authority");
assert.match(server, /const exactRequest = Boolean\([\s\S]{0,320}resolved\?\.callFingerprint[\s\S]{0,220}endsWith\("-page-verified"\)/,
  "ordinary progress narration must still require exact page plus canonical invocation evidence");
assert.match(server, /const exactPageClaim = Boolean\([\s\S]{0,320}resolved\?\.claimId[\s\S]{0,220}classic-exact-page-progress-claim-cdp-page-verified/,
  "only the one-time hidden iframe-parent claim may bypass a missing call fingerprint");
assert.match(server, /if \(!exactRequest && !exactPageClaim && !providerBound\)/,
  'progress must require a native request proof, exact receipt, or authenticated provider-conversation binding with current page verification');
assert.match(server, /const providerIdentity = openaiConversationIdentity\(\{ auth: req\.auth, meta: req\.body\?\.params\?\._meta, headers: req\.headers \}\)/,
  'provider identity must come from the OAuth-accepted host metadata, never tool arguments or MCP transport session id');
assert.match(server, /await openaiBindings\.resolve\(providerIdentity\)/,
  'documented anonymous conversation bindings must revalidate their current exact page per request');

assert.doesNotMatch(server, /ClassicDirectRequestAuthorityRegistry/,
  "the retired cross-request trace authority cache must not remain in production source");
assert.doesNotMatch(server, /resolveVerifiedDirectSession\(/,
  "a host direct-session descriptor must not be reused as conversation authority");
assert.doesNotMatch(server, /persistVerifiedDirectSessionIdentity/,
  "direct request authority must never be persisted for a later conversation");
assert.doesNotMatch(server, /conversationAuthority\.waitForFingerprint\(sessionFingerprint/,
  "progress must not wait for or adopt a durable session mapping");
assert.doesNotMatch(server, /runtimeKeyHint:\s*persistedRuntimeKey/,
  "a persisted Runtime must not select conversation ownership");

assert.match(observer, /Network\.webSocketFrameReceived/,
  "the observer must consume ChatGPT's exact page-local tool stream");
assert.match(observer, /Network\.streamResourceContent/,
  "direct ChatGPT response streams must expose page-local tool invocations without DOM guessing");
assert.match(observer, /Network\.dataReceived/);
assert.match(observer, /Page\.navigatedWithinDocument/,
  "SPA route changes must update the exact conversation route");
assert.match(observer, /ClassicToolInvocationStreamTracker/);
assert.match(toolStream, /recipient === "api_tool\.call_tool"/);
assert.match(toolStream, /DevSpace Local Gateway/);
assert.match(toolStream, /fingerprintMcpToolCall\("tools\/call"/);
assert.match(toolStream, /rawArgumentsPersisted:\s*false/);
assert.match(toolStream, /rawMessageIdsPersisted:\s*false/);

assert.match(correlation, /candidatePairs/,
  "identical concurrent invocations require deterministic mutual-nearest matching");
assert.match(correlation, /candidatePairs\[0\]\.skewMs === candidatePairs\[1\]\.skewMs/,
  "equal-distance ambiguity must fail closed");
assert.match(correlation, /requestSessionAliases/,
  "active-turn authority may use only request-owned hashed session aliases");
assert.match(correlation, /entry\.finishedAtMs !== null && entry\.finishedAtMs !== undefined/,
  "session-only authority must expire immediately when the assistant turn completes");
assert.doesNotMatch(correlation, /ClassicDirectRequestAuthorityRegistry/);
assert.match(correlation, /correlationKind = "active-session-alias"/,
  "a unique active-turn session alias must be explicit and request-scoped");
assert.doesNotMatch(correlation, /correlationKind = "runtime-tool"|deferred-placeholder-correlation/,
  "Runtime and placeholder-only correlation are retired");

assert.doesNotMatch(authority, /observeVerifiedDirectSession|resolveVerifiedDirectSession/,
  "legacy durable direct-session writer and lookup must be removed");
assert.match(authority, /verifiedDirectSession:\s*false/,
  "legacy persisted direct-session flags are retired during load");
assert.match(progressProof, /exact-conversation-request-v1/);
assert.match(progressProof, /exact-page-compatibility-bridge-v1/);
assert.match(progressOverlay, /isProjectableProgressMessage/,
  "unproved historical rows must not be projected into any card");
assert.match(progressLiveness, /persistedVersion >= 4/,
  "pre-fix rescue episodes must be disarmed after deployment");
assert.match(progressLiveness, /isProjectableProgressMessage/,
  "unproved rows must not disarm or delay another conversation's rescue");
assert.match(requestContext, /AsyncLocalStorage/);

console.log(JSON.stringify({
  ok: true,
  gate: "classic-conversation-authority-static",
  exactPageToolInvocationAuthority: true,
  canonicalArgumentsHashedOnly: true,
  requestScopedAuthority: true,
  activeTurnSessionAliasBounded: true,
  exactNativeSessionPageRecovery: true,
  durableDirectSessionAuthorityRetired: true,
  durableDirectTraceAuthorityRetired: true,
  runtimeAuthorityRetired: true,
  legacyUnprovedProgressHidden: true,
  preFixRescueEpisodesDisarmed: true,
  ambiguityFailsClosed: true,
}));
