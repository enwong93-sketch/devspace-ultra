import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function close(listener) {
  for (const socket of listener.sockets) socket.destroy();
  listener.server.closeAllConnections?.();
  await new Promise((resolve) => listener.server.close(resolve));
}

function capabilityRuntime() {
  const claims = new Map();
  return {
    claims,
    async claimInstance(input) {
      const token = `instance-token-${input.runtimeId}-${input.ownerConversationId}`;
      claims.set(token, structuredClone(input));
      return { ok: true, instanceToken: token, runtimeId: input.runtimeId };
    },
    findInstanceByToken(token) {
      const input = claims.get(token);
      return input ? {
        pluginId: input.pluginId,
        serverId: input.serverId,
        instanceId: input.instanceId,
        runtimeId: input.runtimeId,
        ownerConversationId: input.ownerConversationId,
        ownerLabel: input.ownerLabel,
      } : null;
    },
    connectionManager: {
      async adoptLegacySharedConnection() {
        return { adopted: false, reason: "test-has-no-legacy-holder" };
      },
    },
    async getMcpClient(_pluginId, _serverId, token) {
      assert.ok(claims.has(token));
      return { connected: true };
    },
    async releaseInstance(token) {
      claims.delete(token);
      return { ok: true };
    },
  };
}

{
  const listener = await listen();
  const stateDir = await mkdtemp(join(tmpdir(), "blender-adopt-one-"));
  const capability = capabilityRuntime();
  try {
    const manager = new BlenderRuntimeManager({
      stateDir,
      capabilityRuntime: capability,
      defaultPort: listener.port,
    });
    await manager.ready;
    const first = await manager.resolveOrAdoptExisting({
      ownerConversationId: "conversation-right-agent",
      ownerLabel: "Right Blender Agent",
    });
    assert.equal(first.ok, true);
    assert.equal(first.adopted, true);
    assert.equal(first.preservedExistingProcess, true);
    assert.equal(first.runtime.port, listener.port);
    assert.equal(first.runtime.managedProcess, false);
    assert.equal(listener.server.listening, true, "adoption must not restart or stop the existing Blender endpoint");

    const second = await manager.resolveOrAdoptExisting({
      ownerConversationId: "conversation-right-agent",
      ownerLabel: "Right Blender Agent",
    });
    assert.equal(second.adopted, false);
    assert.equal(second.runtime.runtimeId, first.runtime.runtimeId);
    assert.equal((await manager.list("conversation-right-agent")).length, 1);
    assert.equal((await manager.list("conversation-other-agent")).length, 1);
    const handedOff = await manager.resolveOrAdoptExisting({ ownerConversationId: "conversation-other-agent" });
    assert.equal(handedOff.adopted, false);
    assert.equal(handedOff.runtime.runtimeId, first.runtime.runtimeId);
    assert.equal(handedOff.runtime.lastConversationId, "conversation-other-agent");
    assert.equal(handedOff.runtime.conversationLocked, false);

    await manager.stop({
      runtimeId: first.runtime.runtimeId,
      ownerConversationId: "conversation-right-agent",
      terminateProcess: false,
    });
    assert.equal(listener.server.listening, true, "release must leave an adopted external Blender process untouched");
  }
  finally {
    await close(listener).catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
}

{
  const first = await listen();
  const second = await listen();
  const stateDir = await mkdtemp(join(tmpdir(), "blender-adopt-ambiguous-"));
  try {
    const manager = new BlenderRuntimeManager({
      stateDir,
      capabilityRuntime: capabilityRuntime(),
    });
    await manager.ready;
    await manager.attach({ runtimeId: "ambiguous-a", ownerConversationId: "conversation-old-a", port: first.port });
    await manager.attach({ runtimeId: "ambiguous-b", ownerConversationId: "conversation-old-b", port: second.port });
    await assert.rejects(
      () => manager.defaultInstanceToken("conversation-agent"),
      /More than one Blender runtime is online/,
    );
    assert.equal((await manager.list("conversation-agent")).length, 2);
  }
  finally {
    await close(first).catch(() => {});
    await close(second).catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({
  ok: true,
  gate: "blender-runtime-adoption",
  existingProcessPreserved: true,
  conversationTransfer: true,
  ownerConversationBound: false,
  otherConversationRejected: false,
  ambiguousCandidatesRejected: true,
}));
