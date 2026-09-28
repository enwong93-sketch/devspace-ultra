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

function advisory(reason, message, extra = {}, activityAccepted = false) {
  return { ok: true, blocked: false, advisory: true, activityAccepted, reason, message, ...extra };
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
  } = {}) {
    const id = cleanConversationId(conversationId);
    const runtime = cleanRuntimeKey(runtimeKey);
    const name = String(toolName || "").trim();
    if (!id || !runtime) return { ok: true, enforced: false, activityAccepted: false, reason: "not-exact-main" };
    if (name === "devspace_progress_report") return { ok: true, enforced: true, activityAccepted: false, reason: "progress-tool" };
    const row = this.#ensureTurn(id);

    const nowMs = this.now();
    const persistedAtMs = timestampMs(await this.latestProgressAt(id).catch(() => null));
    if (persistedAtMs && persistedAtMs > Number(row.lastReportAtMs || 0)) row.lastReportAtMs = persistedAtMs;

    const planCreatedAtMs = timestampMs(activePlan?.createdAt);
    const requiredAfterMs = Math.max(row.startedAtMs, planCreatedAtMs || 0);
    const hasCurrentReport = Number(row.lastReportAtMs || 0) >= requiredAfterMs;
    const reportAgeMs = row.lastReportAtMs ? Math.max(0, nowMs - row.lastReportAtMs) : null;
    const reportFresh = hasCurrentReport && reportAgeMs <= this.maxSilentMs;

    if (isPlanCompletionCall(name, args)) {
      if (!reportFresh) {
        return advisory(
          hasCurrentReport ? "final-progress-stale" : "final-progress-required",
          hasCurrentReport
            ? "Plan completion is continuing with stale narration. Call devspace_progress_report with the latest verified result before the user-visible final report."
            : "Plan completion is continuing without a current narration entry. Call devspace_progress_report with the latest verified result before the user-visible final report.",
          { reportAgeMs, maxSilentMs: this.maxSilentMs },
        );
      }
      return { ok: true, enforced: true, activityAccepted: false, reason: "plan-completion-progress-current", reportAgeMs };
    }

    if (isProgressSetupTool(name, args)) return { ok: true, enforced: true, activityAccepted: false, reason: "setup-tool" };

    if (activePlan) {
      if (!reportFresh) {
        row.substantiveCalls += 1;
        return advisory(
          hasCurrentReport ? "progress-stale" : "progress-preflight-required",
          hasCurrentReport
            ? "The current progress narration is older than the ten-minute ceiling. This substantive tool is continuing; call devspace_progress_report with a useful current update at the next meaningful boundary."
            : "This conversation has an active multi-step Plan but no successful progress preflight for the current turn. This substantive tool is continuing; call devspace_progress_report at the next meaningful boundary.",
          { reportAgeMs, maxSilentMs: this.maxSilentMs, planId: activePlan.id || null },
          true,
        );
      }
      row.substantiveCalls += 1;
      return { ok: true, enforced: true, activityAccepted: true, reason: "active-plan-progress-current", substantiveCalls: row.substantiveCalls, reportAgeMs };
    }

    if (hasCurrentReport && !reportFresh) {
      row.substantiveCalls += 1;
      return advisory(
        "progress-stale",
        "The current progress narration is older than the ten-minute ceiling. This substantive tool is continuing; call devspace_progress_report with a useful current update at the next meaningful boundary.",
        { substantiveCalls: row.substantiveCalls, reportAgeMs, maxSilentMs: this.maxSilentMs },
        true,
      );
    }
    if (!reportFresh && row.substantiveCalls >= 1) {
      row.substantiveCalls += 1;
      return advisory(
        "second-substantive-tool-requires-progress",
        "This turn is no longer atomic and a second substantive tool is continuing without a successful progress narration. Call devspace_progress_report at the next meaningful boundary; if the direct claim is pending, complete the exact-page relay or owner bridge without asking the user to perform routine pairing. Program telemetry must not author the message for you.",
        { substantiveCalls: row.substantiveCalls, reportAgeMs, maxSilentMs: this.maxSilentMs },
        true,
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
  cleanConversationId,
  cleanRuntimeKey,
  timestampMs,
};
