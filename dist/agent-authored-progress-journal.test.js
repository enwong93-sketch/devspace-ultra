import assert from "node:assert/strict";
import { GoalProgressNarrator } from "./agent-authored-progress-journal.js";

const narrator = new GoalProgressNarrator({ progress: { statePath: "progress.json" } });
assert.deepEqual(await narrator.start(), { ok: true, mode: "agent-authored-only" });
assert.equal(narrator.startToolCall({ toolName: "bash" }), null);
assert.equal(narrator.finishToolCall("id", { ok: true }), null);
assert.equal(narrator.noteSystem({ title: "Core recovery" }), null);
assert.equal(narrator.noteGoal({ goalId: "goal" }), null);
assert.equal(narrator.notePlan({ planId: "plan" }), null);
assert.equal(await narrator.someFutureAutomaticNarrationHook(), null, "unknown automatic hooks must also remain no-op");
assert.deepEqual(narrator.snapshot(), {
  ok: true,
  mode: "agent-authored-only",
  automaticVisibleNarration: false,
});
assert.equal(narrator.statePath, "progress.json");
assert.deepEqual(await narrator.close(), { ok: true });

console.log(JSON.stringify({
  ok: true,
  gate: "agent-authored-progress-journal",
  automaticVisibleNarration: false,
  explicitProgressToolOnly: true,
}));
