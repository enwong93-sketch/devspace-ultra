import { createHash } from "node:crypto";
import { sessionFingerprintFromClassicRequest } from "./classic-conversation-authority.js";

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_PENDING = 128;
const DEFAULT_MAX_SKEW_MS = 8_000;
const CALL_MCP_PATH = "/backend-api/ecosystem/call_mcp";

function cleanText(value, max = 240) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function cleanConversationId(value) {
  const text = cleanText(value, 200);
  return text && /^[A-Za-z0-9_-]{8,200}$/.test(text) ? text : null;
}

function canonicalValue(value, depth = 0, seen = new WeakSet()) {
  if (depth > 24) return "[depth-limit]";
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item, depth + 1, seen));
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalValue(value[key], depth + 1, seen);
  return result;
}

export function fingerprintMcpToolCall(methodOrBody, maybeParams) {
  const body = typeof methodOrBody === "string"
    ? { method: methodOrBody, params: maybeParams }
    : methodOrBody;
  const method = cleanText(body?.method, 120);
  const name = cleanText(body?.params?.name, 220);
  if (method !== "tools/call" || !name) return null;
  const canonical = canonicalValue({
    method,
    name,
    arguments: body?.params?.arguments ?? {},
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function isNativeCallMcpRequest(request = {}) {
  let url;
  try { url = new URL(String(request?.url || "")); }
  catch { return false; }
  return url.hostname === "chatgpt.com"
    && url.pathname === CALL_MCP_PATH
    && String(request?.method || "").toUpperCase() === "POST";
}

export function parseNativeCallMcpRequest(request = {}) {
  if (!isNativeCallMcpRequest(request)) return null;
  let body;
  try { body = JSON.parse(String(request?.postData || "")); }
  catch { return null; }
  const conversationId = cleanConversationId(body?.conversation_id);
  const callFingerprint = fingerprintMcpToolCall(body?.method, body?.params);
  if (!conversationId || !callFingerprint) return null;
  return {
    conversationId,
    sessionFingerprint: sessionFingerprintFromClassicRequest(request),
    callFingerprint,
    toolName: cleanText(body?.params?.name, 220),
    messageIdPresent: Boolean(cleanText(body?.message_id, 240)),
    source: "classic-native-call-mcp",
  };
}

function boundedRecord(input, side, now) {
  const callFingerprint = cleanText(input?.callFingerprint, 64)?.toLowerCase();
  if (!callFingerprint || !/^[a-f0-9]{64}$/.test(callFingerprint)) return null;
  const atMs = Number(input?.observedAtMs ?? now());
  if (!Number.isFinite(atMs)) return null;
  if (side === "native") {
    const conversationId = cleanConversationId(input?.conversationId);
    const runtimeKey = cleanText(input?.runtimeKey, 80);
    if (!conversationId || !runtimeKey) return null;
    return { side, callFingerprint, conversationId, runtimeKey, toolName: cleanText(input?.toolName, 220), atMs };
  }
  const sessionFingerprint = cleanText(input?.sessionFingerprint, 64)?.toLowerCase();
  if (!sessionFingerprint || !/^[a-f0-9]{64}$/.test(sessionFingerprint)) return null;
  return { side, callFingerprint, sessionFingerprint, toolName: cleanText(input?.toolName, 220), atMs };
}

export class ClassicMcpCallCorrelator {
  constructor({
    now = () => Date.now(),
    ttlMs = DEFAULT_TTL_MS,
    maxPending = DEFAULT_MAX_PENDING,
    maxSkewMs = DEFAULT_MAX_SKEW_MS,
  } = {}) {
    this.now = now;
    this.ttlMs = Math.max(1_000, Number(ttlMs) || DEFAULT_TTL_MS);
    this.maxPending = Math.max(4, Number(maxPending) || DEFAULT_MAX_PENDING);
    this.maxSkewMs = Math.max(100, Number(maxSkewMs) || DEFAULT_MAX_SKEW_MS);
    this.native = [];
    this.gateway = [];
    this.resolved = [];
    this.waiters = new Map();
    this.ambiguousMatches = 0;
  }

  noteNative(input) {
    return this.#note(boundedRecord(input, "native", this.now));
  }

  noteGateway(input) {
    return this.#note(boundedRecord(input, "gateway", this.now));
  }

  #note(record) {
    if (!record) return null;
    this.prune();
    const bucket = record.side === "native" ? this.native : this.gateway;
    bucket.push(record);
    while (bucket.length > this.maxPending) bucket.shift();
    return this.#attempt(record.callFingerprint);
  }

  #attempt(callFingerprint) {
    const now = this.now();
    const natives = this.native.filter((item) => item.callFingerprint === callFingerprint && now - item.atMs <= this.ttlMs);
    const gateways = this.gateway.filter((item) => item.callFingerprint === callFingerprint && now - item.atMs <= this.ttlMs);
    const candidatePairs = [];
    for (const native of natives) {
      const choices = gateways
        .map((gateway) => ({ native, gateway, skewMs: Math.abs(native.atMs - gateway.atMs) }))
        .filter((pair) => pair.skewMs <= this.maxSkewMs)
        .sort((a, b) => a.skewMs - b.skewMs || a.gateway.atMs - b.gateway.atMs);
      if (!choices.length) continue;
      if (choices.length > 1 && choices[0].skewMs === choices[1].skewMs) continue;
      const best = choices[0];
      const reverse = natives
        .map((candidateNative) => ({ native: candidateNative, gateway: best.gateway, skewMs: Math.abs(candidateNative.atMs - best.gateway.atMs) }))
        .filter((pair) => pair.skewMs <= this.maxSkewMs)
        .sort((a, b) => a.skewMs - b.skewMs || a.native.atMs - b.native.atMs);
      if (!reverse.length || reverse[0].native !== native) continue;
      if (reverse.length > 1 && reverse[0].skewMs === reverse[1].skewMs) continue;
      candidatePairs.push(best);
    }
    candidatePairs.sort((a, b) => a.skewMs - b.skewMs || Math.max(a.native.atMs, a.gateway.atMs) - Math.max(b.native.atMs, b.gateway.atMs));
    if (!candidatePairs.length) {
      if ((natives.length > 1 && gateways.length > 0) || (gateways.length > 1 && natives.length > 0)) this.ambiguousMatches += 1;
      return null;
    }
    if (candidatePairs.length > 1 && candidatePairs[0].skewMs === candidatePairs[1].skewMs) {
      this.ambiguousMatches += 1;
      return null;
    }
    const [{ native, gateway, skewMs }] = candidatePairs;
    this.native = this.native.filter((item) => item !== native);
    this.gateway = this.gateway.filter((item) => item !== gateway);
    const identity = {
      sessionFingerprint: gateway.sessionFingerprint,
      conversationId: native.conversationId,
      runtimeKey: native.runtimeKey,
      toolName: native.toolName || gateway.toolName || null,
      callFingerprint,
      observedAt: new Date(Math.max(native.atMs, gateway.atMs)).toISOString(),
      skewMs,
      source: "classic-native-call-mcp-correlation",
    };
    this.resolved.unshift(identity);
    this.resolved = this.resolved.slice(0, this.maxPending);
    for (const [key, waiter] of [...this.waiters]) {
      if (waiter.callFingerprint !== callFingerprint) continue;
      if (waiter.sessionFingerprint && waiter.sessionFingerprint !== identity.sessionFingerprint) continue;
      this.waiters.delete(key);
      waiter.resolve(identity);
    }
    return identity;
  }

  waitForIdentity({ callFingerprint, sessionFingerprint = null, signal } = {}) {
    const call = cleanText(callFingerprint, 64)?.toLowerCase();
    const session = cleanText(sessionFingerprint, 64)?.toLowerCase() || null;
    if (!call || !/^[a-f0-9]{64}$/.test(call)) return Promise.resolve(null);
    const existing = this.resolved.find((item) => item.callFingerprint === call && (!session || item.sessionFingerprint === session));
    if (existing) return Promise.resolve(existing);
    const key = `${call}:${session || "*"}`;
    const current = this.waiters.get(key);
    let sharedPromise = current?.promise;
    if (!sharedPromise) {
      let resolveWaiter;
      sharedPromise = new Promise((resolvePromise) => { resolveWaiter = resolvePromise; });
      this.waiters.set(key, {
        callFingerprint: call,
        sessionFingerprint: session,
        createdAtMs: this.now(),
        resolve: resolveWaiter,
        promise: sharedPromise,
      });
    }
    if (!signal) return sharedPromise;
    if (signal.aborted) return Promise.reject(new Error("MCP conversation correlation was cancelled."));
    return new Promise((resolvePromise, rejectPromise) => {
      const onAbort = () => rejectPromise(new Error("MCP conversation correlation was cancelled."));
      signal.addEventListener("abort", onAbort, { once: true });
      sharedPromise.then(resolvePromise, rejectPromise).finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
    });
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;
    this.native = this.native.filter((item) => item.atMs >= cutoff).slice(-this.maxPending);
    this.gateway = this.gateway.filter((item) => item.atMs >= cutoff).slice(-this.maxPending);
    this.resolved = this.resolved.filter((item) => Date.parse(item.observedAt || "") >= cutoff).slice(0, this.maxPending);
    for (const [key, waiter] of this.waiters) {
      if (Number(waiter.createdAtMs || 0) >= cutoff) continue;
      this.waiters.delete(key);
      waiter.resolve(null);
    }
    while (this.waiters.size > this.maxPending) {
      const oldest = [...this.waiters.entries()].sort((a, b) => Number(a[1].createdAtMs || 0) - Number(b[1].createdAtMs || 0))[0];
      if (!oldest) break;
      this.waiters.delete(oldest[0]);
      oldest[1].resolve(null);
    }
  }

  diagnostics() {
    this.prune();
    return {
      nativePending: this.native.length,
      gatewayPending: this.gateway.length,
      recentResolved: this.resolved.length,
      waiters: this.waiters.size,
      ambiguousMatches: this.ambiguousMatches,
      ttlMs: this.ttlMs,
      maxPending: this.maxPending,
      maxSkewMs: this.maxSkewMs,
      rawArgumentsPersisted: false,
      rawSessionPersisted: false,
    };
  }
}
