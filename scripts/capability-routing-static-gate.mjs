import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [routing, runtime, parity, server, stable, agents] = await Promise.all([
  readFile(new URL("../dist/capability-routing.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/capability-runtime.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/codex-parity-tools.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/server.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/stable-gateway-candidate.js", import.meta.url), "utf8"),
  readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
]);

assert.match(routing, /ROUTING_CONTRACT_VERSION/);
assert.match(routing, /rankCapabilityRoutes/);
assert.match(routing, /capabilityRoutingFingerprint/);
assert.match(routing, /allowImplicitInvocation/);
assert.match(routing, /negativeTriggers/);
assert.match(routing, /explicit-invocation-required/);
assert.match(routing, /excluded-by:/);
assert.match(routing, /nextAction/);
assert.match(routing, /Script=Han/);

assert.match(runtime, /agents[\\"']?,?\s*[\\"']openai\.yaml/);
assert.match(runtime, /interfaceMetadata\.display_name/);
assert.match(runtime, /interfaceMetadata\.short_description/);
assert.match(runtime, /interfaceMetadata\.default_prompt/);
assert.match(runtime, /metadataPolicy/);
assert.match(runtime, /dependencies/);
assert.match(runtime, /server\.registerTool\("capability_route"/);
assert.match(runtime, /Follow primary\.nextAction exactly/i);
assert.match(runtime, /read-full-skill-before-substantive-work/);
assert.match(runtime, /routingContractVersion/);
assert.match(runtime, /routingFingerprint/);
assert.match(runtime, /onRoutingChanged/);
assert.match(runtime, /capabilityRouteRegistration\.update/);
assert.match(runtime, /notifications\/tools\/list_changed|sendToolListChanged|listChanged/, "registered tool updates must use the MCP tool-list change capability");

assert.match(parity, /capabilityRuntime\.route/);
assert.match(parity, /workspaceSkillRouteCandidates/);
assert.match(parity, /workspaceSkillRouting/);
assert.match(parity, /deferredRouting/);
assert.match(parity, /capabilityRouting/);
assert.match(parity, /recommendedRoute/);
assert.match(parity, /nextAction/);
assert.match(parity, /routingContractVersion/);

assert.match(server, /call devspace_route once before falling back/i);
assert.match(server, /single routing harness across direct tools, Agent Skills, capability plugins, MCP servers\/tools, workflows, and application runtimes/i);
assert.match(server, /SKILL\.md before substantive work|call capability_read for that one SKILL\.md/i);
assert.match(server, /explicit-only skill must never be invoked implicitly/i);
assert.match(server, /Use tool_search as the unified direct\/deferred router/i);
assert.match(server, /pass that same workspaceId to tool_search/i);
assert.match(server, /modelInstructionsFingerprint/);

assert.match(stable, /description:\s*String\(tool\?\.description/);
assert.match(stable, /outputSchema:\s*tool\?\.outputSchema/);
assert.match(stable, /_meta:\s*tool\?\._meta/);

assert.match(agents, /Capability routing contract/);
assert.match(agents, /routing\.aliases/);
assert.match(agents, /routing\.exclude/);
assert.match(agents, /policy\.allow_implicit_invocation/);

console.log(JSON.stringify({
  ok: true,
  gate: "capability-routing-static",
  codexStyleProgressiveDisclosure: true,
  taskLevelRouter: true,
  workspaceAndPluginSkillRouting: true,
  skillInterfaceMetadata: true,
  explicitOnlyGate: true,
  negativeApplicabilityGate: true,
  directDeferredToolSearch: true,
  liveToolListChangedNotification: true,
  modelSurfaceFingerprint: true,
}));
