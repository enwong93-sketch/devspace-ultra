import assert from "node:assert/strict";
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
assert.throws(() => validateDevspaceListeners({
  listeners,
  processes: [
    { processId: 100, commandLine: "C:\\Other\\server.exe" },
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
}), /exactly one Stable Gateway listener|Multiple listener PIDs/);

const script = buildRestartPowerShell({
  taskName: "DevSpace-Stable-Gateway",
  gatewayPort: 7678,
  gatewayPid: 100,
  corePids: [200, 200, 0],
  resultPath: "C:\\State\\restart-result.json",
  delaySeconds: 5,
  timeoutSeconds: 90,
});
assert.match(script, /Stop-ScheduledTask/);
assert.match(script, /Stop-Process -Id \$pidValue -Force/);
assert.match(script, /Start-ScheduledTask/);
assert.match(script, /__devspace\/gateway\/healthz/);
assert.match(script, /\$oldPids=@\(100,200\)/);
assert.match(script, /secretValuesLogged=\$false/);
assert.equal(/token|authorization|password/i.test(script), false);
assert.throws(() => buildRestartPowerShell({
  taskName: "x",
  gatewayPort: 7678,
  gatewayPid: 0,
  corePids: [],
  resultPath: "x",
}), /valid Gateway PID/);

{
  const rows = await queryListenerProcesses([100, 200], {
    run: async (command, args, options) => {
      assert.equal(command, "powershell.exe");
      assert.equal(args.includes("-NonInteractive"), true);
      assert.equal(options.timeout, 15_000);
      return { stdout: '[{"processId":100,"name":"node.exe","commandLine":"gateway"},{"processId":200,"name":"node.exe","commandLine":"core"}]' };
    },
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].processId, 100);
}

console.log(JSON.stringify({
  ok: true,
  gate: "stable-gateway-whole-restart",
  exactListenerOwnership: true,
  delayedResponseSafeRestart: true,
  healthVerification: true,
  secretValuesLogged: false,
}));
