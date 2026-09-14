import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ClassicConversationAuthorityRegistry,
  sessionFingerprintFromClassicRequest,
} from "./classic-conversation-authority.js";
import {
  ClassicActiveTurnRegistry,
  ClassicMcpCallCorrelator,
  fingerprintMcpToolCall,
} from "./classic-mcp-call-correlation.js";
import { ClassicTurnTransportTracker } from "./classic-turn-transport-observer.js";
import { McpConversationRequestContext } from "./mcp-conversation-request-context.js";
import { requestTraceCorrelationFingerprints } from "./request-trace-correlation.js";
import { sessionCorrelationFingerprintsFromValue } from "./session-correlation.js";

const temp = await mkdtemp(join(tmpdir(), "devspace-direct-tool-correlation-"));
const authorityPath = join(temp, "authority.json");
let now = 10_000;
const activeTurns = new ClassicActiveTurnRegistry({
  now: () => now,
  activeTtlMs: 60 * 60_000,
  postTurnGraceMs: 1_000,
  waitTimeoutMs: 25,
});
const authority = new ClassicConversationAuthorityRegistry({ statePath: authorityPath });
await authority.load();
const requestContext = new McpConversationRequestContext();

function browserTurn({ requestId, runtimeKey, conversationId, session, traceId, datadogTraceId }) {
  const tracker = new ClassicTurnTransportTracker({
    now: () => now,
    onActiveTurn: (event) => activeTurns.noteTurn({ runtimeKey, ...event }),
  });
  tracker.noteRequest({
    requestId,
    request: {
      url: "https://chatgpt.com/backend-api/f/conversation",
      method: "POST",
      postData: JSON.stringify({
        conversation_id: conversationId,
        model: "gpt-test",
        local_function_names: ["local.continue_in_work"],
        messages: [],
      }),
      headers: {
        "x-openai-session": session,
        traceparent: `00-${traceId}-1111111111111111-01`,
      },
    },
  });
  tracker.noteExtraInfo({
    requestId,
    headers: {
      "x-openai-session": session,
      "x-datadog-trace-id": datadogTraceId,
    },
  });
  tracker.noteResponse({
    requestId,
    response: { url: "https://chatgpt.com/backend-api/f/conversation", status: 200 },
  });
  tracker.noteFinished({ requestId });
  return tracker;
}

const traceA = "0123456789abcdef0000000000000065";
const traceB = "0123456789abcdef0000000000000066";
const browserSessionA = "browser-session-a";
const browserSessionB = "browser-session-b";
const sharedDirectSession = "shared-host-direct-session";
const sharedDirectFingerprint = sessionFingerprintFromClassicRequest({
  headers: { "x-openai-session": sharedDirectSession },
});

browserTurn({
  requestId: "turn-a",
  runtimeKey: "main-01",
  conversationId: "conversation-direct-a",
  session: browserSessionA,
  traceId: traceA,
  datadogTraceId: "101",
});
now += 5;
browserTurn({
  requestId: "turn-b",
  runtimeKey: "main-02",
  conversationId: "conversation-direct-b",
  session: browserSessionB,
  traceId: traceB,
  datadogTraceId: "102",
});

const traceKeysA = requestTraceCorrelationFingerprints({
  traceparent: `00-${traceA}-2222222222222222-01`,
  "x-datadog-trace-id": "101",
});
const traceKeysB = requestTraceCorrelationFingerprints({
  traceparent: `00-${traceB}-3333333333333333-01`,
  "x-datadog-trace-id": "102",
});

const browserSessionFingerprintA = sessionFingerprintFromClassicRequest({
  headers: { "x-openai-session": browserSessionA },
});
const activeSessionAuthorityA = activeTurns.resolveGatewayCall({
  toolName: "devspace_progress_report",
  sessionFingerprintHint: browserSessionFingerprintA,
  sessionCorrelationFingerprintsHint: sessionCorrelationFingerprintsFromValue(browserSessionA),
});
assert.equal(activeSessionAuthorityA?.conversationId, "conversation-direct-a",
  "a unique request-owned session alias may resolve only its currently active browser turn");
assert.equal(activeSessionAuthorityA?.runtimeKey, "main-01");
assert.match(activeSessionAuthorityA?.source || "", /session-alias-correlation$/);

for (const toolName of ["blender_runtime", "blender_mcp", "devspace_progress_report"]) {
  const identity = activeTurns.resolveGatewayCall({
    toolName,
    traceCorrelationFingerprints: traceKeysA,
    sessionFingerprintHint: sharedDirectFingerprint,
  });
  assert.equal(identity?.conversationId, "conversation-direct-a", `${toolName} must resolve only through the exact request trace`);
  assert.equal(identity?.runtimeKey, "main-01");
  assert.match(identity?.source || "", /request-trace-correlation$/);
}

assert.equal(activeTurns.resolveGatewayCall({
  toolName: "devspace_progress_report",
  sessionFingerprintHint: sharedDirectFingerprint,
}), null, "a bare direct MCP session must never select a conversation");
assert.equal(activeTurns.resolveGatewayCall({
  toolName: "devspace_progress_report",
  traceCorrelationFingerprints: ["f".repeat(64)],
  sessionFingerprintHint: sharedDirectFingerprint,
}), null, "an unrelated request trace must fail closed");

const callCorrelation = new ClassicMcpCallCorrelator({
  now: () => now,
  ttlMs: 1_000,
  maxSkewMs: 100,
  waitTimeoutMs: 25,
});
const progressCallA = fingerprintMcpToolCall("tools/call", {
  name: "devspace_progress_report",
  arguments: { kind: "milestone", message: "conversation A exact report" },
});
const progressCallB = fingerprintMcpToolCall("tools/call", {
  name: "devspace_progress_report",
  arguments: { kind: "milestone", message: "conversation B exact report" },
});
callCorrelation.noteNative({
  callFingerprint: progressCallA,
  conversationId: "conversation-direct-a",
  runtimeKey: "main-01",
  toolName: "devspace_progress_report",
  source: "classic-websocket-tool-invocation",
  observedAtMs: now,
});
const correlatedA = callCorrelation.noteGateway({
  callFingerprint: progressCallA,
  sessionFingerprint: sharedDirectFingerprint,
  gatewayRequestId: "gateway-request-a",
  toolName: "devspace_progress_report",
  observedAtMs: now + 5,
});
assert.equal(correlatedA?.conversationId, "conversation-direct-a");
assert.equal(correlatedA?.runtimeKey, "main-01");
assert.equal(correlatedA?.source, "classic-websocket-tool-invocation-correlation");
assert.equal(correlatedA?.gatewayRequestId, "gateway-request-a");

callCorrelation.noteNative({
  callFingerprint: progressCallB,
  conversationId: "conversation-direct-b",
  runtimeKey: "main-02",
  toolName: "devspace_progress_report",
  source: "classic-websocket-tool-invocation",
  observedAtMs: now + 10,
});
const correlatedB = callCorrelation.noteGateway({
  callFingerprint: progressCallB,
  sessionFingerprint: sharedDirectFingerprint,
  gatewayRequestId: "gateway-request-b",
  toolName: "devspace_progress_report",
  observedAtMs: now + 15,
});
assert.equal(correlatedB?.conversationId, "conversation-direct-b",
  "two conversations may share one host session without sharing progress ownership");
assert.equal(correlatedB?.runtimeKey, "main-02");

callCorrelation.noteGateway({
  callFingerprint: progressCallA,
  sessionFingerprint: sharedDirectFingerprint,
  gatewayRequestId: "gateway-request-a-later",
  toolName: "devspace_progress_report",
  observedAtMs: now + 20,
});
assert.equal(await callCorrelation.waitForIdentity({
  callFingerprint: progressCallA,
  sessionFingerprint: sharedDirectFingerprint,
  gatewayRequestId: "gateway-request-a-later",
  timeoutMs: 25,
}), null, "a later identical request must not reuse an earlier resolved conversation owner");

const ambiguous = new ClassicMcpCallCorrelator({ now: () => now, maxSkewMs: 100 });
const sameCall = fingerprintMcpToolCall("tools/call", {
  name: "devspace_progress_report",
  arguments: { kind: "progress", message: "identical simultaneous report" },
});
for (const [conversationId, runtimeKey] of [
  ["conversation-ambiguous-a", "main-01"],
  ["conversation-ambiguous-b", "main-02"],
]) {
  ambiguous.noteNative({
    callFingerprint: sameCall,
    conversationId,
    runtimeKey,
    toolName: "devspace_progress_report",
    source: "classic-websocket-tool-invocation",
    observedAtMs: now,
  });
}
assert.equal(ambiguous.noteGateway({
  callFingerprint: sameCall,
  sessionFingerprint: sharedDirectFingerprint,
  gatewayRequestId: "gateway-ambiguous",
  toolName: "devspace_progress_report",
  observedAtMs: now,
}), null, "the same canonical invocation visible in two conversations must fail closed");
assert.equal(ambiguous.diagnostics().ambiguousMatches > 0, true);
assert.equal(typeof authority.observeVerifiedDirectSession, "undefined",
  "the retired durable direct-session writer must not remain available");
assert.equal(typeof authority.resolveVerifiedDirectSession, "undefined");

await requestContext.run({
  progressAuthority: {
    conversationId: correlatedA.conversationId,
    runtimeKey: correlatedA.runtimeKey,
    callFingerprint: correlatedA.callFingerprint,
    pageVerified: true,
    authorityDomain: "progress",
    ephemeral: true,
  },
  sessionFingerprint: sharedDirectFingerprint,
}, async () => {
  assert.equal(requestContext.current()?.progressAuthority?.conversationId, "conversation-direct-a");
  assert.equal(requestContext.current()?.capabilityAuthority, null);
});
assert.equal(requestContext.current(), null, "request authority must not leak after the MCP request completes");

const unmatched = await callCorrelation.waitForIdentity({
  callFingerprint: "f".repeat(64),
  sessionFingerprint: sharedDirectFingerprint,
  timeoutMs: 25,
});
assert.equal(unmatched, null);
assert.equal(callCorrelation.diagnostics().waiters, 0, "unresolved exact invocation must leave no zombie waiter");
assert.equal(callCorrelation.diagnostics().timedOutWaiters > 0, true);

assert.equal(activeTurns.completeConversation("conversation-direct-a"), 1);
assert.equal(activeTurns.resolveGatewayCall({
  toolName: "blender_runtime",
  traceCorrelationFingerprints: traceKeysA,
}), null);
assert.equal(activeTurns.resolveGatewayCall({
  toolName: "blender_runtime",
  traceCorrelationFingerprints: traceKeysB,
})?.conversationId, "conversation-direct-b", "completion cleanup must stay conversation-scoped");

const browserAuthoritySecret = "browser-authority-secret";
await authority.observeNativeTurn({
  sessionFingerprint: sessionFingerprintFromClassicRequest({
    headers: { "x-openai-session": browserAuthoritySecret },
  }),
  conversationId: "conversation-native-diagnostic",
  runtimeKey: "main-04",
  observedAt: new Date(now).toISOString(),
  authoritativeCurrent: true,
});
const persisted = await readFile(authorityPath, "utf8");
for (const rawSecret of [traceA, traceB, "101", "102", browserSessionA, browserSessionB, sharedDirectSession, browserAuthoritySecret]) {
  assert.equal(persisted.includes(rawSecret), false, `authority state must not persist raw correlation secret ${rawSecret}`);
}

await rm(temp, { recursive: true, force: true });
console.log(JSON.stringify({
  ok: true,
  gate: "direct-tool-conversation-correlation",
  exactDistributedTraceAuthority: true,
  exactWebSocketInvocationAuthority: true,
  boundedActiveSessionAuthority: true,
  durableDirectSessionAuthorityRetired: true,
  sharedHostSessionConversationIsolation: true,
  requestContextIsolation: true,
  ambiguityFailsClosed: true,
  boundedWaiterCleanup: true,
  normalCompletionCleanup: true,
  rawCorrelationSecretsPersisted: false,
}));
