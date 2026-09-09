import { createHash } from "node:crypto";

export const ROUTING_HARNESS_VERSION = 1;
export const ROUTE_KINDS = Object.freeze([
  "tool",
  "skill",
  "plugin",
  "mcp-server",
  "mcp-tool",
  "workflow",
  "runtime",
]);

function text(value, max = 2000) {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized.slice(0, max) : null;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function routeId(route, fallbackKind = "tool") {
  return text(route?.routeId || route?.id)
    || `${text(route?.kind) || fallbackKind}:${text(route?.pluginId || route?.name) || "unknown"}`;
}

function normalizedCandidate(route, fallbackKind = "tool") {
  const source = object(route);
  const kind = ROUTE_KINDS.includes(source.kind) ? source.kind : fallbackKind;
  return {
    routeId: routeId(source, kind),
    kind,
    name: text(source.name || source.toolName || source.pluginId) || routeId(source, kind),
    description: text(source.description || source.reason || source.summary, 4000),
    score: Number.isFinite(Number(source.score)) ? Number(source.score) : 0,
    pluginId: text(source.pluginId),
    serverId: text(source.serverId),
    toolName: text(source.toolName),
    skillPath: text(source.skillPath || source.path, 4000),
    available: source.available !== false,
    explicitOnly: source.explicitOnly === true,
    nextAction: source.nextAction ? structuredClone(source.nextAction) : null,
    source: text(source.source) || null,
  };
}

function directToolCandidates(coreTools) {
  return array(coreTools).map((tool) => normalizedCandidate({
    routeId: `tool:${tool?.name || "unknown"}`,
    kind: "tool",
    name: tool?.name,
    description: tool?.description,
    score: Number(tool?.score || 0),
    available: true,
    source: "core-tool-catalog",
    nextAction: {
      tool: tool?.name,
      arguments: {},
    },
  }));
}

function capabilityCandidates(capabilityRouting) {
  const routing = object(capabilityRouting);
  const candidates = [routing.primary, ...array(routing.candidates)].filter(Boolean);
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const normalized = normalizedCandidate(candidate, candidate?.kind || "plugin");
    if (seen.has(normalized.routeId)) continue;
    seen.add(normalized.routeId);
    result.push({ ...normalized, source: normalized.source || "capability-routing" });
  }
  return result;
}

function workspaceSkillCandidates(workspaceSkillRouting) {
  const routing = object(workspaceSkillRouting);
  const candidates = [routing.primary, ...array(routing.candidates)].filter(Boolean);
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const normalized = normalizedCandidate({
      ...candidate,
      routeId: candidate?.routeId || `skill:${candidate?.name || "workspace"}`,
      kind: "skill",
      skillPath: candidate?.skillPath || candidate?.path,
      nextAction: candidate?.nextAction || {
        tool: "read",
        arguments: { path: candidate?.skillPath || candidate?.path || "SKILL.md" },
      },
      source: "workspace-skill-routing",
    }, "skill");
    if (seen.has(normalized.routeId)) continue;
    seen.add(normalized.routeId);
    result.push(normalized);
  }
  return result;
}

function codexMcpCandidates(codexMcp) {
  return array(codexMcp).map((entry) => normalizedCandidate({
    routeId: `mcp-server:codex:${entry?.id || entry?.name || "unknown"}`,
    kind: "mcp-server",
    name: entry?.id || entry?.name,
    description: entry?.description,
    score: Number(entry?.score || 0),
    serverId: entry?.id || entry?.name,
    available: entry?.status !== "disabled" && entry?.status !== "unavailable",
    source: "codex-mcp-catalog",
    nextAction: {
      tool: "codex_mcp_inspect",
      arguments: { serverId: entry?.id || entry?.name },
    },
  }, "mcp-server"));
}

function progressWorkflow({ multiStep, autonomousContinuation }) {
  if (!multiStep && !autonomousContinuation) return null;
  return normalizedCandidate({
    routeId: "workflow:interactive-progress",
    kind: "workflow",
    name: "Interactive progress workflow",
    description: autonomousContinuation
      ? "Resume or start a conversation-bound Goal and current-turn Plan before multi-turn autonomous execution."
      : "Resume or start one conversation-bound Plan before multi-step execution.",
    score: autonomousContinuation ? 1000 : 900,
    source: "routing-harness",
    nextAction: autonomousContinuation
      ? {
          tool: "devspace_goal_status",
          arguments: { goalId: "<existing-goal-id>" },
          fallback: { tool: "devspace_goal_start", arguments: { objective: "<user-outcome>", successCriteria: ["<observable acceptance>"] } },
          then: { tool: "devspace_plan_start", arguments: { title: "<current-turn execution>", steps: ["<verified step>"] } },
        }
      : {
          tool: "devspace_plan_status",
          arguments: { planId: "<existing-plan-id>" },
          fallback: { tool: "devspace_plan_start", arguments: { title: "<task>", steps: ["<verified step>"] } },
        },
  }, "workflow");
}

function runtimeCandidateFromAction(action, primary) {
  const runtime = object(action?.runtimeRoute);
  if (!runtime.managerTool) return null;
  return normalizedCandidate({
    routeId: `runtime:${primary?.pluginId || primary?.name || "application"}`,
    kind: "runtime",
    name: `${primary?.name || primary?.pluginId || "Application"} runtime`,
    description: `Acquire or reuse the current conversation's isolated runtime before executing ${primary?.name || "the selected capability"}.`,
    score: Number(primary?.score || 0) + 1,
    pluginId: primary?.pluginId,
    serverId: primary?.serverId,
    source: "runtime-prerequisite",
    nextAction: {
      tool: runtime.managerTool,
      arguments: structuredClone(runtime.discovery?.arguments || { action: "list" }),
      fallback: structuredClone(runtime.start || null),
      bindArgument: runtime.bindArgument || "runtimeId",
      strategy: runtime.strategy || "reuse-or-start",
      owner: runtime.owner || "current-conversation",
    },
  }, "runtime");
}

function progressiveDisclosure(candidate) {
  if (!candidate) return [];
  if (candidate.kind === "skill") {
    return [
      { stage: "metadata", loaded: true, content: "name + routing description" },
      { stage: "selected-skill", action: candidate.nextAction || { tool: "capability_read" } },
      { stage: "references", action: "Read only references/scripts named by the selected SKILL.md when required." },
    ];
  }
  if (candidate.kind === "plugin" || candidate.kind === "mcp-server") {
    return [
      { stage: "metadata", loaded: true, content: "bounded plugin/server metadata" },
      { stage: "selected-plugin", action: candidate.nextAction || { tool: "capability_inspect" } },
      { stage: "selected-schema", action: "Load only the exact MCP tool/resource/prompt schema needed for execution." },
    ];
  }
  if (candidate.kind === "mcp-tool" || candidate.kind === "tool") {
    return [
      { stage: "metadata", loaded: true, content: "tool name + description + routing metadata" },
      { stage: "execute", action: candidate.nextAction },
    ];
  }
  return [
    { stage: "metadata", loaded: true, content: `${candidate.kind} route metadata` },
    { stage: "execute", action: candidate.nextAction },
  ];
}

function choosePrimary(candidates, explicitQuery) {
  const eligible = candidates.filter((candidate) => candidate.available && (!candidate.explicitOnly || explicitQuery));
  eligible.sort((a, b) => b.score - a.score || a.routeId.localeCompare(b.routeId));
  return eligible[0] || null;
}

export function buildUnifiedRoutePlan({
  query,
  coreTools = [],
  capabilityRouting = null,
  workspaceSkillRouting = null,
  codexMcp = [],
  multiStep = false,
  autonomousContinuation = false,
  explicitQuery = false,
} = {}) {
  const candidates = [
    ...directToolCandidates(coreTools),
    ...workspaceSkillCandidates(workspaceSkillRouting),
    ...capabilityCandidates(capabilityRouting),
    ...codexMcpCandidates(codexMcp),
  ];
  const primary = choosePrimary(candidates, explicitQuery);
  const workflow = progressWorkflow({ multiStep, autonomousContinuation });
  const runtime = runtimeCandidateFromAction(primary?.nextAction, primary);
  const routeChain = [workflow, runtime, primary].filter(Boolean);
  const uniqueKinds = [...new Set(candidates.map((candidate) => candidate.kind).concat(routeChain.map((candidate) => candidate.kind)))];
  const canonical = JSON.stringify({
    version: ROUTING_HARNESS_VERSION,
    query: text(query, 4000),
    routeChain: routeChain.map((route) => ({ routeId: route.routeId, kind: route.kind, nextAction: route.nextAction })),
  });
  return {
    ok: true,
    version: ROUTING_HARNESS_VERSION,
    query: text(query, 4000),
    primary,
    workflow,
    runtime,
    routeChain,
    candidates,
    kinds: uniqueKinds,
    progressiveDisclosure: progressiveDisclosure(primary),
    nextAction: routeChain[0]?.nextAction || null,
    completionRule: primary
      ? "Follow every routeChain entry in order, execute the selected tool, and verify the observable result; discovery alone is not completion."
      : "No eligible route was found. Use the smallest direct tool consistent with current evidence and do not bulk-load unrelated skills or plugins.",
    fingerprint: createHash("sha256").update(canonical).digest("hex"),
  };
}
