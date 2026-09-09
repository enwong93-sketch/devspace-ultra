import assert from "node:assert/strict";
import { codexComputerUseRoute, registerCodexComputerUseRouter } from "./codex-computer-use-router.js";

assert.equal(codexComputerUseRoute("Click the visible Save button in the desktop app").useComputer, true);
assert.equal(codexComputerUseRoute("幫我撳桌面視窗入面個按鈕").recommendedTool, "codex_computer_use");
assert.equal(codexComputerUseRoute("Edit the source code and run unit tests").useComputer, false);

const calls = [];
const fakeBridge = {
  async probe(serverId, ownerConversationId) {
    assert.equal(serverId, "node_repl");
    assert.equal(ownerConversationId, "conversation-a");
    return {
      id: "node_repl",
      status: "online",
      tools: [{
        name: "js",
        inputSchema: {
          type: "object",
          properties: { code: { type: "string" }, timeout_ms: { type: "integer" } },
          required: ["code"],
        },
      }],
    };
  },
  async callTool(input, ownerConversationId) {
    assert.equal(ownerConversationId, "conversation-a");
    calls.push(input);
    const code = String(input.arguments.code || "");
    const payload = code.includes("runtime:")
      ? { ok: true, target: "windows", runtime: "@oai/sky", pluginId: "computer-use@openai-bundled" }
      : [{ id: "app-a", windows: [] }];
    return {
      ok: true,
      server: "node_repl",
      toolName: "js",
      result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false },
    };
  },
};

const registrations = [];
registerCodexComputerUseRouter({
  registerTool(name, definition, handler) { registrations.push({ name, definition, handler }); },
}, {
  codexMcpBridge: fakeBridge,
  capabilityRuntime: null,
  resolveConversation: async () => ({ conversationId: "conversation-a" }),
});

assert.deepEqual(registrations.map((entry) => entry.name), ["codex_computer_use_status", "codex_computer_use"]);
const status = await registrations[0].handler({});
assert.equal(status.structuredContent.payload.target, "windows");
assert.equal(status.structuredContent.nativeRuntimeEvidence.runtime, "@oai/sky");
assert.equal(status.structuredContent.executionPolicy.mode, "danger-full-access");

const observed = await registrations[1].handler({ action: "list_apps", input: {}, timeoutMs: 20_000 });
assert.equal(Array.isArray(observed.structuredContent.payload), true);
assert.equal(observed.structuredContent.readOnly, true);
assert.match(calls.at(-1).arguments.code, /sky\.list_apps/);
assert.equal(calls.at(-1).arguments.timeout_ms, 20_000);

console.log(JSON.stringify({
  ok: true,
  gate: "codex-computer-use-router",
  automaticVisualRouting: true,
  directOpenAiSkyDelegation: true,
  persistentNodeRepl: true,
  fullAccessOnly: true,
  noDevSpaceGuiDriver: true,
}));
