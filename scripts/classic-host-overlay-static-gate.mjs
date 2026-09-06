import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [server, config, overlay] = await Promise.all([
  readFile(new URL("../dist/server.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/config.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/classic-host-overlay.js", import.meta.url), "utf8"),
]);

assert.match(server, /ClassicHostOverlayProjection/);
assert.match(server, /ClassicHostOverlayContextAdapter/);
assert.match(server, /createClassicHostOverlayOwnerStore/);
assert.match(server, /const hostOverlayOwnerStore = createClassicHostOverlayOwnerStore\(\{\s*stateDir:\s*config\.stateDir\s*\}\)/, "production must create exactly one persisted Host Overlay owner store for projection and delivery-recovery fallback");
assert.match(server, /ownerStore:\s*hostOverlayOwnerStore/, "Host Overlay projection must reuse the shared owner store instead of opening a competing state instance");
assert.match(server, /new ClassicHostOverlayContextAdapter\(\{\s*contextAdapter:\s*contextMetadataAdapter\s*\}\)/);
assert.doesNotMatch(server, /new ClassicHostOverlayCdpAdapter\(/, "production Host Overlay must reuse the existing Context Guardian CDP sessions instead of opening another long-lived pool");
assert.match(server, /classicHostOverlayEnabled/);
assert.match(server, /classic_host_overlay_projection_start_failed/);
assert.match(server, /await hostOverlayProjection\.close\(\)/);
assert.doesNotMatch(server, /await hostOverlayAdapter\.close\(\)/, "the shared Host Overlay adapter does not own Context Guardian sessions and must not close them");

assert.match(config, /DEVSPACE_CLASSIC_HOST_OVERLAY/);
assert.match(config, /classicHostOverlayEnabled/);

assert.match(overlay, /devspace-host-overlay-root/);
assert.match(overlay, /devspace-goal-strip/);
assert.match(overlay, /devspace-plan-hud/);
assert.match(overlay, /#prompt-textarea/);
assert.match(overlay, /#thread-bottom-container/);
assert.match(overlay, /main#main/);
assert.match(overlay, /surface=work/);
assert.match(overlay, /projectableGoals/);
assert.match(overlay, /conversationBoundProjectionMap/, "bound Goal\/Plan state must be grouped by authoritative conversation identity before projection");
assert.match(overlay, /syncConversationMap/, "production Host Overlay must broadcast a conversation projection map to every connected Main instead of assigning one runtime owner");
assert.match(overlay, /conversationProjectionMap\[currentConversationId\]/, "the renderer may use its current route only to select which conversation-bound projection to display");
assert.match(overlay, /mode:\s*"conversation-bound"/, "conversation-bound projection mode must supersede the legacy runtime-owner path when bound state exists");
assert.doesNotMatch(overlay, /\.innerHTML\s*=/);
assert.doesNotMatch(overlay, /Page\.reload|Page\.navigate|location\.reload|async reload\s*\(/, "Goal/Plan Host Overlay must not expose or invoke any ChatGPT page refresh/navigation capability");

console.log(JSON.stringify({
  ok: true,
  gate: "classic-host-overlay-static",
  productionLifecycle: true,
  chatOnly: true,
  backendProjection: true,
}));
