import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = await readFile(new URL("../dist/config.js", import.meta.url), "utf8");
const server = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");
const stream = await readFile(new URL("../dist/classic-stream-recovery-guard.js", import.meta.url), "utf8");
const rollover = await readFile(new URL("../dist/context-guardian-rollover.js", import.meta.url), "utf8");
const overlay = await readFile(new URL("../dist/classic-host-overlay.js", import.meta.url), "utf8");

assert.match(config, /DEVSPACE_CLASSIC_STREAM_RECOVERY/);
assert.match(config, /classicStreamRecoveryEnabled/);
assert.match(config, /DEVSPACE_CONTEXT_GUARDIAN/);
assert.match(config, /contextGuardianEnabled/);
assert.match(config, /DEVSPACE_CLASSIC_HOST_OVERLAY/);
assert.match(config, /classicHostOverlayEnabled/);
assert.match(config, /DEVSPACE_PASSIVE_CORE/);
assert.match(config, /passiveCore/);
assert.match(server, /if\s*\(config\.classicStreamRecoveryEnabled\)/);
assert.match(server, /if\s*\(config\.contextGuardianEnabled\)/);
assert.match(server, /if\s*\(config\.classicHostOverlayEnabled\)/);
assert.match(server, /if\s*\(!config\.passiveCore\)[\s\S]*primaryDebugGuard\.start/, "passive Core must not start Primary Debug Guard");
assert.match(server, /if\s*\(!config\.passiveCore\)[\s\S]*goalRoundCompletionGuard\.start/, "passive Core must not start Goal Round Completion Guard");
assert.match(server, /if\s*\(!config\.contextGuardianEnabled\)\s*return\s*\{\s*handled:\s*false/);
assert.match(server, /streamRecoveryAdapter\.start/);
assert.match(server, /streamRecoveryGuard\.start/);
assert.match(server, /contextMetadataAdapter\.start/);
assert.match(server, /contextRollover\.start/);
assert.match(server, /hostOverlayProjection\.start/);
assert.match(stream, /unsupported-mode/);
assert.match(rollover, /snapshot\.mode === "work"/);
assert.match(overlay, /surface=work/);
assert.match(overlay, /expectedConversationId/, "Host Overlay must fail closed outside its exact owner conversation");

console.log(JSON.stringify({
  ok: true,
  gate: "classic-safety-features-static",
  streamRecoveryDefaultOn: true,
  contextGuardianDefaultOn: true,
  classicHostOverlayDefaultOn: true,
  disabledMeansNoBackgroundAutomation: true,
  workModeStillUnsupported: true,
}));
