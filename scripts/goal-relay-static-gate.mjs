import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../dist/ui/goal-continuation-relay.html", import.meta.url), "utf8");

assert.match(html, /devspace_goal_continuation/);
assert.match(html, /action:\s*["']dispatch["']/);
assert.match(html, /dispatchStarted/);
assert.doesNotMatch(html, /sendFollowUpMessage/);
assert.doesNotMatch(html, /action:\s*["']claim["']/);
assert.doesNotMatch(html, /action:\s*["']ack["']/);
assert.doesNotMatch(html, /action:\s*["']release["']/);
assert.match(html, /openai:set_globals/);
assert.match(html, /ui\/notifications\/tool-result/);
assert.match(html, /status === ["']active["']/);
assert.match(html, /roundState === ["']reported["']/);
assert.match(html, /continuation\?\.state === ["']pending["']/);
assert.match(html, /removeEventListener/,
  "completed Goal relays must release host listeners instead of accumulating per round");
assert.match(html, /document\.body\.replaceChildren\(\)/,
  "completed or expired Goal relays must release their hidden DOM");
assert.match(html, /setTimeout\(retire, 150000\)/,
  "a failed hidden Goal relay must still self-retire after a bounded interval");
assert.doesNotMatch(html, /<button/i);
assert.doesNotMatch(html, /<script[^>]+src=/i);
assert.doesNotMatch(html, /<link[^>]+stylesheet/i);
assert.doesNotMatch(html, /https?:\/\//i);

console.log(JSON.stringify({ ok: true, gate: "goal-relay-static" }));
