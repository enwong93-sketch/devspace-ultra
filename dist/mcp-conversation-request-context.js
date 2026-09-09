import { AsyncLocalStorage } from "node:async_hooks";

function cleanFingerprint(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : null;
}

function cleanConversation(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

/**
 * Carries the current Core HTTP request's verified Classic conversation
 * evidence into shared MCP tool handlers. This avoids asking a tool handler to
 * rediscover identity from SDK metadata that may omit the original request
 * headers or expose a different session token.
 */
export class McpConversationRequestContext {
  constructor() {
    this.storage = new AsyncLocalStorage();
  }

  run({ authority = null, authorityPromise = null, sessionFingerprint = null, mcpSessionId = null } = {}, operation) {
    if (typeof operation !== "function") throw new Error("operation is required.");
    const conversationId = cleanConversation(authority?.conversationId);
    const context = {
      authority: conversationId
        ? {
            ...authority,
            conversationId,
            sessionFingerprint: cleanFingerprint(authority?.sessionFingerprint) || cleanFingerprint(sessionFingerprint),
          }
        : null,
      sessionFingerprint: cleanFingerprint(sessionFingerprint) || cleanFingerprint(authority?.sessionFingerprint),
      mcpSessionId: cleanConversation(mcpSessionId),
      authorityPromise: authorityPromise && typeof authorityPromise.then === "function"
        ? Promise.resolve(authorityPromise)
        : null,
    };
    return this.storage.run(context, operation);
  }

  current() {
    const value = this.storage.getStore();
    if (!value) return null;
    return {
      authority: value.authority ? structuredClone(value.authority) : null,
      sessionFingerprint: value.sessionFingerprint,
      mcpSessionId: value.mcpSessionId,
      ...(value.authorityPromise ? { authorityPromise: value.authorityPromise } : {}),
    };
  }
}
