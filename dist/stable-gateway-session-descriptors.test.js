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
    authorization: "Bearer MUST-NOT-PERSIST",
    backendSessionId: "backend-secret-ish",
  }]);
  const text = await readFile(path, "utf8");
  assert.doesNotMatch(text, /Bearer|MUST-NOT-PERSIST|backend-secret-ish/);
  const loaded = await loadStableGatewaySessionDescriptors(path);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].initialized, true);
  assert.equal(loaded[0].publicSessionId, "12345678-1234-1234-1234-123456789abc");
  console.log(JSON.stringify({ ok: true, gate: "stable-gateway-session-descriptors", credentialsPersisted: false, restartDurable: true }));
} finally {
  await rm(root, { recursive: true, force: true });
}
