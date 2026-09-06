import assert from "node:assert/strict";
import { buildCoreEnvironment } from "./devspace-core-slot.mjs";

const contaminatedBase = {
  PATH: "fixture-path",
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
  DEVSPACE_PLUGIN_PATHS: "C:/wrong/plugins",
};

const common = {
  port: 7688,
  configDir: "C:/config",
  stateDir: "C:/state",
  publicBaseUrl: "https://devspace.example.test",
  baseEnv: contaminatedBase,
};

const active = buildCoreEnvironment({ ...common, candidate: false });
assert.equal(active.PATH, "fixture-path");
assert.equal(active.PORT, "7688");
assert.equal(active.DEVSPACE_CONFIG_DIR, "C:/config");
assert.equal(active.DEVSPACE_STATE_DIR, "C:/state");
assert.equal(active.DEVSPACE_PUBLIC_BASE_URL, "https://devspace.example.test");
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
]) {
  assert.equal(Object.hasOwn(active, key), false, `active Core must not inherit transient ${key}`);
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
]) {
  assert.equal(Object.hasOwn(candidate, key), false, `candidate must use persisted schema/tool config for ${key}`);
}

const explicit = buildCoreEnvironment({
  ...common,
  candidate: false,
  runtimeEnvOverrides: {
    DEVSPACE_TOOL_MODE: "ultra",
    DEVSPACE_PLUGINS: "true",
  },
});
assert.equal(explicit.DEVSPACE_TOOL_MODE, "ultra");
assert.equal(explicit.DEVSPACE_PLUGINS, "true");

console.log(JSON.stringify({
  ok: true,
  gate: "devspace-core-slot-env",
  activeConfigAuthoritative: true,
  candidatePassiveButSchemaCompatible: true,
  explicitCanaryOverridesSupported: true,
}));
