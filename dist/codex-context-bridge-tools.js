import * as z from "zod/v4";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const IMPORTING = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

function unavailable() {
  return {
    isError: true,
    content: [{ type: "text", text: "Codex ContextBridge is unavailable because local Codex thread state could not be opened." }],
    structuredContent: { ok: false, reason: "codex-state-unavailable" },
  };
}

function publicCapsule(result) {
  if (!result || typeof result !== "object") return result;
  const { path: _path, ...safe } = result;
  return safe;
}

function candidateText(result) {
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  if (candidates.length === 0) return `Codex ContextBridge could not resolve a thread (${result?.reason || "not-found"}).`;
  return [
    `Codex ContextBridge found ${candidates.length} possible threads; no context was imported because selection is ambiguous:`,
    ...candidates.slice(0, 20).map((thread) => `- ${thread.id} — ${thread.title} — ${thread.workspaceRoot || "unknown workspace"} — ${thread.updatedAt || "unknown time"}`),
  ].join("\n");
}

export function registerCodexContextBridgeTools(server, bridge) {
  server.registerTool("context_bridge_codex_list", {
    title: "List Codex Conversations",
    description: "List/select local Codex project conversations using Codex's read-only thread metadata index. Use this before import when the user names a project/title but not an exact thread id. Returns thread metadata only, never raw transcript/tool output/reasoning.",
    inputSchema: {
      query: z.string().max(500).optional(),
      projectPath: z.string().max(4096).optional(),
      includeArchived: z.boolean().default(false),
      limit: z.number().int().min(1).max(200).default(50),
    },
    annotations: READ_ONLY,
  }, async (input) => {
    if (!bridge) return unavailable();
    try {
      const threads = bridge.listThreads(input);
      const structuredContent = { ok: true, count: threads.length, threads };
      const text = threads.length
        ? [
            `Found ${threads.length} Codex conversation${threads.length === 1 ? "" : "s"}:`,
            ...threads.map((thread) => `- ${thread.id} — ${thread.title} — ${thread.workspaceRoot || "unknown workspace"} — ${thread.updatedAt || "unknown time"}${thread.archived ? " — archived" : ""}`),
          ].join("\n")
        : "No matching Codex conversations were found.";
      return { content: [{ type: "text", text }], structuredContent };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { isError: true, content: [{ type: "text", text: message }], structuredContent: { ok: false, reason: "list-failed", error: message } };
    }
  });

  server.registerTool("context_bridge_codex_import", {
    title: "Import Codex Conversation Context",
    description: "One-action ContextBridge import for the current ChatGPT conversation. Resolves one Codex thread, streams/indexes its history, keeps the latest Codex compaction anchor plus bounded user/assistant context, excludes developer/system/reasoning/raw tool output, redacts obvious credentials, optionally persists the sanitized capsule, and returns contextText directly in this MCP result so the current agent can continue from it immediately.",
    inputSchema: {
      threadId: z.string().min(1).max(200).optional(),
      query: z.string().min(1).max(500).optional(),
      projectPath: z.string().min(1).max(4096).optional(),
      includeArchived: z.boolean().default(true),
      latest: z.boolean().default(false),
      maxChars: z.number().int().min(500).max(120000).default(120000),
      maxMessages: z.number().int().min(1).max(80).default(80),
      maxMessageChars: z.number().int().min(200).max(12000).default(12000),
      persist: z.boolean().default(true),
    },
    annotations: IMPORTING,
  }, async (input) => {
    if (!bridge) return unavailable();
    if (!input.threadId && !input.query && !input.projectPath && !input.latest) {
      return {
        isError: true,
        content: [{ type: "text", text: "Specify threadId, query, projectPath, or explicitly request latest=true." }],
        structuredContent: { ok: false, reason: "selection-required" },
      };
    }
    try {
      const result = await bridge.importThread(input);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: candidateText(result) }],
          structuredContent: publicCapsule(result),
        };
      }
      const safe = publicCapsule(result);
      const prefix = `Imported Codex thread ${result.threadId} (${result.title}). Capsule ${result.capsuleId}; source=${result.sourceMode}; compaction=${Boolean(result.usedCodexCompaction)}; messages=${result.messagesIncluded}; redactions=${result.redactionsApplied}; truncated=${Boolean(result.truncated)}.`;
      return {
        content: [{ type: "text", text: `${prefix}\n\n${result.contextText}` }],
        structuredContent: safe,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { isError: true, content: [{ type: "text", text: message }], structuredContent: { ok: false, reason: "import-failed", error: message } };
    }
  });

  server.registerTool("context_bridge_codex_capsule", {
    title: "Read Imported Codex Context Capsule",
    description: "Read a previously imported sanitized Codex ContextBridge capsule from DevSpace local state. This does not rescan or resume the Codex thread and never returns the raw rollout path.",
    inputSchema: {
      capsuleId: z.string().min(1).max(300),
      threadId: z.string().min(1).max(200).optional(),
    },
    annotations: READ_ONLY,
  }, async (input) => {
    if (!bridge) return unavailable();
    try {
      const result = bridge.readCapsule(input);
      if (!result.ok) {
        return { content: [{ type: "text", text: "The requested sanitized Codex ContextBridge capsule was not found." }], structuredContent: result };
      }
      const safe = publicCapsule(result);
      return {
        content: [{ type: "text", text: `Reopened Codex ContextBridge capsule ${result.capsuleId}.\n\n${result.contextText}` }],
        structuredContent: safe,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { isError: true, content: [{ type: "text", text: message }], structuredContent: { ok: false, reason: "capsule-read-failed", error: message } };
    }
  });
}
