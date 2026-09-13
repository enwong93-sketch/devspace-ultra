import assert from "node:assert/strict";
import {
  ClassicActiveTurnRegistry,
  ClassicMcpCallCorrelator,
  fingerprintMcpToolCall,
  isNativeCallMcpRequest,
  parseNativeCallMcpRequest,
} from "./classic-mcp-call-correlation.js";
import { sessionCorrelationFingerprintsFromValue } from "./session-correlation.js";

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
  waitTimeoutMs: 10000,
  timedOutWaiters: 0,
  cancelledWaiters: 0,
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
assert.notEqual(repeatedWaitA, repeatedWaitB, "each MCP request must own a cancellable waiter instead of sharing an unabortable promise");
assert.equal(boundedWaiters.diagnostics().waiters, 2);
now += 2_000;
boundedWaiters.prune();
assert.equal(await repeatedWaitA, null, "passive correlation cache expiry may release stale observers without terminating user work");
assert.equal(await repeatedWaitB, null, "every request-scoped waiter must be released independently");
assert.equal(boundedWaiters.diagnostics().waiters, 0);

now += 60_000;
concurrent.prune();
assert.equal(concurrent.diagnostics().nativePending, 0);
assert.equal(concurrent.diagnostics().gatewayPending, 0);

const activeTurns = new ClassicActiveTurnRegistry({
  now: () => now,
  activeTtlMs: 60_000,
  maxActive: 8,
  maxWaiters: 8,
});
activeTurns.noteTurn({
  kind: "started",
  requestId: "turn-main-01",
  runtimeKey: "main-01",
  conversationId: "conversation-main-01",
  localFunctionNames: ["blender_runtime", "blender_mcp"],
  turnTraceFingerprint: "1".repeat(64),
  sessionFingerprint: "a".repeat(64),
  observedAtMs: now,
});
activeTurns.noteTurn({
  kind: "started",
  requestId: "turn-main-02",
  runtimeKey: "main-02",
  conversationId: "conversation-main-02",
  localFunctionNames: ["blender_runtime", "devspace_progress_report"],
  turnTraceFingerprint: "2".repeat(64),
  sessionFingerprint: "b".repeat(64),
  observedAtMs: now + 1,
});
const tracedTurn = activeTurns.resolveGatewayCall({
  toolName: "blender_runtime",
  turnTraceFingerprint: "1".repeat(64),
});
assert.equal(tracedTurn?.conversationId, "conversation-main-01");
assert.equal(tracedTurn?.runtimeKey, "main-01");
assert.equal(tracedTurn?.source, "classic-active-turn-trace-correlation");
assert.equal(
  activeTurns.resolveGatewayCall({ toolName: "blender_runtime" }),
  null,
  "two active conversations exposing the same direct tool must fail closed when no trace distinguishes them",
);
assert.equal(activeTurns.diagnostics().ambiguousMatches, 0, "unscoped calls fail before any cross-runtime candidate comparison");
assert.equal(
  activeTurns.resolveGatewayCall({ toolName: "blender_mcp" }),
  null,
  "even a unique tool name must not become cross-window authority without an exact request trace",
);
const uniqueTurn = activeTurns.resolveGatewayCall({ toolName: "blender_mcp", runtimeKeyHint: "main-01" });
assert.equal(uniqueTurn, null, "Runtime is only a page locator and must never become conversation authority");

assert.equal(activeTurns.completeConversation("conversation-main-01"), 1);
assert.equal(
  activeTurns.resolveGatewayCall({ toolName: "blender_mcp", runtimeKeyHint: "main-01" }),
  null,
  "normal completion must revoke every active-turn authority entry for that exact conversation",
);
assert.equal(
  activeTurns.resolveGatewayCall({
    toolName: "devspace_progress_report",
    turnTraceFingerprint: "2".repeat(64),
  })?.conversationId,
  "conversation-main-02",
  "revoking one conversation must not remove another conversation's exact trace authority",
);
assert.equal(activeTurns.completeConversation("conversation-not-present"), 0);

const sessionScopedProgress = activeTurns.resolveGatewayCall({
  toolName: "devspace_progress_report",
  sessionFingerprintHint: "b".repeat(64),
});
assert.equal(sessionScopedProgress, null, "a host direct-session fingerprint must not own progress narration");

const dynamicallyDisclosedSessionTool = new ClassicActiveTurnRegistry({ now: () => now });
dynamicallyDisclosedSessionTool.noteTurn({
  kind: "started",
  requestId: "session-dynamic-tool",
  runtimeKey: "main-02",
  conversationId: "conversation-session-dynamic-tool",
  localFunctionNames: ["some_other_tool"],
  sessionFingerprint: "c".repeat(64),
  observedAtMs: now,
});
const dynamicProgressByExactSession = dynamicallyDisclosedSessionTool.resolveGatewayCall({
  toolName: "devspace_progress_report",
  sessionFingerprintHint: "c".repeat(64),
});
assert.equal(dynamicProgressByExactSession, null,
  "dynamic tool disclosure still requires exact trace or page-local invocation evidence");
assert.equal(
  activeTurns.resolveGatewayCall({
    toolName: "devspace_progress_report",
    sessionFingerprintHint: "c".repeat(64),
  }),
  null,
  "a request-owned MCP session fingerprint may not match another conversation",
);

const distributedTraceTurns = new ClassicActiveTurnRegistry({
  now: () => now,
  activeTtlMs: 60_000,
  postTurnGraceMs: 1_000,
});
distributedTraceTurns.noteTurn({
  kind: "started",
  requestId: "trace-left",
  runtimeKey: "main-01",
  conversationId: "conversation-trace-left",
  localFunctionNames: ["local.continue_in_work"],
  sessionFingerprint: "1".repeat(64),
  traceCorrelationFingerprints: ["e".repeat(64)],
  observedAtMs: now,
});
distributedTraceTurns.noteTurn({
  kind: "started",
  requestId: "trace-right",
  runtimeKey: "main-02",
  conversationId: "conversation-trace-right",
  localFunctionNames: ["local.continue_in_work"],
  sessionFingerprint: "2".repeat(64),
  traceCorrelationFingerprints: ["f".repeat(64)],
  observedAtMs: now + 1,
});
const requestTraceMatch = distributedTraceTurns.resolveGatewayCall({
  toolName: "devspace_progress_report",
  traceCorrelationFingerprints: ["e".repeat(64)],
  sessionFingerprintHint: "9".repeat(64),
});
assert.equal(requestTraceMatch?.conversationId, "conversation-trace-left");
assert.equal(requestTraceMatch?.source, "classic-active-turn-request-trace-correlation");
distributedTraceTurns.noteTurn({
  kind: "finished",
  transportOnly: true,
  requestId: "trace-left",
  runtimeKey: "main-01",
  conversationId: "conversation-trace-left",
  observedAtMs: now + 10,
});
now += 2_000;
assert.equal(
  distributedTraceTurns.resolveGatewayCall({
    toolName: "devspace_progress_report",
    traceCorrelationFingerprints: ["e".repeat(64)],
  })?.conversationId,
  "conversation-trace-left",
  "an exact distributed trace remains valid after the upload transport finishes",
);
assert.equal(
  distributedTraceTurns.resolveGatewayCall({
    toolName: "devspace_progress_report",
    runtimeKeyHint: "main-01",
  }),
  null,
  "legacy runtime/tool fallback must expire shortly after transport finish",
);
assert.equal(distributedTraceTurns.diagnostics().transportFinishedTurns, 1);
assert.equal(distributedTraceTurns.diagnostics().turnsWithRequestTrace, 2);

const ambiguousDistributedTrace = new ClassicActiveTurnRegistry({ now: () => now });
for (const [runtimeKey, conversationId, requestId] of [
  ["main-01", "conversation-trace-a", "trace-a"],
  ["main-02", "conversation-trace-b", "trace-b"],
]) {
  ambiguousDistributedTrace.noteTurn({
    kind: "started",
    runtimeKey,
    conversationId,
    requestId,
    localFunctionNames: ["devspace_progress_report"],
    traceCorrelationFingerprints: ["a".repeat(64)],
    observedAtMs: now,
  });
}
assert.equal(
  ambiguousDistributedTrace.resolveGatewayCall({
    toolName: "devspace_progress_report",
    traceCorrelationFingerprints: ["a".repeat(64)],
  }),
  null,
  "a distributed trace observed in two conversations must fail closed",
);
assert.equal(ambiguousDistributedTrace.diagnostics().ambiguousMatches > 0, true);

const wrappedSessionTurns = new ClassicActiveTurnRegistry({
  now: () => now,
  activeTtlMs: 60_000,
  postTurnGraceMs: 1_000,
});
const browserSessionId = "9b5fcb28-405f-4f5e-8ee7-c6c23d509a4a";
const directSessionDescriptor = JSON.stringify({ id: browserSessionId, issued_at: now });
wrappedSessionTurns.noteTurn({
  kind: "started",
  requestId: "wrapped-session-turn",
  runtimeKey: "main-02",
  conversationId: "conversation-wrapped-session",
  localFunctionNames: ["local.continue_in_work"],
  sessionCorrelationFingerprints: sessionCorrelationFingerprintsFromValue(browserSessionId),
  observedAtMs: now,
});
wrappedSessionTurns.noteTurn({
  kind: "finished",
  transportOnly: true,
  requestId: "wrapped-session-turn",
  runtimeKey: "main-02",
  conversationId: "conversation-wrapped-session",
  observedAtMs: now + 10,
});
const wrappedSessionMatch = wrappedSessionTurns.resolveGatewayCall({
  toolName: "devspace_progress_report",
  // The direct request may expose a distributed trace that the browser upload
  // does not carry. A non-matching trace must not suppress the exact session
  // alias shared by the browser UUID and the wrapped MCP descriptor.
  traceCorrelationFingerprints: ["9".repeat(64)],
  sessionCorrelationFingerprintsHint: sessionCorrelationFingerprintsFromValue(directSessionDescriptor),
  sessionFingerprintHint: "8".repeat(64),
});
assert.equal(wrappedSessionMatch, null,
  "wrapped session aliases are transport metadata and cannot select a conversation");
assert.equal(wrappedSessionTurns.diagnostics().turnsWithSessionAliases, 1);

const ambiguousSessionAliases = new ClassicActiveTurnRegistry({ now: () => now });
for (const [runtimeKey, conversationId, requestId] of [
  ["main-01", "conversation-session-alias-left", "session-alias-left"],
  ["main-02", "conversation-session-alias-right", "session-alias-right"],
]) {
  ambiguousSessionAliases.noteTurn({
    kind: "started",
    runtimeKey,
    conversationId,
    requestId,
    localFunctionNames: ["local.continue_in_work"],
    sessionCorrelationFingerprints: sessionCorrelationFingerprintsFromValue(browserSessionId),
    observedAtMs: now,
  });
}
assert.equal(
  ambiguousSessionAliases.resolveGatewayCall({
    toolName: "devspace_progress_report",
    sessionCorrelationFingerprintsHint: sessionCorrelationFingerprintsFromValue(directSessionDescriptor),
  }),
  null,
  "session aliases must fail closed even before comparing conversation candidates",
);
assert.equal(ambiguousSessionAliases.diagnostics().ambiguousMatches, 0);

const reusedSessionTurns = new ClassicActiveTurnRegistry({ now: () => now });
for (const [runtimeKey, conversationId, requestId, offset] of [
  ["main-01", "conversation-session-left", "session-left", 0],
  ["main-03", "conversation-session-right", "session-right", 1],
]) {
  reusedSessionTurns.noteTurn({
    kind: "started",
    requestId,
    runtimeKey,
    conversationId,
    localFunctionNames: ["some_other_tool"],
    sessionFingerprint: "d".repeat(64),
    observedAtMs: now + offset,
  });
}
assert.equal(
  reusedSessionTurns.resolveGatewayCall({
    toolName: "devspace_progress_report",
    sessionFingerprintHint: "d".repeat(64),
  }),
  null,
  "one session fingerprint observed in two conversations must fail closed",
);

const deferredTraceTurns = new ClassicActiveTurnRegistry({
  now: () => now,
  activeTtlMs: 60_000,
  postTurnGraceMs: 1_000,
});
deferredTraceTurns.noteTurn({
  kind: "started",
  requestId: "turn-deferred-trace",
  runtimeKey: "main-01",
  conversationId: "conversation-deferred-trace",
  localFunctionNames: ["local.continue_in_work"],
  turnTraceFingerprint: "3".repeat(64),
  observedAtMs: now,
});
deferredTraceTurns.noteTurn({
  kind: "finished",
  requestId: "turn-deferred-trace",
  runtimeKey: "main-01",
  conversationId: "conversation-deferred-trace",
  observedAtMs: now + 10,
});
const dynamicallyDisclosedTool = deferredTraceTurns.resolveGatewayCall({
  toolName: "devspace_progress_report",
  turnTraceFingerprint: "3".repeat(64),
});
assert.equal(
  dynamicallyDisclosedTool?.conversationId,
  "conversation-deferred-trace",
  "an exact hashed turn trace must authorize a tool disclosed after the initial local_function_names snapshot",
);
assert.equal(dynamicallyDisclosedTool?.source, "classic-active-turn-post-finish-trace-correlation");
assert.equal(
  deferredTraceTurns.resolveGatewayCall({
    toolName: "devspace_progress_report",
    turnTraceFingerprint: "4".repeat(64),
  }),
  null,
  "a mismatched trace must fail closed even when only one deferred turn is recent",
);
assert.equal(deferredTraceTurns.diagnostics().turnsWithTrace, 1);
assert.equal(deferredTraceTurns.diagnostics().placeholderOnlyTurns, 1);

assert.equal(
  deferredTraceTurns.resolveGatewayCall({ toolName: "devspace_progress_report" }),
  null,
  "a deferred placeholder must never claim an unscoped MCP call merely because it is the only recent Main turn",
);
const runtimeScopedDeferredTool = deferredTraceTurns.resolveGatewayCall({
  toolName: "devspace_progress_report",
  runtimeKeyHint: "main-01",
});
assert.equal(runtimeScopedDeferredTool, null,
  "Runtime-scoped deferred placeholders must not become conversation authority");

const deferredPlaceholderTurns = new ClassicActiveTurnRegistry({
  now: () => now,
  activeTtlMs: 60_000,
  postTurnGraceMs: 1_000,
});
deferredPlaceholderTurns.noteTurn({
  kind: "started",
  requestId: "turn-deferred-placeholder",
  runtimeKey: "main-01",
  conversationId: "conversation-deferred-placeholder",
  localFunctionNames: ["local.continue_in_work"],
  observedAtMs: now,
});
deferredPlaceholderTurns.noteTurn({
  kind: "finished",
  requestId: "turn-deferred-placeholder",
  runtimeKey: "main-01",
  conversationId: "conversation-deferred-placeholder",
  observedAtMs: now + 10,
});
const dynamicallyDisclosedWithoutTrace = deferredPlaceholderTurns.resolveGatewayCall({
  toolName: "devspace_progress_report",
});
assert.equal(
  dynamicallyDisclosedWithoutTrace,
  null,
  "a deferred tool call without trace or request-owned runtime scope must never claim another Main",
);
const runtimeScopedWithoutTrace = deferredPlaceholderTurns.resolveGatewayCall({
  toolName: "devspace_progress_report",
  runtimeKeyHint: "main-01",
});
assert.equal(runtimeScopedWithoutTrace, null);

const ambiguousDeferredPlaceholders = new ClassicActiveTurnRegistry({
  now: () => now,
  activeTtlMs: 60_000,
  postTurnGraceMs: 1_000,
});
for (const [runtimeKey, conversationId, requestId, offset] of [
  ["main-01", "conversation-placeholder-left", "placeholder-left", 0],
  ["main-02", "conversation-placeholder-right", "placeholder-right", 1],
]) {
  ambiguousDeferredPlaceholders.noteTurn({
    kind: "started",
    requestId,
    runtimeKey,
    conversationId,
    localFunctionNames: ["local.continue_in_work"],
    observedAtMs: now + offset,
  });
  ambiguousDeferredPlaceholders.noteTurn({
    kind: "finished",
    requestId,
    runtimeKey,
    conversationId,
    observedAtMs: now + 10 + offset,
  });
}
assert.equal(
  ambiguousDeferredPlaceholders.resolveGatewayCall({ toolName: "devspace_progress_report" }),
  null,
  "two deferred placeholder conversations must fail closed when neither trace nor offered tool name distinguishes them",
);
assert.equal(
  ambiguousDeferredPlaceholders.resolveGatewayCall({
    toolName: "devspace_progress_report",
    runtimeKeyHint: "main-02",
  }),
  null,
  "Runtime-scoped deferred correlation is retired",
);

const deferredTurns = new ClassicActiveTurnRegistry({
  now: () => now,
  activeTtlMs: 60_000,
  postTurnGraceMs: 1_000,
});
const deferredIdentity = deferredTurns.waitForIdentity({
  toolName: "devspace_progress_report",
  runtimeKeyHint: "main-01",
});
deferredTurns.noteTurn({
  kind: "started",
  requestId: "turn-progress",
  runtimeKey: "main-01",
  conversationId: "conversation-main-01",
  localFunctionNames: ["devspace_progress_report"],
  observedAtMs: now,
});
assert.equal(await deferredIdentity, null,
  "a runtime-only waiter must fail closed immediately instead of waiting for another conversation");
deferredTurns.noteTurn({
  kind: "finished",
  requestId: "turn-progress",
  runtimeKey: "main-01",
  conversationId: "conversation-main-01",
  observedAtMs: now + 10,
});
now += 20;
const delayedAfterFinished = deferredTurns.resolveGatewayCall({
  toolName: "devspace_progress_report",
  runtimeKeyHint: "main-01",
});
assert.equal(delayedAfterFinished, null,
  "server-side calls after transport finish still require an exact trace or page-local invocation");
assert.equal(deferredTurns.diagnostics().activeTurns, 0);
assert.equal(deferredTurns.diagnostics().postTurnTurns, 1);

const completedAmbiguity = new ClassicActiveTurnRegistry({
  now: () => now,
  activeTtlMs: 60_000,
  postTurnGraceMs: 1_000,
});
for (const [runtimeKey, conversationId, requestId, offset] of [
  ["main-01", "conversation-completed-left", "completed-left", 0],
  ["main-02", "conversation-completed-right", "completed-right", 1],
]) {
  completedAmbiguity.noteTurn({
    kind: "started",
    requestId,
    runtimeKey,
    conversationId,
    localFunctionNames: ["devspace_progress_report"],
    observedAtMs: now + offset,
  });
  completedAmbiguity.noteTurn({
    kind: "finished",
    requestId,
    runtimeKey,
    conversationId,
    observedAtMs: now + 10 + offset,
  });
}
assert.equal(
  completedAmbiguity.resolveGatewayCall({ toolName: "devspace_progress_report" }),
  null,
  "two recently completed conversations offering the same tool must remain fail-closed",
);
assert.equal(
  completedAmbiguity.resolveGatewayCall({
    toolName: "devspace_progress_report",
    runtimeKeyHint: "main-01",
  }),
  null,
);

const failedTurn = new ClassicActiveTurnRegistry({ now: () => now, postTurnGraceMs: 1_000 });
failedTurn.noteTurn({
  kind: "started",
  requestId: "failed-turn",
  runtimeKey: "main-01",
  conversationId: "conversation-failed",
  localFunctionNames: ["devspace_progress_report"],
  observedAtMs: now,
});
failedTurn.noteTurn({
  kind: "failed",
  requestId: "failed-turn",
  runtimeKey: "main-01",
  conversationId: "conversation-failed",
  observedAtMs: now + 1,
});
assert.equal(failedTurn.resolveGatewayCall({ toolName: "devspace_progress_report", runtimeKeyHint: "main-01" }), null);

now += 1_100;
deferredTurns.prune();
assert.equal(
  deferredTurns.resolveGatewayCall({ toolName: "devspace_progress_report", runtimeKeyHint: "main-01" }),
  null,
  "completed-turn authority must expire after the bounded post-turn grace",
);

console.log(JSON.stringify({
  ok: true,
  gate: "classic-mcp-call-correlation",
  nativeCallMcpConversation: true,
  canonicalArgumentHash: true,
  rawArgumentsPersisted: false,
  rawSessionPersisted: false,
  mutualNearestConcurrentMatch: true,
  trueTieFailsClosed: true,
  requestScopedBoundedWaiters: true,
  boundedTemporalJoin: true,
  activeTurnTraceMatch: true,
  runtimeOnlyAuthorityRetired: true,
  sessionOnlyAuthorityRetired: true,
  deferredToolExactTraceMatch: true,
  deferredToolWrongTraceFailsClosed: true,
  deferredPlaceholderAuthorityRetired: true,
  activeTurnAmbiguityFailsClosed: true,
  delayedPostFinishRequiresExactEvidence: true,
  completedTurnAmbiguityFailsClosed: true,
  failedTurnRevokesCorrelation: true,
  completedConversationRevokesAllAuthority: true,
  postTurnGraceExpires: true,
}));
