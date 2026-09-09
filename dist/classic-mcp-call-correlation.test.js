import assert from "node:assert/strict";
import {
  ClassicMcpCallCorrelator,
  fingerprintMcpToolCall,
  isNativeCallMcpRequest,
  parseNativeCallMcpRequest,
} from "./classic-mcp-call-correlation.js";

const first = fingerprintMcpToolCall("tools/call", {
  name: "devspace_goal_status",
  arguments: { goalId: "goal-a", nested: { b: 2, a: 1 } },
});
const reordered = fingerprintMcpToolCall("tools/call", {
  arguments: { nested: { a: 1, b: 2 }, goalId: "goal-a" },
  name: "devspace_goal_status",
});
assert.match(first, /^[a-f0-9]{64}$/);
assert.equal(first, reordered, "canonical object ordering must not change the correlation fingerprint");
assert.notEqual(first, fingerprintMcpToolCall("tools/call", { name: "devspace_goal_status", arguments: { goalId: "goal-b" } }));
assert.equal(fingerprintMcpToolCall("resources/read", { uri: "x" }), null);

assert.equal(isNativeCallMcpRequest({ url: "https://chatgpt.com/backend-api/ecosystem/call_mcp", method: "POST" }), true);
assert.equal(isNativeCallMcpRequest({ url: "https://chatgpt.com/backend-api/ecosystem/call_mcp", method: "GET" }), false);

const parsed = parseNativeCallMcpRequest({
  url: "https://chatgpt.com/backend-api/ecosystem/call_mcp",
  method: "POST",
  headers: { "oai-session-id": "native-session-a" },
  postData: JSON.stringify({
    app_uri: "https://example.invalid/mcp",
    method: "tools/call",
    params: { name: "devspace_goal_status", arguments: { goalId: "goal-a" } },
    conversation_id: "conversation-native-a",
    message_id: "message-a",
  }),
});
assert.equal(parsed.conversationId, "conversation-native-a");
assert.match(parsed.sessionFingerprint, /^[a-f0-9]{64}$/);
assert.equal(parsed.toolName, "devspace_goal_status");
assert.equal(parsed.messageIdPresent, true);
assert.equal(JSON.stringify(parsed).includes("goal-a"), false, "raw tool arguments must not leave the parser");
assert.equal(JSON.stringify(parsed).includes("native-session-a"), false, "raw native session ids must never leave the parser");
assert.equal(parseNativeCallMcpRequest({ url: "https://chatgpt.com/backend-api/f/conversation", method: "POST", postData: "{}" }), null);

let now = 1_000;
const correlator = new ClassicMcpCallCorrelator({ now: () => now, maxSkewMs: 2_000, ttlMs: 10_000, maxPending: 8 });
const native = correlator.noteNative({
  callFingerprint: first,
  conversationId: "conversation-native-a",
  runtimeKey: "main-02",
  toolName: "devspace_goal_status",
  observedAtMs: now,
});
assert.equal(native, null);
now += 120;
const identity = correlator.noteGateway({
  callFingerprint: first,
  sessionFingerprint: "a".repeat(64),
  toolName: "devspace_goal_status",
  observedAtMs: now,
});
assert.equal(identity.conversationId, "conversation-native-a");
assert.equal(identity.sessionFingerprint, "a".repeat(64));
assert.equal(identity.runtimeKey, "main-02");
assert.equal(identity.skewMs, 120);
assert.equal(identity.source, "classic-native-call-mcp-correlation");
assert.equal(JSON.stringify(identity).includes("goal-a"), false);
assert.deepEqual(correlator.diagnostics(), {
  nativePending: 0,
  gatewayPending: 0,
  recentResolved: 1,
  waiters: 0,
  ambiguousMatches: 0,
  ttlMs: 10000,
  maxPending: 8,
  maxSkewMs: 2000,
  rawArgumentsPersisted: false,
  rawSessionPersisted: false,
});

const future = fingerprintMcpToolCall("tools/call", { name: "read", arguments: { path: "a" } });
const waiting = correlator.waitForIdentity({ callFingerprint: future, sessionFingerprint: "b".repeat(64), timeoutMs: 500 });
now += 10;
correlator.noteGateway({ callFingerprint: future, sessionFingerprint: "b".repeat(64), toolName: "read", observedAtMs: now });
now += 10;
correlator.noteNative({ callFingerprint: future, conversationId: "conversation-native-b", runtimeKey: "main-01", toolName: "read", observedAtMs: now });
assert.equal((await waiting).conversationId, "conversation-native-b");

const concurrent = new ClassicMcpCallCorrelator({ now: () => now, maxSkewMs: 5_000 });
concurrent.noteNative({ callFingerprint: first, conversationId: "conversation-one", runtimeKey: "main-01", observedAtMs: now });
concurrent.noteNative({ callFingerprint: first, conversationId: "conversation-two", runtimeKey: "main-02", observedAtMs: now + 1_000 });
const nearest = concurrent.noteGateway({ callFingerprint: first, sessionFingerprint: "c".repeat(64), observedAtMs: now + 1_050 });
assert.equal(nearest?.conversationId, "conversation-two", "concurrent identical calls must use a unique mutual-nearest temporal match instead of rejecting every candidate");

const trulyAmbiguous = new ClassicMcpCallCorrelator({ now: () => now, maxSkewMs: 5_000 });
trulyAmbiguous.noteNative({ callFingerprint: first, conversationId: "conversation-left", runtimeKey: "main-01", observedAtMs: now });
trulyAmbiguous.noteNative({ callFingerprint: first, conversationId: "conversation-right", runtimeKey: "main-02", observedAtMs: now + 2_000 });
const rejected = trulyAmbiguous.noteGateway({ callFingerprint: first, sessionFingerprint: "d".repeat(64), observedAtMs: now + 1_000 });
assert.equal(rejected, null, "a true equal-distance tie must still fail closed");
assert.equal(trulyAmbiguous.diagnostics().ambiguousMatches > 0, true);

const boundedWaiters = new ClassicMcpCallCorrelator({ now: () => now, ttlMs: 1_000, maxPending: 4 });
const repeatedWaitA = boundedWaiters.waitForIdentity({ callFingerprint: future, sessionFingerprint: "e".repeat(64) });
const repeatedWaitB = boundedWaiters.waitForIdentity({ callFingerprint: future, sessionFingerprint: "e".repeat(64) });
assert.equal(repeatedWaitA, repeatedWaitB, "identical session/call correlation waiters must share one promise");
assert.equal(boundedWaiters.diagnostics().waiters, 1);
now += 2_000;
boundedWaiters.prune();
assert.equal(await repeatedWaitA, null, "passive correlation cache expiry may release stale observers without terminating user work");
assert.equal(boundedWaiters.diagnostics().waiters, 0);

now += 60_000;
concurrent.prune();
assert.equal(concurrent.diagnostics().nativePending, 0);
assert.equal(concurrent.diagnostics().gatewayPending, 0);

console.log(JSON.stringify({
  ok: true,
  gate: "classic-mcp-call-correlation",
  nativeCallMcpConversation: true,
  canonicalArgumentHash: true,
  rawArgumentsPersisted: false,
  rawSessionPersisted: false,
  mutualNearestConcurrentMatch: true,
  trueTieFailsClosed: true,
  sharedBoundedWaiters: true,
  boundedTemporalJoin: true,
}));
