import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [source, agents, toolProgress, gateway, productionJournal] = await Promise.all([
  readFile(new URL("../dist/server.js", import.meta.url), "utf8"),
  readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
  readFile(new URL("../dist/goal-tool-progress.js", import.meta.url), "utf8"),
  readFile(new URL("./devspace-stable-gateway.mjs", import.meta.url), "utf8"),
  readFile(new URL("../dist/agent-authored-progress-journal.js", import.meta.url), "utf8"),
]);

assert.match(source, /exactly one conversation-scoped floating progress narration card/i);
assert.match(source, /neither tool events nor timers may author visible narration/i);
assert.match(source, /personally judge that a meaningful medium-sized step has completed/i);
assert.match(source, /There is no fixed time or tool-count cadence/i);
assert.match(source, /Write the card text yourself in natural language/i);
assert.match(source, /never show generated step counters, heartbeat prose, generic program status/i);
assert.match(source, /server\.registerTool\("devspace_progress_report"/);
assert.match(source, /conversation-bound update to the floating DEV Space progress narration card in your own natural language/i);
assert.match(source, /waits for the current ChatGPT Classic conversation identity instead of failing on a short correlation deadline/i);
assert.doesNotMatch(source, /after roughly ten substantive tool operations/i);

assert.match(agents, /Call `devspace_progress_report` when a meaningful medium-sized step has completed/i);
assert.match(agents, /ten minutes is an Agent reporting ceiling only/i);
assert.match(agents, /No timer, supervisor, overlay, or hidden relay may send a ten-minute reminder/i);
assert.match(agents, /only after at least twenty minutes/i);
assert.match(agents, /normally completed or explicitly cancelled turn must disarm rescue immediately/i);
assert.match(agents, /Write the update yourself in natural language/i);
assert.doesNotMatch(agents, /batches of roughly ten steps/i);

assert.doesNotMatch(toolProgress, /noteToolStart|noteToolBoundary|setTimeout|Promise\.race/,
  "raw MCP tool traffic must remain internal telemetry and must not generate visible narration");
assert.match(toolProgress, /agents publish human-facing progress only through/);
assert.match(gateway, /agent-authored-progress-journal\.js/,
  "production Stable Gateway must use the agent-authored-only journal rather than the legacy automatic narrator");
assert.match(productionJournal, /automaticVisibleNarration:\s*false/);
assert.doesNotMatch(productionJournal, /setInterval|setTimeout|append\(|message:/,
  "production journal must not schedule or synthesize visible progress messages");

console.log(JSON.stringify({
  ok: true,
  gate: "interactive-progress-instructions",
  explicitProgressEntryPoint: "devspace_progress_report",
  agentAuthoredOnly: true,
  timerDrivenNarration: false,
  fixedCountNarration: false,
  tenMinuteAgentReportCeilingFromWorkspaceInstructions: true,
  tenMinuteAutomaticReminder: false,
  twentyMinuteInterruptedTurnRescueOnly: true,
  normalCompletionDisarms: true,
  rawToolNarration: false,
  noCorrelationDeadline: true,
}));
