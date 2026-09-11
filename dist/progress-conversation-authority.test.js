import assert from "node:assert/strict";
import {
  verifyProgressConversationAuthority,
  DEFAULT_PROGRESS_AUTHORITY_MAX_AGE_MS,
} from "./progress-conversation-authority.js";

const now = Date.parse("2026-09-11T08:10:00.000Z");
const sessionA = "a".repeat(64);
const candidateA = {
  conversationId: "conversation-a",
  sessionFingerprint: sessionA,
  observedAt: "2026-09-11T08:06:45.000Z",
  source: "classic-native-turn",
  runtimeKeys: ["main-02"],
};
let page = {
  exact: true,
  ambiguous: false,
  conversationId: "conversation-a",
  locatedRuntimeKey: "main-03",
  progressCardMounted: true,
  progressConversationId: "conversation-a",
  generating: true,
};
const adapter = {
  async find({ conversationId }) {
    return conversationId === page.conversationId ? { ...page } : { exact: false };
  },
};
let events = {
  request: { conversationId: "conversation-a", kind: "request", observedAt: "2026-09-11T08:06:45.000Z" },
  finished: { conversationId: "conversation-a", kind: "finished", observedAt: "2026-09-11T08:05:00.000Z" },
};
const deliveryEvidence = {
  latest({ conversationId, kind }) {
    const event = events[kind] || null;
    return event?.conversationId === conversationId ? { ...event } : null;
  },
};

const accepted = await verifyProgressConversationAuthority({
  candidate: candidateA,
  sessionFingerprint: sessionA,
  adapter,
  deliveryEvidence,
  now: () => now,
});
assert.equal(accepted?.conversationId, "conversation-a");
assert.equal(accepted?.authorityDomain, "progress");
assert.equal(accepted?.ephemeral, true);
assert.equal(accepted?.source, "classic-progress-session-page-verified");
assert.equal(Object.hasOwn(accepted, "runtimeKey"), false, "Runtime 03 is a page location, never narration ownership");
assert.equal(Object.hasOwn(accepted, "runtimeKeys"), false);

assert.equal(await verifyProgressConversationAuthority({
  candidate: candidateA,
  sessionFingerprint: "b".repeat(64),
  adapter,
  deliveryEvidence,
  now: () => now,
}), null, "a different MCP session cannot claim this conversation");

page = { ...page, exact: false, ambiguous: true };
assert.equal(await verifyProgressConversationAuthority({
  candidate: candidateA,
  sessionFingerprint: sessionA,
  adapter,
  deliveryEvidence,
  now: () => now,
}), null, "the same conversation open in more than one Runtime must fail closed");

page = {
  ...page,
  exact: true,
  ambiguous: false,
  locatedRuntimeKey: "main-01",
  progressConversationId: "conversation-wrong",
};
assert.equal(await verifyProgressConversationAuthority({
  candidate: candidateA,
  sessionFingerprint: sessionA,
  adapter,
  deliveryEvidence,
  now: () => now,
}), null, "a card exposing another conversation id must never receive the report");

page = {
  ...page,
  progressConversationId: "conversation-a",
  locatedRuntimeKey: "main-03",
  generating: false,
};
events = {
  request: { conversationId: "conversation-a", kind: "request", observedAt: "2026-09-11T08:05:00.000Z" },
  finished: { conversationId: "conversation-a", kind: "finished", observedAt: "2026-09-11T08:06:00.000Z" },
};
assert.equal(await verifyProgressConversationAuthority({
  candidate: candidateA,
  sessionFingerprint: sessionA,
  adapter,
  deliveryEvidence,
  now: () => now,
}), null, "an idle stale page cannot be selected by an old session mapping");

page = { ...page, generating: true };
const staleCandidate = {
  ...candidateA,
  observedAt: new Date(now - DEFAULT_PROGRESS_AUTHORITY_MAX_AGE_MS - 1).toISOString(),
};
assert.equal(await verifyProgressConversationAuthority({
  candidate: staleCandidate,
  sessionFingerprint: sessionA,
  adapter,
  deliveryEvidence,
  now: () => now,
}), null, "stale session authority must wait for current-turn evidence");

console.log(JSON.stringify({
  ok: true,
  gate: "progress-conversation-authority",
  authorityKey: "conversationId",
  runtime03IsLocationOnly: true,
  sessionExact: true,
  duplicatePageFailsClosed: true,
  mismatchedCardFailsClosed: true,
  staleSessionFailsClosed: true,
  idlePageFailsClosed: true,
  capabilityAuthorityTouched: false,
}));
