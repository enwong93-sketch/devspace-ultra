import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [source, agents, toolProgress, gateway, productionJournal, livenessCdp] = await Promise.all([
  readFile(new URL("../dist/server.js", import.meta.url), "utf8"),
  readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
  readFile(new URL("../dist/goal-tool-progress.js", import.meta.url), "utf8"),
  readFile(new URL("./devspace-stable-gateway.mjs", import.meta.url), "utf8"),
  readFile(new URL("../dist/agent-authored-progress-journal.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/conversation-progress-liveness-cdp.js", import.meta.url), "utf8"),
]);

assert.match(source, /exactly one conversation-scoped floating progress narration card/i);
assert.match(source, /neither tool events nor timers may author visible narration/i);
assert.match(source, /personally judge that a meaningful medium-sized step has completed/i);
assert.match(source, /never leave more than ten minutes between Agent-authored reports/i);
assert.match(source, /Ten minutes is a maximum silent interval for the working Agent, not a timer cadence/i);
assert.match(source, /rescue may emit only the exact visible text `- 繼續`/i);
assert.match(source, /Write the card text yourself in natural language/i);
assert.match(source, /never show generated step counters, heartbeat prose, generic program status/i);
assert.match(source, /registerAppTool\(server, "devspace_progress_report"/);
assert.match(source, /conversation-bound update to the floating DEV Space progress narration card in your own natural language/i);
assert.match(source, /exact ChatGPT Classic page that received this result confirms a one-time claim/i);
assert.match(source, /claimId:\s*z\.string\(\)\.min\(16\)\.max\(200\)\.optional\(\)/);
assert.doesNotMatch(source, /after roughly ten substantive tool operations/i);

assert.match(agents, /Call `devspace_progress_report` when a meaningful medium-sized step has completed/i);
assert.match(agents, /ten minutes is an Agent reporting ceiling only/i);
assert.match(agents, /No timer, supervisor, overlay, or hidden relay may send a ten-minute reminder/i);
assert.match(agents, /only after at least twenty minutes/i);
assert.match(agents, /normally completed or explicitly cancelled turn must disarm rescue immediately/i);
assert.match(agents, /only visible text emitted by a verified twenty-minute interrupted-turn rescue is exactly `- 繼續`/i);
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
assert.match(livenessCdp, /INTERRUPTED_TURN_RESCUE_TEXT\s*=\s*"- 繼續"/,
  "the rescue transport must expose only the minimal continuation message");
assert.doesNotMatch(livenessCdp, /工作中斷補救：|請先用 devspace_progress_report/,
  "backend rescue policy must not leak into the synthetic user turn");

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
  interruptedTurnRescueText: "- 繼續",
  normalCompletionDisarms: true,
  rawToolNarration: false,
  boundedCorrelationDeadline: true,
}));
