import assert from "node:assert/strict";
import { CapabilityConnectionManager } from "./capability-connection-manager.js";

let tick = 0;
const manager = new CapabilityConnectionManager({
  now: () => `2026-09-08T00:00:${String(tick++).padStart(2, "0")}.000Z`,
});

const claimedA = manager.claimInstance({
  pluginId: "blender-local",
  serverId: "blender",
  instanceId: "runtime-a",
  runtimeId: "runtime-a",
  ownerConversationId: "conversation-a",
  ownerLabel: "Agent A",
  envOverrides: { BLENDER_PORT: "9877" },
});
const claimedB = manager.claimInstance({
  pluginId: "blender-local",
  serverId: "blender",
  instanceId: "runtime-b",
  runtimeId: "runtime-b",
  ownerConversationId: "conversation-b",
  ownerLabel: "Agent B",
  envOverrides: { BLENDER_PORT: "9878" },
});

assert.notEqual(claimedA.instanceToken, claimedB.instanceToken);
assert.equal(manager.tokenForRuntime("runtime-a", {
  pluginId: "blender-local",
  serverId: "blender",
  ownerConversationId: "conversation-a",
}), claimedA.instanceToken);
assert.throws(() => manager.tokenForRuntime("runtime-a", {
  pluginId: "blender-local",
  serverId: "blender",
  ownerConversationId: "conversation-b",
}), /another conversation/);
assert.equal("instanceToken" in manager.publicInstance(manager.findInstanceByToken(claimedA.instanceToken)), false);
assert.deepEqual(manager.publicInstance(manager.findInstanceByToken(claimedA.instanceToken)).envNames, ["BLENDER_PORT"]);

let conversationConnects = 0;
const conversationA1 = await manager.getOrConnect({
  pluginId: "memory",
  serverId: "memory",
  ownerConversationId: "conversation-a",
  connect: async () => ({ id: `conversation-${++conversationConnects}` }),
});
const conversationA2 = await manager.getOrConnect({
  pluginId: "memory",
  serverId: "memory",
  ownerConversationId: "conversation-a",
  connect: async () => ({ id: `conversation-${++conversationConnects}` }),
});
const conversationB = await manager.getOrConnect({
  pluginId: "memory",
  serverId: "memory",
  ownerConversationId: "conversation-b",
  connect: async () => ({ id: `conversation-${++conversationConnects}` }),
});
assert.equal(conversationA1, conversationA2, "one conversation must reuse only its own MCP connection");
assert.notEqual(conversationA1, conversationB, "two conversations must never share an implicit MCP connection");
assert.equal(conversationConnects, 2);
await assert.rejects(
  () => manager.getOrConnect({ pluginId: "memory", serverId: "memory", connect: async () => ({}) }),
  /ownerConversationId is required/,
);

let formerlyShareableConnects = 0;
const formerlyShareableA = await manager.getOrConnect({
  pluginId: "stateless-provider",
  serverId: "search",
  ownerConversationId: "conversation-a",
  connect: async () => ({ id: `stateless-conversation-${++formerlyShareableConnects}` }),
});
const formerlyShareableB = await manager.getOrConnect({
  pluginId: "stateless-provider",
  serverId: "search",
  ownerConversationId: "conversation-b",
  connect: async () => ({ id: `stateless-conversation-${++formerlyShareableConnects}` }),
});
assert.notEqual(formerlyShareableA, formerlyShareableB, "even stateless providers must not share one MCP transport across conversations");
assert.equal(formerlyShareableConnects, 2);

let isolatedConnects = 0;
const instanceA = manager.resolveInstance(claimedA.instanceToken, {
  pluginId: "blender-local",
  serverId: "blender",
  ownerConversationId: "conversation-a",
});
const isolatedA = await manager.getOrConnect({
  pluginId: "blender-local",
  serverId: "blender",
  instance: instanceA,
  connect: async () => ({ id: `isolated-a-${++isolatedConnects}` }),
});
const instanceB = manager.resolveInstance(claimedB.instanceToken, {
  pluginId: "blender-local",
  serverId: "blender",
  ownerConversationId: "conversation-b",
});
const isolatedB = await manager.getOrConnect({
  pluginId: "blender-local",
  serverId: "blender",
  instance: instanceB,
  connect: async () => ({ id: `isolated-b-${++isolatedConnects}` }),
});
assert.notEqual(isolatedA, isolatedB, "different runtime instances must never share one stateful MCP client");

const legacyManager = new CapabilityConnectionManager();
const legacyHolder = { id: "already-running-blender-bridge" };
legacyManager.clients.set("blender-local::blender", legacyHolder);
legacyManager.connectionStates.set("blender-local::blender", {
  key: "blender-local::blender",
  pluginId: "blender-local",
  serverId: "blender",
  scope: "shared",
  state: "ready",
  connecting: false,
});
const adoptedClaim = legacyManager.claimInstance({
  pluginId: "blender-local",
  serverId: "blender",
  instanceId: "adopted-runtime",
  runtimeId: "adopted-runtime",
  ownerConversationId: "conversation-a",
  ownerLabel: "Agent A",
});
const adoptedInstance = legacyManager.resolveInstance(adoptedClaim.instanceToken, { ownerConversationId: "conversation-a" });
const adopted = await legacyManager.adoptLegacySharedConnection({
  pluginId: "blender-local",
  serverId: "blender",
  instance: adoptedInstance,
});
assert.equal(adopted.adopted, true);
assert.equal(legacyManager.clients.get(adopted.key), legacyHolder, "adoption must move the live holder without closing or reconnecting it");
assert.equal(legacyManager.clients.has("blender-local::blender"), false);
assert.equal(legacyManager.connectionStates.get(adopted.key)?.ownerConversationId, "conversation-a");

const visibleA = manager.listConnections({ ownerConversationId: "conversation-a" });
assert.equal(visibleA.some((row) => row.scope === "conversation-isolated" && row.ownerConversationId === "conversation-a"), true);
assert.equal(visibleA.some((row) => row.ownerConversationId === "conversation-b"), false);
assert.equal(visibleA.some((row) => row.scope === "explicit-shared"), false);
assert.equal(visibleA.some((row) => row.runtimeId === "runtime-a"), true);
assert.equal(visibleA.some((row) => row.runtimeId === "runtime-b"), false);

const closed = [];
await manager.invalidate({
  pluginId: "blender-local",
  serverId: "blender",
  instanceId: "runtime-a",
  closeHolder: async (holder) => closed.push(holder.id),
  reason: "transport-closed",
});
assert.equal(manager.listConnections({ ownerConversationId: "conversation-a" })
  .find((row) => row.runtimeId === "runtime-a")?.state, "disconnected");
const reconnectedA = await manager.getOrConnect({
  pluginId: "blender-local",
  serverId: "blender",
  instance: instanceA,
  connect: async () => ({ id: `isolated-a-${++isolatedConnects}` }),
});
assert.notEqual(reconnectedA, isolatedA, "the next real call must reconnect an invalidated transport");
assert.equal(closed.length, 1);

await manager.releaseInstance(claimedA.instanceToken, {
  closeHolder: async (holder) => closed.push(holder.id),
});
assert.throws(() => manager.findInstanceByToken(claimedA.instanceToken), /Invalid capability instance token/);
assert.equal(manager.listConnections({ ownerConversationId: "conversation-a" }).some((row) => row.runtimeId === "runtime-a"), false);
assert.equal(manager.listConnections({ ownerConversationId: "conversation-b" }).some((row) => row.runtimeId === "runtime-b"), true);

const diagnostics = manager.diagnostics();
assert.equal(diagnostics.instances, 1);
assert.equal(diagnostics.sharedConnections, 0);
assert.equal(diagnostics.conversationIsolatedConnections, 4);
assert.equal(diagnostics.runtimeIsolatedConnections, 1);
assert.equal(diagnostics.isolatedConnections, 5);

await manager.closeAll({ closeHolder: async (holder) => closed.push(holder.id) });
await legacyManager.closeAll();
assert.equal(manager.diagnostics().clients, 0);
assert.equal(manager.diagnostics().instances, 0);

console.log(JSON.stringify({
  ok: true,
  gate: "capability-connection-manager",
  defaultConversationIsolation: true,
  crossConversationSharingDisabled: true,
  conversationOwnership: true,
  isolatedRuntimeKeys: true,
  liveLegacyAdoptionWithoutReconnect: true,
  explicitReconnect: true,
  explicitRelease: true,
  noLeaseTimeout: true,
}));
