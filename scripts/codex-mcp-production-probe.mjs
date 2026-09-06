#!/usr/bin/env node
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexMcpBridge } from "../dist/codex-mcp-bridge.js";
import { loadConfig } from "../dist/config.js";

const DEFAULT_REQUIRED = Object.freeze([
  "code-review-graph",
  "node_repl",
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
  if (/allowlist|enabled_tools|disabled_tools/i.test(text)) return "filtered";
  return "probe-failed";
}

function publicProbe(probe) {
  return {
    status: probe?.status || "not-probed",
    toolCount: Array.isArray(probe?.tools) ? probe.tools.length : 0,
    promptCount: Array.isArray(probe?.prompts) ? probe.prompts.length : 0,
    resourceCount: Array.isArray(probe?.resources) ? probe.resources.length : 0,
    resourceTemplateCount: Array.isArray(probe?.resourceTemplates) ? probe.resourceTemplates.length : 0,
  };
}

function notRunnableState(entry) {
  if (entry?.enabled === false) return "disabled";
  if (/recursion/i.test(String(entry?.skipReason || ""))) return "self-recursion-skipped";
  if (/powermem/i.test(String(entry?.skipReason || ""))) return "shared-powermem-skipped";
  if (/inline bearer|credential/i.test(String(entry?.skipReason || ""))) return "inline-credential-rejected";
  return "not-runnable";
}

export async function probeLinkedCodexMcp({
  bridge,
  requiredNames = DEFAULT_REQUIRED,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!bridge) throw new Error("Linked Codex MCP bridge is required.");
  const required = new Set(requiredNames.map(String));
  const catalog = await timeout(
    bridge.catalog({ includeDisabled: true }),
    timeoutMs,
    "Codex MCP catalog",
  );
  const executionPolicy = String(catalog?.executionPolicy || bridge.diagnostics?.().executionPolicy || "");
  if (executionPolicy !== "full-access") {
    throw new Error(`Production linked Codex MCP must use full-access, observed ${executionPolicy || "unknown"}.`);
  }

  const rows = [];
  const observed = new Set();
  for (const entry of Array.isArray(catalog?.servers) ? catalog.servers : []) {
    const name = String(entry?.id || "");
    if (!name) continue;
    observed.add(name);
    const requiredForDevelopment = required.has(name);
    let probe = null;
    let probeFailure = null;
    if (entry.runnable === true) {
      try {
        probe = await timeout(bridge.probe(name), timeoutMs, name);
      } catch (error) {
        probeFailure = normalizeProbeError(error);
      }
    }
    const summary = publicProbe(probe);
    const catalogItems = summary.toolCount + summary.promptCount + summary.resourceCount + summary.resourceTemplateCount;
    let state;
    if (entry.runnable !== true) state = notRunnableState(entry);
    else if (probeFailure) state = probeFailure;
    else if (summary.status !== "online") state = summary.status === "not-probed" ? "probe-failed" : summary.status;
    else if (catalogItems === 0) state = "online-empty-catalog";
    else state = "online";

    rows.push({
      name,
      transport: entry?.transport || null,
      requiredForDevelopment,
      runnable: entry?.runnable === true,
      highRisk: entry?.highRisk === true,
      state,
      ...summary,
    });
  }

  for (const name of required) {
    if (observed.has(name)) continue;
    rows.push({
      name,
      transport: null,
      requiredForDevelopment: true,
      runnable: false,
      highRisk: false,
      state: "not-configured",
      ...publicProbe(null),
    });
  }

  rows.sort((left, right) => left.name.localeCompare(right.name));
  const requiredFailures = rows
    .filter((row) => row.requiredForDevelopment && row.state !== "online")
    .map((row) => ({ name: row.name, state: row.state }));
  return {
    ok: requiredFailures.length === 0,
    executionPolicy,
    source: "linked-codex-config",
    requiredNames: [...required],
    rows,
    summary: {
      total: rows.length,
      online: rows.filter((row) => row.state === "online").length,
      highRiskOnline: rows.filter((row) => row.state === "online" && row.highRisk).map((row) => row.name),
      optionalUnavailable: rows
        .filter((row) => !row.requiredForDevelopment && row.state !== "online")
        .map((row) => ({ name: row.name, state: row.state })),
      requiredFailures,
    },
    secretValuesLogged: false,
  };
}

async function main() {
  const configDir = resolve(argument("config-dir", join(homedir(), ".devspace-tailscale-bootstrap")));
  const requiredNames = names(argument("require"), DEFAULT_REQUIRED);
  const timeoutMs = Math.max(2_000, Math.min(120_000, Number(argument("timeout-ms", DEFAULT_TIMEOUT_MS))));
  const config = loadConfig({ ...process.env, DEVSPACE_CONFIG_DIR: configDir });
  const bridge = new CodexMcpBridge({
    codexHome: config.agentDir,
    executionPolicy: "full-access",
  });
  try {
    await bridge.ready;
    const result = await probeLinkedCodexMcp({ bridge, requiredNames, timeoutMs });
    console.log(JSON.stringify({
      ...result,
      gate: "codex-mcp-production-probe",
      configDir,
      codexConfigFile: basename(bridge.configPath),
    }, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    await bridge.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
