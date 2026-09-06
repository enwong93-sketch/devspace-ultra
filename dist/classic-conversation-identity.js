// RETIRED DIRECT-METADATA AUTHORITY
//
// ChatGPT Classic conversation identity is established only by correlating a
// real native POST /backend-api/f/conversation request body with the hashed
// x-openai-session observed on that same request. MCP _meta conversation-like
// keys are unverified hints and must never bind Goal, Plan, recovery, or usage
// state directly. The compatibility export remains fail-closed so an old
// import cannot silently resurrect the superseded authority model.

const CLASSIC_CONVERSATION_META_KEYS = Object.freeze([
  "openai/conversation_id",
  "openai/conversationId",
]);

export function classicConversationIdentityFromExtra() {
  return null;
}

export { CLASSIC_CONVERSATION_META_KEYS };
