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
      portStart: listener.port,
      portEnd: listener.port,
      discoverProcesses: async () => [{
        processId: 4242,
        parentProcessId: 1,
        executable: "C:/Blender/blender.exe",
        commandLine: "blender.exe existing-work.blend",
        ports: [listener.port],
      }],
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
    assert.equal((await manager.list("conversation-other-agent")).length, 0);
    await assert.rejects(
      () => manager.resolveOrAdoptExisting({ ownerConversationId: "conversation-other-agent" }),
      /No unclaimed existing Blender MCP runtime is online/,
    );

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
      portStart: Math.min(first.port, second.port),
      portEnd: Math.max(first.port, second.port),
      discoverProcesses: async () => [
        { processId: 5001, ports: [first.port] },
        { processId: 5002, ports: [second.port] },
      ],
    });
    await manager.ready;
    await assert.rejects(
      () => manager.resolveOrAdoptExisting({ ownerConversationId: "conversation-agent" }),
      /More than one unclaimed Blender MCP runtime is online/,
    );
    assert.equal((await manager.list("conversation-agent")).length, 0);
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
  ownerConversationBound: true,
  otherConversationRejected: true,
  ambiguousCandidatesRejected: true,
}));
