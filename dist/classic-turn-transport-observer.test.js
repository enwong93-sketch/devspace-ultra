import assert from "node:assert/strict";
import { ClassicTurnTransportTracker } from "./classic-turn-transport-observer.js";

let now = 1_000;
const identities = [];
const events = [];
const tracker = new ClassicTurnTransportTracker({
  now: () => now,
  maxPending: 2,
  pendingTtlMs: 1_000,
  onConversationIdentity: (value) => identities.push(value),
  onTurnTransportEvent: (value) => events.push(value),
});

tracker.noteRequest({
  requestId: "r1",
  request: {
    url: "https://chatgpt.com/backend-api/f/conversation",
    method: "POST",
    postData: JSON.stringify({ conversation_id: "conversation-a", model: "gpt-test", messages: [] }),
    headers: {},
  },
});
tracker.noteExtraInfo({ requestId: "r1", headers: { "x-openai-session": "session-secret-a" } });
assert.equal(identities.length, 1);
assert.equal(identities[0].conversationId, "conversation-a");
assert.match(identities[0].sessionFingerprint, /^[a-f0-9]{64}$/);
assert.equal(JSON.stringify(identities).includes("session-secret-a"), false, "raw native session must never leave the tracker");
assert.equal(events[0].kind, "request");
assert.equal(events[0].conversationId, "conversation-a");

tracker.noteResponse({ requestId: "r1", response: { url: "https://chatgpt.com/backend-api/f/conversation", status: 200 } });
tracker.noteFinished({ requestId: "r1" });
assert.deepEqual(events.slice(-2).map((item) => item.kind), ["response", "finished"]);
assert.equal(tracker.pendingSize, 0, "finished native turn must leave no pending transport record");

tracker.noteRequest({ requestId: "r2", request: { url: "https://chatgpt.com/backend-api/f/conversation", method: "POST", postData: JSON.stringify({ conversation_id: "conversation-b", model: "gpt-test" }), headers: {} } });
tracker.noteFailure({ requestId: "r2", errorText: "net::ERR_FAILED", canceled: true, blockedReason: "other" });
assert.equal(events.at(-1).kind, "failed");
assert.equal(events.at(-1).conversationId, "conversation-b");
assert.equal(events.at(-1).errorText, "net::ERR_FAILED");
assert.equal(tracker.pendingSize, 0);

tracker.noteRequest({ requestId: "r3", request: { url: "https://chatgpt.com/backend-api/f/conversation", method: "POST", postData: JSON.stringify({ conversation_id: "conversation-c", model: "gpt-test" }), headers: {} } });
now += 2_000;
tracker.prune();
assert.equal(tracker.pendingSize, 0, "unmatched native turn must expire instead of accumulating forever");

tracker.noteRequest({ requestId: "r4", request: { url: "https://chatgpt.com/backend-api/f/conversation", method: "POST", postData: JSON.stringify({ conversation_id: "conversation-d", model: "gpt-test" }), headers: {} } });
tracker.noteRequest({ requestId: "r5", request: { url: "https://chatgpt.com/backend-api/f/conversation", method: "POST", postData: JSON.stringify({ conversation_id: "conversation-e", model: "gpt-test" }), headers: {} } });
tracker.noteRequest({ requestId: "r6", request: { url: "https://chatgpt.com/backend-api/f/conversation", method: "POST", postData: JSON.stringify({ conversation_id: "conversation-f", model: "gpt-test" }), headers: {} } });
assert.equal(tracker.pendingSize, 2, "native transport tracking must have a hard cap");

console.log(JSON.stringify({ ok: true, gate: "classic-turn-transport-observer", networkOnly: true, nativeIdentity: true, deliveryLifecycle: true, bounded: true, rawSessionPersisted: false }));
