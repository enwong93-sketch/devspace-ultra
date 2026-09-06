import { readFile, realpath, stat } from "node:fs/promises";
import { isPathInsideRoot } from "./roots.js";
import * as z from "zod/v4";

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
  toolCatalog,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => new Date(),
} = {}) {
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
  }, async ({ questions }) => {
    try {
      const request = buildElicitationRequest(questions);
      try {
        const response = await server.server.elicitInput(request, { timeout: 10 * 60_000, maxTotalTimeout: 10 * 60_000 });
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
      const rawUsed = status?.hostMeasuredTokens;
      const window = rawWindow === null || rawWindow === undefined ? Number.NaN : Number(rawWindow);
      const used = rawUsed === null || rawUsed === undefined ? Number.NaN : Number(rawUsed);
      const available = Number.isFinite(window) && window > 0 && Number.isFinite(used) && used >= 0;
      const result = {
        ok: true,
        available,
        runtimeKey,
        conversationId: status?.conversationId ?? null,
        modelSlug: status?.currentModelSlug ?? null,
        contextWindowTokens: Number.isFinite(window) ? window : null,
        usedTokens: available ? used : null,
        remainingTokens: available ? Math.max(0, window - used) : null,
        usageObservedAt: available ? status?.hostUsageObservedAt ?? null : null,
        source: available ? "classic-native-host-measured" : "unavailable",
        reason: available ? null : "Fresh exact Classic-native usage evidence is unavailable; estimates are intentionally not substituted.",
      };
      return textResult(result);
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("tool_search", {
    title: "Search tools",
    description: "Search the complete DevSpace tool catalogue plus installed capability plugins without loading every schema into context. Use the returned exact core tool name directly, or capability_inspect/capability_call for a selected plugin tool.",
    inputSchema: {
      query: z.string().min(1).max(500),
      limit: z.number().int().min(1).max(100).default(20),
      includeCapabilities: z.boolean().default(true),
    },
    annotations: READ_ONLY,
  }, async ({ query, limit = 20, includeCapabilities = true }) => {
    try {
      const coreTools = toolCatalog.search(query, { limit });
      const remaining = Math.max(0, limit - coreTools.length);
      const capabilities = includeCapabilities && remaining > 0
        ? await capabilityRuntime.search(query, { includeDisabled: false, limit: remaining })
        : [];
      const linkedRemaining = Math.max(0, limit - coreTools.length - capabilities.length);
      const linkedCodexMcp = includeCapabilities && linkedRemaining > 0 && codexMcpBridge
        ? await codexMcpBridge.search(query, { limit: linkedRemaining })
        : [];
      return textResult({
        ok: true,
        query,
        coreTools,
        capabilities,
        linkedCodexMcp,
        resultCount: coreTools.length + capabilities.length + linkedCodexMcp.length,
      });
    } catch (error) {
      return errorResult(error);
    }
  });
}
