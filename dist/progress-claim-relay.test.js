import assert from "node:assert/strict";
import './progress-claim-lifetime.test.js';
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("./ui/progress-claim-relay.html", import.meta.url), "utf8");
assert.match(html, /width:\s*1px/);
assert.match(html, /height:\s*1px/);
assert.match(html, /aria-hidden="true"/);
assert.match(html, /toolName:\s*"devspace_progress_report"/);
assert.match(html, /startClaim\.toolName === "devspace_goal_start"/);
assert.match(html, /startClaim\.toolName === "devspace_plan_start"/);
assert.match(html, /relayBridge\.callTool\(action\.toolName, action\.arguments\)/);
assert.doesNotMatch(html, /requestClose/,
  "a hidden exact-page relay must not ask ChatGPT to close host UI");
assert.match(html, /retireClaimRelay/);
assert.match(html, /removeEventListener/);
assert.match(html, /window\.openai\?\.toolResponseMetadata/,
  "progress claim relay must consume tool-result metadata when toolOutput is unavailable");
assert.match(html, /devspace\/progressClaim/,
  "progress claim relay must recognize the opaque one-time claim metadata key");
assert.match(html, /devspace\/conversationStartClaim/,
  "the same hidden exact-page relay must recognize Goal/Plan start ownership claims");
assert.match(html, /structured\?\.ok === true && structured\?\.claimed === true/);
assert.match(html, /ui\/notifications\/tool-result/);
assert.match(html, /claimDispatchStarted/);
assert.match(html, /__DEVSPACE_GOAL_RELAY_STATE__/,
  "a Goal start result must leave one persistent exact-Goal relay capability in its existing hidden App frame");
assert.match(html, /devspace_goal_status/);
assert.match(html, /devspace_goal_continuation/);
assert.match(html, /goal\.roundState === "reported" && goal\.continuation\?\.state === "pending"/);
assert.match(html, /relayBridge\.dispatchPublicMessage\(goalRelayGoalId, goalRelayConversationId\)/,
  "only the backend-authorized bridge may submit a public continuation");
assert.doesNotMatch(html, /location\.|parent\.location|composer|prompt-textarea/);

console.log(JSON.stringify({
  ok: true,
  gate: "progress-claim-relay",
  hidden: true,
  authorizedPublicComponentMessages: true,
  noForegroundInput: true,
  oneShotClaim: true,
  persistentGoalRelay: true,
  localRetirement: true,
  hostUiClose: false,
}));
