import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson } from "./atomic-file.js";
import { enqueueRecoverablePersist } from "./recoverable-persist-queue.js";

const STATE_VERSION = 1;
const GOAL_STATUSES = new Set(["active", "paused", "blocked", "completed", "stopped"]);
const NONTERMINAL_GOAL_STATUSES = new Set(["active", "paused", "blocked"]);
const ROUND_STATES = new Set(["working", "reported"]);
const CONTINUATION_STATES = new Set(["idle", "pending", "dispatching", "dispatched"]);
const MIN_CRITERIA = 1;
const MAX_CRITERIA = 12;
const MAX_OBJECTIVE_CHARS = 4_000;
const MAX_CRITERION_CHARS = 1_000;
const MAX_REPORT_SUMMARY_CHARS = 4_000;
const MAX_BLOCKER_FINGERPRINT_CHARS = 500;
const MAX_EVIDENCE_CHARS = 4_000;
const MAX_CONVERSATION_ID_CHARS = 240;
const REPORT_HISTORY_LIMIT = 32;
const DEFAULT_DISPATCH_LEASE_MS = 45_000;
const DEFAULT_DISPATCH_RECOVERY_MS = 120_000;
const DEFAULT_ROUND_RECOVERY_RELEASE_MS = 5_000;
const MAX_ROUND_RECOVERY_ATTEMPTS = 5;

function randomId(prefix) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanText(value, maxChars, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required.`);
  if (text.length > maxChars) throw new Error(`${label} exceeds ${maxChars} characters.`);
  return text;
}

function newState() {
  return { version: STATE_VERSION, goals: {} };
}

function idleContinuation() {
  return {
    state: "idle",
    forRound: null,
    continuationId: null,
    leaseId: null,
    leasedAt: null,
    expiresAt: null,
    dispatchedAt: null,
  };
}

function emptyBlocker() {
  return {
    fingerprint: null,
    consecutiveRounds: 0,
    lastSeenRound: null,
  };
}

function idleRoundRecovery(round, attempts = 0, retryAfterAt = null) {
  return {
    state: "idle",
    round,
    recoveryId: null,
    attempts,
    claimedAt: null,
    dispatchedAt: null,
    retryAfterAt,
  };
}

function buildRoundRecoveryPrompt(goal, recoveryId) {
  return [
    "[DEVSPACE_GOAL_ROUND_RECOVERY]",
    `Resume DevSpace Goal ${goal.id} in the same working round ${goal.round}.`,
    "The previous assistant turn ended before devspace_goal_turn_report. DevSpace resumed this exact conversation through a backend-owned hidden host continuation; no user message or composer draft was created. This is not new user intent and not a new Goal round.",
    "Do not call devspace_goal_round_begin. Read the current Goal and Plan state, continue meaningful unfinished work for this same round, verify progress, then call devspace_goal_turn_report as the final tool call before one complete visible final report.",
    "Do not stop after merely acknowledging this hidden recovery instruction. Do not send another recovery/follow-up turn. Preserve the full original Goal objective and success criteria.",
    `Recovery id: ${recoveryId}`,
  ].join("\n");
}

function ensureRoundRecoveryShape(goal) {
  if (!goal.roundBeganAt) {
    goal.roundBeganAt = goal.round > 1 && goal.roundState === "working" && goal.lastConsumedContinuationId
      ? goal.updatedAt || goal.createdAt || null
      : goal.createdAt || null;
  }
  if (!goal.roundRecovery || typeof goal.roundRecovery !== "object") {
    goal.roundRecovery = idleRoundRecovery(goal.round);
  }
  if (!Number.isInteger(goal.roundRecovery.attempts) || goal.roundRecovery.attempts < 0) {
    goal.roundRecovery.attempts = 0;
  }
  if (!Number.isInteger(goal.roundRecovery.round) || goal.roundRecovery.round < 1) {
    goal.roundRecovery.round = goal.round;
  }
  if (!["idle", "dispatching", "dispatched"].includes(goal.roundRecovery.state)) {
    goal.roundRecovery = idleRoundRecovery(goal.round);
  }
  return goal;
}

function pendingContinuation(round, continuationId = randomId("continuation")) {
  return {
    state: "pending",
    forRound: round,
    continuationId,
    leaseId: null,
    leasedAt: null,
    expiresAt: null,
    dispatchedAt: null,
  };
}

function buildContinuationPrompt(goal, continuationId) {
  return [
    "[DEVSPACE_GOAL_CONTINUATION]",
    `Continue active DevSpace Goal ${goal.id} after reported round ${goal.round}.`,
    "This prompt is a runtime continuation, not a new user request.",
    `First call devspace_goal_round_begin with goalId=${goal.id} and continuationId=${continuationId}.`,
    "Then read current Goal state, preserve the full original objective and success criteria, perform meaningful next work, and verify progress. Call devspace_goal_turn_report before the visible final report for this round. After that tool returns, give the user one complete visible final report as the final response.",
    "Do not call any more or additional tools after devspace_goal_turn_report in that turn. Do not silently shrink the Goal to an easier sub-goal. If the Goal is already completed, paused, blocked, or stopped, do not continue work.",
  ].join("\n");
}

function normalizeConversationId(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return cleanText(value, MAX_CONVERSATION_ID_CHARS, "Conversation id");
}

function normalizeBlockerFingerprint(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return cleanText(value, MAX_BLOCKER_FINGERPRINT_CHARS, "Blocker fingerprint")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeSuccessCriteria(values) {
  if (!Array.isArray(values) || values.length < MIN_CRITERIA || values.length > MAX_CRITERIA) {
    throw new Error(`Goal requires ${MIN_CRITERIA}-${MAX_CRITERIA} success criteria.`);
  }
  return values.map((value) => ({
    id: randomId("criterion"),
    text: cleanText(value, MAX_CRITERION_CHARS, "Success criterion"),
  }));
}

function nonterminalConversationGoals(state, conversationId, excludeGoalId = null) {
  const expected = normalizeConversationId(conversationId);
  if (!expected) return [];
  return Object.values(state?.goals || {}).filter((goal) => (
    goal?.id !== excludeGoalId
    && NONTERMINAL_GOAL_STATUSES.has(goal?.status)
    && normalizeConversationId(goal?.conversationId) === expected
  ));
}

function validateGoalShape(goal) {
  if (!goal || !/^goal_[a-f0-9]{16}$/.test(String(goal.id ?? ""))) {
    throw new Error("invalid persisted goal id");
  }
  goal.conversationId = normalizeConversationId(goal.conversationId);
  if (!GOAL_STATUSES.has(goal.status)) throw new Error("invalid persisted goal status");
  if (!ROUND_STATES.has(goal.roundState)) throw new Error("invalid persisted goal round state");
  if (!Number.isInteger(goal.round) || goal.round < 1) throw new Error("invalid persisted goal round");
  if (!Number.isInteger(goal.revision) || goal.revision < 1) throw new Error("invalid persisted goal revision");
  cleanText(goal.objective, MAX_OBJECTIVE_CHARS, "Goal objective");
  if (!Array.isArray(goal.successCriteria) || goal.successCriteria.length < MIN_CRITERIA || goal.successCriteria.length > MAX_CRITERIA) {
    throw new Error("invalid persisted goal success criteria");
  }
  const criterionIds = new Set();
  for (const criterion of goal.successCriteria) {
    if (!criterion || !/^criterion_[a-f0-9]{16}$/.test(String(criterion.id ?? ""))) {
      throw new Error("invalid persisted success criterion id");
    }
    if (criterionIds.has(criterion.id)) throw new Error("duplicate persisted success criterion id");
    criterionIds.add(criterion.id);
    cleanText(criterion.text, MAX_CRITERION_CHARS, "Success criterion");
  }
  if (!goal.continuation || !CONTINUATION_STATES.has(goal.continuation.state)) {
    throw new Error("invalid persisted continuation state");
  }
  if (!goal.blocker || !Number.isInteger(goal.blocker.consecutiveRounds) || goal.blocker.consecutiveRounds < 0) {
    throw new Error("invalid persisted blocker state");
  }
  return goal;
}

function validateLoadedState(value) {
  if (!value || value.version !== STATE_VERSION || !value.goals || typeof value.goals !== "object") {
    throw new Error("unsupported goal state version");
  }
  for (const goal of Object.values(value.goals)) {
    ensureRoundRecoveryShape(goal);
    validateGoalShape(goal);
  }
  return value;
}

export class GoalRuntime {
  constructor({
    stateDir,
    now = () => Date.now(),
    dispatchLeaseMs = DEFAULT_DISPATCH_LEASE_MS,
    dispatchRecoveryMs = DEFAULT_DISPATCH_RECOVERY_MS,
  } = {}) {
    if (!stateDir) throw new Error("GoalRuntime requires stateDir.");
    if (typeof now !== "function") throw new Error("GoalRuntime now must be a function.");
    if (!Number.isFinite(dispatchLeaseMs) || dispatchLeaseMs <= 0) throw new Error("dispatchLeaseMs must be positive.");
    if (!Number.isFinite(dispatchRecoveryMs) || dispatchRecoveryMs <= 0) throw new Error("dispatchRecoveryMs must be positive.");

    this.statePath = join(stateDir, "goal-state.json");
    this.state = newState();
    this.now = now;
    this.dispatchLeaseMs = dispatchLeaseMs;
    this.dispatchRecoveryMs = dispatchRecoveryMs;
    this.persistQueue = Promise.resolve();
    this.ready = this.load();
  }

  nowIso() {
    return new Date(this.now()).toISOString();
  }

  async load() {
    try {
      const parsed = JSON.parse((await readFile(this.statePath, "utf8")).replace(/^\uFEFF/, ""));
      this.state = validateLoadedState(parsed);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn(`goal state reset: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.state = newState();
    }
  }

  async save() {
    const snapshot = clone(this.state);
    await enqueueRecoverablePersist(this, () => atomicWriteJson(this.statePath, snapshot));
  }

  getGoal(goalId) {
    const id = String(goalId ?? "");
    const goal = this.state.goals[id];
    if (!goal) throw new Error(`Unknown goal ${id}.`);
    return goal;
  }

  touch(goal) {
    goal.revision = Number(goal.revision ?? 0) + 1;
    goal.updatedAt = this.nowIso();
  }

  async start({ objective, successCriteria, conversationId }) {
    await this.ready;
    const timestamp = this.nowIso();
    const normalizedConversationId = normalizeConversationId(conversationId);
    const collision = nonterminalConversationGoals(this.state, normalizedConversationId)[0] || null;
    if (collision) {
      throw new Error(`Conversation ${normalizedConversationId} already has nonterminal Goal ${collision.id} (${collision.status}); resume that Goal instead of creating another.`);
    }
    const goal = {
      id: randomId("goal"),
      conversationId: normalizedConversationId,
      objective: cleanText(objective, MAX_OBJECTIVE_CHARS, "Goal objective"),
      status: "active",
      round: 1,
      roundState: "working",
      roundBeganAt: timestamp,
      roundRecovery: idleRoundRecovery(1),
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
      pausedAt: null,
      stoppedAt: null,
      blockedAt: null,
      successCriteria: normalizeSuccessCriteria(successCriteria),
      lastRoundReport: null,
      recentReports: [],
      completionEvidence: null,
      blocker: emptyBlocker(),
      continuation: idleContinuation(),
      lastConsumedContinuationId: null,
      lastConsumedLeaseId: null,
    };
    this.state.goals[goal.id] = goal;
    await this.save();
    return clone(goal);
  }

  continuationExpiryIso(deltaMs) {
    return new Date(this.now() + deltaMs).toISOString();
  }

  normalizeExpiredContinuation(goal) {
    const continuation = goal.continuation;
    if (!continuation || (continuation.state !== "dispatching" && continuation.state !== "dispatched")) return false;
    const expiresAtMs = Date.parse(String(continuation.expiresAt ?? ""));
    if (!Number.isFinite(expiresAtMs) || this.now() < expiresAtMs) return false;
    goal.continuation = pendingContinuation(continuation.forRound, continuation.continuationId);
    return true;
  }

  async status(goalId) {
    await this.ready;
    const goal = this.getGoal(goalId);
    if (this.normalizeExpiredContinuation(goal)) {
      this.touch(goal);
      await this.save();
    }
    return clone(goal);
  }

  async activeGoals({ limit = 12, conversationId } = {}) {
    await this.ready;
    const hasConversationFilter = conversationId !== undefined;
    const normalizedConversationId = normalizeConversationId(conversationId);
    return Object.values(this.state.goals)
      .filter((goal) => goal?.status === "active")
      .filter((goal) => !hasConversationFilter || goal.conversationId === normalizedConversationId)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .slice(0, Math.max(1, Math.min(50, Number(limit) || 12)))
      .map((goal) => clone(ensureRoundRecoveryShape(goal)));
  }

  async projectableGoals({ limit = 12, conversationId } = {}) {
    await this.ready;
    const visibleStatuses = new Set(["active", "paused", "blocked"]);
    const hasConversationFilter = conversationId !== undefined;
    const normalizedConversationId = normalizeConversationId(conversationId);
    return Object.values(this.state.goals)
      .filter((goal) => visibleStatuses.has(goal?.status))
      .filter((goal) => !hasConversationFilter || goal.conversationId === normalizedConversationId)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .slice(0, Math.max(1, Math.min(50, Number(limit) || 12)))
      .map((goal) => clone(ensureRoundRecoveryShape(goal)));
  }

  async bindConversation({ goalId, conversationId }) {
    await this.ready;
    const goal = this.getGoal(goalId);
    const target = normalizeConversationId(conversationId);
    if (!target) throw new Error("Conversation id is required to bind a Goal.");
    const current = normalizeConversationId(goal.conversationId);
    if (current === target) return clone(goal);
    if (current) {
      throw new Error(`Goal ${goal.id} is already bound to conversation ${current} and cannot move without a verified Auto Compact continuation.`);
    }
    const collision = nonterminalConversationGoals(this.state, target, goal.id)[0] || null;
    if (collision) {
      throw new Error(`Conversation ${target} already has nonterminal Goal ${collision.id} (${collision.status}); refusing to bind a second Goal.`);
    }
    goal.conversationId = target;
    this.touch(goal);
    await this.save();
    return clone(goal);
  }

  async rebindConversation({ goalId, oldConversationId, newConversationId, reason = "verified-auto-compact" }) {
    await this.ready;
    const goal = this.getGoal(goalId);
    if (!["active", "paused", "blocked"].includes(goal.status)) throw new Error(`Goal ${goal.id} is terminal (${goal.status}) and cannot move conversations.`);
    const prior = normalizeConversationId(oldConversationId);
    const next = normalizeConversationId(newConversationId);
    if (!prior || !next || prior === next) throw new Error("Verified Goal conversation rebind requires distinct old and new conversation ids.");
    const current = normalizeConversationId(goal.conversationId);
    if (current === next) return clone(goal);
    if (current !== prior) throw new Error(`Goal ${goal.id} is bound to ${current || "none"}, not expected source ${prior}.`);
    const collision = nonterminalConversationGoals(this.state, next, goal.id)[0] || null;
    if (collision) throw new Error(`Target conversation ${next} is already bound to nonterminal Goal ${collision.id} (${collision.status}).`);
    goal.conversationId = next;
    goal.conversationContinuity = [
      ...(Array.isArray(goal.conversationContinuity) ? goal.conversationContinuity : []),
      { from: prior, to: next, at: this.nowIso(), reason: cleanText(reason, 240, "Conversation rebind reason") },
    ].slice(-20);
    this.touch(goal);
    await this.save();
    return clone(goal);
  }

  async control({ goalId, action }) {
    await this.ready;
    const goal = this.getGoal(goalId);
    const command = String(action ?? "");

    if (goal.status === "completed" || goal.status === "stopped") {
      if (command === "stop" && goal.status === "stopped") throw new Error(`Goal ${goal.id} is already stopped.`);
      throw new Error(`Goal ${goal.id} is terminal (${goal.status}).`);
    }

    if (command === "pause") {
      if (goal.status === "paused") throw new Error(`Goal ${goal.id} is already paused.`);
      if (goal.status !== "active") throw new Error(`Goal ${goal.id} cannot pause from ${goal.status}.`);
      goal.status = "paused";
      goal.pausedAt = this.nowIso();
      goal.continuation = idleContinuation();
      goal.roundRecovery = idleRoundRecovery(goal.round);
    } else if (command === "resume") {
      if (goal.status === "active") throw new Error(`Goal ${goal.id} is already active.`);
      if (goal.status !== "paused" && goal.status !== "blocked") {
        throw new Error(`Goal ${goal.id} cannot resume from ${goal.status}.`);
      }
      goal.status = "active";
      goal.pausedAt = null;
      goal.blockedAt = null;
      goal.continuation = goal.roundState === "reported" ? pendingContinuation(goal.round) : idleContinuation();
    } else if (command === "stop") {
      goal.status = "stopped";
      goal.stoppedAt = this.nowIso();
      goal.continuation = idleContinuation();
      goal.roundRecovery = idleRoundRecovery(goal.round);
    } else {
      throw new Error(`Invalid Goal control action: ${command}`);
    }

    this.touch(goal);
    await this.save();
    return clone(goal);
  }

  async turnReport({ goalId, summary, meaningfulProgress, blockerFingerprint }) {
    await this.ready;
    const goal = this.getGoal(goalId);
    if (goal.roundState === "reported") throw new Error(`Goal ${goal.id} round ${goal.round} is already reported.`);
    if (goal.roundState !== "working") throw new Error(`Goal ${goal.id} round ${goal.round} is not working.`);
    if (typeof meaningfulProgress !== "boolean") throw new Error("meaningfulProgress must be a boolean.");

    const normalizedBlocker = meaningfulProgress ? null : normalizeBlockerFingerprint(blockerFingerprint);
    const reportedAt = this.nowIso();
    const report = {
      round: goal.round,
      summary: cleanText(summary, MAX_REPORT_SUMMARY_CHARS, "Goal round summary"),
      meaningfulProgress,
      blockerFingerprint: normalizedBlocker,
      reportedAt,
    };

    goal.lastRoundReport = report;
    goal.recentReports = [...(goal.recentReports ?? []), report].slice(-REPORT_HISTORY_LIMIT);
    goal.roundState = "reported";
    goal.roundRecovery = idleRoundRecovery(goal.round);

    if (meaningfulProgress || !normalizedBlocker) {
      goal.blocker = emptyBlocker();
    } else {
      const consecutive = goal.blocker?.fingerprint === normalizedBlocker
        && goal.blocker?.lastSeenRound === goal.round - 1
        ? goal.blocker.consecutiveRounds + 1
        : 1;
      goal.blocker = {
        fingerprint: normalizedBlocker,
        consecutiveRounds: consecutive,
        lastSeenRound: goal.round,
      };
    }

    goal.continuation = goal.status === "active"
      ? pendingContinuation(goal.round)
      : idleContinuation();
    this.touch(goal);
    await this.save();
    return clone(goal);
  }

  async complete({ goalId, evidence }) {
    await this.ready;
    const goal = this.getGoal(goalId);
    if (goal.status === "completed") throw new Error(`Goal ${goal.id} is already completed.`);
    if (goal.status === "stopped") throw new Error(`Goal ${goal.id} is terminal (stopped).`);
    if (goal.status !== "active") throw new Error(`Goal ${goal.id} cannot complete from ${goal.status}.`);
    if (goal.roundState !== "working") throw new Error(`Goal ${goal.id} can complete only during a working round.`);
    if (!Array.isArray(evidence)) throw new Error("Completion evidence is required for every success criterion.");

    const criteriaById = new Map(goal.successCriteria.map((criterion) => [criterion.id, criterion]));
    const supplied = new Map();
    for (const entry of evidence) {
      const criterionId = String(entry?.criterionId ?? "");
      if (!criteriaById.has(criterionId)) throw new Error(`Unknown criterion ${criterionId}.`);
      if (supplied.has(criterionId)) throw new Error(`Duplicate evidence for criterion ${criterionId}.`);
      supplied.set(criterionId, cleanText(entry?.evidence, MAX_EVIDENCE_CHARS, "Completion evidence"));
    }
    const missing = goal.successCriteria.filter((criterion) => !supplied.has(criterion.id));
    if (missing.length > 0) {
      throw new Error(`Missing evidence for every success criterion: ${missing.map((criterion) => criterion.id).join(", ")}`);
    }

    goal.status = "completed";
    goal.completedAt = this.nowIso();
    goal.completionEvidence = goal.successCriteria.map((criterion) => ({
      criterionId: criterion.id,
      evidence: supplied.get(criterion.id),
    }));
    goal.continuation = idleContinuation();
    goal.roundRecovery = idleRoundRecovery(goal.round);
    this.touch(goal);
    await this.save();
    return clone(goal);
  }

  async markBlocked({ goalId }) {
    await this.ready;
    const goal = this.getGoal(goalId);
    if (goal.status !== "active") throw new Error(`Goal ${goal.id} cannot become blocked from ${goal.status}.`);
    if ((goal.blocker?.consecutiveRounds ?? 0) < 3) {
      throw new Error(`Goal ${goal.id} requires 3 consecutive no-progress rounds with the same blocker before it can become blocked.`);
    }
    if (goal.roundState !== "working") {
      throw new Error(`Goal ${goal.id} can become blocked only during a working round.`);
    }
    goal.status = "blocked";
    goal.blockedAt = this.nowIso();
    goal.continuation = idleContinuation();
    goal.roundRecovery = idleRoundRecovery(goal.round);
    this.touch(goal);
    await this.save();
    return clone(goal);
  }

  async continuation({ goalId, action, leaseId }) {
    await this.ready;
    const goal = this.getGoal(goalId);
    const command = String(action ?? "");

    if (this.normalizeExpiredContinuation(goal)) {
      this.touch(goal);
      await this.save();
    }

    if (command === "claim") {
      if (goal.status !== "active") throw new Error(`Goal ${goal.id} cannot continue from ${goal.status}.`);
      if (goal.roundState !== "reported") throw new Error(`Goal ${goal.id} round ${goal.round} is not reported.`);
      if (goal.continuation.state !== "pending") {
        throw new Error(`Goal ${goal.id} continuation is ${goal.continuation.state}, not pending; an existing dispatch lease may still be active.`);
      }
      const nextLeaseId = randomId("lease");
      const leasedAt = this.nowIso();
      const continuationId = goal.continuation.continuationId;
      goal.continuation = {
        ...goal.continuation,
        state: "dispatching",
        leaseId: nextLeaseId,
        leasedAt,
        expiresAt: this.continuationExpiryIso(this.dispatchLeaseMs),
        dispatchedAt: null,
      };
      this.touch(goal);
      await this.save();
      return {
        goal: clone(goal),
        claim: {
          goalId: goal.id,
          round: goal.round,
          continuationId,
          leaseId: nextLeaseId,
          expiresAt: goal.continuation.expiresAt,
          prompt: buildContinuationPrompt(goal, continuationId),
        },
      };
    }

    const requestedLeaseId = String(leaseId ?? "");
    if (!requestedLeaseId) throw new Error(`Goal continuation ${command} requires leaseId.`);

    if (command === "ack" && goal.lastConsumedLeaseId === requestedLeaseId) {
      return { goal: clone(goal), acknowledged: true, consumed: true };
    }
    if (command === "release" && goal.lastConsumedLeaseId === requestedLeaseId) {
      return { goal: clone(goal), released: false, consumed: true };
    }

    if (goal.continuation.state !== "dispatching") {
      throw new Error(`Goal ${goal.id} continuation is ${goal.continuation.state}; no matching dispatch lease is active.`);
    }
    if (goal.continuation.leaseId !== requestedLeaseId) {
      throw new Error(`Goal ${goal.id} continuation lease does not match.`);
    }

    if (command === "release") {
      const { forRound, continuationId } = goal.continuation;
      goal.continuation = pendingContinuation(forRound, continuationId);
      this.touch(goal);
      await this.save();
      return { goal: clone(goal), released: true, consumed: false };
    }

    if (command === "ack") {
      goal.continuation = {
        ...goal.continuation,
        state: "dispatched",
        dispatchedAt: this.nowIso(),
        expiresAt: this.continuationExpiryIso(this.dispatchRecoveryMs),
      };
      this.touch(goal);
      await this.save();
      return { goal: clone(goal), acknowledged: true, consumed: false };
    }

    throw new Error(`Invalid Goal continuation action: ${command}`);
  }

  async roundBegin({ goalId, continuationId }) {
    await this.ready;
    const goal = this.getGoal(goalId);
    const requestedContinuationId = String(continuationId ?? "");
    if (!requestedContinuationId) throw new Error("Goal round begin requires continuationId.");

    if (goal.lastConsumedContinuationId === requestedContinuationId) {
      return clone(goal);
    }
    if (goal.status !== "active") throw new Error(`Goal ${goal.id} cannot begin a new round from ${goal.status}.`);
    if (goal.roundState !== "reported") throw new Error(`Goal ${goal.id} current round is not reported.`);
    if (goal.continuation.state === "idle") throw new Error(`Goal ${goal.id} has no continuation to redeem.`);
    if (goal.continuation.continuationId !== requestedContinuationId) {
      throw new Error(`Goal ${goal.id} continuationId does not match.`);
    }
    if (goal.continuation.forRound !== goal.round) {
      throw new Error(`Goal ${goal.id} continuation belongs to round ${goal.continuation.forRound}, not ${goal.round}.`);
    }

    goal.lastConsumedContinuationId = requestedContinuationId;
    goal.lastConsumedLeaseId = goal.continuation.leaseId ?? null;
    goal.round += 1;
    goal.roundState = "working";
    goal.roundBeganAt = this.nowIso();
    goal.roundRecovery = idleRoundRecovery(goal.round);
    goal.continuation = idleContinuation();
    this.touch(goal);
    await this.save();
    return clone(goal);
  }

  async recoverableWorkingRounds() {
    await this.ready;
    const counts = new Map();
    for (const goal of Object.values(this.state.goals)) {
      const conversationId = normalizeConversationId(goal?.conversationId);
      if (!conversationId || !NONTERMINAL_GOAL_STATUSES.has(goal?.status)) continue;
      counts.set(conversationId, Number(counts.get(conversationId) || 0) + 1);
    }
    return Object.values(this.state.goals)
      .filter((goal) => (
        goal.status === "active"
        && goal.roundState === "working"
        && goal.round >= 1
        && Boolean(goal.roundBeganAt)
        && (!goal.conversationId || counts.get(goal.conversationId) === 1)
      ))
      .map((goal) => clone(ensureRoundRecoveryShape(goal)));
  }

  async hasConversationCollision({ goalId, conversationId } = {}) {
    await this.ready;
    const goal = goalId ? this.getGoal(goalId) : null;
    const expected = normalizeConversationId(conversationId ?? goal?.conversationId);
    if (!expected) return false;
    return nonterminalConversationGoals(this.state, expected, goal?.id || null).length > 0;
  }

  async conversationCollisions({ limit = 20 } = {}) {
    await this.ready;
    const groups = new Map();
    for (const goal of Object.values(this.state.goals)) {
      const conversationId = normalizeConversationId(goal?.conversationId);
      if (!conversationId || !NONTERMINAL_GOAL_STATUSES.has(goal?.status)) continue;
      const rows = groups.get(conversationId) || [];
      rows.push({ id: goal.id, status: goal.status, round: goal.round, roundState: goal.roundState, updatedAt: goal.updatedAt });
      groups.set(conversationId, rows);
    }
    return [...groups.entries()]
      .filter(([, goals]) => goals.length > 1)
      .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
      .map(([conversationId, goals]) => ({ conversationId, goals: goals.map((goal) => ({ ...goal })) }));
  }

  async resolveConversationCollision({ conversationId, keepGoalId, reason = "verified-legacy-duplicate-repair" } = {}) {
    await this.ready;
    const expected = normalizeConversationId(conversationId);
    const keepId = String(keepGoalId || "").trim();
    const keep = this.getGoal(keepId);
    if (!expected || keep.conversationId !== expected || !NONTERMINAL_GOAL_STATUSES.has(keep.status)) {
      throw new Error("Collision repair requires the exact nonterminal Goal currently bound to the conversation.");
    }
    const group = nonterminalConversationGoals(this.state, expected);
    if (group.length <= 1) return { kept: clone(keep), stopped: [], repaired: false };
    if (!group.some((goal) => goal.id === keep.id)) {
      throw new Error(`Goal ${keep.id} is not part of the current conversation collision.`);
    }
    const keepCreatedAt = Date.parse(String(keep.createdAt || ""));
    const stale = group.filter((goal) => goal.id !== keep.id);
    const unsafe = stale.filter((goal) => (
      goal.round !== 1
      || goal.roundState !== "working"
      || goal.lastRoundReport != null
      || (Array.isArray(goal.recentReports) && goal.recentReports.length > 0)
      || goal.completionEvidence != null
      || goal.continuation?.state !== "idle"
      || !Number.isFinite(Date.parse(String(goal.createdAt || "")))
      || !Number.isFinite(keepCreatedAt)
      || Date.parse(String(goal.createdAt)) >= keepCreatedAt
    ));
    if (unsafe.length) {
      throw new Error(`Collision repair refused: Goals ${unsafe.map((goal) => goal.id).join(", ")} contain progressed or non-older state.`);
    }
    const repairedAt = this.nowIso();
    const normalizedReason = cleanText(reason, 240, "Collision repair reason");
    for (const goal of stale) {
      goal.status = "stopped";
      goal.stoppedAt = repairedAt;
      goal.continuation = idleContinuation();
      goal.roundRecovery = idleRoundRecovery(goal.round);
      goal.supersededByGoalId = keep.id;
      goal.supersededAt = repairedAt;
      goal.supersededReason = normalizedReason;
      this.touch(goal);
    }
    await this.save();
    return { kept: clone(keep), stopped: stale.map((goal) => clone(goal)), repaired: true };
  }

  async claimRoundRecovery({ goalId } = {}) {
    await this.ready;
    const goal = ensureRoundRecoveryShape(this.getGoal(goalId));
    if (goal.status !== "active" || goal.roundState !== "working" || goal.round < 1 || !goal.roundBeganAt) {
      return { goal: clone(goal), claimed: false, reason: "round-not-recoverable" };
    }

    const recovery = goal.roundRecovery?.round === goal.round
      ? goal.roundRecovery
      : idleRoundRecovery(goal.round);
    const retryAfterMs = Date.parse(String(recovery.retryAfterAt || ""));
    if (recovery.state === "dispatching") {
      return { goal: clone(goal), claimed: false, reason: "recovery-in-flight" };
    }
    if (recovery.state === "dispatched") {
      return { goal: clone(goal), claimed: false, reason: "recovery-already-dispatched" };
    }
    if (recovery.state === "idle" && Number.isFinite(retryAfterMs) && this.now() < retryAfterMs) {
      return { goal: clone(goal), claimed: false, reason: "recovery-cooldown" };
    }

    let priorAttempts = Number(recovery.attempts ?? 0);
    // The attempt cap is a burst guard, not a permanent dead state. A round
    // that reached the cap because the page was still genuinely generating
    // must become recoverable again after the bounded cooldown once the
    // terminal evidence is safe. Successfully dispatched episodes remain
    // permanently closed by the distinct `dispatched` state above.
    if (
      recovery.state === "idle"
      && priorAttempts >= MAX_ROUND_RECOVERY_ATTEMPTS
      && (!Number.isFinite(retryAfterMs) || this.now() >= retryAfterMs)
    ) {
      priorAttempts = 0;
    }
    const attempt = priorAttempts + 1;
    if (attempt > MAX_ROUND_RECOVERY_ATTEMPTS) {
      return { goal: clone(goal), claimed: false, reason: "recovery-attempt-limit", exhausted: true };
    }

    const recoveryId = randomId("recovery");
    const claimedAt = this.nowIso();
    goal.roundRecovery = {
      state: "dispatching",
      round: goal.round,
      recoveryId,
      attempts: attempt,
      claimedAt,
      dispatchedAt: null,
      retryAfterAt: null,
    };
    this.touch(goal);
    await this.save();
    return {
      goal: clone(goal),
      claimed: true,
      claim: {
        goalId: goal.id,
        round: goal.round,
        recoveryId,
        attempt,
        prompt: buildRoundRecoveryPrompt(goal, recoveryId),
      },
    };
  }

  async roundRecovery({ goalId, action, recoveryId } = {}) {
    await this.ready;
    const goal = ensureRoundRecoveryShape(this.getGoal(goalId));
    const command = String(action ?? "");
    const requestedRecoveryId = String(recoveryId ?? "");
    if (!requestedRecoveryId) throw new Error(`Goal round recovery ${command} requires recoveryId.`);
    if (goal.roundRecovery?.state !== "dispatching") {
      throw new Error(`Goal ${goal.id} round recovery is ${goal.roundRecovery?.state || "idle"}; no dispatch claim is active.`);
    }
    if (goal.roundRecovery.recoveryId !== requestedRecoveryId) {
      throw new Error(`Goal ${goal.id} round recovery id does not match.`);
    }

    if (command === "ack") {
      goal.roundRecovery = {
        ...goal.roundRecovery,
        state: "dispatched",
        dispatchedAt: this.nowIso(),
        retryAfterAt: null,
      };
      this.touch(goal);
      await this.save();
      return { goal: clone(goal), acknowledged: true };
    }
    if (command === "release") {
      goal.roundRecovery = idleRoundRecovery(
        goal.round,
        Number(goal.roundRecovery.attempts ?? 0),
        this.continuationExpiryIso(DEFAULT_ROUND_RECOVERY_RELEASE_MS),
      );
      this.touch(goal);
      await this.save();
      return { goal: clone(goal), released: true };
    }
    throw new Error(`Invalid Goal round recovery action: ${command}`);
  }

  async close() {
    await this.ready;
    await this.persistQueue;
  }
}
