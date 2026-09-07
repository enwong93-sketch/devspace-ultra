import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");
const authority = await readFile(new URL("../dist/classic-conversation-authority.js", import.meta.url), "utf8");
const cdp = await readFile(new URL("../dist/context-guardian-cdp.js", import.meta.url), "utf8");
const observer = await readFile(new URL("../dist/classic-turn-transport-observer.js", import.meta.url), "utf8");
const callCorrelation = await readFile(new URL("../dist/classic-mcp-call-correlation.js", import.meta.url), "utf8");

assert.match(server, /ClassicConversationAuthorityRegistry/, "server must instantiate the native conversation authority registry");
assert.match(server, /classic-conversation-authority\.json/, "authority evidence must persist under canonical state");
assert.match(server, /conversationAuthorityReady/, "server must gate first observation on persisted-registry load");
assert.match(server, /persistConversationIdentity/, "server must use one bounded persistence path for every native identity source");
assert.match(server, /observeNativeTurn\(\{[\s\S]*sessionFingerprint:\s*event\.sessionFingerprint[\s\S]*conversationId:\s*event\.conversationId/, "native identity callback must feed session fingerprint + conversation id to authority registry");
assert.match(server, /new ClassicMcpCallCorrelator\(\)/, "server must join native call_mcp conversation identity to the matching Gateway MCP call");
assert.match(server, /fingerprintMcpToolCall\(req\?\.body\)/, "Gateway MCP call fingerprint must be derived from the real JSON-RPC body");
assert.match(server, /waitForIdentity\(\{ callFingerprint, sessionFingerprint, timeoutMs:\s*1_000 \}\)/, "first tool call should wait briefly for the native CDP correlation rather than require a second call");
assert.match(server, /onNativeMcpCall/, "always-on Classic observer must feed native call_mcp evidence into the correlator");
assert.match(cdp, /Network\.requestWillBeSentExtraInfo/, "CDP must correlate final request headers from ExtraInfo");
assert.match(cdp, /ClassicTurnIdentityCorrelator/, "CDP must correlate request body and final headers by request id");
assert.match(cdp, /sessionFingerprint:\s*sessionFingerprintFromClassicRequest\(request\)/, "CDP native turn parser must emit only the hashed session fingerprint when available directly");
assert.match(observer, /parseNativeCallMcpRequest/, "native ChatGPT call_mcp requests must be observed without DOM inference");
assert.match(callCorrelation, /\/backend-api\/ecosystem\/call_mcp/, "correlation input must come from ChatGPT's native call_mcp route");
assert.match(callCorrelation, /canonicalArgumentHash|canonicalValue|fingerprintMcpToolCall/, "tool arguments must be joined by a canonical hash rather than persisted");
assert.match(callCorrelation, /pairs\.length !== 1/, "ambiguous concurrent correlations must fail closed");
assert.doesNotMatch(callCorrelation, /localStorage|querySelector|document\.|location\./, "call correlation must remain transport-only");
assert.doesNotMatch(authority, /querySelector|document\.|location\.|Page\.reload|Page\.navigate/, "conversation authority registry must never depend on renderer state");

console.log(JSON.stringify({ ok: true, gate: "classic-conversation-authority-static", nativeTransportOnly: true, nativeCallMcpCorrelation: true, canonicalArgumentsHashedOnly: true, ambiguityFailsClosed: true, persisted: true }));
