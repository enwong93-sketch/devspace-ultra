#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CapabilityRuntime } from "../dist/capability-runtime.js";
import { loadConfig } from "../dist/config.js";
import { importCodexMcpCatalog } from "../dist/codex-mcp-import.js";

function argument(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? String(process.argv[index + 1]) : fallback;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}
function names(value) {
  return String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

const configDir = argument("config-dir");
const env = configDir ? { ...process.env, DEVSPACE_CONFIG_DIR: resolve(configDir) } : process.env;
const codexConfigPath = resolve(argument("codex-config", join(homedir(), ".codex", "config.toml")));
const apply = flag("apply");
const enableSafe = flag("enable-safe");
const enableServerIds = names(argument("enable"));
const allowPrivileged = flag("allow-privileged");
const serverIds = names(argument("include"));
const excludeServerIds = names(argument("exclude"));

let runtime = null;
try {
  if (apply) {
    const config = loadConfig(env);
    runtime = new CapabilityRuntime({
      enabled: true,
      pluginsDir: config.pluginsDir,
      registryPath: config.capabilityRegistryPath,
      pluginPaths: config.pluginPaths,
    });
  }
  const result = await importCodexMcpCatalog({
    runtime,
    codexConfigPath,
    serverIds,
    excludeServerIds,
    apply,
    enableSafe,
    enableServerIds,
    allowPrivileged,
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await runtime?.close();
}
