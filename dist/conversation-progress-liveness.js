import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isProjectableProgressMessage } from "./progress-ownership-proof.js";

// Ten minutes is an Agent reporting SLO only. It must never create a visible
// reminder, synthetic user turn, DOM banner, or tool-execution dependency.
export const DEFAULT_PROGRESS_REPORT_INTERVAL_MS = 10 * 60_000;
export const DEFAULT_PROGRESS_REMINDER_MS = DEFAULT_PROGRESS_REPORT_INTERVAL_MS; // compatibility alias
// Rescue is a separate safety action and may run only after interruption
// evidence plus at least twenty minutes without an Agent-authored report.
export const DEFAULT_PROGRESS_CONTINUE_MS = 20 * 60_000;
export const DEFAULT_PROGRESS_POLL_MS = 15_000;
export const DEFAULT_PROGRESS_ARM_WINDOW_MS = 6 * 60 * 60_000;
export const DEFAULT_PROGRESS_MAX_CONTINUES = 1;

function cleanText(value, max = 320) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function cleanConversationId(value) {
  const text = cleanText(value, 200);
  return text && /^[A-Za-z0-9_-]{8,200}$/.test(text) ? text : null;
}

function finiteTime(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

async function readJson(path, fallback) {
  if (!path) return fallback;
  try {
    return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function activeConversationPlans(state) {
  const plans = state?.plans && typeof state.plans === "object"
    ? Object.values(state.plans)
    : [];
  const grouped = new Map();
  for (const plan of plans) {
    const conversationId = cleanConversationId(plan?.conversationId);
    if (!conversationId || plan?.status !== "active") continue;
    const row = {
      planId: cleanText(plan?.id, 200),
      revision: Number(plan?.revision || 0),
      updatedAtMs: finiteTime(plan?.updatedAt) || 0,
    };
    if (!grouped.has(conversationId)) grouped.set(conversationId, []);
    grouped.get(conversationId).push(row);
  }
  for (const rows of grouped.values()) {
    rows.sort((left, right) => right.updatedAtMs - left.updatedAtMs || right.revision - left.revision);
  }
  return grouped;
}

function latestReports(state) {
  const result = new Map();
  const messages = Array.isArray(state?.messages) ? state.messages : [];
  for (const message of messages) {
    if (!isProjectableProgressMessage(message)) continue;
    const conversationId = cleanConversationId(message?.conversationId);
    if (!conversationId) continue;
    if (!["agent-progress-tool", "goal-round-report"].includes(String(message?.source || ""))) continue;
    const atMs = finiteTime(message?.at);
    if (!atMs) continue;
    const current = result.get(conversationId);
    if (!current || atMs > current.atMs) {
      result.set(conversationId, {
        atMs,
        source: String(message.source),
        kind: cleanText(message?.kind, 80),
      });
    }
  }
  return result;
}

function reportAnchor(record, now) {
  return Math.max(
    finiteTime(record.lastReportAt) || 0,
    finiteTime(record.startedAt) || 0,
  ) || now;
}

function rescueAnchor(record, now) {
  return Math.max(
    finiteTime(record.lastReportAt) || 0,
    finiteTime(record.interruptedAt) || 0,
    finiteTime(record.startedAt) || 0,
  ) || now;
}

function serializableRecord(record) {
  return {
    conversationId: record.conversationId,
    planId: record.planId || null,
    planRevision: Number(record.planRevision || 0),
    episodeRevision: Number(record.episodeRevision || 0),
    armed: record.armed === true,
    turnState: cleanText(record.turnState, 80) || "idle",
    duplicatePageObserved: record.duplicatePageObserved === true,
    startedAt: record.startedAt || null,
    interruptedAt: record.interruptedAt || null,
    completedAt: record.completedAt || null,
    lastActivityAt: record.lastActivityAt || null,
    lastReportAt: record.lastReportAt || null,
    lastContinueAt: record.lastContinueAt || null,
    continueAttempts: Number(record.continueAttempts || 0),
    idleObservedAt: record.idleObservedAt || null,
    reportOverdue: record.reportOverdue === true,
    rescuePending: record.rescuePending === true,
    continuePending: record.rescuePending === true,
    rescueEvidence: cleanText(record.rescueEvidence, 120),
    uiCleanupPending: record.uiCleanupPending === true,
    lastDispatchState: cleanText(record.lastDispatchState, 120),
    updatedAt: record.updatedAt || null,
  };
}

function progressReportingPolicy() {
  return "During ongoing non-atomic work, the Agent writes its own devspace_progress_report before ten minutes of silence. No timer may send a reminder message.";
}

export class ConversationProgressLivenessSupervisor {
  constructor({
    statePath,
    planStatePath,
    progressStatePath,
    adapter,
    enabled = true,
    reminderMs = DEFAULT_PROGRESS_REPORT_INTERVAL_MS,
    reportIntervalMs = reminderMs,
    continueMs = DEFAULT_PROGRESS_CONTINUE_MS,
    pollMs = DEFAULT_PROGRESS_POLL_MS,
    armWindowMs = DEFAULT_PROGRESS_ARM_WINDOW_MS,
    maxContinueAttempts = DEFAULT_PROGRESS_MAX_CONTINUES,
    onConversationSettled = null,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.statePath = statePath;
    this.planStatePath = planStatePath;
    this.progressStatePath = progressStatePath;
    this.adapter = adapter;
    this.enabled = enabled !== false;
    this.reportIntervalMs = Math.min(
      DEFAULT_PROGRESS_REPORT_INTERVAL_MS,
      Math.max(60_000, Number(reportIntervalMs) || DEFAULT_PROGRESS_REPORT_INTERVAL_MS),
    );
    this.continueMs = Math.max(
      DEFAULT_PROGRESS_CONTINUE_MS,
      this.reportIntervalMs + 60_000,
      Number(continueMs) || DEFAULT_PROGRESS_CONTINUE_MS,
    );
    this.pollMs = Math.max(1_000, Number(pollMs) || DEFAULT_PROGRESS_POLL_MS);
    this.armWindowMs = Math.max(this.continueMs, Number(armWindowMs) || DEFAULT_PROGRESS_ARM_WINDOW_MS);
    // One rescue per interruption episode. A successful rescue starts a new
    // native turn; only that new episode may later become independently eligible.
    this.maxContinueAttempts = 1;
    if (Number(maxContinueAttempts) === 0) this.maxContinueAttempts = 0;
    this.now = now;
    this.onConversationSettled = typeof onConversationSettled === "function" ? onConversationSettled : null;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.records = new Map();
    this.timer = null;
    this.closed = false;
    this.running = null;
    this.lastError = null;
  }

  async start({ schedule = true } = {}) {
    const persisted = await readJson(this.statePath, { version: 4, records: {} });
    const persistedVersion = Number(persisted?.version || 0);
    const startupNow = this.now();
    for (const value of Object.values(persisted?.records || {})) {
      const conversationId = cleanConversationId(value?.conversationId);
      if (!conversationId) continue;
      const record = this.#newRecord(conversationId);
      record.planId = cleanText(value?.planId, 200);
      record.planRevision = Number(value?.planRevision || 0);
      record.lastReportAt = value?.lastReportAt || null;
      record.lastContinueAt = value?.lastContinueAt || null;
      const persistedTurnState = cleanText(value?.turnState, 80);
      const startedAtMs = finiteTime(value?.startedAt) || 0;
      const interruptedAtMs = finiteTime(value?.interruptedAt) || 0;
      const latestEpisodeAt = Math.max(startedAtMs, interruptedAtMs);
      const restorableState = ["running", "interrupted", "completion-pending", "uncertain"].includes(persistedTurnState);
      const restorable = persistedVersion >= 4
        && value?.armed === true
        && Number(value?.continueAttempts || 0) === 0
        && restorableState
        && latestEpisodeAt > 0
        && latestEpisodeAt <= startupNow + 5_000
        && startupNow - latestEpisodeAt <= this.armWindowMs;
      if (restorable) {
        record.episodeRevision = Math.max(1, Number(value?.episodeRevision || 1));
        record.armed = true;
        record.turnState = persistedTurnState;
        record.startedAt = value?.startedAt || null;
        record.interruptedAt = value?.interruptedAt || null;
        record.lastActivityAt = value?.lastActivityAt || null;
        record.rescueEvidence = cleanText(value?.rescueEvidence, 120);
        record.lastDispatchState = "startup-episode-awaiting-page-verification";
        record.uiCleanupPending = false;
      } else {
        // Legacy state and terminal/rescued episodes cannot be trusted after a
        // Core restart. They stay disarmed and only a fresh native turn may
        // create a new episode.
        record.turnState = "startup-disarmed";
        record.lastDispatchState = "startup-disarmed-old-or-terminal-episode";
        record.uiCleanupPending = true;
      }
      this.records.set(conversationId, record);
    }
    if (this.enabled) await this.tick();
    if (schedule && this.enabled && !this.closed) this.#schedule();
    return this.status();
  }

  async close() {
    this.closed = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    await this.running?.catch(() => {});
    await this.adapter?.close?.().catch?.(() => {});
  }

  async noteTurn(event = {}) {
    const conversationId = cleanConversationId(event?.conversationId);
    if (!conversationId) return null;
    const atMs = finiteTime(event?.observedAtMs ?? event?.observedAt) || this.now();
    const at = new Date(atMs).toISOString();
    const kind = String(event?.kind || "").toLowerCase();
    const record = this.#record(conversationId);
    record.lastActivityAt = at;
    record.updatedAt = new Date(this.now()).toISOString();

    if (kind === "started") {
      record.armed = true;
      record.episodeRevision = Number(record.episodeRevision || 0) + 1;
      record.turnState = "running";
      record.startedAt = at;
      record.interruptedAt = null;
      record.completedAt = null;
      record.lastReportAt = null;
      record.lastContinueAt = null;
      record.continueAttempts = 0;
      record.idleObservedAt = null;
      record.reportOverdue = false;
      record.rescuePending = false;
      record.rescueEvidence = null;
      record.duplicatePageObserved = false;
      record.uiCleanupPending = true;
      record.lastDispatchState = "conversation-turn-started";
    } else if (kind === "finished") {
      // Network loadingFinished is not, by itself, proof that the user-visible
      // assistant turn has settled. Verify the exact conversation page before
      // treating this as normal completion; server-side MCP work can arrive
      // after the browser request's transport boundary.
      const page = await this.adapter?.find?.({ conversationId }).catch(() => null);
      if (page?.exact && page.conversationId === conversationId && page.normalCompletion === true) {
        this.#disarm(record, "completed", atMs, "conversation-turn-finished-page-verified");
      } else {
        record.armed = true;
        record.turnState = "completion-pending";
        record.interruptedAt = at;
        record.completedAt = null;
        record.idleObservedAt = null;
        record.rescuePending = false;
        record.rescueEvidence = null;
        record.lastDispatchState = page?.generating
          ? "transport-finished-page-still-generating"
          : "transport-finished-awaiting-page-completion";
      }
    } else if (kind === "failed" && event?.canceled === true) {
      this.#disarm(record, "cancelled", atMs, "conversation-turn-cancelled");
    } else if (kind === "failed") {
      record.armed = true;
      record.turnState = "interrupted";
      record.startedAt ||= at;
      record.interruptedAt = at;
      record.completedAt = null;
      record.idleObservedAt = null;
      record.rescuePending = false;
      record.rescueEvidence = "transport-failure";
      record.lastDispatchState = "conversation-turn-interrupted";
    } else if (["expired", "evicted"].includes(kind) && record.armed) {
      // Expiry is not proof of failure: a legitimate long turn may still be
      // generating. Rescue remains blocked unless the live page independently
      // shows an incomplete user turn or a visible turn error.
      record.turnState = "uncertain";
      record.interruptedAt ||= at;
      record.idleObservedAt = null;
      record.rescuePending = false;
      record.rescueEvidence = null;
      record.lastDispatchState = `turn-observer-${kind}`;
    }

    if (["finished", "failed"].includes(kind)) {
      await this.adapter?.clearReminder?.({ conversationId }).catch?.(() => {});
      record.uiCleanupPending = false;
    }
    await this.#persist();
    return serializableRecord(record);
  }

  async noteReport({ conversationId, observedAtMs } = {}) {
    const id = cleanConversationId(conversationId);
    if (!id) return null;
    const atMs = finiteTime(observedAtMs) || this.now();
    const record = this.#record(id);
    record.lastReportAt = new Date(atMs).toISOString();
    record.lastActivityAt = record.lastReportAt;
    record.reportOverdue = false;
    if (record.armed) record.rescuePending = false;
    record.lastDispatchState = record.armed ? "agent-progress-report-observed" : "idle-report-observed";
    record.updatedAt = new Date(this.now()).toISOString();
    await this.adapter?.clearReminder?.({ conversationId: id }).catch?.(() => {});
    record.uiCleanupPending = false;
    await this.#persist();
    return serializableRecord(record);
  }

  async tick() {
    if (!this.enabled || this.closed) return this.status();
    if (this.running) return await this.running;
    this.running = this.#tickInternal()
      .catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        return this.status();
      })
      .finally(() => { this.running = null; });
    return await this.running;
  }

  async #tickInternal() {
    const now = this.now();
    const [planState, progressState] = await Promise.all([
      readJson(this.planStatePath, { plans: {} }),
      readJson(this.progressStatePath, { messages: [] }),
    ]);
    const plans = activeConversationPlans(planState);
    const reports = latestReports(progressState);

    // Plan/report files may enrich an already-known episode, but neither may
    // arm rescue. Only an observed native turn start can create an episode.
    for (const [conversationId, record] of this.records) {
      const plan = plans.get(conversationId)?.[0] || null;
      record.planId = plan?.planId || record.planId || null;
      record.planRevision = Math.max(Number(record.planRevision || 0), Number(plan?.revision || 0));
      const report = reports.get(conversationId);
      const storedReportAtMs = finiteTime(record.lastReportAt) || 0;
      if (report?.atMs > storedReportAtMs) {
        record.lastReportAt = new Date(report.atMs).toISOString();
        record.reportOverdue = false;
        record.rescuePending = false;
      }
    }

    for (const [conversationId, record] of this.records) {
      if (!record.armed) {
        if (record.uiCleanupPending) {
          const cleared = await this.adapter?.clearReminder?.({ conversationId }).catch(() => null);
          if (cleared?.ok || cleared?.state === "conversation-page-not-open") record.uiCleanupPending = false;
        }
        continue;
      }

      const startedAtMs = finiteTime(record.startedAt) || finiteTime(record.interruptedAt) || 0;
      if (!startedAtMs || now - startedAtMs > this.armWindowMs) {
        this.#disarm(record, "expired", now, "outside-arm-window");
        continue;
      }

      const reportSilenceMs = Math.max(0, now - reportAnchor(record, now));
      const rescueSilenceMs = Math.max(0, now - rescueAnchor(record, now));
      record.reportOverdue = reportSilenceMs >= this.reportIntervalMs;
      // No action is taken at ten minutes. This is diagnostics only.
      if (record.reportOverdue) record.lastDispatchState = "agent-progress-report-overdue-no-message";
      record.rescuePending = rescueSilenceMs >= this.continueMs;
      record.updatedAt = new Date(now).toISOString();

      const page = await this.adapter?.find?.({ conversationId }).catch(() => null);
      if (!page?.exact || page.conversationId !== conversationId) {
        record.duplicatePageObserved = page?.ambiguous === true;
        record.idleObservedAt = null;
        record.lastDispatchState = page?.ambiguous
          ? "duplicate-conversation-pages"
          : page?.state || "conversation-page-not-open";
        continue;
      }
      record.duplicatePageObserved = false;

      if (page.normalCompletion === true) {
        this.#disarm(record, "completed", now, "normal-completion-observed-on-page");
        await this.adapter?.clearReminder?.({ conversationId, target: page }).catch?.(() => {});
        record.uiCleanupPending = false;
        continue;
      }

      if (!record.rescuePending || this.maxContinueAttempts === 0) continue;
      if (record.continueAttempts >= this.maxContinueAttempts) {
        this.#disarm(record, "rescue-exhausted", now, "single-rescue-already-used");
        continue;
      }
      if (page.generating || !page.hydrated || !page.composerEmpty) {
        record.idleObservedAt = null;
        record.lastDispatchState = page.generating
          ? "active-turn-still-generating"
          : !page.hydrated
            ? "waiting-for-conversation-hydration"
            : "user-composer-not-empty";
        continue;
      }

      const explicitInterruption = record.turnState === "interrupted";
      const pageInterruption = page.hasTurnError === true || page.incompleteUserTurn === true;
      if (!explicitInterruption && !pageInterruption) {
        record.idleObservedAt = null;
        record.rescueEvidence = null;
        record.lastDispatchState = "no-interruption-evidence-no-rescue";
        continue;
      }
      record.rescueEvidence = explicitInterruption
        ? "transport-failure"
        : page.hasTurnError
          ? "visible-turn-error"
          : "incomplete-user-turn";

      const idleAtMs = finiteTime(record.idleObservedAt);
      if (!idleAtMs) {
        record.idleObservedAt = new Date(now).toISOString();
        record.lastDispatchState = "interrupted-turn-idle-confirmation-armed";
        continue;
      }
      if (now - idleAtMs < Math.min(30_000, this.pollMs * 2)) continue;

      const episodeRevision = Number(record.episodeRevision || 0);
      const dispatched = await this.adapter?.sendContinue?.({
        conversationId,
        target: page,
        attempt: 1,
        silenceMs: rescueSilenceMs,
        rescueEvidence: record.rescueEvidence,
      }).catch((error) => ({ ok: false, state: error instanceof Error ? error.message : String(error) }));
      // Clicking the rescue message can synchronously start a new native turn.
      // Never let the old episode's completion path disarm that newer turn.
      if (Number(record.episodeRevision || 0) !== episodeRevision) continue;
      if (dispatched?.ok) {
        record.lastContinueAt = new Date(now).toISOString();
        record.continueAttempts = 1;
        record.idleObservedAt = null;
        record.armed = false;
        record.turnState = "rescue-dispatched";
        record.rescuePending = false;
        record.reportOverdue = false;
        record.lastDispatchState = "single-conversation-rescue-sent";
      } else if (dispatched?.dispatchCommitted === true) {
        // Once the exact page accepted the send click, never retry the same
        // interruption episode merely because DOM visibility confirmation was
        // delayed or the page route changed immediately afterwards. Retrying an
        // uncertain committed send can create duplicate synthetic user turns.
        record.lastContinueAt = new Date(now).toISOString();
        record.continueAttempts = 1;
        record.idleObservedAt = null;
        record.armed = false;
        record.turnState = "rescue-submitted-unverified";
        record.rescuePending = false;
        record.reportOverdue = false;
        record.lastDispatchState = "single-conversation-rescue-committed-no-retry";
      } else if (dispatched?.state === "normal-completion-observed") {
        this.#disarm(record, "completed", now, "normal-completion-observed-before-rescue");
      } else {
        record.lastDispatchState = cleanText(dispatched?.state, 120) || "conversation-rescue-failed";
      }
    }

    await this.#persist();
    return this.status();
  }

  status() {
    return {
      ok: this.lastError == null,
      enabled: this.enabled,
      reportIntervalMs: this.reportIntervalMs,
      reminderMs: this.reportIntervalMs,
      continueMs: this.continueMs,
      pollMs: this.pollMs,
      maxContinueAttempts: this.maxContinueAttempts,
      records: [...this.records.values()].map(serializableRecord),
      lastError: this.lastError,
      stateKey: "conversationId",
      authorityKey: "conversationId",
      runtimeBinding: false,
      runtimeUsedOnlyAsEphemeralLocator: true,
      supportsRuntime03AndLater: true,
      tenMinuteAutomaticReminder: false,
      tenMinuteSyntheticUserTurn: false,
      tenMinuteAgentReportSloOnly: true,
      twentyMinuteInterruptedTurnRescueOnly: true,
      normalCompletionDisarms: true,
      oneRescuePerInterruptionEpisode: true,
      activePlansDoNotArmRescue: true,
      legacyEpisodesRestartDisarmed: true,
      terminalEpisodesRestartDisarmed: true,
      activeEpisodesRestartPageVerified: true,
      rawProgressPersisted: false,
      crossConversationSharing: false,
      goalRecoveryDependency: false,
      autoCompactDependency: false,
    };
  }

  #newRecord(conversationId) {
    return {
      conversationId,
      planId: null,
      planRevision: 0,
      episodeRevision: 0,
      armed: false,
      turnState: "idle",
      duplicatePageObserved: false,
      startedAt: null,
      interruptedAt: null,
      completedAt: null,
      lastActivityAt: null,
      lastReportAt: null,
      lastContinueAt: null,
      continueAttempts: 0,
      idleObservedAt: null,
      reportOverdue: false,
      rescuePending: false,
      rescueEvidence: null,
      uiCleanupPending: false,
      lastDispatchState: null,
      updatedAt: new Date(this.now()).toISOString(),
    };
  }

  #record(conversationId) {
    let record = this.records.get(conversationId);
    if (!record) {
      record = this.#newRecord(conversationId);
      this.records.set(conversationId, record);
    }
    return record;
  }

  #disarm(record, turnState, atMs, dispatchState) {
    const at = new Date(finiteTime(atMs) || this.now()).toISOString();
    record.armed = false;
    record.turnState = turnState;
    record.completedAt = at;
    record.lastActivityAt = at;
    record.idleObservedAt = null;
    record.reportOverdue = false;
    record.rescuePending = false;
    record.rescueEvidence = null;
    record.uiCleanupPending = true;
    record.lastDispatchState = dispatchState;
    record.updatedAt = new Date(this.now()).toISOString();
    try {
      this.onConversationSettled?.({
        conversationId: record.conversationId,
        turnState,
        observedAt: at,
        dispatchState,
      });
    } catch {}
  }

  async #persist() {
    const records = {};
    for (const [conversationId, record] of this.records) records[conversationId] = serializableRecord(record);
    await writeJsonAtomic(this.statePath, {
      version: 4,
      identityKey: "conversationId",
      runtimeBinding: false,
      tenMinuteAutomaticReminder: false,
      tenMinuteAgentReportSloOnly: true,
      twentyMinuteInterruptedTurnRescueOnly: true,
      normalCompletionDisarms: true,
      updatedAt: new Date(this.now()).toISOString(),
      reportIntervalMs: this.reportIntervalMs,
      continueMs: this.continueMs,
      records,
    });
  }

  #schedule() {
    if (this.closed || !this.enabled) return;
    this.timer = this.setTimer(async () => {
      this.timer = null;
      await this.tick();
      this.#schedule();
    }, this.pollMs);
    this.timer?.unref?.();
  }
}

export const _test = {
  activeConversationPlans,
  latestReports,
  progressReportingPolicy,
  reportAnchor,
  rescueAnchor,
  serializableRecord,
};
