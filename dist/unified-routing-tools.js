import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as z from "zod/v4";

export const UNIFIED_ROUTING_VERSION = 1;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function text(value) {
  return String(value ?? "").trim();
}

function tokens(value) {
  return [...new Set(text(value).toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [])];
}

function normalizeArray(value) {
  return [...new Set((Array.isArray(value) ? value : value == null ? [] : [value]).map(text).filter(Boolean))];
}

function scoreText(query, fields, { phrases = [], exclusions = [], priority = 0 } = {}) {
  const normalizedQuery = text(query).toLowerCase();
  const haystack = normalizeArray(fields).join(" ").toLowerCase();
  if (!normalizedQuery || !haystack) return Number(priority) || 0;
  for (const exclusion of exclusions) {
    if (normalizedQuery.includes(String(exclusion).toLowerCase())) return -1000;
  }
  let score = Number(priority) || 0;
  for (const token of tokens(normalizedQuery)) {
    if (haystack.includes(token)) score += token.length >= 6 ? 12 : 7;
  }
  for (const phrase of phrases) {
    const normalized = String(phrase).toLowerCase();
    if (normalized && normalizedQuery.includes(normalized)) score += 28;
  }
  if (haystack.includes(normalizedQuery)) score += 36;
  return score;
}

function coreToolCandidate(tool, query) {
  const name = text(tool?.name);
  if (!name || name === "devspace_route") return null;
  const score = scoreText(query, [name, tool?.title, tool?.description], {
    priority: name === "tool_search" || name === "capability_route" ? -20 : 0,
  });
  if (score <= 0) return null;
  return {
    routeId: `tool:${name}`,
    kind: "tool",
    name,
    title: text(tool?.title) || name,
    description: text(tool?.description),
    score,
    source: "core-tool-catalog",
    nextAction: { tool: name, arguments: {} },
  };
}

function workspaceSkillCandidate(skill, query, workspaceId) {
  const name = text(skill?.name);
  if (!name) return null;
  const score = scoreText(query, [name, skill?.description], { priority: 4 });
  if (score <= 0) return null;
  return {
    routeId: `workspace-skill:${workspaceId}:${name}`,
    kind: "skill",
    name,
    title: name,
    description: text(skill?.description),
    score,
    source: "workspace-skill",
    nextAction: {
      tool: "devspace_skill_read",
      arguments: { workspaceId, skillName: name },
      then: "Follow the selected SKILL.md and continue to its declared plugin, runtime, or execution tool.",
    },
  };
}

const BUILTIN_ROUTES = [
  {
    routeId: "workflow:plugin-mcp-connection",
    kind: "workflow",
    name: "plugin-mcp-connection",
    title: "Plugin and MCP connection lifecycle",
    description: "Inspect, pool, isolate, reconnect, or explicitly release plugin/MCP connections and per-runtime ports.",
    phrases: ["mcp connection", "plugin connection", "second port", "different port", "multiple agent", "two agents", "reconnect mcp", "連線", "第二個 port", "多個 agent"],
    aliases: ["shared connection", "isolated connection", "runtime owner", "connection manager", "port binding", "MCP 連線管理", "插件連線"],
    priority: 24,
    nextAction: { tool: "capability_connection", arguments: { action: "status" } },
  },
  {
    routeId: "runtime:blender-isolated",
    kind: "runtime",
    name: "blender-runtime",
    title: "Transferable Blender runtime",
    description: "Start or reuse a Blender process, loopback port, and isolated MCP runtime that can be continued by a later ChatGPT conversation through the same runtimeId.",
    phrases: ["two blender", "multiple blender", "second blender", "separate blender", "different blender port", "雙 blender", "兩個 blender", "各自 blender", "第二個 port"],
    aliases: ["blender runtime", "isolated blender", "parallel blender", "separate process", "runtimeId"],
    priority: 34,
    nextAction: { tool: "blender_runtime", arguments: { action: "list" }, then: "Reuse the matching runtimeId/process/port even after a conversation handoff. If exactly one runtime is online it can be continued directly; if several are online, select runtimeId explicitly. Start a new runtime only for a separate Blender project, then call blender_mcp." },
  },
  {
    routeId: "tool:blender-live-execution",
    kind: "tool",
    name: "blender-mcp",
    title: "Operate live Blender",
    description: "Inspect or modify the selected live Blender application through the authoritative blender-local MCP backend.",
    phrases: ["operate blender", "edit blender", "blender mcp", "execute_blender_code", "render blender", "modify blender", "操作 blender", "修改 blender"],
    aliases: ["bpy", "blend file", "scene", "mesh", "material", "rig", "render", "viewport"],
    exclusions: ["conceptual blender advice", "no blender access"],
    priority: 22,
    nextAction: { tool: "blender_mcp", arguments: { action: "list" }, then: "Immediately call blender_mcp(action=call) with a returned schema-valid tool." },
  },
  {
    routeId: "workflow:agent-authored-progress",
    kind: "workflow",
    name: "agent-authored-progress",
    title: "Agent-authored progress narration",
    description: "Publish one natural-language progress update before substantive multi-step Main work and after a coherent medium-sized milestone, verification, direction change, blocker, or stale long phase. The Local Gateway rejects a second substantive unplanned tool, active-Plan work without preflight, stale continuation, and Plan completion until the exact Main conversation has a verified Agent-authored report.",
    phrases: ["progress narration", "progress card", "旁白卡", "匯報進度", "report progress"],
    aliases: ["milestone", "verification", "blocker", "direction change", "floating progress"],
    priority: 18,
    nextAction: { tool: "devspace_progress_report", arguments: { kind: "milestone", message: "<write a concise user-facing update in your own words>" } },
  },
  {
    routeId: "workflow:multi-step-plan",
    kind: "workflow",
    name: "multi-step-plan",
    title: "Conversation-bound execution plan",
    description: "Create or resume one Plan for multi-stage work and keep structured status current without synthetic narration.",
    phrases: ["multi-step", "long-running", "continue the work", "complete the remaining", "多步驟", "繼續完成", "長時間工作"],
    aliases: ["plan", "verification gates", "implementation stages"],
    priority: 10,
    nextAction: { tool: "devspace_plan_status", arguments: { planId: "<existing plan id when known>" }, then: "Resume the existing Plan; otherwise call devspace_plan_start before substantive work." },
  },
];

function builtinCandidate(entry, query) {
  const score = scoreText(query, [entry.name, entry.title, entry.description, ...entry.aliases], {
    phrases: entry.phrases,
    exclusions: entry.exclusions,
    priority: entry.priority,
  });
  if (score <= 0) return null;
  return { ...entry, score, source: "devspace-workflow-catalog" };
}

function normalizeCapabilityCandidate(candidate) {
  if (!candidate?.routeId || !candidate?.nextAction) return null;
  return {
    ...candidate,
    score: Number(candidate.score || 0) + 6,
    source: candidate.source || "capability-routing",
  };
}

function fingerprint(candidates) {
  const normalized = candidates.map((candidate) => ({
    routeId: candidate.routeId,
    kind: candidate.kind,
    name: candidate.name,
    description: candidate.description,
    nextAction: candidate.nextAction,
  })).sort((a, b) => a.routeId.localeCompare(b.routeId));
  return createHash("sha256").update(JSON.stringify({ version: UNIFIED_ROUTING_VERSION, candidates: normalized })).digest("hex");
}

export async function buildUnifiedRoute({
  query,
  workspaceId,
  stage = "continue",
  limit = 8,
  toolCatalog,
  capabilityRuntime,
  workspaces,
} = {}) {
  const routeQuery = text(query);
  if (!routeQuery) throw new Error("query is required.");
  const candidates = [];

  const listedTools = typeof toolCatalog?.list === "function" ? toolCatalog.list() : [];
  for (const tool of Array.isArray(listedTools) ? listedTools : []) {
    const candidate = coreToolCandidate(tool, routeQuery);
    if (candidate) candidates.push(candidate);
  }

  if (capabilityRuntime?.route) {
    const routed = await capabilityRuntime.route(routeQuery);
    const capabilityCandidates = [routed?.primary, ...(routed?.candidates || [])];
    for (const value of capabilityCandidates) {
      const candidate = normalizeCapabilityCandidate(value);
      if (candidate) candidates.push(candidate);
    }
  }

  if (workspaceId && workspaces?.getWorkspace) {
    const workspace = workspaces.getWorkspace(workspaceId);
    for (const skill of workspace?.skills || []) {
      const candidate = workspaceSkillCandidate(skill, routeQuery, workspaceId);
      if (candidate) candidates.push(candidate);
    }
  }

  for (const entry of BUILTIN_ROUTES) {
    const candidate = builtinCandidate(entry, routeQuery);
    if (candidate) candidates.push(candidate);
  }

  const deduped = new Map();
  for (const candidate of candidates) {
    const existing = deduped.get(candidate.routeId);
    if (!existing || candidate.score > existing.score) deduped.set(candidate.routeId, candidate);
  }
  const ranked = [...deduped.values()]
    .sort((a, b) => b.score - a.score || a.routeId.localeCompare(b.routeId))
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 8)));
  const primary = ranked[0] || null;
  const second = ranked[1] || null;
  return {
    ok: true,
    routingVersion: UNIFIED_ROUTING_VERSION,
    routingFingerprint: fingerprint([...deduped.values()]),
    query: routeQuery,
    stage,
    candidateCount: deduped.size,
    ambiguous: Boolean(primary && second && primary.score - second.score < 5),
    primary,
    candidates: ranked,
    instruction: primary
      ? "Follow primary.nextAction now. Reading a catalog or SKILL.md is not completion; continue through the declared runtime/plugin/tool and verify the real result."
      : "No route matched strongly. Use the smallest direct core tool that satisfies the request and do not bulk-load unrelated plugins or skills.",
  };
}

export function registerUnifiedRoutingTool(server, dependencies = {}) {
  server.registerTool("devspace_skill_read", {
    title: "Read One Routed Agent Skill",
    description: "Load exactly one SKILL.md that was already discovered for the opened workspace. Use only after devspace_route selects that skill. The path is resolved from the trusted workspace skill inventory, so callers cannot use this tool to read arbitrary files outside the workspace or configured skill roots.",
    inputSchema: {
      workspaceId: z.string().min(1),
      skillName: z.string().min(1).max(220),
    },
    annotations: READ_ONLY,
  }, async ({ workspaceId, skillName }) => {
    try {
      const workspace = dependencies.workspaces?.getWorkspace?.(workspaceId);
      if (!workspace) throw new Error(`Unknown workspace ${workspaceId}.`);
      const skill = (workspace.skills || []).find((entry) => text(entry?.name) === text(skillName));
      if (!skill) throw new Error(`Skill ${skillName} is not present in the trusted workspace skill inventory.`);
      const path = text(skill.path || skill.filePath);
      if (!path) throw new Error(`Skill ${skillName} has no readable SKILL.md path.`);
      const content = await readFile(path.replace(/^~(?=[\\/])/, process.env.USERPROFILE || process.env.HOME || ""), "utf8");
      const result = { ok: true, workspaceId, skillName: skill.name, path, content };
      return { content: [{ type: "text", text: content }], structuredContent: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { isError: true, content: [{ type: "text", text: message }], structuredContent: { ok: false, error: message } };
    }
  });

  server.registerTool("devspace_route", {
    title: "Route Task Across Tools, Skills, Plugins, MCP and Runtimes",
    description: "Single DevSpace routing entry point. Use once at the start or resumption of a non-trivial task to rank the smallest correct route across direct tools, workspace/agent skills, capability plugins, MCP servers/tools, workflows, and application runtimes. Follow primary.nextAction exactly and continue to real execution; never stop after merely listing a capability. Use progressive disclosure and inspect at most the top two ambiguous candidates.",
    inputSchema: {
      query: z.string().min(1).max(4000),
      workspaceId: z.string().min(1).optional(),
      stage: z.enum(["start", "continue", "verify", "recover"]).default("continue"),
      limit: z.number().int().min(1).max(20).default(8),
    },
    annotations: READ_ONLY,
  }, async (input) => {
    try {
      const result = await buildUnifiedRoute({ ...input, ...dependencies });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { isError: true, content: [{ type: "text", text: message }], structuredContent: { ok: false, error: message } };
    }
  });
}

export const unifiedRoutingInternals = { scoreText, coreToolCandidate, workspaceSkillCandidate, builtinCandidate, BUILTIN_ROUTES };
