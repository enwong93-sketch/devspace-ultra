import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");

assert.match(source, /const goalInstruction =/);
assert.match(source, /persistent multi-turn (?:objective|outcome)/i);
assert.match(source, /preserve the (?:full )?original objective/i);
assert.match(source, /success criteria/i);
assert.match(source, /Plan.*(?:under|within|execution).*Goal/i);
assert.match(source, /every physical Goal turn.*visible.*report/i);
assert.match(source, /after.*visible report.*devspace_goal_turn_report/i);
assert.match(source, /devspace_goal_turn_report.*final (?:action|tool)/i);
assert.match(source, /first call devspace_goal_round_begin/i);
assert.match(source, /do not.*(?:CDP|composer).*continu/i);
assert.match(source, /do not.*(?:fake|synthetic) user/i);
assert.match(source, /completion.*(?:every|all).*success criter/i);
assert.match(source, /authoritative evidence/i);
assert.match(source, /blocked.*3 consecutive/i);
assert.match(source, /pause.*stop.*explicit.*user/i);
assert.match(source, /Chat Swarm worker.*must not.*Goal Mode/i);
assert.match(source, /\$\{goalInstruction\}/);

const occurrences = (source.match(/\$\{goalInstruction\}/g) ?? []).length;
assert.equal(occurrences, 2, "Goal instruction must be appended in both tool modes.");

console.log(JSON.stringify({ ok: true, gate: "goal-instructions-static" }));
