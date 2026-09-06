import assert from "node:assert/strict";
import { validateHostOverlayConversationAcceptance } from "./host-overlay-acceptance.js";

const goal = {
  id: "goal_test",
  conversationId: "conversation-a-1234567890",
  objective: "Complete the durable DevSpace Ultra acceptance",
};
const plan = {
  id: "plan_test",
  conversationId: goal.conversationId,
  objective: "Complete remaining DevSpace phases",
  steps: [{ text: "Verify the conversation-bound Host Overlay frontend lifecycle", status: "in_progress" }],
};
const a = {
  conversationId: goal.conversationId,
  overlayElementCount: 2,
  overlayText: "Verify the conversation-bound Host Overlay frontend lifecycle",
};
const b = {
  conversationId: "conversation-b-1234567890",
  overlayElementCount: 0,
  overlayText: "",
};

const accepted = validateHostOverlayConversationAcceptance({
  goal,
  plan,
  activePlanCount: 1,
  aFirst: a,
  b,
  aSecond: { ...a },
  automaticPageActions: 0,
});
assert.equal(accepted.ok, true);
assert.equal(accepted.inspectionOrder, "A→B→A");
assert.equal(accepted.crossConversationLeak, false);

assert.throws(() => validateHostOverlayConversationAcceptance({
  goal,
  plan: { ...plan, conversationId: "other" },
  activePlanCount: 1,
  aFirst: a,
  b,
  aSecond: a,
}), /Plan is not bound/i);
assert.throws(() => validateHostOverlayConversationAcceptance({
  goal,
  plan,
  activePlanCount: 2,
  aFirst: a,
  b,
  aSecond: a,
}), /exactly one active Plan/i);
assert.throws(() => validateHostOverlayConversationAcceptance({
  goal,
  plan,
  activePlanCount: 1,
  aFirst: { ...a, overlayElementCount: 0 },
  b,
  aSecond: a,
}), /no visible DevSpace Host Overlay/i);
assert.throws(() => validateHostOverlayConversationAcceptance({
  goal,
  plan,
  activePlanCount: 1,
  aFirst: a,
  b: { ...b, overlayText: a.overlayText },
  aSecond: a,
}), /leaked into conversation B/i);
assert.throws(() => validateHostOverlayConversationAcceptance({
  goal,
  plan,
  activePlanCount: 1,
  aFirst: a,
  b,
  aSecond: a,
  automaticPageActions: 1,
}), /page actions are forbidden/i);

console.log(JSON.stringify({
  ok: true,
  gate: "host-overlay-conversation-acceptance",
  backendBindingRequired: true,
  exactlyOneActivePlan: true,
  crossConversationLeakFailsClosed: true,
  zeroPageActionsRequired: true,
}));
