import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson } from "./atomic-file.js";
import { enqueueRecoverablePersist } from "./recoverable-persist-queue.js";

const STATE_VERSION = 1;
const PLAN_STATUSES = new Set(["active", "completed"]);
const STEP_STATUSES = new Set(["pending", "in_progress", "completed"]);
const MIN_STEPS = 2;
const MAX_STEPS = 12;
const MAX_TITLE_CHARS = 240;
const MAX_STEP_TEXT_CHARS = 500;
const MAX_EXPLANATION_CHARS = 2_000;
const MAX_CONVERSATION_ID_CHARS = 240;

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function newState() {
  return { version: STATE_VERSION, plans: {} };
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

function normalizeConversationId(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return cleanText(value, MAX_CONVERSATION_ID_CHARS, "Conversation id");
}

function normalizeStepStatus(value) {
  const status = String(value ?? "pending");
  if (!STEP_STATUSES.has(status)) throw new Error(`Invalid plan step status: ${status}`);
  return status;
}

function validateStepSet(steps) {
  if (!Array.isArray(steps) || steps.length < MIN_STEPS || steps.length > MAX_STEPS) {
    throw new Error(`Plan requires ${MIN_STEPS}-${MAX_STEPS} steps.`);
  }
  const inProgress = steps.filter((step) => step.status === "in_progress").length;
  const unfinished = steps.some((step) => step.status !== "completed");
  if (unfinished && inProgress !== 1) {
    throw new Error("An active plan must have exactly one in_progress step.");
  }
  if (!unfinished && inProgress !== 0) {
    throw new Error("A completed plan cannot have an in_progress step.");
  }
}

function normalizeNewSteps(rawSteps) {
  const seen = new Set();
  const steps = rawSteps.map((raw) => {
    const id = raw?.id ? String(raw.id) : randomId("step");
    if (!/^step_[a-f0-9]{16}$/.test(id)) throw new Error(`Invalid plan step id: ${id}`);
    if (seen.has(id)) throw new Error(`Duplicate plan step id: ${id}`);
    seen.add(id);
    return {
      id,
      text: cleanText(raw?.text, MAX_STEP_TEXT_CHARS, "Plan step text"),
      status: normalizeStepStatus(raw?.status),
    };
  });
  validateStepSet(steps);
  return steps;
}

function normalizeUpdatedSteps(plan, rawSteps) {
  const existingById = new Map(plan.steps.map((step) => [step.id, step]));
  const seen = new Set();
  const steps = rawSteps.map((raw) => {
    const id = raw?.id ? String(raw.id) : randomId("step");
    if (!/^step_[a-f0-9]{16}$/.test(id)) throw new Error(`Invalid plan step id: ${id}`);
    if (seen.has(id)) throw new Error(`Duplicate plan step id: ${id}`);
    seen.add(id);
    const status = normalizeStepStatus(raw?.status);
    const previous = existingById.get(id);
    if (previous?.status === "completed" && status !== "completed") {
      throw new Error(`Completed step ${id} cannot regress.`);
    }
    if (previous?.status === "pending" && status === "completed") {
      throw new Error(`Pending step ${id} cannot jump directly to completed.`);
    }
    return {
      id,
      text: cleanText(raw?.text, MAX_STEP_TEXT_CHARS, "Plan step text"),
      status,
    };
  });
  validateStepSet(steps);
  return steps;
}

function validateLoadedState(value) {
  if (!value || value.version !== STATE_VERSION || !value.plans || typeof value.plans !== "object") {
    throw new Error("unsupported plan state version");
  }
  for (const plan of Object.values(value.plans)) {
    if (!plan || !/^plan_[a-f0-9]{16}$/.test(String(plan.id ?? ""))) throw new Error("invalid persisted plan id");
    if (!PLAN_STATUSES.has(plan.status)) throw new Error("invalid persisted plan status");
    plan.conversationId = normalizeConversationId(plan.conversationId);
    validateStepSet(plan.steps ?? []);
  }
  return value;
}

export class PlanRuntime {
  constructor({ stateDir }) {
    if (!stateDir) throw new Error("PlanRuntime requires stateDir.");
    this.statePath = join(stateDir, "plan-state.json");
    this.state = newState();
    this.persistQueue = Promise.resolve();
    this.ready = this.load();
  }

  async load() {
    try {
      const parsed = JSON.parse((await readFile(this.statePath, "utf8")).replace(/^\uFEFF/, ""));
      this.state = validateLoadedState(parsed);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn(`plan state reset: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.state = newState();
    }
  }

  async save() {
    const snapshot = JSON.parse(JSON.stringify(this.state));
    await enqueueRecoverablePersist(this, () => atomicWriteJson(this.statePath, snapshot));
  }

  async start({ title, steps, conversationId }) {
    await this.ready;
    const normalizedConversationId = normalizeConversationId(conversationId);
    const activePlan = Object.values(this.state.plans)
      .filter((plan) => plan?.status === "active")
      .filter((plan) => normalizedConversationId === null || plan.conversationId === normalizedConversationId)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0];
    if (activePlan) {
      if (normalizedConversationId !== null) {
        throw new Error(`Conversation ${normalizedConversationId} already has active plan ${activePlan.id}; complete it before starting a fresh turn plan.`);
      }
      throw new Error(`Active plan ${activePlan.id} must be completed before starting a fresh turn plan.`);
    }
    const normalizedSteps = normalizeNewSteps(steps);
    const timestamp = nowIso();
    const allCompleted = normalizedSteps.every((step) => step.status === "completed");
    const plan = {
      id: randomId("plan"),
      conversationId: normalizedConversationId,
      title: cleanText(title, MAX_TITLE_CHARS, "Plan title"),
      status: allCompleted ? "completed" : "active",
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: allCompleted ? timestamp : null,
      lastExplanation: null,
      steps: normalizedSteps,
    };
    this.state.plans[plan.id] = plan;
    await this.save();
    return clone(plan);
  }

  async update({ planId, explanation, steps }) {
    await this.ready;
    const id = String(planId ?? "");
    const plan = this.state.plans[id];
    if (!plan) throw new Error(`Unknown plan ${id}.`);
    if (plan.status === "completed") throw new Error(`Completed plan ${id} is immutable.`);

    const normalizedSteps = normalizeUpdatedSteps(plan, steps);
    const timestamp = nowIso();
    const allCompleted = normalizedSteps.every((step) => step.status === "completed");
    plan.steps = normalizedSteps;
    plan.status = allCompleted ? "completed" : "active";
    plan.revision = Number(plan.revision ?? 0) + 1;
    plan.updatedAt = timestamp;
    plan.completedAt = allCompleted ? timestamp : null;
    if (explanation !== undefined && explanation !== null && String(explanation).trim()) {
      plan.lastExplanation = cleanText(explanation, MAX_EXPLANATION_CHARS, "Plan explanation");
    }
    await this.save();
    return clone(plan);
  }

  async status(planId) {
    await this.ready;
    const id = String(planId ?? "");
    const plan = this.state.plans[id];
    if (!plan) throw new Error(`Unknown plan ${id}.`);
    return clone(plan);
  }

  async rebindConversation({ planId, oldConversationId, newConversationId, reason = "verified-auto-compact" }) {
    await this.ready;
    const id = String(planId ?? "");
    const plan = this.state.plans[id];
    if (!plan) throw new Error(`Unknown plan ${id}.`);
    if (plan.status !== "active") throw new Error(`Plan ${id} is terminal (${plan.status}) and cannot move conversations.`);
    const prior = normalizeConversationId(oldConversationId);
    const next = normalizeConversationId(newConversationId);
    if (!prior || !next || prior === next) throw new Error("Verified Plan conversation rebind requires distinct old and new conversation ids.");
    const current = normalizeConversationId(plan.conversationId);
    if (current === next) return clone(plan);
    if (current !== prior) throw new Error(`Plan ${id} is bound to ${current || "none"}, not expected source ${prior}.`);
    const collision = Object.values(this.state.plans).find((item) => item?.id !== plan.id && item?.status === "active" && normalizeConversationId(item.conversationId) === next);
    if (collision) throw new Error(`Target conversation ${next} already has active Plan ${collision.id}.`);
    const timestamp = nowIso();
    plan.conversationId = next;
    plan.conversationContinuity = [
      ...(Array.isArray(plan.conversationContinuity) ? plan.conversationContinuity : []),
      { from: prior, to: next, at: timestamp, reason: cleanText(reason, 240, "Conversation rebind reason") },
    ].slice(-20);
    plan.revision = Number(plan.revision ?? 0) + 1;
    plan.updatedAt = timestamp;
    await this.save();
    return clone(plan);
  }

  async activePlans({ limit = 12, conversationId } = {}) {
    await this.ready;
    const hasConversationFilter = conversationId !== undefined;
    const normalizedConversationId = normalizeConversationId(conversationId);
    return Object.values(this.state.plans)
      .filter((plan) => plan?.status === "active")
      .filter((plan) => !hasConversationFilter || plan.conversationId === normalizedConversationId)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .slice(0, Math.max(1, Math.min(50, Number(limit) || 12)))
      .map(clone);
  }

  async latestPlan({ conversationId } = {}) {
    await this.ready;
    const hasConversationFilter = conversationId !== undefined;
    const normalizedConversationId = normalizeConversationId(conversationId);
    const latest = Object.values(this.state.plans)
      .filter((plan) => !hasConversationFilter || plan.conversationId === normalizedConversationId)
      .sort((a, b) => {
        const created = String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
        return created || String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
      })[0];
    return latest ? clone(latest) : null;
  }

  async close() {
    await this.ready;
    await this.persistQueue;
  }
}
