import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");

assert.match(source, /const planInstruction =/);
assert.match(source, /genuinely multi-step work/i);
assert.match(source, /conversation-bound plan/i);
assert.match(source, /optional execution aid/i,
  "a Plan structures work but is not a continuation permission gate");
assert.match(source, /resume an existing active plan when useful/i);
assert.match(source, /keep unfinished steps accurate/i);
assert.match(source, /update it when scope changes/i);
assert.match(source, /active or incomplete Plan never blocks reads, edits, commands, Goal turns, or automatic Goal continuation/i,
  "Plan state must never strand an active Goal or ordinary workspace tools");
assert.match(source, /floating Plan HUD and progress narration card belong to the exact conversation/i);
assert.match(source, /retired inline Plan Card/i);
assert.match(source, /Mount only when the current HUD is missing/i);
assert.match(source, /Chat Swarm workers keep progress backend-only/i);
assert.doesNotMatch(source, /complete every active turn plan before devspace_goal_turn_report/i,
  "Plan completion cannot be required before Goal continuation");
assert.match(source, /\$\{planInstruction\}/);

console.log(JSON.stringify({ ok: true, gate: "plan-instructions-static" }));
