function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function markerCandidates(goal, plan) {
  const values = [
    plan?.steps?.find?.((step) => step.status === "in_progress")?.text,
    plan?.objective,
    goal?.objective,
  ].map(normalize).filter(Boolean);
  const markers = [];
  for (const value of values) {
    for (const length of [48, 32, 20, 12]) {
      if (value.length >= length) markers.push(value.slice(0, length));
    }
  }
  return [...new Set(markers)];
}

function containsMarker(snapshot, markers) {
  const text = normalize(snapshot?.overlayText);
  return markers.some((marker) => text.includes(marker));
}

export function validateHostOverlayConversationAcceptance({
  goal,
  plan,
  activePlanCount,
  aFirst,
  b,
  aSecond,
  automaticPageActions = 0,
} = {}) {
  const conversationId = String(goal?.conversationId || "").trim();
  if (!conversationId) throw new Error("Goal is not conversation-bound.");
  if (String(plan?.conversationId || "").trim() !== conversationId) {
    throw new Error("Active Plan is not bound to the Goal conversation.");
  }
  if (Number(activePlanCount) !== 1) {
    throw new Error(`Expected exactly one active Plan for the Goal conversation; observed ${activePlanCount}.`);
  }
  if (aFirst?.conversationId !== conversationId || aSecond?.conversationId !== conversationId) {
    throw new Error("Conversation A frontend snapshots do not match the authoritative Goal conversation.");
  }
  if (!b?.conversationId || b.conversationId === conversationId) {
    throw new Error("Conversation B must be a different live ChatGPT conversation.");
  }
  if (Number(aFirst?.overlayElementCount || 0) < 1 || Number(aSecond?.overlayElementCount || 0) < 1) {
    throw new Error("Conversation A has no visible DevSpace Host Overlay elements.");
  }
  const markers = markerCandidates(goal, plan);
  if (!markers.length) throw new Error("No bounded Goal/Plan marker is available for frontend verification.");
  if (!containsMarker(aFirst, markers) || !containsMarker(aSecond, markers)) {
    throw new Error("Conversation A Host Overlay does not agree with the active backend Goal/Plan state.");
  }
  if (containsMarker(b, markers)) {
    throw new Error("Conversation A Goal/Plan marker leaked into conversation B.");
  }
  if (Number(automaticPageActions) !== 0) {
    throw new Error(`Automated page actions are forbidden; observed ${automaticPageActions}.`);
  }
  return {
    ok: true,
    goalId: String(goal.id || ""),
    planId: String(plan.id || ""),
    conversationId,
    otherConversationId: b.conversationId,
    activePlanCount: 1,
    aFirstOverlayElements: Number(aFirst.overlayElementCount || 0),
    bOverlayElements: Number(b.overlayElementCount || 0),
    aSecondOverlayElements: Number(aSecond.overlayElementCount || 0),
    backendFrontendAgreement: true,
    crossConversationLeak: false,
    automaticPageActions: 0,
    inspectionOrder: "A→B→A",
  };
}
