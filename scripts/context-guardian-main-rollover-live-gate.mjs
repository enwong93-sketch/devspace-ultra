#!/usr/bin/env node

const RETIRED_FRESH_CONVERSATION_ROLLOVER_GATE = true;

// This former live probe opened a fresh ChatGPT conversation and therefore
// cannot validate true same-conversation Auto Compact. Keeping an executable
// fail-closed tombstone prevents an operator or older handoff from silently
// reviving the superseded fresh-chat rollover acceptance path.
const result = {
  ok: false,
  retired: RETIRED_FRESH_CONVERSATION_ROLLOVER_GATE,
  gate: "context-guardian-main-rollover-live",
  reason: "Fresh-conversation rollover is continuity, not true same-conversation Auto Compact.",
  replacement: "Use the future native same-conversation compact acceptance gate with exact usage before/after evidence.",
};

console.error(JSON.stringify(result));
process.exitCode = 1;
