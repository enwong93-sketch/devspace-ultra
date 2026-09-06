import assert from "node:assert/strict";
import { normalizeToolMode, toolModeCapabilities } from "./tool-mode.js";

assert.equal(normalizeToolMode(undefined), "minimal");
assert.equal(normalizeToolMode("minimal"), "minimal");
assert.equal(normalizeToolMode("full"), "full");
assert.equal(normalizeToolMode("codex"), "codex");
assert.equal(normalizeToolMode("ultra"), "ultra");
assert.throws(() => normalizeToolMode("unknown"), /Invalid DEVSPACE_TOOL_MODE/i);

assert.deepEqual(toolModeCapabilities("minimal"), {
  legacyWorkspaceTools: true,
  dedicatedSearchTools: false,
  codexPatchTool: false,
  codexProcessTools: false,
});
assert.deepEqual(toolModeCapabilities("full"), {
  legacyWorkspaceTools: true,
  dedicatedSearchTools: true,
  codexPatchTool: false,
  codexProcessTools: false,
});
assert.deepEqual(toolModeCapabilities("codex"), {
  legacyWorkspaceTools: false,
  dedicatedSearchTools: false,
  codexPatchTool: true,
  codexProcessTools: true,
});
assert.deepEqual(toolModeCapabilities("ultra"), {
  legacyWorkspaceTools: true,
  dedicatedSearchTools: true,
  codexPatchTool: true,
  codexProcessTools: true,
});

console.log(JSON.stringify({
  ok: true,
  gate: "tool-mode",
  ultraIsCompatibilitySuperset: true,
  codexAliases: ["apply_patch", "exec_command", "write_stdin"],
}));
