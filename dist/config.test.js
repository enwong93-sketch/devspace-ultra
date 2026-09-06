import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  assert.equal(loadConfig(baseEnv).classicStreamRecoveryEnabled, true, "Classic Stream Recovery should be safe-on by default");
  assert.equal(loadConfig(baseEnv).contextGuardianEnabled, true, "Context Guardian should be safe-on by default");
  assert.equal(loadConfig(baseEnv).classicHostOverlayEnabled, true, "Classic Host Overlay should be safe-on by default");
  assert.equal(loadConfig({ ...baseEnv, DEVSPACE_CLASSIC_STREAM_RECOVERY: "false" }).classicStreamRecoveryEnabled, false);
  assert.equal(loadConfig({ ...baseEnv, DEVSPACE_CONTEXT_GUARDIAN: "0" }).contextGuardianEnabled, false);
  assert.equal(loadConfig({ ...baseEnv, DEVSPACE_CLASSIC_HOST_OVERLAY: "false" }).classicHostOverlayEnabled, false);
  assert.equal(loadConfig(baseEnv).passiveCore, false, "normal production Cores must keep Classic background safety guards enabled by default");
  assert.equal(loadConfig({ ...baseEnv, DEVSPACE_PASSIVE_CORE: "true" }).passiveCore, true, "canary/candidate Cores must be able to disable Classic background automation explicitly");
  assert.deepEqual(loadConfig(baseEnv).oauth.scopes, ["devspace", "offline_access"], "default OAuth scopes should advertise refresh-token compatibility");
  assert.equal(loadConfig(baseEnv).toolMode, "minimal", "standalone compatibility default remains minimal");

  writeFileSync(join(configDir, "config.json"), `${JSON.stringify({
    toolMode: "ultra",
    pluginsEnabled: true,
    skillsEnabled: true,
    artifactsEnabled: true,
  })}\n`, "utf8");
  const persistedUltra = loadConfig(baseEnv);
  assert.equal(persistedUltra.toolMode, "ultra", "stable production config must be able to persist the Codex-compatible superset tool mode");
  assert.equal(persistedUltra.pluginsEnabled, true);
  assert.equal(persistedUltra.skillsEnabled, true, "skillsEnabled must be persistable instead of depending on inherited process environment");
  assert.equal(persistedUltra.artifactsEnabled, true);
  assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "codex" }).toolMode, "codex", "explicit environment override remains supported");

  writeFileSync(join(configDir, "config.json"), `\uFEFF${JSON.stringify({ classicHostOverlayEnabled: false })}\n`, "utf8");
  assert.equal(loadConfig(baseEnv).classicHostOverlayEnabled, false, "UTF-8 BOM config files should parse normally");

  console.log(JSON.stringify({ ok: true, defaultWidgets: "off", optInModes: ["changes", "full"], classicStreamRecoveryDefault: true, contextGuardianDefault: true, classicHostOverlayDefault: true, utf8BomConfig: true }));
} finally {
  rmSync(configDir, { recursive: true, force: true });
}
