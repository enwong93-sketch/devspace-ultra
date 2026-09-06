import assert from "node:assert/strict";
import { buildCoreEnvironment } from "./devspace-core-slot.mjs";

const contaminated = {
  PATH: "C:\\Windows\\System32",
  DEVSPACE_PASSIVE_CORE: "true",
  DEVSPACE_PLUGINS: "false",
  DEVSPACE_SKILLS: "false",
  DEVSPACE_ARTIFACTS: "false",
  DEVSPACE_SUBAGENTS: "false",
  DEVSPACE_TOOL_MODE: "minimal",
  DEVSPACE_CONTEXT_GUARDIAN: "false",
  DEVSPACE_CLASSIC_HOST_OVERLAY: "false",
  DEVSPACE_CLASSIC_STREAM_RECOVERY: "false",
  DEVSPACE_AUTO_COMPACT: "false",
  DEVSPACE_PLUGIN_PATHS: "C:\\wrong\\plugins",
  DEVSPACE_CLASSIC_MAIN_DEBUG_PORTS: "19991,19992",
};

const common = {
  port: 7688,
  configDir: "C:\\Users\\test\\.devspace",
  stateDir: "C:\\Users\\test\\state",
  publicBaseUrl: "https://devspace.example.test",
  baseEnv: contaminated,
};

const active = buildCoreEnvironment({ ...common, candidate: false });
assert.equal(active.PATH, contaminated.PATH, "unrelated process environment must remain available");
assert.equal(active.PORT, "7688");
assert.equal(active.DEVSPACE_CONFIG_DIR, common.configDir);
assert.equal(active.DEVSPACE_STATE_DIR, common.stateDir);
assert.equal(active.DEVSPACE_PUBLIC_BASE_URL, common.publicBaseUrl);
for (const key of [
  "DEVSPACE_PASSIVE_CORE",
  "DEVSPACE_PLUGINS",
  "DEVSPACE_SKILLS",
  "DEVSPACE_ARTIFACTS",
  "DEVSPACE_SUBAGENTS",
  "DEVSPACE_TOOL_MODE",
  "DEVSPACE_CONTEXT_GUARDIAN",
  "DEVSPACE_CLASSIC_HOST_OVERLAY",
  "DEVSPACE_CLASSIC_STREAM_RECOVERY",
  "DEVSPACE_AUTO_COMPACT",
  "DEVSPACE_PLUGIN_PATHS",
  "DEVSPACE_CLASSIC_MAIN_DEBUG_PORTS",
]) {
  assert.equal(Object.hasOwn(active, key), false, `active Core must not inherit recovery override ${key}`);
}

const candidate = buildCoreEnvironment({ ...common, candidate: true });
assert.equal(candidate.DEVSPACE_PASSIVE_CORE, "true");
assert.equal(candidate.DEVSPACE_CONTEXT_GUARDIAN, "false");
assert.equal(candidate.DEVSPACE_CLASSIC_HOST_OVERLAY, "false");
assert.equal(candidate.DEVSPACE_CLASSIC_STREAM_RECOVERY, "false");
assert.equal(candidate.DEVSPACE_AUTO_COMPACT, "false");
for (const key of [
  "DEVSPACE_PLUGINS",
  "DEVSPACE_SKILLS",
  "DEVSPACE_ARTIFACTS",
  "DEVSPACE_SUBAGENTS",
  "DEVSPACE_TOOL_MODE",
  "DEVSPACE_PLUGIN_PATHS",
  "DEVSPACE_CLASSIC_MAIN_DEBUG_PORTS",
]) {
  assert.equal(Object.hasOwn(candidate, key), false, `candidate must retain config-owned tool surface instead of inheriting ${key}`);
}

const explicit = buildCoreEnvironment({
  ...common,
  candidate: false,
  runtimeEnvOverrides: {
    DEVSPACE_TOOL_MODE: "codex",
    DEVSPACE_PLUGINS: "false",
  },
});
assert.equal(explicit.DEVSPACE_TOOL_MODE, "codex", "isolated tests may pass explicit feature overrides");
assert.equal(explicit.DEVSPACE_PLUGINS, "false");

console.log(JSON.stringify({
  ok: true,
  gate: "devspace-core-slot-env",
  recoveryFlagsDoNotLeakIntoActiveCore: true,
  candidateAutomationDisabledWithoutToolLoss: true,
}));
