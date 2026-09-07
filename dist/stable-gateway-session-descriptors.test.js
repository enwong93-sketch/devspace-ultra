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
      schemaFingerprint: null,
      toolCount: null,
    }],
  })));
  assert.equal((await loadStableGatewaySessionDescriptors(unknownV2Path)).length, 0, "version 2 descriptors without a known schema must also be dropped");
  console.log(JSON.stringify({ ok: true, gate: "stable-gateway-session-descriptors", credentialsPersisted: false, restartDurable: true, schemaRevisionPersisted: true, unknownSchemaDroppedAtStartup: true }));
} finally {
  await rm(root, { recursive: true, force: true });
}
