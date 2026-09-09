import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [runtime, server, blender] = await Promise.all([
  readFile(new URL("../dist/capability-runtime.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/server.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/blender-runtime-manager.js", import.meta.url), "utf8"),
]);

assert.match(runtime, /server\.registerTool\("capability_connection"/);
assert.match(runtime, /shared\/stateless servers use one pooled connection/i);
assert.match(runtime, /Stateful application servers use isolated instances bound to pluginId, serverId, runtimeId/i);
assert.match(runtime, /ownerConversationId/);
assert.match(runtime, /instanceTokenForRuntime/);
assert.match(runtime, /connectionSnapshot/);
assert.match(runtime, /async reconnect/);
assert.doesNotMatch(runtime, /DEFAULT_INSTANCE_LEASE_MS|MAX_INSTANCE_LEASE_MS|leaseSeconds:\s*z\./,
  "isolated MCP connections must not expire because of a wall-clock lease");

assert.match(server, /new BlenderRuntimeManager/);
assert.match(server, /registerCapabilityTools\(server, capabilityRuntime, \{ modelInstructionsFingerprint, resolveConversation: resolveConversationAuthority, blenderRuntimeManager \}\)/);
assert.match(blender, /ownerConversationId/);
assert.match(blender, /DEVSPACE_BLENDER_PORT/);
assert.match(blender, /await this\.#waitForReady\(record, child\)/);
assert.doesNotMatch(blender, /AbortSignal\.timeout|timed out|deadline exceeded|SIGKILL/i,
  "Blender runtime startup and ownership must not be terminated by a wall-clock deadline or forced kill");

console.log(JSON.stringify({
  ok: true,
  gate: "connection-manager-static",
  sharedPooling: true,
  isolatedRuntimeOwnership: true,
  explicitReconnectRelease: true,
  noLeaseTimeout: true,
  noStartupDeadline: true,
}));
