import assert from "node:assert/strict";
import {
  ClassicMcpCallCorrelator,
  fingerprintMcpToolCall,
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

const parsed = parseNativeCallMcpRequest({
  url: "https://chatgpt.com/backend-api/ecosystem/call_mcp",
  method: "POST",
  postData: JSON.stringify({
    app_uri: "https://example.invalid/mcp",
    method: "tools/call",
    params: { name: "devspace_goal_status", arguments: { goalId: "goal-a" } },
    conversation_id: "conversation-native-a",
    message_id: "message-a",
  }),
});
assert.equal(parsed.conversationId, "conversation-native-a");
assert.equal(parsed.toolName, "devspace_goal_status");
assert.equal(parsed.messageIdPresent, true);
assert.equal(JSON.stringify(parsed).includes("goal-a"), false, "raw tool arguments must not leave the parser");
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

const ambiguous = new ClassicMcpCallCorrelator({ now: () => now, maxSkewMs: 5_000 });
ambiguous.noteNative({ callFingerprint: first, conversationId: "conversation-one", runtimeKey: "main-01", observedAtMs: now });
ambiguous.noteNative({ callFingerprint: first, conversationId: "conversation-two", runtimeKey: "main-02", observedAtMs: now + 1 });
const rejected = ambiguous.noteGateway({ callFingerprint: first, sessionFingerprint: "c".repeat(64), observedAtMs: now + 2 });
assert.equal(rejected, null, "concurrent identical calls must fail closed rather than choose a conversation");
assert.equal(ambiguous.diagnostics().ambiguousMatches > 0, true);

now += 60_000;
ambiguous.prune();
assert.equal(ambiguous.diagnostics().nativePending, 0);
assert.equal(ambiguous.diagnostics().gatewayPending, 0);

console.log(JSON.stringify({
  ok: true,
  gate: "classic-mcp-call-correlation",
  nativeCallMcpConversation: true,
  canonicalArgumentHash: true,
  rawArgumentsPersisted: false,
  rawSessionPersisted: false,
  concurrentAmbiguityFailsClosed: true,
  boundedTemporalJoin: true,
}));
