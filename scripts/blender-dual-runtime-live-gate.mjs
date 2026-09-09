import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";
import { CapabilityRuntime } from "../dist/capability-runtime.js";
import { BlenderRuntimeManager } from "../dist/blender-runtime-manager.js";

function structured(response) {
  return response?.result?.structuredContent?.result
    ?? response?.result?.structuredContent
    ?? response?.structuredContent?.result
    ?? response?.structuredContent
    ?? null;
}

function objectNames(response) {
  const data = structured(response);
  const text = JSON.stringify(data || response);
  return text;
}

const config = loadConfig();
const stateDir = await mkdtemp(join(tmpdir(), "devspace-blender-dual-live-"));
const capabilityRuntime = new CapabilityRuntime({
  enabled: true,
  pluginsDir: config.pluginsDir,
  registryPath: config.capabilityRegistryPath,
  pluginPaths: config.pluginPaths || [],
});
await capabilityRuntime.ready;
const manager = new BlenderRuntimeManager({ stateDir, capabilityRuntime });
await manager.ready;

const ownerA = "live-gate-conversation-a";
const ownerB = "live-gate-conversation-b";
let runtimeA = null;
let runtimeB = null;
let terminateA = false;

try {
  const discovered = await manager.discover(ownerA);
  const existing = discovered
    .flatMap((processInfo) => processInfo.ports.map((entry) => ({ ...entry, processId: processInfo.processId })))
    .find((entry) => entry.accepting && entry.port >= 9876 && entry.port <= 9976);

  if (existing) {
    runtimeA = await manager.attach({
      runtimeId: "dual-live-a",
      ownerConversationId: ownerA,
      ownerLabel: "Dual runtime live gate A",
      port: existing.port,
      processId: existing.processId,
    });
  } else {
    runtimeA = await manager.start({
      runtimeId: "dual-live-a",
      ownerConversationId: ownerA,
      ownerLabel: "Dual runtime live gate A",
    });
    terminateA = true;
  }

  runtimeB = await manager.start({
    runtimeId: "dual-live-b",
    ownerConversationId: ownerB,
    ownerLabel: "Dual runtime live gate B",
  });

  assert.notEqual(runtimeA.runtime.port, runtimeB.runtime.port, "parallel Blender runtimes must receive distinct loopback ports");
  assert.notEqual(runtimeA.instanceToken, runtimeB.instanceToken, "parallel Blender runtimes must receive distinct private MCP instance tokens");

  const marker = `DEVSPACE_DUAL_RUNTIME_B_${Date.now()}`;
  await capabilityRuntime.callMcp(
    "blender-local",
    "blender",
    "execute_blender_code",
    {
      code: `import bpy\nname=${JSON.stringify(marker)}\nobj=bpy.data.objects.get(name)\nif obj is None:\n    mesh=bpy.data.meshes.new(name+'_Mesh')\n    obj=bpy.data.objects.new(name, mesh)\n    bpy.context.scene.collection.objects.link(obj)\nresult={'runtime_marker': name, 'filepath': bpy.data.filepath}`,
    },
    runtimeB.instanceToken,
    ownerB,
  );

  const summaryA = await capabilityRuntime.callMcp(
    "blender-local",
    "blender",
    "get_objects_summary",
    {},
    runtimeA.instanceToken,
    ownerA,
  );
  const summaryB = await capabilityRuntime.callMcp(
    "blender-local",
    "blender",
    "get_objects_summary",
    {},
    runtimeB.instanceToken,
    ownerB,
  );

  assert.equal(objectNames(summaryA).includes(marker), false, "runtime A must not observe runtime B's test object");
  assert.equal(objectNames(summaryB).includes(marker), true, "runtime B must observe its own test object");
  await assert.rejects(
    () => manager.access("dual-live-a", ownerB),
    /belongs to another ChatGPT conversation/,
  );

  console.log(JSON.stringify({
    ok: true,
    gate: "blender-dual-runtime-live",
    runtimeA: { port: runtimeA.runtime.port, attachedExisting: !terminateA },
    runtimeB: { port: runtimeB.runtime.port, managedProcess: true },
    distinctPorts: true,
    distinctMcpInstances: true,
    sceneIsolation: true,
    conversationIsolation: true,
  }));
} finally {
  if (runtimeB) {
    await manager.stop({ runtimeId: "dual-live-b", ownerConversationId: ownerB, terminateProcess: true }).catch(() => {});
  }
  if (runtimeA) {
    await manager.stop({ runtimeId: "dual-live-a", ownerConversationId: ownerA, terminateProcess: terminateA }).catch(() => {});
  }
  await capabilityRuntime.close().catch(() => {});
  await rm(stateDir, { recursive: true, force: true });
}
