import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");

assert.match(source, /const goalInstruction =/);
assert.match(source, /persistent multi-turn (?:objective|outcome)/i);
assert.match(source, /preserve the (?:full )?original objective/i);
assert.match(source, /success criteria/i);
assert.match(source, /exact ChatGPT Classic assistant turn reaches its native completed end-turn/i);
assert.match(source, /automatically closes that physical turn and queues one user-authorized public component continuation message/i);
assert.match(source, /Do not require devspace_goal_turn_report, a completed Plan.*or another user prompt/i);
assert.match(source, /Plan and the floating Goal\/progress surfaces are execution aids; they never gate/i);
assert.doesNotMatch(source, /every physical Goal turn.*visible.*report/i);
assert.doesNotMatch(source, /devspace_goal_turn_report.*before.*visible.*final report/i);
assert.doesNotMatch(source, /three consecutive no-progress/i);
assert.match(source, /calls devspace_goal_round_begin idempotently before work/i);
assert.match(source, /Same-round recovery remains for interrupted turns only/i);
assert.match(source, /exact conversation and local Main page/i);
assert.match(source, /without scrolling, focus changes or composer drafts/i);
assert.match(source, /never fall back to another computer or Connector/i);
assert.match(source, /completion.*(?:every|all).*success criter/i);
assert.match(source, /authoritative evidence/i);
assert.match(source, /\$\{goalInstruction\}/);

const occurrences = (source.match(/\$\{goalInstruction\}/g) ?? []).length;
assert.equal(occurrences, 3, "Goal instruction must be appended in Codex, Ultra compatibility-superset, and legacy tool-mode instruction branches.");
assert.match(source, /config\.toolMode === "codex"/);
assert.match(source, /config\.toolMode === "ultra"/);

console.log(JSON.stringify({ ok: true, gate: "goal-instructions-static", instructionBranches: 3 }));
