import { randomUUID } from "node:crypto";
import { ClassicCdpClient } from "./classic-cdp-client.js";
import { sessionFingerprintFromClassicRequest, turnTraceFingerprintFromClassicRequest } from "./classic-conversation-authority.js";
import { extractClassicNativeUsageEvidence } from "./classic-native-usage-evidence.js";
import { defaultMainDebugPorts } from "./goal-host-bridge.js";
import { runtimeKeyForPort } from "./classic-stream-recovery-cdp.js";
import { requestTraceCorrelationFingerprints } from "./request-trace-correlation.js";
import { sessionCorrelationFingerprintsFromHeaders } from "./session-correlation.js";

const DEFAULT_CONNECTION_POLL_MS = 15_000;
const DEFAULT_PROBE_TIMEOUT_MS = 700;
const DEFAULT_ROLLOVER_TIMEOUT_MS = 120_000;
const NATIVE_DESCRIPTOR_CACHE_TTL_MS = 60_000;
const NATIVE_DESCRIPTOR_RATE_LIMIT_COOLDOWN_MS = 90_000;
const NATIVE_DESCRIPTOR_RETRY_DELAYS_MS = [0, 750, 2_000];
const NATIVE_DESCRIPTOR_MAX_CACHE_ENTRIES = 64;
const NATIVE_DESCRIPTOR_TRANSIENT_STATUSES = new Set([408, 425, 500, 502, 503, 504]);
const ROLLOVER_RESPONSE_TIMEOUT_MS = 30_000;
const ROLLOVER_MAX_TRANSACTIONS = 8;
const DEVSPACE_CONNECTOR_NAME = "DEV Space Local Gateway";

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function observedAt() { return new Date().toISOString(); }

export function parseNativeDescriptorRetryAfterMs(value, nowMs = Date.now()) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  // RFC 9110 permits integer delay-seconds or an HTTP date. Never shorten a
  // server's Retry-After to the former five-minute local cap.
  if (/^\d+$/.test(text)) {
    const milliseconds = Number(text) * 1_000;
    return Number.isSafeInteger(milliseconds) && nowMs + milliseconds <= 8.64e15 ? milliseconds : null;
  }
  if (!/[A-Za-z]{3}/.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

function isNativeDescriptorRateLimit(error) {
  const message = error instanceof Error ? error.message : String(error);
  return Number(error?.status) === 429 || error?.code === "NATIVE_DESCRIPTOR_RATE_LIMIT" || /Native conversation descriptor HTTP 429/i.test(message);
}

function isNativeDescriptorTransient(error) {
  return error?.code === "NATIVE_DESCRIPTOR_HTTP"
    && NATIVE_DESCRIPTOR_TRANSIENT_STATUSES.has(Number(error?.status));
}

export function classicSourcePageIdentity(snapshot) {
  const documentId = typeof snapshot?.documentId === "string" ? snapshot.documentId.trim() : "";
  const conversationId = typeof snapshot?.conversationId === "string" ? snapshot.conversationId.trim() : "";
  const epoch = Number(snapshot?.routeEpoch);
  if (!documentId || !conversationId || documentId.includes(":") || conversationId.includes(":") || !Number.isSafeInteger(epoch) || epoch < 1) return null;
  return `${documentId}:${epoch}:${conversationId}`;
}

export function stableClassicSourceRoute(snapshot, minimumStableMs = 3_000) {
  return Boolean(classicSourcePageIdentity(snapshot)
    && snapshot?.ok !== false && snapshot?.mode === "chat"
    && snapshot.documentReadyState === "complete" && snapshot.composerReady === true
    && snapshot.routeHydrated === true && Number.isFinite(Number(snapshot.routeStableForMs))
    && Number(snapshot.routeStableForMs) >= Math.max(0, Number(minimumStableMs) || 0));
}

function descriptorBoundaryError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function readStableClassicDescriptor({ inspectSource, fetchDescriptor, minimumStableMs = 3_000 } = {}) {
  if (typeof inspectSource !== "function" || typeof fetchDescriptor !== "function") throw new TypeError("Descriptor read requires source inspection and fetch functions.");
  const before = await inspectSource();
  if (!stableClassicSourceRoute(before, minimumStableMs)) throw descriptorBoundaryError("Native descriptor source route is not stable.", "NATIVE_DESCRIPTOR_SOURCE_UNSTABLE");
  const descriptor = await fetchDescriptor(before.conversationId);
  const after = await inspectSource();
  if (!stableClassicSourceRoute(after, minimumStableMs) || classicSourcePageIdentity(before) !== classicSourcePageIdentity(after)) {
    throw descriptorBoundaryError("Native descriptor source page changed during the read.", "NATIVE_DESCRIPTOR_SOURCE_CHANGED");
  }
  if (descriptor?.conversationId !== before.conversationId || !descriptor?.currentNode) throw descriptorBoundaryError("Native descriptor does not match the inspected source.", "NATIVE_DESCRIPTOR_SOURCE_MISMATCH");
  return descriptor;
}

export class NativeConversationDescriptorCoordinator {
  constructor({
    now = () => Date.now(),
    sleepImpl = sleep,
    cacheTtlMs = NATIVE_DESCRIPTOR_CACHE_TTL_MS,
    rateLimitCooldownMs = NATIVE_DESCRIPTOR_RATE_LIMIT_COOLDOWN_MS,
    retryDelaysMs = NATIVE_DESCRIPTOR_RETRY_DELAYS_MS,
    maxCacheEntries = NATIVE_DESCRIPTOR_MAX_CACHE_ENTRIES,
    minimumFetchGapMs = 0,
    failureCooldownMs = 300_000,
    transientCooldownMs = 30_000,
    rateLimitScope = "conversation",
  } = {}) {
    if (!["conversation", "shared"].includes(rateLimitScope)) throw new TypeError("Unknown descriptor rate-limit scope.");
    this.now = now;
    this.sleep = sleepImpl;
    this.cacheTtlMs = Math.max(0, Number(cacheTtlMs) || 0);
    this.rateLimitCooldownMs = Math.max(1_000, Number(rateLimitCooldownMs) || NATIVE_DESCRIPTOR_RATE_LIMIT_COOLDOWN_MS);
    this.retryDelaysMs = Array.isArray(retryDelaysMs) && retryDelaysMs.length
      ? retryDelaysMs.map((value) => Math.max(0, Number(value) || 0))
      : [0];
    this.maxCacheEntries = Math.max(1, Number(maxCacheEntries) || NATIVE_DESCRIPTOR_MAX_CACHE_ENTRIES);
    this.minimumFetchGapMs = Math.max(0, Number(minimumFetchGapMs) || 0);
    this.failureCooldownMs = Math.max(1_000, Number(failureCooldownMs) || 300_000);
    this.transientCooldownMs = Math.max(1_000, Number(transientCooldownMs) || 30_000);
    // A shared rate-limit domain must be explicitly selected by its owner.
    // The default never freezes unrelated Main conversations after one 429.
    this.rateLimitScope = rateLimitScope;
    this.cooldownUntil = 0;
    this.failureCooldowns = new Map();
    this.generation = 0;
    this.pacingTail = null;
    this.lastFetchAt = null;
    this.cache = new Map();
    this.inFlight = new Map();
    this.cooldowns = new Map();
  }

  #cooldownError(cooldownUntil) {
    const error = new Error(`Native conversation descriptor rate limited until ${new Date(cooldownUntil).toISOString()}`);
    error.code = "NATIVE_DESCRIPTOR_COOLDOWN";
    error.status = 429;
    error.retryAt = new Date(cooldownUntil).toISOString();
    return error;
  }

  #assertGeneration(generation) {
    if (generation !== this.generation) throw descriptorBoundaryError("Descriptor coordinator was cleared during the read.", "NATIVE_DESCRIPTOR_CLEARED");
  }

  #checkCooldown(id) {
    const now = this.now();
    const until = Math.max(Number(this.cooldowns.get(id) || 0), this.rateLimitScope === "shared" ? this.cooldownUntil : 0);
    if (until > now) throw this.#cooldownError(until);
    const failure = this.failureCooldowns.get(id);
    if (failure?.until > now) {
      const error = descriptorBoundaryError("Native descriptor failure cooldown is active.", "NATIVE_DESCRIPTOR_FAILURE_COOLDOWN");
      error.status = failure.status;
      error.retryAt = new Date(failure.until).toISOString();
      throw error;
    }
  }

  #pruneCache() {
    const now = this.now();
    for (const [conversationId, until] of this.cooldowns) {
      if (Number(until || 0) <= now) this.cooldowns.delete(conversationId);
    }
    for (const [id, failure] of this.failureCooldowns) if (failure.until <= now) this.failureCooldowns.delete(id);
    while (this.failureCooldowns.size > this.maxCacheEntries) this.failureCooldowns.delete(this.failureCooldowns.keys().next().value);
    if (this.cache.size <= this.maxCacheEntries && this.cooldowns.size <= this.maxCacheEntries) return;
    const oldest = [...this.cache.entries()].sort((a, b) => Number(a[1]?.observedAtMs || 0) - Number(b[1]?.observedAtMs || 0));
    for (const [conversationId] of oldest) {
      if (this.cache.size <= this.maxCacheEntries) break;
      this.cache.delete(conversationId);
    }
    const limited = [...this.cooldowns.entries()].sort((a, b) => Number(a[1] || 0) - Number(b[1] || 0));
    for (const [conversationId] of limited) {
      if (this.cooldowns.size <= this.maxCacheEntries) break;
      this.cooldowns.delete(conversationId);
    }
  }

  async load(conversationId, { force = false, fetchDescriptor } = {}) {
    const id = String(conversationId || "").trim();
    if (!id) throw new Error("Native conversation descriptor requires a conversation id.");
    if (typeof fetchDescriptor !== "function") throw new Error("Native conversation descriptor requires a fetch function.");
    this.#pruneCache();
    this.#checkCooldown(id);
    const now = this.now();
    const cached = this.cache.get(id);
    if (!force && cached && now - cached.observedAtMs < this.cacheTtlMs) return structuredClone(cached.descriptor);
    const existing = this.inFlight.get(id);
    if (existing) return structuredClone(await existing);
    if (this.inFlight.size >= this.maxCacheEntries) throw descriptorBoundaryError("Descriptor in-flight capacity reached.", "NATIVE_DESCRIPTOR_CAPACITY");
    const pending = this.#loadFresh(id, fetchDescriptor, this.generation);
    this.inFlight.set(id, pending);
    try {
      return structuredClone(await pending);
    } finally {
      if (this.inFlight.get(id) === pending) this.inFlight.delete(id);
    }
  }

  async #fetchPaced(id, fetchDescriptor, generation) {
    this.#assertGeneration(generation);
    this.#checkCooldown(id);
    if (!this.minimumFetchGapMs) return await fetchDescriptor();
    const previous = this.pacingTail;
    let release;
    this.pacingTail = new Promise((resolve) => { release = resolve; });
    try {
      if (previous) await previous;
      this.#assertGeneration(generation);
      this.#checkCooldown(id);
      const gap = this.lastFetchAt == null ? 0 : this.lastFetchAt + this.minimumFetchGapMs - this.now();
      if (gap > 0) await this.sleep(gap);
      this.#assertGeneration(generation);
      this.#checkCooldown(id);
      this.lastFetchAt = this.now();
      const pending = fetchDescriptor();
      release();
      return await pending;
    } finally { release(); }
  }

  async #loadFresh(id, fetchDescriptor, generation) {
    let lastError = null;
    let retryAfterMs = 0;
    for (let index = 0; index < this.retryDelaysMs.length; index += 1) {
      const delayMs = Math.max(this.retryDelaysMs[index], retryAfterMs);
      if (delayMs > 0) await this.sleep(delayMs);
      this.#assertGeneration(generation);
      this.#checkCooldown(id);
      try {
        const descriptor = await this.#fetchPaced(id, fetchDescriptor, generation);
        this.#assertGeneration(generation);
        if (descriptor?.conversationId !== id || !descriptor?.currentNode) throw descriptorBoundaryError("Descriptor response names the wrong conversation or lacks its boundary.", "NATIVE_DESCRIPTOR_IDENTITY");
        this.cache.set(id, { descriptor: structuredClone(descriptor), observedAtMs: this.now() });
        this.cooldowns.delete(id);
        this.failureCooldowns.delete(id);
        this.#pruneCache();
        return descriptor;
      } catch (error) {
        this.#assertGeneration(generation);
        if (/^NATIVE_DESCRIPTOR_(?:SOURCE_|COOLDOWN|FAILURE_COOLDOWN|CLEARED)/.test(String(error?.code || ""))) throw error;
        lastError = error;
        if (isNativeDescriptorRateLimit(error)) {
          const retryAfterMs = parseNativeDescriptorRetryAfterMs(error?.retryAfter, this.now());
          const cooldownMs = Math.max(this.rateLimitCooldownMs, retryAfterMs ?? 0);
          const next = this.now() + cooldownMs;
          this.cooldowns.set(id, Math.max(Number(this.cooldowns.get(id) || 0), next));
          if (this.rateLimitScope === "shared") this.cooldownUntil = Math.max(this.cooldownUntil, next);
          this.#pruneCache();
          break;
        }
        const transient = isNativeDescriptorTransient(error);
        retryAfterMs = parseNativeDescriptorRetryAfterMs(error?.retryAfter, this.now()) ?? 0;
        if (!transient || index + 1 >= this.retryDelaysMs.length) {
          this.failureCooldowns.set(id, { until: this.now() + Math.max(retryAfterMs, transient ? this.transientCooldownMs : this.failureCooldownMs), status: Number(error?.status) || null });
          this.#pruneCache();
          break;
        }
      }
    }
    // Never turn a failed fresh boundary read into a successful stale result.
    throw lastError || new Error("Native conversation descriptor unavailable.");
  }

  status() {
    this.#pruneCache();
    const now = this.now();
    const activeCooldowns = [...this.cooldowns.entries()]
      .filter(([, until]) => Number(until || 0) > now)
      .sort((a, b) => Number(a[1]) - Number(b[1]));
    return {
      cachedConversations: this.cache.size,
      inFlight: this.inFlight.size,
      minimumFetchGapMs: this.minimumFetchGapMs,
      failureCooldowns: this.failureCooldowns.size,
      rateLimitScope: this.rateLimitScope,
      cooldownUntil: this.rateLimitScope === "shared" && this.cooldownUntil > now ? new Date(this.cooldownUntil).toISOString() : null,
      rateLimitedConversations: activeCooldowns.length,
      nextCooldownExpiry: activeCooldowns.length ? new Date(activeCooldowns[0][1]).toISOString() : null,
    };
  }

  clear() {
    this.generation += 1;
    this.cache.clear();
    this.inFlight.clear();
    this.cooldowns.clear();
    this.failureCooldowns.clear();
    this.cooldownUntil = 0;
    this.lastFetchAt = null;
  }
}

const sharedNativeConversationDescriptorCoordinator = new NativeConversationDescriptorCoordinator({ minimumFetchGapMs: 2_000 });

async function fetchJson(url, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable for Context Guardian CDP discovery.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function isNativeModelsUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.hostname === "chatgpt.com" && parsed.pathname === "/backend-api/models";
  } catch { return false; }
}

function isTurnUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.hostname === "chatgpt.com"
      && ["/backend-api/f/conversation", "/backend-api/f/conversation/resume"].includes(parsed.pathname);
  } catch { return false; }
}

export function estimateClassicInputTokens(value) {
  const text = String(value ?? "");
  if (!text) return 0;
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/gu) || []).length;
  const emoji = (text.match(/\p{Extended_Pictographic}/gu) || []).length;
  const asciiWords = (text.match(/[A-Za-z0-9_]+(?:[-'][A-Za-z0-9_]+)*/g) || []).length;
  const punctuation = (text.match(/[^\sA-Za-z0-9_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/gu) || []).length;
  const asciiChars = (text.match(/[\x00-\x7f]/g) || []).length;
  const asciiLengthTokens = Math.ceil(asciiChars / 4);
  return Math.max(1, cjk + (emoji * 2) + Math.max(asciiWords, asciiLengthTokens) + Math.ceil(punctuation / 2));
}

function estimateContentTokens(value, depth = 0) {
  if (depth > 10 || value === undefined || value === null) return 0;
  if (typeof value === "string") return estimateClassicInputTokens(value);
  if (typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimateContentTokens(item, depth + 1), 0);
  return Object.entries(value).reduce((sum, [key, item]) => {
    if (/^(?:metadata|author|recipient|status)$/i.test(key)) return sum;
    return sum + estimateContentTokens(item, depth + 1);
  }, 0);
}

function estimateMessageTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const message of messages) {
    total += 8;
    total += estimateContentTokens(message?.content);
  }
  return total;
}

function conversationPayloadMessages(payload = {}) {
  if (Array.isArray(payload?.messages)) return payload.messages;
  if (payload?.mapping && typeof payload.mapping === "object") {
    return Object.values(payload.mapping).map((node) => node?.message).filter(Boolean);
  }
  if (payload?.conversation?.mapping && typeof payload.conversation.mapping === "object") {
    return Object.values(payload.conversation.mapping).map((node) => node?.message).filter(Boolean);
  }
  if (Array.isArray(payload?.conversation?.messages)) return payload.conversation.messages;
  return [];
}

export function estimateClassicConversationPayloadTokens(payload = {}) {
  return estimateMessageTokens(conversationPayloadMessages(payload));
}

export function summarizeClassicConversationPayload(payload = {}) {
  const encoder = new TextEncoder();
  const estimateTextTokens = (value) => {
    const text = String(value ?? "");
    if (!text) return 0;
    const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/gu) || []).length;
    const emoji = (text.match(/\p{Extended_Pictographic}/gu) || []).length;
    const words = (text.match(/[A-Za-z0-9_]+(?:[-'][A-Za-z0-9_]+)*/g) || []).length;
    const punctuation = (text.match(/[^\sA-Za-z0-9_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/gu) || []).length;
    const ascii = (text.match(/[\x00-\x7f]/g) || []).length;
    return Math.max(1, cjk + emoji * 2 + Math.max(words, Math.ceil(ascii / 4)) + Math.ceil(punctuation / 2));
  };
  const estimateContent = (value, depth = 0) => {
    if (depth > 12 || value == null) return 0;
    if (typeof value === "string") return estimateTextTokens(value);
    if (typeof value !== "object") return 0;
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimateContent(item, depth + 1), 0);
    return Object.entries(value).reduce((sum, [key, item]) => /^(?:metadata|author|recipient|status)$/i.test(key) ? sum : sum + estimateContent(item, depth + 1), 0);
  };
  const visibleText = (message) => {
    const parts = Array.isArray(message?.content?.parts)
      ? message.content.parts.filter((part) => typeof part === "string")
      : [];
    return parts.join("").trim().slice(0, 2_400);
  };
  const textLength = (value, depth = 0) => {
    if (depth > 12 || value == null) return 0;
    if (typeof value === "string") return value.length;
    if (typeof value !== "object") return 0;
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + textLength(item, depth + 1), 0);
    return Object.entries(value).reduce((sum, [key, item]) => /^(?:metadata|author|recipient|status)$/i.test(key) ? sum : sum + textLength(item, depth + 1), 0);
  };
  const mapping = payload?.mapping && typeof payload.mapping === "object" ? payload.mapping : null;
  const currentNode = typeof payload?.current_node === "string" ? payload.current_node : null;
  const allMessages = Array.isArray(payload?.messages)
    ? payload.messages
    : mapping ? Object.values(mapping).map((node) => node?.message).filter(Boolean) : [];
  const branch = [];
  if (mapping && currentNode) {
    const seen = new Set();
    let cursor = currentNode;
    while (cursor && !seen.has(cursor) && branch.length < 20_000) {
      seen.add(cursor);
      const node = mapping[cursor];
      if (!node) break;
      if (node.message) branch.push(node.message);
      cursor = typeof node.parent === "string" ? node.parent : null;
    }
    branch.reverse();
  } else {
    branch.push(...allMessages);
  }
  const roleCounts = {};
  let sourceTextChars = 0;
  let estimatedTokens = 0;
  let hiddenMessages = 0;
  let visibleUsers = 0;
  let visibleAssistants = 0;
  let devspaceContinuity = null;
  const recentVisibleMessages = [];
  for (const message of branch) {
    const role = String(message?.author?.role || message?.role || "unknown");
    roleCounts[role] = (roleCounts[role] || 0) + 1;
    sourceTextChars += textLength(message?.content);
    estimatedTokens += 8 + estimateContent(message?.content);
    const hidden = message?.metadata?.is_visually_hidden_from_conversation === true;
    if (hidden) {
      hiddenMessages += 1;
      const metadata = message?.metadata || {};
      if (!devspaceContinuity && (metadata.devspace_source_conversation_id || metadata.devspace_ui_continuity_key || metadata.devspace_capsule_fingerprint)) {
        devspaceContinuity = {
          sourceConversationId: typeof metadata.devspace_source_conversation_id === "string" ? metadata.devspace_source_conversation_id : null,
          sourceBoundaryMessageId: typeof metadata.devspace_source_boundary_message_id === "string" ? metadata.devspace_source_boundary_message_id : null,
          uiContinuityKey: typeof metadata.devspace_ui_continuity_key === "string" ? metadata.devspace_ui_continuity_key : null,
          capsuleFingerprint: typeof metadata.devspace_capsule_fingerprint === "string" ? metadata.devspace_capsule_fingerprint : null,
        };
      }
    } else if (role === "user") {
      visibleUsers += 1;
      const text = visibleText(message);
      if (text) recentVisibleMessages.push({ role: "user", text });
    } else if (role === "assistant" && (!message?.recipient || message.recipient === "all")) {
      visibleAssistants += 1;
      const text = visibleText(message);
      if (text) recentVisibleMessages.push({ role: "assistant", text });
    }
  }
  const continuation = payload?.context_truncation_continuation;
  return {
    conversationId: typeof payload?.conversation_id === "string" ? payload.conversation_id : null,
    currentNode,
    title: typeof payload?.title === "string" ? payload.title.slice(0, 500) : null,
    modelSlug: typeof payload?.default_model_slug === "string" ? payload.default_model_slug.slice(0, 200) : null,
    payloadBytes: encoder.encode(JSON.stringify(payload)).length,
    mappingCount: mapping ? Object.keys(mapping).length : null,
    branchMessageCount: branch.length,
    textChars: sourceTextChars,
    estimatedTokens,
    recentVisibleMessages: recentVisibleMessages.slice(-12),
    roleCounts,
    hiddenMessages,
    visibleUsers,
    visibleAssistants,
    devspaceContinuity,
    contextTruncationContinuation: continuation && typeof continuation === "object" ? {
      sourceConversationId: typeof continuation.source_conversation_id === "string" ? continuation.source_conversation_id : null,
      boundaryMessageId: typeof continuation.boundary_message_id === "string" ? continuation.boundary_message_id : null,
      visibleFromMessageId: typeof continuation.visible_from_message_id === "string" ? continuation.visible_from_message_id : null,
    } : null,
  };
}

export function nativeConversationDescriptorExpression(conversationId) {
  return `(${async function collect(id, summarize) {
    let accessToken = null;
    const auth = await fetch('/api/auth/session', { credentials:'include', cache:'no-store' });
    if (auth.ok) {
      const session = await auth.json();
      accessToken = typeof session?.accessToken === 'string' ? session.accessToken
        : typeof session?.access_token === 'string' ? session.access_token
          : null;
    }
    const paths = [
      '/backend-api/conversation/' + encodeURIComponent(id),
      '/backend-api/conversations/' + encodeURIComponent(id),
    ];
    const attempts = [];
    for (const path of paths) {
      const response = await fetch(path, {
        credentials:'include',
        cache:'no-store',
        headers: accessToken ? { authorization:'Bearer ' + accessToken } : undefined,
      });
      const retryAfter = response.headers?.get?.('retry-after') || null;
      attempts.push({ path, status: response.status, retryAfter });
      if (response.ok) {
        const payload = await response.json();
        return { ...summarize(payload), authenticatedBackendFetch:Boolean(accessToken), rawContentReturned:false, credentialsReturned:false, descriptorEndpoint:path, descriptorAttempts:attempts };
      }
      if (response.status === 429) {
        return { ok:false, errorCode:'NATIVE_DESCRIPTOR_RATE_LIMIT', status:429, retryAfter, attempts, rawContentReturned:false, credentialsReturned:false };
      }
      if (![404, 405].includes(response.status)) {
        return { ok:false, errorCode:'NATIVE_DESCRIPTOR_HTTP', status:response.status, retryAfter, attempts, rawContentReturned:false, credentialsReturned:false };
      }
    }
    return { ok:false, errorCode:'NATIVE_DESCRIPTOR_NOT_FOUND', status:404, retryAfter:null, attempts, rawContentReturned:false, credentialsReturned:false };
  }.toString()})(${JSON.stringify(conversationId)}, (${summarizeClassicConversationPayload.toString()}))`;
}

function visibleMessagesFromPayload(payload = {}, limit = 8) {
  const bounded = Math.max(1, Math.min(20, Number(limit) || 8));
  return conversationPayloadMessages(payload)
    .map((message) => {
      const role = message?.author?.role || message?.role || null;
      const hidden = message?.metadata?.is_visually_hidden_from_conversation === true;
      const recipient = message?.recipient ?? "all";
      const parts = Array.isArray(message?.content?.parts)
        ? message.content.parts.filter((part) => typeof part === "string")
        : [];
      return {
        role,
        hidden,
        recipient,
        text: parts.join("").trim(),
        createTime: Number(message?.create_time || 0),
      };
    })
    .filter((row) => !row.hidden && ["user", "assistant"].includes(row.role) && (!row.recipient || row.recipient === "all") && row.text)
    .sort((a, b) => a.createTime - b.createTime)
    .slice(-bounded)
    .map((row) => ({ role: row.role, text: row.text.slice(0, 2_400) }));
}

export function buildClassicHiddenRolloverBody(originalBody = {}, {
  prompt,
  attribution = "devspace-ultra",
  messageId,
  toolName = "devspace_context_guardian",
  sourceConversationId,
  sourceMessageId,
  uiContinuityKey,
  capsuleFingerprint,
} = {}) {
  const text = String(prompt ?? "").trim();
  if (!text) throw new Error("Hidden rollover prompt is required.");
  const source = originalBody && typeof originalBody === "object" ? originalBody : {};
  const first = Array.isArray(source.messages) && source.messages[0] && typeof source.messages[0] === "object"
    ? source.messages[0]
    : {};
  const originalConversationId = typeof source.conversation_id === "string" ? source.conversation_id.trim() : "";
  const continuationSourceId = String(sourceConversationId || originalConversationId || "").trim();
  const continuationBoundaryId = String(sourceMessageId || "").trim();
  const body = { ...source };
  delete body.conversation_id;
  if (continuationSourceId) {
    body.is_context_truncation_continuation = true;
    body.branching_from_conversation_id = continuationSourceId;
    if (continuationBoundaryId) body.branching_from_message_id = continuationBoundaryId;
  }
  const metadata = {
    ...(Array.isArray(first?.metadata?.system_hints) ? { system_hints: [...first.metadata.system_hints] } : {}),
    chatgpt_sdk_attribution: String(attribution || "devspace-ultra").slice(0, 160),
    chatgpt_sdk_followup_prompt: true,
    is_visually_hidden_from_conversation: true,
    ...(continuationSourceId ? { devspace_source_conversation_id: continuationSourceId } : {}),
    ...(continuationBoundaryId ? { devspace_source_boundary_message_id: continuationBoundaryId } : {}),
    ...(uiContinuityKey ? { devspace_ui_continuity_key: String(uiContinuityKey).slice(0, 300) } : {}),
    ...(capsuleFingerprint ? { devspace_capsule_fingerprint: String(capsuleFingerprint).slice(0, 80) } : {}),
  };
  body.messages = [{
    ...(messageId || first.id ? { id: String(messageId || first.id) } : {}),
    ...(first.create_time !== undefined ? { create_time: first.create_time } : {}),
    author: { role: "tool", name: String(toolName || "devspace_context_guardian").replaceAll(".", "_").slice(0, 160) },
    content: { content_type: "text", parts: [text] },
    recipient: "all",
    metadata,
  }];
  return body;
}

export function buildClassicUserTurnRolloverBody(originalBody = {}, {
  capsulePrompt,
  attribution = "devspace-ultra",
  hiddenMessageId,
  parentMessageId,
  toolName = "devspace_context_guardian",
  sourceConversationId,
  sourceMessageId,
  uiContinuityKey,
  capsuleFingerprint,
} = {}) {
  const text = String(capsulePrompt ?? "").trim();
  if (!text) throw new Error("User-turn rollover compact capsule is required.");
  const source = originalBody && typeof originalBody === "object" ? originalBody : {};
  const messages = Array.isArray(source.messages) ? source.messages : [];
  if (!messages.some((message) => message?.author?.role === "user" && message?.metadata?.is_visually_hidden_from_conversation !== true)) {
    throw new Error("User-turn rollover requires one visible user-submitted message.");
  }
  const originalConversationId = typeof source.conversation_id === "string" ? source.conversation_id.trim() : "";
  const continuationSourceId = String(sourceConversationId || originalConversationId || "").trim();
  const continuationBoundaryId = String(sourceMessageId || "").trim();
  const body = {
    ...source,
    parent_message_id: String(parentMessageId || randomUUID()),
  };
  delete body.conversation_id;
  if (continuationSourceId) {
    body.is_context_truncation_continuation = true;
    body.branching_from_conversation_id = continuationSourceId;
    if (continuationBoundaryId) body.branching_from_message_id = continuationBoundaryId;
  }
  const first = messages[0] && typeof messages[0] === "object" ? messages[0] : {};
  body.messages = [{
    id: String(hiddenMessageId || randomUUID()),
    ...(first.create_time !== undefined ? { create_time: first.create_time } : {}),
    author: { role: "tool", name: String(toolName || "devspace_context_guardian").replaceAll(".", "_").slice(0, 160) },
    content: { content_type: "text", parts: [text] },
    recipient: "all",
    metadata: {
      ...(Array.isArray(first?.metadata?.system_hints) ? { system_hints: [...first.metadata.system_hints] } : {}),
      chatgpt_sdk_attribution: String(attribution || "devspace-ultra").slice(0, 160),
      chatgpt_sdk_followup_prompt: true,
      is_visually_hidden_from_conversation: true,
      ...(continuationSourceId ? { devspace_source_conversation_id: continuationSourceId } : {}),
      ...(continuationBoundaryId ? { devspace_source_boundary_message_id: continuationBoundaryId } : {}),
      ...(uiContinuityKey ? { devspace_ui_continuity_key: String(uiContinuityKey).slice(0, 300) } : {}),
      ...(capsuleFingerprint ? { devspace_capsule_fingerprint: String(capsuleFingerprint).slice(0, 80) } : {}),
    },
  }, ...messages];
  return body;
}

export async function rewriteUserTurnRolloverPausedRequest(client, params, {
  capsulePrompt,
  attribution = "devspace-ultra",
  hiddenMessageId,
  parentMessageId,
  toolName = "devspace_context_guardian",
  sourceConversationId,
  sourceMessageId,
  uiContinuityKey,
  capsuleFingerprint,
} = {}) {
  const requestId = params?.requestId;
  if (!requestId) return { handled: false, modified: false };
  let exactTurn = false;
  try {
    exactTurn = new URL(String(params?.request?.url || "")).pathname === "/backend-api/f/conversation";
  } catch {}
  if (!exactTurn || String(params?.request?.method || "").toUpperCase() !== "POST") {
    return { handled: false, modified: false };
  }
  try {
    const originalBody = JSON.parse(String(params?.request?.postData || "{}"));
    const oldConversationId = typeof originalBody?.conversation_id === "string" ? originalBody.conversation_id.trim() : "";
    if (!oldConversationId) return { handled: false, modified: false };
    const visibleUserMessages = Array.isArray(originalBody?.messages)
      ? originalBody.messages.filter((message) => message?.author?.role === "user" && message?.metadata?.is_visually_hidden_from_conversation !== true).length
      : 0;
    if (visibleUserMessages < 1) return { handled: false, modified: false };
    const rewritten = buildClassicUserTurnRolloverBody(originalBody, {
      capsulePrompt,
      attribution,
      hiddenMessageId,
      parentMessageId,
      toolName,
      sourceConversationId,
      sourceMessageId,
      uiContinuityKey,
      capsuleFingerprint,
    });
    await client.call("Fetch.continueRequest", {
      requestId,
      postData: Buffer.from(JSON.stringify(rewritten), "utf8").toString("base64"),
    });
    return { handled: true, modified: true, oldConversationId, visibleUserMessages };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const originalRequestContinued = await client.call("Fetch.continueRequest", { requestId })
      .then(() => true)
      .catch(() => false);
    return {
      handled: true,
      modified: false,
      originalRequestContinued,
      sourceConversationPreserved: originalRequestContinued,
      error: message,
    };
  }
}

export async function rewriteHiddenRolloverPausedRequest(client, params, {
  prompt,
  attribution = "devspace-ultra",
  toolName = "devspace_context_guardian",
  sourceConversationId,
  sourceMessageId,
  uiContinuityKey,
  capsuleFingerprint,
} = {}) {
  const requestId = params?.requestId;
  if (!requestId) return { handled: false, modified: false };
  let exactTurn = false;
  try {
    exactTurn = new URL(String(params?.request?.url || "")).pathname === "/backend-api/f/conversation";
  } catch {}
  if (!exactTurn || String(params?.request?.method || "").toUpperCase() !== "POST") {
    return { handled: false, modified: false };
  }
  try {
    const originalBody = JSON.parse(String(params?.request?.postData || "{}"));
    const hiddenBody = buildClassicHiddenRolloverBody(originalBody, {
      prompt,
      attribution,
      toolName,
      sourceConversationId,
      sourceMessageId,
      uiContinuityKey,
      capsuleFingerprint,
    });
    await client.call("Fetch.continueRequest", {
      requestId,
      postData: Buffer.from(JSON.stringify(hiddenBody), "utf8").toString("base64"),
    });
    return { handled: true, modified: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const originalRequestContinued = await client.call("Fetch.continueRequest", { requestId })
      .then(() => true)
      .catch(() => false);
    return {
      handled: true,
      modified: false,
      originalRequestContinued,
      sourceConversationPreserved: originalRequestContinued,
      error: message,
    };
  }
}

export function parseClassicTurnRequest(request = {}) {
  if (String(request.method || "").toUpperCase() !== "POST" || !isTurnUrl(request.url)) return null;
  let requestPath = null;
  try { requestPath = new URL(String(request.url || "")).pathname; } catch {}
  let body;
  try { body = JSON.parse(String(request.postData || "{}")); } catch { return null; }
  const modelSlug = typeof body?.model === "string" ? body.model.trim() : "";
  if (!modelSlug) return null;
  const localFunctionNames = [...new Set(
    (Array.isArray(body?.local_function_names) ? body.local_function_names : [])
      .map((value) => String(value ?? "").trim())
      .filter((value) => /^[A-Za-z0-9_.:-]{1,220}$/.test(value))
      .slice(0, 256),
  )];
  const sourceUserMessageId = [...(Array.isArray(body?.messages) ? body.messages : [])]
    .reverse()
    .find((message) => message?.author?.role === "user" && typeof message?.id === "string")
    ?.id?.trim() || null;
  return {
    transportKind: requestPath === "/backend-api/f/conversation/resume" ? "resume" : "start",
    modelSlug,
    thinkingEffort: typeof body?.thinking_effort === "string"
      ? body.thinking_effort
      : typeof body?.thinkingEffort === "string" ? body.thinkingEffort : null,
    conversationId: typeof body?.conversation_id === "string" ? body.conversation_id : null,
    sessionFingerprint: sessionFingerprintFromClassicRequest(request),
    sessionCorrelationFingerprints: sessionCorrelationFingerprintsFromHeaders(request?.headers || {}),
    turnTraceFingerprint: turnTraceFingerprintFromClassicRequest(request),
    traceCorrelationFingerprints: requestTraceCorrelationFingerprints(request?.headers || {}),
    sourceUserMessageId: sourceUserMessageId && /^[A-Za-z0-9_-]{8,200}$/.test(sourceUserMessageId)
      ? sourceUserMessageId
      : null,
    localFunctionNames,
    estimatedInputTokens: estimateMessageTokens(body?.messages),
  };
}

export class ClassicTurnIdentityCorrelator {
  constructor({ now = Date.now, pendingTtlMs = 30_000, maxPending = 256 } = {}) {
    if (typeof now !== "function") throw new Error("ClassicTurnIdentityCorrelator now must be a function.");
    this.now = now;
    this.pendingTtlMs = Math.max(1_000, Number(pendingTtlMs) || 30_000);
    this.maxPending = Math.max(1, Number(maxPending) || 256);
    this.pending = new Map();
  }

  get pendingSize() {
    this.prune();
    return this.pending.size;
  }

  noteRequest(params = {}) {
    const requestId = String(params?.requestId || "").trim();
    if (!requestId) return null;
    const metadata = parseClassicTurnRequest(params?.request);
    if (!metadata?.conversationId) return null;
    const entry = this.#entry(requestId);
    entry.conversationId = metadata.conversationId;
    if (metadata.sessionFingerprint) entry.sessionFingerprint = metadata.sessionFingerprint;
    this.pending.set(requestId, entry);
    this.#enforceBounds();
    return this.#resolve(requestId);
  }

  noteExtraInfo(params = {}) {
    const requestId = String(params?.requestId || "").trim();
    if (!requestId) return null;
    const sessionFingerprint = sessionFingerprintFromClassicRequest({ headers: params?.headers || {} });
    if (!sessionFingerprint) return null;
    const entry = this.#entry(requestId);
    entry.sessionFingerprint = sessionFingerprint;
    this.pending.set(requestId, entry);
    this.#enforceBounds();
    return this.#resolve(requestId);
  }

  forget(requestId) {
    const id = String(requestId || "").trim();
    if (!id) return false;
    return this.pending.delete(id);
  }

  prune() {
    const cutoff = Number(this.now()) - this.pendingTtlMs;
    for (const [requestId, entry] of this.pending) {
      if (Number(entry?.firstSeenAt || 0) < cutoff) this.pending.delete(requestId);
    }
    this.#enforceCap();
    return this.pending.size;
  }

  #entry(requestId) {
    this.prune();
    return this.pending.get(requestId) || { firstSeenAt: Number(this.now()) };
  }

  #enforceBounds() {
    this.prune();
  }

  #enforceCap() {
    if (this.pending.size <= this.maxPending) return;
    const oldest = [...this.pending.entries()]
      .sort((a, b) => Number(a[1]?.firstSeenAt || 0) - Number(b[1]?.firstSeenAt || 0));
    for (const [requestId] of oldest) {
      if (this.pending.size <= this.maxPending) break;
      this.pending.delete(requestId);
    }
  }

  #resolve(requestId) {
    const entry = this.pending.get(requestId);
    if (!entry?.conversationId || !entry?.sessionFingerprint) return null;
    this.pending.delete(requestId);
    return {
      requestId,
      conversationId: entry.conversationId,
      sessionFingerprint: entry.sessionFingerprint,
    };
  }
}

export function parseNativeClassicModelResponse(text) {
  let payload;
  try { payload = typeof text === "string" ? JSON.parse(text) : text; } catch { return []; }
  const models = Array.isArray(payload?.models) ? payload.models : [];
  const safe = [];
  for (const model of models) {
    const slug = typeof model?.slug === "string" ? model.slug.trim() : "";
    const maxTokens = Number(model?.max_tokens);
    if (!slug || !Number.isFinite(maxTokens) || maxTokens < 8_000) continue;
    safe.push({
      slug,
      max_tokens: Math.floor(maxTokens),
      title: typeof model?.title === "string" ? model.title.slice(0, 240) : undefined,
      reasoning_type: typeof model?.reasoning_type === "string" ? model.reasoning_type.slice(0, 80) : undefined,
      is_work_mode_model: model?.is_work_mode_model === true,
    });
  }
  return safe;
}

function inspectExpression() {
  return `(() => {
    const match = location.pathname.match(/\\/c\\/([^/?#]+)/);
    const conversationId = match?.[1] || null;
    const lifecycleNow = Date.now();
    const documentLifecycleKey = '__devspaceClassicDocumentLifecycleV1';
    const routeLifecycleKey = '__devspaceClassicConversationLifecycleV1';
    const documentLifecycle = globalThis[documentLifecycleKey] || (globalThis[documentLifecycleKey] = {
      id: globalThis.crypto?.randomUUID?.() || ('document-' + lifecycleNow + '-' + Math.random().toString(36).slice(2)),
      createdAtMs: lifecycleNow,
    });
    const priorRoute = globalThis[routeLifecycleKey];
    let routeLifecycle = priorRoute;
    if (!routeLifecycle || routeLifecycle.documentId !== documentLifecycle.id || routeLifecycle.conversationId !== conversationId) {
      routeLifecycle = globalThis[routeLifecycleKey] = {
        documentId: documentLifecycle.id,
        conversationId,
        routeEpoch: Math.max(1, Number(priorRoute?.routeEpoch || 0) + 1),
        enteredAtMs: lifecycleNow,
        hydratedSinceMs: null,
        lastSeenAtMs: lifecycleNow,
      };
    }
    const radios = [...document.querySelectorAll('[role="radio"]')];
    const work = radios.find((el) => /^(工作|Work)$/i.test((el.innerText || el.textContent || '').trim()));
    const chat = radios.find((el) => /^(對話|Chat)$/i.test((el.innerText || el.textContent || '').trim()));
    const mode = work?.getAttribute('aria-checked') === 'true' || /[?&]surface=work(?:&|$)/i.test(location.search)
      ? 'work'
      : chat?.getAttribute('aria-checked') === 'true' ? 'chat' : 'chat';
    const modeled = [...document.querySelectorAll('[data-message-model-slug]')];
    const lastModeled = modeled.at(-1);
    const tokenText=(text)=>{text=String(text??'');if(!text)return 0;const cjk=(text.match(/[\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af]/gu)||[]).length;const emoji=(text.match(/\\p{Extended_Pictographic}/gu)||[]).length;const words=(text.match(/[A-Za-z0-9_]+(?:[-'][A-Za-z0-9_]+)*/g)||[]).length;const punct=(text.match(/[^\\sA-Za-z0-9_\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af]/gu)||[]).length;const ascii=(text.match(/[\\x00-\\x7f]/g)||[]).length;return Math.max(1,cjk+emoji*2+Math.max(words,Math.ceil(ascii/4))+Math.ceil(punct/2))};
    const visible=[...document.querySelectorAll('[data-message-author-role="user"],[data-message-author-role="assistant"]')];
    const domObservedTokens=visible.reduce((sum,el)=>sum+8+tokenText((el.innerText||el.textContent||'').trim()),0);
    const composer=document.querySelector('#prompt-textarea');
    const composerText=(composer?.innerText||composer?.textContent||'').replace(/\\u2060/g,'').trim();
    const composerReady=Boolean(composer);
    const routeHydrated=Boolean(conversationId && document.readyState === 'complete' && composerReady && visible.length > 0);
    routeLifecycle.hydratedSinceMs = routeHydrated ? (routeLifecycle.hydratedSinceMs || lifecycleNow) : null;
    routeLifecycle.lastSeenAtMs = lifecycleNow;
    const devspacePluginPaired=[...(composer?.querySelectorAll('[data-id^="plugin:"]')||[])].some((el)=>/DEV\\s*Space(?:[_\\s-]+Local[_\\s-]+Gateway)/i.test((el.innerText||el.textContent||'')));
    return {
      mode,
      conversationId,
      modelSlug: lastModeled?.getAttribute('data-message-model-slug') || null,
      generating: Boolean(document.querySelector('button[data-testid="stop-button"]')),
      composerTextChars: composerText.length,
      devspacePluginPaired,
      domObservedTokens,
      visibleMessageCount: visible.length,
      href: location.href,
      pageVisibilityState: document.visibilityState || null,
      documentReadyState: document.readyState || null,
      composerReady,
      documentId: documentLifecycle.id,
      routeEpoch: routeLifecycle.routeEpoch,
      routeEnteredAt: new Date(routeLifecycle.enteredAtMs).toISOString(),
      routeHydratedAt: routeLifecycle.hydratedSinceMs ? new Date(routeLifecycle.hydratedSinceMs).toISOString() : null,
      routeStableForMs: routeLifecycle.hydratedSinceMs ? Math.max(0, lifecycleNow - routeLifecycle.hydratedSinceMs) : 0,
      routeHydrated,
    };
  })()`;
}

function recentVisibleMessagesExpression(limit = 8) {
  const bounded = Math.max(1, Math.min(20, Number(limit) || 8));
  return `(() => [...document.querySelectorAll('[data-message-author-role="user"],[data-message-author-role="assistant"]')]
    .map((el)=>({role:el.getAttribute('data-message-author-role'),text:(el.innerText||el.textContent||'').trim()}))
    .filter((row)=>row.text)
    .slice(-${bounded})
    .map((row)=>({role:row.role,text:row.text.slice(0,2400)})))()`;
}

function freshSurfaceForHref(href) {
  try {
    const url = new URL(String(href || ""));
    const project = url.pathname.match(/^\/g\/(g-p-[^/]+)(?:\/c\/[^/?#]+)?/);
    if (url.protocol === "https:" && url.hostname === "chatgpt.com" && project) return `https://chatgpt.com/g/${project[1]}?window_style=main_view`;
  } catch {}
  return "https://chatgpt.com/?window_style=main_view";
}

async function waitForCondition(fn, { timeoutMs = 10_000, pollMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await fn();
    if (value) return value;
    await sleep(pollMs);
  }
  return null;
}

async function pairDevspacePlugin(client) {
  const boxReady = await waitForCondition(async () => await evaluate(client, `Boolean(document.querySelector('#prompt-textarea'))`));
  if (!boxReady) throw new Error("Fresh Chat composer did not appear for DevSpace rollover.");
  const typed = await evaluate(client, `(() => { const box=document.querySelector('#prompt-textarea'); if(!box)return false; box.focus(); const sel=getSelection(); sel.selectAllChildren(box); sel.deleteFromDocument(); document.execCommand('insertText',false,'@${DEVSPACE_CONNECTOR_NAME}'); box.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'@${DEVSPACE_CONNECTOR_NAME}'})); return true; })()`);
  if (!typed) throw new Error("Could not open the DEV Space Local Gateway Chat plugin picker.");
  const selected = await waitForCondition(async () => await evaluate(client, `(() => { const wrappers=[...document.querySelectorAll('[data-composer-plugin-impression-id]')]; const wrapper=wrappers.find((el)=>{const t=(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim();return t.startsWith('${DEVSPACE_CONNECTOR_NAME}')}); const row=wrapper?.querySelector('[tabindex="0"]'); if(!row)return false; row.click(); return true; })()`), { timeoutMs: 7_000, pollMs: 200 });
  if (!selected) throw new Error("DEV Space Local Gateway was not available in the Chat plugin picker.");
  await sleep(300);
  return true;
}

async function evaluate(client, expression) {
  const result = await client.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Context Guardian CDP evaluate failed.");
  return result.result?.value;
}

function emit(handler, event) {
  if (typeof handler !== "function") return;
  void Promise.resolve(handler(event)).catch(() => {});
}

export async function connectClassicContextMetadataPort(port, {
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  onCatalog,
  onTurnRequest,
  onConversationIdentity,
  onUsageEvidence,
  onTurnTransportEvent,
  onSnapshot,
  onUserTurnRollover,
  onDisconnected,
} = {}) {
  let targets;
  try {
    targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, { fetchImpl, timeoutMs: probeTimeoutMs });
  } catch { return null; }
  if (!Array.isArray(targets)) return null;
  const page = targets.find((target) => target?.type === "page" && /chatgpt\.com/i.test(target.url || "") && typeof target.webSocketDebuggerUrl === "string");
  if (!page) return null;

  const runtimeKey = runtimeKeyForPort(port);
  const connectedAt = observedAt();
  let lastTurnRequestObservedAt = null;
  const client = new ClassicCdpClient(page.webSocketDebuggerUrl, { WebSocketImpl });
  await client.open();
  await client.call("Runtime.enable");
  await client.call("Network.enable", { maxTotalBufferSize: 20_000_000, maxResourceBufferSize: 10_000_000, enableDurableMessages: true });

  const modelResponses = new Set();
  const turnIdentityCorrelator = new ClassicTurnIdentityCorrelator();
  const turnUsageRequests = new Map();
  const TURN_USAGE_TTL_MS = 2 * 60_000;
  const TURN_USAGE_MAX_PENDING = 64;
  const TURN_USAGE_MAX_BODY_BYTES = 16 * 1024 * 1024;
  const pruneTurnUsageRequests = () => {
    const cutoff = Date.now() - TURN_USAGE_TTL_MS;
    for (const [requestId, entry] of turnUsageRequests) {
      if (Number(entry?.firstSeenAt || 0) < cutoff) turnUsageRequests.delete(requestId);
    }
    if (turnUsageRequests.size <= TURN_USAGE_MAX_PENDING) return;
    const oldest = [...turnUsageRequests.entries()].sort((a, b) => Number(a[1]?.firstSeenAt || 0) - Number(b[1]?.firstSeenAt || 0));
    for (const [requestId] of oldest) {
      if (turnUsageRequests.size <= TURN_USAGE_MAX_PENDING) break;
      turnUsageRequests.delete(requestId);
    }
  };
  const emitConversationIdentity = (identity) => {
    if (!identity) return;
    emit(onConversationIdentity, { runtimeKey, port, ...identity, observedAt: observedAt() });
  };
  let nativeBaseline = null;
  let userTurnRolloverArm = null;
  let userTurnPausedHandler = null;
  let userTurnFetchEnabled = false;
  const rolloverTransactions = new Map();
  const adoptNativeDescriptor = async (conversationId, descriptor, inspected = null) => {
    const current = inspected || await evaluate(client, inspectExpression());
    const observedTokens = Math.max(0, Number(descriptor?.estimatedTokens || 0));
    const messageCount = Math.max(0, Number(descriptor?.branchMessageCount || 0));
    nativeBaseline = {
      conversationId,
      observedTokens,
      domObservedTokens: Number(current?.domObservedTokens || 0),
      messageCount,
      recentVisibleMessages: Array.isArray(descriptor?.recentVisibleMessages)
        ? descriptor.recentVisibleMessages.slice(-12)
        : [],
      capturedAt: observedAt(),
    };
    const snapshot = {
      runtimeKey,
      port,
      ok: true,
      ...current,
      conversationId,
      observedTokens,
      messageCount,
      nativeSnapshot: true,
      observedAt: nativeBaseline.capturedAt,
    };
    emit(onSnapshot, snapshot);
    return snapshot;
  };

  const loadNativeConversationDescriptor = async (conversationId, { force = false } = {}) => {
    const id = String(conversationId || "").trim();
    return await sharedNativeConversationDescriptorCoordinator.load(id, {
      force,
      fetchDescriptor: async () => {
        const descriptor = await evaluate(client, nativeConversationDescriptorExpression(id));
        if (descriptor?.ok === false) {
          const error = new Error(`Native conversation descriptor HTTP ${descriptor.status || "unavailable"}`);
          error.code = descriptor.errorCode || "NATIVE_DESCRIPTOR_HTTP";
          error.status = descriptor.status;
          error.retryAfter = descriptor.retryAfter;
          throw error;
        }
        if (!descriptor || descriptor.conversationId !== id || !descriptor.currentNode) {
          throw new Error("Native conversation descriptor did not return the requested conversation boundary.");
        }
        return descriptor;
      },
    });
  };

  const clearUserTurnRolloverArm = async ({ disableFetch = true } = {}) => {
    userTurnRolloverArm = null;
    try { userTurnPausedHandler?.(); } catch {}
    userTurnPausedHandler = null;
    if (disableFetch && userTurnFetchEnabled) {
      userTurnFetchEnabled = false;
      await client.call("Fetch.disable").catch(() => {});
    }
  };

  const rolloverEventBase = (arm, oldConversationId, rolloverMode) => ({
    mode: rolloverMode,
    runtimeKey,
    port,
    goalId: arm?.goalId || null,
    planId: arm?.planId || null,
    oldConversationId,
    sourceMessageId: arm?.sourceMessageId || null,
    uiContinuityKey: arm?.uiContinuityKey || null,
    capsuleFingerprint: arm?.capsuleFingerprint || null,
    capsuleId: arm?.capsuleId || null,
    sourceDescriptor: arm?.sourceDescriptor || null,
    compressionContract: arm?.compressionContract || null,
  });

  const verifyUserTurnRollover = async ({ arm, outcome }) => {
    const oldConversationId = String(outcome?.oldConversationId || arm?.oldConversationId || "").trim();
    const rolloverMode = arm?.mode === "hidden-goal-continuation" ? "hidden-goal-continuation" : "user-turn";
    try {
      const stable = await waitForCondition(async () => {
        const state = await evaluate(client, inspectExpression());
        if (state?.mode === "work") throw new Error("Auto Compact continuation unexpectedly entered Work mode.");
        return state?.conversationId
          && state.conversationId !== oldConversationId
          && state.generating === false
          && Number(state.composerTextChars || 0) === 0
          ? state
          : null;
      }, { timeoutMs: Math.max(30_000, Number(arm?.verifyTimeoutMs) || DEFAULT_ROLLOVER_TIMEOUT_MS), pollMs: 300 });
      if (!stable?.conversationId) throw new Error("Auto Compact continuation did not reach a stable target conversation.");
      const targetDescriptor = await loadNativeConversationDescriptor(stable.conversationId, { force: true });
      if (targetDescriptor?.conversationId !== stable.conversationId) {
        throw new Error("Auto Compact target descriptor does not match the stable continuation conversation.");
      }
      const expectedVisibleUsers = rolloverMode === "user-turn" ? Math.max(1, Number(outcome?.visibleUserMessages || 1)) : 0;
      if (targetDescriptor.visibleUsers < expectedVisibleUsers || targetDescriptor.visibleAssistants < 1 || targetDescriptor.hiddenMessages < 1) {
        throw new Error(`Auto Compact continuation verification failed: ${JSON.stringify({ mode: rolloverMode, visibleUsers: targetDescriptor.visibleUsers, visibleAssistants: targetDescriptor.visibleAssistants, hiddenMessages: targetDescriptor.hiddenMessages, expectedVisibleUsers })}`);
      }
      if (targetDescriptor.devspaceContinuity?.sourceConversationId !== oldConversationId) {
        throw new Error("Auto Compact target did not retain the hidden source-conversation marker.");
      }
      if (arm?.uiContinuityKey && targetDescriptor.devspaceContinuity?.uiContinuityKey !== arm.uiContinuityKey) {
        throw new Error("Auto Compact target did not retain the UI continuity key.");
      }
      if (arm?.capsuleFingerprint && targetDescriptor.devspaceContinuity?.capsuleFingerprint !== arm.capsuleFingerprint) {
        throw new Error("Auto Compact target did not retain the capsule fingerprint.");
      }
      const after = await evaluate(client, inspectExpression());
      const snapshot = await adoptNativeDescriptor(stable.conversationId, targetDescriptor, after);
      emit(onUserTurnRollover, {
        ok: true,
        ...rolloverEventBase(arm, oldConversationId, rolloverMode),
        newConversationId: stable.conversationId,
        conversationId: stable.conversationId,
        visibleUsers: targetDescriptor.visibleUsers,
        visibleAssistants: targetDescriptor.visibleAssistants,
        hiddenMessages: targetDescriptor.hiddenMessages,
        observedTokens: snapshot?.observedTokens ?? null,
        targetDescriptor,
        nativeContinuationSourceId: targetDescriptor.contextTruncationContinuation?.sourceConversationId || null,
        devspaceContinuationSourceId: targetDescriptor.devspaceContinuity?.sourceConversationId || null,
        sourceConversationPreserved: true,
        observedAt: observedAt(),
      });
    } catch (error) {
      let current = null;
      try { current = await evaluate(client, inspectExpression()); } catch {}
      emit(onUserTurnRollover, {
        ok: false,
        ...rolloverEventBase(arm, oldConversationId, rolloverMode),
        errorCode: error?.code || null,
        httpStatus: Number.isFinite(Number(error?.status)) ? Number(error.status) : null,
        retryAfter: error?.retryAfter || null,
        error: error instanceof Error ? error.message : String(error),
        currentConversationId: current?.conversationId || null,
        sourceConversationCurrent: current?.conversationId === oldConversationId,
        sourceConversationPreserved: true,
        authorityMigrationCommitted: false,
        observedAt: observedAt(),
      });
    }
  };

  const clearRolloverTransaction = (transactionId) => {
    const id = String(transactionId || "").trim();
    const transaction = id ? rolloverTransactions.get(id) : null;
    if (transaction?.timer) clearTimeout(transaction.timer);
    if (id) rolloverTransactions.delete(id);
    return transaction;
  };

  const emitRolloverTransportFailure = async (transaction, {
    errorCode = "AUTO_COMPACT_TRANSPORT_FAILURE",
    httpStatus = null,
    retryAfter = null,
    error = "Auto Compact continuation transport failed.",
  } = {}) => {
    const arm = transaction?.arm || {};
    const oldConversationId = String(arm.oldConversationId || "").trim();
    const rolloverMode = arm.mode === "hidden-goal-continuation" ? "hidden-goal-continuation" : "user-turn";
    let current = null;
    try { current = await evaluate(client, inspectExpression()); } catch {}
    emit(onUserTurnRollover, {
      ok: false,
      ...rolloverEventBase(arm, oldConversationId, rolloverMode),
      errorCode,
      httpStatus: Number.isFinite(Number(httpStatus)) ? Number(httpStatus) : null,
      retryAfter: retryAfter || null,
      error: String(error || "Auto Compact continuation transport failed."),
      currentConversationId: current?.conversationId || null,
      sourceConversationCurrent: current?.conversationId === oldConversationId,
      sourceConversationPreserved: true,
      authorityMigrationCommitted: false,
      observedAt: observedAt(),
    });
  };

  const processRolloverTransaction = (transactionId) => {
    const id = String(transactionId || "").trim();
    const transaction = id ? rolloverTransactions.get(id) : null;
    if (!transaction || !transaction.outcome || !transaction.response || transaction.settled) return false;
    transaction.settled = true;
    const status = Number(transaction.response.status || 0);
    if (status < 200 || status >= 300) {
      clearRolloverTransaction(id);
      void emitRolloverTransportFailure(transaction, {
        errorCode: status === 429 ? "AUTO_COMPACT_HTTP_429" : "AUTO_COMPACT_HTTP_ERROR",
        httpStatus: status || null,
        retryAfter: transaction.response.retryAfter || null,
        error: `Auto Compact continuation HTTP ${status || "error"}; source conversation retained and compact cancelled.`,
      });
      return true;
    }
    if (transaction.timer) clearTimeout(transaction.timer);
    transaction.timer = null;
    void verifyUserTurnRollover({ arm: transaction.arm, outcome: transaction.outcome })
      .finally(() => clearRolloverTransaction(id));
    return true;
  };

  const registerRolloverTransaction = (transactionId, arm) => {
    const id = String(transactionId || "").trim();
    if (!id) return null;
    while (rolloverTransactions.size >= ROLLOVER_MAX_TRANSACTIONS) {
      const oldest = [...rolloverTransactions.entries()]
        .sort((left, right) => Number(left[1]?.createdAtMs || 0) - Number(right[1]?.createdAtMs || 0))[0];
      if (!oldest) break;
      const evicted = clearRolloverTransaction(oldest[0]);
      if (evicted) void emitRolloverTransportFailure(evicted, {
        errorCode: "AUTO_COMPACT_TRANSACTION_EVICTED",
        error: "Auto Compact transaction bound exceeded; source conversation retained.",
      });
    }
    const transaction = {
      id,
      arm: { ...arm },
      outcome: null,
      response: null,
      settled: false,
      createdAtMs: Date.now(),
      timer: null,
    };
    transaction.timer = setTimeout(() => {
      const expired = clearRolloverTransaction(id);
      if (expired) void emitRolloverTransportFailure(expired, {
        errorCode: "AUTO_COMPACT_RESPONSE_TIMEOUT",
        error: "Auto Compact continuation response timed out; source conversation retained and automatic retry suppressed.",
      });
    }, ROLLOVER_RESPONSE_TIMEOUT_MS);
    transaction.timer.unref?.();
    rolloverTransactions.set(id, transaction);
    return transaction;
  };

  const armUserTurnRollover = async ({
    capsulePrompt,
    oldConversationId,
    goalId = null,
    planId = null,
    mode = "user-turn",
    sourceMessageId = null,
    uiContinuityKey = null,
    capsuleFingerprint = null,
    sourceDescriptor = null,
    compressionContract = null,
    capsuleId = null,
    ttlMs = 60_000,
    verifyTimeoutMs = DEFAULT_ROLLOVER_TIMEOUT_MS,
  } = {}) => {
    const prompt = String(capsulePrompt ?? "").trim();
    const oldId = String(oldConversationId ?? "").trim();
    const rolloverMode = mode === "hidden-goal-continuation" ? "hidden-goal-continuation" : "user-turn";
    if (!prompt || !oldId || !sourceMessageId || !uiContinuityKey || !capsuleFingerprint) return { armed: false, reason: "missing-input" };
    const current = await evaluate(client, inspectExpression());
    if (current?.mode === "work") return { armed: false, reason: "work-mode" };
    if (current?.generating) return { armed: false, reason: "generating" };
    if (current?.conversationId !== oldId) return { armed: false, reason: "conversation-changed" };
    if (current?.devspacePluginPaired !== true) return { armed: false, reason: "devspace-plugin-not-paired" };
    const expiresAt = Date.now() + Math.max(5_000, Math.min(300_000, Number(ttlMs) || 60_000));
    if (userTurnRolloverArm?.oldConversationId === oldId && userTurnRolloverArm?.mode === rolloverMode) {
      userTurnRolloverArm = { ...userTurnRolloverArm, capsulePrompt: prompt, goalId, planId, sourceMessageId, uiContinuityKey, capsuleFingerprint, sourceDescriptor, compressionContract, capsuleId, expiresAt, verifyTimeoutMs };
      return { armed: true, reused: true, mode: rolloverMode, oldConversationId: oldId };
    }
    await clearUserTurnRolloverArm();
    await client.call("Fetch.enable", {
      patterns: [{ urlPattern: "*backend-api/f/conversation*", requestStage: "Request" }],
    });
    userTurnFetchEnabled = true;
    userTurnRolloverArm = { capsulePrompt: prompt, oldConversationId: oldId, goalId, planId, mode: rolloverMode, sourceMessageId, uiContinuityKey, capsuleFingerprint, sourceDescriptor, compressionContract, capsuleId, expiresAt, verifyTimeoutMs, consuming: false };
    userTurnPausedHandler = client.on("Fetch.requestPaused", (params) => {
      void (async () => {
        const arm = userTurnRolloverArm;
        const requestId = params?.requestId;
        if (!requestId) return;
        if (!arm || Date.now() > arm.expiresAt) {
          await client.call("Fetch.continueRequest", { requestId }).catch(() => {});
          await clearUserTurnRolloverArm();
          return;
        }
        if (arm.consuming) {
          await client.call("Fetch.continueRequest", { requestId }).catch(() => {});
          return;
        }
        let requestBody = null;
        let requestConversationId = null;
        let visibleUserMessages = 0;
        try {
          requestBody = JSON.parse(String(params?.request?.postData || "{}"));
          requestConversationId = typeof requestBody?.conversation_id === "string" ? requestBody.conversation_id.trim() : null;
          visibleUserMessages = Array.isArray(requestBody?.messages)
            ? requestBody.messages.filter((message) => message?.author?.role === "user" && message?.metadata?.is_visually_hidden_from_conversation !== true).length
            : 0;
        } catch {}
        if (requestConversationId !== arm.oldConversationId) {
          await client.call("Fetch.continueRequest", { requestId }).catch(() => {});
          return;
        }
        if (arm.mode === "hidden-goal-continuation" && visibleUserMessages > 0) {
          await client.call("Fetch.continueRequest", { requestId }).catch(() => {});
          await clearUserTurnRolloverArm();
          emit(onUserTurnRollover, {
            ok: false,
            ...rolloverEventBase(arm, arm.oldConversationId, arm.mode),
            errorCode: "AUTO_COMPACT_SUPERSEDED_BY_USER_TURN",
            error: "A real user turn arrived before the hidden Goal continuation; the user request continued unchanged in the source conversation.",
            sourceConversationCurrent: true,
            sourceConversationPreserved: true,
            authorityMigrationCommitted: false,
            observedAt: observedAt(),
          });
          return;
        }
        arm.consuming = true;
        const consumedArm = { ...arm };
        const transactionId = String(params?.networkId || requestId).trim();
        const transaction = registerRolloverTransaction(transactionId, consumedArm);
        const common = {
          attribution: "devspace-ultra",
          toolName: "devspace_context_guardian",
          sourceConversationId: arm.oldConversationId,
          sourceMessageId: arm.sourceMessageId,
          uiContinuityKey: arm.uiContinuityKey,
          capsuleFingerprint: arm.capsuleFingerprint,
        };
        const outcome = consumedArm.mode === "hidden-goal-continuation"
          ? await rewriteHiddenRolloverPausedRequest(client, params, { prompt: consumedArm.capsulePrompt, ...common })
          : await rewriteUserTurnRolloverPausedRequest(client, params, { capsulePrompt: consumedArm.capsulePrompt, ...common });
        if (!outcome.handled) {
          clearRolloverTransaction(transactionId);
          arm.consuming = false;
          await client.call("Fetch.continueRequest", { requestId }).catch(() => {});
          return;
        }
        await clearUserTurnRolloverArm();
        if (!outcome.modified) {
          clearRolloverTransaction(transactionId);
          emit(onUserTurnRollover, {
            ok: false,
            ...rolloverEventBase(consumedArm, consumedArm.oldConversationId, consumedArm.mode),
            errorCode: "AUTO_COMPACT_REWRITE_BYPASSED",
            error: outcome.error || "Auto Compact request rewrite was bypassed; original request continued unchanged.",
            sourceConversationCurrent: true,
            sourceConversationPreserved: outcome.sourceConversationPreserved === true,
            originalRequestContinued: outcome.originalRequestContinued === true,
            authorityMigrationCommitted: false,
            observedAt: observedAt(),
          });
          return;
        }
        if (!transaction) {
          emit(onUserTurnRollover, {
            ok: false,
            ...rolloverEventBase(consumedArm, consumedArm.oldConversationId, consumedArm.mode),
            errorCode: "AUTO_COMPACT_TRANSACTION_UNAVAILABLE",
            error: "Auto Compact transaction tracking was unavailable; authority migration remains blocked.",
            sourceConversationPreserved: true,
            authorityMigrationCommitted: false,
            observedAt: observedAt(),
          });
          return;
        }
        transaction.outcome = {
          ...outcome,
          oldConversationId: consumedArm.oldConversationId,
          visibleUserMessages,
        };
        processRolloverTransaction(transactionId);
      })().catch(async (error) => {
        const requestId = params?.requestId;
        const transactionId = String(params?.networkId || requestId || "").trim();
        const transaction = clearRolloverTransaction(transactionId);
        const arm = transaction?.arm || userTurnRolloverArm || {};
        const originalRequestContinued = requestId
          ? await client.call("Fetch.continueRequest", { requestId }).then(() => true).catch(() => false)
          : false;
        await clearUserTurnRolloverArm();
        emit(onUserTurnRollover, {
          ok: false,
          ...rolloverEventBase(arm, arm?.oldConversationId || "", arm?.mode || "user-turn"),
          errorCode: "AUTO_COMPACT_HANDLER_ERROR",
          error: error instanceof Error ? error.message : String(error),
          originalRequestContinued,
          sourceConversationCurrent: originalRequestContinued,
          sourceConversationPreserved: originalRequestContinued,
          authorityMigrationCommitted: false,
          observedAt: observedAt(),
        });
      });
    });
    return { armed: true, reused: false, mode: rolloverMode, oldConversationId: oldId };
  };

  const disposers = [];
  disposers.push(client.on("Network.requestWillBeSent", (params) => {
    const metadata = parseClassicTurnRequest(params?.request);
    if (!metadata) return;
    const at = observedAt();
    lastTurnRequestObservedAt = at;
    const requestId = String(params?.requestId || "").trim();
    if (requestId && metadata.conversationId) {
      pruneTurnUsageRequests();
      turnUsageRequests.set(requestId, {
        conversationId: metadata.conversationId,
        requestHeaders: params?.request?.headers || {},
        responseHeaders: {},
        firstSeenAt: Date.now(),
      });
      pruneTurnUsageRequests();
      emit(onTurnTransportEvent, {
        runtimeKey,
        port,
        conversationId: metadata.conversationId,
        kind: "request",
        observedAt: at,
      });
    }
    emit(onTurnRequest, { runtimeKey, port, ...metadata, observedAt: at });
    emitConversationIdentity(turnIdentityCorrelator.noteRequest(params));
  }));
  disposers.push(client.on("Network.requestWillBeSentExtraInfo", (params) => {
    const requestId = String(params?.requestId || "").trim();
    const pendingUsage = requestId ? turnUsageRequests.get(requestId) : null;
    if (pendingUsage) pendingUsage.requestHeaders = params?.headers || pendingUsage.requestHeaders || {};
    emitConversationIdentity(turnIdentityCorrelator.noteExtraInfo(params));
  }));
  disposers.push(client.on("Network.responseReceived", (params) => {
    const requestId = String(params?.requestId || "").trim();
    const turnResponse = isTurnUrl(params?.response?.url);
    const responseHeaders = params?.response?.headers || {};
    const retryAfter = Object.entries(responseHeaders)
      .find(([name]) => String(name).toLowerCase() === "retry-after")?.[1] || null;
    const transaction = requestId ? rolloverTransactions.get(requestId) : null;
    if (transaction && turnResponse) {
      transaction.response = {
        status: Number(params?.response?.status || 0) || null,
        retryAfter: retryAfter == null ? null : String(retryAfter),
        observedAt: observedAt(),
      };
      processRolloverTransaction(requestId);
    }
    const pendingUsage = requestId ? turnUsageRequests.get(requestId) : null;
    if (pendingUsage && turnResponse) {
      pendingUsage.responseHeaders = responseHeaders || pendingUsage.responseHeaders || {};
      emit(onTurnTransportEvent, {
        runtimeKey,
        port,
        conversationId: pendingUsage.conversationId,
        kind: "response",
        status: Number(params?.response?.status || 0) || null,
        observedAt: observedAt(),
      });
    }
    if (requestId && params?.response?.status === 200 && isNativeModelsUrl(params?.response?.url)) {
      modelResponses.add(requestId);
    }
  }));
  disposers.push(client.on("Network.responseReceivedExtraInfo", (params) => {
    const requestId = String(params?.requestId || "").trim();
    const headers = params?.headers || {};
    const retryAfter = Object.entries(headers)
      .find(([name]) => String(name).toLowerCase() === "retry-after")?.[1] || null;
    const transaction = requestId ? rolloverTransactions.get(requestId) : null;
    if (transaction) {
      if (!transaction.response && Number(params?.statusCode || 0) > 0) {
        transaction.response = {
          status: Number(params.statusCode),
          retryAfter: retryAfter == null ? null : String(retryAfter),
          observedAt: observedAt(),
        };
      } else if (transaction.response && retryAfter != null) {
        transaction.response.retryAfter = String(retryAfter);
      }
      processRolloverTransaction(requestId);
    }
    const pendingUsage = requestId ? turnUsageRequests.get(requestId) : null;
    if (pendingUsage) pendingUsage.responseHeaders = headers || pendingUsage.responseHeaders || {};
  }));
  disposers.push(client.on("Network.loadingFailed", (params) => {
    if (params?.requestId) {
      const requestId = String(params.requestId);
      const transaction = clearRolloverTransaction(requestId);
      if (transaction) {
        void emitRolloverTransportFailure(transaction, {
          errorCode: "AUTO_COMPACT_NETWORK_FAILURE",
          error: String(params?.errorText || params?.blockedReason || "Auto Compact continuation network request failed."),
        });
      }
      const pendingUsage = turnUsageRequests.get(requestId);
      if (pendingUsage?.conversationId) {
        emit(onTurnTransportEvent, {
          runtimeKey,
          port,
          conversationId: pendingUsage.conversationId,
          kind: "failed",
          errorText: String(params?.errorText || ""),
          canceled: params?.canceled === true,
          blockedReason: params?.blockedReason || null,
          observedAt: observedAt(),
        });
      }
      modelResponses.delete(requestId);
      turnUsageRequests.delete(requestId);
      turnIdentityCorrelator.forget(requestId);
    }
  }));
  disposers.push(client.on("Network.loadingFinished", (params) => {
    const requestId = String(params?.requestId || "").trim();
    const transaction = requestId ? rolloverTransactions.get(requestId) : null;
    if (transaction && !transaction.response && !transaction.settled) {
      clearRolloverTransaction(requestId);
      void emitRolloverTransportFailure(transaction, {
        errorCode: "AUTO_COMPACT_RESPONSE_MISSING",
        error: "Auto Compact continuation finished without an observable HTTP response; source conversation retained.",
      });
    }
    if (requestId) turnIdentityCorrelator.forget(requestId);
    const usageRequest = requestId ? turnUsageRequests.get(requestId) : null;
    if (usageRequest) {
      emit(onTurnTransportEvent, {
        runtimeKey,
        port,
        conversationId: usageRequest.conversationId,
        kind: "finished",
        observedAt: observedAt(),
      });
      turnUsageRequests.delete(requestId);
      void (async () => {
        let responseBody = "";
        if (Number(params?.encodedDataLength || 0) <= TURN_USAGE_MAX_BODY_BYTES) {
          try {
            const body = await client.call("Network.getResponseBody", { requestId });
            responseBody = body?.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : String(body?.body || "");
          } catch {}
        }
        const evidence = extractClassicNativeUsageEvidence({
          conversationId: usageRequest.conversationId,
          requestHeaders: usageRequest.requestHeaders,
          responseHeaders: usageRequest.responseHeaders,
          responseBody,
          observedAt: observedAt(),
        });
        emit(onUsageEvidence, { runtimeKey, port, ...evidence });
      })().catch(() => {});
    }
    if (!requestId || !modelResponses.delete(requestId)) return;
    void (async () => {
      const body = await client.call("Network.getResponseBody", { requestId });
      const text = body?.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : String(body?.body || "");
      const models = parseNativeClassicModelResponse(text);
      if (models.length) emit(onCatalog, { runtimeKey, port, models, observedAt: observedAt() });
    })().catch(() => {});
  }));

  let initial = null;
  try { initial = await evaluate(client, inspectExpression()); } catch {}
  if (initial) emit(onSnapshot, { runtimeKey, port, ...initial, observedAt: observedAt() });

  const closeListener = () => { try { onDisconnected?.({ runtimeKey, port }); } catch {} };
  client.ws.addEventListener?.("close", closeListener, { once: true });

  return {
    runtimeKey,
    port,
    async inspect() { return await evaluate(client, inspectExpression()); },
    async evaluateExpression(expression) {
      const text = String(expression ?? "").trim();
      if (!text) throw new Error("Context Guardian runtime evaluation requires an expression.");
      return await evaluate(client, text);
    },
    async nativeConversationDescriptor({ force = false } = {}) {
      const descriptor = await readStableClassicDescriptor({
        inspectSource: () => evaluate(client, inspectExpression()),
        fetchDescriptor: (conversationId) => loadNativeConversationDescriptor(conversationId, { force }),
      });
      return { runtimeKey, port, ...descriptor, observedAt: observedAt() };
    },
    async refreshSnapshot() {
      const current = await evaluate(client, inspectExpression());
      if (userTurnRolloverArm && (
        current?.mode === "work"
        || (current?.conversationId && current.conversationId !== userTurnRolloverArm.oldConversationId)
      )) {
        await clearUserTurnRolloverArm();
      }
      const sameNative = Boolean(current?.conversationId && nativeBaseline?.conversationId === current.conversationId);
      const domDelta = sameNative
        ? Math.max(0, Number(current?.domObservedTokens || 0) - Number(nativeBaseline?.domObservedTokens || 0))
        : 0;
      const observedTokens = sameNative
        ? Number(nativeBaseline.observedTokens || 0) + domDelta
        : undefined;
      const snapshot = {
        runtimeKey,
        port,
        ok: Boolean(current?.conversationId),
        ...current,
        ...(Number.isFinite(observedTokens) ? { observedTokens } : {}),
        messageCount: sameNative ? nativeBaseline.messageCount : current?.visibleMessageCount ?? 0,
        nativeSnapshot: sameNative,
      };
      emit(onSnapshot, { ...snapshot, observedAt: observedAt() });
      return snapshot;
    },
    async captureNativeSnapshot() {
      throw new Error("Context Guardian native snapshot reload is forbidden; wait for passively observed Classic-native metadata.");
    },
    async armUserTurnRollover(input) {
      return await armUserTurnRollover({ ...input, mode: input?.mode || "user-turn" });
    },
    async cancelUserTurnRollover() {
      const wasArmed = Boolean(userTurnRolloverArm);
      await clearUserTurnRolloverArm();
      return { cancelled: wasArmed };
    },
    get userTurnRolloverArmed() { return Boolean(userTurnRolloverArm); },
    async recentVisibleMessages({ limit = 8 } = {}) {
      const current = await evaluate(client, inspectExpression());
      if (current?.conversationId && nativeBaseline?.conversationId === current.conversationId && nativeBaseline.recentVisibleMessages?.length) {
        return nativeBaseline.recentVisibleMessages.slice(-Math.max(1, Math.min(20, Number(limit) || 8)));
      }
      const rows = await evaluate(client, recentVisibleMessagesExpression(limit));
      return Array.isArray(rows) ? rows : [];
    },
    async startHiddenRollover(input) {
      return await armUserTurnRollover({ ...input, capsulePrompt: input?.prompt || input?.capsulePrompt, mode: "hidden-goal-continuation" });
    },
    get connectedAt() { return connectedAt; },
    get lastTurnRequestObservedAt() { return lastTurnRequestObservedAt; },
    get pendingCdpCalls() { return client.pendingSize; },
    get pendingUsageRequests() { return turnUsageRequests.size; },
    get pendingIdentityCorrelations() { return turnIdentityCorrelator.pendingSize; },
    get pendingRolloverTransactions() { return rolloverTransactions.size; },
    async close() {
      await clearUserTurnRolloverArm();
      for (const transactionId of [...rolloverTransactions.keys()]) clearRolloverTransaction(transactionId);
      for (const dispose of disposers) dispose();
      client.close();
      await sleep(0);
    },
  };
}

export class ClassicContextMetadataCdpAdapter {
  constructor({
    ports = defaultMainDebugPorts(),
    connectPort,
    connectionPollMs = DEFAULT_CONNECTION_POLL_MS,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  } = {}) {
    this.ports = [...ports];
    this.connectionPollMs = connectionPollMs;
    this.options = { fetchImpl, WebSocketImpl, probeTimeoutMs };
    this.connectPort = connectPort || ((port, handlers) => connectClassicContextMetadataPort(port, { ...this.options, ...handlers }));
    this.sessions = new Map();
    this.handlers = {};
    this.timer = null;
    this.polling = null;
    this.closed = false;
  }

  setHandlers({ onCatalog, onTurnRequest, onConversationIdentity, onUsageEvidence, onTurnTransportEvent, onSnapshot, onUserTurnRollover } = {}) {
    this.handlers = { onCatalog, onTurnRequest, onConversationIdentity, onUsageEvidence, onTurnTransportEvent, onSnapshot, onUserTurnRollover };
  }

  async start({ schedule = true } = {}) {
    await this.pollConnections();
    if (schedule && !this.closed && this.connectionPollMs > 0 && !this.timer) {
      this.timer = setInterval(() => { void this.pollConnections(); }, this.connectionPollMs);
      this.timer.unref?.();
    }
    return this.status();
  }

  async pollConnections() {
    if (this.closed) return this.status();
    if (this.polling) return this.polling;
    this.polling = this.#pollConnectionsImpl().finally(() => { this.polling = null; });
    return this.polling;
  }

  async #pollConnectionsImpl() {
    for (const port of this.ports) {
      const runtimeKey = runtimeKeyForPort(port);
      if (this.sessions.has(runtimeKey)) continue;
      let session = null;
      try {
        session = await this.connectPort(port, {
          ...this.handlers,
          onDisconnected: ({ runtimeKey: disconnectedKey }) => {
            const current = this.sessions.get(disconnectedKey);
            if (current === session) this.sessions.delete(disconnectedKey);
          },
        });
      } catch { session = null; }
      if (session?.runtimeKey) this.sessions.set(session.runtimeKey, session);
    }
    return this.status();
  }

  #session(runtimeKey) {
    const session = this.sessions.get(runtimeKey);
    if (!session) throw new Error(`Context Guardian runtime ${runtimeKey} is not connected.`);
    return session;
  }

  async refreshSnapshot(runtimeKey) {
    return await this.#session(runtimeKey).refreshSnapshot();
  }

  async nativeConversationDescriptor(runtimeKey, options = {}) {
    return await this.#session(runtimeKey).nativeConversationDescriptor(options);
  }

  async evaluateRuntime(runtimeKey, expression) {
    return await this.#session(runtimeKey).evaluateExpression(expression);
  }

  async captureNativeSnapshot(runtimeKey) {
    return await this.#session(runtimeKey).captureNativeSnapshot();
  }

  async recentVisibleMessages(runtimeKey, options = {}) {
    return await this.#session(runtimeKey).recentVisibleMessages(options);
  }

  async armUserTurnRollover(runtimeKey, input) {
    return await this.#session(runtimeKey).armUserTurnRollover(input);
  }

  async cancelUserTurnRollover(runtimeKey) {
    return await this.#session(runtimeKey).cancelUserTurnRollover();
  }

  async startHiddenRollover(runtimeKey, input) {
    return await this.#session(runtimeKey).startHiddenRollover(input);
  }

  status() {
    return {
      connected: this.sessions.size,
      runtimes: [...this.sessions.values()].map((session) => ({
        runtimeKey: session.runtimeKey,
        port: session.port,
        connectedAt: session.connectedAt ?? null,
        lastTurnRequestObservedAt: session.lastTurnRequestObservedAt ?? null,
        userTurnRolloverArmed: session.userTurnRolloverArmed === true,
        pendingCdpCalls: Number(session.pendingCdpCalls || 0),
        pendingUsageRequests: Number(session.pendingUsageRequests || 0),
        pendingIdentityCorrelations: Number(session.pendingIdentityCorrelations || 0),
        pendingRolloverTransactions: Number(session.pendingRolloverTransactions || 0),
      })),
    };
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.polling) await this.polling.catch(() => {});
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.close?.()));
  }
}
