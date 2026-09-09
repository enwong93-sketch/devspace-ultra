import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function parseNetstatListeners(text, ports) {
  const allowed = new Set(ports.map(Number));
  const rows = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+:\S+\s+LISTENING\s+(\d+)$/i);
    if (!match) continue;
    const port = Number(match[2]);
    const pid = Number(match[3]);
    if (!allowed.has(port) || !Number.isInteger(pid) || pid < 1) continue;
    rows.push({ address: match[1], port, pid });
  }
  rows.sort((left, right) => left.port - right.port || left.pid - right.pid);
  return rows;
}

function normalizePath(value) {
  return String(value || "").replaceAll("/", "\\").toLowerCase();
}

function ownedByPackageOrLauncher(process, processByPid, expectedRoot) {
  let current = process;
  const seen = new Set();
  for (let depth = 0; current && depth < 4; depth += 1) {
    const pid = Number(current.processId);
    if (seen.has(pid)) break;
    seen.add(pid);
    const commandLine = normalizePath(current.commandLine);
    if (commandLine.includes(expectedRoot)) {
      if (depth === 0 || /devspace-(?:stable-gateway|fixed-backend)\.mjs|dist\\cli\.js/.test(commandLine)) return true;
    }
    current = processByPid.get(Number(current.parentProcessId));
  }
  return false;
}

export function validateDevspaceListeners({ listeners, processes, packageRoot, gatewayPort, corePorts }) {
  const processByPid = new Map(processes.map((process) => [Number(process.processId), process]));
  const expectedRoot = normalizePath(packageRoot);
  const expectedPorts = [Number(gatewayPort), ...corePorts.map(Number)];
  const observed = [];
  for (const port of expectedPorts) {
    const matches = listeners.filter((listener) => listener.port === port);
    if (port === Number(gatewayPort) && matches.length > 1) {
      throw new Error(`Expected at most one Stable Gateway listener on ${port}; observed ${matches.length}.`);
    }
    if (matches.length > 1) throw new Error(`Multiple listener PIDs are bound to DevSpace port ${port}.`);
    if (!matches.length) continue;
    const listener = matches[0];
    const process = processByPid.get(listener.pid);
    const commandLine = normalizePath(process?.commandLine);
    const gateway = port === Number(gatewayPort);
    const expectedMarker = gateway ? "devspace-stable-gateway.mjs" : "dist\\cli.js";
    if (!commandLine || !commandLine.includes(expectedMarker)) {
      throw new Error(`Listener ${listener.pid} on port ${port} does not match the expected ${gateway ? "Gateway" : "Core"} command.`);
    }
    if (!ownedByPackageOrLauncher(process, processByPid, expectedRoot)) {
      throw new Error(`Listener ${listener.pid} on port ${port} is not owned by the expected DevSpace package root.`);
    }
    observed.push({ port, pid: listener.pid, role: gateway ? "gateway" : "core" });
  }
  return observed;
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildRestartPowerShell({
  taskName,
  gatewayPort,
  gatewayPid,
  corePids,
  resultPath,
  helperTaskName = null,
  delaySeconds = 5,
}) {
  const allPids = [...new Set([gatewayPid, ...corePids].map(Number).filter((value) => Number.isInteger(value) && value > 0))];
  const pidList = allPids.join(",");
  return [
    "$ErrorActionPreference='Stop'",
    `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)`,
    `$taskName=${psQuote(taskName)}`,
    `$resultPath=${psQuote(resultPath)}`,
    `$gatewayPort=${Number(gatewayPort)}`,
    `$oldPids=@(${pidList})`,
    `$startedAt=[DateTime]::UtcNow.ToString('o')`,
    `$ok=$false`,
    `$state='scheduled'`,
    `$reason=$null`,
    "try {",
    `  Start-Sleep -Seconds ${Number(delaySeconds)}`,
    "  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue",
    "  foreach ($pidValue in $oldPids) { Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue }",
    "  Start-Sleep -Seconds 2",
    "  Start-ScheduledTask -TaskName $taskName",
    "  while (-not $ok) {",
    "    Start-Sleep -Milliseconds 500",
    "    try {",
    "      $response=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$gatewayPort+'/__devspace/gateway/healthz')",
    "      if ($response.ok -eq $true) { $ok=$true; $state='ready'; break }",
    "    } catch {}",
    "    $task=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue",
    "    $taskInfo=Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue",
    "    $listener=Get-NetTCPConnection -State Listen -LocalPort $gatewayPort -ErrorAction SilentlyContinue | Select-Object -First 1",
    "    if (-not $listener -and $task -and $task.State -ne 'Running' -and $taskInfo -and $taskInfo.LastTaskResult -notin @(0,267009)) {",
    "      throw ('Stable Gateway task exited before readiness (LastTaskResult='+$taskInfo.LastTaskResult+').')",
    "    }",
    "  }",
    "} catch {",
    "  $state='failed'",
    "  $reason=$_.Exception.GetType().Name",
    "}",
    "$payload=[ordered]@{ok=$ok;state=$state;reason=$reason;taskName=$taskName;gatewayPort=$gatewayPort;oldPids=$oldPids;startedAt=$startedAt;completedAt=[DateTime]::UtcNow.ToString('o');secretValuesLogged=$false}",
    "$directory=Split-Path -Parent $resultPath",
    "New-Item -ItemType Directory -Path $directory -Force | Out-Null",
    "$payload | ConvertTo-Json -Compress | Set-Content -LiteralPath $resultPath -Encoding UTF8",
    ...(helperTaskName ? [
      `$helperTaskName=${psQuote(helperTaskName)}`,
      "try { Unregister-ScheduledTask -TaskName $helperTaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}",
    ] : []),
    "if (-not $ok) { exit 1 }",
  ].join("\r\n");
}

export async function queryListenerProcesses(pids, { run = execFileAsync } = {}) {
  const values = [...new Set(pids.map(Number).filter((value) => Number.isInteger(value) && value > 0))];
  if (!values.length) return [];
  const filter = values.map((pid) => `$_.ProcessId -eq ${pid}`).join(" -or ");
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
    `@(Get-CimInstance Win32_Process | Where-Object { ${filter} } | ForEach-Object { [pscustomobject]@{processId=[int]$_.ProcessId;parentProcessId=[int]$_.ParentProcessId;name=[string]$_.Name;executablePath=[string]$_.ExecutablePath;commandLine=[string]$_.CommandLine} }) | ConvertTo-Json -Compress`,
  ].join("; ");
  const result = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  const parsed = JSON.parse(String(result.stdout || "[]").replace(/^\uFEFF/, "") || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}
