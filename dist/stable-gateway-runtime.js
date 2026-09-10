import { randomUUID } from "node:crypto";

function cloneInitializeBody(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function cleanSchemaFingerprint(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : null;
}

function cleanClientSessionFingerprint(value) {
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

export class StableGatewaySessionRegistry {
  constructor({ now = Date.now } = {}) {
    if (typeof now !== "function") throw new Error("now must be a function.");
    this.now = now;
    this.sessions = new Map();
    this.clientSessions = new Map();
    this.barrier = null;
    this.drainWaiters = new Set();
  }

  registerInitialize({ coreId, backendSessionId, initializeBody, authorization, clientSessionFingerprint = null } = {}) {
    const normalizedCoreId = requireText(coreId, "coreId");
    const normalizedBackendSessionId = requireText(backendSessionId, "backendSessionId");
    const normalizedAuthorization = requireText(authorization, "authorization");
    const clientFingerprint = cleanClientSessionFingerprint(clientSessionFingerprint);
    if (clientFingerprint) {
      const priorId = this.clientSessions.get(clientFingerprint);
      const prior = priorId ? this.sessions.get(priorId) : null;
      if (prior) {
        prior.coreId = normalizedCoreId;
        prior.backendSessionId = normalizedBackendSessionId;
        prior.initializeBody = cloneInitializeBody(initializeBody);
        prior.authorization = normalizedAuthorization;
        prior.initialized = false;
        prior.disconnectObserved = false;
        prior.schemaFingerprint = null;
        prior.toolCount = null;
        prior.lastActivityAt = this.now();
        return prior.publicSessionId;
      }
    }
    const publicSessionId = randomUUID();
    if (clientFingerprint) this.clientSessions.set(clientFingerprint, publicSessionId);
    this.sessions.set(publicSessionId, {
      publicSessionId,
      coreId: normalizedCoreId,
      backendSessionId: normalizedBackendSessionId,
      initializeBody: cloneInitializeBody(initializeBody),
      authorization: normalizedAuthorization,
      initialized: false,
      activeRequests: 0,
      eventStreams: 0,
      disconnectObserved: false,
      clientSessionFingerprint: clientFingerprint,
      schemaFingerprint: null,
      toolCount: null,
      lastActivityAt: this.now(),
    });
    return publicSessionId;
  }

  resolvePublicSessionId(publicSessionId, clientSessionFingerprint = null) {
    const requested = String(publicSessionId ?? "").trim();
    if (requested && this.sessions.has(requested)) return requested;
    const clientFingerprint = cleanClientSessionFingerprint(clientSessionFingerprint);
    if (!clientFingerprint) return null;
    const current = this.clientSessions.get(clientFingerprint);
    return current && this.sessions.has(current) ? current : null;
  }

  lookup(publicSessionId, clientSessionFingerprint = null) {
    const resolved = this.resolvePublicSessionId(publicSessionId, clientSessionFingerprint);
    if (!resolved) return undefined;
    const entry = this.sessions.get(resolved);
    if (!entry) return undefined;
    return this.#internalSnapshot(entry);
  }

  restoreDescriptors(descriptors = []) {
    if (!Array.isArray(descriptors)) throw new Error("descriptors must be an array.");
    for (const descriptor of descriptors) {
      const publicSessionId = requireText(descriptor?.publicSessionId, "publicSessionId");
      const lastActivityAt = Number(descriptor?.lastActivityAt || this.now());
      const clientSessionFingerprint = cleanClientSessionFingerprint(descriptor?.clientSessionFingerprint);
      const restoredEntry = {
        publicSessionId,
        coreId: "restored-unmapped",
        backendSessionId: "restored-unmapped",
        initializeBody: cloneInitializeBody(descriptor?.initializeBody),
        authorization: "",
        initialized: descriptor?.initialized === true,
        activeRequests: 0,
        eventStreams: 0,
        disconnectObserved: false,
        clientSessionFingerprint,
        schemaFingerprint: cleanSchemaFingerprint(descriptor?.schemaFingerprint),
        toolCount: cleanToolCount(descriptor?.toolCount),
        lastActivityAt: Number.isFinite(lastActivityAt) ? lastActivityAt : this.now(),
      };
      if (clientSessionFingerprint) {
        const previousId = this.clientSessions.get(clientSessionFingerprint);
        const previous = previousId ? this.sessions.get(previousId) : null;
        if (previous && Number(previous.lastActivityAt || 0) > Number(restoredEntry.lastActivityAt || 0)) continue;
        if (previousId) this.sessions.delete(previousId);
        this.clientSessions.set(clientSessionFingerprint, publicSessionId);
      }
      this.sessions.set(publicSessionId, restoredEntry);
    }
    return this.snapshotDescriptors();
  }

  snapshotDescriptors() {
    return [...this.sessions.values()].map((entry) => ({
      publicSessionId: entry.publicSessionId,
      initializeBody: cloneInitializeBody(entry.initializeBody),
      initialized: entry.initialized === true,
      lastActivityAt: Number(entry.lastActivityAt || 0),
      clientSessionFingerprint: cleanClientSessionFingerprint(entry.clientSessionFingerprint),
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

  async waitForAdmission() {
    const barrier = this.barrier;
    if (barrier) await barrier.promise;
  }

  async acquire(publicSessionId) {
    const id = String(publicSessionId ?? "");
    if (!this.sessions.has(id)) return undefined;
    await this.waitForAdmission();
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
    return true;
  }

  markEventStreamOpen(publicSessionId) {
    const entry = this.sessions.get(String(publicSessionId ?? ""));
    if (!entry) return false;
    entry.eventStreams += 1;
    entry.disconnectObserved = false;
    entry.lastActivityAt = this.now();
    return true;
  }

  markEventStreamClosed(publicSessionId, { disconnected = false } = {}) {
    const entry = this.sessions.get(String(publicSessionId ?? ""));
    if (!entry) return false;
    entry.eventStreams = Math.max(0, entry.eventStreams - 1);
    if (disconnected && entry.eventStreams === 0) {
      // A ChatGPT SSE close is a reconnect boundary, not revocation. Drop only
      // the Core-side mapping so the next real call lazily recreates the
      // backend MCP transport under the same public session/conversation.
      entry.disconnectObserved = true;
      entry.coreId = "unmapped";
      entry.backendSessionId = "unmapped";
    }
    entry.lastActivityAt = this.now();
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

  async waitForDrain() {
    if (this.#totalNonStreamActiveRequests() === 0) return;
    await new Promise((resolve) => {
      this.drainWaiters.add({ resolve });
    });
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
      if (!entry) continue;
      validated.push({
        entry,
        coreId: requireText(mapping?.coreId, "coreId"),
        backendSessionId: requireText(mapping?.backendSessionId, "backendSessionId"),
      });
    }

    for (const mapping of validated) {
      mapping.entry.coreId = mapping.coreId;
      mapping.entry.backendSessionId = mapping.backendSessionId;
      mapping.entry.disconnectObserved = false;
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
    const id = String(publicSessionId ?? "").trim();
    const entry = this.sessions.get(id);
    if (!entry) return false;
    this.sessions.delete(id);
    if (entry.clientSessionFingerprint && this.clientSessions.get(entry.clientSessionFingerprint) === id) {
      this.clientSessions.delete(entry.clientSessionFingerprint);
    }
    return true;
  }

  entriesForReplay() {
    return [...this.sessions.values()]
      .filter((entry) => String(entry.authorization || "").trim())
      .filter((entry) => !entry.disconnectObserved || entry.activeRequests > 0 || entry.eventStreams > 0)
      .sort((a, b) => Number(b.lastActivityAt || 0) - Number(a.lastActivityAt || 0))
      .map((entry) => this.#internalSnapshot(entry));
  }

  snapshotPublic() {
    return {
      barrierActive: Boolean(this.barrier),
      totalActiveRequests: this.#totalActiveRequests(),
      totalNonStreamActiveRequests: this.#totalNonStreamActiveRequests(),
      sessions: Array.from(this.sessions.values(), (entry) => ({
        publicSessionId: entry.publicSessionId,
        coreId: entry.coreId,
        initialized: entry.initialized,
        activeRequests: entry.activeRequests,
        eventStreams: entry.eventStreams,
        disconnectObserved: entry.disconnectObserved,
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
      eventStreams: entry.eventStreams,
      disconnectObserved: entry.disconnectObserved,
      clientSessionFingerprint: cleanClientSessionFingerprint(entry.clientSessionFingerprint),
      lastActivityAt: Number(entry.lastActivityAt || 0),
      schemaFingerprint: cleanSchemaFingerprint(entry.schemaFingerprint),
      toolCount: cleanToolCount(entry.toolCount),
    };
  }

  #totalActiveRequests() {
    let total = 0;
    for (const entry of this.sessions.values()) total += entry.activeRequests;
    return total;
  }

  #totalNonStreamActiveRequests() {
    let total = 0;
    for (const entry of this.sessions.values()) {
      total += Math.max(0, Number(entry.activeRequests || 0) - Number(entry.eventStreams || 0));
    }
    return total;
  }

  #notifyDrainIfReady() {
    if (this.#totalNonStreamActiveRequests() !== 0 || this.drainWaiters.size === 0) return;
    const waiters = Array.from(this.drainWaiters);
    this.drainWaiters.clear();
    for (const waiter of waiters) waiter.resolve();
  }
}
