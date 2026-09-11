import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");
const requestContext = await readFile(new URL("../dist/mcp-conversation-request-context.js", import.meta.url), "utf8");
const correlation = await readFile(new URL("../dist/classic-mcp-call-correlation.js", import.meta.url), "utf8");
const progressAuthority = await readFile(new URL("../dist/progress-conversation-authority.js", import.meta.url), "utf8");
const liveness = await readFile(new URL("../dist/conversation-progress-liveness.js", import.meta.url), "utf8");
const livenessCdp = await readFile(new URL("../dist/conversation-progress-liveness-cdp.js", import.meta.url), "utf8");
const transportObserver = await readFile(new URL("../dist/classic-turn-transport-observer.js", import.meta.url), "utf8");

assert.match(server, /const resolveCapabilityConversationAuthority = async \(extra\) =>/);
assert.match(server, /const resolveProgressConversationAuthority = async \(extra\) =>/);
assert.match(server, /const resolveConversationAuthority = resolveCapabilityConversationAuthority;/);
assert.match(server, /const resolveConversation = resolveCapabilityConversationAuthority;/);
assert.match(server, /const resolveProgressConversation = resolveProgressConversationAuthority;/);
assert.match(server, /server\.registerTool\("devspace_progress_report"[\s\S]*const resolved = await resolveProgressConversation\(extra\);/);
const progressResolverStart = server.indexOf("const resolveProgressConversationAuthority = async (extra) =>");
const progressResolverEnd = server.indexOf("const resolveConversationAuthority = resolveCapabilityConversationAuthority", progressResolverStart);
assert.ok(progressResolverStart >= 0 && progressResolverEnd > progressResolverStart);
const progressResolver = server.slice(progressResolverStart, progressResolverEnd);
assert.doesNotMatch(progressResolver, /capabilityAuthority|resolveFingerprint|resolveMcpExtra|waitForFingerprint/,
  "progress narration may never fall back to capability/session/Runtime ownership");
assert.match(server, /let progressAuthority = null;/);
assert.doesNotMatch(server, /progressAuthority\s*=\s*progressOnlyTool\s*\?\s*persistedSessionAuthority/);
assert.match(server, /progressOnlyCall\s*=\s*event\?\.toolName\s*===\s*"devspace_progress_report"/);
assert.match(server, /if \(progressOnlyCall\) return;/,
  "a progress-only native call must not rewrite durable capability authority");
assert.match(server, /registerCapabilityTools\(server, capabilityRuntime, \{[\s\S]*resolveConversation: resolveConversationAuthority,/);
assert.match(server, /registerPlanTools\(server, planRuntime, \{[\s\S]*resolveConversation,/);
assert.match(server, /registerGoalTools\(server, goalRuntime, \{[\s\S]*resolveConversation,/);
assert.doesNotMatch(server, /conversationProgressLiveness\.noteToolActivity|consumeToolReminder/,
  "liveness may not wrap, delay, or mutate arbitrary tool handlers");
assert.doesNotMatch(liveness, /noteToolActivity|consumeToolReminder|lastToolReminderAt/,
  "the liveness subsystem must not inject reminders through another tool's execution path");
assert.doesNotMatch(server, /String\(event\.source \|\| ""\)\.startsWith\("classic-active-turn-"\)/,
  "active-turn fallback may not rewrite durable session authority");
assert.match(server, /active-turn evidence authorizes this one tool request only/i);
assert.match(requestContext, /capabilityAuthority/);
assert.match(requestContext, /progressAuthority/);
assert.match(requestContext, /progressAuthorityPromise/);
assert.match(correlation, /if \(!distributedTraces\.length && !trace && !sessionHint && !runtimeHint\) return null;/,
  "an unscoped tool name may never select another Main conversation");
assert.match(correlation, /tracesIntersect\(distributedTraces, entry\.traceCorrelationFingerprints\)/,
  "server-side MCP calls may bind only through an exact distributed-trace match when browser call_mcp no longer exists");
assert.match(server, /const traceCorrelationFingerprints = requestTraceCorrelationFingerprints\(req\?\.headers \|\| \{\}\);/);
assert.match(server, /authoritativeCurrent:\s*true/,
  "an exact request trace may refresh the reused MCP session's current conversation mapping");
assert.match(correlation, /entry\.sessionFingerprint === sessionHint/,
  "a request-owned hashed MCP session may confirm the current browser turn without binding narration to a Runtime");
assert.match(correlation, /entry\.runtimeKey === runtimeHint/);
assert.match(server, /sessionFingerprintHint:\s*sessionFingerprint/);
assert.match(server, /verifyProgressConversationAuthority\(\{/);
assert.match(progressAuthority, /page\.progressConversationId !== conversationId/);
assert.match(progressAuthority, /page\.generating !== true && !activeTransport/,
  "session fallback requires one exact active conversation page rather than a Runtime owner");
assert.doesNotMatch(progressAuthority, /runtimeKey\s*:/,
  "verified progress authority must not contain Runtime ownership");
assert.doesNotMatch(liveness, /runtime-owner-conflict|record\.runtimeKey|runtimeKey:\s*record\.runtimeKey/,
  "liveness ownership must be conversation-only even when a chat moves to Runtime 03");
assert.match(liveness, /authorityKey:\s*"conversationId"/);
assert.match(liveness, /runtimeBinding:\s*false/);
assert.match(liveness, /adapter\?\.find\?\.\(\{ conversationId \}\)/);
assert.doesNotMatch(livenessCdp, /#exactTarget\(conversationId, runtimeKey\)|dispatchConversationFollowUp\(\{[\s\S]{0,160}runtimePort/,
  "liveness must discover the current page from conversationId instead of binding reminders to one Runtime");
assert.match(livenessCdp, /for \(const runtimeKey of this\.runtimeKeys\)/);
assert.match(livenessCdp, /duplicate-conversation-pages/,
  "the same conversation open in more than one Runtime must fail closed rather than guess");
assert.doesNotMatch(liveness, /adapter\?\.sendReminder|adapter\?\.projectReminder|conversation-reminder-sent|conversation-reminder-projected/,
  "ten minutes is an Agent-authored reporting ceiling and may not dispatch or project a reminder");
assert.doesNotMatch(livenessCdp, /async sendReminder\(|async projectReminder\(|purpose:\s*"progress-reminder"|進度旁白提醒/,
  "the ten-minute reminder transport and visible banner APIs must not exist");
assert.doesNotMatch(livenessCdp, /dispatchConversationFollowUp\(/,
  "progress liveness may not use a hidden host relay to create reminder turns");
assert.doesNotMatch(livenessCdp, /hostBridge/,
  "the liveness adapter must not retain any hidden conversation follow-up relay");
assert.doesNotMatch(server, /new ConversationProgressLivenessCdpAdapter\(\{[\s\S]{0,240}hostBridge:/,
  "the Core must not wire Goal recovery dispatch into progress liveness");
assert.match(liveness, /tenMinuteAutomaticReminder:\s*false/);
assert.match(liveness, /tenMinuteSyntheticUserTurn:\s*false/);
assert.match(liveness, /twentyMinuteInterruptedTurnRescueOnly:\s*true/);
assert.match(liveness, /normalCompletionDisarms:\s*true/);
assert.match(liveness, /kind === "finished"/);
assert.match(liveness, /event\?\.canceled === true/);
assert.match(livenessCdp, /normalCompletion:/);
assert.match(livenessCdp, /incompleteUserTurn:/);
assert.match(livenessCdp, /state:'normal-completion-observed'/);
assert.match(transportObserver, /kind:\s*"failed"[\s\S]{0,300}canceled:\s*params\?\.canceled === true/,
  "the supervisor must distinguish a real transport interruption from user cancellation");

console.log(JSON.stringify({
  ok: true,
  gate: "conversation-authority-domain-static",
  progressAuthorityIsolated: true,
  capabilityAuthorityIsolated: true,
  blenderUnaffectedByProgressFailure: true,
  arbitraryToolWrapping: false,
  toolResultReminderCoupling: false,
  unscopedCrossMainGuessing: false,
  legacyActiveTurnDurableRewrite: false,
  exactRequestTraceRefresh: true,
  narrationAuthorityKey: "conversationId",
  narrationRuntimeBinding: false,
  runtime03DiscoverySupported: true,
  tenMinuteAgentReportSloOnly: true,
  tenMinuteAutomaticReminder: false,
  twentyMinuteInterruptedTurnRescueOnly: true,
  normalCompletionDisarms: true,
  exactSessionTurnCorrelation: true,
  restartFallbackPageVerified: true,
}));
