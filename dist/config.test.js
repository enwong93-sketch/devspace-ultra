import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";

const configDir = mkdtempSync(join(tmpdir(), "devspace-widget-config-"));
const baseEnv = {
  DEVSPACE_CONFIG_DIR: configDir,
  DEVSPACE_OAUTH_OWNER_TOKEN: "0123456789abcdef0123456789abcdef",
};

try {
  assert.equal(loadConfig(baseEnv).widgets, "off", "DevSpace should not attach per-tool widget cards by default");
  assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "changes" }).widgets, "changes");
  assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "full" }).widgets, "full");
  assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "compact" }).toolMode, "compact");
  console.log(JSON.stringify({ ok: true, defaultWidgets: "off", optInModes: ["changes", "full"], compactToolMode: true }));
} finally {
  rmSync(configDir, { recursive: true, force: true });
}
