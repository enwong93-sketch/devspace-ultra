import assert from "node:assert/strict";
import { codexComputerUseRoute, registerCodexComputerUseRouter } from "./codex-computer-use-router.js";

assert.equal(codexComputerUseRoute("Click the visible Save button in the desktop app").useComputer, true);
assert.equal(codexComputerUseRoute("幫我撳桌面視窗入面個按鈕").recommendedTool, "codex_computer_use");
assert.equal(codexComputerUseRoute("Use Chrome browser UI to open a page and click the visible form button").recommendedTool, "codex_computer_use");
assert.equal(codexComputerUseRoute("Edit the source code and run unit tests").useComputer, false);

const calls = [];
const elicitationRequests = [];
const overlayBegins = [];
const overlayEnds = [];
const overlayReleases = [];
let nextRiskLevel = "low";
let failNextCall = false;
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
  async callTool(input, ownerConversationId, executionOptions = {}) {
    assert.equal(ownerConversationId, "conversation-a");
    calls.push(input);
    if (failNextCall) {
      failNextCall = false;
      throw new Error("simulated Computer Use transport failure");
    }
    const code = String(input.arguments.code || "");
    let payload = code.includes("runtime:")
      ? { ok: true, target: "windows", runtime: "@oai/sky", pluginId: "computer-use@openai-bundled" }
      : [{ id: "app-a", windows: [{ app: "app-a", id: 1, title: "Window" }] }];
    if (code.includes("sky.get_window_state(") || code.includes("sky.press_key(")) {
      const riskLevel = nextRiskLevel;
      nextRiskLevel = "low";
      const response = await executionOptions.elicitationHandler({
        method: "elicitation/create",
        params: {
          message: "Allow Codex to use App A?",
          _meta: { connector_id: "computer-use", riskLevel, tool_params: { app: "app-a" } },
        },
      });
      assert.equal(response.action, "accept");
      payload = { window: { app: "app-a", id: 1, title: "Window" }, screenshots: [], accessibility: { tree: "Window" } };
    }
    return {
      ok: true,
      server: "node_repl",
      toolName: "js",
      result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false },
    };
  },
};

const registrations = [];
const computerUseOverlay = {
  async begin(input) {
    overlayBegins.push(structuredClone(input));
    return {
      ok: true,
      operationId: "overlay-operation-a",
      conversationId: input.conversationId,
      app: input.app,
      action: input.action,
    };
  },
  async end(input) {
    overlayEnds.push(structuredClone(input));
    return { ok: true, state: "idle-clear-scheduled" };
  },
  async release(input) {
    overlayReleases.push(structuredClone(input));
    return { ok: true, state: "released", explicitRelease: true, cleared: true };
  },
};
registerCodexComputerUseRouter({
  registerTool(name, definition, handler) { registrations.push({ name, definition, handler }); },
}, {
  codexMcpBridge: fakeBridge,
  capabilityRuntime: null,
  resolveConversation: async () => ({ conversationId: "conversation-a", runtimeKey: "main-01" }),
  computerUseOverlay,
});

assert.deepEqual(registrations.map((entry) => entry.name), ["codex_computer_use_status", "codex_computer_use"]);
assert.match(registrations[1].definition.description, /ordinary Chrome and Edge browser-window automation/i);
assert.match(registrations[1].definition.description, /legacy custom Chrome-extension path has been removed/i);
const status = await registrations[0].handler({});
assert.equal(status.structuredContent.payload.target, "windows");
assert.equal(status.structuredContent.nativeRuntimeEvidence.runtime, "@oai/sky");
assert.equal(status.structuredContent.executionPolicy.mode, "danger-full-access");
assert.equal(overlayBegins.length, 0, "read-only runtime status must not show the desktop takeover state");

const observed = await registrations[1].handler({ action: "list_apps", input: {}, timeoutMs: 20_000 });
assert.equal(Array.isArray(observed.structuredContent.payload), true);
assert.equal(observed.structuredContent.readOnly, true);
assert.match(calls.at(-1).arguments.code, /sky\.list_apps/);
assert.equal(calls.at(-1).arguments.timeout_ms, 20_000);
assert.equal(overlayBegins.at(-1).conversationId, "conversation-a");
assert.equal(overlayBegins.at(-1).runtimeKey, "main-01");
assert.equal(overlayBegins.at(-1).action, "list_apps");
assert.equal(overlayBegins.at(-1).app, "Windows desktop");
assert.equal(overlayEnds.at(-1).operationId, "overlay-operation-a");
assert.equal(observed.structuredContent.nativeRuntimeEvidence.computerUseOverlay.operationId, "overlay-operation-a");

const state = await registrations[1].handler({
  action: "get_window_state",
  input: { window: { app: "app-a", id: 1, title: "Window" }, include_text: true, include_screenshot: true },
  timeoutMs: 20_000,
}, {
  async sendRequest(request) {
    elicitationRequests.push(request);
    assert.equal(request.params._meta.connector_id, "computer-use");
    return { action: "accept", content: { approval_scope: "current_tool_call" } };
  },
});
assert.equal(state.structuredContent.nativeRuntimeEvidence.approvalRelay.action, "accept");
assert.equal(elicitationRequests.length, 1);
assert.equal(elicitationRequests[0].method, "elicitation/create");
assert.equal(elicitationRequests[0].params._meta.connector_id, "computer-use");

const unsupportedExtra = {
  async sendRequest() {
    throw new Error("MCP error -32600: Elicitation not supported");
  },
};
const fallbackObservation = await registrations[1].handler({
  action: "get_window_state",
  input: { window: { app: "app-a", id: 1, title: "Window" }, include_text: true },
  timeoutMs: 20_000,
}, unsupportedExtra);
assert.equal(fallbackObservation.structuredContent.nativeRuntimeEvidence.approvalRelay.action, "accept");
assert.equal(fallbackObservation.structuredContent.nativeRuntimeEvidence.approvalRelay.fallback,
  "host-elicitation-unsupported-exact-conversation-observe-action");

const fallbackAction = await registrations[1].handler({
  action: "press_key",
  input: { window: { app: "app-a", id: 1, title: "Window" }, key: "F6" },
  timeoutMs: 20_000,
}, unsupportedExtra);
assert.equal(fallbackAction.structuredContent.nativeRuntimeEvidence.approvalRelay.action, "accept");
assert.equal(fallbackAction.structuredContent.nativeRuntimeEvidence.approvalRelay.fallback,
  "host-elicitation-unsupported-exact-conversation-observe-action");

const finalObservation = await registrations[1].handler({
  action: "get_window_state",
  input: {
    window: { app: "app-a", id: 1, title: "Window" },
    include_text: true,
    release_control: true,
  },
  timeoutMs: 20_000,
}, unsupportedExtra);
assert.equal(finalObservation.structuredContent.nativeRuntimeEvidence.computerUseOverlay.releaseRequested, true);
assert.equal(finalObservation.structuredContent.nativeRuntimeEvidence.computerUseOverlay.released, true);
assert.equal(finalObservation.structuredContent.nativeRuntimeEvidence.computerUseOverlay.approvalGrantReleased, true);
assert.equal(finalObservation.structuredContent.nativeRuntimeEvidence.computerUseOverlay.cleanup.state, "released");
assert.equal(overlayReleases.at(-1).conversationId, "conversation-a");
assert.equal(overlayReleases.at(-1).operationId, "overlay-operation-a");

const releaseOnMutationRejected = await registrations[1].handler({
  action: "press_key",
  input: {
    window: { app: "app-a", id: 1, title: "Window" },
    key: "F6",
    release_control: true,
  },
  timeoutMs: 20_000,
}, unsupportedExtra);
assert.equal(releaseOnMutationRejected.isError, true);
assert.match(releaseOnMutationRejected.content[0].text, /final read-only observation/i);

failNextCall = true;
const failedObservation = await registrations[1].handler({
  action: "list_windows",
  input: {},
  timeoutMs: 20_000,
}, unsupportedExtra);
assert.equal(failedObservation.isError, true);
assert.match(failedObservation.content[0].text, /simulated Computer Use transport failure/);
assert.equal(overlayReleases.at(-1).state, "failed", "failed Computer Use calls must immediately release the takeover state");

const rejectedSecondAction = await registrations[1].handler({
  action: "press_key",
  input: { window: { app: "app-a", id: 1, title: "Window" }, key: "F6" },
  timeoutMs: 20_000,
}, unsupportedExtra);
assert.equal(rejectedSecondAction.isError, true,
  "a second mutation must re-observe instead of reusing one fallback grant twice");
assert.match(rejectedSecondAction.content[0].text, /Elicitation not supported/);

nextRiskLevel = "high";
const highRiskRejected = await registrations[1].handler({
  action: "get_window_state",
  input: { window: { app: "app-a", id: 1, title: "Window" }, include_text: true, diagnostic_marker: "high-risk-fixture" },
  timeoutMs: 20_000,
}, unsupportedExtra);
assert.equal(highRiskRejected.isError, true,
  "high-risk app approval must not be inferred without explicit current-user authorization");

nextRiskLevel = "high";
const highRiskObserved = await registrations[1].handler({
  action: "get_window_state",
  input: {
    window: { app: "app-a", id: 1, title: "Window" },
    include_text: true,
    user_authorized_app_control: true,
    diagnostic_marker: "high-risk-fixture",
  },
  timeoutMs: 20_000,
}, unsupportedExtra);
assert.notEqual(highRiskObserved.isError, true, JSON.stringify(highRiskObserved));
assert.equal(highRiskObserved.structuredContent.nativeRuntimeEvidence.approvalRelay.action, "accept");
assert.equal(highRiskObserved.structuredContent.nativeRuntimeEvidence.approvalRelay.riskLevel, "high");

nextRiskLevel = "high";
const highRiskAction = await registrations[1].handler({
  action: "press_key",
  input: { window: { app: "app-a", id: 1, title: "Window" }, key: "F6", diagnostic_marker: "high-risk-fixture" },
  timeoutMs: 20_000,
}, unsupportedExtra);
assert.equal(highRiskAction.structuredContent.nativeRuntimeEvidence.approvalRelay.action, "accept");

console.log(JSON.stringify({
  ok: true,
  gate: "codex-computer-use-router",
  automaticVisualRouting: true,
  ordinaryBrowserRouting: true,
  directOpenAiSkyDelegation: true,
  approvalRelay: true,
  hostUnsupportedObserveActionFallback: true,
  oneMutationPerObservation: true,
  highRiskRequiresExplicitCurrentUserAuthorization: true,
  conversationScopedTakeoverOverlay: true,
  explicitFinalRelease: true,
  mutationCannotSkipFinalReobserve: true,
  persistentNodeRepl: true,
  fullAccessOnly: true,
  noDevSpaceGuiDriver: true,
}));
