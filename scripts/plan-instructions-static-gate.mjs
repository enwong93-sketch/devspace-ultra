import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");

assert.match(source, /const planInstruction =/);
assert.match(source, /genuinely multi-step or long-running work/i);
assert.match(source, /devspace_plan_start exactly once/i);
assert.match(source, /reuse the same planId/i);
assert.match(source, /exactly one step.*in_progress/i);
assert.match(source, /mark the current in_progress step completed before advancing/i);
assert.match(source, /scope changes.*update the plan before executing/i);
assert.match(source, /do not repeat the full plan in prose/i);
assert.match(source, /finish with every plan step completed/i);
assert.match(source, /devspace_plan_mount.*missing/i);
assert.match(source, /Chat Swarm worker.*must not.*plan card/i);
assert.match(source, /\$\{planInstruction\}/);

console.log(JSON.stringify({ ok: true, gate: "plan-instructions-static" }));
