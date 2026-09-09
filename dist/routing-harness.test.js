import assert from "node:assert/strict";
import { buildUnifiedRoutePlan, ROUTE_KINDS, ROUTING_HARNESS_VERSION } from "./routing-harness.js";

assert.equal(ROUTING_HARNESS_VERSION, 1);
assert.deepEqual(ROUTE_KINDS, ["tool", "skill", "plugin", "mcp-server", "mcp-tool", "workflow", "runtime"]);

{
  const plan = buildUnifiedRoutePlan({
    query: "continue the character in my own Blender runtime and show meaningful progress",
    multiStep: true,
    capabilityRouting: {
      primary: {
        routeId: "mcp-tool:blender-local:blender:execute_blender_code",
        kind: "mcp-tool",
        name: "execute_blender_code",
        pluginId: "blender-local",
        serverId: "blender",
        toolName: "execute_blender_code",
        score: 250,
        nextAction: {
          tool: "blender_mcp",
          arguments: { action: "call", toolName: "execute_blender_code", arguments: {} },
          runtimeRoute: {
            kind: "runtime",
            managerTool: "blender_runtime",
            owner: "current-conversation",
            strategy: "reuse-owned-runtime-or-start-isolated",
            discovery: { tool: "blender_runtime", arguments: { action: "list" } },
            start: { tool: "blender_runtime", arguments: { action: "start", runtimeId: "<conversation-project-runtime>" } },
            bindArgument: "runtimeId",
          },
        },
      },
    },
  });
  assert.equal(plan.primary.kind, "mcp-tool");
  assert.deepEqual(plan.routeChain.map((route) => route.kind), ["workflow", "runtime", "mcp-tool"]);
  assert.equal(plan.routeChain[0].nextAction.tool, "devspace_plan_status");
  assert.equal(plan.routeChain[1].nextAction.tool, "blender_runtime");
  assert.equal(plan.routeChain[2].nextAction.tool, "blender_mcp");
  assert.match(plan.completionRule, /discovery alone is not completion/i);
}

{
  const plan = buildUnifiedRoutePlan({
    query: "read package.json",
    coreTools: [{ name: "read", description: "Read one workspace file", score: 100 }],
    multiStep: false,
  });
  assert.equal(plan.primary.kind, "tool");
  assert.equal(plan.workflow, null);
  assert.deepEqual(plan.routeChain.map((route) => route.routeId), ["tool:read"]);
  assert.equal(plan.nextAction.tool, "read");
}

{
  const plan = buildUnifiedRoutePlan({
    query: "use my explicit specialist",
    capabilityRouting: {
      primary: {
        routeId: "skill:explicit-only",
        kind: "skill",
        name: "explicit-only",
        score: 200,
        explicitOnly: true,
        nextAction: { tool: "capability_read", arguments: { pluginId: "x", path: "skills/x/SKILL.md" } },
      },
      candidates: [{ routeId: "plugin:fallback", kind: "plugin", name: "fallback", score: 50, nextAction: { tool: "capability_inspect" } }],
    },
    explicitQuery: false,
  });
  assert.equal(plan.primary.routeId, "plugin:fallback", "explicit-only skills must not win implicit routing");
}

{
  const plan = buildUnifiedRoutePlan({
    query: "continue autonomously across turns",
    multiStep: true,
    autonomousContinuation: true,
    coreTools: [{ name: "bash", description: "Run a command", score: 10 }],
  });
  assert.equal(plan.workflow.nextAction.tool, "devspace_goal_status");
  assert.equal(plan.workflow.nextAction.then.tool, "devspace_plan_start");
}

console.log(JSON.stringify({
  ok: true,
  gate: "routing-harness",
  routeKinds: ROUTE_KINDS,
  blenderChain: ["workflow", "runtime", "mcp-tool"],
  progressiveDisclosure: true,
  explicitOnlyFailClosed: true,
}));
