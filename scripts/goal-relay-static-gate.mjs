import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../dist/ui/goal-continuation-relay.html", import.meta.url), "utf8");
const claimRelay = await readFile(new URL("../dist/ui/progress-claim-relay.html", import.meta.url), "utf8");
const hostBridge = await readFile(new URL("../dist/goal-host-bridge.js", import.meta.url), "utf8");

assert.match(html, /devspace_goal_continuation/);
assert.match(html, /action:\s*["']dispatch["']/);
assert.match(html, /__DEVSPACE_GOAL_RELAY_STATE__/,
  "a Goal report App must remain a persistent exact-Goal relay across later rounds");
assert.match(html, /relayBridge\.callTool\("devspace_goal_status"/,
  "the persistent Goal relay must refresh current backend state rather than trust historical tool output");
assert.match(html, /relayBridge\.callTool\("devspace_goal_continuation"/,
  "the persistent Goal relay must delegate pending continuation dispatch to the backend supervisor");
assert.doesNotMatch(html, /sendFollowUpMessage\s*\(/,
  "the App relay must expose host capability for backend discovery but never synthesize a user-visible turn itself");
assert.doesNotMatch(html, /action:\s*["']claim["']/);
assert.doesNotMatch(html, /action:\s*["']ack["']/);
assert.doesNotMatch(html, /action:\s*["']release["']/);
assert.match(html, /openai:set_globals/);
assert.match(html, /ui\/notifications\/tool-result/);
assert.match(html, /goal\?\.status !== ["']active["']/,
  "the relay must refuse to adopt a non-active Goal");
assert.match(html, /goal\.status !== ["']active["'][\s\S]{0,160}stop\(/,
  "the relay must retire after current exact Goal state becomes terminal");
assert.match(html, /roundState === ["']reported["']/);
assert.match(html, /continuation\?\.state === ["']pending["']/);
assert.match(html, /removeEventListener/,
  "hydration listeners must be released after one exact Goal is adopted");
assert.match(html, /document\.body\.replaceChildren\(\)/,
  "a terminal or mismatched Goal relay must release its hidden DOM");
assert.match(html, /goal\.status !== ["']active["'][\s\S]{0,160}stop\(/,
  "the persistent relay must retire only after current exact Goal state becomes terminal");
assert.match(html, /lastRequestedContinuationId !== continuationId/,
  "one persistent frame must request each pending continuation at most once before backend state changes");
assert.doesNotMatch(html, /<button/i);
assert.doesNotMatch(html, /<script[^>]+src=/i);
assert.doesNotMatch(html, /<link[^>]+stylesheet/i);
assert.doesNotMatch(html, /https?:\/\//i);
assert.doesNotMatch(html, /location\.|parent\.location|prompt-textarea|composer/,
  "persistent Goal relay maintenance must not navigate or mutate the visible composer");

assert.match(claimRelay, /__DEVSPACE_GOAL_RELAY_STATE__/,
  "Goal start must retain one persistent exact-Goal relay in the hidden claim App frame");
assert.match(claimRelay, /relayBridge\.callTool\("devspace_goal_status"/,
  "the persistent relay must refresh backend Goal state without synthetic user turns");
assert.match(claimRelay, /relayBridge\.callTool\("devspace_goal_continuation"/,
  "the persistent relay must request backend-owned dispatch only for a pending continuation");
assert.match(claimRelay, /goal\.roundState === "reported" && goal\.continuation\?\.state === "pending"/,
  "working Goal rounds must never trigger hidden dispatch");
assert.doesNotMatch(claimRelay, /sendFollowUpMessage\s*\(/,
  "the App relay must never synthesize the hidden assistant turn itself");
assert.doesNotMatch(claimRelay, /location\.|parent\.location|prompt-textarea|composer/,
  "persistent Goal relay maintenance must not navigate or mutate the visible composer");
assert.match(hostBridge, /relayStatePresent/);
assert.match(hostBridge, /relayGoalId/);
assert.match(hostBridge, /relayConversationId/);
assert.match(hostBridge, /relayHeartbeatAt/);
assert.match(hostBridge, /goalId && candidate\?\.relayStatePresent !== undefined && candidate\?\.goalId !== goalId/,
  "production host dispatch must fail closed on a live relay for another Goal");
assert.match(hostBridge, /findExactConversationRelay\(expectedConversationId, \{ runtimePort, goalId \}\)/,
  "normal Goal continuation must request the exact persistent relay for its own Goal");

console.log(JSON.stringify({
  ok: true,
  gate: "goal-relay-static",
  persistentCheckpointRelay: true,
  persistentStartRelay: true,
  exactGoalMarkerRequired: true,
  syntheticUserMessage: false,
  pageNavigation: false,
}));
