import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");
const requestContext = await readFile(new URL("../dist/mcp-conversation-request-context.js", import.meta.url), "utf8");
const correlation = await readFile(new URL("../dist/classic-mcp-call-correlation.js", import.meta.url), "utf8");
const liveness = await readFile(new URL("../dist/conversation-progress-liveness.js", import.meta.url), "utf8");
const livenessCdp = await readFile(new URL("../dist/conversation-progress-liveness-cdp.js", import.meta.url), "utf8");

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
assert.doesNotMatch(server, /String\(event\.source \|\| ""\)\.startsWith\("classic-active-turn-"\)/,
  "active-turn fallback may not rewrite durable session authority");
assert.match(server, /active-turn evidence authorizes this one tool request only/i);
assert.match(requestContext, /capabilityAuthority/);
assert.match(requestContext, /progressAuthority/);
assert.match(requestContext, /progressAuthorityPromise/);
assert.match(correlation, /if \(!trace && !runtimeHint\) return null;/,
  "an unscoped tool name may never select another Main conversation");
assert.match(correlation, /entry\.runtimeKey === runtimeHint/);
assert.doesNotMatch(liveness, /runtime-owner-conflict|record\.runtimeKey|runtimeKey:\s*record\.runtimeKey/,
  "liveness ownership must be conversation-only even when a chat moves to Runtime 03");
assert.match(liveness, /authorityKey:\s*"conversationId"/);
assert.match(liveness, /runtimeBinding:\s*false/);
assert.match(liveness, /adapter\?\.find\?\.\(\{ conversationId \}\)/);
assert.doesNotMatch(livenessCdp, /#exactTarget\(conversationId, runtimeKey\)|dispatchConversationFollowUp\(\{[\s\S]{0,160}runtimePort/,
  "liveness must discover the current page from conversationId instead of binding reminders to one Runtime");
assert.match(livenessCdp, /for \(const runtimeKey of this\.runtimeKeys\)/);
assert.match(livenessCdp, /conversation-open-in-multiple-runtimes/,
  "the same conversation open in more than one Runtime must fail closed rather than guess");

console.log(JSON.stringify({
  ok: true,
  gate: "conversation-authority-domain-static",
  progressAuthorityIsolated: true,
  capabilityAuthorityIsolated: true,
  blenderUnaffectedByProgressFailure: true,
  arbitraryToolWrapping: false,
  unscopedCrossMainGuessing: false,
  activeTurnDurableRewrite: false,
  narrationAuthorityKey: "conversationId",
  narrationRuntimeBinding: false,
  runtime03DiscoverySupported: true,
}));
