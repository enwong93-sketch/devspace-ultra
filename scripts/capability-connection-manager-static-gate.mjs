import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const [runtime, connectionManager, blender, bootstrap, server, codexBridge, stableGateway] = await Promise.all([
  readFile(resolve(root, "dist/capability-runtime.js"), "utf8"),
  readFile(resolve(root, "dist/capability-connection-manager.js"), "utf8"),
  readFile(resolve(root, "dist/blender-runtime-manager.js"), "utf8"),
  readFile(resolve(root, "scripts/blender-runtime-bootstrap.py"), "utf8"),
  readFile(resolve(root, "dist/server.js"), "utf8"),
  readFile(resolve(root, "dist/codex-mcp-bridge.js"), "utf8"),
  readFile(resolve(root, "scripts/devspace-stable-gateway.mjs"), "utf8"),
]);

assert.match(runtime, /server\.registerTool\("capability_connection"/);
assert.match(runtime, /source:\s*z\.enum\(\["all",\s*"capability",\s*"codex"\]\)/);
assert.match(runtime, /ownerConversationId/);
assert.match(runtime, /server\.registerTool\("blender_runtime"/);
assert.match(runtime, /server\.registerTool\("blender_mcp"[\s\S]*runtimeId/);
assert.match(runtime, /blenderRuntimeManager\?\.instanceToken\(input\.runtimeId, ownerConversationId\)/);
assert.doesNotMatch(runtime, /leaseSeconds|expiresAt\s*=\s*new Date|MCP_CONNECT_TIMEOUT|MCP_CALL_TIMEOUT/);

assert.match(connectionManager, /scope:\s*instance\s*\?\s*"isolated"\s*:\s*"shared"/);
assert.match(connectionManager, /ownerConversationId/);
assert.match(connectionManager, /belongs to another conversation/);
assert.doesNotMatch(connectionManager, /leaseSeconds|setTimeout|expiresAt\s*=\s*new Date/);

assert.match(blender, /reserveFreePort/);
assert.match(blender, /DEVSPACE_BLENDER_PORT/);
assert.match(blender, /ownerConversationId/);
assert.match(blender, /capabilityRuntime\.claimInstance/);
assert.match(blender, /capabilityRuntime\.getMcpClient/);
assert.match(blender, /processTerminated/);
assert.doesNotMatch(blender, /AbortSignal\.timeout|Promise\.race[\s\S]*timeout|timed out after|startup timeout|leaseSeconds|leaseMs|expiresAt/);
assert.match(blender, /setTimeout\(resolvePromise,\s*250\)/, "Blender readiness may poll liveness, but the polling delay must never become a startup deadline");

assert.match(bootstrap, /use_preferences_save\s*=\s*False/);
assert.match(bootstrap, /preferences\.port\s*=\s*PORT/);
assert.match(bootstrap, /127\.0\.0\.1/);

assert.match(server, /new BlenderRuntimeManager/);
assert.match(server, /registerCapabilityTools\([\s\S]*blenderRuntimeManager/);
assert.match(server, /createMcpServer\([\s\S]*capabilityRuntime, blenderRuntimeManager, codexMcpBridge/);
assert.match(server, /registerCapabilityTools\([\s\S]*codexMcpBridge/);
assert.match(codexBridge, /listConnections\(/);
assert.match(codexBridge, /resetConnection\(/);
assert.match(codexBridge, /reconnectOnNextUse:\s*true/);
assert.match(stableGateway, /activityJournal/, "Gateway/Core keeps structured diagnostics without projecting them as user narration");
assert.doesNotMatch(stableGateway, /activityJournal\s*=\s*null/, "Structured diagnostics must remain enabled; only visible narration is agent-authored");

console.log(JSON.stringify({
  ok: true,
  gate: "capability-connection-manager-static",
  sharedPool: true,
  isolatedRuntimeOwnership: true,
  blenderMultiPortRuntime: true,
  codexMcpConnections: true,
  agentAuthoredProgressOnly: true,
  noLeaseTimeout: true,
}));
