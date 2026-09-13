import assert from "node:assert/strict";
import {
  ClassicToolInvocationStreamTracker,
  parseClassicToolInvocationPayload,
} from "./classic-tool-invocation-stream.js";

const secretMessage = "private-progress-text-never-persist";
const payload = JSON.stringify({
  type: "message",
  message: {
    id: "assistant-tool-message-a",
    author: { role: "assistant" },
    recipient: "api_tool.call_tool",
    status: "finished_successfully",
    content: {
      content_type: "code",
      text: JSON.stringify({
        path: "/DevSpace Local Gateway/link_6a9c8ea532a481918c0f3a852cdb8bbf/devspace_progress_report",
        args: { kind: "milestone", message: secretMessage },
      }),
    },
    metadata: {
      request_id: "request-secret-a",
      working_turn_id: "turn-secret-a",
    },
  },
});

const parsed = parseClassicToolInvocationPayload(payload, {
  conversationId: "conversation-tool-stream-a",
  observedAtMs: 1_000,
});
assert.equal(parsed.length, 1);
assert.equal(parsed[0].conversationId, "conversation-tool-stream-a");
assert.equal(parsed[0].toolName, "devspace_progress_report");
assert.match(parsed[0].callFingerprint, /^[a-f0-9]{64}$/);
assert.match(parsed[0].invocationFingerprint, /^[a-f0-9]{64}$/);
assert.equal(JSON.stringify(parsed).includes(secretMessage), false);
assert.equal(JSON.stringify(parsed).includes("request-secret-a"), false);
assert.equal(JSON.stringify(parsed).includes("turn-secret-a"), false);

const nestedSsePayload = JSON.stringify({
  data: `data: ${payload}\n`,
  duplicate: JSON.parse(payload),
});
let now = 1_000;
const tracker = new ClassicToolInvocationStreamTracker({
  now: () => now,
  ttlMs: 100,
  maxSeen: 16,
});
const first = tracker.notePayload({
  payloadData: nestedSsePayload,
  conversationId: "conversation-tool-stream-a",
  observedAtMs: now,
});
assert.equal(first.length, 1, "repeated copies of one websocket message must emit one invocation");
assert.equal(tracker.notePayload({
  payloadData: payload,
  conversationId: "conversation-tool-stream-a",
  observedAtMs: now + 1,
}).length, 0);
assert.equal(tracker.diagnostics().duplicates > 0, true);

const directRecipientPayload = JSON.stringify({
  message: {
    id: "assistant-tool-message-b",
    author: { role: "assistant" },
    recipient: "DevSpace_Local_Gateway.devspace_goal_status",
    content: {
      content_type: "code",
      text: JSON.stringify({ goalId: "goal-safe-a" }),
    },
    metadata: { turn_exchange_id: "turn-secret-b" },
  },
});
const direct = tracker.notePayload({
  payloadData: directRecipientPayload,
  conversationId: "conversation-tool-stream-b",
  observedAtMs: now + 2,
});
assert.equal(direct.length, 1);
assert.equal(direct[0].toolName, "devspace_goal_status");

const foreignConnectorPayload = JSON.stringify({
  message: {
    id: "assistant-tool-message-c",
    author: { role: "assistant" },
    recipient: "api_tool.call_tool",
    content: {
      content_type: "code",
      text: JSON.stringify({
        path: "/Another Connector/link_abcdef012345/search",
        args: { query: "not-devspace" },
      }),
    },
  },
});
assert.equal(tracker.notePayload({
  payloadData: foreignConnectorPayload,
  conversationId: "conversation-tool-stream-a",
  observedAtMs: now + 3,
}).length, 0, "other connectors must not become DevSpace authority evidence");

assert.equal(tracker.completeConversation("conversation-tool-stream-b"), 1);
now += 1_100;
tracker.prune();
assert.equal(tracker.diagnostics().seen, 0);

console.log(JSON.stringify({
  ok: true,
  gate: "classic-tool-invocation-stream",
  exactConversationRoute: true,
  canonicalToolArgumentsHash: true,
  duplicateFramesDeduped: true,
  foreignConnectorsIgnored: true,
  boundedRetention: true,
  rawArgumentsPersisted: false,
  rawMessageIdsPersisted: false,
}));
