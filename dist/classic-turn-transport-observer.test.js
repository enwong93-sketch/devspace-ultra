import assert from "node:assert/strict";
import { ClassicActiveTurnRegistry } from "./classic-mcp-call-correlation.js";
import { ClassicTurnTransportTracker } from "./classic-turn-transport-observer.js";

let now = 1_000;
const identities = [];
const events = [];
const nativeMcpCalls = [];
const toolInvocations = [];
const activeTurns = [];
const delayedGatewayTurns = new ClassicActiveTurnRegistry({
  now: () => now,
  activeTtlMs: 60_000,
  postTurnGraceMs: 1_000,
});
const tracker = new ClassicTurnTransportTracker({
  now: () => now,
  maxPending: 2,
  pendingTtlMs: 1_000,
  onConversationIdentity: (value) => identities.push(value),
  onTurnTransportEvent: (value) => events.push(value),
  onNativeMcpCall: (value) => nativeMcpCalls.push(value),
  onToolInvocation: (value) => toolInvocations.push(value),
  onActiveTurn: (value) => {
    activeTurns.push(value);
    delayedGatewayTurns.noteTurn({ runtimeKey: "main-01", ...value });
  },
});

tracker.noteRequest({
  requestId: "mcp-native-1",
  request: {
    url: "https://chatgpt.com/backend-api/ecosystem/call_mcp",
    method: "POST",
    postData: JSON.stringify({
      method: "tools/call",
      params: { name: "devspace_goal_status", arguments: { goalId: "goal-a" } },
      conversation_id: "conversation-native-mcp",
      message_id: "message-a",
    }),
    headers: { authorization: "Bearer never-persist" },
  },
});
assert.equal(nativeMcpCalls.length, 1);
assert.equal(nativeMcpCalls[0].conversationId, "conversation-native-mcp");
assert.equal(nativeMcpCalls[0].toolName, "devspace_goal_status");
assert.match(nativeMcpCalls[0].callFingerprint, /^[a-f0-9]{64}$/);
assert.equal(JSON.stringify(nativeMcpCalls).includes("goal-a"), false);
assert.equal(JSON.stringify(nativeMcpCalls).includes("never-persist"), false);
assert.equal(tracker.pendingSize, 0, "native MCP call correlation must not enter turn-delivery pending state");

tracker.noteWebSocketFrame({
  conversationId: "conversation-websocket-tool",
  observedAtMs: now,
  payloadData: JSON.stringify({
    message: {
      id: "assistant-tool-message-a",
      author: { role: "assistant" },
      recipient: "api_tool.call_tool",
      content: {
        content_type: "code",
        text: JSON.stringify({
          path: "/DevSpace Local Gateway/link_6a9c8ea532a481918c0f3a852cdb8bbf/devspace_progress_report",
          args: { kind: "milestone", message: "private exact progress" },
        }),
      },
      metadata: { request_id: "request-secret", working_turn_id: "turn-secret" },
    },
  }),
});
assert.equal(toolInvocations.length, 1);
assert.equal(toolInvocations[0].conversationId, "conversation-websocket-tool");
assert.equal(toolInvocations[0].toolName, "devspace_progress_report");
assert.match(toolInvocations[0].callFingerprint, /^[a-f0-9]{64}$/);
assert.equal(JSON.stringify(toolInvocations).includes("private exact progress"), false);
assert.equal(JSON.stringify(toolInvocations).includes("request-secret"), false);
assert.equal(tracker.noteWebSocketFrame({
  conversationId: "conversation-websocket-tool",
  observedAtMs: now + 1,
  payloadData: JSON.stringify({
    message: {
      id: "assistant-tool-message-a",
      author: { role: "assistant" },
      recipient: "api_tool.call_tool",
      content: {
        content_type: "code",
        text: JSON.stringify({
          path: "/DevSpace Local Gateway/link_6a9c8ea532a481918c0f3a852cdb8bbf/devspace_progress_report",
          args: { kind: "milestone", message: "private exact progress" },
        }),
      },
      metadata: { request_id: "request-secret", working_turn_id: "turn-secret" },
    },
  }),
}).length, 0, "duplicate websocket frames must not create duplicate native correlation events");

tracker.noteRequest({
  requestId: "r1",
  request: {
    url: "https://chatgpt.com/backend-api/f/conversation",
    method: "POST",
    postData: JSON.stringify({
      conversation_id: "conversation-a",
      model: "gpt-test",
      messages: [],
      local_function_names: ["blender_runtime", "blender_mcp", "blender_runtime"],
    }),
    headers: {
      "x-oai-turn-trace-id": "turn-trace-secret-a",
      "x-openai-session": "session-secret-a",
      traceparent: "00-0123456789abcdef000000000000002a-1111111111111111-01",
    },
  },
});
tracker.noteExtraInfo({
  requestId: "r1",
  headers: {
    "x-openai-session": "session-secret-a",
    "x-datadog-trace-id": "42",
  },
});
assert.equal(identities.length, 1);
assert.equal(identities[0].conversationId, "conversation-a");
assert.match(identities[0].sessionFingerprint, /^[a-f0-9]{64}$/);
assert.equal(JSON.stringify(identities).includes("session-secret-a"), false, "raw native session must never leave the tracker");
assert.equal(events[0].kind, "request");
assert.equal(events[0].conversationId, "conversation-a");
assert.equal(activeTurns[0].kind, "started");
assert.equal(activeTurns[0].conversationId, "conversation-a");
assert.deepEqual(activeTurns[0].localFunctionNames, ["blender_runtime", "blender_mcp"]);
assert.match(activeTurns[0].turnTraceFingerprint, /^[a-f0-9]{64}$/);
assert.match(activeTurns[0].sessionFingerprint, /^[a-f0-9]{64}$/);
assert.equal(activeTurns[0].sessionCorrelationFingerprints.length, 1);
assert.equal(activeTurns[0].traceCorrelationFingerprints.length, 2);
assert.equal(activeTurns[1].kind, "metadata");
assert.deepEqual(activeTurns[1].sessionCorrelationFingerprints, activeTurns[0].sessionCorrelationFingerprints);
assert.deepEqual(activeTurns[1].traceCorrelationFingerprints, activeTurns[0].traceCorrelationFingerprints);
assert.equal(JSON.stringify(activeTurns[0]).includes("turn-trace-secret-a"), false, "raw turn trace ids must never leave the parser");
assert.equal(JSON.stringify(activeTurns[0]).includes("session-secret-a"), false, "raw session ids must never leave the active-turn parser");
assert.equal(JSON.stringify(activeTurns).includes("0123456789abcdef000000000000002a"), false, "raw distributed trace ids must never leave the active-turn parser");

tracker.noteResponse({ requestId: "r1", response: { url: "https://chatgpt.com/backend-api/f/conversation", status: 200 } });
const responseToolMessage = JSON.stringify({
  message: {
    id: "assistant-response-tool-a",
    author: { role: "assistant" },
    recipient: "DevSpace_Local_Gateway.devspace_progress_report",
    content: {
      content_type: "code",
      text: JSON.stringify({ kind: "verification", message: "跨對話進度測試" }),
    },
    metadata: { request_id: "response-request-secret", turn_id: "response-turn-secret" },
  },
});
const responseEnvelope = `data: ${responseToolMessage}\n\n`;
const responseBytes = Buffer.from(responseEnvelope, "utf8");
const chineseMarker = Buffer.from("跨", "utf8");
const responseSplit = responseBytes.indexOf(chineseMarker) + 1;
assert.equal(responseSplit > 0, true, "test fixture must split inside one UTF-8 code point");
assert.equal(tracker.noteResponseData({
  requestId: "r1",
  data: responseBytes.subarray(0, responseSplit).toString("base64"),
  base64Encoded: true,
  observedAtMs: now,
}).length, 0, "a split response envelope must wait for the remaining bytes");
const responseInvocations = tracker.noteResponseData({
  requestId: "r1",
  data: responseBytes.subarray(responseSplit).toString("base64"),
  base64Encoded: true,
  observedAtMs: now + 1,
});
assert.equal(responseInvocations.length, 1);
assert.equal(responseInvocations[0].conversationId, "conversation-a");
assert.equal(responseInvocations[0].toolName, "devspace_progress_report");
assert.equal(JSON.stringify(responseInvocations).includes("跨對話進度測試"), false);
assert.equal(JSON.stringify(responseInvocations).includes("response-request-secret"), false);
tracker.noteFinished({ requestId: "r1" });
assert.deepEqual(events.slice(-2).map((item) => item.kind), ["response", "finished"]);
assert.equal(activeTurns.at(-1).kind, "finished");

tracker.noteRequest({
  requestId: "resume-1",
  request: {
    url: "https://chatgpt.com/backend-api/f/conversation/resume",
    method: "POST",
    postData: JSON.stringify({ conversation_id: "conversation-resume", model: "gpt-test", messages: [] }),
    headers: {},
  },
});
assert.equal(tracker.noteResponse({
  requestId: "resume-1",
  response: { url: "https://chatgpt.com/backend-api/f/conversation/resume", status: 200 },
})?.conversationId, "conversation-resume");
tracker.noteFinished({ requestId: "resume-1" });
const resumedFinished = activeTurns.at(-1);
assert.equal(resumedFinished.kind, "finished");
assert.equal(resumedFinished.requestId, "resume-1");
assert.equal(resumedFinished.conversationId, "conversation-resume");
const originalFinished = activeTurns.findLast((item) => item.requestId === "r1" && item.kind === "finished");
assert.equal(originalFinished?.transportOnly, true);
assert.deepEqual(originalFinished?.sessionCorrelationFingerprints, activeTurns[0].sessionCorrelationFingerprints);
assert.equal(tracker.pendingSize, 0, "finished native turn must leave no pending transport record");
const delayedGatewayIdentity = delayedGatewayTurns.resolveGatewayCall({
  toolName: "blender_mcp",
  sessionFingerprintHint: activeTurns[0].sessionFingerprint,
});
assert.equal(delayedGatewayIdentity?.conversationId, "conversation-a",
  "transport completion is not assistant completion; one unique active-turn session alias remains request-scoped authority");
assert.equal(delayedGatewayIdentity?.source, "classic-active-turn-post-transport-session-alias-correlation");
now += 1_100;
assert.equal(delayedGatewayTurns.resolveGatewayCall({
  toolName: "blender_mcp",
  sessionFingerprintHint: activeTurns[0].sessionFingerprint,
})?.conversationId, "conversation-a");
assert.equal(
  delayedGatewayTurns.resolveGatewayCall({
    toolName: "blender_mcp",
    traceCorrelationFingerprints: activeTurns[0].traceCorrelationFingerprints,
    sessionFingerprintHint: "f".repeat(64),
  })?.conversationId,
  "conversation-a",
  "the exact distributed trace must survive the short legacy post-transport grace",
);
delayedGatewayTurns.noteTurn({
  kind: "finished",
  requestId: "r1",
  runtimeKey: "main-01",
  conversationId: "conversation-a",
  observedAtMs: now + 1,
});
assert.equal(delayedGatewayTurns.resolveGatewayCall({
  toolName: "blender_mcp",
  sessionFingerprintHint: activeTurns[0].sessionFingerprint,
}), null, "assistant completion must revoke session-only authority immediately");

tracker.noteRequest({ requestId: "r2", request: { url: "https://chatgpt.com/backend-api/f/conversation", method: "POST", postData: JSON.stringify({ conversation_id: "conversation-b", model: "gpt-test" }), headers: {} } });
tracker.noteFailure({ requestId: "r2", errorText: "net::ERR_FAILED", canceled: true, blockedReason: "other" });
assert.equal(events.at(-1).kind, "failed");
assert.equal(events.at(-1).conversationId, "conversation-b");
assert.equal(events.at(-1).errorText, "net::ERR_FAILED");
assert.equal(activeTurns.at(-1).kind, "failed");
assert.equal(activeTurns.at(-1).requestId, "r2");
assert.equal(activeTurns.at(-1).errorText, "net::ERR_FAILED");
assert.equal(activeTurns.at(-1).canceled, true,
  "liveness must distinguish explicit cancellation from an interruption eligible for rescue");
assert.equal(activeTurns.at(-1).blockedReason, "other");
assert.equal(tracker.pendingSize, 0);

tracker.noteRequest({ requestId: "r3", request: { url: "https://chatgpt.com/backend-api/f/conversation", method: "POST", postData: JSON.stringify({ conversation_id: "conversation-c", model: "gpt-test" }), headers: {} } });
now += 2_000;
tracker.prune();
assert.equal(activeTurns.at(-1).kind, "expired");
assert.equal(activeTurns.at(-1).requestId, "r3");
assert.equal(tracker.pendingSize, 0, "unmatched native turn must expire instead of accumulating forever");

tracker.noteRequest({ requestId: "r4", request: { url: "https://chatgpt.com/backend-api/f/conversation", method: "POST", postData: JSON.stringify({ conversation_id: "conversation-d", model: "gpt-test" }), headers: {} } });
tracker.noteRequest({ requestId: "r5", request: { url: "https://chatgpt.com/backend-api/f/conversation", method: "POST", postData: JSON.stringify({ conversation_id: "conversation-e", model: "gpt-test" }), headers: {} } });
tracker.noteRequest({ requestId: "r6", request: { url: "https://chatgpt.com/backend-api/f/conversation", method: "POST", postData: JSON.stringify({ conversation_id: "conversation-f", model: "gpt-test" }), headers: {} } });
assert.equal(tracker.pendingSize, 2, "native transport tracking must have a hard cap");

console.log(JSON.stringify({ ok: true, gate: "classic-turn-transport-observer", networkOnly: true, nativeIdentity: true, nativeCallMcpCorrelation: true, websocketToolInvocationCorrelation: true, streamedResponseToolInvocationCorrelation: true, splitStreamEnvelopeReassembled: true, activeTurnLifecycle: true, failureCancellationPropagated: true, delayedServerSideMcpUsesBoundedActiveSessionOrExactTrace: true, localFunctionNamesObserved: true, hashedTurnTraceOnly: true, deliveryLifecycle: true, bounded: true, rawSessionPersisted: false, rawToolArgumentsPersisted: false }));
