const DEFAULT_POLL_MS = 2_000;
const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_STALLED_GENERATING_MS = 15_000;

function streamStatusConversationId(url) {
  const match = String(url || "").match(/\/backend-api\/conversation\/([^/?#]+)\/stream_status(?:[?#]|$)/i);
  return match?.[1] || null;
}

function normalizeMode(mode) {
  return String(mode || "").trim().toLowerCase();
}

function signature(value) {
  return value == null ? null : String(value);
}

export class ClassicStreamRecoveryGuard {
  constructor({
    inspect,
    checkStreamStatus,
    listRuntimes,
    pollMs = DEFAULT_POLL_MS,
    graceMs = DEFAULT_GRACE_MS,
    stalledGeneratingMs = DEFAULT_STALLED_GENERATING_MS,
    now = () => Date.now(),
  } = {}) {
    if (typeof inspect !== "function" || typeof checkStreamStatus !== "function") {
      throw new Error("ClassicStreamRecoveryGuard requires inspect and checkStreamStatus adapters.");
    }
    this.inspect = inspect;
    this.checkStreamStatus = checkStreamStatus;
    this.listRuntimes = typeof listRuntimes === "function" ? listRuntimes : null;
    this.pollMs = pollMs;
    this.graceMs = graceMs;
    this.stalledGeneratingMs = Math.max(graceMs, Number(stalledGeneratingMs) || DEFAULT_STALLED_GENERATING_MS);
    this.now = now;
    this.armed = new Map();
    this.stalledCandidates = new Map();
    this.staleComplete = new Map();
    this.timer = null;
    this.polling = null;
    this.closed = false;
    this.lastState = { state: "idle" };
  }

  noteTransportFailure({
    runtimeKey,
    url,
    errorText,
    conversationId,
    progressSignature,
    at,
  } = {}) {
    const streamConversationId = streamStatusConversationId(url);
    if (!runtimeKey || !streamConversationId) return { state: "ignored-transport-failure" };
    if (conversationId && String(conversationId) !== streamConversationId) return { state: "ignored-conversation-mismatch" };

    const observedAt = Number.isFinite(Number(at)) ? Number(at) : this.now();
    this.staleComplete.delete(runtimeKey);
    this.armed.set(runtimeKey, {
      runtimeKey,
      conversationId: streamConversationId,
      failureAt: observedAt,
      errorText: String(errorText || ""),
      progressSignature: signature(progressSignature),
    });
    this.lastState = {
      state: "armed",
      runtimeKey,
      conversationId: streamConversationId,
      failureAt: observedAt,
    };
    return this.lastState;
  }

  async start({ schedule = true } = {}) {
    if (schedule && !this.closed && this.pollMs > 0 && !this.timer) {
      this.timer = setInterval(() => { void this.pollOnce(); }, this.pollMs);
      this.timer.unref?.();
    }
    return this.lastState;
  }

  async pollOnce() {
    if (this.closed) return { state: "closed" };
    if (this.polling) return this.polling;
    this.polling = this.#pollOnceImpl().finally(() => { this.polling = null; });
    return this.polling;
  }

  #staleState(runtimeKey, conversationId, progressSignature, source) {
    const value = {
      runtimeKey,
      conversationId,
      progressSignature: signature(progressSignature),
      detectedAt: this.now(),
      source,
    };
    this.staleComplete.set(runtimeKey, value);
    return {
      state: "renderer-stale-after-complete-stream",
      runtimeKey,
      conversationId,
      source,
      recoveryAction: "none",
      reason: "automatic-page-refresh-forbidden",
    };
  }

  async #inspectRuntime(runtimeKey) {
    try {
      return await this.inspect(runtimeKey);
    } catch (error) {
      return { __error: error instanceof Error ? error.message : String(error) };
    }
  }

  async #serverState(runtimeKey, conversationId) {
    try {
      return await this.checkStreamStatus(runtimeKey, conversationId);
    } catch (error) {
      return { __error: error instanceof Error ? error.message : String(error) };
    }
  }

  async #pollOnceImpl() {
    if (this.armed.size === 0 && !this.listRuntimes) {
      const latched = [...this.staleComplete.values()][0];
      if (!latched) return this.lastState;
      const latest = {
        state: "renderer-stale-latched",
        runtimeKey: latched.runtimeKey,
        conversationId: latched.conversationId,
        source: latched.source,
        detectedAt: latched.detectedAt,
        recoveryAction: "none",
      };
      this.lastState = latest;
      return latest;
    }
    let latest = this.lastState;

    for (const [runtimeKey, armed] of [...this.armed.entries()]) {
      const current = await this.#inspectRuntime(runtimeKey);
      if (current?.__error) {
        latest = { state: "inspect-error", runtimeKey, error: current.__error };
        continue;
      }
      if (!current?.ok) {
        latest = { state: "runtime-unavailable", runtimeKey };
        continue;
      }
      if (normalizeMode(current.mode) !== "chat") {
        this.armed.delete(runtimeKey);
        latest = { state: "unsupported-mode", runtimeKey, conversationId: armed.conversationId };
        continue;
      }
      if (String(current.conversationId || "") !== armed.conversationId) {
        this.armed.delete(runtimeKey);
        latest = { state: "conversation-changed", runtimeKey, conversationId: armed.conversationId };
        continue;
      }
      if (Number(current.composerTextChars || 0) > 0) {
        this.armed.delete(runtimeKey);
        latest = { state: "unsent-composer-protected", runtimeKey, conversationId: armed.conversationId };
        continue;
      }

      const currentSignature = signature(current.progressSignature);
      if (armed.progressSignature != null && currentSignature != null && currentSignature !== armed.progressSignature) {
        this.armed.delete(runtimeKey);
        this.staleComplete.delete(runtimeKey);
        latest = { state: "renderer-recovered", runtimeKey, conversationId: armed.conversationId };
        continue;
      }
      if (armed.progressSignature == null && currentSignature != null) {
        armed.progressSignature = currentSignature;
        armed.failureAt = this.now();
      }

      const elapsed = Math.max(0, this.now() - armed.failureAt);
      if (elapsed < this.graceMs) {
        latest = { state: "waiting-grace", runtimeKey, conversationId: armed.conversationId, elapsedMs: elapsed };
        continue;
      }

      const server = await this.#serverState(runtimeKey, armed.conversationId);
      if (server?.__error) {
        latest = { state: "stream-status-error", runtimeKey, conversationId: armed.conversationId, error: server.__error };
        continue;
      }
      if (!server?.ok || String(server.status || "").toUpperCase() !== "COMPLETE") {
        latest = { state: "waiting-server", runtimeKey, conversationId: armed.conversationId, serverStatus: server?.status || null };
        continue;
      }

      this.armed.delete(runtimeKey);
      latest = this.#staleState(runtimeKey, armed.conversationId, currentSignature, "transport-failure");
    }

    if (this.listRuntimes) {
      let runtimes = [];
      try {
        const value = await this.listRuntimes();
        runtimes = Array.isArray(value) ? value : [];
      } catch (error) {
        latest = { state: "runtime-list-error", error: error instanceof Error ? error.message : String(error) };
      }

      for (const entry of runtimes) {
        const runtimeKey = typeof entry === "string" ? entry : String(entry?.runtimeKey || "").trim();
        if (!runtimeKey || this.armed.has(runtimeKey)) continue;
        const current = await this.#inspectRuntime(runtimeKey);
        if (current?.__error) {
          this.stalledCandidates.delete(runtimeKey);
          latest = { state: "inspect-error", runtimeKey, error: current.__error };
          continue;
        }
        if (!current?.ok) {
          this.stalledCandidates.delete(runtimeKey);
          continue;
        }
        if (normalizeMode(current.mode) !== "chat") {
          this.stalledCandidates.delete(runtimeKey);
          this.staleComplete.delete(runtimeKey);
          continue;
        }

        const conversationId = String(current.conversationId || "").trim();
        if (!conversationId) {
          this.stalledCandidates.delete(runtimeKey);
          this.staleComplete.delete(runtimeKey);
          continue;
        }
        if (!current.generating) {
          const existed = this.stalledCandidates.delete(runtimeKey) || this.staleComplete.delete(runtimeKey);
          if (existed) latest = { state: "renderer-idle", runtimeKey, conversationId };
          continue;
        }
        if (Number(current.composerTextChars || 0) > 0) {
          this.stalledCandidates.delete(runtimeKey);
          latest = { state: "unsent-composer-protected", runtimeKey, conversationId };
          continue;
        }

        const currentSignature = signature(current.progressSignature);
        const latched = this.staleComplete.get(runtimeKey);
        if (latched) {
          if (latched.conversationId !== conversationId || latched.progressSignature !== currentSignature) {
            this.staleComplete.delete(runtimeKey);
            this.stalledCandidates.set(runtimeKey, {
              runtimeKey,
              conversationId,
              progressSignature: currentSignature,
              stableSince: this.now(),
            });
            latest = { state: "renderer-progressed", runtimeKey, conversationId };
          } else {
            latest = {
              state: "renderer-stale-latched",
              runtimeKey,
              conversationId,
              source: latched.source,
              detectedAt: latched.detectedAt,
              recoveryAction: "none",
            };
          }
          continue;
        }

        let candidate = this.stalledCandidates.get(runtimeKey);
        if (!candidate || candidate.conversationId !== conversationId) {
          candidate = {
            runtimeKey,
            conversationId,
            progressSignature: currentSignature,
            stableSince: this.now(),
          };
          this.stalledCandidates.set(runtimeKey, candidate);
          latest = { state: "watching-generating", runtimeKey, conversationId, elapsedMs: 0 };
          continue;
        }
        if (candidate.progressSignature !== currentSignature) {
          candidate.progressSignature = currentSignature;
          candidate.stableSince = this.now();
          latest = { state: "renderer-progressed", runtimeKey, conversationId };
          continue;
        }

        const elapsed = Math.max(0, this.now() - candidate.stableSince);
        if (elapsed < this.stalledGeneratingMs) {
          latest = { state: "watching-generating", runtimeKey, conversationId, elapsedMs: elapsed };
          continue;
        }

        const server = await this.#serverState(runtimeKey, conversationId);
        if (server?.__error) {
          candidate.stableSince = this.now();
          latest = { state: "stream-status-error", runtimeKey, conversationId, error: server.__error };
          continue;
        }
        if (!server?.ok || String(server.status || "").toUpperCase() !== "COMPLETE") {
          candidate.stableSince = this.now();
          latest = { state: "watching-server-running", runtimeKey, conversationId, serverStatus: server?.status || null };
          continue;
        }

        this.stalledCandidates.delete(runtimeKey);
        latest = this.#staleState(runtimeKey, conversationId, currentSignature, "stuck-renderer-discovery");
      }
    }

    this.lastState = latest;
    return latest;
  }

  status() {
    return {
      ...this.lastState,
      armed: [...this.armed.values()].map((item) => ({
        runtimeKey: item.runtimeKey,
        conversationId: item.conversationId,
        failureAt: item.failureAt,
      })),
      stalledCandidates: [...this.stalledCandidates.values()].map((item) => ({
        runtimeKey: item.runtimeKey,
        conversationId: item.conversationId,
        stableSince: item.stableSince,
      })),
      staleComplete: [...this.staleComplete.values()].map((item) => ({
        runtimeKey: item.runtimeKey,
        conversationId: item.conversationId,
        detectedAt: item.detectedAt,
        source: item.source,
      })),
    };
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.polling) await this.polling.catch(() => {});
    this.armed.clear();
    this.stalledCandidates.clear();
    this.staleComplete.clear();
  }
}

export { streamStatusConversationId };
