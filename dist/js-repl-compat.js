import * as z from "zod/v4";

const PLUGIN_ID = "codex-mcp-node_repl";
const TOOL_NAMES = [
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

export async function callJsReplCompatibility(runtime, { code, timeoutMs = 30_000 } = {}) {
  if (!runtime) throw new Error("Capability runtime is required.");
  const plugin = await runtime.inspect(PLUGIN_ID, { probeMcp: true });
  if (plugin?.enabled !== true) throw new Error("The imported node_repl capability is disabled.");
  if (plugin?.trusted !== true) throw new Error("The imported node_repl capability is not trusted.");
  const selected = selectTool(plugin);
  const args = { [selected.codeField]: String(code ?? "") };
  if (selected.timeoutField) args[selected.timeoutField] = Number(timeoutMs);
  const response = await runtime.callMcp(PLUGIN_ID, selected.serverId, selected.toolName, args);
  return {
    ok: true,
    pluginId: PLUGIN_ID,
    serverId: selected.serverId,
    toolName: selected.toolName,
    result: response?.result ?? response,
  };
}

export function registerJsReplCompatibilityTool(server, runtime) {
  server.registerTool("js_repl", {
    title: "JavaScript REPL",
    description: "Execute JavaScript through the trusted persistent node_repl capability imported from the user's Codex MCP catalogue. This top-level compatibility entry resolves the plugin/server/tool schema automatically. Use exec_command for isolated shell commands; use js_repl when JavaScript state should persist across evaluations.",
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
  }, async (input) => {
    try { return textResult(await callJsReplCompatibility(runtime, input)); }
    catch (error) { return errorResult(error); }
  });
}
