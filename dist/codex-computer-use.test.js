import assert from "node:assert/strict";
import {
  callCodexComputerUse,
  codexComputerUseActionInfo,
  codexComputerUseStatus,
  validateComputerUseElicitation,
  CODEX_COMPUTER_USE_PLUGIN_ID,
  CODEX_COMPUTER_USE_RUNTIME,
} from "./codex-computer-use.js";

const calls = [];
const approvals = [];
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
  async callTool(input, _ownerConversationId, executionOptions = {}) {
    calls.push({ input, executionOptions });
    const code = String(input.arguments.code || "");
    let payload = { ok: true };
    if (code.includes("sky.list_apps()")) payload = [{ id: "app-a", windows: [{ app: "app-a", id: 1, title: "Window" }] }];
    if (code.includes("runtime:")) payload = { ok: true, target: "windows", runtime: "@oai/sky", pluginId: CODEX_COMPUTER_USE_PLUGIN_ID };
    if (code.includes("sky.get_window_state(")) {
      const response = await executionOptions.elicitationHandler({
        method: "elicitation/create",
        params: {
          message: "Allow Codex to use App A?",
          meta: {
            connector_id: "computer-use",
            connector_name: "Computer Use",
            riskLevel: "low",
            tool_params: { app: "app-a" },
          },
        },
      });
      approvals.push(response);
      payload = {
        window: { app: "app-a", id: 1, title: "Window" },
        screenshots: [],
        accessibility: { tree: "[1] document Window" },
      };
    }
    if (code.includes("sky.click(")) payload = { ok: true, action: "click", result: null };
    return {
      ok: true,
      server: "node_repl",
      toolName: "js",
      result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false },
    };
  },
};
const deps = {
  codexMcpBridge: fakeBridge,
  capabilityRuntime: null,
  elicitationHandler: async (request) => {
    assert.equal(request.params.meta.connector_id, "computer-use");
    return { action: "accept", content: { approval_scope: "current_tool_call" } };
  },
};

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
const listCall = calls.at(-1).input;
assert.match(listCall.arguments.code, /import\("@oai\/sky"\)/);
assert.match(listCall.arguments.code, /sky\.list_apps\(\)/);
assert.equal(listCall.arguments.timeout_ms, 30_000);

const state = await callCodexComputerUse(deps, {
  action: "get_window_state",
  input: { window: { app: "app-a", id: 1, title: "Window" }, includeScreenshot: true, includeText: true },
});
assert.equal(state.readOnly, true);
assert.match(calls.at(-1).input.arguments.code, /sky\.get_window_state/);
assert.match(calls.at(-1).input.arguments.code, /screenshots: \(__devspace_cua_state\.screenshots \|\| \[\]\)\.map/);
assert.doesNotMatch(calls.at(-1).input.arguments.code, /eval\(|Function\(/);
assert.deepEqual(approvals, [{ action: "accept", content: { approval_scope: "current_tool_call" } }]);
assert.equal(state.nativeRuntimeEvidence.approvalRelay.required, true);
assert.equal(state.nativeRuntimeEvidence.approvalRelay.requested, true);
assert.equal(state.nativeRuntimeEvidence.approvalRelay.action, "accept");
assert.equal(state.nativeRuntimeEvidence.approvalRelay.requestedApp, "app-a");

const clicked = await callCodexComputerUse(deps, {
  action: "click",
  input: { window: { app: "app-a", id: 1 }, element_index: 7 },
});
assert.equal(clicked.mutating, true);
assert.match(calls.at(-1).input.arguments.code, /sky\.click/);
assert.match(calls.at(-1).input.arguments.code, /"element_index":7/);
await assert.rejects(() => callCodexComputerUse(deps, { action: "click", input: { window: { app: "app-a", id: 1 } } }), /click requires/);
await assert.rejects(() => callCodexComputerUse(deps, { action: "type_text", input: { window: { app: "app-a", id: 1 }, text: "" } }), /must not be empty/);
await assert.rejects(() => callCodexComputerUse(deps, {
  action: "get_window_state",
  input: { window: { app: "OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0!ChatGPT", id: 2 } },
}), /prohibited app/i);
assert.throws(() => validateComputerUseElicitation({
  method: "elicitation/create",
  params: { meta: { connector_id: "other", tool_params: { app: "app-a" } } },
}, "app-a"), /not issued by the official Computer Use connector/);
assert.throws(() => validateComputerUseElicitation({
  method: "elicitation/create",
  params: { meta: { connector_id: "computer-use", tool_params: { app: "app-b" } } },
}, "app-a"), /app mismatch/);
assert.deepEqual(validateComputerUseElicitation({
  method: "elicitation/create",
  params: {
    message: "Allow Codex to use App A?",
    _meta: { connector_id: "computer-use", riskLevel: "low", tool_params: { app: "app-a" } },
  },
}, "app-a"), {
  connectorId: "computer-use",
  expectedApp: "app-a",
  requestedApp: "app-a",
  riskLevel: "low",
});
assert.deepEqual(validateComputerUseElicitation({
  message: "Allow Codex to use App A?",
  meta: { connector_id: "computer-use", riskLevel: "low", tool_params: { app: "app-a" } },
}, "app-a"), {
  connectorId: "computer-use",
  expectedApp: "app-a",
  requestedApp: "app-a",
  riskLevel: "low",
});

console.log(JSON.stringify({
  ok: true,
  gate: "codex-computer-use",
  officialRuntime: "@oai/sky",
  persistentNodeRepl: true,
  structuredActionsOnly: true,
  screenshotDataUrlNotSerialized: true,
  officialApprovalRelay: true,
  prohibitedAppBoundary: true,
  fullAccessOnly: true,
  noDevSpaceGuiDriver: true,
}));
