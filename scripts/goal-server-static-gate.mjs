import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");

assert.match(source, /import \{ GoalRuntime \} from "\.\/goal-runtime\.js";/);
assert.match(source, /import \{ registerGoalTools \} from "\.\/goal-tools\.js";/);
assert.match(source, /import \{ ClassicGoalHostBridge \} from "\.\/goal-host-bridge\.js";/);
assert.match(source, /const GOAL_DOCK_URI = "ui:\/\/devspace\/goal-dock\.html";/);
assert.match(source, /const GOAL_RELAY_URI = "ui:\/\/devspace\/goal-continuation-relay\.html";/);
assert.match(source, /new GoalRuntime\(\{\s*stateDir: config\.stateDir,?\s*\}\)/s);
assert.match(source, /const\s+classicCdpOptions\s*=\s*Array\.isArray\(config\.classicMainDebugPorts\)[\s\S]{0,180}ports:\s*config\.classicMainDebugPorts/, "Goal Host Bridge must share the configured bounded Classic port set");
assert.match(source, /new ClassicGoalHostBridge\(\{\s*\.\.\.classicCdpOptions,\s*beforeDispatch:\s*config\.passiveCore\s*\?\s*undefined\s*:\s*\(\) => primaryDebugGuard\.pollOnce\(\),\s*sendRecovery:\s*sendExactGoalRecovery,?\s*\}\)/s);
assert.match(source, /const sendExactGoalRecovery = async \([\s\S]*progressLivenessAdapter\.sendGoalRecovery\(\{/,
  "Goal Recovery must use the exact current conversation page-composer sender");
assert.match(source, /registerAppResource\(server, "DevSpace Goal Dock", GOAL_DOCK_URI,/);
assert.match(source, /new URL\("\.\/ui\/goal-dock\.html", import\.meta\.url\)/);
assert.match(source, /registerAppResource\(server, "DevSpace Goal Continuation Relay", GOAL_RELAY_URI,/);
assert.match(source, /new URL\("\.\/ui\/goal-continuation-relay\.html", import\.meta\.url\)/);
assert.match(source, /const resolveCapabilityConversationAuthority = async \(extra\) => \{[\s\S]*requestContext\?\.capabilityAuthority/, "production Goal and capability tools must consume only request-scoped verified conversation authority");
assert.doesNotMatch(source, /const resolveCapabilityConversationAuthority = async \(extra\) => \{[\s\S]*conversationAuthority\.resolveMcpExtra\(extra\)/, "Goal tools must not revive stale durable session authority inside the handler");
assert.match(source, /mcpCallCorrelator\.noteGateway\(\{[\s\S]*callFingerprint[\s\S]*gatewayRequestId:\s*gatewayCorrelationId/, "the Core HTTP request must establish one exact canonical page-invocation join before entering Goal tools");
assert.match(source, /progressLivenessAdapter\.find\(\{[\s\S]*conversationId:\s*candidate\.conversationId/, "the joined invocation must be re-verified against one exact live conversation page");
assert.match(source, /activeTurnRegistry\.resolveGatewayCall\(\{[\s\S]*sessionCorrelationFingerprintsHint:\s*sessionCorrelationFingerprints/, "Goal tools may use only the current request's hashed session aliases to select one unique active browser turn");
assert.match(source, /activeTurnRegistry\.waitForIdentity\(\{[\s\S]*timeoutMs:\s*MCP_CONVERSATION_CORRELATION_TIMEOUT_MS/, "active-turn fallback must remain bounded to the current MCP request");
assert.match(source, /page\.runtimeKey !== candidateRuntimeKey[\s\S]*page\.generating !== true/, "active-turn evidence must still be re-verified against one exact generating conversation page");
assert.doesNotMatch(source, /resolveVerifiedDirectSession|persistVerifiedDirectSessionIdentity|conversationAuthority\.waitForFingerprint/, "Goal tools must not revive durable or cross-request session ownership");
const progressResolverStart = source.indexOf("const resolveProgressConversationAuthority = async (extra) =>");
const progressResolverEnd = source.indexOf("const resolveConversationAuthority = resolveCapabilityConversationAuthority", progressResolverStart);
assert.ok(progressResolverStart >= 0 && progressResolverEnd > progressResolverStart, "progress authority resolver must exist");
const progressResolver = source.slice(progressResolverStart, progressResolverEnd);
assert.match(progressResolver, /requestContext\?\.progressAuthority/);
assert.match(progressResolver, /requestContext\?\.progressAuthorityPromise/);
assert.doesNotMatch(progressResolver, /capabilityAuthority|resolveFingerprint|resolveMcpExtra|waitForFingerprint/,
  "progress narration must never inherit capability/session/Runtime ownership");
assert.match(source, /const resolveConversationAuthority = resolveCapabilityConversationAuthority;/, "capability compatibility alias must remain on the capability authority domain");
assert.match(source, /const resolveConversation = resolveCapabilityConversationAuthority;/, "Goal and Plan tools must not inherit progress-only authority");
assert.match(source, /const resolveProgressConversation = resolveProgressConversationAuthority;/, "progress narration must use only the progress authority resolver");
assert.match(source, /const resolved = await resolveProgressConversation\(extra\);/, "devspace_progress_report must use the isolated progress resolver");
assert.doesNotMatch(source, /const resolveConversation = resolveProgressConversationAuthority;/, "progress identity must never become the generic tool authority");
assert.match(source, /registerGoalTools\(server, goalRuntime, \{\s*resourceUri: GOAL_DOCK_URI,\s*relayResourceUri: GOAL_RELAY_URI,\s*hostBridge: goalHostBridge,\s*onMount:\s*\(\{ goal \}\) => hostOverlayProjection\?\.requestOwnerRebind\?\.\(\{ goalId: goal\?\.id \}\),\s*resolveConversation,?\s*\}\)/s, "Goal tools must receive the native conversation resolver while explicit mount remains read-only for Goal state");
assert.match(source, /createMcpServer\([^)]*goalRuntime[^)]*goalHostBridge[^)]*hostOverlayProjection[^)]*conversationAuthority[^)]*conversationAuthorityReady/s);
assert.match(source, /await goalRuntime\.close\(\)/);

const resourceIndex = source.indexOf('registerAppResource(server, "DevSpace Goal Dock"');
const relayResourceIndex = source.indexOf('registerAppResource(server, "DevSpace Goal Continuation Relay"');
const toolsIndex = source.indexOf("registerGoalTools(server, goalRuntime");
assert.ok(resourceIndex >= 0 && toolsIndex > resourceIndex, "Goal Dock resource must be registered before Goal tools.");
assert.ok(relayResourceIndex >= 0 && toolsIndex > relayResourceIndex, "Goal continuation relay resource must be registered before Goal tools.");

console.log(JSON.stringify({ ok: true, gate: "goal-server-static" }));
