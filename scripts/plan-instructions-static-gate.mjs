import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");

assert.match(source, /const planInstruction =/);
assert.match(source, /genuinely multi-step or long-running work/i);
assert.match(source, /conversation-bound plan/i);
assert.match(source, /fresh plan.*physical.*turn|physical.*turn.*fresh plan/i);
assert.match(source, /Goal round.*fresh plan|fresh plan.*Goal round/i);
assert.match(source, /active plan.*resume|resume.*active plan/i);
assert.match(source, /completed plan.*must not be reused|do not reuse.*completed plan/i);
assert.match(source, /exactly one step.*in_progress/i);
assert.match(source, /mark the current in_progress step completed before advancing/i);
assert.match(source, /scope changes.*update the plan before executing/i);
assert.match(source, /floating Plan HUD and progress narration card.*automatically/i);
assert.match(source, /legacy inline Plan Card.*retired/i);
assert.match(source, /do not repeat the full plan in prose/i);
assert.match(source, /complete.*plan.*before.*devspace_goal_turn_report|complete.*plan.*before.*final response/i);
assert.match(source, /devspace_plan_mount.*floating Plan HUD.*missing/i);
assert.match(source, /rebinds the overlay.*does not create an inline card/i);
assert.match(source, /Chat Swarm worker.*must not.*plan card/i);
assert.match(source, /\$\{planInstruction\}/);

console.log(JSON.stringify({ ok: true, gate: "plan-instructions-static" }));
