import { readFile } from "node:fs/promises";
import { atomicWriteJson } from "./atomic-file.js";

const VERSION = 1;
const EVIDENCE_VERSION = 2;
const DEFAULT_HEARTBEAT_MS = 15_000;
const MAX_RUNS = 32;
const MAX_IN_FLIGHT = 128;
const MAX_RECENT_BOUNDARIES = 64;

function clip(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}
function key(goal) { return `${goal.id ?? goal.goalId ?? goal.runId}:${goal.round}`; }
function category(name) {
  if (/^(read|grep|glob|ls|context_|browser_control_status|chat_.*_status|devspace_.*_status)/.test(name)) return "inspection";
  if (/^(edit|write|apply_patch|show_changes)/.test(name)) return "change";
  if (/^(bash|exec_command|write_stdin)/.test(name)) return "verification";
  if (/^(devspace_goal_|devspace_plan_|update_plan)/.test(name)) return "goal-control";
  if (/^capability_/.test(name)) return "capability";
  return "work";
}
function phrase(value) {
  return { inspection: "資料核對", change: "程式修改", verification: "命令／測試", "goal-control": "任務狀態更新", capability: "本機工具操作" }[value] || "工作";
}
async function atomicWrite(path, payload) {
  await atomicWriteJson(path, payload);
}

/** Observability only: a heartbeat never authorizes recovery or proves model activity. */
export class GoalRunProgressSupervisor {
  constructor({ statePath, goalRuntime, planRuntime = null, heartbeatMs = DEFAULT_HEARTBEAT_MS, staleAfterMs = 60_000, now = () => Date.now(), writeState = atomicWrite } = {}) {
    this.statePath = clip(statePath, 4096);
    if (!this.statePath) throw new Error("GoalRunProgressSupervisor requires statePath.");
    if (!goalRuntime || typeof goalRuntime.activeGoals !== "function") throw new Error("GoalRunProgressSupervisor requires GoalRuntime.");
    this.goalRuntime = goalRuntime;
    this.planRuntime = planRuntime && typeof planRuntime.activePlans === "function" ? planRuntime : null;
    this.heartbeatMs = Math.max(2_000, Number(heartbeatMs) || DEFAULT_HEARTBEAT_MS);
    this.staleAfterMs = Math.max(2_000, Number(staleAfterMs) || 60_000);
    this.now = now;
    this.writeState = writeState;
    this.state = { version: VERSION, evidenceVersion: EVIDENCE_VERSION, active: null, runs: [], updatedAt: null };
    this.runs = new Map();
    this.inFlight = new Map();
    this.timer = null;
    this.heartbeatPending = null;
    this.pendingSnapshot = null;
    this.persistQueue = null;
    this.persistenceError = null;
    this.closed = false;
  }

  async load() {
    try {
      const parsed = JSON.parse((await readFile(this.statePath, "utf8")).replace(/^\uFEFF/, ""));
      if (parsed?.version === VERSION) {
        const saved = Array.isArray(parsed.runs) && parsed.runs.length ? parsed.runs : [parsed.active];
        for (const row of saved.filter((r) => r?.goalId).slice(-MAX_RUNS)) {
          const recentBoundaries = (Array.isArray(row.recentBoundaries) ? row.recentBoundaries : [])
            .filter((item) => item?.at && Number.isInteger(Number(item?.stepCount)))
            .slice(-MAX_RECENT_BOUNDARIES)
            .map((item) => ({
              at: clip(item.at, 80),
              stepCount: Math.max(1, Math.floor(Number(item.stepCount))),
              toolName: clip(item.toolName, 120) || "unknown",
              toolCategory: clip(item.toolCategory, 80) || "work",
              success: item.success === true ? true : item.success === false ? false : null,
              durationMs: Number.isFinite(Number(item.durationMs)) ? Math.max(0, Math.round(Number(item.durationMs))) : null,
            }));
          const restored = { ...row, recentBoundaries, interrupted: Boolean(row.inFlightToolName || row.inFlightCount || row.interrupted), inFlightToolName: null, inFlightToolCategory: null, inFlightStartedAt: null, inFlightCount: 0 };
          if (parsed.evidenceVersion !== EVIDENCE_VERSION) {
            Object.assign(restored, {
              legacyStepCount: Number(row.stepCount || 0), legacyProgressUnverified: true,
              stepCount: 0, successfulSteps: 0, failedSteps: 0,
              lastBoundaryAt: null, lastToolName: null, lastToolCategory: null,
              lastSuccess: null, lastDurationMs: null, recentBoundaries: [],
            });
          }
          this.runs.set(key(restored), restored);
        }
        this.state.active = parsed.active?.goalId ? this.runs.get(key(parsed.active)) || null : null;
      }
    } catch { /* A missing/invalid progress file cannot block actual work. */ }
    return this.snapshot();
  }

  async start() {
    await this.load();
    await this.refreshHeartbeat();
    if (!this.timer && !this.closed) {
      this.timer = setInterval(() => { void this.refreshHeartbeat().catch(() => {}); }, this.heartbeatMs);
      this.timer.unref?.();
    }
    return this.snapshot();
  }

  async resolveGoal({ conversationId = null, goalId = null, runtimeKey = null, monitor = false } = {}) {
    const conversation = clip(conversationId, 240);
    const id = clip(goalId, 240);
    const runtime = clip(runtimeKey, 80);
    const goals = (await this.goalRuntime.activeGoals({ limit: 128 })).filter((g) => g.status === "active");
    const matches = goals.filter((g) => {
      if (id && g.id !== id) return false;
      if (conversation) return g.conversationId === conversation;
      // Explicit legacy Goal observation is permitted; it does not bind identity.
      if (id) return monitor || !g.conversationId;
      return monitor;
    });
    if (matches.length === 1) return { ...matches[0], progressKind: "goal" };

    const requestedPlanId = id?.startsWith("plan:") ? id.slice("plan:".length) : null;
    const requestedConversationId = id?.startsWith("conversation:") ? id.slice("conversation:".length) : null;
    if (id && !requestedPlanId && !requestedConversationId) return null;
    const plans = this.planRuntime
      ? (await this.planRuntime.activePlans({ limit: 128 })).filter((plan) => plan.status === "active")
      : [];
    const planMatches = plans.filter((plan) => {
      if (requestedPlanId && plan.id !== requestedPlanId) return false;
      if (conversation) return plan.conversationId === conversation;
      return Boolean(requestedPlanId && monitor);
    });
    if (planMatches.length === 1) {
      const plan = planMatches[0];
      const current = Array.isArray(plan.steps) ? plan.steps.find((step) => step.status === "in_progress") : null;
      return {
        id: `plan:${plan.id}`,
        planId: plan.id,
        progressKind: "plan",
        conversationId: plan.conversationId || conversation || null,
        status: "active",
        objective: clip(current?.text, 260) || clip(plan.title, 260) || "目前多步工作",
        round: 1,
        revision: Number(plan.revision || 1),
      };
    }

    const directConversation = requestedConversationId || (!id && conversation && /^main-\d{2}$/i.test(runtime || "") ? conversation : null);
    if (!directConversation || (conversation && directConversation !== conversation)) return null;
    return {
      id: `conversation:${directConversation}`,
      planId: null,
      progressKind: "conversation",
      conversationId: directConversation,
      status: "active",
      objective: "目前對話工作",
      round: 1,
      revision: 1,
    };
  }

  runFor(goal) {
    const runKey = key(goal);
    let row = this.runs.get(runKey);
    if (!row) {
      if (this.runs.size >= MAX_RUNS) {
        const evict = [...this.runs.keys()].find((k) => ![...this.inFlight.values()].some((op) => op.runKey === k));
        if (!evict) return null;
        this.runs.delete(evict);
      }
      row = { goalId: goal.id, planId: goal.planId || null, progressKind: goal.progressKind || "goal", round: goal.round, stepCount: 0, successfulSteps: 0, failedSteps: 0, recentBoundaries: [], lastBoundaryAt: null, lastToolName: null, lastToolCategory: null, lastSuccess: null, lastDurationMs: null, interrupted: false };
      this.runs.set(runKey, row);
    }
    Object.assign(row, { goalRevision: goal.revision, planId: goal.planId || row.planId || null, progressKind: goal.progressKind || row.progressKind || "goal", objective: clip(goal.objective, 260) || "目前任務", conversationId: goal.conversationId || null });
    return row;
  }

  describe(row) {
    const calls = [...this.inFlight.values()].filter((op) => op.runKey === key(row));
    const first = calls[0];
    const nowIso = new Date(this.now()).toISOString();
    Object.assign(row, { heartbeatAt: nowIso, inFlightCount: calls.length, inFlightToolName: first?.toolName || null, inFlightToolCategory: first?.category || null, inFlightStartedAt: first?.startedAt || null });
    if (first) {
      const elapsed = Math.max(0, Math.floor((this.now() - Date.parse(first.startedAt)) / 1000));
      row.evidenceState = elapsed * 1000 >= this.staleAfterMs ? "awaiting-result-stale" : "awaiting-result";
      row.currentText = `已提交${phrase(first.category)}，已等候 ${elapsed} 秒，未收到結果。${calls.length > 1 ? `另有 ${calls.length - 1} 個操作等候回傳。` : ""}服務心跳正常唔代表工作已有新進展。`;
    } else if (row.interrupted) {
      row.evidenceState = "interrupted";
      row.currentText = "服務重啟前有操作未回傳，結果尚未確認；已保留進度，唔會當成完成或者自行重做。";
    } else if (!row.lastBoundaryAt) {
      row.evidenceState = "waiting-for-work";
      row.currentText = row.legacyProgressUnverified
        ? "原有任務紀錄已保留；舊版步數未經實際工具結果核對，唔會當成已驗證進展。服務在線，等候新工作紀錄。"
        : "服務仍然在線，任務尚未完成；暫時未收到可歸屬呢個任務嘅工作紀錄。";
    } else {
      const elapsed = Math.max(0, Math.floor((this.now() - Date.parse(row.lastBoundaryAt)) / 1000));
      row.evidenceState = elapsed * 1000 >= this.staleAfterMs ? "no-recent-work" : "waiting-for-work";
      const outcome = row.lastSuccess === true ? "已回傳結果" : row.lastSuccess === false ? "回報未通過" : "結果仍待確認";
      row.currentText = `最近一次${phrase(row.lastToolCategory)}${outcome}，距今 ${elapsed} 秒。現時冇已確認執行中嘅工具；等候下一個工作事件。`;
    }
    return row;
  }

  publish(row) {
    this.state = { version: VERSION, evidenceVersion: EVIDENCE_VERSION, active: row ? this.describe(row) : null, runs: [...this.runs.values()], updatedAt: new Date(this.now()).toISOString() };
    return this.persist();
  }

  async noteToolStart({ toolName, operationId, conversationId = null, goalId = null, runtimeKey = null, signal } = {}) {
    if (this.closed || signal?.aborted) return this.snapshot();
    const id = clip(operationId, 160);
    if (!id || this.inFlight.has(id) || this.inFlight.size >= MAX_IN_FLIGHT) return this.snapshot();
    const goal = await this.resolveGoal({ conversationId, goalId, runtimeKey });
    if (this.closed || signal?.aborted || !goal || this.inFlight.has(id) || this.inFlight.size >= MAX_IN_FLIGHT) return this.snapshot();
    const row = this.runFor(goal);
    if (!row) return this.snapshot();
    row.interrupted = false;
    row.runtimeKey = clip(runtimeKey, 80) || row.runtimeKey || null;
    this.inFlight.set(id, { runKey: key(goal), goalId: goal.id, round: goal.round, conversationId: goal.conversationId || null, runtimeKey: clip(runtimeKey, 80) || null, toolName: clip(toolName, 120) || "unknown", category: category(String(toolName || "")), startedAt: new Date(this.now()).toISOString() });
    await this.publish(row);
    return this.snapshot();
  }

  async noteConversationTurn({ conversationId = null, runtimeKey = null, observedAt = null } = {}) {
    if (this.closed) return this.snapshot();
    const goal = await this.resolveGoal({ conversationId, runtimeKey });
    if (this.closed || !goal) return this.snapshot();
    const row = this.runFor(goal);
    if (!row) return this.snapshot();
    row.interrupted = false;
    row.runtimeKey = clip(runtimeKey, 80) || row.runtimeKey || null;
    const parsedObservedAt = Date.parse(observedAt || "");
    row.turnObservedAt = Number.isFinite(parsedObservedAt) ? new Date(parsedObservedAt).toISOString() : new Date(this.now()).toISOString();
    if (row.progressKind === "conversation" && Number(row.stepCount || 0) === 0) {
      row.objective = "處理目前對話要求，等候第一個已驗證工具結果";
    }
    await this.publish(row);
    return this.snapshot();
  }

  async noteToolBoundary({ operationId, success = null, durationMs = null, conversationId = null } = {}) {
    if (this.closed) return this.snapshot();
    const id = clip(operationId, 160);
    const op = this.inFlight.get(id);
    if (!op || (conversationId && conversationId !== op.conversationId)) return this.snapshot();
    const goal = await this.resolveGoal({ conversationId: op.conversationId, goalId: op.goalId, runtimeKey: op.runtimeKey, monitor: true });
    if (this.closed || this.inFlight.get(id) !== op) return this.snapshot();
    this.inFlight.delete(id);
    if (!goal || goal.round !== op.round) return this.refreshHeartbeat();
    const row = this.runFor(goal);
    row.stepCount = Number(row.stepCount || 0) + 1;
    row.successfulSteps = Number(row.successfulSteps || 0) + (success === true ? 1 : 0);
    row.failedSteps = Number(row.failedSteps || 0) + (success === false ? 1 : 0);
    const boundaryAt = new Date(this.now()).toISOString();
    const normalizedDurationMs = durationMs != null && Number.isFinite(Number(durationMs)) ? Math.max(0, Math.round(Number(durationMs))) : null;
    const recentBoundaries = Array.isArray(row.recentBoundaries) ? row.recentBoundaries : [];
    recentBoundaries.push({
      at: boundaryAt,
      stepCount: row.stepCount,
      toolName: op.toolName,
      toolCategory: op.category,
      success: success === true ? true : success === false ? false : null,
      durationMs: normalizedDurationMs,
    });
    if (recentBoundaries.length > MAX_RECENT_BOUNDARIES) recentBoundaries.splice(0, recentBoundaries.length - MAX_RECENT_BOUNDARIES);
    Object.assign(row, { recentBoundaries, lastBoundaryAt: boundaryAt, lastToolName: op.toolName, lastToolCategory: op.category, lastSuccess: success === true ? true : success === false ? false : null, lastDurationMs: normalizedDurationMs });
    await this.publish(row);
    return this.snapshot();
  }

  refreshHeartbeat() {
    if (this.closed) return Promise.resolve(this.snapshot());
    if (this.heartbeatPending) return this.heartbeatPending;
    this.heartbeatPending = (async () => {
      const goal = await this.resolveGoal({
        conversationId: this.state.active?.conversationId,
        goalId: this.state.active?.goalId,
        runtimeKey: this.state.active?.runtimeKey,
        monitor: true,
      });
      if (this.closed) return this.snapshot();
      await this.publish(goal ? this.runFor(goal) : null);
      return this.snapshot();
    })().finally(() => { this.heartbeatPending = null; });
    return this.heartbeatPending;
  }

  async clear() {
    await this.publish(null);
    return this.snapshot();
  }

  // Serial disk writes, with at most one current and one latest pending snapshot.
  // Intermediate render snapshots may coalesce; state counters have already advanced.
  persist() {
    this.pendingSnapshot = structuredClone(this.state);
    if (this.persistQueue) return this.persistQueue;
    this.persistQueue = Promise.resolve().then(async () => {
      while (this.pendingSnapshot) {
        const payload = this.pendingSnapshot;
        this.pendingSnapshot = null;
        try {
          await this.writeState(this.statePath, payload);
          this.persistenceError = null;
        } catch (error) {
          this.persistenceError = clip(error?.code, 80) || "WRITE_FAILED";
        }
      }
    }).finally(() => { this.persistQueue = null; });
    return this.persistQueue;
  }

  snapshot() { return structuredClone(this.state); }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.heartbeatPending?.catch(() => {});
    await this.persistQueue;
  }
}
