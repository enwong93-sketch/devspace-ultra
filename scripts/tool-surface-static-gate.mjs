import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [config, server, coreSlot] = await Promise.all([
  readFile(new URL("../dist/config.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/server.js", import.meta.url), "utf8"),
  readFile(new URL("./devspace-core-slot.mjs", import.meta.url), "utf8"),
]);

assert.match(config, /parseToolMode\(env, files\.config\.toolMode\)/);
assert.match(config, /files\.config\.skillsEnabled !== false/);
assert.match(server, /toolModeCapabilities\(config\.toolMode\)/);
assert.match(server, /toolSurface\.legacyWorkspaceTools/);
assert.match(server, /toolSurface\.dedicatedSearchTools/);
assert.match(server, /toolSurface\.codexPatchTool/);
assert.match(server, /toolSurface\.codexProcessTools/);
assert.match(server, /config\.toolMode === "ultra"/);
assert.match(server, /compatibility superset for cached ChatGPT tool schemas/);
assert.match(coreSlot, /CORE_RUNTIME_ENV_KEYS/);
assert.match(coreSlot, /delete environment\[key\]/);
assert.match(coreSlot, /DEVSPACE_PLUGINS/);
assert.match(coreSlot, /DEVSPACE_TOOL_MODE/);
assert.match(coreSlot, /runtimeEnvOverrides/);
assert.match(coreSlot, /DEVSPACE_PASSIVE_CORE: "true"/);

console.log(JSON.stringify({
  ok: true,
  gate: "tool-surface-static",
  persistedUltraMode: true,
  compatibilitySuperset: true,
  recoveryFlagsCannotLeakIntoActiveCore: true,
}));
