import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [server, rollover, overlay] = await Promise.all([
  readFile(new URL("../dist/server.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/context-guardian-rollover.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/classic-host-overlay.js", import.meta.url), "utf8"),
]);

assert.match(server, /resolveOwner:\s*\(goal\)\s*=>\s*resolveClassicHostOverlayOwner/, "production Host Overlay must use the conservative initial-owner resolver");
assert.match(server, /contextAdapter:\s*contextMetadataAdapter/, "owner resolution must reuse the Context Guardian session adapter");
assert.match(overlay, /resolveClassicHostOverlayOwner/);
assert.match(overlay, /goalHostBridge\.findMatchingCandidate\(goalId,\s*\{\s*conversationId:\s*boundConversationId/s, "normal initial owner resolution must prefer the real Goal Host Bridge while enforcing the Goal's bound conversation");
assert.match(overlay, /hiddenActive\.length === 1/, "upgrade bootstrap must require exactly one hidden-style active Chat");
assert.match(overlay, /snapshot\.visibleMessageCount/, "upgrade bootstrap must refuse ordinary visible conversations");
assert.match(overlay, /!boundConversationId \|\| conversationId === boundConversationId/, "bound Goal owner discovery and hidden bootstrap must reject another conversation");
assert.match(server, /onVerifiedRollover:\s*async \(event\)\s*=>/,
  "verified Context Guardian rollover must use the guarded authority-transfer callback");
assert.match(server, /conversationAuthority\.acceptVerifiedRollover/,
  "verified rollover must rotate native MCP conversation authority");
assert.match(server, /planRuntime\.rebindConversation/,
  "verified rollover must transfer the active Plan to the continuation conversation");
assert.match(server, /goalRuntime\.rebindConversation/,
  "verified rollover must transfer the active Goal to the continuation conversation");
assert.match(server, /goalRunProgress\.rebindConversation/,
  "verified rollover must preserve progress narration continuity");
assert.match(server, /hostOverlayProjection\.noteVerifiedRollover/,
  "verified rollover must transfer Host Overlay ownership to the continuation conversation");
assert.match(rollover, /onVerifiedRollover/);
assert.match(rollover, /oldConversationId/);
assert.match(rollover, /newConversationId/);
assert.match(overlay, /noteVerifiedRollover/);
assert.match(overlay, /current\.conversationId !== priorConversationId/);

console.log(JSON.stringify({
  ok: true,
  gate: "classic-host-overlay-owner-static",
  initialOwnerResolved: true,
  exactConversationBound: true,
  verifiedRolloverTransferWired: true,
}));
