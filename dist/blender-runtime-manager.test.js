import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
    assert.match(ownerConversationId, /^conversation-/);
    return { client: {} };
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
  assert.equal(runtimeA.runtime.defaultForOwner, true);
  assert.equal(runtimeB.runtime.defaultForOwner, true);
  assert.notEqual(runtimeA.instanceToken, runtimeB.instanceToken);
  assert.equal(claims.length, 2);
  assert.equal(adoptions.length, 2);
  assert.deepEqual(claims.map((claim) => claim.instanceId), ["agent-a", "agent-b"]);
  assert.deepEqual(claims.map((claim) => claim.env.BLENDER_MCP_HOST), ["127.0.0.1", "127.0.0.1"]);
  assert.deepEqual(claims.map((claim) => claim.env.BLENDER_MCP_PORT), [String(first.port), String(second.port)]);
  assert.deepEqual(claims.map((claim) => claim.env.BLENDER_PORT), [String(first.port), String(second.port)]);
  assert.deepEqual((await manager.list("conversation-a")).map((runtime) => runtime.runtimeId), ["agent-a"]);
  assert.deepEqual((await manager.list("conversation-b")).map((runtime) => runtime.runtimeId), ["agent-b"]);

  await assert.rejects(
    () => manager.access("agent-a", "conversation-b"),
    /belongs to another ChatGPT conversation/,
  );
  const accessA = await manager.access("agent-a", "conversation-a");
  assert.equal(accessA.instanceToken, runtimeA.instanceToken);
  assert.equal(await manager.defaultInstanceToken("conversation-a"), runtimeA.instanceToken);
  assert.equal((await manager.defaultRuntime("conversation-b")).runtime.runtimeId, "agent-b");

  await assert.rejects(
    () => manager.attach({
      runtimeId: "agent-c",
      ownerConversationId: "conversation-c",
      port: second.port,
    }),
    /belongs to another conversation runtime/,
  );

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
    assert.equal(adoptedRuntime.runtime.defaultForOwner, true);
    assert.equal(adoptedRuntime.runtime.ownerConversationId, "conversation-existing");
  } finally {
    await rm(adoptedStateDir, { recursive: true, force: true });
  }

  await manager.stop({ runtimeId: "agent-a", ownerConversationId: "conversation-a" });
  assert.equal(releases.length, 1);
  assert.equal(releases[0].ownerConversationId, "conversation-a");
  assert.deepEqual((await manager.list("conversation-a")), []);
  assert.deepEqual((await manager.list("conversation-b")).map((runtime) => runtime.runtimeId), ["agent-b"]);

  await manager.close();
  assert.equal(releases.length, 2, "manager close must release remaining MCP connections without terminating Blender");
  assert.equal(releases[1].ownerConversationId, "conversation-b");

  console.log(JSON.stringify({
    ok: true,
    gate: "blender-runtime-manager",
    dualRuntimePorts: [first.port, second.port],
    conversationIsolation: true,
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
