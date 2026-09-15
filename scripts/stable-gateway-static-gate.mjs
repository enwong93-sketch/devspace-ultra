import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = async (path) => await readFile(resolve(root, path), "utf8");

const coreSlot = await read("scripts/devspace-core-slot.mjs");
const stableGateway = await read("scripts/devspace-stable-gateway.mjs");
const stableGatewayStartup = await read("scripts/devspace-stable-gateway-startup.ps1");
const gatewayController = await read("dist/stable-gateway-controller.js");
const gatewayAdmission = await read("dist/stable-gateway-admission.js");
const gatewayQuiet = await read("dist/stable-gateway-quiet.js");
const gatewayRuntime = await read("dist/stable-gateway-runtime.js");
const gatewayProxy = await read("dist/stable-gateway-proxy.js");
const handoverGate = await read("scripts/stable-gateway-handover-gate.mjs");
const backendReload = await read("scripts/devspace-fixed-backend-reload.mjs");
const fixedBackend = await read("scripts/devspace-fixed-backend.mjs");
const packageJson = JSON.parse(await read("package.json"));

assert.match(coreSlot, /DEVSPACE_CONFIG_DIR/, "Core slot launcher must preserve explicit config ownership");
assert.match(coreSlot, /DEVSPACE_STATE_DIR/, "Core slot launcher must select candidate/canonical state explicitly");
assert.match(coreSlot, /DEVSPACE_PUBLIC_BASE_URL/, "Core slots must generate metadata for the stable public origin");
assert.match(coreSlot, /createCandidateSnapshot/, "Core slot helper must build an isolated candidate snapshot");
assert.match(coreSlot, /devspace\.sqlite/, "candidate snapshot must handle SQLite separately from ordinary file copying");
assert.match(coreSlot, /candidate[\s\S]*DEVSPACE_CONTEXT_GUARDIAN/i, "candidate Core must disable Context Guardian background work");
assert.match(coreSlot, /candidate[\s\S]*DEVSPACE_CLASSIC_HOST_OVERLAY/i, "candidate Core must disable Host Overlay background work");
assert.match(coreSlot, /candidate[\s\S]*DEVSPACE_CLASSIC_STREAM_RECOVERY/i, "candidate Core must disable Stream Recovery background work");

assert.match(gatewayController, /StableGatewaySessionRegistry/, "Gateway controller must own the public MCP session registry");
assert.match(gatewayController, /readCoreSchemaFingerprint/, "handover baseline must use a fresh active-Core MCP schema session");
assert.doesNotMatch(gatewayController, /baseline\.backendSessionId[\s\S]*read.*SchemaFingerprint/i, "handover schema gate must not depend on a previously issued backend MCP session id");
assert.match(gatewayController, /createStableGatewayProxy/, "Gateway controller must own the stable public proxy");
assert.match(stableGateway, /stableGatewayPublicBaseUrl[\s\S]*edgePublicBaseUrl/, "Stable Gateway must prefer generic production public identity config while retaining legacy edge fallback");
assert.match(stableGateway, /stableGatewayStateDir[\s\S]*edgeFixedStateDir/, "Stable Gateway must prefer generic production state ownership while retaining legacy edge fallback");
assert.match(stableGateway, /stableGatewayPort[\s\S]*edgeBackendPort/, "Stable Gateway must prefer generic production listener config while retaining legacy edge fallback");
assert.match(stableGateway, /stableGatewayCoreAPort[\s\S]*stableGatewayCoreBPort/, "Stable Gateway must allow explicit private Core A/B ports");
assert.match(stableGateway, /DEVSPACE_CLASSIC_UI_OWNER_PRIORITY:\s*"100"/, "Stable Gateway active Core must outrank ordinary standalone Core UI projection");
assert.match(coreSlot, /candidate[\s\S]*DEVSPACE_CLASSIC_UI_OWNER_PRIORITY:\s*"0"/i, "candidate Core must never compete for the Classic UI owner lease");
assert.match(stableGateway, /readCoreSchemaFingerprint/, "runtime wiring must probe active-Core schema through a fresh ephemeral MCP session instead of trusting a stale backend session id");
assert.match(stableGateway, /probeCandidate/, "runtime wiring must provide candidate compatibility probing");
assert.match(stableGateway, /__devspace\/gateway\/handover/, "Gateway must expose a private handover control endpoint");
assert.match(stableGateway, /timingSafeEqual/, "Gateway handover control endpoint must authenticate its local caller");
assert.match(stableGateway, /remoteAddress|loopback/i, "Gateway handover endpoint must be loopback-only");
assert.match(gatewayAdmission, /closeAdmission[\s\S]*waitForDrain/, "Gateway must stop global HTTP admission and drain before canonical ownership changes");
assert.match(gatewayAdmission, /waitForOpen/, "Gateway admission must support barrier-only waits for replayable MCP event streams");
assert.match(gatewayController, /isReplayableMcpEventStream[\s\S]*waitForOpen/, "GET MCP event streams must wait behind handover admission without counting as non-draining HTTP work");
assert.match(gatewayProxy, /replayableMcpStream[\s\S]*waitForAdmission[\s\S]*registry\.lookup/, "session-bound GET MCP event streams must honor the MCP barrier without incrementing active request drain accounting");
assert.match(gatewayController, /beginBarrier[\s\S]*waitForDrain/, "Gateway must stop MCP admission and drain Core A before canonical ownership changes");
assert.match(gatewayController, /stopCoreSlot[\s\S]*startCoreSlot/, "handover must stop the old canonical writer before starting the replacement writer");
assert.match(gatewayController, /commitMappings/, "Gateway must atomically commit replayed backend session mappings");
assert.match(gatewayController, /rollback/i, "handover must contain an explicit rollback path");
assert.match(gatewayController, /abortBarrier/, "Gateway must reopen admission after success or rollback");
assert.match(gatewayController, /handover = async \(\{ allowSchemaChange = false \} = \{\}\)/,
  "model-surface changes must require an explicit one-handover authorization");
assert.match(gatewayController, /candidateFingerprint[\s\S]*verifyCore\(replacementHandle, baseline, candidateFingerprint\)/,
  "the production replacement must exactly match the already-validated schema-changing candidate");
assert.match(gatewayController, /candidateToolCount !== baselineToolCount/,
  "a schema-changing handover may not silently add or remove tools under the metadata-only migration flag");
assert.match(gatewayController, /requiresFreshInitialize:\s*schemaChanged/,
  "schema-changing handover must declare that stale clients require a fresh initialize");
assert.match(gatewayRuntime, /updateAuthorization\(/, "Gateway registry must rotate in-memory replay credentials after OAuth access-token refresh");
assert.match(gatewayRuntime, /markEventStreamOpen[\s\S]*markEventStreamClosed[\s\S]*entry\.coreId = "unmapped"[\s\S]*entry\.backendSessionId = "unmapped"/, "Gateway SSE disconnects must invalidate only the Core mapping while retaining the public conversation descriptor for lazy resurrection");
assert.doesNotMatch(gatewayRuntime, /#removeDisconnectedIfIdle|this\.sessions\.delete\(entry\.publicSessionId\)/, "A normal ChatGPT SSE reconnect boundary must never revoke the public MCP session descriptor");
assert.doesNotMatch(gatewayRuntime, /MAX_RETAINED|MAX_REPLAY|idleRetention|timeoutPromise|setTimeout/, "Gateway public-session continuity must not impose artificial retention caps or wall-clock termination");
assert.match(gatewayProxy, /registry\.updateAuthorization\(publicSessionId, currentAuthorization\)/, "every authenticated session request must refresh the replay/schema-probe credential before later handover");
assert.match(gatewayProxy, /droppedPublicSessionIds[\s\S]*registry\.invalidateMapping\?\.\(session\.publicSessionId\)/, "one stale replay mapping must be isolated without deleting the lightweight public session descriptor");
assert.match(gatewayProxy, /resurrectionLocks[\s\S]*resurrectSession[\s\S]*registry\.commitMappings/, "Gateway must lazily resurrect an unmapped public MCP session exactly once while preserving public identity");
assert.match(gatewayProxy, /upstreamRes\.statusCode === 404[\s\S]*resurrectSession/, "only an exact downstream unknown-session response may trigger transparent lazy resurrection");
assert.match(gatewayProxy, /markEventStreamOpen[\s\S]*markEventStreamClosed/, "Gateway proxy must release public descriptors on actual downstream SSE disconnect");
assert.doesNotMatch(gatewayProxy, /setTimeout|setTimeout\(|requestTimeoutMs|Core request timed out/, "Gateway proxy must not terminate long Core or tool requests by wall clock");
assert.doesNotMatch(gatewayController, /drainTimeoutMs|requestTimeoutMs|waitForDrain\([^)]*\d|waitForOpen\([^)]*timeout/, "Core recovery and handover must wait for real request completion rather than a deadline");
assert.doesNotMatch(coreSlot, /Core readiness timed out|SIGKILL|max-old-space-size|max-semi-space-size/, "Core lifecycle must not cap heap, kill a slow startup, or force-kill long shutdown work");
assert.match(gatewayController, /droppedSessions/, "Core recovery and handover results must surface partial replay drops without marking a healthy replacement Core fatal");
assert.doesNotMatch(gatewayRuntime, /writeFile|persist.*authorization|authorization.*JSON\.stringify/i, "rotated replay credentials must remain memory-only");
assert.doesNotMatch(stableGateway, /console\.log\([^\n]*(controlToken|authorization|bearer)/i, "Gateway must never log control/replay credentials");

assert.match(backendReload, /__devspace\/gateway\/handover/, "reload helper must ask the stable Gateway to hand over Core slots");
assert.match(backendReload, /waitForStableGatewayQuiet/, "reload worker must wait for a real quiet boundary before requesting handover");
assert.match(backendReload, /__devspace\/gateway\/status/, "quiet-boundary probe must use the authenticated loopback Gateway status endpoint");
assert.match(gatewayQuiet, /admission[\s\S]*activeRequests/, "quiet-boundary helper must consume the Gateway HTTP request counter");
assert.match(gatewayQuiet, /sessions[\s\S]*totalActiveRequests/, "quiet-boundary helper must consume the MCP-session request counter");
assert.match(gatewayQuiet, /eventStreams[\s\S]*sessionActive\s*-\s*eventStreams/, "persistent replayable event streams must be excluded from the non-stream quiet-boundary counter");
assert.doesNotMatch(backendReload, /await delay\(2_000\)/, "reload worker must not rely on a fixed two-second delay before handover");
assert.doesNotMatch(backendReload, /AbortSignal\.timeout|quiet-timeout|timeoutMs/, "reload and handover must not fail because a quiet boundary or Core operation takes longer than a clock deadline");
assert.match(backendReload, /--worker/, "reload helper must detach before replacing the Core that served the triggering command");
assert.match(backendReload, /--status/, "reload helper must expose authoritative last-handover status instead of treating scheduled=true as completion");
assert.match(backendReload, /handoverId/, "scheduled and terminal handover records must share a unique correlation id");
assert.match(backendReload, /state:\s*"pending"/, "reload helper must write pending state before detaching");
assert.match(backendReload, /--allow-schema-change/, "schema-changing deployment must be explicit at the reload command boundary");
assert.match(backendReload, /JSON\.stringify\(\{ allowSchemaChange \}\)/,
  "the reload helper must send a bounded boolean authorization rather than bypassing the compatibility gate");
assert.doesNotMatch(backendReload, /restart-backend|devspace-edge-startup\.ps1|Stop-ScheduledTask/i, "reload helper must never restart the public listener/Scheduled Task boundary");

assert.match(fixedBackend, /--config-dir/, "Stable Gateway launcher must accept one explicit config directory for persistent startup ownership");
assert.match(fixedBackend, /stableGatewayPublicBaseUrl[\s\S]*edgePublicBaseUrl/, "fixed backend launcher must prefer generic Stable Gateway identity before legacy edge fallback");
assert.match(fixedBackend, /stableGatewayStateDir[\s\S]*edgeFixedStateDir/, "fixed backend launcher must prefer generic Stable Gateway state before legacy edge fallback");
assert.match(fixedBackend, /stableGatewayPort[\s\S]*edgeBackendPort/, "fixed backend launcher must prefer generic Stable Gateway port before legacy edge fallback");
assert.match(fixedBackend, /devspace-stable-gateway\.mjs/, "fixed backend launcher must start the long-lived Gateway instead of a Core directly");
assert.doesNotMatch(fixedBackend, /\["dist\/cli\.js",\s*"serve"\]/, "fixed backend launcher must not expose Core lifetime as the public listener lifetime");

assert.match(stableGatewayStartup, /ValidateSet\("install",\s*"status",\s*"remove",\s*"start",\s*"restart"\)/, "Stable Gateway lifecycle must expose a bounded self-upgrade restart action");
assert.match(stableGatewayStartup, /DevSpace-Stable-Gateway/, "Stable Gateway startup must use an independent Scheduled Task identity");
assert.match(stableGatewayStartup, /--foreground/, "Stable Gateway Scheduled Task must own the foreground Gateway lifetime");
assert.match(stableGatewayStartup, /--config-dir/, "Stable Gateway Scheduled Task must bind to one explicit config directory");
assert.match(stableGatewayStartup, /New-ScheduledTaskTrigger -AtLogOn|MSFT_TaskLogonTrigger/, "Stable Gateway must start automatically at logon");
assert.match(stableGatewayStartup, /ExecutionTimeLimit[^\n]*(Seconds 0|TimeSpan::Zero)|New-TimeSpan -Seconds 0/, "Stable Gateway Scheduled Task must not have a short execution timeout");
assert.doesNotMatch(stableGatewayStartup, /(?:Stop|Start|Unregister)-ScheduledTask[^\n]*(?:DevSpace-Fixed-Edge-Tunnel|DevSpace-Fixed-Backend)/i, "Stable Gateway startup must not mutate legacy edge tasks");
assert.match(stableGatewayStartup, /Get-NetTCPConnection[\s\S]*7678|GatewayPort/, "restart must verify the dedicated Gateway/Core listeners rather than killing arbitrary Node processes");
assert.match(stableGatewayStartup, /CommandLine[\s\S]*devspace|dist\\cli\.js/, "restart must verify DevSpace process identity before terminating orphan Core listeners");
assert.match(stableGatewayStartup, /Invoke-GatewayHelper -Status/, "restart must wait for authoritative new Gateway health before reporting success");
assert.doesNotMatch(stableGatewayStartup, /CLOUDFLARE_API_TOKEN|ownerToken|access_token|refresh_token/i, "Stable Gateway startup must not persist credentials");

assert.ok(packageJson.scripts?.["verify:stable-gateway"], "package.json must expose a focused stable-gateway verification command");
assert.match(packageJson.scripts["verify:stable-gateway"], /stable-gateway-runtime\.test\.js/);
assert.match(packageJson.scripts["verify:stable-gateway"], /stable-gateway-proxy\.test\.js/);
assert.match(packageJson.scripts["verify:stable-gateway"], /stable-gateway-candidate\.test\.js/);
assert.match(packageJson.scripts["verify:stable-gateway"], /stable-gateway-handover-gate\.mjs/);
assert.ok(packageJson.scripts?.["verify:stable-gateway:soak"], "package.json must expose the opt-in real-Core session churn/OOM soak gate");
assert.match(packageJson.scripts["verify:stable-gateway:soak"], /stable-gateway-real-core-canary\.mjs --soak/);
assert.match(packageJson.scripts["verify:ultra"], /verify:stable-gateway/, "full Ultra verification must include the stable Gateway gate");

assert.match(handoverGate, /productionPidsUnchanged|productionPortsUnchanged/, "handover integration gate must explicitly prove production runtimes are untouched");
assert.match(handoverGate, /rollback/i, "handover integration gate must exercise rollback");
assert.match(handoverGate, /explicitSchemaChangeControl/i, "handover integration must exercise explicit schema-change control forwarding");

console.log(JSON.stringify({ ok: true, gate: "stable-gateway-static" }));
