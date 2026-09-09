import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");
const authority = await readFile(new URL("../dist/classic-conversation-authority.js", import.meta.url), "utf8");
const cdp = await readFile(new URL("../dist/context-guardian-cdp.js", import.meta.url), "utf8");
const observer = await readFile(new URL("../dist/classic-turn-transport-observer.js", import.meta.url), "utf8");
const callCorrelation = await readFile(new URL("../dist/classic-mcp-call-correlation.js", import.meta.url), "utf8");
const requestContext = await readFile(new URL("../dist/mcp-conversation-request-context.js", import.meta.url), "utf8");

assert.match(server, /ClassicConversationAuthorityRegistry/, "server must instantiate the native conversation authority registry");
assert.match(server, /classic-conversation-authority\.json/, "authority evidence must persist under canonical state");
assert.match(server, /conversationAuthorityReady/, "server must gate first observation on persisted-registry load");
assert.match(server, /persistConversationIdentity/, "server must use one bounded persistence path for every native identity source");
assert.match(server, /observeNativeTurn\(\{[\s\S]*sessionFingerprint:\s*event\.sessionFingerprint[\s\S]*conversationId:\s*event\.conversationId/, "native identity callback must feed session fingerprint + conversation id to authority registry");
assert.match(server, /new ClassicMcpCallCorrelator\(\)/, "server must join native call_mcp conversation identity to the matching Gateway MCP call");
assert.match(server, /fingerprintMcpToolCall\(req\?\.body\)/, "Gateway MCP call fingerprint must be derived from the real JSON-RPC body");
assert.match(server, /requestConversationContext\.run\(/, "the exact Core HTTP request identity must propagate into the shared MCP tool handler");
assert.match(server, /requestContext\?\.sessionFingerprint/, "conversation-bound tools must prefer the request header fingerprint over incomplete SDK metadata");
assert.match(server, /conversationAuthority\.waitForFingerprint\(requestFingerprint,\s*\{\s*signal:\s*extra\?\.signal\s*\}\)/, "the first conversation-bound tool call must wait on its own request fingerprint and stop only when the host cancels that request");
assert.match(server, /onNativeMcpCall/, "always-on Classic observer must feed native call_mcp evidence into the correlator");
assert.match(server, /event\?\.sessionFingerprint[\s\S]*persistConversationIdentity\(event\)/, "a native call_mcp request carrying oai-session-id must bind its own conversation directly without temporal guessing");
assert.match(cdp, /Network\.requestWillBeSentExtraInfo/, "CDP must correlate final request headers from ExtraInfo");
assert.match(cdp, /ClassicTurnIdentityCorrelator/, "CDP must correlate request body and final headers by request id");
assert.match(cdp, /sessionFingerprint:\s*sessionFingerprintFromClassicRequest\(request\)/, "CDP native turn parser must emit only the hashed session fingerprint when available directly");
assert.match(observer, /parseNativeCallMcpRequest/, "native ChatGPT call_mcp requests must be observed without DOM inference");
assert.match(callCorrelation, /\/backend-api\/ecosystem\/call_mcp/, "correlation input must come from ChatGPT's native call_mcp route");
assert.match(callCorrelation, /sessionFingerprint:\s*sessionFingerprintFromClassicRequest\(request\)/, "native call_mcp parsing must hash the request's own OpenAI session header for direct conversation claim");
assert.match(callCorrelation, /canonicalArgumentHash|canonicalValue|fingerprintMcpToolCall/, "tool arguments must be joined by a canonical hash rather than persisted");
assert.match(callCorrelation, /candidatePairs/, "concurrent identical calls must use deterministic mutual-nearest pairing");
assert.match(callCorrelation, /candidatePairs\[0\]\.skewMs === candidatePairs\[1\]\.skewMs/, "true equal-distance correlation ties must still fail closed");
assert.match(requestContext, /AsyncLocalStorage/, "request-scoped identity propagation must be concurrency-safe and must not use globals");
assert.match(requestContext, /cross|current\(\)/i, "request context must expose only the active asynchronous call scope");
assert.doesNotMatch(callCorrelation, /localStorage|querySelector|document\.|location\./, "call correlation must remain transport-only");
assert.doesNotMatch(authority, /querySelector|document\.|location\.|Page\.reload|Page\.navigate/, "conversation authority registry must never depend on renderer state");

console.log(JSON.stringify({ ok: true, gate: "classic-conversation-authority-static", nativeTransportOnly: true, nativeCallMcpCorrelation: true, canonicalArgumentsHashedOnly: true, ambiguityFailsClosed: true, persisted: true }));
