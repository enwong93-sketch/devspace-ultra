import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const [harness, parity, capability, server] = await Promise.all([
  readFile(resolve(root, "dist/routing-harness.js"), "utf8"),
  readFile(resolve(root, "dist/codex-parity-tools.js"), "utf8"),
  readFile(resolve(root, "dist/capability-runtime.js"), "utf8"),
  readFile(resolve(root, "dist/server.js"), "utf8"),
]);

for (const kind of ["tool", "skill", "plugin", "mcp-server", "mcp-tool", "workflow", "runtime"]) {
  assert.match(harness, new RegExp(`"${kind}"`), `routing harness must cover ${kind}`);
}
assert.match(harness, /buildUnifiedRoutePlan/);
assert.match(harness, /progressiveDisclosure/);
assert.match(harness, /discovery alone is not completion/i);
assert.match(harness, /runtimeCandidateFromAction/);
assert.match(harness, /workflow:interactive-progress/);

assert.match(parity, /name !== "tool_search"/);
assert.match(parity, /single model-facing routing entry point/i);
assert.match(parity, /routingHarness\.routeChain/i);
assert.match(parity, /buildUnifiedRoutePlan/);
assert.match(parity, /routingHarnessFingerprint/);

assert.match(capability, /mcpServerRequiresIsolatedRuntime/);
assert.match(capability, /managerTool:\s*"capability_connection"/);
assert.match(capability, /managerTool:\s*"blender_runtime"/);
assert.match(capability, /bindArgument:\s*"instanceToken"/);
assert.match(capability, /bindArgument:\s*"runtimeId"/);
assert.match(capability, /server\.registerTool\("capability_route"/);

assert.match(server, /devspace_route[\s\S]*single routing harness/i);
assert.match(server, /blender_mcp is the explicit execution entry point/i);

console.log(JSON.stringify({
  ok: true,
  gate: "routing-harness-static",
  unifiedToolSearch: true,
  routeKinds: 7,
  progressiveDisclosure: true,
  runtimePrerequisites: true,
}));
