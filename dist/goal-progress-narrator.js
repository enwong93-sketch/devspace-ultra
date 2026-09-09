import { readFile } from "node:fs/promises";

const DEFAULT_POLL_MS = 500;
const MAX_AGENT_REPORT_PARTS = 12;
const MAX_AGENT_REPORT_TEXT = 1_600;
const SENSITIVE = /(Bearer\s+\S+|(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[=:]\s*\S+)/i;

function clip(value, max) {
  const text = String(value ?? "").replace(/\r/g, "").trim();
  if (!text || SENSITIVE.test(text)) return null;
  return text.slice(0, max);
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function runKey(row) {
  const goalId = clip(row?.goalId, 160);
  const round = Math.max(1, Math.floor(number(row?.round, 1)));
  return goalId ? `${goalId}:${round}` : null;
}

function planRows(payload) {
  if (Array.isArray(payload?.plans)) return payload.plans;
  if (payload?.plans && typeof payload.plans === "object") return Object.values(payload.plans);
  return [];
}

function goalRows(payload) {
  if (Array.isArray(payload?.goals)) return payload.goals;
  if (payload?.goals && typeof payload.goals === "object") return Object.values(payload.goals);
  return [];
}

function progressRows(payload) {
  const rows = [];
  const byKey = new Map();
  for (const row of [...(Array.isArray(payload?.runs) ? payload.runs : []), payload?.active].filter(Boolean)) {
    const key = runKey(row);
    if (!key || !row?.conversationId) continue;
    byKey.set(key, row);
  }
  for (const row of byKey.values()) rows.push(row);
  return rows;
}

function rowActivityMs(row, fallback = 0) {
  for (const value of [row?.lastBoundaryAt, row?.inFlightStartedAt, row?.turnObservedAt, row?.heartbeatAt]) {
    const parsed = Date.parse(value || "");
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * Select currently authoritative Goal/Plan/conversation rows for UI context.
 * This function does not create user-visible narration.
 */
export function activeProgressRows({ progressState, planState, goalState, nowMs = Date.now(), maxConversationAgeMs = 30 * 60_000 } = {}) {
  const plans = planRows(planState).filter((plan) => plan?.status === "active" && plan?.conversationId);
  const hasGoalAuthority = Boolean(goalState && typeof goalState === "object");
  const goals = goalRows(goalState).filter((goal) => goal?.status === "active" && goal?.conversationId);
  const planIds = new Set(plans.map((plan) => plan.id));
  const goalKeys = new Set(goals.map((goal) => `${goal.id}:${Math.max(1, Math.floor(number(goal.round, 1)))}`));
  const authoritativeConversations = new Set([
    ...plans.map((plan) => plan.conversationId),
    ...goals.map((goal) => goal.conversationId),
  ]);
  const activeKey = runKey(progressState?.active || {});
  const conversationGrace = Math.max(1_000, number(maxConversationAgeMs, 30 * 60_000));
  return progressRows(progressState).filter((row) => {
    const key = runKey(row);
    if (row?.progressKind === "plan") {
      const planId = row?.planId || String(row?.goalId || "").replace(/^plan:/, "");
      return planIds.has(planId);
    }
    if (row?.progressKind === "conversation") {
      if (authoritativeConversations.has(row?.conversationId)) return false;
      if (number(row?.inFlightCount) > 0) return true;
      const activityMs = rowActivityMs(row);
      return activityMs > 0 && nowMs - activityMs >= -60_000 && nowMs - activityMs <= conversationGrace;
    }
    if (goalKeys.has(key)) return true;
    if (!hasGoalAuthority && key === activeKey) {
      return number(row?.inFlightCount) > 0 || nowMs - rowActivityMs(row) <= conversationGrace;
    }
    return false;
  });
}

function splitAgentReport(value) {
  const text = String(value ?? "").replace(/\r/g, "").trim();
  if (!text || SENSITIVE.test(text)) return [];
  const paragraphs = text.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const parts = [];
  for (const paragraph of paragraphs.length ? paragraphs : [text]) {
    let remaining = paragraph;
    while (remaining && parts.length < MAX_AGENT_REPORT_PARTS) {
      if (remaining.length <= MAX_AGENT_REPORT_TEXT) {
        parts.push(remaining);
        break;
      }
      const window = remaining.slice(0, MAX_AGENT_REPORT_TEXT + 1);
      const boundary = Math.max(
        window.lastIndexOf("。"),
        window.lastIndexOf("；"),
        window.lastIndexOf(". "),
        window.lastIndexOf("; "),
        window.lastIndexOf("\n"),
      );
      const take = boundary >= Math.floor(MAX_AGENT_REPORT_TEXT * 0.6) ? boundary + 1 : MAX_AGENT_REPORT_TEXT;
      parts.push(remaining.slice(0, take).trim());
      remaining = remaining.slice(take).trim();
    }
    if (parts.length >= MAX_AGENT_REPORT_PARTS) break;
  }
  return parts.filter(Boolean);
}

/**
 * Convert an explicit agent-authored Goal round report into card rows without
 * adding headings, counters, status boilerplate, or other program-written text.
 */
export function goalRoundReportNarration(goal) {
  const report = goal?.lastRoundReport;
  const round = Math.max(1, Math.floor(number(report?.round, goal?.round || 1)));
  const reportedAt = clip(report?.reportedAt, 80);
  const parts = splitAgentReport(report?.summary);
  if (!goal?.id || !goal?.conversationId || !reportedAt || !parts.length) return [];
  return parts.map((text, index) => ({
    text,
    conversationId: goal.conversationId,
    goalId: goal.id,
    round,
    kind: "agent-round-report",
    source: "goal-round-report",
    dedupeKey: `${goal.id}:${round}:agent-round-report:${reportedAt}:${index + 1}`,
  }));
}

/**
 * Legacy export retained for callers/tests. Automatic objective, milestone,
 * failure, silence, and tool-count narration is intentionally disabled.
 */
export function decideGoalProgressNarration() {
  return null;
}

async function readJson(path) {
  try {
    return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function existingDedupeKeys(messages) {
  return new Set((Array.isArray(messages) ? messages : [])
    .map((item) => clip(item?.dedupeKey, 500))
    .filter(Boolean));
}

export class GoalProgressNarrator {
  constructor({
    progressStatePath = null,
    planStatePath = null,
    goalStatePath = null,
    humanProgress,
    pollMs = DEFAULT_POLL_MS,
  } = {}) {
    if (!goalStatePath) throw new Error("GoalProgressNarrator requires goalStatePath.");
    if (!humanProgress || typeof humanProgress.update !== "function" || typeof humanProgress.snapshot !== "function") {
      throw new Error("GoalProgressNarrator requires the Stable Gateway human-progress store.");
    }
    this.progressStatePath = progressStatePath;
    this.planStatePath = planStatePath;
    this.goalStatePath = goalStatePath;
    this.humanProgress = humanProgress;
    this.pollMs = Math.max(250, number(pollMs, DEFAULT_POLL_MS));
    this.timer = null;
    this.polling = null;
    this.closed = false;
    this.lastResult = null;
  }

  async start({ schedule = true } = {}) {
    const result = await this.pollOnce();
    if (schedule && !this.closed && !this.timer) {
      this.timer = setInterval(() => { void this.pollOnce(); }, this.pollMs);
      this.timer.unref?.();
    }
    return result;
  }

  async pollOnce() {
    if (this.closed) return this.lastResult;
    if (this.polling) return this.polling;
    this.polling = this.#pollOnceImpl().finally(() => { this.polling = null; });
    return this.polling;
  }

  async #pollOnceImpl() {
    const goalState = await readJson(this.goalStatePath);
    const known = existingDedupeKeys(this.humanProgress.snapshot()?.messages);
    const published = [];
    for (const goal of goalRows(goalState)) {
      for (const row of goalRoundReportNarration(goal)) {
        if (known.has(row.dedupeKey)) continue;
        await this.humanProgress.update(row);
        known.add(row.dedupeKey);
        published.push({
          conversationId: row.conversationId,
          goalId: row.goalId,
          round: row.round,
          dedupeKey: row.dedupeKey,
        });
      }
    }
    this.lastResult = {
      ok: true,
      action: published.length ? "published-agent-report" : "observed",
      agentAuthoredOnly: true,
      published: published.length > 0,
      publishedCount: published.length,
      publishedRows: published,
    };
    return this.lastResult;
  }

  status() {
    return {
      enabled: true,
      running: Boolean(this.timer),
      pollInProgress: Boolean(this.polling),
      pollMs: this.pollMs,
      agentAuthoredOnly: true,
      automaticToolNarration: false,
      periodicNarration: false,
      lastResult: this.lastResult,
    };
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.polling?.catch?.(() => {});
  }
}
