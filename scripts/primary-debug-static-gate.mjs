import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");
const bridge = await readFile(new URL("../dist/goal-host-bridge.js", import.meta.url), "utf8");
const script = await readFile(new URL("./chat-classic-primary-debug.ps1", import.meta.url), "utf8");

assert.match(server, /import \{ ClassicPrimaryDebugGuard \} from "\.\/primary-debug-guard\.js";/);
assert.match(server, /const primaryDebugGuard = process\.platform === "win32"\s*\? new ClassicPrimaryDebugGuard\(\)\s*:\s*null;/,
  "Primary Debug Guard must exist only on its supported Windows runtime");
assert.match(server, /const\s+classicCdpOptions\s*=\s*Array\.isArray\(config\.classicMainDebugPorts\)[\s\S]{0,180}ports:\s*config\.classicMainDebugPorts/, "Primary/Host Bridge lifecycle must use the bounded configured Classic port set");
assert.match(server, /new ClassicGoalHostBridge\(\{\s*\.\.\.classicCdpOptions,\s*beforeDispatch:\s*config\.passiveCore\s*\|\|\s*!primaryDebugGuard\s*\?\s*undefined\s*:\s*\(\) => primaryDebugGuard\.pollOnce\(\),?\s*\}\)/s);
assert.doesNotMatch(server, /sendExactGoalRecovery|sendRecovery:\s*/,
  "same-round Goal Recovery must not wire a page-composer sender through Primary Debug Guard");
assert.doesNotMatch(server, /goalRoundCompletionGuard\.start\(/,
  "same-round Goal Recovery is retired and cannot trigger Primary debug repair indirectly");
const recoveryStart = bridge.indexOf("async dispatchRoundRecovery");
const recoveryEnd = bridge.indexOf("setBeforeRawDispatch", recoveryStart);
assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart);
assert.match(bridge.slice(recoveryStart, recoveryEnd), /visible-goal-recovery-transport-retired/);
assert.doesNotMatch(bridge.slice(recoveryStart, recoveryEnd), /primaryDebugGuard|beforeDispatch|this\.sendRaw\(|findExactConversation/,
  "retired same-round Goal Recovery must fail before repair, discovery, or host dispatch");
assert.match(server, /if\s*\(!config\.passiveCore\)[\s\S]*if\s*\(primaryDebugGuard\)[\s\S]*primaryDebugGuard\.start\(\)/,
  "Windows production Core keeps Primary Debug Guard while passive/non-Windows Core suppresses it");
assert.match(server, /await primaryDebugGuard\?\.close\?\.\(\)/);

assert.match(script, /OpenAI\.ChatGPT-Desktop/);
assert.match(script, /primaryDebugPort = 9721/);
assert.match(script, /ExpectedPid/);
assert.match(script, /canonical-primary-pid-changed/);
assert.match(script, /--remote-debugging-address=127\.0\.0\.1/);
assert.match(script, /--remote-debugging-port=\$primaryDebugPort/);
assert.match(script, /Restore-CanonicalPrimaryNormal/);
assert.match(script, /ValidateSet\("status",\s*"repair",\s*"show"\)/, "Primary debug helper must expose an explicit non-destructive show action for acceptance recovery");
assert.match(script, /function Show-CanonicalPrimary/, "Primary show action must be isolated from debug repair/restart logic");
const showBlock = script.match(/if \(\$Action -eq "show"\) \{([\s\S]*?)\n\}/);
assert.ok(showBlock, "Primary show action block must exist");
assert.match(showBlock[1], /Show-CanonicalPrimary/, "show action must activate the canonical Primary");
assert.doesNotMatch(showBlock[1], /Stop-CanonicalPrimary|Stop-Process/, "show action must never stop/restart Main-01");
assert.match(showBlock[1], /ProtocolOwnerModified\s*=\s*\$false/, "show action must never change protocol ownership");
assert.match(script, /ProtocolOwnerModified = \$false/);
assert.doesNotMatch(script, /UserChoice/);
assert.doesNotMatch(script, /Worker\d|OpenAI\.ChatGPT-Desktop\.Worker/);

console.log(JSON.stringify({
  ok: true,
  gate: "primary-debug-static",
  port: 9721,
  protectsProtocolOwner: true,
  expectedPidGuard: true,
  normalRestoreFallback: true,
}));
