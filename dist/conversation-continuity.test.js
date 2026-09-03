import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatSwarmCoordinator } from "./chat-swarm.js";
import {
  ConversationContinuityRuntime,
  contextPressure,
  estimateVisibleConversationTokens,
  normalizeCompactCapsule,
  shouldAutomaticCompactHandoff,
} from "./conversation-continuity.js";

const root = await mkdtemp(join(tmpdir(), "devspace-auto-compact-"));
try {
  // Threshold gate: the policy is evaluated against estimated effective usage,
  // including an explicit hidden/tool reserve. 90% is inclusive.
  const stats = { cjkChars: 0, asciiChars: 3_200, otherNonAsciiChars: 0, whitespaceChars: 0, messageCount: 0 };
  assert.equal(estimateVisibleConversationTokens(stats), 1_000);
  const below = contextPressure(stats, { contextWindowTokens: 10_000, reserveTokens: 7_999, threshold: 0.90 });
  assert.equal(below.estimatedTokens, 8_999);
  assert.equal(below.shouldCompact, false);
  const at = contextPressure(stats, { contextWindowTokens: 10_000, reserveTokens: 8_000, threshold: 0.90 });
  assert.equal(at.estimatedTokens, 9_000);
  assert.equal(at.utilization, 0.9);
  assert.equal(at.shouldCompact, true);

  // GPT-5.6 Sol production baseline: the absolute 1.05M window has a 945K
  // 90% trigger. Reserve is included in estimated usage, not subtracted before
  // computing that trigger.
  const solWindow = contextPressure({ asciiChars: 0 }, { contextWindowTokens: 1_050_000, reserveTokens: 32_000, threshold: 0.90 });
  assert.equal(solWindow.triggerTokens, 945_000);
  assert.equal(solWindow.estimatedTokens, 32_000);
  assert.equal(solWindow.contextWindowTokens, 1_050_000);
  const ledgerDominatesVirtualizedDom = contextPressure({ asciiChars: 0 }, {
    contextWindowTokens: 10_000,
    reserveTokens: 1_000,
    threshold: 0.90,
    backendLedgerTokens: 8_000,
  });
  assert.equal(ledgerDominatesVirtualizedDom.visibleTokens, 0);
  assert.equal(ledgerDominatesVirtualizedDom.backendLedgerTokens, 8_000);
  assert.equal(ledgerDominatesVirtualizedDom.observedTokens, 8_000);
  assert.equal(ledgerDominatesVirtualizedDom.shouldCompact, true);

  // Idle compact-required workers are automatically handed off by the backend,
  // with a retry debounce. Generating or in-flight workers stay untouched.
  assert.equal(shouldAutomaticCompactHandoff({ compactRequired: true, generating: false }), true);
  assert.equal(shouldAutomaticCompactHandoff({ compactRequired: true, generating: true }), false);
  assert.equal(shouldAutomaticCompactHandoff({ compactRequired: true, generating: false, inFlightTaskId: "task_busy" }), false);
  assert.equal(shouldAutomaticCompactHandoff({ compactRequired: false, generating: false }), false);
  assert.equal(shouldAutomaticCompactHandoff({ compactRequired: true, generating: false, lastAttemptAt: new Date(90_000).toISOString(), now: 100_000, cooldownMs: 60_000 }), false);
  assert.equal(shouldAutomaticCompactHandoff({ compactRequired: true, generating: false, lastAttemptAt: new Date(30_000).toISOString(), now: 100_000, cooldownMs: 60_000 }), true);

  // Conservative multilingual estimator must count CJK more heavily than equal
  // numbers of prose ASCII characters.
  assert.ok(estimateVisibleConversationTokens({ cjkChars: 1_000 }) > estimateVisibleConversationTokens({ asciiChars: 1_000 }));

  // Capsule redaction/bounds: continuation state may contain paths and decisions,
  // but credentials must never be copied into the fresh conversation.
  const capsule = normalizeCompactCapsule({
    goal: "Continue release work",
    currentState: "Bearer testtoken1234567 and workerToken=abcdefghijklmnopqrstuvwx",
    decisions: ["Keep exact project state", "api_key=super-secret-value-123456789"],
    nextSteps: ["run tests", "finish handoff"],
  });
  const capsuleText = JSON.stringify(capsule);
  assert.match(capsuleText, /REDACTED_SECRET/);
  assert.doesNotMatch(capsuleText, /testtoken1234567/);
  assert.doesNotMatch(capsuleText, /super-secret-value/);

  // Generic/non-managed checkpoint persistence and restore.
  const controllerPath = join(root, "controller-state.json");
  await writeFile(controllerPath, `\uFEFF${JSON.stringify({ version: 4, workers: [] })}`, "utf8");
  const runtime = new ConversationContinuityRuntime({
    enabled: false,
    stateDir: join(root, "continuity-state"),
    controllerStatePath: controllerPath,
  });
  assert.equal((await runtime.status({})).workers.length, 0);
  const saved = await runtime.checkpoint({
    continuityKey: "main-task",
    goal: "Implement a very long task",
    currentState: "phase 2 complete",
    nextSteps: ["phase 3"],
  });
  assert.equal(saved.automaticHandoff, false);
  assert.ok(saved.capsuleId.startsWith("capsule_"));
  let restored = await runtime.loadCapsule(saved.capsuleId);
  assert.equal(restored.capsule.goal, "Implement a very long task");
  assert.equal(runtime.latestCapsule("main-task").id, saved.capsuleId);
  await runtime.updateCapsuleMeta(saved.capsuleId, { status: "verified-test" });
  restored = await runtime.loadCapsule(saved.capsuleId);
  assert.equal(restored.status, "verified-test");
  assert.equal(runtime.latestCapsule("main-task").status, "verified-test");
  await runtime.close();

  // Protected interactive runtimes are surfaced explicitly so watchdog/rotation
  // policy can hard-skip a ChatGPT window that is temporarily acting as Primary.
  const protectedControllerPath = join(root, "protected-controller-state.json");
  await writeFile(protectedControllerPath, `\uFEFF${JSON.stringify({
    version: 5,
    protectedWorkers: [4],
    workers: [{ number: 4, label: "Runtime-04", debugPort: 9334, conversationUrl: "https://chatgpt.com/c/protected" }],
  })}`, "utf8");
  const protectedRuntime = new ConversationContinuityRuntime({
    enabled: false,
    stateDir: join(root, "protected-continuity-state"),
    controllerStatePath: protectedControllerPath,
  });
  const protectedStatus = await protectedRuntime.status({ worker: 4 });
  assert.equal(protectedStatus.workers[0].protected, true);
  await protectedRuntime.close();

  // Fresh ChatGPT workers can be session-bound from the first join, so a raw
  // workerToken never needs to cross the ChatGPT tool-result surface.
  const boundDir = join(root, "bound-worker");
  const boundCoordinator = new ChatSwarmCoordinator({ stateDir: boundDir });
  const boundCreated = await boundCoordinator.create({ name: "bound", workerSlots: 1, peer: { identitySource: "test" } });
  const boundPeer = { identitySource: "openai/session", identityFingerprint: "bound-peer-1" };
  const boundJoin = await boundCoordinator.join({ inviteCode: boundCreated.inviteCode, label: "Runtime-29", peer: boundPeer, sessionBound: true });
  assert.equal(boundJoin.sessionBound, true);
  assert.equal(boundJoin.workerToken, undefined);
  const boundTask = await boundCoordinator.dispatch({
    orchestratorToken: boundCreated.orchestratorToken,
    tasks: [{ prompt: "session-bound normal join", targetWorkerId: boundJoin.workerId, taskKey: "bound-normal" }],
  });
  const boundClaim = await boundCoordinator.next({ peer: boundPeer, waitMs: 0 });
  assert.equal(boundClaim.task.taskId, boundTask.tasks[0].taskId);
  await boundCoordinator.submit({ peer: boundPeer, taskId: boundClaim.task.taskId, status: "completed", result: "bound-ok", waitForNextMs: 0 });
  assert.equal((await boundCoordinator.status(undefined, boundPeer)).workerId, boundJoin.workerId);
  await boundCoordinator.closeSwarm({ orchestratorToken: boundCreated.orchestratorToken, cancelPending: true });
  await boundCoordinator.close();

  // Chat Swarm continuation: backend marks compaction externally, a parked worker
  // receives compact_required, and a one-time ticket rotates the private worker
  // token while preserving worker identity. The old token and reused ticket fail.
  const swarmDir = join(root, "swarm");
  const coordinator = new ChatSwarmCoordinator({ stateDir: swarmDir });
  const created = await coordinator.create({ name: "continuity", workerSlots: 1, peer: { identitySource: "test" } });
  const joined = await coordinator.join({ inviteCode: created.inviteCode, label: "Runtime-31", peer: { identitySource: "old-conversation" } });
  const oldToken = joined.workerToken;

  await coordinator.markCompactRequiredByLabel("Runtime-31", { utilization: 0.91, utilizationPercent: 91 });
  const compact = await coordinator.next({ workerToken: oldToken, waitMs: 0 });
  assert.equal(compact.state, "compact_required");
  assert.equal(compact.workerId, joined.workerId);
  assert.equal((await coordinator.reserveWorkerWake(oldToken)).state, "compact_required");

  const continuation = await coordinator.prepareContinuationByWorkerToken(oldToken);
  assert.ok(continuation.continuationTicket.length >= 16);
  await coordinator.setContinuationContextEstimate(continuation.continuationId, 2_345);
  // Fresh conversations redeem through the long-existing chat_swarm_join schema,
  // so stale MCP catalogs do not need a newly registered resume tool name.
  const freshPeer = { identitySource: "openai/session", identityFingerprint: "fresh-peer-1" };
  const resumed = await coordinator.join({ inviteCode: continuation.continuationTicket, label: "Runtime-31", peer: freshPeer });
  assert.equal(resumed.continuationResumed, true);
  assert.equal(resumed.sessionBound, true);
  assert.equal(resumed.workerId, joined.workerId);
  assert.equal(resumed.workerToken, undefined);
  assert.equal(resumed.continuationCount, 1);
  await assert.rejects(() => coordinator.status(oldToken), /Invalid or inactive worker token/);
  const resumedStatus = await coordinator.status(undefined, freshPeer);
  assert.equal(resumedStatus.workerId, joined.workerId);
  assert.equal(resumedStatus.workers.find((item) => item.workerId === joined.workerId)?.contextLedgerTokens, 2_345);
  // Older cached schemas may still require a syntactically token-like field.
  // A fixed public sentinel is accepted only when the backend-observed MCP
  // session fingerprint matches the bound continuation; it is not a secret.
  const sentinelStatus = await coordinator.status("SESSION_BOUND_CONTINUATION", freshPeer);
  assert.equal(sentinelStatus.workerId, joined.workerId);
  await assert.rejects(
    () => coordinator.status("SESSION_BOUND_CONTINUATION", { identitySource: "openai/session", identityFingerprint: "wrong-peer" }),
    /No active session-bound Chat Swarm continuation/,
  );
  await assert.rejects(
    () => coordinator.status(undefined, { identitySource: "openai/session", identityFingerprint: "wrong-peer" }),
    /No active session-bound Chat Swarm continuation/,
  );
  await assert.rejects(
    () => coordinator.join({ inviteCode: continuation.continuationTicket, label: "Runtime-31", peer: {} }),
    /Invite code is invalid|Invalid or expired conversation continuation ticket/,
  );
  assert.equal((await coordinator.continuationStatus(continuation.continuationId)).state, "resumed");

  // A worker actively executing a claimed task cannot be rotated mid-operation.
  const task = await coordinator.dispatch({
    orchestratorToken: created.orchestratorToken,
    tasks: [{ prompt: "atomic operation", targetWorkerId: joined.workerId, taskKey: "atomic" }],
  });
  const claimed = await coordinator.next({ peer: freshPeer, waitMs: 0 });
  assert.equal(claimed.task.taskId, task.tasks[0].taskId);
  const afterClaimLedger = (await coordinator.status(undefined, freshPeer)).workers.find((item) => item.workerId === joined.workerId)?.contextLedgerTokens;
  assert.ok(afterClaimLedger > 2_345);
  await assert.rejects(() => coordinator.prepareContinuationByLabel("Runtime-31"), /in-flight task/);
  await coordinator.submit({ peer: freshPeer, taskId: claimed.task.taskId, status: "completed", result: "done", waitForNextMs: 0 });
  const afterSubmitLedger = (await coordinator.status(undefined, freshPeer)).workers.find((item) => item.workerId === joined.workerId)?.contextLedgerTokens;
  assert.ok(afterSubmitLedger > afterClaimLedger);

  // Wake-race gate: a worker parked before the mark is woken specifically for
  // compaction and does not claim a subsequent task first.
  const parked = coordinator.next({ peer: freshPeer, waitMs: 2_000 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await coordinator.markCompactRequiredByLabel("Runtime-31", { utilization: 0.95 });
  const parkedResult = await parked;
  assert.equal(parkedResult.state, "compact_required");

  await coordinator.closeSwarm({ orchestratorToken: created.orchestratorToken, cancelPending: true });
  await coordinator.close();

  console.log(JSON.stringify({
    ok: true,
    threshold90Inclusive: true,
    conservativeEstimator: true,
    automaticHandoffDebounce: true,
    capsuleSecretRedaction: true,
    windowsBomControllerJson: true,
    genericCheckpointRestore: true,
    capsuleMetadataDurability: true,
    protectedRuntimeSurface: true,
    backendContextLedger: true,
    compactRequiredWake: true,
    oneTimeContinuationTicket: true,
    cachedJoinSchemaContinuation: true,
    workerIdentityPreserved: true,
    sessionBoundNormalJoin: true,
    sessionBoundContinuation: true,
    cachedSchemaSentinel: true,
    noContinuationSecretOutput: true,
    workerTokenRotated: true,
    oldTokenInvalidated: true,
    ticketReplayBlocked: true,
    midTaskRotationBlocked: true,
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
