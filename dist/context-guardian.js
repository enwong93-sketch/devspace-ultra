import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import * as z from "zod/v4";

function nowIso() { return new Date().toISOString(); }

async function readJsonIfExists(path) {
  try {
    return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, path);
}

function cleanModelSlug(value) {
  const text = String(value ?? "").trim();
  return /^[A-Za-z0-9._-]{2,160}$/.test(text) ? text : null;
}

function cleanRuntimeKey(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^main-(?:0[1-9]|[12][0-9]|3[0-2])$/.test(text) ? text : null;
}

function cleanConversationId(value) {
  const text = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]{8,200}$/.test(text) ? text : null;
}

function cleanObservedAt(value) {
  const text = String(value ?? "").trim();
  return Number.isFinite(Date.parse(text)) ? text : nowIso();
}

export function normalizeClassicModelCatalog(models = []) {
  const catalog = {};
  for (const raw of Array.isArray(models) ? models : []) {
    const slug = cleanModelSlug(raw?.slug);
    const maxTokens = Number(raw?.max_tokens ?? raw?.maxTokens);
    if (!slug || !Number.isFinite(maxTokens) || maxTokens < 8_000) continue;
    catalog[slug] = {
      slug,
      maxTokens: Math.floor(maxTokens),
      title: typeof raw?.title === "string" ? raw.title.slice(0, 240) : undefined,
      reasoningType: typeof raw?.reasoning_type === "string" ? raw.reasoning_type.slice(0, 80) : undefined,
      isWorkModeModel: raw?.is_work_mode_model === true,
    };
  }
  return catalog;
}

export function resolveClassicModelWindow(catalog = {}, modelSlug) {
  const slug = cleanModelSlug(modelSlug);
  const entry = slug ? catalog?.[slug] : undefined;
  if (!entry) {
    return {
      modelSlug: slug,
      contextWindowTokens: null,
      source: "unresolved",
      supportedChatMode: null,
    };
  }
  return {
    modelSlug: slug,
    contextWindowTokens: Number(entry.maxTokens),
    source: "native-classic-model-catalog",
    supportedChatMode: entry.isWorkModeModel !== true,
  };
}

function boundedTokens(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : fallback;
}

export function computeContextGuardianPressure({
  contextWindowTokens,
  hostMeasuredTokens,
  snapshotTokens = 0,
  ledgerTokens = 0,
  nextInputTokens = 0,
  outputReserveTokens,
  uncertaintyReserveTokens,
} = {}) {
  const window = boundedTokens(contextWindowTokens);
  if (window < 8_000) {
    return {
      contextWindowTokens: window || null,
      usageSource: hostMeasuredTokens !== undefined && hostMeasuredTokens !== null ? "host-measured" : "unresolved",
      usedTokens: null,
      nextInputTokens: boundedTokens(nextInputTokens),
      predictedInputTokens: null,
      outputReserveTokens: null,
      uncertaintyReserveTokens: null,
      watchLimitTokens: null,
      prepareLimitTokens: null,
      rolloverLimitTokens: null,
      stage: "unresolved",
      shouldPrepareCheckpoint: false,
      shouldRolloverBeforeNextRequest: false,
    };
  }

  const measured = hostMeasuredTokens === undefined || hostMeasuredTokens === null
    ? null
    : boundedTokens(hostMeasuredTokens);
  const snapshot = boundedTokens(snapshotTokens);
  const ledger = boundedTokens(ledgerTokens);
  const usedTokens = measured ?? Math.max(snapshot, ledger);
  const usageSource = measured !== null
    ? "host-measured"
    : ledger >= snapshot && ledger > 0
      ? "devspace-ledger"
      : snapshot > 0 ? "classic-conversation-snapshot" : "unresolved";
  const next = boundedTokens(nextInputTokens);
  const predictedInputTokens = usedTokens + next;

  const defaultOutputReserve = Math.min(32_768, Math.max(8_192, Math.floor(window * 0.08)));
  const defaultUncertainty = measured !== null
    ? Math.max(8_192, Math.floor(window * 0.04))
    : Math.max(16_384, Math.floor(window * 0.10));
  const outputReserve = Math.min(Math.floor(window * 0.25), boundedTokens(outputReserveTokens, defaultOutputReserve));
  const uncertaintyReserve = Math.min(Math.floor(window * 0.25), boundedTokens(uncertaintyReserveTokens, defaultUncertainty));
  const rolloverLimitTokens = Math.max(0, window - outputReserve - uncertaintyReserve);
  const stageSpan = Math.max(8_192, Math.floor(window * 0.05));
  const prepareLimitTokens = Math.max(0, rolloverLimitTokens - stageSpan);
  const watchLimitTokens = Math.max(0, prepareLimitTokens - stageSpan);

  let stage = "normal";
  if (usageSource === "unresolved") stage = "unresolved";
  else if (predictedInputTokens >= rolloverLimitTokens) stage = "rollover";
  else if (predictedInputTokens >= prepareLimitTokens) stage = "prepare";
  else if (predictedInputTokens >= watchLimitTokens) stage = "watch";

  return {
    contextWindowTokens: window,
    usageSource,
    usedTokens,
    snapshotTokens: snapshot,
    ledgerTokens: ledger,
    nextInputTokens: next,
    predictedInputTokens,
    outputReserveTokens: outputReserve,
    uncertaintyReserveTokens: uncertaintyReserve,
    watchLimitTokens,
    prepareLimitTokens,
    rolloverLimitTokens,
    stage,
    utilizationPercent: Number(((usedTokens / window) * 100).toFixed(2)),
    predictedUtilizationPercent: Number(((predictedInputTokens / window) * 100).toFixed(2)),
    shouldPrepareCheckpoint: stage === "prepare" || stage === "rollover",
    shouldRolloverBeforeNextRequest: stage === "rollover",
  };
}

export class ContextGuardianRuntime {
  constructor({ stateDir, now = nowIso } = {}) {
    if (!stateDir) throw new Error("ContextGuardianRuntime requires stateDir.");
    this.stateDir = resolve(stateDir);
    this.dir = join(this.stateDir, "context-guardian");
    this.statePath = join(this.dir, "state.json");
    this.now = now;
    this.state = {
      version: 1,
      modelCatalog: {},
      catalogObservedAt: null,
      runtimes: {},
    };
    this.ready = this.initialize();
  }

  async initialize() {
    await mkdir(this.dir, { recursive: true });
    const persisted = await readJsonIfExists(this.statePath);
    if (persisted?.version === 1 && persisted.modelCatalog && persisted.runtimes) {
      this.state = {
        version: 1,
        modelCatalog: normalizeClassicModelCatalog(Object.values(persisted.modelCatalog).map((entry) => ({
          slug: entry?.slug,
          max_tokens: entry?.maxTokens,
          title: entry?.title,
          reasoning_type: entry?.reasoningType,
          is_work_mode_model: entry?.isWorkModeModel,
        }))),
        catalogObservedAt: typeof persisted.catalogObservedAt === "string" ? persisted.catalogObservedAt : null,
        runtimes: persisted.runtimes && typeof persisted.runtimes === "object" ? persisted.runtimes : {},
      };
    }
  }

  async save() {
    await atomicJson(this.statePath, this.state);
  }

  async observeNativeModelCatalog({ models, observedAt } = {}) {
    await this.ready;
    const catalog = normalizeClassicModelCatalog(models);
    if (!Object.keys(catalog).length) throw new Error("Native Classic model catalog did not contain any valid model windows.");
    this.state.modelCatalog = catalog;
    this.state.catalogObservedAt = cleanObservedAt(observedAt ?? this.now());
    await this.save();
    return { models: Object.keys(catalog).length, observedAt: this.state.catalogObservedAt };
  }

  async observeTurnRequest({ runtimeKey, modelSlug, thinkingEffort, conversationId, mode = "chat", observedAt } = {}) {
    await this.ready;
    const key = cleanRuntimeKey(runtimeKey);
    const slug = cleanModelSlug(modelSlug);
    if (!key) throw new Error("Invalid Context Guardian runtime key.");
    if (!slug) throw new Error("Turn request did not provide a valid model slug.");
    const nextConversationId = cleanConversationId(conversationId);
    const previous = this.state.runtimes[key] || {};
    const changedConversation = Boolean(nextConversationId && previous.conversationId && nextConversationId !== previous.conversationId);
    const base = changedConversation ? { runtimeKey: key } : previous;
    this.state.runtimes[key] = {
      ...base,
      runtimeKey: key,
      mode: mode === "work" ? "work" : "chat",
      currentModelSlug: slug,
      thinkingEffort: typeof thinkingEffort === "string" ? thinkingEffort.slice(0, 80) : null,
      conversationId: nextConversationId ?? base.conversationId ?? null,
      modelObservedAt: cleanObservedAt(observedAt ?? this.now()),
      modelSource: "native-turn-request",
    };
    await this.save();
    return await this.status(key);
  }

  async observeRuntimeSnapshot({ runtimeKey, modelSlug, conversationId, mode = "chat", observedTokens, observedAt } = {}) {
    await this.ready;
    const key = cleanRuntimeKey(runtimeKey);
    if (!key) throw new Error("Invalid Context Guardian runtime key.");
    const nextConversationId = cleanConversationId(conversationId);
    const previous = this.state.runtimes[key] || {};
    const changedConversation = Boolean(nextConversationId && previous.conversationId && nextConversationId !== previous.conversationId);
    const base = changedConversation ? { runtimeKey: key } : previous;
    const slug = cleanModelSlug(modelSlug) ?? base.currentModelSlug ?? null;
    const at = cleanObservedAt(observedAt ?? this.now());
    const nextSnapshot = Math.max(changedConversation ? 0 : boundedTokens(base.snapshotTokens), boundedTokens(observedTokens));
    const nextLedger = Math.max(changedConversation ? 0 : boundedTokens(base.ledgerTokens), nextSnapshot);
    this.state.runtimes[key] = {
      ...base,
      runtimeKey: key,
      mode: mode === "work" ? "work" : "chat",
      currentModelSlug: slug,
      conversationId: nextConversationId ?? base.conversationId ?? null,
      modelObservedAt: at,
      modelSource: cleanModelSlug(modelSlug) ? "classic-dom-snapshot" : base.modelSource ?? "unresolved",
      snapshotTokens: nextSnapshot,
      snapshotObservedAt: observedTokens === undefined ? base.snapshotObservedAt ?? null : at,
      ledgerTokens: nextLedger,
      ledgerObservedAt: observedTokens === undefined ? base.ledgerObservedAt ?? null : at,
    };
    await this.save();
    return await this.status(key);
  }

  async observeTurnInputEstimate({ runtimeKey, conversationId, estimatedTokens, observedAt } = {}) {
    await this.ready;
    const key = cleanRuntimeKey(runtimeKey);
    if (!key) throw new Error("Invalid Context Guardian runtime key.");
    const nextConversationId = cleanConversationId(conversationId);
    const previous = this.state.runtimes[key] || {};
    const changedConversation = Boolean(nextConversationId && previous.conversationId && nextConversationId !== previous.conversationId);
    const base = changedConversation ? { runtimeKey: key } : previous;
    const at = cleanObservedAt(observedAt ?? this.now());
    const floor = Math.max(boundedTokens(base.snapshotTokens), boundedTokens(base.ledgerTokens));
    this.state.runtimes[key] = {
      ...base,
      runtimeKey: key,
      conversationId: nextConversationId ?? base.conversationId ?? null,
      ledgerTokens: floor + boundedTokens(estimatedTokens),
      ledgerObservedAt: at,
    };
    await this.save();
    return await this.status(key);
  }

  async observeHostUsage({ runtimeKey, conversationId, usedTokens, observedAt } = {}) {
    await this.ready;
    const key = cleanRuntimeKey(runtimeKey);
    if (!key) throw new Error("Invalid Context Guardian runtime key.");
    const nextConversationId = cleanConversationId(conversationId);
    const previous = this.state.runtimes[key] || {};
    const changedConversation = Boolean(nextConversationId && previous.conversationId && nextConversationId !== previous.conversationId);
    const base = changedConversation ? { runtimeKey: key } : previous;
    this.state.runtimes[key] = {
      ...base,
      runtimeKey: key,
      conversationId: nextConversationId ?? base.conversationId ?? null,
      hostMeasuredTokens: boundedTokens(usedTokens),
      hostUsageObservedAt: cleanObservedAt(observedAt ?? this.now()),
    };
    await this.save();
    return await this.status(key);
  }

  async status(runtimeKey, { nextInputTokens = 0 } = {}) {
    await this.ready;
    const key = cleanRuntimeKey(runtimeKey);
    if (!key) throw new Error("Invalid Context Guardian runtime key.");
    const runtime = this.state.runtimes[key] || { runtimeKey: key, mode: "chat", currentModelSlug: null };
    const resolved = resolveClassicModelWindow(this.state.modelCatalog, runtime.currentModelSlug);
    const runtimeChatSupported = runtime.mode !== "work";
    const latestEstimateAt = Math.max(
      Date.parse(runtime.snapshotObservedAt || "") || 0,
      Date.parse(runtime.ledgerObservedAt || "") || 0,
    );
    const hostObservedAt = Date.parse(runtime.hostUsageObservedAt || "") || 0;
    const freshHostMeasuredTokens = hostObservedAt >= latestEstimateAt && hostObservedAt > 0
      ? runtime.hostMeasuredTokens
      : null;
    const pressure = computeContextGuardianPressure({
      contextWindowTokens: resolved.contextWindowTokens,
      hostMeasuredTokens: freshHostMeasuredTokens,
      snapshotTokens: runtime.snapshotTokens,
      ledgerTokens: runtime.ledgerTokens,
      nextInputTokens,
    });
    return {
      runtimeKey: key,
      mode: runtime.mode || "chat",
      conversationId: runtime.conversationId ?? null,
      currentModelSlug: runtime.currentModelSlug ?? null,
      thinkingEffort: runtime.thinkingEffort ?? null,
      modelSource: runtime.modelSource ?? "unresolved",
      modelObservedAt: runtime.modelObservedAt ?? null,
      contextWindowTokens: resolved.contextWindowTokens,
      windowSource: resolved.source,
      supportedChatMode: runtimeChatSupported && resolved.supportedChatMode !== false
        ? resolved.supportedChatMode
        : false,
      snapshotTokens: boundedTokens(runtime.snapshotTokens),
      snapshotObservedAt: runtime.snapshotObservedAt ?? null,
      ledgerTokens: boundedTokens(runtime.ledgerTokens),
      ledgerObservedAt: runtime.ledgerObservedAt ?? null,
      hostMeasuredTokens: freshHostMeasuredTokens,
      hostUsageObservedAt: freshHostMeasuredTokens === null ? null : runtime.hostUsageObservedAt ?? null,
      pressure,
      catalogObservedAt: this.state.catalogObservedAt,
      catalogSize: Object.keys(this.state.modelCatalog).length,
    };
  }

  async close() {}
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function contextGuardianText(status) {
  const model = status.currentModelSlug || "unresolved";
  const window = Number.isFinite(status.contextWindowTokens)
    ? `${status.contextWindowTokens.toLocaleString("en-US")} tokens`
    : "unresolved";
  return `${status.runtimeKey}: model=${model}; contextWindow=${window}; source=${status.windowSource}; Chat-mode-supported=${status.supportedChatMode === true}.`;
}

export function registerContextGuardianTools(server, runtime) {
  server.registerTool("context_guardian_status", {
    title: "Context Guardian Status",
    description: "Inspect the current DevSpace Context Guardian model/window state for one ChatGPT Classic Main. Read-only. Values come from observed Classic-native model metadata when available; unresolved state is reported rather than inventing a fixed context window.",
    inputSchema: {
      mainNumber: z.number().int().min(1).max(32).default(1),
    },
    annotations: READ_ONLY,
  }, async ({ mainNumber = 1 }) => {
    try {
      const runtimeKey = `main-${String(mainNumber).padStart(2, "0")}`;
      const status = await runtime.status(runtimeKey);
      return {
        content: [{ type: "text", text: contextGuardianText(status) }],
        structuredContent: status,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [{ type: "text", text: message }],
        structuredContent: { error: message },
      };
    }
  });
}
