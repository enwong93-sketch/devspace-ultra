import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("./ui/progress-claim-relay.html", import.meta.url), "utf8");
assert.match(html, /width:\s*1px/);
assert.match(html, /height:\s*1px/);
assert.match(html, /aria-hidden="true"/);
assert.match(html, /window\.openai\.callTool\("devspace_progress_report"/);
assert.match(html, /ui\/notifications\/tool-result/);
assert.match(html, /dispatchStarted/);
assert.doesNotMatch(html, /sendFollowUpMessage|location\.|parent\.location|composer|prompt-textarea/);

console.log(JSON.stringify({
  ok: true,
  gate: "progress-claim-relay",
  hidden: true,
  noSyntheticUserTurn: true,
  oneShot: true,
}));
