import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");

assert.match(source, /const goalInstruction =/);
assert.match(source, /persistent multi-turn (?:objective|outcome)/i);
assert.match(source, /preserve the (?:full )?original objective/i);
assert.match(source, /success criteria/i);
assert.match(source, /floating Goal strip and progress narration card/i);
assert.match(source, /legacy inline black Goal Dock.*retired/i);
assert.match(source, /devspace_goal_mount.*rebinds the floating overlay/i);
assert.match(source, /Plan.*(?:under|within|execution).*Goal/i);
assert.match(source, /every physical Goal turn.*visible.*report/i);
assert.match(source, /devspace_goal_turn_report.*before.*visible.*final report/i);
assert.match(source, /after.*devspace_goal_turn_report.*visible.*final report/i);
assert.match(source, /do not call.*(?:more|additional).*tool.*after.*devspace_goal_turn_report/i);
assert.match(source, /first call devspace_goal_round_begin/i);
assert.match(source, /do not.*(?:CDP|composer).*continu/i);
assert.match(source, /do not.*(?:fake|synthetic) user/i);
assert.match(source, /Rescue remains the only path allowed to emit the exact visible user text `- 繼續`/i,
  "visible Rescue and normal post-report Goal continuation must remain distinct contracts");
assert.match(source, /Same-round Goal Recovery is backend-owned and hidden/i);
assert.match(source, /must not create a user message, type into the composer/i);
assert.match(source, /retired page-composer Goal sender stays fail-closed/i);
assert.match(source, /Goal Recovery must delegate rather than race it/i,
  "Goal recovery must not race the ordinary twenty-minute Rescue episode");
assert.match(source, /continue(?:s)? the same (?:working )?round.*devspace_goal_round_begin/i);
assert.match(source, /Normal post-report Goal continuation remains a separate backend-owned hidden path/i);
assert.match(source, /must never fall back to visible composer automation/i);
assert.match(source, /completion.*(?:every|all).*success criter/i);
assert.match(source, /authoritative evidence/i);
assert.match(source, /blocked.*3 consecutive/i);
assert.match(source, /pause.*stop.*explicit.*user/i);
assert.match(source, /devspace_goal_control.*explicit controls/i);
assert.match(source, /Chat Swarm worker.*must not.*Goal Mode/i);
assert.match(source, /ChatGPT Classic Chat mode/i);
assert.match(source, /Work mode.*(?:out of scope|unsupported|do not)/i);
assert.match(source, /\$\{goalInstruction\}/);

const occurrences = (source.match(/\$\{goalInstruction\}/g) ?? []).length;
assert.equal(occurrences, 3, "Goal instruction must be appended in Codex, Ultra compatibility-superset, and legacy tool-mode instruction branches.");
assert.match(source, /config\.toolMode === "codex"/);
assert.match(source, /config\.toolMode === "ultra"/);

console.log(JSON.stringify({ ok: true, gate: "goal-instructions-static", instructionBranches: 3 }));
