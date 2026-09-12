import assert from "node:assert/strict";
import {
  mergeSessionCorrelationFingerprints,
  sessionCorrelationFingerprintsFromHeaders,
  sessionCorrelationFingerprintsFromMcpExtra,
  sessionCorrelationFingerprintsFromValue,
  sessionsIntersect,
  _test,
} from "./session-correlation.js";

const sessionId = "9b5fcb28-405f-4f5e-8ee7-c6c23d509a4a";
const wrapped = JSON.stringify({ id: sessionId, issued_at: 1789156814527 });
const browser = sessionCorrelationFingerprintsFromHeaders({ "oai-session-id": sessionId });
const direct = sessionCorrelationFingerprintsFromHeaders({ "x-openai-session": wrapped });
assert.equal(browser.length, 1);
assert.equal(direct.length >= 2, true);
assert.equal(sessionsIntersect(browser, direct), true,
  "a bare browser UUID must match the same UUID wrapped by the server-side MCP session descriptor");
assert.equal(direct.includes(_test.digest(wrapped)), true, "the legacy full descriptor fingerprint remains available");
assert.equal(direct.includes(_test.digest(sessionId)), true, "the embedded session UUID receives an exact alias");

const urlWrapped = `session_id=${encodeURIComponent(sessionId)}&issued=1789156814527`;
assert.equal(sessionsIntersect(browser, sessionCorrelationFingerprintsFromValue(urlWrapped)), true);

const meta = sessionCorrelationFingerprintsFromMcpExtra({
  _meta: { "openai/session": wrapped },
  requestInfo: { headers: { "x-devspace-client-session-fingerprint": "a".repeat(64) } },
});
assert.equal(meta.includes("a".repeat(64)), true);
assert.equal(meta.includes(_test.digest(sessionId)), true);

assert.deepEqual(mergeSessionCorrelationFingerprints(browser, direct, ["not-a-digest"]),
  mergeSessionCorrelationFingerprints(direct, browser));
assert.equal(sessionsIntersect(browser, sessionCorrelationFingerprintsFromValue("different-session")), false);

const encoded = JSON.stringify({ browser, direct, meta });
assert.equal(encoded.includes(sessionId), false, "raw session identifiers must not leave the parser");
assert.equal(encoded.includes(wrapped), false, "raw wrapped descriptors must not leave the parser");

console.log(JSON.stringify({
  ok: true,
  gate: "session-correlation",
  wrappedDescriptorAlias: true,
  urlEncodedAlias: true,
  trustedFingerprintPreserved: true,
  rawSessionPersisted: false,
}));
