import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { BlenderRuntimeManager } from "./blender-runtime-manager.js";

async function listen() {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, sockets, port: server.address().port };
}

async function close(server, sockets = new Set()) {
  for (const socket of sockets) socket.destroy();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

const stateDir = await mkdtemp(join(tmpdir(), "devspace-blender-runtime-test-"));
const first = await listen();
const second = await listen();
const third = await listen();
const claims = [];
const releases = [];
const instances = new Map();
const adoptions = [];
const capabilityRuntime = {
  async claimInstance(input) {
    claims.push(input);
    const instanceToken = `token-${input.runtimeId}-0123456789abcdef`;
    instances.set(instanceToken, {
      pluginId: input.pluginId,
      serverId: input.serverId,
      instanceId: input.runtimeId,
      runtimeId: input.runtimeId,
      ownerConversationId: input.ownerConversationId,
      ownerLabel: input.ownerLabel,
    });
    return { instanceToken };
  },
  findInstanceByToken(token) { return instances.get(token); },
  connectionManager: {
    async adoptLegacySharedConnection(input) {
      adoptions.push(input);
      return { adopted: false, reason: "fixture-has-no-legacy-holder" };
    },
  },
  async getMcpClient(_pluginId, _serverId, instanceToken, ownerConversationId) {
    assert.match(instanceToken, /^token-/);
    assert.match(ownerConversationId, /^blender-runtime:/);
    return { client: {} };
  },
  async call(input, { ownerConversationId }) {
    const instance = instances.get(input.instanceToken);
    assert.ok(instance);
    assert.equal(instance.ownerConversationId, ownerConversationId);
    return {
      ok: true,
      result: {
        structuredContent: {
          status: "ok",
          result: { filepath: join(stateDir, `${instance.runtimeId}-live.blend`) },
        },
        isError: false,
      },
    };
  },
  async releaseInstance(token, ownerConversationId) {
    releases.push({ token, ownerConversationId });
    instances.delete(token);
    return { ok: true };
  },
};

try {
  const manager = new BlenderRuntimeManager({ stateDir, capabilityRuntime });
  await manager.ready;

  const runtimeA = await manager.attach({
    runtimeId: "agent-a",
    ownerConversationId: "conversation-a",
    ownerLabel: "Agent A",
    port: first.port,
  });
  const runtimeB = await manager.attach({
    runtimeId: "agent-b",
    ownerConversationId: "conversation-b",
    ownerLabel: "Agent B",
    port: second.port,
  });

  assert.equal(runtimeA.runtime.port, first.port);
  assert.equal(runtimeB.runtime.port, second.port);
  assert.equal(runtimeA.runtime.conversationLocked, false);
  assert.equal(runtimeB.runtime.conversationLocked, false);
  assert.equal(runtimeA.runtime.lastConversationId, "conversation-a");
  assert.equal(runtimeB.runtime.lastConversationId, "conversation-b");
  assert.notEqual(runtimeA.instanceToken, runtimeB.instanceToken);
  assert.equal(claims.length, 2);
  assert.equal(adoptions.length, 2);
  assert.deepEqual(claims.map((claim) => claim.instanceId), ["agent-a", "agent-b"]);
  assert.deepEqual(claims.map((claim) => claim.env.BLENDER_MCP_HOST), ["127.0.0.1", "127.0.0.1"]);
  assert.deepEqual(claims.map((claim) => claim.env.BLENDER_MCP_PORT), [String(first.port), String(second.port)]);
  assert.deepEqual(claims.map((claim) => claim.env.BLENDER_PORT), [String(first.port), String(second.port)]);
  assert.deepEqual((await manager.list("conversation-a")).map((runtime) => runtime.runtimeId), ["agent-a", "agent-b"]);
  assert.deepEqual((await manager.list("conversation-b")).map((runtime) => runtime.runtimeId), ["agent-a", "agent-b"]);
  assert.equal((await manager.list("conversation-a")).find((runtime) => runtime.runtimeId === "agent-a").preferredByCurrentConversation, true);
  assert.equal((await manager.list("conversation-b")).find((runtime) => runtime.runtimeId === "agent-b").preferredByCurrentConversation, true);

  const accessA = await manager.access("agent-a", "conversation-a");
  assert.equal(accessA.instanceToken, runtimeA.instanceToken);
  assert.equal(await manager.defaultInstanceToken("conversation-a"), runtimeA.instanceToken);
  const defaultB = await manager.defaultRuntime("conversation-b");
  assert.equal(defaultB.runtime.runtimeId, "agent-b");
  assert.equal(defaultB.runtime.blendFile, join(stateDir, "agent-b-live.blend"));

  const transferredA = await manager.access("agent-a", "conversation-b");
  assert.equal(transferredA.instanceToken, runtimeA.instanceToken, "a later conversation must continue the same Blender MCP runtime");
  assert.equal((await manager.status("agent-a", "conversation-b")).runtime.lastConversationId, "conversation-b");
  assert.equal(await manager.defaultInstanceToken("conversation-b"), runtimeA.instanceToken, "the latest explicit runtime becomes only an advisory default for that conversation");

  const reusedByPort = await manager.attach({
    runtimeId: "agent-c",
    ownerConversationId: "conversation-c",
    port: second.port,
  });
  assert.equal(reusedByPort.runtime.runtimeId, "agent-b", "an already-registered Blender port must be reused rather than rejected by conversation identity");
  assert.equal(reusedByPort.runtime.lastConversationId, "conversation-c");

  const adoptedStateDir = await mkdtemp(join(tmpdir(), "devspace-blender-runtime-adopt-test-"));
  try {
    const adoptingManager = new BlenderRuntimeManager({
      stateDir: adoptedStateDir,
      capabilityRuntime,
      defaultPort: third.port,
    });
    await adoptingManager.ready;
    const adoptedToken = await adoptingManager.defaultInstanceToken("conversation-existing");
    const adoptedRuntime = await adoptingManager.defaultRuntime("conversation-existing");
    assert.match(adoptedToken, /^token-adopted-default-/);
    assert.equal(adoptedRuntime.runtime.port, third.port);
    assert.equal(adoptedRuntime.runtime.managedProcess, false);
    assert.equal(adoptedRuntime.runtime.defaultForOwner, false);
    assert.equal(adoptedRuntime.runtime.ownerConversationId, null);
    assert.equal(adoptedRuntime.runtime.lastConversationId, "conversation-existing");
    assert.equal(adoptedRuntime.runtime.conversationLocked, false);
  } finally {
    await rm(adoptedStateDir, { recursive: true, force: true });
  }

  const legacy = await listen();
  const legacyStateDir = await mkdtemp(join(tmpdir(), "devspace-blender-runtime-v2-migration-"));
  try {
    await writeFile(join(legacyStateDir, "blender-runtimes.json"), JSON.stringify({
      version: 2,
      runtimes: [{
        runtimeId: "legacy-runtime",
        ownerConversationId: "conversation-old",
        ownerLabel: "Legacy Agent",
        port: legacy.port,
        processId: null,
        managedProcess: false,
        defaultForOwner: true,
        blendFile: join(legacyStateDir, "legacy.blend"),
        executable: null,
        createdAt: new Date().toISOString(),
        connectedAt: new Date().toISOString(),
      }],
    }, null, 2), "utf8");
    const legacyManager = new BlenderRuntimeManager({ stateDir: legacyStateDir, capabilityRuntime });
    await legacyManager.ready;
    const visibleFromNewConversation = await legacyManager.list("conversation-new");
    assert.equal(visibleFromNewConversation.length, 1, "a new conversation must see a persisted v2 Blender runtime owned by an older conversation");
    assert.equal(visibleFromNewConversation[0].runtimeId, "legacy-runtime");
    assert.equal(visibleFromNewConversation[0].conversationLocked, false);
    assert.equal(visibleFromNewConversation[0].lastConversationId, "conversation-old");
    const legacyAccess = await legacyManager.access("legacy-runtime", "conversation-new");
    assert.match(legacyAccess.instanceToken, /^token-legacy-runtime-/);
    const migrated = JSON.parse(await readFile(join(legacyStateDir, "blender-runtimes.json"), "utf8"));
    assert.equal(migrated.version, 3);
    assert.equal(migrated.runtimes[0].ownerConversationId, undefined, "v3 persistence must remove the hard conversation owner field");
    assert.equal(migrated.runtimes[0].lastConversationId, "conversation-new", "the new conversation becomes only the latest-use hint");
    await legacyManager.close();
  } finally {
    await close(legacy.server, legacy.sockets).catch(() => {});
    await rm(legacyStateDir, { recursive: true, force: true });
  }

  await manager.stop({ runtimeId: "agent-a", ownerConversationId: "conversation-handoff" });
  assert.equal(releases.filter((item) => item.ownerConversationId === "blender-runtime:agent-a").length, 1);
  assert.ok(releases.some((item) => item.ownerConversationId === "blender-runtime:agent-a"));
  assert.deepEqual((await manager.list("conversation-a")).map((runtime) => runtime.runtimeId), ["agent-b"]);
  assert.deepEqual((await manager.list("conversation-b")).map((runtime) => runtime.runtimeId), ["agent-b"]);

  await manager.close();
  assert.equal(releases.filter((item) => item.ownerConversationId === "blender-runtime:agent-b").length, 1, "manager close must release the remaining MCP connection without terminating Blender");
  assert.ok(releases.some((item) => item.ownerConversationId === "blender-runtime:agent-b"));

  console.log(JSON.stringify({
    ok: true,
    gate: "blender-runtime-manager",
    dualRuntimePorts: [first.port, second.port],
    runtimeIsolation: true,
    conversationTransfer: true,
    conversationOwnershipLock: false,
    legacyV2OwnerMigratedToAdvisoryHint: true,
    uniqueDefaultRuntime: true,
    existingRuntimeAdoption: true,
    implicitDefaultEndpointAdoption: true,
    gracefulConnectionClose: true,
    noLeaseTimeout: true,
  }));
} finally {
  await close(first.server, first.sockets).catch(() => {});
  await close(second.server, second.sockets).catch(() => {});
  await close(third.server, third.sockets).catch(() => {});
  await rm(stateDir, { recursive: true, force: true });
}
