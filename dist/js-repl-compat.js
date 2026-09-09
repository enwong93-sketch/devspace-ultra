import * as z from "zod/v4";

const PLUGIN_ID = "codex-mcp-node_repl";
const TOOL_NAMES = [
  "js",
  "js_repl",
  "node_repl",
  "execute_javascript",
  "execute_javascript_tool",
  "evaluate_javascript",
  "evaluate",
  "execute",
  "eval",
  "run",
];
const CODE_FIELDS = ["code", "script", "javascript", "expression", "input", "source"];
const TIMEOUT_FIELDS = ["timeoutMs", "timeout_ms", "timeout"];

function textResult(payload) {
  const text = typeof payload?.result === "string"
    ? payload.result
    : JSON.stringify(payload, null, 2);
  return {
    content: [{ type: "text", text }],
    structuredContent: payload,
  };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { ok: false, error: message },
  };
}

function schemaProperties(tool) {
  const properties = tool?.inputSchema?.properties;
  return properties && typeof properties === "object" ? properties : {};
}

function selectTool(plugin) {
  const candidates = [];
  for (const server of plugin?.mcpServers || []) {
    for (const tool of server?.tools || []) {
      candidates.push({ server, tool });
    }
  }
  const selected = TOOL_NAMES
    .map((name) => candidates.find((candidate) => candidate.tool?.name === name))
    .find(Boolean)
    || candidates.find((candidate) => CODE_FIELDS.some((field) => Object.hasOwn(schemaProperties(candidate.tool), field)));
  if (!selected) {
    const available = candidates.map((candidate) => candidate.tool?.name).filter(Boolean).slice(0, 20);
    throw new Error(`The imported node_repl capability does not expose a compatible JavaScript evaluation tool${available.length ? `; available tools: ${available.join(", ")}` : "."}`);
  }
  const properties = schemaProperties(selected.tool);
  const codeField = CODE_FIELDS.find((field) => Object.hasOwn(properties, field));
  if (!codeField) throw new Error(`JavaScript REPL tool ${selected.tool.name} has no recognized code input field.`);
  const timeoutField = TIMEOUT_FIELDS.find((field) => Object.hasOwn(properties, field));
  return {
    serverId: selected.server.id,
    toolName: selected.tool.name,
    codeField,
    timeoutField,
  };
}

function dependenciesFrom(value) {
  if (value?.codexMcpBridge || value?.capabilityRuntime) {
    return {
      codexMcpBridge: value.codexMcpBridge || null,
      capabilityRuntime: value.capabilityRuntime || null,
      ownerConversationId: String(value.ownerConversationId || "").trim() || "__devspace_internal_js_repl__",
    };
  }
  return { codexMcpBridge: null, capabilityRuntime: value || null, ownerConversationId: "__devspace_internal_js_repl__" };
}

function callArguments(selected, code, timeoutMs) {
  const args = { [selected.codeField]: String(code ?? "") };
  if (selected.timeoutField) args[selected.timeoutField] = Number(timeoutMs);
  return args;
}

export async function callJsReplCompatibility(dependencies, { code, timeoutMs = 30_000 } = {}) {
  const { codexMcpBridge, capabilityRuntime, ownerConversationId } = dependenciesFrom(dependencies);
  if (!codexMcpBridge && !capabilityRuntime) throw new Error("A linked Codex MCP bridge or Capability runtime is required.");

  if (codexMcpBridge) {
    let selected = null;
    try {
      const linkedServer = await codexMcpBridge.probe("node_repl", ownerConversationId);
      if (linkedServer?.status !== "online") throw new Error("The linked Codex node_repl server is not online.");
      selected = selectTool({ mcpServers: [linkedServer] });
    } catch (error) {
      if (!capabilityRuntime) throw error;
    }
    if (selected) {
      const response = await codexMcpBridge.callTool({
        serverId: "node_repl",
        toolName: selected.toolName,
        arguments: callArguments(selected, code, timeoutMs),
      }, ownerConversationId);
      if (response?.approvalRequired) {
        throw new Error("The linked Codex node_repl unexpectedly requested local bridge approval.");
      }
      return {
        ok: true,
        source: "linked-codex-node-repl",
        serverId: "node_repl",
        toolName: selected.toolName,
        result: response?.result ?? response,
      };
    }
  }

  const plugin = await capabilityRuntime.inspect(PLUGIN_ID, { probeMcp: true });
  if (plugin?.enabled !== true) throw new Error("The imported node_repl capability is disabled.");
  if (plugin?.trusted !== true) throw new Error("The imported node_repl capability is not trusted.");
  const selected = selectTool(plugin);
  const response = await capabilityRuntime.callMcp(
    PLUGIN_ID,
    selected.serverId,
    selected.toolName,
    callArguments(selected, code, timeoutMs),
    undefined,
    ownerConversationId,
  );
  return {
    ok: true,
    source: "imported-capability-node-repl",
    pluginId: PLUGIN_ID,
    serverId: selected.serverId,
    toolName: selected.toolName,
    result: response?.result ?? response,
  };
}

export function registerJsReplCompatibilityTool(server, dependencies) {
  server.registerTool("js_repl", {
    title: "JavaScript REPL",
    description: "Execute JavaScript through the user's existing persistent Codex node_repl. The linked Codex runtime is used directly before any imported fallback, so bundled services such as @oai/sky Computer Use remain available without a second helper or copied implementation. Use exec_command for isolated shell commands; use js_repl for persistent JavaScript state and, after reading the official computer-use skill, Windows desktop automation.",
    inputSchema: {
      code: z.string().min(1).max(200_000),
      timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async (input, extra) => {
    try {
      const resolved = typeof dependencies?.resolveConversation === "function"
        ? await dependencies.resolveConversation(extra)
        : null;
      const ownerConversationId = String(resolved?.conversationId || "").trim();
      if (!ownerConversationId) throw new Error("JavaScript REPL requires the current ChatGPT conversation identity.");
      return textResult(await callJsReplCompatibility({ ...dependencies, ownerConversationId }, input));
    }
    catch (error) { return errorResult(error); }
  });
}
