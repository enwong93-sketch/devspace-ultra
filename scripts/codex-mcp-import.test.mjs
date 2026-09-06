import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function run(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: resolve("."),
      env: process.env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", rejectPromise);
    child.once("exit", (code) => resolvePromise({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

const root = await mkdtemp(join(tmpdir(), "devspace-codex-import-test-"));
const configDir = join(root, "devspace-config");
const stateDir = join(root, "state");
const codexConfig = join(root, "codex.toml");
try {
  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(configDir, "config.json"), `${JSON.stringify({
    host: "127.0.0.1",
    port: 7676,
    publicBaseUrl: "https://devspace-import-test.invalid",
    stateDir,
    allowedRoots: [root],
    pluginsEnabled: true,
    pluginPaths: [],
  }, null, 2)}\n`);
  await writeFile(join(configDir, "auth.json"), `${JSON.stringify({ ownerToken: "0123456789abcdef0123456789abcdef" }, null, 2)}\n`);
  await writeFile(codexConfig, [
    "[mcp_servers.safe]",
    `command = ${JSON.stringify(process.execPath)}`,
    'args = ["fixture.mjs"]',
    'env = { API_KEY = "never-persist-this" }',
    "",
    '[mcp_servers."windows-mcp-elevated"]',
    `command = ${JSON.stringify(process.execPath)}`,
    'args = ["elevated.mjs"]',
    "",
    "[mcp_servers.devspace]",
    'command = "devspace"',
    'args = ["serve"]',
    "",
  ].join("\n"));

  const script = resolve("scripts/codex-mcp-import.mjs");
  const common = [script, "--config-dir", configDir, "--codex-config", codexConfig];
  const dry = await run(common);
  assert.equal(dry.code, 0, dry.stderr);
  const dryPayload = JSON.parse(dry.stdout);
  assert.equal(dryPayload.applied, false);
  assert.equal(dryPayload.summary.importableStdio, 2);
  assert.equal(dryPayload.catalog.find((entry) => entry.name === "devspace").status, "skipped-existing-native");
  assert.equal(dry.stdout.includes("never-persist-this"), false);

  const applied = await run([...common, "--apply", "--enable-safe"]);
  assert.equal(applied.code, 0, applied.stderr);
  const appliedPayload = JSON.parse(applied.stdout);
  assert.equal(appliedPayload.summary.installed, 2);
  assert.equal(appliedPayload.results.find((entry) => entry.name === "safe").state, "installed-enabled-trusted");
  assert.equal(appliedPayload.results.find((entry) => entry.name === "windows-mcp-elevated").state, "installed-disabled-untrusted");
  assert.equal(applied.stdout.includes("never-persist-this"), false);

  const registryPath = join(configDir, "plugins", "registry.json");
  const registryText = await readFile(registryPath, "utf8");
  const registry = JSON.parse(registryText);
  assert.equal(registry.plugins["codex-mcp-safe"].enabled, true);
  assert.equal(registry.plugins["codex-mcp-safe"].trusted, true);
  assert.equal(registry.plugins["codex-mcp-windows-mcp-elevated"].enabled, false);
  assert.equal(registry.plugins["codex-mcp-windows-mcp-elevated"].trusted, false);
  assert.equal(registryText.includes("never-persist-this"), false);
  const safeManifest = await readFile(join(registry.plugins["codex-mcp-safe"].dir, "devspace-plugin.json"), "utf8");
  assert.equal(safeManifest.includes("never-persist-this"), false);

  const repeated = await run([...common, "--apply", "--enable-safe"]);
  assert.equal(repeated.code, 0, repeated.stderr);
  const repeatedPayload = JSON.parse(repeated.stdout);
  assert.equal(repeatedPayload.summary.alreadyImported, 2);

  console.log(JSON.stringify({
    ok: true,
    gate: "codex-mcp-import",
    dryRun: true,
    idempotent: true,
    safeEntriesTrusted: true,
    elevatedEntriesQuarantined: true,
    secretValuesPersisted: false,
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
