import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [capabilityRuntime, blenderRuntime, server, agents] = await Promise.all([
  readFile(new URL("../dist/capability-runtime.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/blender-runtime-manager.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/server.js", import.meta.url), "utf8"),
  readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
]);

assert.match(capabilityRuntime, /async ensureConversationInstance\(/, "CapabilityRuntime must create conversation-owned MCP connections by default.");
assert.match(capabilityRuntime, /registerTool\("devspace_connection_isolation_status"/, "Every conversation needs a live isolation diagnostic surface.");
assert.match(capabilityRuntime, /Shared MCP connections are retired/, "CapabilityRuntime must reject an unowned shared MCP execution path.");
assert.match(capabilityRuntime, /setConversationResolver\(/, "CapabilityRuntime must receive the verified request-scoped conversation owner.");
assert.match(capabilityRuntime, /implicitConversationIsolation:\s*true/, "Implicit MCP connections must be marked as conversation-isolated.");
assert.match(capabilityRuntime, /if \(!instanceToken && input\.kind !== "tool"\)[\s\S]*ensureConversationInstance/, "Generic MCP calls must not fall back to a shared client.");
assert.match(capabilityRuntime, /resolveOrAdoptExisting\(/, "Blender MCP must preserve and adopt an existing unclaimed runtime.");
assert.doesNotMatch(
  capabilityRuntime.slice(capabilityRuntime.indexOf('server.registerTool("blender_mcp"'), capabilityRuntime.indexOf('server.registerTool("capability_call"'))),
  /runtime\.inspect\("blender-local"[\s\S]*probeMcp:\s*true/,
  "Blender execution must never route through the legacy shared catalogue connection.",
);
assert.match(blenderRuntime, /preservedExistingProcess:\s*true/, "Adopting a running Blender must explicitly preserve its process.");
assert.match(blenderRuntime, /belongs to another ChatGPT conversation/, "Runtime ownership must fail closed across conversations.");
assert.match(blenderRuntime, /More than one unclaimed Blender MCP runtime is online/, "Ambiguous unclaimed runtimes must never be guessed.");
assert.match(server, /sendToolListChanged\(\)/, "Core must notify existing ChatGPT sessions when the tool surface changes.");
assert.match(server, /capabilityRuntime\.setConversationResolver/, "Core must wire request identity into every capability/MCP connection path.");
assert.match(server, /mcp_tool_list_changed_sent/, "Tool-list refresh must be observable without exposing payloads.");
assert.match(agents, /conversation-isolated|conversation scoped|conversation-scoped/i, "Agent routing instructions must state the isolation boundary.");

console.log(JSON.stringify({
  ok: true,
  gate: "conversation-connection-isolation-static",
  genericMcpConversationIsolation: true,
  blenderExistingRuntimeAdoption: true,
  ambiguousRuntimeFailsClosed: true,
  sharedBlenderFallbackRemoved: true,
  toolListRefreshNotification: true,
}));
