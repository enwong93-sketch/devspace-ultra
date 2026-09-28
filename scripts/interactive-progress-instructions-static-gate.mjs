import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [source, agents, toolProgress, gateway, productionJournal, livenessCdp, enforcement] = await Promise.all([
  readFile(new URL("../dist/server.js", import.meta.url), "utf8"),
  readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
  readFile(new URL("../dist/goal-tool-progress.js", import.meta.url), "utf8"),
  readFile(new URL("./devspace-stable-gateway.mjs", import.meta.url), "utf8"),
  readFile(new URL("../dist/agent-authored-progress-journal.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/conversation-progress-liveness-cdp.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/interactive-progress-enforcement.js", import.meta.url), "utf8"),
]);

assert.match(source, /exactly one conversation-scoped floating progress narration card/i);
assert.match(source, /INTERACTIVE PROGRESS:/);
assert.match(source, /call devspace_progress_report with concise natural language/i);
assert.match(source, /pending first report means the hidden exact-page claim is completing asynchronously/i);
assert.match(source, /Verify the current conversation's card before claiming narration success/i);
assert.match(source, /neither tool events nor timers may author visible narration/i);
assert.match(source, /personally judge that a meaningful medium-sized step has completed/i);
assert.match(source, /never leave more than ten minutes between Agent-authored reports/i);
assert.match(source, /Ten minutes is a maximum silent interval for the working Agent, not a timer cadence/i);
assert.match(source, /Before entering a long external wait\/process\/CI watch/i);
assert.match(source, /after that wait returns, report the meaningful result before beginning another long phase/i);
assert.match(source, /rescue may emit only the exact visible text `- 繼續`/i);
assert.match(source, /Write the card text yourself in natural language/i);
assert.match(source, /never show generated step counters, heartbeat prose, generic program status/i);
assert.match(source, /registerAppTool\(server, "devspace_progress_report"/);
assert.match(source, /registerAppTool\(server, "devspace_progress_bind"/);
assert.match(source, /registerAppTool\(server, "devspace_progress_bind"[\s\S]{0,2400}visibility:\s*\["app"\]/,
  "the legacy progress-bind endpoint must remain hidden-App compatibility rather than a model-visible workflow requirement");
assert.match(source, /Agents and users must not call this tool manually/i);
assert.match(source, /resourceUri: PROGRESS_CLAIM_RELAY_URI/,
  "the first report must carry its own exact-page relay, even with an older host tool snapshot");
assert.match(source, /Never ask the user to pair a conversation or rely on a separate devspace_progress_bind tool/);
assert.match(source, /conversation-bound update to the floating DEV Space progress narration card in your own natural language/i);
assert.match(source, /hidden exact-page claim completes automatically/i);
assert.match(source, /Local Gateway progress guidance is advisory/);
assert.match(source, /Exact local conversation authority, server-instance isolation, and cross-computer Connector isolation remain separate hard security gates/i,
  "advisory progress must never weaken the separate instance and exact-conversation security boundary");
assert.doesNotMatch(source, /serverInstructions\(config\)\.replace\(/,
  "published model instructions must contain the advisory contract directly rather than mutating it with a runtime regex");
assert.doesNotMatch(source, /if \(progressGate\?\.ok === false && progressGate\?\.blocked === true\)/,
  "a late or pending narration must not reject an ordinary MCP tool call");
assert.match(source, /goalRoundClosureState/,
  "Goal round guidance still derives from persisted Goal and Plan state");
assert.match(source, /interactiveProgressGate\.beforeTool/);
assert.match(source, /progressGate\?\.activityAccepted === true/,
  "actual substantive work advances the exact conversation rescue clock");
assert.match(source, /conversationProgressLiveness\?\.noteActivity/,
  "an admitted substantive tool request must advance the exact conversation rescue clock");
assert.doesNotMatch(source, /onToolInvocation:\s*\(event\)\s*=>\s*\{[\s\S]{0,900}conversationProgressLiveness\?\.noteActivity/,
  "raw ChatGPT tool-invocation observation happens before progress preflight and must not postpone rescue");
assert.match(source, /interactiveProgressGate\?\.noteReport/);
assert.match(source, /interactiveProgressGate\.noteTurn/);
assert.match(source, /claimId:\s*z\.string\(\)\.min\(16\)\.max\(200\)\.optional\(\)/);
assert.doesNotMatch(source, /after roughly ten substantive tool operations/i);
assert.equal(
  (source.match(/return `\$\{mandatoryProgressPreflightInstruction\} Use DevSpace as a local coding workspace/g) || []).length,
  3,
  "every Codex, Ultra, and minimal server-instruction branch must lead with the mandatory progress preflight",
);

assert.match(agents, /## Mandatory interactive progress preflight/);
assert.match(agents, /call `devspace_progress_report` \*\*before the first substantive work tool\*\*/i);
assert.match(agents, /A `pending` claim, unresolved or unbound conversation identity, unavailable recipient, omitted tool, or timeout is not proof/i);
assert.match(agents, /a separate `devspace_progress_bind` call is not required/i);
assert.match(agents, /never claim that the card was updated/i);
assert.match(agents, /Call `devspace_progress_report` when a meaningful medium-sized step has completed/i);
assert.match(agents, /ten minutes is an Agent reporting ceiling only/i);
assert.match(agents, /No timer, supervisor, overlay, or hidden relay may send a ten-minute reminder/i);
assert.match(agents, /Before entering any long external wait, process watch, CI watch/i);
assert.match(agents, /When that wait returns, report the material result before starting another long phase/i);
assert.match(agents, /Silent, ambiguous, merely incomplete, transport-only, or still-generating turns retain the full twenty-minute/i);
assert.match(agents, /Thinking failed.*思考失敗.*at least thirty seconds/i);
assert.match(agents, /normally completed or explicitly cancelled turn must disarm rescue immediately/i);
assert.match(agents, /only visible text emitted by any verified interrupted-turn rescue.*exactly `- 繼續`/i);
assert.match(agents, /Write the update yourself in natural language/i);
assert.match(agents, /Progress narration is an Agent responsibility, not a reason to deny ordinary tools/i);
assert.match(agents, /pending first-use claim, late report, active Plan or completed Plan does not stop reads, edits, commands/i);
assert.doesNotMatch(agents, /batches of roughly ten steps/i);

assert.match(enforcement, /second-substantive-tool-requires-progress/);
assert.match(enforcement, /progress-preflight-required/);
assert.match(enforcement, /final-progress-required/);
assert.match(enforcement, /final-progress-stale/);
assert.match(enforcement, /goal-round-plan-incomplete/);
assert.match(enforcement, /goal-round-report-required/);
assert.match(enforcement, /devspace_goal_round_report_required/,
  "completed turn Plans still produce a Goal round advisory");
assert.match(enforcement, /GOAL_ROUND_CLOSURE_ALLOWED_TOOLS/);
assert.match(enforcement, /devspace_goal_turn_report as the final tool/);
assert.match(enforcement, /maxSilentMs/);
assert.match(enforcement, /activityAccepted:\s*false/,
  "setup/control calls stay outside rescue-clock activity");
assert.match(enforcement, /activityAccepted:\s*true/,
  "substantive calls qualify as rescue-clock activity even when a report is late");
assert.match(enforcement, /runtime.*main-/is,
  "progress guidance applies to user-facing Main runtimes rather than backend workers");
assert.doesNotMatch(enforcement, /append\(|message:\s*["'`]/,
  "progress guidance must never synthesize narration prose into the card");

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
  openingPreflightRequired: true,
  pendingClaimIsNotSuccess: true,
  allToolModesPrependPreflight: true,
  agentAuthoredOnly: true,
  timerDrivenNarration: false,
  fixedCountNarration: false,
  tenMinuteAgentReportCeilingFromWorkspaceInstructions: true,
  longWaitBoundaryReportsRequired: true,
  tenMinuteAutomaticReminder: false,
  twentyMinuteInterruptedTurnRescueOnly: false,
  twentyMinuteSilentOrAmbiguousRescueOnly: true,
  explicitTerminalFailureFastRescue: true,
  interruptedTurnRescueText: "- 繼續",
  normalCompletionDisarms: true,
  rawToolNarration: false,
  boundedCorrelationDeadline: true,
  hardProgressGate: false,
  crossComputerIsolationStillHardGate: true,
  modelInstructionsDirect: true,
  secondSubstantiveToolContinuesWithoutNarration: true,
  activePlanProgressAdvisory: true,
  planCompletionContinuesWithoutFreshNarration: true,
  substantiveToolsResetRescueClock: true,
}));
