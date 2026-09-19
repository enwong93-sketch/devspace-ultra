import assert from "node:assert/strict";
import { ProgressBootstrapAuthorityRegistry } from "./progress-bootstrap-authority.js";

let now = Date.parse("2026-09-19T14:00:00.000Z");
const registry = new ProgressBootstrapAuthorityRegistry({
  now: () => now,
  ttlMs: 10_000,
  maxSessions: 8,
});
const session = "a".repeat(64);

assert.equal(registry.consume({ sessionFingerprint: session, toolName: "devspace_goal_start" }), null,
  "no Goal/Plan authority may exist before exact progress proof");

const registered = registry.register({
  sessionFingerprint: session,
  conversationId: "conversation-bootstrap-a",
  runtimeKey: "main-01",
  observedAt: new Date(now).toISOString(),
});
assert.equal(registered.ok, true);
assert.equal(registered.ambiguous, false);

const goal = registry.consume({ sessionFingerprint: session, toolName: "devspace_goal_start" });
assert.equal(goal.conversationId, "conversation-bootstrap-a");
assert.equal(goal.runtimeKey, "main-01");
assert.equal(goal.pageVerified, true);
assert.equal(goal.bootstrapLease, true);
assert.equal(goal.source, "exact-progress-bootstrap-lease-page-verified");
assert.equal(registry.consume({ sessionFingerprint: session, toolName: "devspace_goal_start" }), null,
  "one exact progress preflight may start each mutating control surface at most once");

const plan = registry.consume({ sessionFingerprint: session, toolName: "devspace_plan_start" });
assert.equal(plan.conversationId, "conversation-bootstrap-a",
  "the same exact progress preflight may bootstrap one Goal and one Plan for the same conversation");

registry.register({
  sessionFingerprint: session,
  conversationId: "conversation-bootstrap-b",
  runtimeKey: "main-02",
  observedAt: new Date(now + 1).toISOString(),
});
assert.equal(registry.consume({ sessionFingerprint: session, toolName: "devspace_goal_start" }), null,
  "one host session observed under two exact conversations must fail closed");
assert.equal(registry.diagnostics().ambiguousSessions, 1);

now += 10_001;
registry.prune();
assert.equal(registry.diagnostics().activeSessions, 0);
assert.equal(registry.consume({ sessionFingerprint: session, toolName: "devspace_plan_start" }), null,
  "bootstrap authority must expire quickly and never become durable session ownership");

assert.equal(registry.register({
  sessionFingerprint: "not-a-fingerprint",
  conversationId: "conversation-bootstrap-c",
  runtimeKey: "main-03",
}), null);

console.log(JSON.stringify({
  ok: true,
  gate: "progress-bootstrap-authority",
  exactProgressOnly: true,
  shortLived: true,
  perToolSingleUse: true,
  crossConversationAmbiguityFailsClosed: true,
  durableConversationOwners: 0,
}));