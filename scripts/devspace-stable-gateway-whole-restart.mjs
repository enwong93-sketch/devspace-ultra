#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import {openSync, closeSync} from 'node:fs';
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadDevspaceFiles } from "../dist/user-config.js";
import { parseGatewayRestartArguments } from '../dist/gateway-restart-cli.js';
import {
  buildRestartPowerShell,
  parseNetstatListeners,
  queryListenerProcesses,
  validateDevspaceListeners,
} from "../dist/stable-gateway-restart.js";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const cli = parseGatewayRestartArguments(process.argv.slice(2));
const configDir = resolve(cli.configDir || join(homedir(), '.devspace-tailscale-bootstrap'));
if (cli.mode === 'help') {
  console.log('Usage: devspace-stable-gateway-whole-restart.mjs --status | --preflight-only | --execute [--config-dir PATH] [--delay-seconds 0..300]');
  process.exit(0);
}
if (cli.mode === 'status') {
  const path = join(configDir, 'logs', 'stable-gateway-whole-restart-result.json');
  let record = null;
  try { record = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  console.log(JSON.stringify({ ok: true, readOnly: true, state: record?.state || 'missing', record, statusPath: path, secretValuesLogged: false }));
  process.exit(0);
}
const taskName = cli.taskName;
const delaySeconds = cli.delaySeconds;
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
const jobProbe = await new Promise((resolveProbe, rejectProbe) => {
  // Match the actual detached helper's Job. execFile creates a short-lived
  // child Job and therefore measures the wrong containment boundary.
  const probe = spawn('python', [join(packageRoot,'scripts','devspace-runtime-safety-probe.py'),
    ...owned.map(entry=>String(entry.pid))], {detached:true,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='';
  probe.stdout.on('data',data=>{stdout+=data.toString('utf8');});
  probe.stderr.resume();
  probe.once('error',rejectProbe);
  probe.once('close',code=>code===0?resolveProbe(stdout):rejectProbe(new Error('Windows Job probe failed.')));
});
const jobSafety = JSON.parse(jobProbe).currentJob;
if (!jobSafety?.queryOk || !jobSafety?.limitsQueryOk || jobSafety.killOnJobClose !== false
  || !owned.every(entry=>jobSafety.requestedPidsInCurrentJob?.includes(entry.pid))) {
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
const helperStdoutPath=join(logDir,'stable-gateway-whole-restart-helper.out.log');
const helperStderrPath=join(logDir,'stable-gateway-whole-restart-helper.err.log');
const out=openSync(helperStdoutPath,'a');const err=openSync(helperStderrPath,'a');
const planPath=join(logDir,'stable-gateway-replacement-plan.json');
await writeFile(planPath,JSON.stringify({version:1,packageRoot,configDir,gatewayPort,delaySeconds,
  identities:owned.map(entry=>({pid:entry.pid,role:entry.role,createdAt:listenerProcesses.find(p=>p.processId===entry.pid).createdAt}))}),{encoding:'utf8',mode:0o600});
let helper;
try {
  helper = spawn(process.execPath, [join(packageRoot,'scripts','devspace-gateway-replace-worker.mjs'),planPath,
    ...(cli.mode === 'preflight-only'?['--preflight-only']:[])], {
    detached:true, windowsHide:true, stdio:['ignore',out,err],
  });
} finally {closeSync(out);closeSync(err);}
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
  helperStdoutPath,
  helperStderrPath,
  delaySeconds,
  resultPath,
  scriptPath,
  secretValuesLogged: false,
}));
