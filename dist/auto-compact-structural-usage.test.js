import assert from "node:assert/strict";
import { estimateStructuralContextTokens } from "./auto-compact-structural-usage.js";

const toolHeavy = estimateStructuralContextTokens({
  payloadBytes: 1_600_000,
  textChars: 120_000,
  branchMessageCount: 8_000,
});
assert.equal(toolHeavy.estimatedTokens, 400_000);
assert.equal(toolHeavy.source, "classic-conversation-structural");
assert.equal(toolHeavy.exact, false);
assert.equal(toolHeavy.rawContentUsed, false);
assert.deepEqual(toolHeavy.components, {
  payloadBytes: 1_600_000,
  textChars: 120_000,
  branchMessageCount: 8_000,
  payloadEstimate: 400_000,
  textEstimate: 60_000,
  messageEstimate: 96_000,
  explicitEstimate: 0,
});

const textHeavy = estimateStructuralContextTokens({
  payloadBytes: 120_000,
  textChars: 300_000,
  branchMessageCount: 100,
});
assert.equal(textHeavy.estimatedTokens, 150_000);

const explicit = estimateStructuralContextTokens({
  estimatedTokens: 250_000,
  payloadBytes: 100,
  textChars: 100,
  branchMessageCount: 1,
});
assert.equal(explicit.estimatedTokens, 250_000);

const empty = estimateStructuralContextTokens({
  payloadBytes: -1,
  textChars: Number.NaN,
  branchMessageCount: null,
});
assert.equal(empty.estimatedTokens, 0);
assert.equal(empty.exact, false);

const clamped = estimateStructuralContextTokens({ payloadBytes: Number.MAX_SAFE_INTEGER });
assert.equal(clamped.estimatedTokens, 500_000_000);

console.log(JSON.stringify({
  ok: true,
  gate: "auto-compact-structural-usage",
  payloadByteSignal: true,
  textSignal: true,
  messageOverheadSignal: true,
  explicitHigherBoundPreserved: true,
  exactClaimed: false,
  rawContentUsed: false,
}));
