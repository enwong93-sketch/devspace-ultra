import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStableGatewaySessionDescriptors, saveStableGatewaySessionDescriptors } from "./stable-gateway-session-descriptors.js";

const root = await mkdtemp(join(tmpdir(), "devspace-gateway-descriptors-"));
try {
  const path = join(root, "sessions.json");
  await saveStableGatewaySessionDescriptors(path, [{
    publicSessionId: "12345678-1234-1234-1234-123456789abc",
    initializeBody: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", clientInfo: { name: "test", version: "1" } } },
    initialized: true,
    lastActivityAt: 1234,
    clientSessionFingerprint: "c".repeat(64),
    schemaFingerprint: "a".repeat(64),
    toolCount: 116,
    authorization: "Bearer MUST-NOT-PERSIST",
    backendSessionId: "backend-secret-ish",
  }]);
  const text = await readFile(path, "utf8");
  assert.doesNotMatch(text, /Bearer|MUST-NOT-PERSIST|backend-secret-ish/);
  const loaded = await loadStableGatewaySessionDescriptors(path);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].initialized, true);
  assert.equal(loaded[0].publicSessionId, "12345678-1234-1234-1234-123456789abc");
  assert.equal(loaded[0].clientSessionFingerprint, "c".repeat(64));
  assert.equal(loaded[0].schemaFingerprint, "a".repeat(64));
  assert.equal(loaded[0].toolCount, 116);

  const legacyPath = join(root, "legacy-sessions.json");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(legacyPath, JSON.stringify({
    version: 1,
    descriptors: [{
      publicSessionId: "22345678-1234-1234-1234-123456789abc",
      initializeBody: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      initialized: true,
      lastActivityAt: 5678,
    }],
  })));
  const legacy = await loadStableGatewaySessionDescriptors(legacyPath);
  assert.equal(legacy.length, 0, "initialized legacy descriptors without a tool fingerprint must be dropped at startup");

  const unknownV2Path = join(root, "unknown-v2-sessions.json");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(unknownV2Path, JSON.stringify({
    version: 2,
    descriptors: [{
      publicSessionId: "32345678-1234-1234-1234-123456789abc",
      initializeBody: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      initialized: true,
      lastActivityAt: 6789,
      schemaFingerprint: "b".repeat(64),
      toolCount: 119,
    }],
  })));
  assert.equal((await loadStableGatewaySessionDescriptors(unknownV2Path)).length, 0, "pre-v3 descriptors must be dropped once because they lack the client-session key needed for event-driven supersession");

  const boundedPath = join(root, "bounded-sessions.json");
  const many = Array.from({ length: 600 }, (_, index) => ({
    publicSessionId: `${String(index).padStart(8, "0")}-1234-1234-1234-123456789abc`,
    initializeBody: { jsonrpc: "2.0", id: index, method: "initialize", params: {} },
    initialized: true,
    lastActivityAt: index,
    clientSessionFingerprint: index >= 598 ? "d".repeat(64) : null,
    schemaFingerprint: "e".repeat(64),
    toolCount: 119,
  }));
  await saveStableGatewaySessionDescriptors(boundedPath, many);
  const bounded = await loadStableGatewaySessionDescriptors(boundedPath);
  assert.equal(bounded.length, 512, "restart descriptors must have a hard persistence cap");
  assert.equal(bounded[0].lastActivityAt, 599, "newest descriptors must survive the cap");
  assert.equal(bounded.some((item) => item.publicSessionId.startsWith("00000599-")), true,
    "the newest descriptor for a repeated client fingerprint must survive");
  assert.equal(bounded.some((item) => item.publicSessionId.startsWith("00000598-")), false,
    "older duplicate client descriptors must not accumulate indefinitely");
  console.log(JSON.stringify({ ok: true, gate: "stable-gateway-session-descriptors", credentialsPersisted: false, restartDurable: true, clientSessionFingerprintPersisted: true, legacyDescriptorReset: true, schemaRevisionPersisted: true, boundedPersistence: 512, duplicateClientsCollapsed: true }));
} finally {
  await rm(root, { recursive: true, force: true });
}
