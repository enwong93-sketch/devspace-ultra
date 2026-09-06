#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { CapabilityRuntime } from "../dist/capability-runtime.js";
import { discoverCodexMcpCatalog } from "../dist/codex-mcp-config.js";
import { loadConfig } from "../dist/config.js";

const DEFAULT_REQUIRED = Object.freeze([
  "code-review-graph",
  "git_bash",
  "node_repl",
  "windows-mcp",
  "cua_repl",
]);
const DEFAULT_TIMEOUT_MS = 30_000;

function argument(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? String(process.argv[index + 1]) : fallback;
}
function names(value, fallback = []) {
  const parsed = String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean);
  return parsed.length ? parsed : [...fallback];
}
function timeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      timer.unref?.();
    }),
  ]);
}
function normalizeProbeError(error) {
  const text = error instanceof Error ? error.message : String(error || "unknown");
  if (/timed out/i.test(text)) return "timeout";
  if (/ENOENT|not found|cannot find/i.test(text)) return "executable-not-found";
  if (/ECONNREFUSED|connection refused/i.test(text)) return "connection-refused";
  if (/disabled/i.test(text)) return "disabled";
  if (/not trusted/i.test(text)) return "untrusted";
  if (/fingerprint|surface changed/i.test(text)) return "executable-drift";
  return "probe-failed";
}
function publicServer(server) {
  const probeErrors = server?.probeErrors && typeof server.probeErrors === "object"
    ? Object.keys(server.probeErrors).sort()
    : [];
  return {
    id: server?.id || null,
    type: server?.type || null,
    status: server?.status || "not-probed",
    toolCount: Array.isArray(server?.tools) ? server.tools.length : 0,
    promptCount: Array.isArray(server?.prompts) ? server.prompts.length : 0,
    resourceCount: Array.isArray(server?.resources) ? server.resources.length : 0,
    resourceTemplateCount: Array.isArray(server?.resourceTemplates) ? server.resourceTemplates.length : 0,
    probeErrorKinds: probeErrors,
  };
}

export async function probeImportedCodexMcp({
  runtime,
  codexConfigText,
  requiredNames = DEFAULT_REQUIRED,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!runtime) throw new Error("Capability runtime is required.");
  const catalog = discoverCodexMcpCatalog(codexConfigText);
  const required = new Set(requiredNames);
  const rows = [];

  for (const entry of catalog) {
    if (entry.status !== "importable-stdio") continue;
    const requiredForDevelopment = required.has(entry.name);
    let plugin;
    let probeFailure = null;
    try {
      plugin = await timeout(runtime.inspect(entry.pluginId, { probeMcp: true }), timeoutMs, entry.name);
    } catch (error) {
      probeFailure = normalizeProbeError(error);
    }
    const enabled = plugin?.enabled === true;
    const trusted = plugin?.trusted === true;
    const servers = Array.isArray(plugin?.mcpServers) ? plugin.mcpServers.map(publicServer) : [];
    const online = servers.length > 0 && servers.every((server) => server.status === "online" && server.toolCount > 0);
    let state = "online";
    if (entry.privileged && (!enabled || !trusted)) state = "privileged-quarantined";
    else if (!enabled) state = "disabled";
    else if (!trusted) state = "untrusted";
    else if (probeFailure) state = probeFailure;
    else if (!servers.length) state = "server-metadata-missing";
    else if (!online) state = "offline-or-empty-catalog";

    rows.push({
      name: entry.name,
      pluginId: entry.pluginId,
      riskClass: entry.riskClass,
      requiredForDevelopment,
      enabled,
      trusted,
      state,
      servers,
    });
  }

  rows.sort((left, right) => left.name.localeCompare(right.name));
  const requiredFailures = rows
    .filter((row) => row.requiredForDevelopment && row.state !== "online")
    .map((row) => ({ name: row.name, state: row.state }));
  const privilegedViolations = rows
    .filter((row) => row.riskClass === "high-impact" && /elevated|admin|root/i.test(row.name) && (row.enabled || row.trusted))
    .map((row) => row.name);
  return {
    ok: requiredFailures.length === 0 && privilegedViolations.length === 0,
    requiredNames: [...required],
    rows,
    summary: {
      total: rows.length,
      online: rows.filter((row) => row.state === "online").length,
      privilegedQuarantined: rows.filter((row) => row.state === "privileged-quarantined").length,
      optionalOffline: rows.filter((row) => !row.requiredForDevelopment && !["online", "privileged-quarantined"].includes(row.state)).map((row) => ({ name: row.name, state: row.state })),
      requiredFailures,
      privilegedViolations,
    },
    secretValuesLogged: false,
  };
}

async function main() {
  const configDir = resolve(argument("config-dir", join(homedir(), ".devspace-tailscale-bootstrap")));
  const codexConfigPath = resolve(argument("codex-config", join(homedir(), ".codex", "config.toml")));
  const requiredNames = names(argument("require"), DEFAULT_REQUIRED);
  const timeoutMs = Math.max(2_000, Math.min(120_000, Number(argument("timeout-ms", DEFAULT_TIMEOUT_MS))));
  const env = { ...process.env, DEVSPACE_CONFIG_DIR: configDir };
  const config = loadConfig(env);
  const runtime = new CapabilityRuntime({
    enabled: true,
    pluginsDir: config.pluginsDir,
    registryPath: config.capabilityRegistryPath,
    pluginPaths: config.pluginPaths,
  });
  try {
    await runtime.ready;
    const result = await probeImportedCodexMcp({
      runtime,
      codexConfigText: await readFile(codexConfigPath, "utf8"),
      requiredNames,
      timeoutMs,
    });
    console.log(JSON.stringify({
      ...result,
      gate: "codex-mcp-production-probe",
      configDir,
      codexConfigFile: basename(codexConfigPath),
    }, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    await runtime.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1)))) {
  await main();
} else if (process.argv[1] && basename(process.argv[1]) === basename(new URL(import.meta.url).pathname)) {
  await main();
}
