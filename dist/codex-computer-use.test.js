import assert from "node:assert/strict";
import {
  callCodexComputerUse,
  codexComputerUseActionInfo,
  codexComputerUseStatus,
  CODEX_COMPUTER_USE_PLUGIN_ID,
  CODEX_COMPUTER_USE_RUNTIME,
} from "./codex-computer-use.js";

const calls = [];
const fakeBridge = {
  async probe(serverId) {
    assert.equal(serverId, "node_repl");
    return {
      id: "node_repl",
      status: "online",
      tools: [{
        name: "js",
        inputSchema: {
          type: "object",
          properties: {
            code: { type: "string" },
            timeout_ms: { type: "integer" },
          },
          required: ["code"],
        },
      }],
    };
  },
  async callTool(input) {
    calls.push(input);
    const code = String(input.arguments.code || "");
    let payload = { ok: true };
    if (code.includes("sky.list_apps()")) payload = [{ id: "app-a", windows: [{ app: "app-a", id: 1, title: "Window" }] }];
    if (code.includes("runtime:")) payload = { ok: true, target: "windows", runtime: "@oai/sky", pluginId: CODEX_COMPUTER_USE_PLUGIN_ID };
    if (code.includes("sky.click(")) payload = { ok: true, action: "click", result: null };
    return {
      ok: true,
      server: "node_repl",
      toolName: "js",
      result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false },
    };
  },
};
const deps = { codexMcpBridge: fakeBridge, capabilityRuntime: null };

assert.deepEqual(codexComputerUseActionInfo("list_apps"), {
  action: "list_apps",
  readOnly: true,
  mutating: false,
  implementation: "openai-bundled-computer-use",
  runtime: CODEX_COMPUTER_USE_RUNTIME,
});
assert.equal(codexComputerUseActionInfo("click").mutating, true);
assert.throws(() => codexComputerUseActionInfo("shell"), /Unsupported/);

const status = await codexComputerUseStatus(deps);
assert.equal(status.ok, true);
assert.equal(status.payload.target, "windows");
assert.equal(status.nativeRuntimeEvidence.nodeRepl, true);
assert.equal(status.nativeRuntimeEvidence.runtime, "@oai/sky");
assert.equal(status.nativeRuntimeEvidence.devspaceGuiDriver, false);
assert.equal(status.executionPolicy.mode, "danger-full-access");
assert.equal(status.executionPolicy.approvalPolicy, "never");
assert.equal(status.executionPolicy.sandboxEnabled, false);
assert.deepEqual(status.executionPolicy.alternativeModes, []);

const apps = await callCodexComputerUse(deps, { action: "list_apps" });
assert.equal(apps.readOnly, true);
assert.equal(Array.isArray(apps.payload), true);
assert.equal(apps.payload[0].windows[0].id, 1);
const listCall = calls.at(-1);
assert.match(listCall.arguments.code, /import\("@oai\/sky"\)/);
assert.match(listCall.arguments.code, /sky\.list_apps\(\)/);
assert.equal(listCall.arguments.timeout_ms, 30_000);

const state = await callCodexComputerUse(deps, {
  action: "get_window_state",
  input: { window: { app: "app-a", id: 1, title: "Window" }, includeScreenshot: true, includeText: true },
});
assert.equal(state.readOnly, true);
assert.match(calls.at(-1).arguments.code, /sky\.get_window_state/);
assert.match(calls.at(-1).arguments.code, /screenshots: \(__devspace_cua_state\.screenshots \|\| \[\]\)\.map/);
assert.doesNotMatch(calls.at(-1).arguments.code, /eval\(|Function\(/);

const clicked = await callCodexComputerUse(deps, {
  action: "click",
  input: { window: { app: "app-a", id: 1 }, element_index: 7 },
});
assert.equal(clicked.mutating, true);
assert.match(calls.at(-1).arguments.code, /sky\.click/);
assert.match(calls.at(-1).arguments.code, /"element_index":7/);
await assert.rejects(() => callCodexComputerUse(deps, { action: "click", input: { window: { app: "app-a", id: 1 } } }), /click requires/);
await assert.rejects(() => callCodexComputerUse(deps, { action: "type_text", input: { window: { app: "app-a", id: 1 }, text: "" } }), /must not be empty/);

console.log(JSON.stringify({
  ok: true,
  gate: "codex-computer-use",
  officialRuntime: "@oai/sky",
  persistentNodeRepl: true,
  structuredActionsOnly: true,
  screenshotDataUrlNotSerialized: true,
  fullAccessOnly: true,
  noDevSpaceGuiDriver: true,
}));
