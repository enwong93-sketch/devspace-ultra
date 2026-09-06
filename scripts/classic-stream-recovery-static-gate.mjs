import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");
const guard = await readFile(new URL("../dist/classic-stream-recovery-guard.js", import.meta.url), "utf8");
const adapter = await readFile(new URL("../dist/classic-stream-recovery-cdp.js", import.meta.url), "utf8");

assert.match(server, /ClassicStreamRecoveryGuard/);
assert.match(server, /ClassicStreamRecoveryCdpAdapter/);
assert.match(server, /streamRecoveryAdapter\.setFailureHandler\([\s\S]*streamRecoveryGuard\.noteTransportFailure/);
assert.match(server, /listRuntimes:\s*\(\) => streamRecoveryAdapter\.status\(\)\.runtimes/);
assert.match(server, /__devspace\/stream-recovery\/status/);
assert.match(server, /Stream Recovery diagnostics are loopback-only/);
assert.match(server, /adapter:\s*streamRecoveryAdapter\.status\(\)/);
assert.match(server, /guard:\s*streamRecoveryGuard\.status\(\)/);
assert.match(server, /streamRecoveryAdapter\.start\(/);
assert.match(server, /streamRecoveryGuard\.start\(/);
assert.match(server, /streamRecoveryGuard\.close\(/);
assert.match(server, /streamRecoveryAdapter\.close\(/);
assert.doesNotMatch(server, /streamRecoveryAdapter\.reload|reload:\s*\([^)]*\)\s*=>\s*streamRecoveryAdapter/, "production server must not inject a renderer page-action capability into Stream Recovery");

assert.match(adapter, /Network\.loadingFailed/);
assert.match(adapter, /\/stream_status/);
assert.match(adapter, /surface=work/);
assert.match(adapter, /progressSignature/);
assert.match(adapter, /composerTextChars/);
assert.doesNotMatch(adapter, /Page\.navigate|Page\.reload|location\.reload|\.reload\s*\(/, "Stream Recovery CDP adapter must not contain a page reload/navigation primitive");
assert.doesNotMatch(adapter, /async reload\s*\(/, "Stream Recovery adapter API must not expose reload");

assert.match(guard, /renderer-stale-after-complete-stream/);
assert.match(guard, /renderer-stale-latched/);
assert.match(guard, /automatic-page-refresh-forbidden/);
assert.match(guard, /recoveryAction:\s*"none"/);
assert.match(guard, /COMPLETE/);
assert.match(guard, /stalledGeneratingMs/);
assert.match(guard, /unsent-composer-protected/);
assert.match(guard, /renderer-recovered/);
assert.doesNotMatch(guard, /Page\.navigate|Page\.reload|autoReloadEnabled|reloadFailures|cooldown|this\.reload/, "Stream Recovery guard must observe and classify only; it must have no page-refresh state machine");

console.log(JSON.stringify({
  ok: true,
  gate: "classic-stream-recovery-static",
  chatModeOnly: true,
  protocolObservationOnly: true,
  unsentComposerProtected: true,
  serverCompleteRequired: true,
  automaticPageActionCount: 0,
}));
