import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [clone, controller, updateManager, runtime, identity, continuity, sessionSeed, chatSwarm, handover, bootstrap] = await Promise.all([
  read("scripts/chat-swarm-classic-runtime-clone.ps1"),
  read("scripts/chat-swarm-classic-controller.ps1"),
  read("scripts/chat-swarm-classic-update-manager.ps1"),
  read("dist/chat-swarm-classic-runtime.js"),
  read("scripts/chat-swarm-classic-runtime-identity.ps1"),
  read("dist/conversation-continuity.js"),
  read("scripts/chat-swarm-classic-session-seed.mjs"),
  read("dist/chat-swarm.js"),
  read("scripts/devspace-server-handover.mjs"),
  read("scripts/chat-swarm-classic-cdp-bootstrap.mjs"),
]);

// Worker packages must never own global Primary launch surfaces.
assert.match(clone, /AppListEntry", "none"/);
assert.match(clone, /SetAttribute\("Id", "DevSpaceWorker"\)/);
assert.match(clone, /Only Primary may own !ChatGPT/);
assert.match(clone, /windows\.protocol/);
assert.match(clone, /Remove-XmlNodes[^\n]+windows\.protocol/);
assert.match(clone, /Remove-XmlNodes[^\n]+windows\.startupTask/);
assert.match(clone, /Remove-XmlNodes[^\n]+windows\.appExtension/);
assert.match(clone, /pending-running/);
assert.match(clone, /RepairExisting/);
assert.match(clone, /PreserveApplicationData/);

// Protection is persistent and enforced at the lowest destructive stop path.
assert.match(controller, /protectedWorkers/);
assert.match(controller, /function Assert-WorkerMutable/);
assert.match(controller, /function Stop-WorkerRuntime[\s\S]*?Assert-WorkerMutable -Runtime \$Runtime -Operation "stop"/);
assert.match(controller, /protected-skip/);
assert.match(controller, /"plan"/);
assert.match(controller, /ProductionWorkerNumbers/);
assert.match(controller, /Get-ProtectedWorkerNumbers/);
assert.match(controller, /function Ensure-WorkerAuthenticated/);
assert.match(controller, /Find-SessionSeedSource/);
assert.match(controller, /Seed-WorkerSession/);
assert.doesNotMatch(controller, /function Ensure-AuthSeed/);
assert.doesNotMatch(controller, /function Apply-AuthSeed/);

// Update/canary paths are protected independently from normal controller stop.
assert.match(updateManager, /function Assert-NotProtected/);
assert.match(updateManager, /Assert-NotProtected -Number \$CanaryWorker/);
assert.match(updateManager, /Assert-NotProtected -Number \$number -Operation "update rollout"/);

// Node orchestration must consume the live controller plan, not re-derive [1..N].
assert.match(runtime, /export async function planClassicRuntimePool/);
assert.match(runtime, /runController\("plan"/);
assert.match(runtime, /const runtimePlan = await planClassicRuntimePool/);
assert.match(runtime, /runtimeNumbers: result\.runtimeNumbers/);
assert.match(runtime, /chat_swarm_runtime_identity_status/);
assert.match(runtime, /chat_swarm_runtime_identity_repair/);

// Logon guard identifies protocol misrouting, protects a running owner, and makes Primary visible.
assert.match(identity, /Invoke-PowerShellChild/);
assert.match(identity, /ErrorActionPreference = "Continue"/);
assert.match(identity, /Protect-MisroutedProtocolWorker/);
assert.match(identity, /Get-CurrentProtocolClaims/);
assert.match(identity, /primary-current/);
assert.match(identity, /worker-stale/);
assert.match(identity, /stale-unknown/);
assert.match(identity, /NeedsUserDefaultRepair/);
assert.match(identity, /protocol\.State -eq "primary-current"/);
assert.match(identity, /WorkerIsolationSafe/);
assert.match(identity, /ProtocolCanonical/);
assert.match(identity, /windows-chatgpt-protocol-default-owner/);
assert.match(identity, /MainWindowHandle/);
assert.match(identity, /chatgpt-classic\.exe/);
assert.match(identity, /MSFT_TaskLogonTrigger|New-ScheduledTaskTrigger -AtLogOn/);
assert.match(identity, /DevSpace-ChatGPT-Worker-Identity-Heal/);
assert.match(identity, /RepetitionInterval.*Minutes 10|New-TimeSpan -Minutes 10/);
assert.match(identity, /pending-running/);

// CDP Session Seed transfers only allowlisted ChatGPT/OpenAI cookies in memory,
// verifies source/target UI state, and never logs cookie values.
assert.match(sessionSeed, /Network\.getAllCookies/);
assert.match(sessionSeed, /Network\.setCookies/);
assert.match(sessionSeed, /Network\.deleteCookies/);
assert.match(sessionSeed, /clearAllowlistedTargetCookies/);
assert.match(sessionSeed, /allowedCookieDomain/);
assert.match(sessionSeed, /secretValuesLogged: false/);
assert.doesNotMatch(sessionSeed, /console\.log\([^\n]*(?:cookie\.value|\.value\))/i);

// Auto Compact may never rotate a protected interactive runtime and must support
// stale MCP catalogs by redeeming continuation tickets through chat_swarm_join.
assert.match(continuity, /protected-interactive-runtime/);
assert.match(continuity, /automatic conversation rotation is disabled/);
assert.match(continuity, /buildAutomaticCapsule/);
assert.match(continuity, /prepareContinuationByLabel/);
assert.match(continuity, /chat_swarm_join/);
assert.match(chatSwarm, /continuationResumed/);
assert.match(chatSwarm, /pendingContinuation/);
assert.match(chatSwarm, /SESSION_BOUND_CONTINUATION/);
assert.match(chatSwarm, /sessionBound/);
assert.match(continuity, /backendLedgerTokens/);
assert.match(continuity, /observedTokens/);
assert.match(bootstrap, /Stable server conversation URL/);
assert.match(bootstrap, /WEB\|TEMP\|LOCAL/);

// Server hot handover must kill only the old DevSpace Node PID. `/T` would
// terminate the detached helper itself before it can spawn the replacement.
assert.match(handover, /taskkill\.exe/);
assert.doesNotMatch(handover, /["']\/T["']/);

console.log(JSON.stringify({
  ok: true,
  workerGlobalLaunchIsolation: true,
  workerAumidIsolation: true,
  staleProtocolChoiceDetection: true,
  protectedStopGuard: true,
  memoryOnlySessionSeed: true,
  staleTargetCookieReplacement: true,
  protectedUpdateGuard: true,
  controllerPlanAuthoritative: true,
  protocolMisrouteBootGuard: true,
  deferredIdentitySelfHeal: true,
  protectedAutoCompactGuard: true,
  sessionBoundWorkerAuth: true,
  canonicalConversationPersistence: true,
  safeServerHandover: true,
  cachedToolSchemaContinuation: true,
}));
