import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DEFAULT_PROGRESS_REMINDER_MS = 10 * 60_000;
export const DEFAULT_PROGRESS_CONTINUE_MS = 20 * 60_000;
export const DEFAULT_PROGRESS_POLL_MS = 15_000;
export const DEFAULT_PROGRESS_ARM_WINDOW_MS = 6 * 60 * 60_000;
export const DEFAULT_PROGRESS_MAX_CONTINUES = 3;

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

function activePlans(state) {
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
  return grouped;
}

function latestReports(state) {
  const result = new Map();
  const messages = Array.isArray(state?.messages) ? state.messages : [];
  for (const message of messages) {
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

function serializableRecord(record) {
  return {
    conversationId: record.conversationId,
    planId: record.planId || null,
    planRevision: Number(record.planRevision || 0),
    armed: record.armed === true,
    ambiguous: record.ambiguous === true,
    armedAt: record.armedAt || null,
    lastActivityAt: record.lastActivityAt || null,
    lastReportAt: record.lastReportAt || null,
    lastReminderAt: record.lastReminderAt || null,
    lastReminderProjectedAt: record.lastReminderProjectedAt || null,
    lastContinueAt: record.lastContinueAt || null,
    continueAttempts: Number(record.continueAttempts || 0),
    idleObservedAt: record.idleObservedAt || null,
    reminderPending: record.reminderPending === true,
    continuePending: record.continuePending === true,
    lastDispatchState: cleanText(record.lastDispatchState, 120),
    updatedAt: record.updatedAt || null,
  };
}

function reportAnchor(record, plan, now) {
  return finiteTime(record.lastReportAt)
    || finiteTime(record.armedAt)
    || finiteTime(record.lastActivityAt)
    || Number(plan?.updatedAtMs || 0)
    || now;
}

export class ConversationProgressLivenessSupervisor {
  constructor({
    statePath,
    planStatePath,
    progressStatePath,
    adapter,
    enabled = true,
    reminderMs = DEFAULT_PROGRESS_REMINDER_MS,
    continueMs = DEFAULT_PROGRESS_CONTINUE_MS,
    pollMs = DEFAULT_PROGRESS_POLL_MS,
    armWindowMs = DEFAULT_PROGRESS_ARM_WINDOW_MS,
    maxContinueAttempts = DEFAULT_PROGRESS_MAX_CONTINUES,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.statePath = statePath;
    this.planStatePath = planStatePath;
    this.progressStatePath = progressStatePath;
    this.adapter = adapter;
    this.enabled = enabled !== false;
    this.reminderMs = Math.max(60_000, Number(reminderMs) || DEFAULT_PROGRESS_REMINDER_MS);
    this.continueMs = Math.max(this.reminderMs + 60_000, Number(continueMs) || DEFAULT_PROGRESS_CONTINUE_MS);
    this.pollMs = Math.max(1_000, Number(pollMs) || DEFAULT_PROGRESS_POLL_MS);
    this.armWindowMs = Math.max(this.continueMs, Number(armWindowMs) || DEFAULT_PROGRESS_ARM_WINDOW_MS);
    this.maxContinueAttempts = Math.max(1, Math.min(10, Number(maxContinueAttempts) || DEFAULT_PROGRESS_MAX_CONTINUES));
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.records = new Map();
    this.timer = null;
    this.closed = false;
    this.running = null;
    this.lastError = null;
  }

  async start({ schedule = true } = {}) {
    const persisted = await readJson(this.statePath, { version: 1, records: {} });
    for (const value of Object.values(persisted?.records || {})) {
      const conversationId = cleanConversationId(value?.conversationId);
      if (!conversationId) continue;
      const { runtimeKey: _retiredRuntimeBinding, ...conversationState } = value || {};
      this.records.set(conversationId, {
        ...conversationState,
        conversationId,
      });
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
    const now = finiteTime(event?.observedAtMs) || this.now();
    const record = this.#record(conversationId);
    record.lastActivityAt = new Date(now).toISOString();
    record.updatedAt = new Date(this.now()).toISOString();
    if (String(event?.kind || "").toLowerCase() === "started") {
      record.armed = true;
      record.ambiguous = false;
      record.armedAt ||= new Date(now).toISOString();
    }
    await this.#persist();
    return serializableRecord(record);
  }

  async noteReport({ conversationId, observedAtMs } = {}) {
    const id = cleanConversationId(conversationId);
    if (!id) return null;
    const atMs = finiteTime(observedAtMs) || this.now();
    const record = this.#record(id);
    record.armed = true;
    record.ambiguous = false;
    record.lastReportAt = new Date(atMs).toISOString();
    record.lastActivityAt = new Date(atMs).toISOString();
    record.lastReminderAt = null;
    record.lastReminderProjectedAt = null;
    record.lastContinueAt = null;
    record.continueAttempts = 0;
    record.reminderPending = false;
    record.continuePending = false;
    record.idleObservedAt = null;
    record.lastDispatchState = "report-observed";
    record.updatedAt = new Date(this.now()).toISOString();
    await this.adapter?.clearReminder?.({ conversationId: id }).catch?.(() => {});
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
    const plans = activePlans(planState);
    const reports = latestReports(progressState);

    for (const [conversationId, candidates] of plans) {
      const record = this.#record(conversationId);
      if (candidates.length !== 1) {
        record.ambiguous = true;
        record.armed = false;
        record.lastDispatchState = "multiple-active-plans";
        record.updatedAt = new Date(now).toISOString();
        continue;
      }
      const plan = candidates[0];
      const report = reports.get(conversationId);
      const reportAtMs = Number(report?.atMs || 0);
      const storedReportAtMs = finiteTime(record.lastReportAt) || 0;
      if (reportAtMs > storedReportAtMs) {
        record.lastReportAt = new Date(reportAtMs).toISOString();
        record.lastReminderAt = null;
        record.lastReminderProjectedAt = null;
        record.lastContinueAt = null;
        record.continueAttempts = 0;
        record.reminderPending = false;
        record.continuePending = false;
        record.idleObservedAt = null;
      }
      record.planId = plan.planId;
      record.planRevision = plan.revision;
      record.ambiguous = false;
      const recent = Math.max(
        Number(plan.updatedAtMs || 0),
        finiteTime(record.lastActivityAt) || 0,
        finiteTime(record.lastReportAt) || 0,
      );
      if (!recent || now - recent > this.armWindowMs) {
        record.armed = false;
        record.lastDispatchState = "outside-arm-window";
        continue;
      }
      record.armed = true;
      record.armedAt ||= new Date(Math.max(recent, now - this.continueMs)).toISOString();
      const anchor = reportAnchor(record, plan, now);
      const silenceMs = Math.max(0, now - anchor);
      record.reminderPending = silenceMs >= this.reminderMs;
      record.continuePending = silenceMs >= this.continueMs;
      record.updatedAt = new Date(now).toISOString();

      const page = await this.adapter?.find?.({ conversationId }).catch(() => null);
      if (!page?.exact || page.conversationId !== conversationId) {
        record.idleObservedAt = null;
        record.lastDispatchState = page?.ambiguous ? "page-ambiguous" : "page-not-open";
        continue;
      }

      if (record.reminderPending) {
        const lastProjected = finiteTime(record.lastReminderProjectedAt) || 0;
        if (now - lastProjected >= this.reminderMs) {
          const projected = await this.adapter?.projectReminder?.({
            conversationId,
            lastReportAt: record.lastReportAt,
            reminderAt: new Date(now).toISOString(),
            silenceMs,
          }).catch(() => null);
          if (projected?.ok) {
            record.lastReminderProjectedAt = new Date(now).toISOString();
          }
        }
        const lastReminder = finiteTime(record.lastReminderAt) || 0;
        if (now - lastReminder >= this.reminderMs) {
          const reminded = await this.adapter?.sendReminder?.({
            conversationId,
            lastReportAt: record.lastReportAt,
            reminderAt: new Date(now).toISOString(),
            silenceMs,
          }).catch((error) => ({ ok: false, state: error instanceof Error ? error.message : String(error) }));
          if (reminded?.ok) {
            record.lastReminderAt = new Date(now).toISOString();
            record.lastDispatchState = "reminder-sent";
          } else {
            record.lastDispatchState = cleanText(reminded?.state || reminded?.error, 120) || "reminder-pending";
          }
        }
      } else {
        await this.adapter?.clearReminder?.({ conversationId }).catch(() => null);
      }

      if (!record.continuePending || record.continueAttempts >= this.maxContinueAttempts) continue;
      if (page.generating || !page.hydrated || !page.composerEmpty) {
        record.idleObservedAt = null;
        record.lastDispatchState = page.generating
          ? "waiting-for-turn-stop"
          : page.composerEmpty
            ? "waiting-for-hydration"
            : "user-composer-not-empty";
        continue;
      }
      const idleAtMs = finiteTime(record.idleObservedAt);
      if (!idleAtMs) {
        record.idleObservedAt = new Date(now).toISOString();
        record.lastDispatchState = "idle-confirmation-armed";
        continue;
      }
      if (now - idleAtMs < Math.min(30_000, this.pollMs * 2)) continue;
      const lastContinue = finiteTime(record.lastContinueAt) || 0;
      if (lastContinue && now - lastContinue < this.continueMs) continue;
      const dispatched = await this.adapter?.sendContinue?.({
        conversationId,
        attempt: record.continueAttempts + 1,
      }).catch((error) => ({ ok: false, state: error instanceof Error ? error.message : String(error) }));
      if (dispatched?.ok) {
        record.lastContinueAt = new Date(now).toISOString();
        record.continueAttempts += 1;
        record.idleObservedAt = null;
        record.lastDispatchState = "continue-sent";
      } else {
        record.lastDispatchState = cleanText(dispatched?.state, 120) || "continue-failed";
      }
    }

    for (const [conversationId, record] of this.records) {
      if (plans.has(conversationId)) continue;
      record.armed = false;
      record.reminderPending = false;
      record.continuePending = false;
      record.lastDispatchState = "no-active-plan";
      record.updatedAt = new Date(now).toISOString();
      await this.adapter?.clearReminder?.({ conversationId }).catch(() => null);
    }
    await this.#persist();
    return this.status();
  }

  status() {
    return {
      ok: this.lastError == null,
      enabled: this.enabled,
      reminderMs: this.reminderMs,
      continueMs: this.continueMs,
      pollMs: this.pollMs,
      maxContinueAttempts: this.maxContinueAttempts,
      records: [...this.records.values()].map(serializableRecord),
      lastError: this.lastError,
      rawProgressPersisted: false,
      crossConversationSharing: false,
      authorityKey: "conversationId",
      runtimeBinding: false,
      goalRecoveryDependency: false,
      autoCompactDependency: false,
    };
  }

  #record(conversationId) {
    let record = this.records.get(conversationId);
    if (!record) {
      record = {
        conversationId,
        planId: null,
        planRevision: 0,
        armed: false,
        ambiguous: false,
        armedAt: null,
        lastActivityAt: null,
        lastReportAt: null,
        lastReminderAt: null,
        lastReminderProjectedAt: null,
        lastContinueAt: null,
        continueAttempts: 0,
        idleObservedAt: null,
        reminderPending: false,
        continuePending: false,
        lastDispatchState: null,
        updatedAt: new Date(this.now()).toISOString(),
      };
      this.records.set(conversationId, record);
    }
    return record;
  }

  async #persist() {
    const records = {};
    for (const [conversationId, record] of this.records) records[conversationId] = serializableRecord(record);
    await writeJsonAtomic(this.statePath, {
      version: 2,
      updatedAt: new Date(this.now()).toISOString(),
      reminderMs: this.reminderMs,
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
  activePlans,
  latestReports,
};
