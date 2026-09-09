import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [server, agents, skill] = await Promise.all([
  readFile(new URL("../dist/server.js", import.meta.url), "utf8"),
  readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
  readFile(new URL("../skills/devspace-ultra-setup/SKILL.md", import.meta.url), "utf8"),
]);

for (const [name, source] of [["server", server], ["AGENTS.md", agents], ["setup Skill", skill]]) {
  assert.match(source, /meaningful medium-sized|中型/i, `${name} must use Agent-judged medium-step narration.`);
  assert.match(source, /not after every tool|not per tool|唔.*每.*工具/i, `${name} must reject per-tool narration.`);
  assert.match(source, /not on a timer|no fixed time|timer/i, `${name} must reject timer-driven narration.`);
}
assert.match(server, /completely free-form|free-form/i, "The progress tool must preserve natural free-form wording.");
assert.doesNotMatch(server, /every\s+10\s+tools|every ten tools|10 個工具/i, "The server must not impose a ten-tool narration cadence.");
assert.doesNotMatch(agents, /every\s+10\s+tools|every ten tools|10 個工具/i, "Agent instructions must not impose a ten-tool narration cadence.");

console.log(JSON.stringify({
  ok: true,
  gate: "progress-cadence-static",
  mediumStepCadence: true,
  perToolCadence: false,
  timerCadence: false,
  freeFormAgentAuthoredText: true,
}));
