#!/usr/bin/env node
import { execFile } from "node:child_process";
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

const helperTaskName = `${taskName}-Restart-${Date.now().toString(36)}`.slice(0, 220);
const script = buildRestartPowerShell({
  taskName,
  gatewayPort,
  gatewayPid: gateway?.pid ?? null,
  corePids,
  resultPath,
  helperTaskName,
  delaySeconds,
  expectedProcesses: owned.map(entry => {
    const process=listenerProcesses.find(row=>row.processId===entry.pid);
    if (!process?.createdAt) throw new Error('Process creation identity is unavailable; refusing whole restart.');
    return {processId:entry.pid,createdAt:process.createdAt};
  }),
});
await writeFile(scriptPath, `${script}\r\n`, { encoding: "utf8", mode: 0o600 });

const helperCommand = [
  "$ErrorActionPreference='Stop'",
  `$helperTaskName=${psQuote(helperTaskName)}`,
  `$scriptPath=${psQuote(scriptPath)}`,
  "$execute=Join-Path $PSHOME 'powershell.exe'",
  `$arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$scriptPath+'"'`,
  "$action=New-ScheduledTaskAction -Execute $execute -Argument $arguments",
  "$trigger=New-ScheduledTaskTrigger -Once -At ((Get-Date).AddHours(1))",
  "$settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)",
  "$principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited",
  "$definition=New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal",
  "Register-ScheduledTask -TaskName $helperTaskName -InputObject $definition -Force | Out-Null",
  "Start-ScheduledTask -TaskName $helperTaskName",
].join("; ");
await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", helperCommand], {
  windowsHide: true,
  maxBuffer: 2 * 1024 * 1024,
});

console.log(JSON.stringify({
  ok: true,
  state: "restart-scheduled",
  taskName,
  gatewayPort,
  corePorts,
  oldGatewayPid: gateway?.pid ?? null,
  oldCorePids: corePids,
  helperTaskName,
  delaySeconds,
  resultPath,
  scriptPath,
  secretValuesLogged: false,
}));
