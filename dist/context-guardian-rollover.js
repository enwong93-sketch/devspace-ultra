import { attachAutoCompactContract, validateAutoCompactContinuation } from "./auto-compact-contract.js";
import { estimateClassicInputTokens } from "./context-guardian-cdp.js";

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_ROUTE_SETTLE_MS = 3_000;
const PREPARE_REUSE_MS = 30_000;
const NATIVE_STRUCTURAL_SEED_TTL_MS = 60_000;
const DESCRIPTOR_FAILURE_COOLDOWN_MS = 60_000;
const MAX_FAILURE_CIRCUITS = 64;

function clip(value, max = 2_400) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function currentStep(plan) {
  return plan?.steps?.find((step) => step.status === "in_progress") || null;
}

function stableHydratedConversationRoute(snapshot, settleMs = DEFAULT_ROUTE_SETTLE_MS) {
  return Boolean(
    snapshot?.ok
    && snapshot?.mode !== "work"
    && snapshot?.conversationId
    && snapshot?.documentReadyState === "complete"
    && snapshot?.composerReady === true
    && snapshot?.routeHydrated === true
    && Number(snapshot?.routeStableForMs || 0) >= Math.max(0, Number(settleMs) || 0)
  );
}

function pressureSummary(context) {
  const pressure = context?.pressure || {};
  return [
    `model=${context?.currentModelSlug || "unresolved"}`,
    `window=${context?.contextWindowTokens ?? "unresolved"}`,
    `usageSource=${pressure.usageSource || "unresolved"}`,
    `used=${pressure.usedTokens ?? "unresolved"}`,
    `predicted=${pressure.predictedInputTokens ?? "unresolved"}`,
    `rolloverLimit=${pressure.rolloverLimitTokens ?? "unresolved"}`,
    `stage=${pressure.stage || "unresolved"}`,
  ].join("; ");
}

export function buildMainCompactCapsule({ runtimeKey, goal, plan, context, recentMessages = [] } = {}) {
  const completedSteps = (plan?.steps || []).filter((step) => step.status === "completed");
  const remainingSteps = (plan?.steps || []).filter((step) => step.status !== "completed");
  const reportHistory = Array.isArray(goal?.recentReports) ? goal.recentReports.slice(-6) : [];
  const activeStep = currentStep(plan);
  const recent = (Array.isArray(recentMessages) ? recentMessages : [])
    .slice(-8)
    .map((message) => `${message.role || "message"}: ${clip(message.text, 2_000)}`)
    .filter(Boolean)
    .join("\n");

  const objective = clip(goal?.objective, 6_000)
    || clip(plan?.title, 1_000)
    || "Continue the same ChatGPT Classic task after a Context Guardian rollover without repeating completed work.";
  const constraints = [
    ...(goal?.successCriteria || []).map((criterion) => clip(criterion?.text, 1_800)).filter(Boolean),
    "ChatGPT Classic Chat mode only; never switch to Work mode.",
    "Preserve backend Goal/Plan truth and do not repeat completed steps unless current live evidence requires re-validation.",
  ];
  const completed = [
    ...completedSteps.map((step) => `Plan completed: ${step.id} — ${clip(step.text, 1_800)}`),
    ...reportHistory.map((report) => `Goal round ${report.round} reported: ${clip(report.summary, 2_000)}`),
  ];
  const nextSteps = remainingSteps.length
    ? remainingSteps.map((step) => `${step.status}: ${step.id} — ${clip(step.text, 1_800)}`)
    : ["Continue the current user task from the preserved Goal/current-state frontier and re-check live volatile state before acting."];
  const currentState = [
    `runtime=${runtimeKey || "unknown"}`,
    goal ? `Goal ${goal.id}: status=${goal.status}; round ${goal.round}; roundState=${goal.roundState}; revision=${goal.revision ?? "unknown"}` : "No active Goal was resolved for this runtime.",
    plan ? `Plan ${plan.id}: ${plan.title}; revision=${plan.revision ?? "unknown"}; current=${activeStep?.id || "none"}` : "No active Plan was resolved for this runtime.",
    `Context Guardian: ${pressureSummary(context)}`,
  ].join("\n");
  const toolState = [
    ...(goal ? [`goalId=${goal.id}`, `goalRound=${goal.round}`, `goalRoundState=${goal.roundState}`, `goalRevision=${goal.revision ?? "unknown"}`] : []),
    ...(plan ? [`planId=${plan.id}`, `planRevision=${plan.revision ?? "unknown"}`, `planCurrentStep=${activeStep?.id || "none"}`] : []),
    `do-not-redo: ${(completedSteps.map((step) => step.id).join(",") || "none")}`,
  ];
  return {
    goal: objective,
    userIntent: objective,
    constraints,
    decisions: plan?.lastExplanation ? [clip(plan.lastExplanation, 2_000)] : [],
    completed,
    currentState,
    tests: [],
    blockers: [],
    nextSteps,
    toolState,
    notes: recent
      ? `Recent bounded visible context from the old ChatGPT Classic conversation:\n${recent}`
      : "Recent bounded visible context was unavailable; rely on Goal/Plan backend state and re-check volatile live state.",
  };
}

function compactPrompt(record, { goal, sameRound = false, continuationPrompt } = {}) {
  const capsule = record?.capsule || record;
  const lines = [
    "[DEVSPACE_AUTO_COMPACT_CONTINUATION]",
    "This is hidden Context Guardian maintenance, not a new user request. Continue the same user-facing ChatGPT Classic conversation through a compact backend continuation branch. The backend conversation id may change, but the UI continuity key, Goal/Plan authority and unfinished work must remain continuous.",
    "Use only the selective capsule below. Do not reconstruct or inherit the full old transcript/tool history, and do not treat this as a zero-context new task.",
  ];
  if (goal && sameRound) {
    lines.push(`Continue the same working Goal round ${goal.round} for ${goal.id}. Do not call devspace_goal_round_begin. Read current Goal and Plan state, continue meaningful unfinished work, and call devspace_goal_turn_report only when this Goal round is actually ready to report.`);
  } else if (goal?.roundState === "reported" && continuationPrompt) {
    lines.push("This rollover is carrying an already-authorized Goal continuation into the fresh conversation. Follow the DEVSPACE_GOAL_CONTINUATION instructions after reading the compact capsule.");
  } else {
    lines.push("Read current DevSpace Goal/Plan state when available, preserve the execution frontier, and continue from the compact capsule without repeating completed work.");
  }
  lines.push("Treat the capsule as handoff state, not as a substitute for current live verification.");
  lines.push("DEVSPACE_COMPACT_CAPSULE_BEGIN");
  lines.push(JSON.stringify(capsule, null, 2));
  lines.push("DEVSPACE_COMPACT_CAPSULE_END");
  if (continuationPrompt) lines.push(String(continuationPrompt));
  return lines.join("\n\n");
}

export class ContextGuardianRolloverCoordinator {
  constructor({
    contextGuardian,
    contextAdapter,
    continuityRuntime,
    goalRuntime,
    planRuntime,
    resolveGoalRuntimeKey,
    onVerifiedRollover,
    pollMs = DEFAULT_POLL_MS,
    routeSettleMs = DEFAULT_ROUTE_SETTLE_MS,
  } = {}) {
    if (!contextGuardian || !contextAdapter || !continuityRuntime || !goalRuntime || !planRuntime) {
      throw new Error("ContextGuardianRolloverCoordinator requires Context Guardian, CDP adapter, continuity, Goal, and Plan runtimes.");
    }
    this.contextGuardian = contextGuardian;
    this.contextAdapter = contextAdapter;
    this.continuityRuntime = continuityRuntime;
    this.goalRuntime = goalRuntime;
    this.planRuntime = planRuntime;
    this.resolveGoalRuntimeKey = typeof resolveGoalRuntimeKey === "function" ? resolveGoalRuntimeKey : null;
    this.onVerifiedRollover = typeof onVerifiedRollover === "function" ? onVerifiedRollover : null;
    this.pollMs = Math.max(0, Number(pollMs) || 0);
    this.routeSettleMs = Math.max(0, Number(routeSettleMs) || 0);
    this.timer = null;
    this.polling = null;
    this.closed = false;
    this.prepared = new Map();
    this.nativeSeedCache = new Map();
    this.descriptorFailures = new Map();
    this.compactFailures = new Map();
    this.committing = new Set();
    this.preparationVersions = new Map();
  }

  async start({ schedule = true } = {}) {
    const first = await this.pollOnce();
    if (this.continuityRuntime.enabled !== true) return first;
    if (schedule && !this.closed && this.pollMs > 0 && !this.timer) {
      this.timer = setInterval(() => { void this.pollOnce().catch(() => {}); }, this.pollMs);
      this.timer.unref?.();
    }
    return first;
  }

  async #resolvePlan(conversationId) {
    const plans = await this.planRuntime.activePlans({ limit: 12, conversationId });
    return plans[0] || null;
  }

  async #resolveGoal(conversationId) {
    const goals = await this.goalRuntime.activeGoals({ limit: 12, conversationId });
    return goals[0] || null;
  }

  #uiContinuityKey({ goal, plan, runtimeKey } = {}) {
    if (goal?.id) return `goal:${goal.id}`;
    if (plan?.id) return `plan:${plan.id}`;
    return `runtime:${runtimeKey || "unknown"}`;
  }

  async #refresh(runtimeKey) {
    const snapshot = await this.contextAdapter.refreshSnapshot(runtimeKey);
    if (snapshot?.ok && typeof this.contextGuardian.observeRuntimeSnapshot === "function") {
      await this.contextGuardian.observeRuntimeSnapshot({
        runtimeKey,
        modelSlug: snapshot.modelSlug,
        conversationId: snapshot.conversationId,
        mode: snapshot.mode,
        observedTokens: snapshot.observedTokens,
        observedAt: new Date().toISOString(),
      });
    }
    return snapshot;
  }

  async #nativeDescriptor(runtimeKey, conversationId, { force = false } = {}) {
    if (typeof this.contextAdapter.nativeConversationDescriptor !== "function") return null;
    const id = String(conversationId || "").trim();
    if (!id) return null;
    const now = Date.now();
    const failureKey = JSON.stringify([runtimeKey, id]);
    const failed = this.descriptorFailures.get(failureKey);
    if (failed?.conversationId === id && now < failed.retryAfterMs) {
      const error = new Error("Native descriptor failure circuit is open for this conversation.");
      error.code = "NATIVE_DESCRIPTOR_CIRCUIT_OPEN";
      throw error;
    }
    this.descriptorFailures.delete(failureKey);
    const cached = this.nativeSeedCache.get(runtimeKey);
    if (!force && cached?.conversationId === id && now - cached.observedAtMs < NATIVE_STRUCTURAL_SEED_TTL_MS) {
      return cached.descriptor;
    }
    let descriptor;
    try {
      descriptor = await this.contextAdapter.nativeConversationDescriptor(runtimeKey);
      if (!descriptor?.conversationId || descriptor.conversationId !== id) {
        throw new Error("Native structural descriptor does not match the current Context Guardian conversation.");
      }
    } catch (error) {
      this.descriptorFailures.set(failureKey, { conversationId: id, retryAfterMs: Date.now() + DESCRIPTOR_FAILURE_COOLDOWN_MS });
      while (this.descriptorFailures.size > MAX_FAILURE_CIRCUITS) this.descriptorFailures.delete(this.descriptorFailures.keys().next().value);
      throw error;
    }
    this.nativeSeedCache.set(runtimeKey, {
      conversationId: id,
      observedAtMs: now,
      descriptor,
    });
    return descriptor;
  }

  async #ensureNativeSeed(runtimeKey, snapshot, context) {
    // Exact host usage may be unavailable after Core restart even though the
    // existing ChatGPT conversation is already large. Use one sanitized,
    // authenticated structural descriptor as a conservative snapshot seed.
    // This affects pressure timing only; it is never relabelled exact usage.
    if (!snapshot?.ok || snapshot?.mode === "work" || !snapshot?.conversationId) return { snapshot, context };
    const descriptor = await this.#nativeDescriptor(runtimeKey, snapshot.conversationId);
    const structuralTokens = Number(descriptor?.estimatedTokens);
    const existingUsed = Number(context?.pressure?.usedTokens ?? 0);
    if (!Number.isFinite(structuralTokens) || structuralTokens <= 0 || structuralTokens <= existingUsed) {
      return { snapshot, context, descriptor };
    }
    if (typeof this.contextGuardian.observeRuntimeSnapshot === "function") {
      await this.contextGuardian.observeRuntimeSnapshot({
        runtimeKey,
        modelSlug: descriptor?.defaultModelSlug || snapshot.modelSlug,
        conversationId: snapshot.conversationId,
        mode: snapshot.mode,
        observedTokens: Math.floor(structuralTokens),
        observedAt: new Date().toISOString(),
      });
    }
    const refreshedContext = await this.contextGuardian.status(runtimeKey);
    return {
      snapshot: {
        ...snapshot,
        observedTokens: Math.floor(structuralTokens),
        messageCount: Number(descriptor?.branchMessageCount || snapshot?.messageCount || 0),
        nativeSnapshot: true,
        structuralSnapshot: true,
      },
      context: refreshedContext,
      descriptor,
    };
  }

  async #checkpoint({ runtimeKey, goal, plan, context, recentMessages, mode = "user-turn", force = false, preparationVersion = this.preparationVersions.get(runtimeKey) || 0 }) {
    this.#assertPreparationCurrent(runtimeKey, preparationVersion);
    const used = Number(context?.pressure?.usedTokens ?? 0);
    const prior = this.prepared.get(runtimeKey);
    const now = Date.now();
    if (!force && prior && prior.conversationId === context?.conversationId && prior.mode === mode && now - prior.preparedAt < PREPARE_REUSE_MS && Math.abs(used - prior.usedTokens) < 4_096) {
      return prior.record;
    }
    const sourceDescriptor = await this.#nativeDescriptor(runtimeKey, context?.conversationId);
    this.#assertPreparationCurrent(runtimeKey, preparationVersion);
    if (!sourceDescriptor?.conversationId || sourceDescriptor.conversationId !== context?.conversationId || !sourceDescriptor.currentNode) {
      throw new Error("Auto Compact source descriptor does not match the current Context Guardian conversation.");
    }
    const baseCapsule = buildMainCompactCapsule({ runtimeKey, goal, plan, context, recentMessages });
    const exactUsage = /classic-native-(?:protocol|actual)/i.test(String(context?.pressure?.usageSource || ""))
      ? Number(context?.pressure?.usedTokens)
      : undefined;
    const uiContinuityKey = this.#uiContinuityKey({ goal, plan, runtimeKey });
    const capsule = attachAutoCompactContract(baseCapsule, {
      source: {
        ...sourceDescriptor,
        exactUsedTokens: Number.isSafeInteger(exactUsage) && exactUsage >= 0 ? exactUsage : undefined,
      },
      uiContinuityKey,
      runtimeKey,
      goalId: goal?.id || null,
      planId: plan?.id || null,
      mode,
    });
    const record = await this.continuityRuntime.checkpoint({
      continuityKey: `context-guardian:${uiContinuityKey}`,
      ...capsule,
    });
    this.#assertPreparationCurrent(runtimeKey, preparationVersion);
    this.prepared.set(runtimeKey, {
      conversationId: context?.conversationId || null,
      usedTokens: used,
      preparedAt: now,
      mode,
      record,
      sourceDescriptor,
      uiContinuityKey,
    });
    return record;
  }

  async #notifyVerifiedRollover({ goalId, planId, runtimeKey, oldConversationId, rolled } = {}) {
    if (!this.onVerifiedRollover || rolled?.ok !== true) return false;
    const prior = String(oldConversationId ?? "").trim();
    const next = String(rolled?.conversationId ?? "").trim();
    if (!runtimeKey || !prior || !next || prior === next) return false;
    try {
      const result = await this.onVerifiedRollover({
        goalId: goalId || null,
        planId: planId || null,
        runtimeKey,
        oldConversationId: prior,
        newConversationId: next,
        rollover: rolled,
      });
      // Existing void callbacks signal success by completing. An explicit
      // rejection must not be converted into a successful authority migration.
      return result !== false && result?.ok !== false;
    } catch {
      // The caller retains the source authority and blocks automatic re-arming.
      return false;
    }
  }

  #compactFailure(runtimeKey, conversationId) {
    return this.compactFailures.get(JSON.stringify([runtimeKey, conversationId])) || null;
  }

  async #abortCompact({ runtimeKey, oldConversationId, newConversationId, capsuleId, status, error }) {
    this.compactFailures.set(JSON.stringify([runtimeKey, oldConversationId]), { conversationId: oldConversationId, reason: status });
    while (this.compactFailures.size > MAX_FAILURE_CIRCUITS) this.compactFailures.delete(this.compactFailures.keys().next().value);
    this.prepared.delete(runtimeKey);
    this.nativeSeedCache.delete(runtimeKey);
    if (typeof this.contextAdapter.cancelUserTurnRollover === "function") {
      try { await this.contextAdapter.cancelUserTurnRollover(runtimeKey); } catch { /* Remain blocked even if cancellation fails. */ }
    }
    if (capsuleId && typeof this.continuityRuntime.updateCapsuleMeta === "function") {
      try {
        await this.continuityRuntime.updateCapsuleMeta(capsuleId, {
          status,
          sourceConversationPreserved: true,
          ...(newConversationId ? { candidateConversationId: newConversationId } : {}),
          error: String(error || status).slice(0, 2_000),
          failedAt: new Date().toISOString(),
        });
      } catch { /* The in-memory safety circuit still prevents duplicate commits. */ }
    }
    return false;
  }

  #assertPreparationCurrent(runtimeKey, version) {
    if (this.closed || this.continuityRuntime.enabled !== true || this.committing.has(runtimeKey)
      || (this.preparationVersions.get(runtimeKey) || 0) !== version) {
      const error = new Error("Auto Compact preparation was superseded or closed.");
      error.code = "AUTO_COMPACT_STALE_PREPARATION";
      throw error;
    }
  }

  async pollOnce() {
    if (this.closed) return { ok: true, closed: true, results: [] };
    if (this.continuityRuntime.enabled !== true) {
      return { ok: true, enabled: false, action: "auto-compact-disabled", results: [] };
    }
    if (this.polling) return await this.polling;
    this.polling = this.#pollOnceImpl().finally(() => { this.polling = null; });
    return await this.polling;
  }

  async #pollOnceImpl() {
    const runtimes = this.contextAdapter.status()?.runtimes || [];
    const results = [];
    for (const item of runtimes) {
      const runtimeKey = item.runtimeKey;
      const preparationVersion = this.preparationVersions.get(runtimeKey) || 0;
      try {
        if (this.committing.has(runtimeKey)) {
          results.push({ runtimeKey, action: "compact-commit-in-progress" });
          continue;
        }
        let snapshot = await this.#refresh(runtimeKey);
        this.#assertPreparationCurrent(runtimeKey, preparationVersion);
        let context = await this.contextGuardian.status(runtimeKey);
        this.#assertPreparationCurrent(runtimeKey, preparationVersion);
        if (!snapshot?.ok || context.supportedChatMode !== true || snapshot.mode === "work") {
          results.push({ runtimeKey, action: "skipped-unsupported" });
          continue;
        }
        if (!stableHydratedConversationRoute(snapshot, this.routeSettleMs)) {
          results.push({ runtimeKey, action: "skipped-route-hydration" });
          continue;
        }
        const failure = this.#compactFailure(runtimeKey, snapshot.conversationId);
        if (failure) {
          results.push({ runtimeKey, action: "compact-circuit-open", conversationId: failure.conversationId, reason: failure.reason });
          continue;
        }
        ({ snapshot, context } = await this.#ensureNativeSeed(runtimeKey, snapshot, context));
        this.#assertPreparationCurrent(runtimeKey, preparationVersion);
        const stage = context?.pressure?.stage;
        if (stage !== "prepare" && stage !== "rollover") {
          results.push({ runtimeKey, action: "normal", stage });
          continue;
        }
        if (snapshot.generating) {
          results.push({ runtimeKey, action: "skipped-generating", stage });
          continue;
        }
        const conversationId = String(context?.conversationId || snapshot?.conversationId || "").trim();
        const [goal, plan, recentMessages] = await Promise.all([
          this.#resolveGoal(conversationId),
          this.#resolvePlan(conversationId),
          this.contextAdapter.recentVisibleMessages(runtimeKey, { limit: 8 }),
        ]);
        this.#assertPreparationCurrent(runtimeKey, preparationVersion);
        const record = await this.#checkpoint({ runtimeKey, goal, plan, context, recentMessages, mode: "user-turn", force: stage === "rollover", preparationVersion });
        this.#assertPreparationCurrent(runtimeKey, preparationVersion);
        const capsule = record?.capsule || null;
        if (stage === "prepare") {
          results.push({
            runtimeKey,
            action: "prepared-selective-capsule",
            capsuleId: record.capsuleId || record.id || null,
            uiContinuityKey: capsule?.continuity?.uiContinuityKey || null,
            carryEstimatedTokens: capsule?.compression?.carryEstimatedTokens ?? null,
            sourceBranchMessageCount: capsule?.compression?.sourceBranchMessageCount ?? null,
          });
          continue;
        }
        if (goal?.roundState === "reported") {
          results.push({ runtimeKey, action: "prepared-reported-goal", capsuleId: record.capsuleId || record.id || null });
          continue;
        }
        const armed = await this.contextAdapter.armUserTurnRollover(runtimeKey, {
          mode: "user-turn",
          capsulePrompt: compactPrompt(record, { goal, sameRound: goal?.roundState === "working" }),
          oldConversationId: conversationId,
          goalId: goal?.id || null,
          planId: plan?.id || null,
          sourceMessageId: capsule?.continuity?.sourceBoundaryMessageId,
          uiContinuityKey: capsule?.continuity?.uiContinuityKey,
          capsuleFingerprint: capsule?.continuity?.capsuleFingerprint,
          sourceDescriptor: {
            conversationId,
            currentNode: capsule?.continuity?.sourceBoundaryMessageId,
            payloadBytes: capsule?.compression?.sourcePayloadBytes,
            branchMessageCount: capsule?.compression?.sourceBranchMessageCount,
            textChars: capsule?.compression?.sourceTextChars,
            exactUsedTokens: capsule?.compression?.sourceExactUsedTokens,
          },
          compressionContract: capsule,
          capsuleId: record.capsuleId || record.id || null,
        });
        if (armed?.armed !== true) {
          results.push({
            runtimeKey,
            action: "compact-arm-blocked",
            reason: armed?.reason || "unknown",
            capsuleId: record.capsuleId || record.id || null,
          });
          continue;
        }
        results.push({
          runtimeKey,
          action: "armed-user-turn-auto-compact",
          capsuleId: record.capsuleId || record.id || null,
          uiContinuityKey: capsule?.continuity?.uiContinuityKey || null,
          sourceConversationId: conversationId,
          sourceBranchMessageCount: capsule?.compression?.sourceBranchMessageCount ?? null,
          carryMessageCount: capsule?.compression?.carryMessageCount ?? null,
          carryEstimatedTokens: capsule?.compression?.carryEstimatedTokens ?? null,
        });
      } catch (error) {
        results.push({ runtimeKey, action: error?.code === "AUTO_COMPACT_STALE_PREPARATION" ? "skipped-stale-preparation" : "error", error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { ok: true, results };
  }

  async noteUserTurnRollover(event = {}) {
    if (this.closed) return false;
    const runtimeKey = String(event?.runtimeKey || "").trim();
    const oldConversationId = String(event?.oldConversationId || "").trim();
    const newConversationId = String(event?.newConversationId || event?.conversationId || "").trim();
    const capsuleId = String(event?.capsuleId || "").trim() || null;
    const prepared = this.prepared.get(runtimeKey);
    const expectedCapsuleId = prepared?.record?.capsuleId || prepared?.record?.id || null;
    // A stale or unrelated completion cannot cancel or rebind a different chat.
    if (!prepared || prepared.conversationId !== oldConversationId || !capsuleId || capsuleId !== expectedCapsuleId) return false;
    const goalId = prepared.record.capsule?.continuity?.goalId || null;
    const planId = prepared.record.capsule?.continuity?.planId || null;
    if ((event.goalId && event.goalId !== goalId) || (event.planId && event.planId !== planId)) return false;
    if (this.committing.has(runtimeKey)) return false;
    this.committing.add(runtimeKey);
    this.preparationVersions.set(runtimeKey, (this.preparationVersions.get(runtimeKey) || 0) + 1);
    try {
      return await this.#commitPreparedRollover({ event, prepared, runtimeKey, oldConversationId, newConversationId, goalId, planId, capsuleId });
    } finally {
      this.committing.delete(runtimeKey);
    }
  }

  async #commitPreparedRollover({ event, prepared, runtimeKey, oldConversationId, newConversationId, goalId, planId, capsuleId }) {
    if (event?.ok !== true) {
      if (event?.ok !== false) return false;
      return await this.#abortCompact({ runtimeKey, oldConversationId, newConversationId, capsuleId, status: "source-preserved-abort", error: event.error });
    }
    const target = event?.targetDescriptor || {};
    let validation;
    try {
      if (!newConversationId || oldConversationId === newConversationId) throw new Error("Auto Compact requires a distinct target conversation.");
      if (target.conversationId !== newConversationId) throw new Error("Auto Compact target descriptor does not match the completion conversation.");
      validation = validateAutoCompactContinuation({
        contract: prepared.record.capsule,
        sourceConversationId: oldConversationId,
        targetConversationId: newConversationId,
        targetMappingCount: target?.mappingCount,
        targetBranchMessageCount: target?.branchMessageCount,
        targetPayloadBytes: target?.payloadBytes,
        hiddenMessages: event?.hiddenMessages,
        visibleUsers: event?.visibleUsers,
        visibleAssistants: event?.visibleAssistants,
        uiContinuityVerified: Boolean(
          event?.uiContinuityKey
          && event.uiContinuityKey === prepared.uiContinuityKey
          && target?.devspaceContinuity?.uiContinuityKey === event.uiContinuityKey
          && target?.devspaceContinuity?.sourceConversationId === oldConversationId
          && target?.devspaceContinuity?.capsuleFingerprint === prepared.record.capsule?.continuity?.capsuleFingerprint
        ),
        nativeContinuationSourceId: event?.nativeContinuationSourceId || null,
      });
    } catch (error) {
      return await this.#abortCompact({ runtimeKey, oldConversationId, newConversationId, capsuleId, status: "verification-failed", error: error instanceof Error ? error.message : String(error) });
    }
    const rebound = await this.#notifyVerifiedRollover({
      goalId,
      planId,
      runtimeKey,
      oldConversationId,
      rolled: { ...event, ...validation, ok: true, conversationId: newConversationId },
    });
    if (rebound !== true) {
      return await this.#abortCompact({ runtimeKey, oldConversationId, newConversationId, capsuleId, status: "authority-rebind-failed", error: "Verified target authority migration was rejected." });
    }
    this.prepared.delete(runtimeKey);
    this.nativeSeedCache.delete(runtimeKey);
    this.descriptorFailures.delete(JSON.stringify([runtimeKey, oldConversationId]));
    this.compactFailures.delete(JSON.stringify([runtimeKey, oldConversationId]));
    if (capsuleId && typeof this.continuityRuntime.updateCapsuleMeta === "function") {
      await this.continuityRuntime.updateCapsuleMeta(capsuleId, {
        status: "verified-continuation",
        toConversationId: newConversationId,
        verifiedAt: new Date().toISOString(),
        validation,
      });
    }
    return true;
  }

  async beforeGoalContinuation({ runtimeKey, goalId, continuationPrompt } = {}) {
    const preparationVersion = this.preparationVersions.get(runtimeKey) || 0;
    const prompt = String(continuationPrompt ?? "").trim();
    if (!runtimeKey || !goalId || !prompt) return { handled: false, reason: "missing-input" };
    if (this.closed || this.committing.has(runtimeKey)) return { handled: false, blocked: true, reason: "compact-commit-in-progress" };
    if (this.continuityRuntime.enabled !== true) return { handled: false, reason: "auto-compact-disabled" };
    let snapshot = await this.#refresh(runtimeKey);
    this.#assertPreparationCurrent(runtimeKey, preparationVersion);
    let baseContext = await this.contextGuardian.status(runtimeKey);
    this.#assertPreparationCurrent(runtimeKey, preparationVersion);
    if (!stableHydratedConversationRoute(snapshot, this.routeSettleMs)) {
      return { handled: false, blocked: true, reason: "route-not-stable", context: baseContext };
    }
    if (this.#compactFailure(runtimeKey, snapshot.conversationId)) {
      return { handled: false, blocked: true, reason: "compact-circuit-open", context: baseContext };
    }
    ({ snapshot, context: baseContext } = await this.#ensureNativeSeed(runtimeKey, snapshot, baseContext));
    this.#assertPreparationCurrent(runtimeKey, preparationVersion);
    const nextInputTokens = estimateClassicInputTokens(prompt) + 128;
    const context = await this.contextGuardian.status(runtimeKey, { nextInputTokens });
    this.#assertPreparationCurrent(runtimeKey, preparationVersion);
    if (!snapshot?.ok || context.supportedChatMode !== true || snapshot.mode === "work" || snapshot.generating || Number(snapshot.composerTextChars || 0) > 0) {
      return { handled: false, reason: "unsafe-boundary", context };
    }
    const conversationId = String(context?.conversationId || snapshot?.conversationId || "").trim();
    if (context?.pressure?.stage !== "rollover") {
      if (context?.pressure?.stage === "prepare") {
        const [goal, plan, recentMessages] = await Promise.all([
          this.goalRuntime.status(goalId),
          this.#resolvePlan(conversationId),
          this.contextAdapter.recentVisibleMessages(runtimeKey, { limit: 8 }),
        ]);
        this.#assertPreparationCurrent(runtimeKey, preparationVersion);
        await this.#checkpoint({ runtimeKey, goal, plan, context, recentMessages, mode: "hidden-goal-continuation", preparationVersion });
      }
      return { handled: false, reason: "headroom-available", context };
    }
    const [goal, plan, recentMessages] = await Promise.all([
      this.goalRuntime.status(goalId),
      this.#resolvePlan(conversationId),
      this.contextAdapter.recentVisibleMessages(runtimeKey, { limit: 8 }),
    ]);
    this.#assertPreparationCurrent(runtimeKey, preparationVersion);
    const record = await this.#checkpoint({ runtimeKey, goal, plan, context, recentMessages, mode: "hidden-goal-continuation", force: true, preparationVersion });
    this.#assertPreparationCurrent(runtimeKey, preparationVersion);
    const capsule = record?.capsule || null;
    const armed = await this.contextAdapter.startHiddenRollover(runtimeKey, {
      prompt: compactPrompt(record, { goal, sameRound: false, continuationPrompt: prompt }),
      oldConversationId: conversationId,
      goalId: goal?.id || goalId,
      planId: plan?.id || null,
      sourceMessageId: capsule?.continuity?.sourceBoundaryMessageId,
      uiContinuityKey: capsule?.continuity?.uiContinuityKey,
      capsuleFingerprint: capsule?.continuity?.capsuleFingerprint,
      sourceDescriptor: {
        conversationId,
        currentNode: capsule?.continuity?.sourceBoundaryMessageId,
        payloadBytes: capsule?.compression?.sourcePayloadBytes,
        branchMessageCount: capsule?.compression?.sourceBranchMessageCount,
        textChars: capsule?.compression?.sourceTextChars,
        exactUsedTokens: capsule?.compression?.sourceExactUsedTokens,
      },
      compressionContract: capsule,
      capsuleId: record.capsuleId || record.id || null,
    });
    if (armed?.armed !== true) {
      return {
        handled: false,
        blocked: true,
        reason: `auto-compact-arm-failed:${armed?.reason || "unknown"}`,
        context,
        capsuleId: record.capsuleId || record.id || null,
      };
    }
    return {
      handled: false,
      armed: true,
      reason: "hidden-goal-auto-compact-armed",
      context,
      capsuleId: record.capsuleId || record.id || null,
      uiContinuityKey: capsule?.continuity?.uiContinuityKey || null,
    };
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.polling) await this.polling.catch(() => {});
    this.nativeSeedCache.clear();
    this.descriptorFailures.clear();
    this.compactFailures.clear();
    this.preparationVersions.clear();
  }
}
