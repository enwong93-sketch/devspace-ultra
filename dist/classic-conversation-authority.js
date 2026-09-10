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
  };
}

export class ClassicConversationAuthorityRegistry {
  constructor({ statePath } = {}) {
    this.statePath = requireText(statePath, "statePath");
    this.entries = new Map();
    this.waiters = new Map();
  }

  async load() {
    let parsed = null;
    try { parsed = JSON.parse((await readFile(this.statePath, "utf8")).replace(/^\uFEFF/, "")); } catch {}
    this.entries.clear();
    for (const item of Array.isArray(parsed?.sessions) ? parsed.sessions : []) {
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
    if (authoritativeCurrent) {
      existing.conversationIds = [conversation];
      if (runtime) existing.runtimeKeys = [runtime];
    } else {
      if (!existing.conversationIds.includes(conversation)) existing.conversationIds.push(conversation);
      if (runtime && !existing.runtimeKeys.includes(runtime)) existing.runtimeKeys.push(runtime);
    }
    existing.ambiguous = existing.conversationIds.length > 1;
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
    if (!selected.length) throw new Error(`No Classic MCP session authority is bound to source conversation ${prior}.`);
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
      observedAt: at,
    };
  }

  resolveMcpExtra(extra) {
    const fingerprint = sessionFingerprintFromMcpExtra(extra);
    if (!fingerprint) return null;
    return this.resolveFingerprint(fingerprint);
  }

  async waitForFingerprint(value, { signal } = {}) {
    const fingerprint = String(value || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) return null;
    const immediate = this.resolveFingerprint(fingerprint);
    if (immediate) return immediate;
    const current = this.waiters.get(fingerprint);
    let sharedPromise = current?.promise;
    if (!sharedPromise) {
      let resolveWaiter;
      sharedPromise = new Promise((resolvePromise) => { resolveWaiter = resolvePromise; });
      this.waiters.set(fingerprint, { resolve: resolveWaiter, promise: sharedPromise });
    }
    if (!signal) return await sharedPromise;
    if (signal.aborted) throw new Error("Conversation identity wait was cancelled.");
    return await new Promise((resolvePromise, rejectPromise) => {
      const onAbort = () => rejectPromise(new Error("Conversation identity wait was cancelled."));
      signal.addEventListener("abort", onAbort, { once: true });
      sharedPromise.then(resolvePromise, rejectPromise).finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
    });
  }

  #resolveWaiters(fingerprint, resolved) {
    const waiter = this.waiters.get(fingerprint);
    if (!waiter) return;
    this.waiters.delete(fingerprint);
    waiter.resolve(structuredClone(resolved));
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
