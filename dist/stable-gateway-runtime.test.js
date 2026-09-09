import assert from "node:assert/strict";
import { StableGatewaySessionRegistry } from "./stable-gateway-runtime.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createSession(registry, index = 1) {
  return registry.registerInitialize({
    coreId: "core-a",
    backendSessionId: `backend-a-${index}`,
    initializeBody: { jsonrpc: "2.0", id: index, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    authorization: `Bearer secret-${index}`,
  });
}

async function testStableSessionMapping() {
  const registry = new StableGatewaySessionRegistry({ now: () => 123_456 });
  const publicSessionId = createSession(registry);
  assert.match(publicSessionId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(registry.lookup(publicSessionId), {
    publicSessionId,
    coreId: "core-a",
    backendSessionId: "backend-a-1",
    initializeBody: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    authorization: "Bearer secret-1",
    initialized: false,
    activeRequests: 0,
    eventStreams: 0,
    disconnectObserved: false,
    clientSessionFingerprint: null,
    lastActivityAt: 123_456,
    schemaFingerprint: null,
    toolCount: null,
  });
  assert.equal(registry.markInitialized(publicSessionId), true);
  assert.equal(registry.updateAuthorization(publicSessionId, "Bearer refreshed-secret"), true);
  assert.equal(registry.updateSchema(publicSessionId, { schemaFingerprint: "a".repeat(64), toolCount: 117 }), true);
  assert.equal(registry.lookup(publicSessionId).authorization, "Bearer refreshed-secret");
  assert.equal(registry.lookup(publicSessionId).toolCount, 117);
}

async function testAdmissionAndDrainHaveNoDeadline() {
  const registry = new StableGatewaySessionRegistry();
  const publicSessionId = createSession(registry);
  assert.ok(await registry.acquire(publicSessionId));
  registry.beginBarrier();

  let admitted = false;
  const queued = registry.acquire(publicSessionId, { timeoutMs: 1 }).then((entry) => {
    admitted = true;
    return entry;
  });
  let drained = false;
  const drain = registry.waitForDrain(1).then(() => { drained = true; });
  await sleep(20);
  assert.equal(admitted, false, "legacy timeout arguments must not terminate queued admission");
  assert.equal(drained, false, "legacy timeout arguments must not terminate drain waiting");

  registry.release(publicSessionId);
  await drain;
  assert.equal(drained, true);
  registry.abortBarrier();
  assert.ok(await queued);
  registry.release(publicSessionId);
}

async function testEventStreamLifecycle() {
  const registry = new StableGatewaySessionRegistry();
  const publicSessionId = createSession(registry);
  assert.equal(registry.markEventStreamOpen(publicSessionId), true);
  assert.equal(registry.lookup(publicSessionId).eventStreams, 1);
  assert.ok(await registry.acquire(publicSessionId));
  registry.markEventStreamClosed(publicSessionId, { disconnected: true });
  const disconnected = registry.lookup(publicSessionId);
  assert.ok(disconnected, "an SSE reconnect boundary must preserve the public descriptor");
  assert.equal(disconnected.coreId, "unmapped");
  assert.equal(disconnected.backendSessionId, "unmapped");
  registry.release(publicSessionId);
  assert.ok(registry.lookup(publicSessionId), "draining the old Core request must not revoke the public conversation session");
  registry.commitMappings([{ publicSessionId, coreId: "core-b", backendSessionId: "backend-b" }]);
  assert.equal(registry.lookup(publicSessionId).disconnectObserved, false, "successful lazy resurrection must mark the descriptor live again");

  const retained = createSession(registry, 2);
  registry.markEventStreamOpen(retained);
  registry.markEventStreamClosed(retained, { disconnected: false });
  assert.ok(registry.lookup(retained), "an upstream Core stream ending during handover must retain public identity for reconnect");
}

async function testClientSessionSupersession() {
  const registry = new StableGatewaySessionRegistry();
  const clientSessionFingerprint = "f".repeat(64);
  const first = registry.registerInitialize({
    coreId: "core-a",
    backendSessionId: "backend-first",
    initializeBody: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    authorization: "Bearer shared-owner",
    clientSessionFingerprint,
  });
  registry.markEventStreamOpen(first);
  const second = registry.registerInitialize({
    coreId: "core-a",
    backendSessionId: "backend-second",
    initializeBody: { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    authorization: "Bearer shared-owner",
    clientSessionFingerprint,
  });
  assert.equal(first, second, "the same OpenAI client session must retain one stable public session id across reconnect initialization");
  assert.equal(registry.snapshotPublic().sessions.length, 1, "a reconnect initialize must update the existing logical descriptor even while an old SSE stream is draining");
  assert.equal(registry.resolvePublicSessionId(first, clientSessionFingerprint), first);
  assert.equal(registry.lookup(first, clientSessionFingerprint)?.backendSessionId, "backend-second");
  assert.equal(registry.lookup(first)?.eventStreams, 1, "reinitialization must not lose accounting for the still-draining prior event stream");
}

async function testNoArtificialRetentionOrReplayCap() {
  const registry = new StableGatewaySessionRegistry({
    idleRetentionMs: 1,
    maxRetainedSessions: 1,
    maxReplaySessions: 1,
  });
  const ids = [];
  for (let index = 0; index < 300; index += 1) {
    const id = createSession(registry, index + 1);
    ids.push(id);
    registry.markInitialized(id);
  }
  assert.equal(registry.snapshotPublic().sessions.length, 300, "legacy count/TTL options must not impose an artificial public-session memory ceiling");
  assert.equal(registry.entriesForReplay().length, 300, "all genuinely live authorized sessions remain eligible for continuity replay");
  assert.ok(registry.lookup(ids[0]));
}

async function testMappingCommitToleratesDisconnectedRace() {
  const registry = new StableGatewaySessionRegistry();
  const first = createSession(registry, 1);
  const second = createSession(registry, 2);
  registry.remove(second);
  registry.commitMappings([
    { publicSessionId: first, coreId: "core-b", backendSessionId: "backend-b-1" },
    { publicSessionId: second, coreId: "core-b", backendSessionId: "backend-b-2" },
  ]);
  assert.equal(registry.lookup(first).backendSessionId, "backend-b-1");
  assert.equal(registry.lookup(second), undefined, "a descriptor that disconnected during replay must stay removed rather than aborting the whole handover");
}

async function testPublicSnapshotRedactsReplaySecrets() {
  const registry = new StableGatewaySessionRegistry();
  const publicSessionId = createSession(registry);
  registry.markInitialized(publicSessionId);
  const snapshot = registry.snapshotPublic();
  const serialized = JSON.stringify(snapshot);
  assert.deepEqual(snapshot.sessions[0], {
    publicSessionId,
    coreId: "core-a",
    initialized: true,
    activeRequests: 0,
    eventStreams: 0,
    disconnectObserved: false,
    schemaFingerprint: null,
    toolCount: null,
  });
  assert.doesNotMatch(serialized, /secret-1|backend-a-1|protocolVersion/);
}

async function testDescriptorRestore() {
  const registry = new StableGatewaySessionRegistry({ now: () => 10_000 });
  const publicSessionId = "12345678-1234-1234-1234-123456789abc";
  registry.restoreDescriptors([{
    publicSessionId,
    initializeBody: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    initialized: true,
    lastActivityAt: 9_000,
    schemaFingerprint: "b".repeat(64),
    toolCount: 77,
  }]);
  const restored = registry.lookup(publicSessionId);
  assert.equal(restored.coreId, "restored-unmapped");
  assert.equal(restored.authorization, "");
  assert.equal(restored.eventStreams, 0);
  assert.equal(restored.schemaFingerprint, "b".repeat(64));
}

await testStableSessionMapping();
await testAdmissionAndDrainHaveNoDeadline();
await testEventStreamLifecycle();
await testClientSessionSupersession();
await testNoArtificialRetentionOrReplayCap();
await testMappingCommitToleratesDisconnectedRace();
await testPublicSnapshotRedactsReplaySecrets();
await testDescriptorRestore();

console.log(JSON.stringify({
  ok: true,
  gate: "stable-gateway-runtime",
  wallClockTimeoutsRemoved: true,
  artificialRetentionLimitsRemoved: true,
  clientSessionSupersession: true,
  disconnectLifecycleBound: true,
}));
