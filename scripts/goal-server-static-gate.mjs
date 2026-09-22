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
assert.match(source, /new ClassicGoalHostBridge\(\{\s*\.\.\.classicCdpOptions,\s*beforeDispatch:\s*config\.passiveCore\s*\|\|\s*!primaryDebugGuard\s*\?\s*undefined\s*:\s*\(\) => primaryDebugGuard\.pollOnce\(\),?\s*\}\)/s);
assert.doesNotMatch(source, /sendExactGoalRecovery|progressLivenessAdapter\.sendGoalRecovery|progressLivenessAdapter\.sendGoalContinuation/,
  "Goal continuation and same-round recovery must never be wired to the visible composer transport");
assert.match(source, /dispatch:\s*\(\{ goal, page,[\s\S]{0,500}return goalHostBridge\.dispatch\(\{/,
  "the Goal continuation supervisor must dispatch through the hidden host bridge");
assert.match(source, /expectedPageTargetId:\s*candidate\.pageTargetId/,
  "hidden continuation must remain bound to the exact page proven at the visible-final boundary");
assert.match(source, /onHiddenContinuationStarted:\s*async \(\{ conversationId, continuationId, sourceUserMessageId, runtimeKey, observedAtMs \}\)/,
  "successful or reconciled hidden continuation must notify the liveness owner instead of reusing a prior Rescue episode forever");
assert.match(source, /kind:\s*"goal-continuation-started"[\s\S]{0,220}goalContinuationId:\s*continuationId/);
assert.match(source, /goalRecoveryRescueDecision\(rescueRecord\)/,
  "same-round Goal recovery and interrupted-turn Rescue must share one explicit arbitration policy");
assert.match(source, /arbitration\.action === "delegate"[\s\S]{0,320}ordinary-interrupted-turn-rescue/,
  "a committed Rescue must close the Goal recovery episode without another send");
assert.match(source, /arbitration\.action === "wait"[\s\S]{0,260}state:\s*arbitration\.reason/,
  "a pending Rescue must block hidden Goal recovery from racing it");
assert.match(source, /goalHostBridge\.dispatchRoundRecovery\(\{[\s\S]{0,420}sourceUserMessageId:[\s\S]{0,220}baselineAssistantMessageId:/,
  "hidden same-round recovery must retain the exact native branch boundary for acknowledgement reconciliation");
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
assert.match(source, /conversationAuthority\.resolveFingerprint\(sessionFingerprint\)[\s\S]*classic-native-session-page-verified/, "an exact native ChatGPT session mapping may recover a direct Goal call only through current page verification");
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
assert.match(source, /registerGoalTools\(server, goalRuntime, \{\s*resourceUri: GOAL_DOCK_URI,\s*relayResourceUri: GOAL_RELAY_URI,\s*hostBridge: goalHostBridge,\s*onMount:\s*\(\{ goal \}\) => hostOverlayProjection\?\.requestOwnerRebind\?\.\(\{ goalId: goal\?\.id \}\),\s*resolveConversation,\s*resolveBootstrapConversation,\s*startClaimRegistry:\s*conversationStartClaimRegistry,\s*claimRelayResourceUri:\s*PROGRESS_CLAIM_RELAY_URI,\s*resolveStartClaimPage,?\s*\}\)/s, "Goal tools must receive native request authority plus short-lived exact-progress bootstrap and exact-page one-time start recovery");
assert.match(source, /new ProgressBootstrapAuthorityRegistry\(\)/,
  "cached-schema Goal bootstrap must be derived from short-lived exact progress proof rather than durable session ownership");
assert.match(source, /progressBootstrapAuthority\?\.consume\?\.\(\{[\s\S]{0,180}toolName/,
  "Goal bootstrap must consume a tool-specific exact-progress lease");
assert.match(source, /new ConversationStartClaimRegistry\(\)/,
  "Goal start recovery must use one bounded in-memory claim registry rather than a reusable session owner");
assert.match(source, /new ConversationStartClaimCdpResolver\(\{\s*ports:\s*classicCdpOptions\.ports,?\s*\}\)/s,
  "Goal start recovery must prove the hidden claim iframe under the bounded Classic Main port set");
assert.match(source, /const resolveStartClaimPage = async \(claimId\) => conversationStartClaimCdp\.find\(\{ claimId, claimType: "conversation-start" \}\)/,
  "Goal start recovery must resolve a one-time claim to its exact parent ChatGPT page");
assert.match(source, /conversationStartClaimRelay/,
  "exact-page relay retries must not be counted as a second substantive user work tool");
assert.match(source, /registerGoalTools\(server, goalRuntime,[\s\S]{0,800}resolveStartClaimPage/,
  "Goal tools must receive the exact-page CDP claim resolver");
assert.match(source, /createMcpServer\([^)]*goalRuntime[^)]*goalHostBridge[^)]*hostOverlayProjection[^)]*conversationAuthority[^)]*conversationAuthorityReady/s);
assert.match(source, /safeGoalDurabilityDiagnostics\(\{[\s\S]{0,180}goalRoundCompletionGuard,[\s\S]{0,180}goalRuntime,[\s\S]{0,180}planRuntime/,
  "loopback diagnostics must invoke the bounded fail-safe Goal durability wrapper instead of calling an unchecked method inline");
assert.match(source, /goalRuntime\.conversationCollisions\(\{ limit: 20 \}\)/,
  "loopback diagnostics must expose bounded legacy multi-Goal collisions so automatic dispatch failures are diagnosable");
assert.match(source, /app\.post\('\/__devspace\/goal\/repair-collision'/,
  "legacy collision repair must use one explicit owner-authorized loopback endpoint rather than out-of-process state writes");
assert.match(source, /assertGoalCollisionRepairAuthority\(\{[\s\S]{0,240}conversationId,[\s\S]{0,240}keepGoalId,[\s\S]{0,240}projection,[\s\S]{0,240}pageResolution/,
  "collision repair requires both the current backend projection and one exact current ChatGPT page");
assert.match(source, /goalRuntime\.resolveConversationCollision\(\{/,
  "the active Core must serialize collision repair through its authoritative GoalRuntime");
assert.match(source, /goalContinuation:\s*goalContinuationSupervisor\.status\(\),[\s\S]{0,80}\.\.\.durability/,
  "memory status must include the bounded Goal recovery and persistence diagnostics helper output");
assert.match(source, /await goalRuntime\.close\(\)/);

const resourceIndex = source.indexOf('registerAppResource(server, "DevSpace Goal Dock"');
const relayResourceIndex = source.indexOf('registerAppResource(server, "DevSpace Goal Continuation Relay"');
const toolsIndex = source.indexOf("registerGoalTools(server, goalRuntime");
assert.ok(resourceIndex >= 0 && toolsIndex > resourceIndex, "Goal Dock resource must be registered before Goal tools.");
assert.ok(relayResourceIndex >= 0 && toolsIndex > relayResourceIndex, "Goal continuation relay resource must be registered before Goal tools.");

console.log(JSON.stringify({ ok: true, gate: "goal-server-static" }));
