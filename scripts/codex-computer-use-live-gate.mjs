#!/usr/bin/env node
import assert from "node:assert/strict";
import { CodexMcpBridge } from "../dist/codex-mcp-bridge.js";
import { callCodexComputerUse, codexComputerUseStatus } from "../dist/codex-computer-use.js";

const execute = process.argv.includes("--execute");
const bridge = new CodexMcpBridge({ executionPolicy: "full-access" });
try {
  await bridge.ready;
  const nodeRepl = await bridge.probe("node_repl");
  assert.equal(nodeRepl.status, "online", `Linked Codex node_repl is unavailable: ${nodeRepl.error || "unknown"}`);
  assert.equal((nodeRepl.tools || []).some((tool) => tool.name === "js"), true, "Linked node_repl does not expose js.");
  const dependencies = { codexMcpBridge: bridge, capabilityRuntime: null };
  const status = await codexComputerUseStatus(dependencies);
  assert.equal(status.ok, true);
  assert.equal(status.payload?.target, "windows");
  assert.equal(status.payload?.runtime, "@oai/sky");
  assert.equal(status.payload?.pluginId, "computer-use@openai-bundled");
  assert.equal(status.nativeRuntimeEvidence.nodeRepl, true);
  assert.equal(status.nativeRuntimeEvidence.devspaceGuiDriver, false);
  assert.equal(status.executionPolicy.mode, "danger-full-access");
  assert.equal(status.executionPolicy.approvalPolicy, "never");
  assert.equal(status.executionPolicy.sandboxEnabled, false);
  assert.deepEqual(status.executionPolicy.alternativeModes, []);

  let observation = null;
  if (execute) {
    observation = await callCodexComputerUse(dependencies, { action: "list_apps", timeoutMs: 30_000 });
    assert.equal(observation.ok, true);
    assert.equal(observation.readOnly, true);
    assert.equal(Array.isArray(observation.payload), true);
    assert.ok(observation.payload.length > 0, "sky.list_apps() returned no apps.");
    const windowCount = observation.payload.reduce((count, app) => count + (Array.isArray(app?.windows) ? app.windows.length : 0), 0);
    assert.ok(windowCount > 0, "sky.list_apps() returned no open windows.");
    observation = {
      appCount: observation.payload.length,
      windowCount,
      hasWindow: windowCount > 0,
    };
  }

  console.log(JSON.stringify({
    ok: true,
    gate: "codex-computer-use-live",
    implementation: "openai-bundled-computer-use",
    runtime: "@oai/sky",
    linkedNodeRepl: true,
    readOnlyExecution: Boolean(execute),
    observation,
    fullAccessOnly: true,
    devspaceFallbackDriverUsed: false,
    secretValuesLogged: false,
  }));
} finally {
  await bridge.close().catch(() => {});
}
