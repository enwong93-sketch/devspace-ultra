import assert from "node:assert/strict";
import { callJsReplCompatibility, registerJsReplCompatibilityTool } from "./js-repl-compat.js";

function plugin({ enabled = true, trusted = true, toolName = "evaluate", codeField = "code", timeoutField = "timeout_ms" } = {}) {
  return {
    id: "codex-mcp-node_repl",
    enabled,
    trusted,
    mcpServers: [{
      id: "node_repl",
      status: "online",
      tools: [{
        name: toolName,
        inputSchema: {
          type: "object",
          properties: {
            [codeField]: { type: "string" },
            ...(timeoutField ? { [timeoutField]: { type: "integer" } } : {}),
          },
        },
      }],
    }],
  };
}

{
  const calls = [];
  const runtime = {
    async inspect(id, options) {
      calls.push({ kind: "inspect", id, options });
      return plugin();
    },
    async callMcp(pluginId, serverId, toolName, args) {
      calls.push({ kind: "call", pluginId, serverId, toolName, args });
      return { result: { content: [{ type: "text", text: "3" }] } };
    },
  };
  const result = await callJsReplCompatibility(runtime, { code: "1 + 2", timeoutMs: 4_000 });
  assert.equal(result.ok, true);
  assert.equal(result.serverId, "node_repl");
  assert.equal(result.toolName, "evaluate");
  assert.deepEqual(calls.at(-1).args, { code: "1 + 2", timeout_ms: 4_000 });
}

{
  const runtime = {
    async inspect() { return plugin({ toolName: "custom_eval", codeField: "expression", timeoutField: null }); },
    async callMcp(pluginId, serverId, toolName, args) {
      return { result: { pluginId, serverId, toolName, args } };
    },
  };
  const result = await callJsReplCompatibility(runtime, { code: "globalThis.counter = 1" });
  assert.equal(result.toolName, "custom_eval");
  assert.deepEqual(result.result.args, { expression: "globalThis.counter = 1" });
}

await assert.rejects(
  () => callJsReplCompatibility({ async inspect() { return plugin({ enabled: false }); } }, { code: "1" }),
  /disabled/i,
);
await assert.rejects(
  () => callJsReplCompatibility({ async inspect() { return plugin({ trusted: false }); } }, { code: "1" }),
  /not trusted/i,
);
await assert.rejects(
  () => callJsReplCompatibility({
    async inspect() {
      return {
        enabled: true,
        trusted: true,
        mcpServers: [{ id: "node_repl", tools: [{ name: "status", inputSchema: { properties: {} } }] }],
      };
    },
  }, { code: "1" }),
  /does not expose a compatible/i,
);

{
  const registrations = [];
  registerJsReplCompatibilityTool({
    registerTool(name, definition, handler) { registrations.push({ name, definition, handler }); },
  }, {
    async inspect() { return plugin({ toolName: "js_repl", codeField: "code", timeoutField: "timeoutMs" }); },
    async callMcp() { return { result: "persistent-ok" }; },
  });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, "js_repl");
  assert.equal(registrations[0].definition.annotations.openWorldHint, true);
  const response = await registrations[0].handler({ code: "let x = 1", timeoutMs: 2_000 });
  assert.equal(response.structuredContent.ok, true);
  assert.equal(response.content[0].text, "persistent-ok");
}

console.log(JSON.stringify({
  ok: true,
  gate: "js-repl-compat",
  schemaAdaptation: true,
  trustRequired: true,
  persistentProviderDelegation: true,
}));
