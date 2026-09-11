import assert from "node:assert/strict";
import { McpConversationRequestContext } from "./mcp-conversation-request-context.js";

const context = new McpConversationRequestContext();
assert.equal(context.current(), null);

const fingerprint = "a".repeat(64);
const result = await context.run({
  authority: {
    conversationId: "conversation-a",
    sessionFingerprint: fingerprint,
    runtimeKeys: ["main-01"],
  },
  sessionFingerprint: fingerprint,
  mcpSessionId: "backend-session-a",
}, async () => {
  await Promise.resolve();
  assert.deepEqual(context.current(), {
    authority: {
      conversationId: "conversation-a",
      sessionFingerprint: fingerprint,
      runtimeKeys: ["main-01"],
    },
    capabilityAuthority: {
      conversationId: "conversation-a",
      sessionFingerprint: fingerprint,
      runtimeKeys: ["main-01"],
    },
    progressAuthority: null,
    sessionFingerprint: fingerprint,
    mcpSessionId: "backend-session-a",
  });
  return "ok";
});
assert.equal(result, "ok");
assert.equal(context.current(), null, "request identity must not leak between MCP calls");

await Promise.all([
  context.run({ authority: { conversationId: "conversation-a" }, sessionFingerprint: "b".repeat(64) }, async () => {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(context.current()?.authority?.conversationId, "conversation-a");
  }),
  context.run({ authority: { conversationId: "conversation-b" }, sessionFingerprint: "c".repeat(64) }, async () => {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(context.current()?.authority?.conversationId, "conversation-b");
  }),
]);

const deferredAuthority = Promise.resolve({
  conversationId: "conversation-deferred",
  sessionFingerprint: "d".repeat(64),
  runtimeKeys: ["main-04"],
});
await context.run({
  authorityPromise: deferredAuthority,
  progressAuthority: {
    conversationId: "conversation-progress-only",
    runtimeKeys: ["main-05"],
  },
  sessionFingerprint: "d".repeat(64),
}, async () => {
  const current = context.current();
  assert.equal(current.authority, null);
  assert.equal(current.capabilityAuthority, null);
  assert.equal(current.progressAuthority.conversationId, "conversation-progress-only");
  assert.equal(current.authorityPromise, deferredAuthority, "conversation-bound tools must receive the exact in-flight correlation promise without a global mutable slot");
  assert.equal((await current.authorityPromise).conversationId, "conversation-deferred");
});

const progressDeferred = Promise.resolve({
  conversationId: "conversation-progress-deferred",
  runtimeKeys: ["main-06"],
});
await context.run({
  capabilityAuthority: { conversationId: "conversation-capability", runtimeKeys: ["main-01"] },
  progressAuthorityPromise: progressDeferred,
}, async () => {
  const current = context.current();
  assert.equal(current.capabilityAuthority.conversationId, "conversation-capability");
  assert.equal(current.progressAuthority, null);
  assert.equal((await current.progressAuthorityPromise).conversationId, "conversation-progress-deferred");
});

console.log(JSON.stringify({
  ok: true,
  gate: "mcp-conversation-request-context",
  asyncPropagation: true,
  concurrentIsolation: true,
  deferredAuthorityPropagation: true,
  authorityDomainsSeparated: true,
  crossRequestLeakage: false,
}));
