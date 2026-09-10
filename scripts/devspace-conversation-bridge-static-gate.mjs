import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [bridge, blenderRuntime, agents, packageText] = await Promise.all([
  readFile(new URL("./devspace-conversation-bridge.mjs", import.meta.url), "utf8"),
  readFile(new URL("../dist/blender-runtime-manager.js", import.meta.url), "utf8"),
  readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
  readFile(new URL("../package.json", import.meta.url), "utf8"),
]);
const packageJson = JSON.parse(packageText);

assert.match(bridge, /classic-conversation-authority\.json/);
assert.match(bridge, /runtimeKeys/);
assert.match(bridge, /conversationIds/);
assert.match(bridge, /belongs to a different ChatGPT conversation/);
assert.match(bridge, /BLENDER_MCP_HOST/);
assert.match(bridge, /BLENDER_MCP_PORT/);
assert.match(bridge, /CapabilityRuntime/);
assert.match(bridge, /agent-progress-tool/);
assert.match(bridge, /\/__devspace\/progress/);
assert.doesNotMatch(bridge, /createStableGatewayHumanProgress/);
assert.match(bridge, /mcpToolFailed/);
assert.doesNotMatch(bridge, /process\.kill\([^,]+,\s*["']SIG(?:TERM|KILL|INT)/i);
assert.doesNotMatch(bridge, /spawn\s*\(/);

assert.match(blenderRuntime, /instanceId:\s*runtime\.runtimeId/);
assert.match(blenderRuntime, /BLENDER_MCP_HOST:\s*LOOPBACK/);
assert.match(blenderRuntime, /BLENDER_MCP_PORT:\s*String\(runtime\.port\)/);
assert.match(agents, /Host lazy-tool fallback/);
assert.match(agents, /devspace-conversation-bridge <status\|list\|call\|progress>/);
assert.match(agents, /do \*\*not\*\* wait for the palette/);
assert.match(agents, /must never choose between multiple unclaimed runtimes or terminate\/restart/);
assert.equal(packageJson.bin?.["devspace-conversation-bridge"], "scripts/devspace-conversation-bridge.mjs");

console.log(JSON.stringify({
  ok: true,
  gate: "conversation-tool-palette-bridge-static",
  conversationAuthority: true,
  existingRuntimeOwnership: true,
  officialBlenderMcpPortEnvironment: true,
  serializedGatewayProgressWrite: true,
  publicNpmBin: true,
  noRuntimeTermination: true,
  agentAuthoredProgress: true,
}));
