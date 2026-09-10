#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createConnection, createServer as createNetServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDevspaceFiles } from "../dist/user-config.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function flag(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] != null ? process.argv[index + 1] : fallback;
}

function integerFlag(name, fallback = null) {
  const value = Number(flag(name, fallback));
  return Number.isInteger(value) && value > 0 ? value : null;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function portOnline(port, host = "127.0.0.1") {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function reservePort() {
  const server = createNetServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const port = Number(server.address().port);
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const body = await response.json().catch(() => null);
  return { response, body };
}

async function waitForCanary(port, child, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Canary Core exited before readiness with code ${child.exitCode}.`);
    try {
      const { response, body } = await fetchJson(`http://127.0.0.1:${port}/healthz`);
      if (response.ok && body?.ok === true) return body;
    } catch {}
    await sleep(250);
  }
  throw new Error(`Canary Core did not become ready on 127.0.0.1:${port}.`);
}

async function stopChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill("SIGTERM");
  for (let index = 0; index < 80 && child.exitCode == null; index += 1) await sleep(100);
  if (child.exitCode == null) child.kill("SIGKILL");
}

const preservePid = integerFlag("preserve-pid");
const preservePort = integerFlag("preserve-port");
const productionGatewayPort = integerFlag("production-gateway-port", 7678);
const maxWaitMs = integerFlag("wait-ms", 90_000);
const productionBefore = await fetchJson(`http://127.0.0.1:${productionGatewayPort}/healthz`).catch(() => null);
if (!productionBefore?.response?.ok || productionBefore.body?.ok !== true) {
  throw new Error(`Production Gateway ${productionGatewayPort} is not healthy before canary.`);
}
if (preservePid && !processAlive(preservePid)) throw new Error(`Preserved process ${preservePid} is not alive before canary.`);
if (preservePort && !await portOnline(preservePort)) throw new Error(`Preserved port ${preservePort} is not online before canary.`);

const files = loadDevspaceFiles();
const config = structuredClone(files.config || {});
const tempRoot = await mkdtemp(join(tmpdir(), "devspace-core-canary-"));
const configDir = join(tempRoot, "config");
const stateDir = join(tempRoot, "state");
const logDir = join(tempRoot, "logs");
await mkdir(configDir, { recursive: true });
await mkdir(stateDir, { recursive: true });
await mkdir(logDir, { recursive: true });
const port = await reservePort();

Object.assign(config, {
  host: "127.0.0.1",
  port,
  publicBaseUrl: `http://127.0.0.1:${port}`,
  edgeBackendPort: port,
  edgePublicBaseUrl: `http://127.0.0.1:${port}`,
  stableGatewayPort: port,
  stableGatewayPublicBaseUrl: `http://127.0.0.1:${port}`,
  stateDir,
  edgeFixedStateDir: stateDir,
  stableGatewayStateDir: stateDir,
  passiveCore: true,
  autoCompactEnabled: false,
  goalRoundRecoveryEnabled: false,
  classicHostOverlayEnabled: false,
  contextGuardianEnabled: false,
});
config.allowedHosts = ["127.0.0.1", "localhost", "::1"];
config.logging = {
  ...(config.logging || {}),
  enabled: true,
  path: join(logDir, "canary.jsonl"),
};
await writeFile(join(configDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

const stdout = [];
const stderr = [];
let child = null;
try {
  child = spawn(process.execPath, [
    join(root, "dist", "cli.js"),
    "serve",
    "--host", "127.0.0.1",
    "--port", String(port),
    "--config-dir", configDir,
  ], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      DEVSPACE_CONFIG_DIR: configDir,
      DEVSPACE_STATE_DIR: stateDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));

  const health = await waitForCanary(port, child, maxWaitMs);
  const memory = await fetchJson(`http://127.0.0.1:${port}/__devspace/memory/status`);
  if (!memory.response.ok || memory.body?.ok !== true) throw new Error(`Canary memory endpoint failed with HTTP ${memory.response.status}.`);
  const toolSurface = await import("../dist/mcp-tool-priority.js");
  if (!Array.isArray(toolSurface.DEFAULT_MCP_TOOL_PRIORITY)) throw new Error("MCP tool priority export is unavailable.");
  for (const required of ["devspace_progress_report", "blender_runtime", "blender_mcp"]) {
    if (!toolSurface.DEFAULT_MCP_TOOL_PRIORITY.includes(required)) throw new Error(`Canary source priority is missing ${required}.`);
  }
  await sleep(2_000);
  if (child.exitCode != null) throw new Error(`Canary Core exited after readiness with code ${child.exitCode}.`);

  const productionAfter = await fetchJson(`http://127.0.0.1:${productionGatewayPort}/healthz`);
  if (!productionAfter.response.ok || productionAfter.body?.ok !== true) throw new Error("Production Gateway became unhealthy during canary.");
  if (preservePid && !processAlive(preservePid)) throw new Error(`Preserved process ${preservePid} was interrupted by canary.`);
  if (preservePort && !await portOnline(preservePort)) throw new Error(`Preserved port ${preservePort} was interrupted by canary.`);

  console.log(JSON.stringify({
    ok: true,
    gate: "alternate-port-core-startup",
    canary: {
      port,
      pid: child.pid,
      health: true,
      memory: {
        rss: memory.body.memory?.rss ?? null,
        heapUsed: memory.body.memory?.heapUsed ?? null,
        heapSizeLimit: memory.body.memory?.heapSizeLimit ?? null,
      },
      priorityTools: toolSurface.DEFAULT_MCP_TOOL_PRIORITY.slice(0, 5),
    },
    productionGateway: { port: productionGatewayPort, preserved: true },
    preservedProcess: preservePid ? { pid: preservePid, alive: true } : null,
    preservedPort: preservePort ? { port: preservePort, online: true } : null,
    stdoutTail: stdout.join("").slice(-2_000),
    stderrTail: stderr.join("").slice(-2_000),
  }));
} catch (error) {
  const diagnostics = {
    message: error instanceof Error ? error.message : String(error),
    childPid: child?.pid ?? null,
    childExitCode: child?.exitCode ?? null,
    stdoutTail: stdout.join("").slice(-8_000),
    stderrTail: stderr.join("").slice(-8_000),
    tempRoot,
  };
  throw new Error(`Alternate-port Core canary failed: ${JSON.stringify(diagnostics)}`);
} finally {
  await stopChild(child).catch(() => {});
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}
