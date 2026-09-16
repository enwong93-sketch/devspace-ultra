import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [capabilityRuntime, blenderRuntime, server, agents] = await Promise.all([
  readFile(new URL("../dist/capability-runtime.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/blender-runtime-manager.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/server.js", import.meta.url), "utf8"),
  readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
]);

assert.match(capabilityRuntime, /scope:\s*owner === INTERNAL_CAPABILITY_OWNER \? "internal-isolated" : "conversation-isolated"/,
  "Ordinary CapabilityRuntime MCP connections must remain conversation-isolated by default.");
assert.match(capabilityRuntime, /registerTool\("devspace_connection_isolation_status"/, "Every conversation needs a live isolation diagnostic surface.");
assert.match(capabilityRuntime, /connectionPolicy:\s*"conversation-isolated"/, "Ordinary capability catalogue/execution surfaces must advertise conversation isolation.");
assert.match(capabilityRuntime, /currentConversation\(extra\)/, "CapabilityRuntime must receive the verified request-scoped conversation owner for ordinary MCP calls.");
assert.match(blenderRuntime, /resolveOrAdoptExisting\(/, "Blender runtime manager must preserve and adopt an existing Blender endpoint without tying it to one ChatGPT conversation.");
const blenderToolBlock = capabilityRuntime.slice(
  capabilityRuntime.indexOf('server.registerTool("blender_mcp"'),
  capabilityRuntime.indexOf('server.registerTool("capability_call"'),
);
assert.doesNotMatch(
  blenderToolBlock,
  /runtime\.inspect\("blender-local"[\s\S]*probeMcp:\s*true/,
  "Blender execution must never route through the legacy shared catalogue connection.",
);
assert.match(blenderRuntime, /preservedExistingProcess:\s*true/, "Adopting a running Blender must explicitly preserve its process.");
assert.match(blenderRuntime, /runtimeConnectionOwnerId\(/, "Blender MCP transport identity must be stable per runtime rather than per ChatGPT conversation.");
assert.match(blenderRuntime, /conversationLocked:\s*false/, "Blender runtimes must be transferable across conversation handoffs.");
assert.doesNotMatch(blenderRuntime, /belongs to another ChatGPT conversation/, "Blender runtime access must not be denied solely because the ChatGPT conversation changed.");
assert.match(blenderRuntime, /More than one Blender runtime is online/, "Ambiguous multiple Blender runtimes must still require an explicit runtimeId.");
assert.match(server, /sendToolListChanged\(\)/, "Core must notify existing ChatGPT sessions when the tool surface changes.");
assert.match(server, /const resolveCapabilityConversationAuthority = async/, "Core must keep a request-scoped conversation authority resolver for ordinary capability/MCP paths.");
assert.match(server, /mcp_tool_list_changed_sent/, "Tool-list refresh must be observable without exposing payloads.");
assert.match(agents, /conversation-isolated|conversation scoped|conversation-scoped/i, "Agent routing instructions must state the isolation boundary.");
assert.match(agents, /Blender is the deliberate exception[\s\S]*runtimeId[\s\S]*not locked to one ChatGPT conversation/i,
  "Agent instructions must document transferable Blender runtime continuity separately from ordinary conversation-isolated MCPs.");

console.log(JSON.stringify({
  ok: true,
  gate: "conversation-connection-isolation-static",
  genericMcpConversationIsolation: true,
  blenderExistingRuntimeAdoption: true,
  blenderConversationTransfer: true,
  ambiguousRuntimeFailsClosed: true,
  sharedBlenderFallbackRemoved: true,
  toolListRefreshNotification: true,
}));
