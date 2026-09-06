import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./host-overlay-conversation-live-gate.mjs", import.meta.url), "utf8");
assert.match(source, /Runtime\.evaluate/);
assert.match(source, /inspectionOrder:\s*"A→B→A"|validateHostOverlayConversationAcceptance/);
assert.match(source, /automaticPageActions:\s*0/);
assert.match(source, /urlOrDomUsedForBinding:\s*false/);
assert.doesNotMatch(source, /Page\.(?:reload|navigate|enable)/);
assert.doesNotMatch(source, /location\.(?:href\s*=|assign\(|replace\()/);
assert.doesNotMatch(source, /window\.location\s*=/);
assert.doesNotMatch(source, /data-testid=["']retry|Retry/);

console.log(JSON.stringify({
  ok: true,
  gate: "host-overlay-conversation-live-static",
  runtimeEvaluateOnly: true,
  automaticPageActions: 0,
  urlOrDomBinding: false,
}));
