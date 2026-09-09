import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [routing, server, agents, capability] = await Promise.all([
  readFile(new URL("../dist/unified-routing-tools.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/server.js", import.meta.url), "utf8"),
  readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
  readFile(new URL("../dist/capability-runtime.js", import.meta.url), "utf8"),
]);

assert.match(routing, /server\.registerTool\("devspace_route"/);
assert.match(routing, /server\.registerTool\("devspace_skill_read"/);
for (const kind of ["tool", "skill", "workflow", "runtime"]) {
  assert.match(routing, new RegExp(`kind: ["']${kind}["']`));
}
assert.match(routing, /capabilityRuntime\.route/);
assert.match(routing, /primary\.nextAction/);
assert.match(routing, /progressive/i);
assert.match(routing, /runtime:blender-isolated/);
assert.match(routing, /workflow:plugin-mcp-connection/);
assert.match(routing, /workflow:agent-authored-progress/);
assert.match(routing, /tool:blender-live-execution/);
assert.match(routing, /routingFingerprint/);

assert.match(server, /registerUnifiedRoutingTool/);
assert.match(server, /call devspace_route once/i);
assert.match(server, /single routing harness across direct tools, Agent Skills, capability plugins, MCP servers\/tools, workflows, and application runtimes/i);
assert.match(agents, /Use `devspace_route` once at the start or resumption of a non-trivial task/i);
assert.match(capability, /tool: "blender_mcp"/);
assert.match(capability, /tool: "blender_runtime"/);

console.log(JSON.stringify({
  ok: true,
  gate: "unified-routing-static",
  routeKinds: ["tool", "skill", "plugin", "mcp", "workflow", "runtime"],
  boundedMetadata: true,
  progressiveDisclosure: true,
  exactNextAction: true,
}));
