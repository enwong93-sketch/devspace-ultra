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

  run({
    authority = null,
    capabilityAuthority = null,
    progressAuthority = null,
    authorityPromise = null,
    progressAuthorityPromise = null,
    sessionFingerprint = null,
    mcpSessionId = null,
    traceCorrelationFingerprints = [],
  } = {}, operation) {
    if (typeof operation !== "function") throw new Error("operation is required.");
    const selectedCapabilityAuthority = capabilityAuthority || authority;
    const capabilityConversationId = cleanConversation(selectedCapabilityAuthority?.conversationId);
    const progressConversationId = cleanConversation(progressAuthority?.conversationId);
    const context = {
      authority: capabilityConversationId
        ? {
            ...selectedCapabilityAuthority,
            conversationId: capabilityConversationId,
            sessionFingerprint: cleanFingerprint(selectedCapabilityAuthority?.sessionFingerprint) || cleanFingerprint(sessionFingerprint),
          }
        : null,
      capabilityAuthority: capabilityConversationId
        ? {
            ...selectedCapabilityAuthority,
            conversationId: capabilityConversationId,
            sessionFingerprint: cleanFingerprint(selectedCapabilityAuthority?.sessionFingerprint) || cleanFingerprint(sessionFingerprint),
          }
        : null,
      progressAuthority: progressConversationId
        ? {
            ...progressAuthority,
            conversationId: progressConversationId,
            sessionFingerprint: cleanFingerprint(progressAuthority?.sessionFingerprint) || cleanFingerprint(sessionFingerprint),
          }
        : null,
      sessionFingerprint: cleanFingerprint(sessionFingerprint) || cleanFingerprint(selectedCapabilityAuthority?.sessionFingerprint) || cleanFingerprint(progressAuthority?.sessionFingerprint),
      mcpSessionId: cleanConversation(mcpSessionId),
      traceCorrelationFingerprints: [...new Set((Array.isArray(traceCorrelationFingerprints)
        ? traceCorrelationFingerprints : []).slice(0, 8).map(cleanFingerprint).filter(Boolean))],
      authorityPromise: authorityPromise && typeof authorityPromise.then === "function"
        ? Promise.resolve(authorityPromise)
        : null,
      progressAuthorityPromise: progressAuthorityPromise && typeof progressAuthorityPromise.then === "function"
        ? Promise.resolve(progressAuthorityPromise)
        : null,
    };
    return this.storage.run(context, operation);
  }

  current() {
    const value = this.storage.getStore();
    if (!value) return null;
    return {
      authority: value.authority ? structuredClone(value.authority) : null,
      capabilityAuthority: value.capabilityAuthority ? structuredClone(value.capabilityAuthority) : null,
      progressAuthority: value.progressAuthority ? structuredClone(value.progressAuthority) : null,
      sessionFingerprint: value.sessionFingerprint,
      mcpSessionId: value.mcpSessionId,
      ...(value.traceCorrelationFingerprints.length
        ? { traceCorrelationFingerprints: [...value.traceCorrelationFingerprints] } : {}),
      ...(value.authorityPromise ? { authorityPromise: value.authorityPromise } : {}),
      ...(value.progressAuthorityPromise ? { progressAuthorityPromise: value.progressAuthorityPromise } : {}),
    };
  }
}
