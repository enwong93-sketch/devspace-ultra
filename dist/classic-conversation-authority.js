import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { atomicWriteJson } from "./atomic-file.js";

function requireText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function normalizedHeaders(headers = {}) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) result[String(key).toLowerCase()] = value;
  return result;
}

export function fingerprintClassicSession(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return createHash("sha256").update(text).digest("hex");
}

function firstSessionHeader(headers = {}) {
  for (const name of ["x-openai-session", "oai-session-id", "openai-session-id"]) {
    const value = Array.isArray(headers[name]) ? headers[name][0] : headers[name];
    if (String(value ?? "").trim()) return value;
  }
  return null;
}

export function sessionFingerprintFromMcpExtra(extra = {}) {
  const meta = extra?._meta && typeof extra._meta === "object" ? extra._meta : {};
  const rawMeta = typeof meta["openai/session"] === "string" ? meta["openai/session"] : "";
  if (rawMeta.trim()) return fingerprintClassicSession(rawMeta);
  const headers = normalizedHeaders(extra?.requestInfo?.headers);
  return fingerprintClassicSession(firstSessionHeader(headers));
}

export function sessionFingerprintFromClassicRequest(request = {}) {
  const headers = normalizedHeaders(request?.headers);
  return fingerprintClassicSession(firstSessionHeader(headers));
}

export function turnTraceFingerprintFromClassicRequest(request = {}) {
  const headers = normalizedHeaders(request?.headers);
  const value = Array.isArray(headers["x-oai-turn-trace-id"])
    ? headers["x-oai-turn-trace-id"][0]
    : headers["x-oai-turn-trace-id"];
  return fingerprintClassicSession(value);
}

async function atomicWrite(path, value) {
  await atomicWriteJson(path, value);
}

function cleanEntry(fingerprint, input = {}) {
  const ids = [...new Set(Array.isArray(input.conversationIds) ? input.conversationIds.map((value) => String(value || "").trim()).filter(Boolean) : [])];
  return {
    fingerprint,
    conversationIds: ids,
    runtimeKeys: [...new Set(Array.isArray(input.runtimeKeys) ? input.runtimeKeys.map((value) => String(value || "").trim()).filter(Boolean) : [])],
    ambiguous: ids.length > 1 || input.ambiguous === true,
    updatedAt: input.updatedAt || null,
    // Direct MCP sessions are host transport descriptors, not durable
    // conversation owners. Legacy verified flags are deliberately retired on
    // load so a shared/stale session can never select another chat.
    verifiedDirectSession: false,
    verifiedDirectSessionAt: null,
  };
}

function bindAuthoritativeCurrent(existing, conversation, runtime) {
  const sameConversation = existing.conversationIds.length === 0
    || existing.conversationIds.every((value) => value === conversation);
  const sameRuntime = existing.runtimeKeys.length === 0
    || existing.runtimeKeys.every((value) => value === runtime);
  if (sameConversation || sameRuntime) {
    const changedConversation = existing.conversationIds.length !== 1
      || existing.conversationIds[0] !== conversation;
    existing.conversationIds = [conversation];
    existing.runtimeKeys = [runtime];
    existing.ambiguous = false;
    if (changedConversation) {
      existing.verifiedDirectSession = false;
      existing.verifiedDirectSessionAt = null;
    }
    return true;
  }
  if (!existing.conversationIds.includes(conversation)) existing.conversationIds.push(conversation);
  if (!existing.runtimeKeys.includes(runtime)) existing.runtimeKeys.push(runtime);
  existing.ambiguous = existing.conversationIds.length > 1 || existing.runtimeKeys.length > 1;
  return false;
}

export class ClassicConversationAuthorityRegistry {
  constructor({ statePath, waitTimeoutMs = 30_000 } = {}) {
    this.statePath = requireText(statePath, "statePath");
    this.entries = new Map();
    this.waiters = new Map();
    this.nextWaiterId = 1;
    this.waitTimeoutMs = Math.max(100, Number(waitTimeoutMs) || 30_000);
    this.timedOutWaiters = 0;
    this.cancelledWaiters = 0;
  }

  async load() {
    let parsed = null;
    try { parsed = JSON.parse((await readFile(this.statePath, "utf8")).replace(/^\uFEFF/, "")); } catch {}
    this.entries.clear();
    for (const item of Array.isArray(parsed?.sessions) ? parsed.sessions : []) {
      if (item?.verifiedDirectSession === true || item?.verifiedDirectSessionAt) {
        // Pre-v0.5.7 direct-session rows were reusable ownership grants, not
        // native browser observations. Retiring only their boolean flag while
        // retaining the conversation mapping would let the same stale session
        // regain authority whenever that old page happens to be generating.
        // Drop the whole legacy row; a real native ChatGPT turn can repopulate
        // the fingerprint through observeNativeTurn.
        continue;
      }
      const fingerprint = String(item?.fingerprint || "").trim();
      if (!/^[a-f0-9]{64}$/i.test(fingerprint)) continue;
      this.entries.set(fingerprint, cleanEntry(fingerprint, item));
    }
    return this.snapshot();
  }

  async observeNativeTurn({ sessionFingerprint, conversationId, runtimeKey, observedAt, authoritativeCurrent = false } = {}) {
    const fingerprint = requireText(sessionFingerprint, "sessionFingerprint").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("sessionFingerprint must be a SHA-256 hex digest.");
    const conversation = requireText(conversationId, "conversationId");
    const runtime = String(runtimeKey || "").trim();
    const at = String(observedAt || new Date().toISOString());
    const existing = this.entries.get(fingerprint) || cleanEntry(fingerprint);
    if (authoritativeCurrent && runtime) {
      bindAuthoritativeCurrent(existing, conversation, runtime);
    } else if (authoritativeCurrent) {
      existing.conversationIds = [conversation];
      existing.runtimeKeys = [];
      existing.ambiguous = false;
      existing.verifiedDirectSession = false;
      existing.verifiedDirectSessionAt = null;
    } else {
      if (!existing.conversationIds.includes(conversation)) existing.conversationIds.push(conversation);
      if (runtime && !existing.runtimeKeys.includes(runtime)) existing.runtimeKeys.push(runtime);
      existing.ambiguous = existing.conversationIds.length > 1 || existing.runtimeKeys.length > 1;
    }
    existing.updatedAt = at;
    this.entries.set(fingerprint, existing);
    await this.#persist();
    const resolved = this.resolveFingerprint(fingerprint);
    if (resolved) this.#resolveWaiters(fingerprint, resolved);
    return resolved;
  }

  resolveFingerprint(value) {
    const fingerprint = String(value || "").trim().toLowerCase();
    const entry = this.entries.get(fingerprint);
    if (!entry || entry.ambiguous || entry.conversationIds.length !== 1) return null;
    return {
      conversationId: entry.conversationIds[0],
      sessionFingerprint: fingerprint,
      runtimeKeys: [...entry.runtimeKeys],
      observedAt: entry.updatedAt,
      source: "classic-native-turn",
      verifiedDirectSession: false,
      verifiedDirectSessionAt: null,
    };
  }

  async acceptVerifiedRollover({ oldConversationId, newConversationId, runtimeKey, observedAt } = {}) {
    const prior = requireText(oldConversationId, "oldConversationId");
    const next = requireText(newConversationId, "newConversationId");
    if (prior === next) throw new Error("Verified conversation rollover requires distinct old and new conversation ids.");
    const runtime = String(runtimeKey || "").trim();
    const at = String(observedAt || new Date().toISOString());
    const matches = [...this.entries.values()].filter((entry) => (
      entry.conversationIds.includes(prior)
      && (!runtime || entry.runtimeKeys.includes(runtime))
    ));
    const selected = matches.length ? matches : [...this.entries.values()].filter((entry) => entry.conversationIds.includes(prior));
    if (!selected.length) {
      const alreadyApplied = [...this.entries.values()].filter((entry) => (
        entry.conversationIds.length === 1
        && entry.conversationIds[0] === next
        && (!runtime || entry.runtimeKeys.includes(runtime))
        && Array.isArray(entry.continuity)
        && entry.continuity.some((row) => row?.from === prior && row?.to === next)
      ));
      if (!alreadyApplied.length) throw new Error(`No Classic MCP session authority is bound to source conversation ${prior}.`);
      return {
        ok: true,
        oldConversationId: prior,
        newConversationId: next,
        runtimeKey: runtime || null,
        updatedSessions: 0,
        matchedSessions: alreadyApplied.length,
        alreadyApplied: true,
        observedAt: at,
      };
    }
    for (const entry of selected) {
      entry.conversationIds = [next];
      if (runtime && !entry.runtimeKeys.includes(runtime)) entry.runtimeKeys.push(runtime);
      entry.ambiguous = false;
      entry.updatedAt = at;
      entry.continuity = [
        ...(Array.isArray(entry.continuity) ? entry.continuity : []),
        { from: prior, to: next, at, reason: "verified-auto-compact" },
      ].slice(-20);
      this.entries.set(entry.fingerprint, entry);
    }
    await this.#persist();
    return {
      ok: true,
      oldConversationId: prior,
      newConversationId: next,
      runtimeKey: runtime || null,
      updatedSessions: selected.length,
      matchedSessions: selected.length,
      alreadyApplied: false,
      observedAt: at,
    };
  }

  resolveMcpExtra(extra) {
    const fingerprint = sessionFingerprintFromMcpExtra(extra);
    if (!fingerprint) return null;
    return this.resolveFingerprint(fingerprint);
  }

  async waitForFingerprint(value, {
    signal,
    minimumObservedAt = null,
    timeoutMs = this.waitTimeoutMs,
  } = {}) {
    const fingerprint = String(value || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) return null;
    const minimumObservedAtMs = minimumObservedAt == null
      ? null
      : Date.parse(String(minimumObservedAt));
    const freshEnough = (resolved) => {
      if (!resolved) return false;
      if (!Number.isFinite(minimumObservedAtMs)) return true;
      const observedAtMs = Date.parse(String(resolved.observedAt || ""));
      return Number.isFinite(observedAtMs) && observedAtMs >= minimumObservedAtMs;
    };
    const immediate = this.resolveFingerprint(fingerprint);
    if (freshEnough(immediate)) return immediate;
    if (signal?.aborted) throw new Error("Conversation identity wait was cancelled.");
    const waiterId = this.nextWaiterId++;
    const boundedTimeoutMs = Math.max(100, Number(timeoutMs) || this.waitTimeoutMs);
    let resolveWaiter;
    let rejectWaiter;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolveWaiter = resolvePromise;
      rejectWaiter = rejectPromise;
    });
    let settled = false;
    let timer = null;
    const finish = ({ value = null, error = null } = {}) => {
      if (settled) return;
      settled = true;
      this.waiters.delete(waiterId);
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (error) rejectWaiter(error);
      else resolveWaiter(value);
    };
    const onAbort = () => {
      this.cancelledWaiters += 1;
      finish({ error: new Error("Conversation identity wait was cancelled.") });
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    this.waiters.set(waiterId, {
      fingerprint,
      minimumObservedAtMs: Number.isFinite(minimumObservedAtMs) ? minimumObservedAtMs : null,
      createdAtMs: Date.now(),
      timeoutMs: boundedTimeoutMs,
      resolve: (resolved) => finish({ value: resolved }),
    });
    timer = setTimeout(() => {
      if (!this.waiters.has(waiterId)) return;
      this.timedOutWaiters += 1;
      finish({ value: null });
    }, boundedTimeoutMs);
    return await promise;
  }

  #resolveWaiters(fingerprint, resolved) {
    const observedAtMs = Date.parse(String(resolved?.observedAt || ""));
    for (const [id, waiter] of [...this.waiters]) {
      if (waiter.fingerprint !== fingerprint) continue;
      if (Number.isFinite(waiter.minimumObservedAtMs)
        && (!Number.isFinite(observedAtMs) || observedAtMs < waiter.minimumObservedAtMs)) continue;
      this.waiters.delete(id);
      waiter.resolve(structuredClone(resolved));
    }
  }

  diagnostics() {
    return {
      sessions: this.entries.size,
      verifiedDirectSessions: [...this.entries.values()].filter((entry) => entry.verifiedDirectSession === true).length,
      waiters: this.waiters.size,
      waitTimeoutMs: this.waitTimeoutMs,
      timedOutWaiters: this.timedOutWaiters,
      cancelledWaiters: this.cancelledWaiters,
      rawSessionPersisted: false,
    };
  }

  snapshot() {
    return {
      sessions: [...this.entries.values()]
        .map((entry) => structuredClone(entry))
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))),
    };
  }

  async #persist() {
    await atomicWrite(this.statePath, { version: 1, sessions: this.snapshot().sessions });
  }
}
