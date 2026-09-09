import assert from "node:assert/strict";
import { buildUnifiedRoute, registerUnifiedRoutingTool } from "./unified-routing-tools.js";

const toolCatalog = {
  list() {
    return [
      { name: "read", title: "Read file", description: "Read a workspace file." },
      { name: "blender_mcp", title: "Operate Blender", description: "Execute Blender MCP tools." },
      { name: "devspace_progress_report", title: "Report progress", description: "Write an agent-authored progress milestone." },
    ];
  },
};
const capabilityRuntime = {
  async route(query) {
    if (!query.toLowerCase().includes("retopology")) return { primary: null, candidates: [] };
    return {
      primary: {
        routeId: "skill:blender-retopology",
        kind: "skill",
        name: "blender-retopology",
        description: "Manual animation-ready retopology guidance.",
        score: 90,
        nextAction: { tool: "capability_read", arguments: { pluginId: "blender-retopology", path: "SKILL.md" } },
      },
      candidates: [],
    };
  },
};
const workspaces = {
  getWorkspace() {
    return {
      skills: [{ name: "video-to-3d", description: "Reconstruct a character from a turntable into Blender.", path: "skills/video-to-3d/SKILL.md" }],
    };
  },
};

{
  const result = await buildUnifiedRoute({
    query: "Open two separate Blender runtimes for two agents on different ports",
    workspaceId: "ws-a",
    stage: "start",
    toolCatalog,
    capabilityRuntime,
    workspaces,
  });
  assert.equal(result.primary.routeId, "runtime:blender-isolated");
  assert.equal(result.primary.nextAction.tool, "blender_runtime");
  assert.match(result.routingFingerprint, /^[a-f0-9]{64}$/);
}

{
  const result = await buildUnifiedRoute({
    query: "Use Blender MCP to execute code and modify the live mesh",
    toolCatalog,
    capabilityRuntime,
    workspaces,
  });
  assert.equal(result.primary.nextAction.tool, "blender_mcp");
}

{
  const result = await buildUnifiedRoute({
    query: "Retopology the character before rigging",
    toolCatalog,
    capabilityRuntime,
    workspaces,
  });
  assert.equal(result.primary.routeId, "skill:blender-retopology");
  assert.equal(result.primary.nextAction.tool, "capability_read");
}

{
  const registered = new Map();
  const server = { registerTool(name, definition, handler) { registered.set(name, { definition, handler }); } };
  registerUnifiedRoutingTool(server, { toolCatalog, capabilityRuntime, workspaces });
  assert.ok(registered.has("devspace_route"));
  assert.match(registered.get("devspace_route").definition.description, /Single DevSpace routing entry point/);
  const called = await registered.get("devspace_route").handler({ query: "旁白卡匯報進度", stage: "continue", limit: 8 });
  assert.equal(called.structuredContent.primary.nextAction.tool, "devspace_progress_report");
}

console.log(JSON.stringify({
  ok: true,
  gate: "unified-routing-tools",
  routeKinds: ["tool", "skill", "plugin", "mcp", "workflow", "runtime"],
  progressiveDisclosure: true,
  executableNextAction: true,
}));
