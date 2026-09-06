import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");
const authority = await readFile(new URL("../dist/classic-conversation-authority.js", import.meta.url), "utf8");
const cdp = await readFile(new URL("../dist/context-guardian-cdp.js", import.meta.url), "utf8");

assert.match(server, /ClassicConversationAuthorityRegistry/, "server must instantiate the native conversation authority registry");
assert.match(server, /classic-conversation-authority\.json/, "authority evidence must persist under canonical state");
assert.match(server, /conversationAuthorityReady/, "server must gate first observation on persisted-registry load");
assert.match(server, /onConversationIdentity:\s*async\s*\(event\)/, "server must consume a dedicated native conversation-identity event rather than overload turn metadata");
assert.match(server, /observeNativeTurn\(\{[\s\S]*sessionFingerprint:\s*event\.sessionFingerprint[\s\S]*conversationId:\s*event\.conversationId/, "native identity callback must feed session fingerprint + conversation id to authority registry");
assert.match(cdp, /Network\.requestWillBeSentExtraInfo/, "CDP must correlate final request headers from ExtraInfo");
assert.match(cdp, /ClassicTurnIdentityCorrelator/, "CDP must correlate request body and final headers by request id");
assert.match(cdp, /sessionFingerprint:\s*sessionFingerprintFromClassicRequest\(request\)/, "CDP native turn parser must emit only the hashed session fingerprint when available directly");
assert.doesNotMatch(authority, /querySelector|document\.|location\.|Page\.reload|Page\.navigate/, "conversation authority registry must never depend on renderer state");

console.log(JSON.stringify({ ok: true, gate: "classic-conversation-authority-static", nativeTransportOnly: true, persisted: true }));
