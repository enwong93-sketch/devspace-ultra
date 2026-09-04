#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDevspaceFiles } from "../dist/user-config.js";
import { resolveNpxInvocation } from "../dist/edge-cloudflare.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const action = process.argv.includes("--status")
  ? "status"
  : process.argv.includes("--foreground")
    ? "foreground"
    : "start";
const files = loadDevspaceFiles();
const runtimeStatePath = join(files.dir, "edge-tunnel-runtime.json");
const logPath = join(files.dir, "edge-tunnel.log");

function readRuntimeState() {
  if (!existsSync(runtimeStatePath)) return null;
  try { return JSON.parse(readFileSync(runtimeStatePath, "utf8")); }
  catch { return null; }
}

function processAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function processMatchesTunnel(pid, expectedTunnelId) {
  if (!processAlive(pid)) return false;
  if (process.platform !== "win32") return true;
  const numericPid = Number(pid);
  const tunnelId = String(expectedTunnelId || "");
  if (!Number.isInteger(numericPid) || numericPid <= 0 || !/^[0-9a-f-]{36}$/i.test(tunnelId)) return false;
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${numericPid}' -ErrorAction SilentlyContinue`,
    "if (-not $p) { exit 2 }",
    "$c = [string]$p.CommandLine",
    `if ($c -match 'wrangler(?:@4)?' -and $c -match 'tunnel\\s+run' -and $c -match '${tunnelId}') { exit 0 }`,
    "exit 3",
  ].join("; ");
  const check = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    windowsHide: true,
    stdio: "ignore",
  });
  return check.status === 0;
}

function stopExistingNamedTunnelWrappers(expectedTunnelId) {
  if (process.platform !== "win32") return;
  const tunnelId = String(expectedTunnelId || "");
  if (!/^[0-9a-f-]{36}$/i.test(tunnelId)) return;
  const script = [
    `$tunnelId = '${tunnelId}'`,
    "$matches = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { ([string]$_.CommandLine) -match 'wrangler' -and ([string]$_.CommandLine) -match 'tunnel\\s+run' -and ([string]$_.CommandLine) -match [regex]::Escape($tunnelId) })",
    "$ids = @($matches | ForEach-Object { [int]$_.ProcessId })",
    "$roots = @($matches | Where-Object { $ids -notcontains [int]$_.ParentProcessId })",
    "foreach ($p in $roots) { & taskkill.exe /PID $p.ProcessId /T /F *> $null }",
  ].join("; ");
  const cleanup = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    windowsHide: true,
    stdio: "ignore",
    timeout: 15_000,
  });
  if (cleanup.error) throw cleanup.error;
}

function writeState(value) {
  mkdirSync(files.dir, { recursive: true });
  writeFileSync(runtimeStatePath, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

const config = files.config ?? {};
const enabled = config.edgeProvider === "cloudflare-worker" && config.edgeTransportMode === "workers-vpc";
const tunnelId = String(config.edgeTunnelId ?? "").trim();

if (!enabled) {
  console.log(JSON.stringify({ ok: true, state: "not-configured", workersVpc: false, secretValuesLogged: false }));
  process.exit(0);
}
if (!/^[0-9a-f-]{36}$/i.test(tunnelId)) {
  console.log(JSON.stringify({ ok: false, state: "invalid-config", reason: "edge-tunnel-id-invalid", secretValuesLogged: false }));
  process.exit(2);
}

const previous = readRuntimeState();
let previousAlive = Boolean(previous?.tunnelId === tunnelId && processMatchesTunnel(previous?.pid, tunnelId));

if (action === "foreground") {
  // Upgrade/restart ownership rule: the Scheduled Task must be the sole lifetime
  // owner of this exact named tunnel. Clean up only wrappers whose command line
  // names this tunnel id; Quick Tunnels and unrelated cloudflared processes are untouched.
  stopExistingNamedTunnelWrappers(tunnelId);
  previousAlive = false;
}

if (action === "status") {
  console.log(JSON.stringify({
    ok: true,
    state: previousAlive ? "running" : "stopped",
    workersVpc: true,
    tunnelId,
    pid: previousAlive ? Number(previous.pid) : null,
    logPath,
    secretValuesLogged: false,
  }));
  process.exit(0);
}

if (previousAlive) {
  console.log(JSON.stringify({
    ok: true,
    state: "already-running",
    workersVpc: true,
    tunnelId,
    pid: Number(previous.pid),
    secretValuesLogged: false,
  }));
  process.exit(0);
}

const env = { ...process.env };
// A stale account-scoped API token can override the one-time Wrangler OAuth
// login and prevent the named tunnel from starting. Setup has already verified
// the stored OAuth credential, so steady-state startup intentionally uses it.
delete env.CLOUDFLARE_API_TOKEN;
delete env.CLOUDFLARE_ACCOUNT_ID;

const invocation = resolveNpxInvocation(["--yes", "wrangler@4", "tunnel", "run", tunnelId]);
if (process.platform === "win32" && !existsSync(invocation.args[0])) {
  throw new Error(`Unable to locate npm npx CLI at ${invocation.args[0]}.`);
}

mkdirSync(files.dir, { recursive: true });
const stdoutFd = openSync(logPath, "a");
const stderrFd = openSync(logPath, "a");
let child;
try {
  child = spawn(invocation.command, invocation.args, {
    cwd: packageRoot,
    env,
    windowsHide: true,
    detached: action !== "foreground",
    shell: false,
    stdio: ["ignore", stdoutFd, stderrFd],
  });
  if (action !== "foreground") child.unref();
} finally {
  closeSync(stdoutFd);
  closeSync(stderrFd);
}

const state = {
  version: 1,
  tunnelId,
  pid: child.pid,
  startedAt: new Date().toISOString(),
  secretValuesLogged: false,
};
writeState(state);
console.log(JSON.stringify({
  ok: true,
  state: action === "foreground" ? "running-foreground" : "started",
  workersVpc: true,
  tunnelId,
  pid: child.pid,
  logPath,
  secretValuesLogged: false,
}));

if (action === "foreground") {
  const exitCode = await new Promise((resolvePromise) => {
    child.once("error", () => resolvePromise(1));
    child.once("exit", (code) => resolvePromise(Number(code ?? 1)));
  });
  writeState({
    ...state,
    pid: null,
    lastPid: child.pid,
    stoppedAt: new Date().toISOString(),
    exitCode,
  });
  process.exitCode = exitCode;
}
