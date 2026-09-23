const DEFAULT_MAX_SILENT_MS = 10 * 60_000;

const SETUP_TOOLS = new Set([
  "devspace_progress_report",
  "devspace_plan_start",
  "devspace_plan_status",
  "devspace_plan_mount",
  "devspace_goal_start",
  "devspace_goal_status",
  "devspace_goal_round_begin",
  "devspace_goal_mount",
  "open_workspace",
  "devspace_route",
  "tool_search",
  "capability_route",
  "capability_search",
  "capability_inspect",
  "capability_read",
  "request_user_input",
]);

const GOAL_ROUND_CLOSURE_ALLOWED_TOOLS = new Set([
  "devspace_goal_turn_report",
  "devspace_progress_report",
  "devspace_goal_status",
  "devspace_plan_status",
  "devspace_goal_complete",
  "devspace_goal_blocked",
  "devspace_goal_control",
  "devspace_goal_mount",
  "devspace_plan_mount",
  "devspace_plan_start",
  "request_user_input",
]);

function cleanText(value, max = 240) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function cleanConversationId(value) {
  const text = cleanText(value, 200);
  return text && /^[A-Za-z0-9_-]{8,200}$/.test(text) ? text : null;
}

function cleanRuntimeKey(value) {
  const text = cleanText(value, 80)?.toLowerCase();
  return text && /^main-\d{2}$/.test(text) ? text : null;
}

function timestampMs(value) {
  const parsed = typeof value === "number" ? value : Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function isPlanCompletionCall(toolName, args) {
  if (String(toolName || "") !== "devspace_update_plan") return false;
  const steps = Array.isArray(args?.steps) ? args.steps : [];
  return steps.length > 0 && steps.every((step) => step?.status === "completed");
}

export function isProgressSetupTool(toolName, args) {
  const name = String(toolName || "").trim();
  if (!name) return true;
  if (isPlanCompletionCall(name, args)) return false;
  if (name === "devspace_update_plan") return true;
  return SETUP_TOOLS.has(name);
}

export function goalRoundClosureState({ activeGoal = null, activePlan = null, latestPlan = null } = {}) {
  if (activePlan) return null;
  if (activeGoal?.status !== "active" || activeGoal?.roundState !== "working") return null;
  if (!Number.isInteger(activeGoal?.round) || activeGoal.round < 1) return null;
  if (latestPlan?.status !== "completed" || !latestPlan?.completedAt) return null;
  if (activeGoal?.conversationId && latestPlan?.conversationId !== activeGoal.conversationId) return null;
  const roundBeganAtMs = timestampMs(activeGoal.roundBeganAt);
  const planCreatedAtMs = timestampMs(latestPlan.createdAt);
  const planCompletedAtMs = timestampMs(latestPlan.completedAt);
  if (roundBeganAtMs == null || planCreatedAtMs == null || planCompletedAtMs == null) return null;
  // A prior round's completed Plan must never close a newly begun round. Allow
  // only a one-second clock-serialization tolerance for the current round.
  if (planCreatedAtMs < roundBeganAtMs - 1_000 || planCompletedAtMs < roundBeganAtMs - 1_000) return null;
  return {
    goalId: cleanText(activeGoal.id, 200),
    round: activeGoal.round,
    planId: cleanText(latestPlan.id, 200),
    planCompletedAt: latestPlan.completedAt,
  };
}

function block(reason, message, extra = {}) {
  return { ok: false, blocked: true, activityAccepted: false, reason, message, ...extra };
}

export class InteractiveProgressEnforcementGate {
  constructor({
    now = () => Date.now(),
    maxSilentMs = DEFAULT_MAX_SILENT_MS,
    latestProgressAt = async () => null,
  } = {}) {
    this.now = now;
    this.maxSilentMs = Math.max(30_000, Number(maxSilentMs) || DEFAULT_MAX_SILENT_MS);
    this.latestProgressAt = latestProgressAt;
    this.turns = new Map();
  }

  noteTurn(event = {}) {
    const conversationId = cleanConversationId(event.conversationId);
    if (!conversationId) return null;
    if (event.kind === "started") {
      const startedAtMs = timestampMs(event.observedAtMs ?? event.observedAt) ?? this.now();
      const row = {
        conversationId,
        turnKey: cleanText(event.turnTraceFingerprint, 80) || cleanText(event.requestId, 160) || `turn:${startedAtMs}`,
        startedAtMs,
        substantiveCalls: 0,
        lastReportAtMs: null,
      };
      this.turns.set(conversationId, row);
      return { ...row };
    }
    if (["failed", "evicted"].includes(event.kind)) this.turns.delete(conversationId);
    return this.turns.get(conversationId) ? { ...this.turns.get(conversationId) } : null;
  }

  noteReport({ conversationId, observedAtMs } = {}) {
    const id = cleanConversationId(conversationId);
    if (!id) return null;
    const atMs = timestampMs(observedAtMs) ?? this.now();
    const row = this.#ensureTurn(id);
    row.lastReportAtMs = Math.max(Number(row.lastReportAtMs || 0), atMs);
    return { ...row };
  }

  clearConversation(conversationId) {
    const id = cleanConversationId(conversationId);
    return id ? this.turns.delete(id) : false;
  }

  async beforeTool({
    conversationId,
    runtimeKey,
    toolName,
    args = {},
    activePlan = null,
    roundClosure = null,
  } = {}) {
    const id = cleanConversationId(conversationId);
    const runtime = cleanRuntimeKey(runtimeKey);
    const name = String(toolName || "").trim();
    if (!id || !runtime) return { ok: true, enforced: false, activityAccepted: false, reason: "not-exact-main" };
    if (name === "devspace_progress_report") return { ok: true, enforced: true, activityAccepted: false, reason: "progress-tool" };

    if (name === "devspace_goal_turn_report" && activePlan) {
      return block(
        "goal-round-plan-incomplete",
        `Active Plan ${activePlan.id || "for this turn"} is not completed. Update every Plan step to completed before calling devspace_goal_turn_report. Do not end the visible turn while this Plan remains active.`,
        {
          errorType: "devspace_goal_round_plan_incomplete",
          planId: activePlan.id || null,
        },
      );
    }

    if (roundClosure) {
      if (GOAL_ROUND_CLOSURE_ALLOWED_TOOLS.has(name)) {
        return {
          ok: true,
          enforced: true,
          activityAccepted: false,
          reason: name === "devspace_goal_turn_report"
            ? "goal-round-report-tool"
            : "goal-round-closure-control-tool",
          ...roundClosure,
        };
      }
      return block(
        "goal-round-report-required",
        `Plan ${roundClosure.planId || "for this turn"} is completed while Goal ${roundClosure.goalId || "for this conversation"} round ${roundClosure.round ?? "current"} is still working. If the round is finished, call devspace_goal_turn_report as the final tool now and then give one visible final report. If meaningful work remains, start a fresh devspace_plan_start before any other substantive tool.`,
        {
          errorType: "devspace_goal_round_report_required",
          goalId: roundClosure.goalId || null,
          round: roundClosure.round ?? null,
          planId: roundClosure.planId || null,
        },
      );
    }

    const nowMs = this.now();
    const row = this.#ensureTurn(id);
    const persistedAtMs = timestampMs(await this.latestProgressAt(id).catch(() => null));
    if (persistedAtMs && persistedAtMs > Number(row.lastReportAtMs || 0)) row.lastReportAtMs = persistedAtMs;

    const planCreatedAtMs = timestampMs(activePlan?.createdAt);
    const requiredAfterMs = Math.max(row.startedAtMs, planCreatedAtMs || 0);
    const hasCurrentReport = Number(row.lastReportAtMs || 0) >= requiredAfterMs;
    const reportAgeMs = row.lastReportAtMs ? Math.max(0, nowMs - row.lastReportAtMs) : null;
    const reportFresh = hasCurrentReport && reportAgeMs <= this.maxSilentMs;

    if (isPlanCompletionCall(name, args)) {
      if (!reportFresh) {
        return block(
          hasCurrentReport ? "final-progress-stale" : "final-progress-required",
          hasCurrentReport
            ? "Progress narration is stale. Call devspace_progress_report with the latest verified result before completing the Plan and replying to the user."
            : "This multi-step Plan cannot be completed yet. Call devspace_progress_report with the latest verified result before completing the Plan and replying to the user.",
          { reportAgeMs, maxSilentMs: this.maxSilentMs },
        );
      }
      return { ok: true, enforced: true, activityAccepted: false, reason: "plan-completion-progress-current", reportAgeMs };
    }

    if (isProgressSetupTool(name, args)) return { ok: true, enforced: true, activityAccepted: false, reason: "setup-tool" };

    if (activePlan) {
      if (!reportFresh) {
        return block(
          hasCurrentReport ? "progress-stale" : "progress-preflight-required",
          hasCurrentReport
            ? "The current progress narration is older than the ten-minute ceiling. Call devspace_progress_report with a useful current update before starting another substantive tool."
            : "This conversation has an active multi-step Plan but no successful progress preflight for the current turn. Call devspace_progress_report before this substantive tool, then retry it.",
          { reportAgeMs, maxSilentMs: this.maxSilentMs, planId: activePlan.id || null },
        );
      }
      row.substantiveCalls += 1;
      return { ok: true, enforced: true, activityAccepted: true, reason: "active-plan-progress-current", substantiveCalls: row.substantiveCalls, reportAgeMs };
    }

    if (hasCurrentReport && !reportFresh) {
      return block(
        "progress-stale",
        "The current progress narration is older than the ten-minute ceiling. Call devspace_progress_report with a useful current update before starting another substantive tool.",
        { substantiveCalls: row.substantiveCalls, reportAgeMs, maxSilentMs: this.maxSilentMs },
      );
    }
    if (!reportFresh && row.substantiveCalls >= 1) {
      return block(
        "second-substantive-tool-requires-progress",
        "This turn is no longer atomic: a second substantive tool was requested without a successful progress narration. Call devspace_progress_report now, then retry this tool. If the direct claim is pending, complete the exact-page relay/bridge first; program telemetry must not author the message for you.",
        { substantiveCalls: row.substantiveCalls, reportAgeMs, maxSilentMs: this.maxSilentMs },
      );
    }
    row.substantiveCalls += 1;
    return {
      ok: true,
      enforced: true,
      activityAccepted: true,
      reason: reportFresh ? "progress-current" : "atomic-first-substantive-tool",
      substantiveCalls: row.substantiveCalls,
      reportAgeMs,
    };
  }

  status(conversationId = null) {
    const id = cleanConversationId(conversationId);
    if (id) return this.turns.get(id) ? { ...this.turns.get(id), maxSilentMs: this.maxSilentMs } : null;
    return {
      maxSilentMs: this.maxSilentMs,
      conversations: [...this.turns.values()].map((row) => ({ ...row })),
    };
  }

  #ensureTurn(conversationId) {
    let row = this.turns.get(conversationId);
    if (!row) {
      const nowMs = this.now();
      row = {
        conversationId,
        turnKey: `implicit:${nowMs}`,
        startedAtMs: nowMs,
        substantiveCalls: 0,
        lastReportAtMs: null,
      };
      this.turns.set(conversationId, row);
    }
    return row;
  }
}

export const interactiveProgressEnforcementInternals = {
  DEFAULT_MAX_SILENT_MS,
  SETUP_TOOLS,
  GOAL_ROUND_CLOSURE_ALLOWED_TOOLS,
  cleanConversationId,
  cleanRuntimeKey,
  timestampMs,
};
