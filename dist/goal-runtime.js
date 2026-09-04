import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const STATE_VERSION = 1;
const GOAL_STATUSES = new Set(["active", "paused", "blocked", "completed", "stopped"]);
const ROUND_STATES = new Set(["working", "reported"]);
const CONTINUATION_STATES = new Set(["idle", "pending", "dispatching", "dispatched"]);
const MIN_CRITERIA = 1;
const MAX_CRITERIA = 12;
const MAX_OBJECTIVE_CHARS = 4_000;
const MAX_CRITERION_CHARS = 1_000;
const MAX_REPORT_SUMMARY_CHARS = 4_000;
const MAX_BLOCKER_FINGERPRINT_CHARS = 500;
const MAX_EVIDENCE_CHARS = 4_000;
const REPORT_HISTORY_LIMIT = 32;
const DEFAULT_DISPATCH_LEASE_MS = 45_000;
const DEFAULT_DISPATCH_RECOVERY_MS = 120_000;

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
    "Then read current Goal state, preserve the full original objective and success criteria, perform meaningful next work, verify progress, give the user a complete visible report for this round, and finish with devspace_goal_turn_report.",
    "Do not silently shrink the Goal to an easier sub-goal. If the Goal is already completed, paused, blocked, or stopped, do not continue work.",
  ].join("\n");
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

function validateGoalShape(goal) {
  if (!goal || !/^goal_[a-f0-9]{16}$/.test(String(goal.id ?? ""))) {
    throw new Error("invalid persisted goal id");
  }
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
  for (const goal of Object.values(value.goals)) validateGoalShape(goal);
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
    const snapshot = JSON.stringify(this.state, null, 2);
    this.persistQueue = this.persistQueue.then(async () => {
      await mkdir(dirname(this.statePath), { recursive: true });
      await writeFile(this.statePath, snapshot, "utf8");
    });
    await this.persistQueue;
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

  async start({ objective, successCriteria }) {
    await this.ready;
    const timestamp = this.nowIso();
    const goal = {
      id: randomId("goal"),
      objective: cleanText(objective, MAX_OBJECTIVE_CHARS, "Goal objective"),
      status: "active",
      round: 1,
      roundState: "working",
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
    goal.continuation = idleContinuation();
    this.touch(goal);
    await this.save();
    return clone(goal);
  }

  async close() {
    await this.ready;
    await this.persistQueue;
  }
}
