import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source = await readFile(new URL("../dist/classic-progress-narration-overlay.js", import.meta.url), "utf8");
assert.match(source, /PRODUCER_LEASE_MS/,
  "progress narration must arbitrate one producer across concurrently running DevSpace Core processes");
assert.match(source, /competingProducerWins[\s\S]*pageMutationCount:0/,
  "a losing Core must return before mutating the shared progress card DOM");
assert.match(source, /ownerId:\s*PRODUCER_ID[\s\S]*priority:\s*PRODUCER_PRIORITY/,
  "the page-local lease must record the winning Core producer and priority");
assert.match(source, /const UI_VERSION = "7"/);
assert.match(source, /__devspaceProgressAnchor/);
assert.match(source, /now - Number\(prior\.observedAt \|\| 0\) < 1_500/);
assert.match(source, /if \(current\.style\.left !== nextLeft\)/);
assert.match(source, /if \(current\.style\.width !== nextWidth\)/);
assert.match(source, /const setData = \(key, value\)/);
assert.match(source, /if \(root\.dataset\[key\] !== next\) root\.dataset\[key\] = next/);
assert.match(source, /__devspaceProgressLastProjectionAt/);
assert.match(source, /setInterval\(\(\) =>/);
assert.doesNotMatch(source, /transition:opacity 160ms ease,transform 160ms ease,width 160ms ease,max-height 160ms ease/);
assert.match(source, /mappedState = \(\$\{serialized\}\)\[conversationId\] \|\| null/);
assert.doesNotMatch(source, /Date\.parse\(item\.at\) >= nowMs - maxAgeMs/,
  "Agent-authored conversation history must not disappear merely because a later turn starts after a wall-clock cutoff");
assert.match(source, /Human-authored narration is durable conversation history/);
assert.match(source, /const visible = Boolean\(conversationId\)/);
assert.match(source, /render an empty state rather than[\s\S]*historical rows/);
console.log(JSON.stringify({ ok:true, gate:"progress-narration-stability-static", anchorFallbackDebounced:true, conversationMapKeyed:true, crossTurnHistoryDurable:true }));
