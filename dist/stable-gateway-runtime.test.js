import assert from "node:assert/strict";
import { StableGatewaySessionRegistry } from "./stable-gateway-runtime.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function testStableSessionMapping() {
  const registry = new StableGatewaySessionRegistry({ now: () => 123_456 });
  const publicSessionId = registry.registerInitialize({
    coreId: "core-a",
    backendSessionId: "backend-a-1",
    initializeBody: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    authorization: "Bearer top-secret",
  });

  assert.match(publicSessionId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(registry.lookup(publicSessionId), {
    publicSessionId,
    coreId: "core-a",
    backendSessionId: "backend-a-1",
    initializeBody: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    authorization: "Bearer top-secret",
    initialized: false,
    activeRequests: 0,
    lastActivityAt: 123_456,
  });

  assert.equal(registry.markInitialized(publicSessionId), true);
  assert.equal(registry.lookup(publicSessionId).initialized, true);
  assert.equal(typeof registry.updateAuthorization, "function", "Stable Gateway registry must support in-memory replay credential rotation after OAuth refresh");
  assert.equal(registry.updateAuthorization(publicSessionId, "Bearer refreshed-secret"), true);
  assert.equal(registry.lookup(publicSessionId).authorization, "Bearer refreshed-secret");
  assert.equal(registry.updateAuthorization("missing-session", "Bearer ignored"), false);
  assert.throws(() => registry.updateAuthorization(publicSessionId, ""), /authorization/i);
}

async function testActiveRequestAccountingAndDrain() {
  const registry = new StableGatewaySessionRegistry();
  const publicSessionId = registry.registerInitialize({
    coreId: "core-a",
    backendSessionId: "backend-a-1",
    initializeBody: { method: "initialize" },
    authorization: "Bearer secret",
  });

  const entry = await registry.acquire(publicSessionId);
  assert.equal(entry.backendSessionId, "backend-a-1");
  assert.equal(registry.lookup(publicSessionId).activeRequests, 1);

  registry.beginBarrier();
  let drained = false;
  const drainPromise = registry.waitForDrain(250).then(() => { drained = true; });
  await sleep(15);
  assert.equal(drained, false, "drain must wait for in-flight requests");

  assert.equal(registry.release(publicSessionId), true);
  await drainPromise;
  assert.equal(registry.lookup(publicSessionId).activeRequests, 0);
  registry.abortBarrier();
}

async function testBarrierQueuesAdmission() {
  const registry = new StableGatewaySessionRegistry();
  const publicSessionId = registry.registerInitialize({
    coreId: "core-a",
    backendSessionId: "backend-a-1",
    initializeBody: { method: "initialize" },
    authorization: "Bearer secret",
  });

  registry.beginBarrier();
  let admitted = false;
  const acquirePromise = registry.acquire(publicSessionId, { timeoutMs: 250 }).then((entry) => {
    admitted = true;
    return entry;
  });

  await sleep(15);
  assert.equal(admitted, false, "new requests must wait behind the handover barrier");
  registry.abortBarrier();
  const entry = await acquirePromise;
  assert.equal(entry.backendSessionId, "backend-a-1");
  assert.equal(admitted, true);
  registry.release(publicSessionId);
}

async function testAtomicMappingCommit() {
  const registry = new StableGatewaySessionRegistry();
  const first = registry.registerInitialize({
    coreId: "core-a",
    backendSessionId: "backend-a-1",
    initializeBody: { method: "initialize", id: 1 },
    authorization: "Bearer first-secret",
  });
  const second = registry.registerInitialize({
    coreId: "core-a",
    backendSessionId: "backend-a-2",
    initializeBody: { method: "initialize", id: 2 },
    authorization: "Bearer second-secret",
  });

  assert.throws(() => registry.commitMappings([
    { publicSessionId: first, coreId: "core-b", backendSessionId: "backend-b-1" },
    { publicSessionId: "missing-public-session", coreId: "core-b", backendSessionId: "backend-b-2" },
  ]), /Unknown public MCP session/);
  assert.equal(registry.lookup(first).coreId, "core-a", "failed commit must not partially mutate mappings");
  assert.equal(registry.lookup(second).coreId, "core-a", "failed commit must leave every mapping untouched");

  registry.commitMappings([
    { publicSessionId: first, coreId: "core-b", backendSessionId: "backend-b-1" },
    { publicSessionId: second, coreId: "core-b", backendSessionId: "backend-b-2" },
  ]);
  assert.equal(registry.lookup(first).backendSessionId, "backend-b-1");
  assert.equal(registry.lookup(second).backendSessionId, "backend-b-2");
}

async function testPublicSnapshotRedactsReplaySecrets() {
  const registry = new StableGatewaySessionRegistry();
  const publicSessionId = registry.registerInitialize({
    coreId: "core-a",
    backendSessionId: "backend-a-1",
    initializeBody: { jsonrpc: "2.0", id: 1, method: "initialize", params: { secretish: "raw-init-payload" } },
    authorization: "Bearer must-never-leak",
  });
  registry.markInitialized(publicSessionId);

  const snapshot = registry.snapshotPublic();
  const serialized = JSON.stringify(snapshot);
  assert.equal(snapshot.sessions.length, 1);
  assert.deepEqual(snapshot.sessions[0], {
    publicSessionId,
    coreId: "core-a",
    initialized: true,
    activeRequests: 0,
  });
  assert.doesNotMatch(serialized, /must-never-leak|raw-init-payload|backend-a-1/);
}

await testStableSessionMapping();
await testActiveRequestAccountingAndDrain();
await testBarrierQueuesAdmission();
{
  let now = 1_000;
  const registry = new StableGatewaySessionRegistry({ now: () => now });
  const older = registry.registerInitialize({ coreId: "core-a", backendSessionId: "backend-old", initializeBody: { method: "initialize" }, authorization: "Bearer old" });
  registry.markInitialized(older);
  now = 2_000;
  const newer = registry.registerInitialize({ coreId: "core-a", backendSessionId: "backend-new", initializeBody: { method: "initialize" }, authorization: "Bearer new" });
  registry.markInitialized(newer);
  now = 3_000;
  registry.updateAuthorization(newer, "Bearer refreshed-new");
  assert.deepEqual(registry.entriesForReplay().map((entry) => entry.publicSessionId), [newer, older], "handover baseline candidates must be ordered by latest real activity rather than registration order");
}

await testAtomicMappingCommit();
await testPublicSnapshotRedactsReplaySecrets();

{
  const registry = new StableGatewaySessionRegistry({ now: () => 10_000 });
  const publicSessionId = "12345678-1234-1234-1234-123456789abc";
  registry.restoreDescriptors([{
    publicSessionId,
    initializeBody: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    initialized: true,
    lastActivityAt: 9_000,
  }]);
  const restored = registry.lookup(publicSessionId);
  assert.equal(restored.coreId, "restored-unmapped");
  assert.equal(restored.authorization, "", "restored descriptors must never contain persisted OAuth credentials");
  assert.equal(restored.initialized, true);
  assert.equal(registry.snapshotDescriptors()[0].publicSessionId, publicSessionId);
}

{
  let now = 1_000;
  const registry = new StableGatewaySessionRegistry({
    now: () => now,
    idleRetentionMs: 2_000,
    maxRetainedSessions: 3,
    maxReplaySessions: 2,
  });
  const ids = [];
  for (let index = 0; index < 4; index += 1) {
    ids.push(registry.registerInitialize({
      coreId: "core-a",
      backendSessionId: `backend-${index}`,
      initializeBody: { method: "initialize", id: index },
      authorization: `Bearer token-${index}`,
    }));
    registry.markInitialized(ids.at(-1));
    now += 500;
  }
  assert.equal(registry.snapshotPublic().sessions.length, 3, "inactive public MCP session retention must be hard-bounded");
  assert.equal(registry.lookup(ids[0]), undefined, "oldest inactive session must be evicted first when the retention cap is exceeded");
  assert.deepEqual(registry.entriesForReplay().map((entry) => entry.publicSessionId), [ids[3], ids[2]], "Core replay must be capped to the most recently active sessions");
  now += 3_000;
  assert.equal(registry.entriesForReplay().length, 0, "expired inactive sessions must not be replayed after the retention TTL");
  assert.equal(registry.snapshotPublic().sessions.length, 0, "expired inactive sessions must be pruned from memory");
}

console.log(JSON.stringify({ ok: true, gate: "stable-gateway-runtime", boundedReplay: true }));
