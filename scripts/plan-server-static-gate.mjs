import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");

assert.match(source, /import \{ PlanRuntime \} from "\.\/plan-runtime\.js";/);
assert.match(source, /import \{ registerPlanTools \} from "\.\/plan-tools\.js";/);
assert.match(source, /const PLAN_CARD_URI = "ui:\/\/devspace\/plan-card\.html";/);
assert.match(source, /new PlanRuntime\(\{\s*stateDir: config\.stateDir,?\s*\}\)/s);
assert.match(source, /const resolveCapabilityConversationAuthority = async \(extra\) => \{[\s\S]*requestContext\?\.capabilityAuthority/, "production MCP tools must consume only request-scoped verified conversation authority");
assert.doesNotMatch(source, /const resolveCapabilityConversationAuthority = async \(extra\) => \{[\s\S]*conversationAuthority\.resolveMcpExtra\(extra\)/, "Plan tools must not revive stale durable session authority inside the handler");
assert.match(source, /mcpCallCorrelator\.noteGateway\(\{[\s\S]*callFingerprint[\s\S]*gatewayRequestId:\s*gatewayCorrelationId/, "the Core HTTP request must establish one exact canonical page-invocation join before entering Plan tools");
assert.match(source, /progressLivenessAdapter\.find\(\{[\s\S]*conversationId:\s*candidate\.conversationId/, "the joined invocation must be re-verified against one exact live conversation page");
assert.match(source, /activeTurnRegistry\.resolveGatewayCall\(\{[\s\S]*sessionCorrelationFingerprintsHint:\s*sessionCorrelationFingerprints/, "Plan tools may use only the current request's hashed session aliases to select one unique active browser turn");
assert.match(source, /activeTurnRegistry\.waitForIdentity\(\{[\s\S]*timeoutMs:\s*MCP_CONVERSATION_CORRELATION_TIMEOUT_MS/, "active-turn fallback must remain bounded to the current MCP request");
assert.match(source, /page\.runtimeKey !== candidateRuntimeKey[\s\S]*page\.generating !== true/, "active-turn evidence must still be re-verified against one exact generating conversation page");
assert.doesNotMatch(source, /resolveVerifiedDirectSession|persistVerifiedDirectSessionIdentity|conversationAuthority\.waitForFingerprint/, "Plan tools must not revive durable or cross-request session ownership");
assert.match(source, /const resolveConversation = resolveCapabilityConversationAuthority;/, "Plan tools must receive the capability/control authority, never the progress-only authority");
assert.doesNotMatch(source, /const resolveConversation = resolveProgressConversationAuthority;/, "a progress-card identity must never own Plan execution state");
assert.match(source, /registerPlanTools\(server, planRuntime, \{\s*resourceUri: PLAN_CARD_URI,\s*resolveConversation,?\s*\}\)/s, "Plan tools must receive the native conversation resolver so new Plans cannot become global unbound state");
assert.match(source, /await planRuntime\.close\(\)/);

console.log(JSON.stringify({ ok: true, gate: "plan-server-static" }));
