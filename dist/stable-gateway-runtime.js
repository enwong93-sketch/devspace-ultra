import { randomUUID } from "node:crypto";

const DEFAULT_BARRIER_TIMEOUT_MS = 30_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const DEFAULT_SESSION_IDLE_RETENTION_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_RETAINED_SESSIONS = 256;
const DEFAULT_MAX_REPLAY_SESSIONS = 16;

function cloneInitializeBody(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function cleanSchemaFingerprint(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : null;
}

function cleanToolCount(value) {
  if (value === null || value === undefined || value === "") return null;
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

function requireText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function timeoutPromise(promise, timeoutMs, message, onTimeout) {
  const boundedTimeout = Number(timeoutMs);
  if (!Number.isFinite(boundedTimeout) || boundedTimeout <= 0) {
    throw new Error("timeoutMs must be a positive number.");
  }

  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error(message));
      }, boundedTimeout);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

export class StableGatewaySessionRegistry {
  constructor({
    now = Date.now,
    idleRetentionMs = DEFAULT_SESSION_IDLE_RETENTION_MS,
    maxRetainedSessions = DEFAULT_MAX_RETAINED_SESSIONS,
    maxReplaySessions = DEFAULT_MAX_REPLAY_SESSIONS,
  } = {}) {
    if (typeof now !== "function") throw new Error("now must be a function.");
    this.now = now;
    this.idleRetentionMs = Math.max(1_000, Number(idleRetentionMs) || DEFAULT_SESSION_IDLE_RETENTION_MS);
    this.maxRetainedSessions = Math.max(1, Number(maxRetainedSessions) || DEFAULT_MAX_RETAINED_SESSIONS);
    this.maxReplaySessions = Math.max(1, Math.min(this.maxRetainedSessions, Number(maxReplaySessions) || DEFAULT_MAX_REPLAY_SESSIONS));
    this.sessions = new Map();
    this.barrier = null;
    this.drainWaiters = new Set();
  }

  registerInitialize({ coreId, backendSessionId, initializeBody, authorization } = {}) {
    const publicSessionId = randomUUID();
    this.sessions.set(publicSessionId, {
      publicSessionId,
      coreId: requireText(coreId, "coreId"),
      backendSessionId: requireText(backendSessionId, "backendSessionId"),
      initializeBody: cloneInitializeBody(initializeBody),
      authorization: requireText(authorization, "authorization"),
      initialized: false,
      activeRequests: 0,
      schemaFingerprint: null,
      toolCount: null,
      lastActivityAt: this.now(),
    });
    this.#pruneInactive();
    return publicSessionId;
  }

  lookup(publicSessionId) {
    const entry = this.sessions.get(String(publicSessionId ?? ""));
    if (!entry) return undefined;
    return this.#internalSnapshot(entry);
  }

  restoreDescriptors(descriptors = []) {
    if (!Array.isArray(descriptors)) throw new Error("descriptors must be an array.");
    for (const descriptor of descriptors) {
      const publicSessionId = requireText(descriptor?.publicSessionId, "publicSessionId");
      const lastActivityAt = Number(descriptor?.lastActivityAt || this.now());
      this.sessions.set(publicSessionId, {
        publicSessionId,
        coreId: "restored-unmapped",
        backendSessionId: "restored-unmapped",
        initializeBody: cloneInitializeBody(descriptor?.initializeBody),
        authorization: "",
        initialized: descriptor?.initialized === true,
        activeRequests: 0,
        schemaFingerprint: cleanSchemaFingerprint(descriptor?.schemaFingerprint),
        toolCount: cleanToolCount(descriptor?.toolCount),
        lastActivityAt: Number.isFinite(lastActivityAt) ? lastActivityAt : this.now(),
      });
    }
    this.#pruneInactive();
    return this.snapshotDescriptors();
  }

  snapshotDescriptors() {
    this.#pruneInactive();
    return [...this.sessions.values()].map((entry) => ({
      publicSessionId: entry.publicSessionId,
      initializeBody: cloneInitializeBody(entry.initializeBody),
      initialized: entry.initialized === true,
      lastActivityAt: Number(entry.lastActivityAt || 0),
      schemaFingerprint: cleanSchemaFingerprint(entry.schemaFingerprint),
      toolCount: cleanToolCount(entry.toolCount),
    }));
  }

  invalidateMapping(publicSessionId) {
    const entry = this.sessions.get(String(publicSessionId ?? ""));
    if (!entry) return false;
    entry.coreId = "unmapped";
    entry.backendSessionId = "unmapped";
    return true;
  }

  markInitialized(publicSessionId) {
    const entry = this.sessions.get(String(publicSessionId ?? ""));
    if (!entry) return false;
    entry.initialized = true;
    entry.lastActivityAt = this.now();
    return true;
  }

  updateAuthorization(publicSessionId, authorization) {
    const entry = this.sessions.get(String(publicSessionId ?? ""));
    if (!entry) return false;
    entry.authorization = requireText(authorization, "authorization");
    entry.lastActivityAt = this.now();
    return true;
  }

  updateSchema(publicSessionId, { schemaFingerprint, toolCount } = {}) {
    const entry = this.sessions.get(String(publicSessionId ?? ""));
    if (!entry) return false;
    const fingerprint = cleanSchemaFingerprint(schemaFingerprint);
    const count = cleanToolCount(toolCount);
    if (!fingerprint || count == null) return false;
    entry.schemaFingerprint = fingerprint;
    entry.toolCount = count;
    entry.lastActivityAt = this.now();
    return true;
  }

  async waitForAdmission(timeoutMs = DEFAULT_BARRIER_TIMEOUT_MS) {
    await this.#waitForAdmission(timeoutMs);
  }

  async acquire(publicSessionId, { timeoutMs = DEFAULT_BARRIER_TIMEOUT_MS } = {}) {
    const id = String(publicSessionId ?? "");
    if (!this.sessions.has(id)) return undefined;
    await this.#waitForAdmission(timeoutMs);
    const entry = this.sessions.get(id);
    if (!entry) return undefined;
    entry.activeRequests += 1;
    entry.lastActivityAt = this.now();
    return this.#internalSnapshot(entry);
  }

  release(publicSessionId) {
    const entry = this.sessions.get(String(publicSessionId ?? ""));
    if (!entry) return false;
    entry.activeRequests = Math.max(0, entry.activeRequests - 1);
    entry.lastActivityAt = this.now();
    this.#notifyDrainIfReady();
    this.#pruneInactive();
    return true;
  }

  beginBarrier() {
    if (this.barrier) return false;
    let resolveBarrier;
    const promise = new Promise((resolve) => {
      resolveBarrier = resolve;
    });
    this.barrier = { promise, resolve: resolveBarrier };
    return true;
  }

  async waitForDrain(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS) {
    if (this.#totalActiveRequests() === 0) return;

    let waiter;
    const promise = new Promise((resolve) => {
      waiter = { resolve };
      this.drainWaiters.add(waiter);
    });

    return timeoutPromise(
      promise,
      timeoutMs,
      `Timed out waiting for Stable Gateway requests to drain after ${timeoutMs}ms.`,
      () => this.drainWaiters.delete(waiter),
    );
  }

  commitMappings(mappings) {
    if (!Array.isArray(mappings)) throw new Error("mappings must be an array.");
    const validated = [];
    const seen = new Set();

    for (const mapping of mappings) {
      const publicSessionId = requireText(mapping?.publicSessionId, "publicSessionId");
      if (seen.has(publicSessionId)) throw new Error(`Duplicate public MCP session ${publicSessionId}.`);
      seen.add(publicSessionId);
      const entry = this.sessions.get(publicSessionId);
      if (!entry) throw new Error(`Unknown public MCP session ${publicSessionId}.`);
      validated.push({
        entry,
        coreId: requireText(mapping?.coreId, "coreId"),
        backendSessionId: requireText(mapping?.backendSessionId, "backendSessionId"),
      });
    }

    for (const mapping of validated) {
      mapping.entry.coreId = mapping.coreId;
      mapping.entry.backendSessionId = mapping.backendSessionId;
      mapping.entry.lastActivityAt = this.now();
    }
  }

  abortBarrier() {
    if (!this.barrier) return false;
    const barrier = this.barrier;
    this.barrier = null;
    barrier.resolve();
    return true;
  }

  remove(publicSessionId) {
    return this.sessions.delete(String(publicSessionId ?? ""));
  }

  entriesForReplay() {
    this.#pruneInactive();
    const ordered = [...this.sessions.values()]
      .sort((a, b) => Number(b.lastActivityAt || 0) - Number(a.lastActivityAt || 0));
    const replayed = ordered
      .filter((entry) => String(entry.authorization || "").trim())
      .slice(0, this.maxReplaySessions);
    return replayed.map((entry) => this.#internalSnapshot(entry));
  }

  snapshotPublic() {
    this.#pruneInactive();
    return {
      barrierActive: Boolean(this.barrier),
      totalActiveRequests: this.#totalActiveRequests(),
      sessions: Array.from(this.sessions.values(), (entry) => ({
        publicSessionId: entry.publicSessionId,
        coreId: entry.coreId,
        initialized: entry.initialized,
        activeRequests: entry.activeRequests,
        schemaFingerprint: cleanSchemaFingerprint(entry.schemaFingerprint),
        toolCount: cleanToolCount(entry.toolCount),
      })),
    };
  }

  #internalSnapshot(entry) {
    return {
      publicSessionId: entry.publicSessionId,
      coreId: entry.coreId,
      backendSessionId: entry.backendSessionId,
      initializeBody: cloneInitializeBody(entry.initializeBody),
      authorization: entry.authorization,
      initialized: entry.initialized,
      activeRequests: entry.activeRequests,
      lastActivityAt: Number(entry.lastActivityAt || 0),
      schemaFingerprint: cleanSchemaFingerprint(entry.schemaFingerprint),
      toolCount: cleanToolCount(entry.toolCount),
    };
  }

  async #waitForAdmission(timeoutMs) {
    const barrier = this.barrier;
    if (!barrier) return;
    await timeoutPromise(
      barrier.promise,
      timeoutMs,
      `Timed out waiting for Stable Gateway admission after ${timeoutMs}ms.`,
    );
  }

  #totalActiveRequests() {
    let total = 0;
    for (const entry of this.sessions.values()) total += entry.activeRequests;
    return total;
  }

  #pruneInactive() {
    const now = this.now();
    const cutoff = now - this.idleRetentionMs;
    for (const [id, entry] of this.sessions) {
      if (Number(entry.activeRequests || 0) === 0 && Number(entry.lastActivityAt || 0) < cutoff) {
        this.sessions.delete(id);
      }
    }
    if (this.sessions.size <= this.maxRetainedSessions) return;
    const inactive = [...this.sessions.values()]
      .filter((entry) => Number(entry.activeRequests || 0) === 0)
      .sort((a, b) => Number(a.lastActivityAt || 0) - Number(b.lastActivityAt || 0));
    for (const entry of inactive) {
      if (this.sessions.size <= this.maxRetainedSessions) break;
      this.sessions.delete(entry.publicSessionId);
    }
  }

  #notifyDrainIfReady() {
    if (this.#totalActiveRequests() !== 0 || this.drainWaiters.size === 0) return;
    const waiters = Array.from(this.drainWaiters);
    this.drainWaiters.clear();
    for (const waiter of waiters) waiter.resolve();
  }
}
