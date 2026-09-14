import assert from "node:assert/strict";
import {
  ROUTING_CONTRACT_VERSION,
  capabilityRoutingFingerprint,
  normalizeRoutingPolicy,
  rankCapabilityRoutes,
} from "./capability-routing.js";

const candidates = [
  {
    routeId: "plugin:blender-suite",
    kind: "plugin",
    name: "blender-suite",
    title: "Blender Production Suite",
    description: "General Blender modeling, rigging, animation, retopology, and rendering workflows.",
    aliases: ["Blender 3D production"],
    pluginId: "blender-suite",
    nextAction: { tool: "capability_inspect", arguments: { pluginId: "blender-suite", probeMcp: false } },
  },
  {
    routeId: "skill:blender-suite:retopology",
    kind: "skill",
    name: "retopology",
    title: "Blender Retopology",
    shortDescription: "Clean topology and animation-ready quad edge flow",
    description: "Use after sculpting or generated meshes before rigging, UVs, and animation.",
    aliases: ["retopo", "quad remesh", "edge loops", "拓撲重建"],
    negativeTriggers: ["texture only"],
    pluginId: "blender-suite",
    path: "skills/retopology/SKILL.md",
    nextAction: { tool: "capability_read", arguments: { pluginId: "blender-suite", path: "skills/retopology/SKILL.md" } },
  },
  {
    routeId: "skill:blender-suite:review-agent",
    kind: "skill",
    name: "review-agent",
    title: "Review Agent",
    description: "Review code changes and return actionable findings.",
    allowImplicitInvocation: false,
    pluginId: "blender-suite",
    path: "skills/review-agent/SKILL.md",
    nextAction: { tool: "capability_read", arguments: { pluginId: "blender-suite", path: "skills/review-agent/SKILL.md" } },
  },
  {
    routeId: "mcp-tool:blender-suite:blender:execute",
    kind: "mcp-tool",
    name: "execute_blender_code",
    title: "Execute Blender Code",
    description: "Execute Python inside the active Blender project.",
    aliases: ["run blender python"],
    pluginId: "blender-suite",
    serverId: "blender",
    toolName: "execute_blender_code",
    available: false,
    availabilityReason: "mcp-server-offline",
    nextAction: { tool: "capability_call", arguments: { pluginId: "blender-suite", kind: "mcp", serverId: "blender", toolName: "execute_blender_code" } },
  },
];

const retopo = rankCapabilityRoutes("幫我做角色 retopo 同 quad edge loops", candidates, { limit: 8 });
assert.equal(retopo.version, ROUTING_CONTRACT_VERSION);
assert.equal(retopo.primary.routeId, "skill:blender-suite:retopology");
assert.equal(retopo.primary.nextAction.tool, "capability_read");
assert.equal(retopo.primary.eligible, true);
assert.equal(retopo.primary.matchedFields.includes("name") || retopo.primary.matchedFields.includes("aliases"), true);

const chinese = rankCapabilityRoutes("幫角色做拓撲重建，之後先綁骨", candidates);
assert.equal(chinese.primary.routeId, "skill:blender-suite:retopology");

const excluded = rankCapabilityRoutes("texture only retopology", candidates);
const excludedSkill = excluded.candidates.find((candidate) => candidate.routeId === "skill:blender-suite:retopology");
assert.match(excludedSkill.blockedReason, /^excluded-by:/);

const maintenance = rankCapabilityRoutes("verify DevSpace source working tree scheduled startup canonical backend legacy artifacts", candidates);
assert.equal(maintenance.primary, null, "long DevSpace maintenance queries must not route to an unrelated Blender candidate from one incidental term");

const implicitReview = rankCapabilityRoutes("review these code changes", candidates);
const reviewImplicit = implicitReview.candidates.find((candidate) => candidate.routeId === "skill:blender-suite:review-agent");
assert.equal(reviewImplicit.eligible, false);
assert.equal(reviewImplicit.blockedReason, "explicit-invocation-required");
const explicitReview = rankCapabilityRoutes("Use $review-agent", candidates);
assert.equal(explicitReview.primary.routeId, "skill:blender-suite:review-agent");
assert.equal(explicitReview.primary.explicitMatch, true);

const unavailable = rankCapabilityRoutes("execute blender code", candidates);
const unavailableTool = unavailable.candidates.find((candidate) => candidate.kind === "mcp-tool");
assert.equal(unavailableTool.eligible, false);
assert.equal(unavailableTool.blockedReason, "mcp-server-offline");
assert.notEqual(unavailable.primary?.routeId, unavailableTool.routeId);

const policy = normalizeRoutingPolicy({
  aliases: ["one"],
  exclude: ["not this"],
  allow_implicit_invocation: false,
  priority: 7,
});
assert.deepEqual(policy, {
  aliases: ["one"],
  negativeTriggers: ["not this"],
  allowImplicitInvocation: false,
  exposure: "explicit-only",
  priority: 7,
});

const fingerprint = capabilityRoutingFingerprint(candidates);
assert.match(fingerprint, /^[a-f0-9]{64}$/);
assert.notEqual(
  fingerprint,
  capabilityRoutingFingerprint(candidates.map((candidate, index) => index === 1
    ? { ...candidate, shortDescription: "Changed route-facing description" }
    : candidate)),
  "route descriptions must invalidate the routing surface",
);
assert.notEqual(
  fingerprint,
  capabilityRoutingFingerprint(candidates.map((candidate, index) => index === 1
    ? { ...candidate, allowImplicitInvocation: false }
    : candidate)),
  "implicit-invocation policy must invalidate the routing surface",
);

console.log(JSON.stringify({
  ok: true,
  gate: "capability-routing",
  version: ROUTING_CONTRACT_VERSION,
  deterministicFieldedRouting: true,
  cjkAliases: true,
  explicitOnlyGate: true,
  negativeTriggerGate: true,
  unavailableRouteGate: true,
  routeFingerprint: true,
}));
