import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");

assert.match(source, /const interactiveProgressInstruction =/);
assert.match(source, /interactive\/main ChatGPT Classic conversation/i);
assert.match(source, /Thinking\/XHi or Pro/i);
assert.match(source, /Before the first substantive tool call.*user-visible progress/i);
assert.match(source, /meaningful verified milestone/i);
assert.match(source, /roughly five minutes/i);
assert.match(source, /operational summaries, not hidden chain-of-thought/i);
assert.match(source, /never expose private reasoning/i);
assert.match(source, /Do not replace these updates with repeated collapsed tool previews/i);
assert.match(source, /Chat Swarm worker conversations remain backend-only/i);
assert.match(source, /existing bounded DevSpace human-progress transcript/i);
assert.match(source, /without creating a synthetic user message, a new ChatGPT turn, or any refresh\/navigation/i);

const occurrences = (source.match(/\$\{interactiveProgressInstruction\}/g) ?? []).length;
assert.equal(occurrences, 3, "Interactive progress instruction must be appended in Codex, Ultra, and legacy tool-mode branches.");

console.log(JSON.stringify({
  ok: true,
  gate: "interactive-progress-instructions-static",
  instructionBranches: occurrences,
  reasoningModes: ["thinking-xhigh", "pro"],
  noHiddenReasoningExposure: true,
  noSyntheticTurnFallback: true,
}));
