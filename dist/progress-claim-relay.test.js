import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("./ui/progress-claim-relay.html", import.meta.url), "utf8");
assert.match(html, /width:\s*1px/);
assert.match(html, /height:\s*1px/);
assert.match(html, /aria-hidden="true"/);
assert.match(html, /toolName:\s*"devspace_progress_report"/);
assert.match(html, /startClaim\.toolName === "devspace_goal_start"/);
assert.match(html, /startClaim\.toolName === "devspace_plan_start"/);
assert.match(html, /window\.openai\.callTool\(action\.toolName, action\.arguments\)/);
assert.match(html, /window\.openai\?\.requestClose/);
assert.match(html, /await closeRelay\(\)/);
assert.match(html, /window\.openai\?\.toolResponseMetadata/,
  "progress claim relay must consume tool-result metadata when toolOutput is unavailable");
assert.match(html, /devspace\/progressClaim/,
  "progress claim relay must recognize the opaque one-time claim metadata key");
assert.match(html, /devspace\/conversationStartClaim/,
  "the same hidden exact-page relay must recognize Goal/Plan start ownership claims");
assert.match(html, /structured\?\.ok === true && structured\?\.claimed === true/);
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
