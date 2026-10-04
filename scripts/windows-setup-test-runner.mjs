import { platform } from 'node:os';
import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import './self-update-native-readiness.test.mjs';

if (platform() !== 'win32') {
  console.log(JSON.stringify({ ok: true, gate: 'windows-setup-unit', skipped: 'non-Windows host' }));
} else {
  const windowsPowerShellEnv = {
    ...process.env,
    PSModulePath: [
      join(homedir(), 'Documents', 'WindowsPowerShell', 'Modules'),
      join(process.env.ProgramFiles, 'WindowsPowerShell', 'Modules'),
      join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
    ].join(';'),
  };
  for (const file of [
    'scripts/windows-installer.test.ps1',
    'scripts/devspace-public-setup.test.ps1',
    'scripts/devspace-local-ingress.test.ps1',
    'scripts/self-update-readiness.test.ps1',
    'scripts/self-update-shared-runtime.test.ps1',
    'scripts/chat-classic-session-source.test.ps1',
  ]) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], {
      stdio: 'inherit', shell: false, timeout: 30000, env: windowsPowerShellEnv,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  const server = createServer((request, response) => {
    response.writeHead(500, { 'Content-Type': 'text/xml; charset=utf-8' });
    response.end(request.url === '/missing'
      ? '<s:Fault><detail><UPnPError><errorCode>714</errorCode></UPnPError></detail></s:Fault>'
      : '<html>generic router failure</html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    for (const host of ['powershell.exe', 'pwsh']) {
      await new Promise((resolve, reject) => {
        const child = spawn(host, ['-NoProfile', '-File', 'scripts/devspace-upnp-loopback.test.ps1', '-BaseUrl', baseUrl], {
          stdio: 'inherit', shell: false, env: host === 'powershell.exe' ? windowsPowerShellEnv : process.env,
        });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${host} UPnP loopback test failed: ${code}`)));
      });
    }
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
