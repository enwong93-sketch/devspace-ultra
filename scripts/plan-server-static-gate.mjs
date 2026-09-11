import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");

assert.match(source, /import \{ PlanRuntime \} from "\.\/plan-runtime\.js";/);
assert.match(source, /import \{ registerPlanTools \} from "\.\/plan-tools\.js";/);
assert.match(source, /const PLAN_CARD_URI = "ui:\/\/devspace\/plan-card\.html";/);
assert.match(source, /new PlanRuntime\(\{\s*stateDir: config\.stateDir,?\s*\}\)/s);
assert.match(source, /const resolveCapabilityConversationAuthority = async \(extra\) => \{[\s\S]*requestContext\?\.capabilityAuthority/, "production MCP tools must consume only request-scoped verified conversation authority");
assert.doesNotMatch(source, /const resolveCapabilityConversationAuthority = async \(extra\) => \{[\s\S]*conversationAuthority\.resolveMcpExtra\(extra\)/, "Plan tools must not revive stale durable session authority inside the handler");
assert.match(source, /const traceCorrelationFingerprints = requestTraceCorrelationFingerprints\(req\?\.headers \|\| \{\}\)/, "the Core HTTP request must establish exact distributed-trace authority before entering Plan tools");
assert.match(source, /const resolveConversation = resolveCapabilityConversationAuthority;/, "Plan tools must receive the capability/control authority, never the progress-only authority");
assert.doesNotMatch(source, /const resolveConversation = resolveProgressConversationAuthority;/, "a progress-card identity must never own Plan execution state");
assert.match(source, /registerPlanTools\(server, planRuntime, \{\s*resourceUri: PLAN_CARD_URI,\s*resolveConversation,?\s*\}\)/s, "Plan tools must receive the native conversation resolver so new Plans cannot become global unbound state");
assert.match(source, /await planRuntime\.close\(\)/);

console.log(JSON.stringify({ ok: true, gate: "plan-server-static" }));
