import assert from "node:assert/strict";
import { classicConversationIdentityFromExtra } from "./classic-conversation-identity.js";

const canonical = classicConversationIdentityFromExtra({
  _meta: {
    "openai/session": "session-should-not-win",
    "openai/conversation_id": "6a9c696c-9630-83e8-a70f-4bbe4b59e5d1",
    "io.modelcontextprotocol/clientCapabilities": { extensions: {} },
  },
  sessionId: "generic-mcp-session",
});
assert.equal(canonical, null, "unverified MCP conversation metadata must never become conversation authority");

const camel = classicConversationIdentityFromExtra({
  _meta: { "openai/conversationId": "conversation_ABC-12345678" },
});
assert.equal(camel, null, "legacy camel-case metadata must remain non-authoritative");

assert.equal(classicConversationIdentityFromExtra({
  _meta: { "openai/session": "looks-like-a-conversation-but-is-not" },
  sessionId: "mcp-session-id",
}), null);

assert.equal(classicConversationIdentityFromExtra({
  _meta: { "openai/conversation_id": "bad id with spaces" },
}), null);

assert.equal(classicConversationIdentityFromExtra({}), null);

console.log(JSON.stringify({
  ok: true,
  gate: "classic-conversation-identity-retired",
  directMcpConversationMetadataRejected: true,
  nativeCorrelationRequired: true,
  genericSessionRejected: true,
}));
