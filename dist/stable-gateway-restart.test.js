import assert from "node:assert/strict";
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {
  buildRestartPowerShell,
  parseNetstatListeners,
  queryListenerProcesses,
  validateDevspaceListeners,
} from "./stable-gateway-restart.js";

const listeners = parseNetstatListeners(`
  TCP    127.0.0.1:7678    0.0.0.0:0    LISTENING    100
  TCP    127.0.0.1:7688    0.0.0.0:0    LISTENING    200
  TCP    127.0.0.1:9999    0.0.0.0:0    LISTENING    300
`, [7678, 7688, 7689]);
assert.deepEqual(listeners, [
  { address: "127.0.0.1", port: 7678, pid: 100 },
  { address: "127.0.0.1", port: 7688, pid: 200 },
]);

const observed = validateDevspaceListeners({
  listeners,
  processes: [
    { processId: 100, commandLine: '"C:\\Program Files\\nodejs\\node.exe" C:\\DevSpace\\scripts\\devspace-stable-gateway.mjs' },
    { processId: 200, commandLine: '"C:\\Program Files\\nodejs\\node.exe" C:\\DevSpace\\dist\\cli.js serve' },
  ],
  packageRoot: "C:\\DevSpace",
  gatewayPort: 7678,
  corePorts: [7688, 7689],
});
assert.deepEqual(observed, [
  { port: 7678, pid: 100, role: "gateway" },
  { port: 7688, pid: 200, role: "core" },
]);

const legacyRelativeObserved = validateDevspaceListeners({
  listeners,
  processes: [
    { processId: 100, parentProcessId: 90, commandLine: '"C:\\Program Files\\nodejs\\node.exe" scripts/devspace-stable-gateway.mjs' },
    { processId: 90, parentProcessId: 1, commandLine: '"C:\\Program Files\\nodejs\\node.exe" C:\\DevSpace\\scripts\\devspace-fixed-backend.mjs --foreground' },
    { processId: 200, parentProcessId: 100, commandLine: '"C:\\Program Files\\nodejs\\node.exe" dist/cli.js serve' },
  ],
  packageRoot: "C:\\DevSpace",
  gatewayPort: 7678,
  corePorts: [7688, 7689],
});
assert.deepEqual(legacyRelativeObserved, [
  { port: 7678, pid: 100, role: "gateway" },
  { port: 7688, pid: 200, role: "core" },
]);
assert.throws(() => validateDevspaceListeners({
  listeners,
  processes: [
    { processId: 100, parentProcessId: 90, commandLine: '"C:\\Program Files\\nodejs\\node.exe" scripts/devspace-stable-gateway.mjs' },
    { processId: 90, commandLine: '"C:\\Program Files\\nodejs\\node.exe" C:\\Other\\scripts\\devspace-fixed-backend.mjs --foreground' },
    { processId: 200, commandLine: "C:\\DevSpace\\dist\\cli.js serve" },
  ],
  packageRoot: "C:\\DevSpace",
  gatewayPort: 7678,
  corePorts: [7688, 7689],
}), /not owned by the expected DevSpace package root/);
assert.throws(() => validateDevspaceListeners({
  listeners: [...listeners, { address: "::1", port: 7678, pid: 101 }],
  processes: [],
  packageRoot: "C:\\DevSpace",
  gatewayPort: 7678,
  corePorts: [7688, 7689],
}), /at most one Stable Gateway listener|Multiple listener PIDs/);

const script = buildRestartPowerShell({
  taskName: "DevSpace-Stable-Gateway",
  gatewayPort: 7678,
  gatewayPid: 100,
  corePids: [200, 200, 0],
  resultPath: "C:\\State\\restart-result.json",
  helperTaskName: "DevSpace-Stable-Gateway-Restart-test",
  delaySeconds: 5,
});
assert.doesNotMatch(script, /Stop-ScheduledTask|Stop-Job|TerminateJobObject/,
  'replacing Gateway must never kill a shared Windows Job containing Blender');
assert.match(script, /Stop-Process -Id \$pidValue -Force/);
assert.match(script, /Start-ScheduledTask/);
assert.match(script, /__devspace\/gateway\/healthz/);
assert.match(script, /while \(-not \$ok\)/, "restart health verification must wait for actual readiness rather than a wall-clock deadline");
assert.doesNotMatch(script.slice(script.indexOf('  Start-ScheduledTask')), /quietDeadline|health-timeout/,
  "startup has no overall deadline; the bounded quiet check may only abort BEFORE stopping any work");
assert.ok(script.indexOf('$quietSamples -lt 3') < script.indexOf(' Stop-Process'));
assert.ok(script.indexOf('Process identity changed; restart cancelled.') < script.indexOf(' Stop-Process'));
assert.match(script, /admission\.activeRequests -eq 0/);
assert.match(script, /activity\.running -eq 0/);
assert.match(script, /\$oldPids=@\(100,200\)/);
assert.match(script, /secretValuesLogged=\$false/);
assert.match(script, /Unregister-ScheduledTask -TaskName \$helperTaskName/);
assert.equal(/token|authorization|password/i.test(script), false);
const coldStartScript = buildRestartPowerShell({
  taskName: "x",
  gatewayPort: 7678,
  gatewayPid: 0,
  corePids: [],
  resultPath: "x",
});
assert.match(coldStartScript, /\$oldPids=@\(\)/, "zero-listener recovery must be a supported cold-start path");
assert.match(coldStartScript, /\$hasGateway=\$false/);
const preserveJobScript=buildRestartPowerShell({taskName:'x',gatewayPort:7678,gatewayPid:100,corePids:[200],resultPath:'x',
  nodePath:'C:\\Node\\node.exe',launcherPath:'C:\\DevSpace\\scripts\\devspace-fixed-backend.mjs',configDir:'C:\\State'});
assert.match(preserveJobScript,/Start-Process -FilePath \$nodePath/);
assert.doesNotMatch(preserveJobScript,/Stop-ScheduledTask|Start-ScheduledTask|Unregister-ScheduledTask/);
if (process.platform === 'win32') {
  const encoded=Buffer.from(preserveJobScript,'utf8').toString('base64');
  const check=`$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')),[ref]$t,[ref]$e)|Out-Null; if($e.Count){$e|ForEach-Object{$_.Message};exit 1}`;
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',check],{windowsHide:true});
}

{
  const rows = await queryListenerProcesses([100, 200], {
    run: async (command, args, options) => {
      assert.equal(command, "powershell.exe");
      assert.equal(args.includes("-NonInteractive"), true);
      assert.equal(options.timeout, undefined, "listener ownership lookup must not have a wall-clock kill timeout");
      return { stdout: '[{"processId":100,"name":"node.exe","commandLine":"gateway"},{"processId":200,"name":"node.exe","commandLine":"core"}]' };
    },
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].processId, 100);
  assert.equal(Object.hasOwn(rows[0], "parentProcessId"), false, "fixture confirms parser preserves only fields returned by PowerShell");
}

const worker=readFileSync(new URL('../scripts/devspace-gateway-replace-worker.mjs',import.meta.url),'utf8');
assert.doesNotMatch(worker,/Stop-ScheduledTask|TerminateJobObject|taskkill|Stop-Job/);
assert.match(worker,/actual\.createdAt!==p\.createdAt/);
assert.match(worker,/job\.killOnJobClose!==false/);
assert.ok(worker.indexOf("if(!quiet(await snapshot()))") < worker.indexOf('process.kill(p.pid)'));
assert.match(worker,/await save\('replacing-exact-processes'/);
assert.match(worker,/if\(process\.argv\.includes\('--preflight-only'\)\)/);
assert.match(worker,/devspace-fixed-backend\.mjs/);
assert.match(worker,/detached:true/);

console.log(JSON.stringify({
  ok: true,
  gate: "stable-gateway-whole-restart",
  exactListenerOwnership: true,
  legacyRelativeChildrenRequireOwnedParent: true,
  zeroListenerColdStart: true,
  noStartupDeadline: true,
  healthVerification: true,
  secretValuesLogged: false,
}));
