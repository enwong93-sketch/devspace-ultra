import { open as openFile, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as YAML from "yaml";
import { isPathInsideRoot } from "./roots.js";
import * as z from "zod/v4";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { codexComputerUseRoute } from "./codex-computer-use-router.js";
import {
  ROUTING_CONTRACT_VERSION,
  capabilityRoutingFingerprint,
  normalizeRoutingPolicy,
  rankCapabilityRoutes,
} from "./capability-routing.js";
import { buildUnifiedRoutePlan, ROUTING_HARNESS_VERSION } from "./routing-harness.js";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_SLEEP_SECONDS = 300;
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WAITING = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

function textResult(structuredContent, text = JSON.stringify(structuredContent, null, 2)) {
  return { content: [{ type: "text", text }], structuredContent };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { ok: false, error: message },
  };
}

function routeStringArray(value, max = 64) {
  const source = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(source.map((item) => String(item ?? "").trim()).filter(Boolean))].slice(0, max);
}

async function readTextPrefix(path, maxBytes = 64 * 1024) {
  const file = await openFile(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await file.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close().catch(() => {});
  }
}

function workspaceSkillFrontmatter(text) {
  if (!String(text || "").startsWith("---")) return {};
  const end = String(text).indexOf("\n---", 3);
  if (end < 0) return {};
  try {
    const parsed = YAML.parse(String(text).slice(3, end));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function workspaceSkillMetadata(skill) {
  const skillPath = String(skill?.filePath || "").trim();
  let frontmatter = {};
  try { frontmatter = workspaceSkillFrontmatter(await readTextPrefix(skillPath)); } catch {}
  let metadata = {};
  let routingMetadataPath = null;
  for (const candidate of [
    join(dirname(skillPath), "agents", "openai.yaml"),
    join(dirname(skillPath), "agents", "openai.yml"),
    join(dirname(skillPath), "agents", "openai.json"),
  ]) {
    try {
      const text = await readTextPrefix(candidate);
      const parsed = candidate.toLowerCase().endsWith(".json") ? JSON.parse(text) : YAML.parse(text);
      if (parsed && typeof parsed === "object") {
        metadata = parsed;
        routingMetadataPath = candidate;
        break;
      }
    } catch {}
  }
  const interfaceMetadata = metadata.interface && typeof metadata.interface === "object" ? metadata.interface : {};
  const frontRouting = frontmatter.routing && typeof frontmatter.routing === "object" ? frontmatter.routing : {};
  const metadataRouting = metadata.routing && typeof metadata.routing === "object" ? metadata.routing : {};
  const frontPolicy = frontmatter.policy && typeof frontmatter.policy === "object" ? frontmatter.policy : {};
  const metadataPolicy = metadata.policy && typeof metadata.policy === "object" ? metadata.policy : {};
  const routing = normalizeRoutingPolicy({
    ...frontRouting,
    ...frontPolicy,
    ...metadataRouting,
    ...metadataPolicy,
    allowImplicitInvocation: skill?.disableModelInvocation === true
      ? false
      : metadataPolicy.allow_implicit_invocation
        ?? metadataPolicy.allowImplicitInvocation
        ?? frontPolicy.allow_implicit_invocation
        ?? frontPolicy.allowImplicitInvocation,
    aliases: [
      ...routeStringArray(frontmatter.aliases),
      ...routeStringArray(frontmatter.routingAliases),
      ...routeStringArray(frontmatter.routing_aliases),
      ...routeStringArray(frontRouting.aliases),
      ...routeStringArray(metadataRouting.aliases),
    ],
    negativeTriggers: [
      ...routeStringArray(frontmatter.negativeTriggers),
      ...routeStringArray(frontmatter.negative_triggers),
      ...routeStringArray(frontRouting.negativeTriggers),
      ...routeStringArray(frontRouting.exclude),
      ...routeStringArray(metadataRouting.negativeTriggers),
      ...routeStringArray(metadataRouting.exclude),
    ],
  });
  const dependencies = (Array.isArray(metadata?.dependencies?.tools) ? metadata.dependencies.tools : [])
    .slice(0, 32)
    .map((item) => typeof item === "string"
      ? item
      : [item?.type, item?.value, item?.description].map((value) => String(value || "").trim()).filter(Boolean).join(" "))
    .filter(Boolean);
  return {
    displayName: String(interfaceMetadata.display_name || interfaceMetadata.displayName || frontmatter.display_name || frontmatter.displayName || "").slice(0, 240),
    shortDescription: String(interfaceMetadata.short_description || interfaceMetadata.shortDescription || frontmatter.short_description || frontmatter.shortDescription || "").slice(0, 800),
    defaultPrompts: routeStringArray(
      interfaceMetadata.default_prompts
      ?? interfaceMetadata.defaultPrompts
      ?? interfaceMetadata.default_prompt
      ?? interfaceMetadata.defaultPrompt
      ?? frontmatter.default_prompt
      ?? frontmatter.defaultPrompt,
      20,
    ),
    dependencies,
    routing,
    routingMetadataPath,
  };
}

async function workspaceSkillRouteCandidates(workspaces, workspaceId) {
  const id = String(workspaceId || "").trim();
  if (!id) return [];
  const workspace = workspaces?.getWorkspace?.(id);
  if (!workspace) throw new Error(`Unknown workspaceId: ${id}. Call open_workspace first.`);
  const skills = Array.isArray(workspace.skills) ? workspace.skills.slice(0, 256) : [];
  return await Promise.all(skills.map(async (skill) => {
    const metadata = await workspaceSkillMetadata(skill);
    return {
      routeId: `workspace-skill:${id}:${skill.name}`,
      kind: "skill",
      name: String(skill.name || "skill"),
      title: metadata.displayName || String(skill.name || "skill"),
      description: String(skill.description || "Reusable workspace skill"),
      shortDescription: metadata.shortDescription,
      aliases: metadata.routing.aliases,
      negativeTriggers: metadata.routing.negativeTriggers,
      defaultPrompts: metadata.defaultPrompts,
      dependencies: metadata.dependencies,
      allowImplicitInvocation: metadata.routing.allowImplicitInvocation,
      exposure: metadata.routing.exposure,
      priority: metadata.routing.priority + 12,
      path: String(skill.filePath || ""),
      available: true,
      requires: ["read-full-skill-before-substantive-work", ...(metadata.dependencies.length ? ["resolve-declared-tool-dependencies"] : [])],
      nextAction: {
        tool: "read",
        arguments: { workspaceId: id, path: String(skill.filePath || "") },
        then: "Follow the selected workspace Skill and resolve only its declared dependencies.",
      },
      routingMetadataPath: metadata.routingMetadataPath,
    };
  }));
}

function imagePrefix(bytes, start, text) {
  return bytes.subarray(start, start + text.length).toString("ascii") === text;
}

export function detectImageMime(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) return null;
  const data = Buffer.from(bytes);
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 6 && (imagePrefix(data, 0, "GIF87a") || imagePrefix(data, 0, "GIF89a"))) return "image/gif";
  if (data.length >= 12 && imagePrefix(data, 0, "RIFF") && imagePrefix(data, 8, "WEBP")) return "image/webp";
  return null;
}

export async function loadWorkspaceImage({ workspaces, workspaceId, path, maxBytes = MAX_IMAGE_BYTES } = {}) {
  if (!workspaces || typeof workspaces.getWorkspace !== "function" || typeof workspaces.resolvePath !== "function") {
    throw new Error("Workspace registry is required for view_image.");
  }
  const workspace = workspaces.getWorkspace(workspaceId);
  const lexicalPath = workspaces.resolvePath(workspace, path);
  const [rootPath, resolvedPath] = await Promise.all([realpath(workspace.root), realpath(lexicalPath)]);
  if (!isPathInsideRoot(resolvedPath, rootPath)) throw new Error(`Image path escapes the workspace root: ${path}`);
  const info = await stat(resolvedPath);
  if (!info.isFile()) throw new Error(`Image path is not a file: ${path}`);
  const limit = Math.max(1, Math.min(MAX_IMAGE_BYTES, Number(maxBytes) || MAX_IMAGE_BYTES));
  if (info.size > limit) throw new Error(`Image exceeds the ${limit}-byte view_image limit.`);
  const data = await readFile(resolvedPath);
  const mimeType = detectImageMime(data);
  if (!mimeType) throw new Error("Unsupported or invalid image. Supported formats: PNG, JPEG, GIF, and WebP.");
  return {
    workspace,
    resolvedPath,
    mimeType,
    bytes: data.length,
    data,
  };
}

function cleanQuestionId(value) {
  const id = String(value ?? "").trim();
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(id)) throw new Error(`Question id must be snake_case: ${id || "<empty>"}`);
  return id;
}

export function buildElicitationRequest(questions) {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 3) {
    throw new Error("request_user_input requires one to three questions.");
  }
  const properties = {};
  const required = [];
  const seen = new Set();
  for (const question of questions) {
    const id = cleanQuestionId(question?.id);
    if (seen.has(id)) throw new Error(`Duplicate question id: ${id}`);
    seen.add(id);
    const header = String(question?.header ?? "").trim().slice(0, 40);
    const prompt = String(question?.question ?? "").trim().slice(0, 1000);
    const options = Array.isArray(question?.options) ? question.options : [];
    if (!header || !prompt) throw new Error(`Question ${id} requires header and question text.`);
    if (options.length < 1 || options.length > 8) throw new Error(`Question ${id} requires one to eight options.`);
    const values = [];
    const optionDescriptions = [];
    for (const option of options) {
      const label = String(option?.label ?? "").trim().slice(0, 120);
      if (!label) throw new Error(`Question ${id} contains an empty option label.`);
      if (values.includes(label)) throw new Error(`Question ${id} contains duplicate option label: ${label}`);
      values.push(label);
      const description = String(option?.description ?? "").trim().slice(0, 500);
      if (description) optionDescriptions.push(`${label}: ${description}`);
    }
    values.push("Other");
    properties[id] = {
      type: "string",
      title: header,
      description: [prompt, ...optionDescriptions].join("\n"),
      enum: values,
    };
    properties[`${id}_other`] = {
      type: "string",
      title: `${header} — Other`,
      description: "Optional free-text answer when Other is selected.",
      maxLength: 2000,
    };
    required.push(id);
  }
  return {
    mode: "form",
    message: questions.length === 1
      ? String(questions[0].question).trim().slice(0, 1000)
      : "Please answer the following questions so the task can continue.",
    requestedSchema: {
      type: "object",
      properties,
      required,
    },
  };
}

export function normalizeElicitationAnswers(questions, result) {
  const action = result?.action === "accept" || result?.action === "decline" || result?.action === "cancel"
    ? result.action
    : "cancel";
  const content = result?.content && typeof result.content === "object" ? result.content : {};
  const answers = {};
  for (const question of questions || []) {
    const id = cleanQuestionId(question?.id);
    const selected = typeof content[id] === "string" ? content[id] : null;
    const otherText = typeof content[`${id}_other`] === "string" && content[`${id}_other`].trim()
      ? content[`${id}_other`].trim()
      : null;
    answers[id] = {
      selected,
      ...(selected === "Other" || otherText ? { otherText } : {}),
    };
  }
  return { action, answers };
}

export function currentTimeSnapshot({ timeZone, now = new Date() } = {}) {
  const zone = String(timeZone ?? "").trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    });
  } catch {
    throw new Error(`Invalid IANA time zone: ${zone}`);
  }
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  return {
    ok: true,
    timeZone: zone,
    utcIso: now.toISOString(),
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localTime: `${parts.hour}:${parts.minute}:${parts.second}`,
    offset: parts.timeZoneName || null,
    epochMilliseconds: now.getTime(),
  };
}

export function registerCodexParityTools(server, {
  workspaces,
  capabilityRuntime,
  codexMcpBridge,
  contextGuardian,
  exactUsageAuthority,
  toolCatalog,
  modelInstructionsFingerprint = null,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => new Date(),
} = {}) {
  const routingFingerprint = typeof capabilityRuntime?.routingFingerprint === "function"
    ? capabilityRuntime.routingFingerprint({ includeDisabled: true })
    : capabilityRoutingFingerprint([]);
  const routingMeta = {
    _meta: {
      devspace: {
        routingContractVersion: ROUTING_CONTRACT_VERSION,
        routingFingerprint,
        ...(modelInstructionsFingerprint ? { modelInstructionsFingerprint: String(modelInstructionsFingerprint) } : {}),
      },
    },
  };
  const registerParityTool = server.registerTool.bind(server);
  server.registerTool = (name, definition, handler) => {
    if (name !== "tool_search") return registerParityTool(name, definition, handler);
    const enhancedDefinition = {
      ...definition,
      description: `${definition.description || "Search the DevSpace route catalog."} This is the single model-facing routing entry point across direct tools, workspace skills, plugin skills, plugins, MCP servers, MCP tools, workflows, and application runtimes. Follow routingHarness.routeChain in order; discovery or inspection alone is never completion.`,
      inputSchema: {
        ...(definition.inputSchema || {}),
        stage: z.enum(["start", "continue", "verify", "recover"]).optional(),
        multiStep: z.boolean().optional(),
        autonomousContinuation: z.boolean().optional(),
      },
      _meta: {
        ...(definition._meta || {}),
        devspace: {
          ...(definition._meta?.devspace || {}),
          routingHarnessVersion: String(ROUTING_HARNESS_VERSION),
          routeKinds: ["tool", "skill", "plugin", "mcp-server", "mcp-tool", "workflow", "runtime"],
        },
      },
    };
    return registerParityTool(name, enhancedDefinition, async (input, extra) => {
      const result = await handler(input, extra);
      if (result?.isError || !result?.structuredContent) return result;
      const query = String(input?.query || "").trim();
      const inferredMultiStep = input?.multiStep === true || /continue|complete|implement|build|repair|finish|multi[- ]?step|workflow|runtime|agent|繼續|完成|實作|修復|多步|工作流|建模/i.test(query);
      const inferredAutonomous = input?.autonomousContinuation === true || /autonomous|across turns|goal mode|自動接續|跨回合|目標模式/i.test(query);
      const routingHarness = buildUnifiedRoutePlan({
        query,
        coreTools: result.structuredContent.coreTools,
        capabilityRouting: result.structuredContent.capabilityRouting,
        workspaceSkillRouting: result.structuredContent.workspaceSkillRouting,
        codexMcp: result.structuredContent.codexMcp || result.structuredContent.codexMcpServers,
        multiStep: inferredMultiStep,
        autonomousContinuation: inferredAutonomous,
        explicitQuery: input?.explicit === true,
      });
      result.structuredContent.routingHarness = routingHarness;
      result.structuredContent.routeChain = routingHarness.routeChain;
      result.structuredContent.routingHarnessFingerprint = routingHarness.fingerprint;
      return result;
    });
  };

  server.registerTool("view_image", {
    title: "View image",
    description: "Load a PNG, JPEG, GIF, or WebP file from an open workspace into model context. Paths are workspace-confined and validated by file signature. Use detail=original only when full source resolution is genuinely needed.",
    inputSchema: {
      workspaceId: z.string().min(1),
      path: z.string().min(1).max(4096),
      detail: z.enum(["high", "original"]).optional(),
    },
    annotations: READ_ONLY,
  }, async ({ workspaceId, path, detail }) => {
    try {
      const image = await loadWorkspaceImage({ workspaces, workspaceId, path });
      const visiblePath = String(path).replace(/\\/g, "/");
      return {
        content: [
          { type: "text", text: `Loaded ${visiblePath} (${image.mimeType}, ${image.bytes} bytes).` },
          { type: "image", data: image.data.toString("base64"), mimeType: image.mimeType },
        ],
        structuredContent: {
          ok: true,
          workspaceId,
          path: visiblePath,
          mimeType: image.mimeType,
          bytes: image.bytes,
          detail: detail || "high",
        },
      };
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("request_user_input", {
    title: "Request user input",
    description: "Request one to three short structured questions and wait for the user's response through MCP form elicitation. Every question needs explicit options; an Other free-text field is added automatically. If the connected host lacks elicitation support, the result says so and the assistant should ask in normal chat instead.",
    inputSchema: {
      questions: z.array(z.object({
        id: z.string().min(1).max(64),
        header: z.string().min(1).max(40),
        question: z.string().min(1).max(1000),
        options: z.array(z.object({
          label: z.string().min(1).max(120),
          description: z.string().max(500).optional(),
        })).min(1).max(8),
      })).min(1).max(3),
    },
    annotations: WAITING,
  }, async ({ questions }, extra) => {
    try {
      const request = buildElicitationRequest(questions);
      try {
        const response = typeof extra?.sendRequest === "function"
          ? await extra.sendRequest({
              method: "elicitation/create",
              params: request.mode === "form" ? request : { ...request, mode: "form" },
            }, ElicitResultSchema)
          : await server.server.elicitInput(request);
        const normalized = normalizeElicitationAnswers(questions, response);
        return textResult({ ok: true, supported: true, ...normalized });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/does not support.*elicitation|elicitation.*not supported|client does not support/i.test(message)) {
          return textResult({
            ok: false,
            supported: false,
            fallback: "Ask the same question in the assistant's normal visible response.",
            error: message,
          }, "The connected host does not support MCP form elicitation. Ask the user in normal chat instead.");
        }
        throw error;
      }
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("current_time", {
    title: "Current time",
    description: "Return the current clock time in UTC and an optional IANA time zone. Use this instead of guessing the local date or offset.",
    inputSchema: {
      timeZone: z.string().min(1).max(120).optional(),
    },
    annotations: READ_ONLY,
  }, async ({ timeZone }) => {
    try {
      const snapshot = currentTimeSnapshot({ timeZone, now: now() });
      return textResult(snapshot, `${snapshot.localDate} ${snapshot.localTime} ${snapshot.offset || ""} (${snapshot.timeZone}); UTC ${snapshot.utcIso}`.trim());
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("sleep", {
    title: "Sleep",
    description: "Wait for a bounded duration without polling. Use only when an external process or service genuinely needs time to settle; prefer write_stdin or event-driven tools for running commands.",
    inputSchema: {
      seconds: z.number().min(0).max(MAX_SLEEP_SECONDS),
      reason: z.string().max(500).optional(),
    },
    annotations: WAITING,
  }, async ({ seconds, reason }) => {
    try {
      const milliseconds = Math.round(Number(seconds) * 1000);
      await sleep(milliseconds);
      return textResult({ ok: true, seconds: milliseconds / 1000, reason: reason || null }, `Waited ${milliseconds / 1000} seconds${reason ? `: ${reason}` : "."}`);
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("get_context_remaining", {
    title: "Get context remaining",
    description: "Return exact remaining ChatGPT Classic context only when Context Guardian has a fresh native host-measured usage value and a resolved model window. Never substitutes DOM, estimator, or ledger values when exact native evidence is unavailable.",
    inputSchema: {
      mainNumber: z.number().int().min(1).max(32).default(1),
    },
    annotations: READ_ONLY,
  }, async ({ mainNumber = 1 }) => {
    try {
      const runtimeKey = `main-${String(mainNumber).padStart(2, "0")}`;
      const status = await contextGuardian.status(runtimeKey);
      const rawWindow = status?.contextWindowTokens;
      const window = rawWindow === null || rawWindow === undefined ? Number.NaN : Number(rawWindow);
      const conversationId = status?.conversationId ?? null;
      const exact = exactUsageAuthority && conversationId
        ? await exactUsageAuthority.status({ conversationId })
        : {
            available: false,
            reason: conversationId ? "exact-usage-authority-unavailable" : "conversation-id-unresolved",
            source: "unavailable",
          };
      const used = exact?.available ? Number(exact.exactUsedTokens) : Number.NaN;
      const available = Number.isFinite(window) && window > 0 && Number.isFinite(used) && used >= 0;
      const result = {
        ok: true,
        available,
        runtimeKey,
        conversationId,
        modelSlug: status?.currentModelSlug ?? null,
        contextWindowTokens: Number.isFinite(window) ? window : null,
        usedTokens: available ? used : null,
        remainingTokens: available ? Math.max(0, window - used) : null,
        usageObservedAt: exact?.available ? exact.observedAt ?? null : null,
        usageKind: exact?.available ? exact.usageKind ?? null : null,
        evidencePath: exact?.available ? exact.evidencePath ?? null : null,
        source: available ? "classic-native-protocol" : "unavailable",
        reason: available ? null : exact?.reason || "Fresh exact Classic-native usage evidence is unavailable; estimates are intentionally not substituted.",
        estimatorFallbackUsed: false,
        ledgerFallbackUsed: false,
        domFallbackUsed: false,
      };
      return textResult(result);
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("tool_search", {
    title: "Route and Search Tools",
    description: "Use this before guessing a tool or falling back to generic shell/browser work. It searches direct DevSpace tools, workspace/user Agent Skills, deferred installed skills/plugins/MCP tools, and linked Codex MCPs, then returns one exact recommendedRoute when the evidence is clear. Pass workspaceId after open_workspace so project, user, and trusted plugin Skills compete in the same bounded router. Routing uses names, aliases, descriptions, default prompts, dependencies, negative gates, trust/availability, and explicit-only policy; read the selected SKILL.md or inspect only the selected deferred plugin before acting.",
    inputSchema: {
      query: z.string().min(1).max(2_000),
      workspaceId: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).default(20),
      includeCapabilities: z.boolean().default(true),
    },
    annotations: READ_ONLY,
    ...routingMeta,
  }, async ({ query, workspaceId, limit = 20, includeCapabilities = true }) => {
    try {
      const coreTools = toolCatalog.search(query, { limit });
      const remaining = Math.max(0, limit - coreTools.length);
      const capabilities = includeCapabilities && remaining > 0
        ? await capabilityRuntime.search(query, { includeDisabled: false, limit: remaining })
        : [];
      const capabilityRouting = includeCapabilities && typeof capabilityRuntime?.route === "function"
        ? await capabilityRuntime.route(query, { includeDisabled: false, probeMcp: false, limit: Math.min(12, limit) })
        : null;
      const workspaceSkillCandidates = workspaceId
        ? await workspaceSkillRouteCandidates(workspaces, workspaceId)
        : [];
      const installedRouteCandidates = includeCapabilities
        ? typeof capabilityRuntime?.routingCandidates === "function"
          ? capabilityRuntime.routingCandidates({ includeDisabled: false })
          : [capabilityRouting?.primary, ...(capabilityRouting?.candidates || [])].filter(Boolean)
        : [];
      const deferredCandidateMap = new Map();
      for (const candidate of [...workspaceSkillCandidates, ...installedRouteCandidates]) {
        const routeId = String(candidate?.routeId || "").trim();
        if (routeId && !deferredCandidateMap.has(routeId)) deferredCandidateMap.set(routeId, candidate);
      }
      const deferredCandidates = [...deferredCandidateMap.values()];
      const deferredRouting = rankCapabilityRoutes(query, deferredCandidates, { limit: Math.min(50, limit) });
      const workspaceSkillRouting = rankCapabilityRoutes(query, workspaceSkillCandidates, { limit: Math.min(50, limit) });
      const dynamicRoutingFingerprint = deferredCandidates.length
        ? capabilityRoutingFingerprint(deferredCandidates)
        : capabilityRouting?.routingFingerprint || routingFingerprint;
      const linkedRemaining = Math.max(0, limit - coreTools.length - capabilities.length);
      const linkedCodexMcp = includeCapabilities && linkedRemaining > 0 && codexMcpBridge
        ? await codexMcpBridge.search(query, { limit: linkedRemaining })
        : [];
      const normalizedQuery = String(query || "").toLowerCase().replace(/[^a-z0-9_:-]+/g, " ").trim();
      const exactCore = coreTools.find((tool) => {
        const name = String(tool?.name || "").toLowerCase();
        const title = String(tool?.title || "").toLowerCase();
        return normalizedQuery === name || normalizedQuery === title || normalizedQuery.includes(`tool ${name}`);
      }) || null;
      const selectedDeferred = deferredRouting.primary;
      const computerRoute = codexComputerUseRoute(query);
      const recommendedRoute = exactCore
        ? {
            source: "core-tool",
            routeId: `core-tool:${exactCore.name}`,
            kind: "core-tool",
            name: exactCore.name,
            score: exactCore.score,
            nextAction: { tool: exactCore.name, arguments: {} },
          }
        : selectedDeferred
          ? {
              source: selectedDeferred.routeId.startsWith("workspace-skill:") ? "workspace-skill-routing" : "capability-routing",
              routeId: selectedDeferred.routeId,
              kind: selectedDeferred.kind,
              name: selectedDeferred.name,
              pluginId: selectedDeferred.pluginId,
              score: selectedDeferred.score,
              ambiguous: deferredRouting.ambiguous,
              nextAction: selectedDeferred.nextAction,
            }
          : computerRoute.useComputer
            ? { source: "computer-use-fallback", tool: "codex_computer_use", reason: computerRoute.reason, score: computerRoute.score }
            : linkedCodexMcp[0]
              ? {
                  source: "linked-codex-mcp",
                  routeId: `linked-codex-mcp:${linkedCodexMcp[0].id}`,
                  kind: "linked-codex-mcp",
                  name: linkedCodexMcp[0].id,
                  nextAction: { tool: "codex_mcp_inspect", arguments: { serverId: linkedCodexMcp[0].id } },
                }
              : coreTools[0]
                ? {
                    source: "core-tool-search",
                    routeId: `core-tool:${coreTools[0].name}`,
                    kind: "core-tool",
                    name: coreTools[0].name,
                    score: coreTools[0].score,
                    nextAction: { tool: coreTools[0].name, arguments: {} },
                  }
                : null;
      return textResult({
        ok: true,
        routingContractVersion: ROUTING_CONTRACT_VERSION,
        routingFingerprint: dynamicRoutingFingerprint,
        query,
        workspaceId: workspaceId || null,
        coreTools,
        capabilities,
        capabilityRouting,
        workspaceSkillRouting,
        deferredRouting,
        linkedCodexMcp,
        recommendedRoute,
        resultCount: coreTools.length + capabilities.length + linkedCodexMcp.length + deferredRouting.candidateCount,
      });
    } catch (error) {
      return errorResult(error);
    }
  });
}
