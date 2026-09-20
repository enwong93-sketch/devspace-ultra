#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadDevspaceFiles } from "../dist/user-config.js";
import {
  buildRestartPowerShell,
  parseNetstatListeners,
  queryListenerProcesses,
  validateDevspaceListeners,
} from "../dist/stable-gateway-restart.js";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function argument(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? String(process.argv[index + 1]) : fallback;
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const configDir = resolve(argument("config-dir", join(homedir(), ".devspace-tailscale-bootstrap")));
const taskName = argument("task-name", "DevSpace-Stable-Gateway").trim();
const delaySeconds = Math.max(0, Number(argument("delay-seconds", "6")) || 0);
if (!taskName) throw new Error("Scheduled Task name is required.");

const files = loadDevspaceFiles({ ...process.env, DEVSPACE_CONFIG_DIR: configDir });
const config = files.config || {};
const gatewayPort = Number(config.stableGatewayPort ?? config.edgeBackendPort ?? 7678);
const corePorts = [
  Number(config.stableGatewayCoreAPort ?? gatewayPort + 10),
  Number(config.stableGatewayCoreBPort ?? gatewayPort + 11),
];
for (const port of [gatewayPort, ...corePorts]) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`Invalid DevSpace production port: ${port}`);
}

await execFileAsync("powershell.exe", [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  `$task=Get-ScheduledTask -TaskName '${taskName.replaceAll("'", "''")}' -ErrorAction Stop; if (-not $task) { exit 2 }`,
], { windowsHide: true, maxBuffer: 1024 * 1024 });

const logDir = join(configDir, "logs");
const resultPath = join(logDir, "stable-gateway-whole-restart-result.json");
const scriptPath = join(logDir, "stable-gateway-whole-restart-pending.ps1");
await mkdir(logDir, { recursive: true });
await rm(resultPath, { force: true });

const netstat = await execFileAsync("netstat.exe", ["-ano", "-p", "tcp"], {
  windowsHide: true,
  maxBuffer: 4 * 1024 * 1024,
});
const listeners = parseNetstatListeners(netstat.stdout, [gatewayPort, ...corePorts]);
const listenerProcesses = await queryListenerProcesses(listeners.map((listener) => listener.pid));
const parentPids = listenerProcesses.map((process) => process.parentProcessId);
const parentProcesses = await queryListenerProcesses(parentPids);
const processes = [...listenerProcesses, ...parentProcesses];
const owned = validateDevspaceListeners({
  listeners,
  processes,
  packageRoot,
  gatewayPort,
  corePorts,
});
const gateway = owned.find((entry) => entry.role === "gateway") ?? null;
const corePids = owned.filter((entry) => entry.role === "core").map((entry) => entry.pid);
const jobProbe = await execFileAsync('python', [join(packageRoot,'scripts','devspace-runtime-safety-probe.py'),
  ...owned.map(entry=>String(entry.pid))], {windowsHide:true,maxBuffer:1024*1024});
const jobSafety = JSON.parse(jobProbe.stdout).currentJob;
if (!jobSafety?.queryOk || !jobSafety?.limitsQueryOk || jobSafety.killOnJobClose !== false) {
  throw new Error('Cannot prove shared Windows Job survives launcher exit; no process was stopped.');
}

const helperTaskName = `${taskName}-Restart-${Date.now().toString(36)}`.slice(0, 220);
const script = buildRestartPowerShell({
  taskName,
  gatewayPort,
  gatewayPid: gateway?.pid ?? null,
  corePids,
  resultPath,
  delaySeconds,
  nodePath: process.execPath,
  launcherPath: join(packageRoot, 'scripts', 'devspace-fixed-backend.mjs'),
  configDir,
  expectedProcesses: owned.map(entry => {
    const process=listenerProcesses.find(row=>row.processId===entry.pid);
    if (!process?.createdAt) throw new Error('Process creation identity is unavailable; refusing whole restart.');
    return {processId:entry.pid,createdAt:process.createdAt};
  }),
});
await writeFile(scriptPath, `${script}\r\n`, { encoding: "utf8", mode: 0o600 });

// Keep the existing Windows Job alive; do not stop/unregister the production
// task or create another task-owned Job around its long-lived applications.
const helper = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',scriptPath], {
  detached:true, windowsHide:true, stdio:'ignore',
});
helper.unref();

console.log(JSON.stringify({
  ok: true,
  state: "restart-scheduled",
  taskName,
  gatewayPort,
  corePorts,
  oldGatewayPid: gateway?.pid ?? null,
  oldCorePids: corePids,
  helperTaskName,
  helperPid: helper.pid,
  jobPreserved: true,
  delaySeconds,
  resultPath,
  scriptPath,
  secretValuesLogged: false,
}));
