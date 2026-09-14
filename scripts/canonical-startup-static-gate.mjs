import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [startup, interactive, identity] = await Promise.all([
  readFile(new URL("./devspace-canonical-startup.ps1", import.meta.url), "utf8"),
  readFile(new URL("./chat-classic-interactive-runtime.ps1", import.meta.url), "utf8"),
  readFile(new URL("./chat-swarm-classic-runtime-identity.ps1", import.meta.url), "utf8"),
]);

assert.match(startup, /DevSpace-Canonical-Startup/);
assert.match(startup, /\.devspace-tailscale-bootstrap/);
assert.match(startup, /devspace-stable-gateway-startup\.ps1/);
assert.match(startup, /devspace-local-ingress\.ps1/);
assert.match(startup, /\$mainNumbers = @\(2, 3, 4, 5\)/);
assert.match(startup, /Start-SecondaryMain[\s\S]*-StartMinimized/);
assert.match(startup, /New-ScheduledTaskTrigger -AtLogOn/);
assert.match(startup, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/);
assert.doesNotMatch(startup, /Page\.navigate|SetForegroundWindow/);
assert.match(interactive, /\[switch\]\$StartMinimized/);
assert.match(interactive, /-WindowStyle Minimized/);
assert.match(identity, /-NoWindowActivation/);
assert.match(identity, /-WindowStyle Minimized/);

console.log(JSON.stringify({ ok: true, gate: "canonical-startup-static", workerAutostart: false, foregroundActivation: false }));
