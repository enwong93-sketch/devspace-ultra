import assert from "node:assert/strict";
import { CodexMcpBridge } from "./codex-mcp-bridge.js";

const closed = [];
const bridge = Object.create(CodexMcpBridge.prototype);
bridge.clients = new Map([
  ["alpha::conversation:a", {
    serverId: "alpha",
    ownerConversationId: "conversation-a",
    definition: { transport: "stdio" },
    client: { async close() { closed.push("client-alpha-a"); } },
    transport: { async close() { closed.push("transport-alpha-a"); } },
  }],
  ["alpha::conversation:b", {
    serverId: "alpha",
    ownerConversationId: "conversation-b",
    definition: { transport: "stdio" },
    client: { async close() { closed.push("client-alpha-b"); } },
    transport: { async close() { closed.push("transport-alpha-b"); } },
  }],
  ["beta::conversation:a", {
    serverId: "beta",
    ownerConversationId: "conversation-a",
    server: { id: "beta", transport: "http" },
    client: { async close() { closed.push("client-beta-a"); } },
    transport: { async close() { closed.push("transport-beta-a"); } },
  }],
]);
bridge.connecting = new Map();

const listedA = bridge.listConnections({ ownerConversationId: "conversation-a" });
assert.deepEqual(listedA.map((row) => row.serverId), ["alpha", "beta"]);
assert.equal(listedA.every((row) => row.mode === "conversation-isolated"), true);
assert.equal(listedA.every((row) => row.ownerConversationId === "conversation-a"), true);
assert.equal(bridge.listConnections({ ownerConversationId: "conversation-b" }).length, 1);

const reset = await bridge.resetConnection("alpha", "conversation-a");
assert.equal(reset.ok, true);
assert.equal(reset.reconnectOnNextUse, true);
assert.equal(reset.ownerConversationId, "conversation-a");
assert.equal(bridge.listConnections({ serverId: "alpha", ownerConversationId: "conversation-a" }).length, 0);
assert.equal(bridge.listConnections({ serverId: "alpha", ownerConversationId: "conversation-b" }).length, 1, "one conversation reset must not close another conversation's Codex MCP client");
assert.deepEqual(closed, ["client-alpha-a", "transport-alpha-a"]);

console.log(JSON.stringify({
  ok: true,
  gate: "codex-mcp-connection-manager",
  conversationIsolatedInventory: true,
  crossConversationResetIsolation: true,
  resetAndLazyReconnect: true,
}));
