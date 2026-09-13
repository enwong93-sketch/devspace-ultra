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
assert.match(server, /requestConversationContext\.run\(/,
  "verified authority must remain request-scoped through AsyncLocalStorage");
assert.match(server, /EXACT_CONVERSATION_REQUEST_PROOF/,
  "progress writes must carry a verifiable exact-conversation ownership proof");
assert.match(server, /resolved\?\.pageVerified !== true \|\| !resolved\?\.runtimeKey \|\| !resolved\?\.callFingerprint/,
  "progress narration must fail closed without exact page and invocation evidence");

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
assert.doesNotMatch(server, /activeTurnRegistry\.(?:resolveGatewayCall|waitForIdentity)\(/,
  "browser-turn trace telemetry remains useful for liveness but cannot authorize a direct MCP tool request");

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
assert.match(correlation, /if \(!distributedTraces\.length && !trace\) return null/,
  "active-turn authority requires an exact trace");
assert.doesNotMatch(correlation, /ClassicDirectRequestAuthorityRegistry/);
assert.doesNotMatch(correlation, /correlationKind = "session"|correlationKind = "session-alias"/,
  "session-only correlation is retired");
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
  durableDirectSessionAuthorityRetired: true,
  durableDirectTraceAuthorityRetired: true,
  runtimeAuthorityRetired: true,
  legacyUnprovedProgressHidden: true,
  preFixRescueEpisodesDisarmed: true,
  ambiguityFailsClosed: true,
}));
