import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCodexMcpBridgeManifest,
  discoverCodexMcpCatalog,
  publicCodexMcpCatalog,
} from "./codex-mcp-config.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function normalizeSelection(values) {
  if (!Array.isArray(values)) return new Set();
  return new Set(values.map((value) => String(value).trim()).filter(Boolean));
}

export async function importCodexMcpCatalog({
  runtime,
  codexConfigPath = join(homedir(), ".codex", "config.toml"),
  serverIds = [],
  excludeServerIds = [],
  apply = false,
  enableSafe = false,
  enableServerIds = [],
  allowPrivileged = false,
  nodePath = process.execPath,
  bridgeScriptPath = join(packageRoot, "scripts", "codex-mcp-stdio-bridge.mjs"),
} = {}) {
  if ((enableSafe || (Array.isArray(enableServerIds) && enableServerIds.length > 0)) && !apply) {
    throw new Error("Enabling imported Codex MCP servers requires apply=true.");
  }
  if (apply && !runtime) throw new Error("Capability runtime is required when apply=true.");
  const configPath = resolve(String(codexConfigPath));
  const text = await readFile(configPath, "utf8");
  const include = normalizeSelection(serverIds);
  const exclude = normalizeSelection(excludeServerIds);
  const explicitlyEnabled = normalizeSelection(enableServerIds);
  const allCatalog = discoverCodexMcpCatalog(text);
  const catalog = allCatalog.filter((server) => {
    if (include.size && !include.has(server.name)) return false;
    return !exclude.has(server.name);
  });
  const publicCatalog = publicCodexMcpCatalog(catalog);

  if (!apply) {
    return {
      ok: true,
      applied: false,
      codexConfigPath: configPath,
      catalog: publicCatalog,
      summary: {
        total: catalog.length,
        importableStdio: catalog.filter((server) => server.status === "importable-stdio").length,
        highRisk: catalog.filter((server) => server.highRisk).length,
        remoteReviewRequired: catalog.filter((server) => server.status === "remote-review-required").length,
        blocked: catalog.filter((server) => server.status.startsWith("blocked-")).length,
        skipped: catalog.filter((server) => server.status.startsWith("skipped-")).length,
      },
      secretValuesLogged: false,
    };
  }

  await runtime.ready;
  const results = [];
  const existing = new Set((await runtime.list({ includeDisabled: true, probeMcp: false })).map((plugin) => plugin.id));
  for (const server of catalog) {
    if (server.status !== "importable-stdio") {
      results.push({
        name: server.name,
        pluginId: server.pluginId,
        state: server.status,
        riskClass: server.riskClass,
        privileged: server.privileged,
        autoEnableEligible: server.autoEnableEligible,
      });
      continue;
    }
    const explicitTrust = explicitlyEnabled.has(server.name);
    const autoTrust = enableSafe && server.autoEnableEligible;
    if (explicitTrust && server.privileged && !allowPrivileged) {
      results.push({
        name: server.name,
        pluginId: server.pluginId,
        state: "privileged-approval-required",
        riskClass: server.riskClass,
        privileged: true,
        autoEnableEligible: server.autoEnableEligible,
      });
      continue;
    }
    const trusted = explicitTrust || autoTrust;
    if (existing.has(server.pluginId)) {
      if (trusted) {
        await runtime.setEnabled(server.pluginId, true, { trust: true });
        results.push({
          name: server.name,
          pluginId: server.pluginId,
          state: explicitTrust ? "existing-enabled-explicitly" : "existing-enabled-safe",
          riskClass: server.riskClass,
          privileged: server.privileged,
          autoEnableEligible: server.autoEnableEligible,
        });
      } else {
        results.push({
          name: server.name,
          pluginId: server.pluginId,
          state: "already-imported",
          riskClass: server.riskClass,
          privileged: server.privileged,
          autoEnableEligible: server.autoEnableEligible,
        });
      }
      continue;
    }
    const sourceDir = await mkdtemp(join(tmpdir(), "devspace-codex-mcp-import-"));
    try {
      const manifest = createCodexMcpBridgeManifest(server, {
        nodePath,
        bridgeScriptPath,
        configPath,
      });
      await writeFile(join(sourceDir, "devspace-plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      const installed = await runtime.install({
        source: sourceDir,
        id: server.pluginId,
        enable: trusted,
        trust: trusted,
      });
      existing.add(server.pluginId);
      results.push({
        name: server.name,
        pluginId: server.pluginId,
        state: trusted
          ? (explicitTrust ? "installed-enabled-explicitly" : "installed-enabled-safe")
          : "installed-disabled-untrusted",
        riskClass: server.riskClass,
        privileged: server.privileged,
        autoEnableEligible: server.autoEnableEligible,
        detectedFormats: installed?.plugin?.detectedFormats || [],
      });
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
    }
  }
  await runtime.refresh({ probeMcp: false });
  return {
    ok: true,
    applied: true,
    codexConfigPath: configPath,
    results,
    summary: {
      installed: results.filter((entry) => entry.state.startsWith("installed-")).length,
      enabledTrusted: results.filter((entry) => /enabled-(?:explicitly|safe)$/.test(entry.state)).length,
      disabledUntrusted: results.filter((entry) => entry.state === "installed-disabled-untrusted").length,
      alreadyImported: results.filter((entry) => entry.state === "already-imported").length,
      privilegedApprovalRequired: results.filter((entry) => entry.state === "privileged-approval-required").length,
    },
    secretValuesLogged: false,
  };
}
