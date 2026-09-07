import { readFile } from "node:fs/promises";

const DEFAULT_POLL_MS = 250;
const DEFAULT_MIN_GAP_MS = 250;
const DEFAULT_MAX_SILENCE_MS = 15_000;
const DEFAULT_LONG_TOOL_MS = 10_000;
const DEFAULT_MILESTONE_EVERY = 1;
const MAX_SESSIONS = 64;
const SENSITIVE = /(Bearer\s+\S+|(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[=:]\s*\S+)/i;

function clip(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
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

function goalById(payload, goalId) {
  const id = clip(goalId, 240);
  return id ? goalRows(payload).find((goal) => goal?.id === id) || null : null;
}

function splitRoundReportSummary(value, maxChars = 420, maxParts = 8) {
  const text = String(value ?? "").replace(/\r/g, "").trim();
  if (!text) return [];
  const paragraphs = text.split(/\n{2,}/).map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean);
  const chunks = [];
  const pushChunk = (raw) => {
    let remaining = raw;
    while (remaining.length > maxChars && chunks.length < maxParts) {
      const window = remaining.slice(0, maxChars + 1);
      const boundary = Math.max(window.lastIndexOf("。"), window.lastIndexOf("；"), window.lastIndexOf(". "), window.lastIndexOf("; "), window.lastIndexOf("，"), window.lastIndexOf(", "), window.lastIndexOf(" "));
      const take = boundary >= Math.floor(maxChars * 0.55) ? boundary + 1 : maxChars;
      chunks.push(remaining.slice(0, take).trim());
      remaining = remaining.slice(take).trim();
    }
    if (remaining && chunks.length < maxParts) chunks.push(remaining.slice(0, maxChars).trim());
  };
  for (const paragraph of paragraphs.length ? paragraphs : [text]) {
    pushChunk(paragraph);
    if (chunks.length >= maxParts) break;
  }
  return chunks.filter(Boolean).slice(0, maxParts);
}

export function goalRoundReportNarration(goal) {
  const report = goal?.lastRoundReport;
  const round = Math.max(1, Math.floor(number(report?.round, goal?.round || 1)));
  const reportedAt = clip(report?.reportedAt, 80);
  const summary = splitRoundReportSummary(report?.summary);
  if (!goal?.id || !reportedAt || !summary.length) return [];
  const prefix = `${goal.id}:${round}:round-report:${reportedAt}`;
  const decorate = (row) => ({
    ...row,
    conversationId: goal.conversationId,
    goalId: goal.id,
    source: "goal-round-report",
    dedupeKey: row.key,
  });
  const rows = [decorate({
    round,
    kind: "round-report-heading",
    key: `${prefix}:heading`,
    text: `第 ${round} 輪工作匯報已提交。以下係本輪已核實進度，完整內容可喺旁白卡向上捲動查看。`,
  })];
  summary.forEach((text, index) => rows.push(decorate({
    round,
    kind: "round-report",
    key: `${prefix}:part:${index + 1}`,
    text: `本輪進度 ${index + 1}/${summary.length}：${text}`,
  })));
  rows.push(decorate({
    round,
    kind: "round-report-status",
    key: `${prefix}:status`,
    text: report?.meaningfulProgress === false
      ? `第 ${round} 輪暫未形成足夠實質進展；Goal 仍會保留原目標同阻塞證據，唔會因完成匯報而當成完成。`
      : `第 ${round} 輪已有實質進展並已寫入後端；Goal 狀態同下一輪 execution frontier 會繼續沿用，唔會重做已完成工作。`,
  }));
  return rows;
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
  for (const value of [row?.lastBoundaryAt, row?.inFlightStartedAt, row?.heartbeatAt]) {
    const parsed = Date.parse(value || "");
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function activeProgressRows({ progressState, planState, goalState, nowMs = Date.now(), maxConversationAgeMs = 30 * 60_000 } = {}) {
  const plans = planRows(planState).filter((plan) => plan?.status === "active" && plan?.conversationId);
  const goals = goalRows(goalState).filter((goal) => goal?.status === "active" && goal?.conversationId);
  const planIds = new Set(plans.map((plan) => plan.id));
  const goalKeys = new Set(goals.map((goal) => `${goal.id}:${Math.max(1, Math.floor(number(goal.round, 1)))}`));
  const activeKey = runKey(progressState?.active || {});
  const fallbackActivity = Date.parse(progressState?.updatedAt || "") || 0;
  return progressRows(progressState).filter((row) => {
    const key = runKey(row);
    if (key === activeKey) return true;
    if (row?.progressKind === "plan") {
      const planId = row?.planId || String(row?.goalId || "").replace(/^plan:/, "");
      return planIds.has(planId);
    }
    if (row?.progressKind === "conversation") {
      if (number(row?.inFlightCount) > 0) return true;
      return nowMs - rowActivityMs(row, fallbackActivity) <= maxConversationAgeMs;
    }
    return goalKeys.has(key);
  });
}

function activePlanContext(payload, conversationId) {
  const plans = planRows(payload)
    .filter((plan) => plan?.status === "active" && plan?.conversationId === conversationId)
    .sort((left, right) => Date.parse(right?.updatedAt || 0) - Date.parse(left?.updatedAt || 0));
  if (plans.length !== 1) return { planId: null, stepId: null, stepText: null };
  const plan = plans[0];
  const step = Array.isArray(plan.steps) ? plan.steps.find((item) => item?.status === "in_progress") : null;
  return {
    planId: clip(plan.id, 160),
    stepId: clip(step?.id, 160),
    stepText: clip(step?.text, 360),
  };
}

function categoryLabel(category) {
  return {
    inspection: "資料核對",
    change: "核心修改",
    verification: "測試／驗證",
    "goal-control": "任務狀態更新",
    capability: "本機能力調用",
    work: "實際工作",
  }[String(category || "")] || "實際工作";
}

function stepPhrase(plan) {
  return plan?.stepText ? `「${plan.stepText}」` : "目前工作階段";
}

function startMessage(plan) {
  return `我而家先處理${stepPhrase(plan)}。會按實際工具結果逐步核對、修正同驗收，唔會將摺疊工具列或者提示詞當成已完成。`;
}

function stepChangeMessage(plan) {
  return `上一個階段已經收斂；而家轉入${stepPhrase(plan)}。下一步會用針對性測試同真實流程驗收，確認唔係只改咗表面設定。`;
}

function toolPhrase(row) {
  const name = clip(row?.lastToolName, 120);
  return name ? `「${name}」` : categoryLabel(row?.lastToolCategory);
}

function durationPhrase(row) {
  const durationMs = number(row?.lastDurationMs);
  if (durationMs < 1_000) return "";
  return `，用時約 ${Math.max(1, Math.round(durationMs / 1_000))} 秒`;
}

function failureMessage(row, plan) {
  return `第 ${Math.max(1, number(row?.stepCount, 1))} 個已驗證步驟 ${toolPhrase(row)} 未通過${durationPhrase(row)}。現有成果已保留；我會喺${stepPhrase(plan)}入面按實際錯誤縮窄原因，再改最少範圍，唔會盲目重做。`;
}

function milestoneMessage(row, plan) {
  const category = String(row?.lastToolCategory || "work");
  const prefix = `第 ${Math.max(1, number(row?.stepCount, 1))} 個已驗證步驟 ${toolPhrase(row)} 已完成${durationPhrase(row)}。`;
  if (category === "inspection") {
    return `${prefix}現況同關鍵證據已核對；我會繼續${stepPhrase(plan)}，按結果收窄根因並落實下一步。`;
  }
  if (category === "change") {
    return `${prefix}核心修改已經落盤；下一步會做針對性測試同真實流程驗收，確認唔係淨係程式碼存在。`;
  }
  if (category === "verification") {
    return `${prefix}測試／命令已經回傳結果；我會繼續對照 production 同實際前端狀態，未達真實使用條件前唔會當成完成。`;
  }
  if (category === "capability") {
    return `${prefix}本機能力已成功回傳；下一步會驗證實際路由同輸出，避免工具存在但工作仍然用唔到。`;
  }
  return `${prefix}${categoryLabel(category)}已有新結果；我會繼續完成${stepPhrase(plan)}餘下可做部分，並以實際驗收作準。`;
}

function silenceMessage(row, plan, nowMs) {
  const startedAt = Date.parse(row?.inFlightStartedAt || "") || null;
  if (startedAt && number(row?.inFlightCount) > 0) {
    const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAt) / 1_000));
    return `${stepPhrase(plan)}仍然進行中；目前有${number(row?.inFlightCount, 1)}個${categoryLabel(row?.inFlightToolCategory)}等候真實結果，最早一個已等候約 ${elapsedSeconds} 秒。未有新證據前我唔會提早判定完成。`;
  }
  return `${stepPhrase(plan)}仍然進行中；最近已有 ${number(row?.stepCount)} 個工具結果，但暫時未有足夠新證據形成下一個結論。我會繼續同一目標，唔會因畫面只顯示工具列就當成已匯報。`;
}

async function readJson(path) {
  try {
    return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function existingNarration(messages, goalId, round) {
  return (Array.isArray(messages) ? messages : [])
    .filter((item) => item?.source === "goal-run-events" && item?.goalId === goalId && Number(item?.round) === round)
    .sort((left, right) => Date.parse(right?.at || 0) - Date.parse(left?.at || 0))[0] || null;
}

function existingDedupeKeys(messages) {
  return new Set((Array.isArray(messages) ? messages : []).map((item) => clip(item?.dedupeKey, 500)).filter(Boolean));
}

function normalizedBoundaries(row) {
  return (Array.isArray(row?.recentBoundaries) ? row.recentBoundaries : [])
    .filter((item) => item?.at && Number.isInteger(Number(item?.stepCount)))
    .map((item) => ({
      at: String(item.at),
      stepCount: Math.max(1, Math.floor(Number(item.stepCount))),
      toolName: clip(item.toolName, 120) || "unknown",
      toolCategory: clip(item.toolCategory, 80) || "work",
      success: item.success === true ? true : item.success === false ? false : null,
      durationMs: Number.isFinite(Number(item.durationMs)) ? Math.max(0, Math.round(Number(item.durationMs))) : null,
    }))
    .sort((left, right) => left.stepCount - right.stepCount || Date.parse(left.at) - Date.parse(right.at));
}

export function decideGoalProgressNarration({ row, plan, session, nowMs, minGapMs, maxSilenceMs, longToolMs, milestoneEvery } = {}) {
  const key = runKey(row);
  if (!key || !row?.conversationId) return null;
  const stepId = plan?.stepId || null;
  const stepCount = number(row?.stepCount);
  const lastBoundaryAt = row?.lastBoundaryAt || null;
  const gapMs = session?.lastMessageAtMs == null ? Number.POSITIVE_INFINITY : nowMs - session.lastMessageAtMs;

  if (!session?.initialized) {
    return { kind: "objective", key: `${key}:objective:${stepId || "none"}`, text: startMessage(plan), force: true };
  }
  if (stepId && stepId !== session.lastPlanStepId) {
    return { kind: "stage", key: `${key}:stage:${stepId}`, text: stepChangeMessage(plan), force: true };
  }
  const pendingBoundary = normalizedBoundaries(row)
    .find((item) => item.stepCount > number(session?.lastNarratedStepCount));
  if (pendingBoundary && gapMs >= minGapMs) {
    const boundaryRow = {
      ...row,
      stepCount: pendingBoundary.stepCount,
      lastBoundaryAt: pendingBoundary.at,
      lastToolName: pendingBoundary.toolName,
      lastToolCategory: pendingBoundary.toolCategory,
      lastSuccess: pendingBoundary.success,
      lastDurationMs: pendingBoundary.durationMs,
    };
    return {
      kind: pendingBoundary.success === false ? "blocker" : "milestone",
      key: `${key}:boundary:${pendingBoundary.stepCount}:${pendingBoundary.at}`,
      text: pendingBoundary.success === false ? failureMessage(boundaryRow, plan) : milestoneMessage(boundaryRow, plan),
      force: true,
      boundaryAt: pendingBoundary.at,
      toolStepCount: pendingBoundary.stepCount,
      toolName: pendingBoundary.toolName,
      toolCategory: pendingBoundary.toolCategory,
    };
  }
  const boundaryChanged = Boolean(lastBoundaryAt && lastBoundaryAt !== session.lastBoundaryAt);
  if (boundaryChanged && row?.lastSuccess === false) {
    return { kind: "blocker", key: `${key}:failed:${lastBoundaryAt}`, text: failureMessage(row, plan), force: true, boundaryAt: lastBoundaryAt, toolStepCount: stepCount, toolName: row?.lastToolName || null, toolCategory: row?.lastToolCategory || null };
  }
  if (boundaryChanged) {
    const categoryChanged = row?.lastToolCategory && row.lastToolCategory !== session.lastNarratedCategory;
    const enoughBoundaries = stepCount - number(session.lastNarratedStepCount) >= milestoneEvery;
    const longTool = number(row?.lastDurationMs) >= longToolMs;
    if (gapMs >= minGapMs && (categoryChanged || enoughBoundaries || longTool)) {
      return { kind: "milestone", key: `${key}:milestone:${lastBoundaryAt}`, text: milestoneMessage(row, plan), force: false, boundaryAt: lastBoundaryAt, toolStepCount: stepCount, toolName: row?.lastToolName || null, toolCategory: row?.lastToolCategory || null };
    }
  }
  if (gapMs >= maxSilenceMs) {
    const silenceBucket = Math.floor(nowMs / maxSilenceMs);
    return { kind: "continuing", key: `${key}:silence:${silenceBucket}`, text: silenceMessage(row, plan, nowMs), force: false };
  }
  return null;
}

export class GoalProgressNarrator {
  constructor({
    progressStatePath,
    planStatePath,
    goalStatePath = null,
    humanProgress,
    pollMs = DEFAULT_POLL_MS,
    minGapMs = DEFAULT_MIN_GAP_MS,
    maxSilenceMs = DEFAULT_MAX_SILENCE_MS,
    longToolMs = DEFAULT_LONG_TOOL_MS,
    milestoneEvery = DEFAULT_MILESTONE_EVERY,
    maxConversationAgeMs = 30 * 60_000,
    now = () => Date.now(),
  } = {}) {
    if (!progressStatePath) throw new Error("GoalProgressNarrator requires progressStatePath.");
    if (!planStatePath) throw new Error("GoalProgressNarrator requires planStatePath.");
    if (!humanProgress || typeof humanProgress.update !== "function" || typeof humanProgress.snapshot !== "function") {
      throw new Error("GoalProgressNarrator requires the Stable Gateway human-progress store.");
    }
    this.progressStatePath = progressStatePath;
    this.planStatePath = planStatePath;
    this.goalStatePath = goalStatePath || null;
    this.humanProgress = humanProgress;
    this.pollMs = Math.max(250, number(pollMs, DEFAULT_POLL_MS));
    this.minGapMs = Math.max(0, number(minGapMs, DEFAULT_MIN_GAP_MS));
    this.maxSilenceMs = Math.max(this.minGapMs || 1, number(maxSilenceMs, DEFAULT_MAX_SILENCE_MS));
    this.longToolMs = Math.max(1, number(longToolMs, DEFAULT_LONG_TOOL_MS));
    this.milestoneEvery = Math.max(1, Math.floor(number(milestoneEvery, DEFAULT_MILESTONE_EVERY)));
    this.maxConversationAgeMs = Math.max(this.maxSilenceMs, number(maxConversationAgeMs, 30 * 60_000));
    this.now = now;
    this.sessions = new Map();
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
    const [progressState, planState, goalState] = await Promise.all([
      readJson(this.progressStatePath),
      readJson(this.planStatePath),
      this.goalStatePath ? readJson(this.goalStatePath) : Promise.resolve(null),
    ]);
    const nowMs = Number(this.now());
    const rows = activeProgressRows({
      progressState,
      planState,
      goalState,
      nowMs,
      maxConversationAgeMs: this.maxConversationAgeMs,
    });
    if (!rows.length) {
      this.sessions.clear();
      this.lastResult = { ok: true, action: "idle", published: false, publishedCount: 0, observedCount: 0 };
      return this.lastResult;
    }

    const activeKeys = new Set(rows.map(runKey).filter(Boolean));
    for (const key of this.sessions.keys()) {
      if (!activeKeys.has(key)) this.sessions.delete(key);
    }
    const published = [];
    const observed = [];
    const knownDedupeKeys = existingDedupeKeys(this.humanProgress.snapshot()?.messages);
    let latestMessageCount = this.humanProgress.snapshot()?.messages?.length || 0;

    for (const row of rows) {
      const key = runKey(row);
      if (!key || !row?.conversationId) continue;
      if (!this.sessions.has(key) && this.sessions.size >= MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest) this.sessions.delete(oldest);
      }
      const selectedPlan = activePlanContext(planState, row.conversationId);
      const plan = selectedPlan.stepText
        ? selectedPlan
        : { ...selectedPlan, stepText: clip(row?.objective, 360) || null };
      let session = this.sessions.get(key);
      if (!session) {
        const existing = existingNarration(this.humanProgress.snapshot()?.messages, row.goalId, Number(row.round));
        session = {
          initialized: Boolean(existing),
          lastMessageAtMs: existing ? Date.parse(existing.at || 0) || null : null,
          lastKey: existing?.dedupeKey || null,
          lastPlanStepId: existing?.planStepId || null,
          lastBoundaryAt: row.lastBoundaryAt || null,
          lastNarratedCategory: existing?.toolCategory || null,
          lastNarratedStepCount: number(existing?.toolStepCount),
        };
        this.sessions.set(key, session);
      }
      const reportGoal = !["plan", "conversation"].includes(String(row.progressKind || "goal")) ? goalById(goalState, row.goalId) : null;
      const reportRows = goalRoundReportNarration(reportGoal);
      let reportPublished = false;
      for (const reportRow of reportRows) {
        if (knownDedupeKeys.has(reportRow.key)) continue;
        const snapshot = await this.humanProgress.update({
          message: reportRow.text,
          conversationId: reportGoal?.conversationId || row.conversationId,
          goalId: row.goalId,
          round: reportRow.round,
          planId: plan.planId,
          planStepId: plan.stepId,
          source: "goal-round-report",
          kind: reportRow.kind,
          dedupeKey: reportRow.key,
          toolCategory: "goal-control",
          toolStepCount: number(row.stepCount),
        });
        knownDedupeKeys.add(reportRow.key);
        latestMessageCount = snapshot?.messages?.length || latestMessageCount;
        published.push({ runKey: key, conversationId: reportGoal?.conversationId || row.conversationId, kind: reportRow.kind, dedupeKey: reportRow.key });
        reportPublished = true;
      }
      if (reportPublished) {
        Object.assign(session, {
          initialized: true,
          lastMessageAtMs: nowMs,
          lastKey: reportRows.at(-1)?.key || session.lastKey,
          lastPlanStepId: plan.stepId || session.lastPlanStepId || null,
        });
      }
      const decision = decideGoalProgressNarration({
        row,
        plan,
        session,
        nowMs,
        minGapMs: this.minGapMs,
        maxSilenceMs: this.maxSilenceMs,
        longToolMs: this.longToolMs,
        milestoneEvery: this.milestoneEvery,
      });
      if (!decision || decision.key === session.lastKey) {
        Object.assign(session, {
          initialized: true,
          lastPlanStepId: plan.stepId || session.lastPlanStepId || null,
          lastBoundaryAt: row.lastBoundaryAt || session.lastBoundaryAt || null,
        });
        observed.push(key);
        continue;
      }
      const snapshot = await this.humanProgress.update({
        message: decision.text,
        conversationId: row.conversationId,
        goalId: row.goalId,
        round: Number(row.round),
        planId: plan.planId,
        planStepId: plan.stepId,
        source: "goal-run-events",
        kind: decision.kind,
        dedupeKey: decision.key,
        toolCategory: decision.toolCategory || row.lastToolCategory || row.inFlightToolCategory || null,
        toolStepCount: decision.toolStepCount ?? number(row.stepCount),
      });
      latestMessageCount = snapshot?.messages?.length || latestMessageCount;
      Object.assign(session, {
        initialized: true,
        lastMessageAtMs: nowMs,
        lastKey: decision.key,
        lastPlanStepId: plan.stepId || null,
        lastBoundaryAt: decision.boundaryAt || row.lastBoundaryAt || null,
        lastNarratedCategory: decision.toolCategory || row.lastToolCategory || row.inFlightToolCategory || session.lastNarratedCategory || null,
        lastNarratedStepCount: decision.toolStepCount ?? number(row.stepCount),
      });
      published.push({ runKey: key, conversationId: row.conversationId, kind: decision.kind, dedupeKey: decision.key });
    }

    this.lastResult = {
      ok: true,
      action: published.length ? "published" : "observed",
      published: published.length > 0,
      publishedCount: published.length,
      observedCount: observed.length,
      activeConversationCount: new Set(rows.map((row) => row.conversationId)).size,
      publishedRows: published,
      messageCount: latestMessageCount,
    };
    return this.lastResult;
  }

  status() {
    return {
      enabled: true,
      running: Boolean(this.timer),
      pollInProgress: Boolean(this.polling),
      pollMs: this.pollMs,
      minGapMs: this.minGapMs,
      maxSilenceMs: this.maxSilenceMs,
      longToolMs: this.longToolMs,
      milestoneEvery: this.milestoneEvery,
      maxConversationAgeMs: this.maxConversationAgeMs,
      sessions: this.sessions.size,
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
