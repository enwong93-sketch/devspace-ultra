import assert from "node:assert/strict";
import { ClassicActiveTurnRegistry } from "./classic-mcp-call-correlation.js";
import { ClassicTurnTransportTracker } from "./classic-turn-transport-observer.js";

let now = 1_000;
const identities = [];
const events = [];
const nativeMcpCalls = [];
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
    headers: { "x-oai-turn-trace-id": "turn-trace-secret-a" },
  },
});
tracker.noteExtraInfo({ requestId: "r1", headers: { "x-openai-session": "session-secret-a" } });
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
assert.equal(JSON.stringify(activeTurns[0]).includes("turn-trace-secret-a"), false, "raw turn trace ids must never leave the parser");

tracker.noteResponse({ requestId: "r1", response: { url: "https://chatgpt.com/backend-api/f/conversation", status: 200 } });
tracker.noteFinished({ requestId: "r1" });
assert.deepEqual(events.slice(-2).map((item) => item.kind), ["response", "finished"]);
assert.equal(activeTurns.at(-1).kind, "finished");
assert.equal(activeTurns.at(-1).requestId, "r1");
assert.equal(tracker.pendingSize, 0, "finished native turn must leave no pending transport record");
const delayedGatewayIdentity = delayedGatewayTurns.resolveGatewayCall({
  toolName: "blender_mcp",
  runtimeKeyHint: "main-01",
});
assert.equal(
  delayedGatewayIdentity?.conversationId,
  "conversation-a",
  "the correlation layer must retain a finished browser turn long enough for the later server-side MCP call",
);
assert.equal(delayedGatewayIdentity?.source, "classic-active-turn-post-finish-unique-tool-correlation");
now += 1_100;
assert.equal(delayedGatewayTurns.resolveGatewayCall({
  toolName: "blender_mcp",
  runtimeKeyHint: "main-01",
}), null);

tracker.noteRequest({ requestId: "r2", request: { url: "https://chatgpt.com/backend-api/f/conversation", method: "POST", postData: JSON.stringify({ conversation_id: "conversation-b", model: "gpt-test" }), headers: {} } });
tracker.noteFailure({ requestId: "r2", errorText: "net::ERR_FAILED", canceled: true, blockedReason: "other" });
assert.equal(events.at(-1).kind, "failed");
assert.equal(events.at(-1).conversationId, "conversation-b");
assert.equal(events.at(-1).errorText, "net::ERR_FAILED");
assert.equal(activeTurns.at(-1).kind, "failed");
assert.equal(activeTurns.at(-1).requestId, "r2");
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

console.log(JSON.stringify({ ok: true, gate: "classic-turn-transport-observer", networkOnly: true, nativeIdentity: true, nativeCallMcpCorrelation: true, activeTurnLifecycle: true, delayedServerSideMcpAfterTransportFinish: true, localFunctionNamesObserved: true, hashedTurnTraceOnly: true, deliveryLifecycle: true, bounded: true, rawSessionPersisted: false, rawToolArgumentsPersisted: false }));
