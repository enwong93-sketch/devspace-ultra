import { createHash } from "node:crypto";
import { fingerprintMcpToolCall } from "./classic-mcp-call-correlation.js";

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_SEEN = 1_024;
const MAX_JSON_DEPTH = 14;

function cleanText(value, max = 512) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function cleanConversationId(value) {
  const text = cleanText(value, 200);
  return text && /^[A-Za-z0-9_-]{8,200}$/.test(text) ? text : null;
}

function cleanToolName(value) {
  const text = cleanText(value, 220);
  return text && /^[A-Za-z0-9_.:-]{1,220}$/.test(text) ? text : null;
}

function digest(value) {
  const text = cleanText(value, 8_192);
  return text ? createHash("sha256").update(text).digest("hex") : null;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function jsonCandidates(text) {
  const source = String(text ?? "").trim();
  if (!source) return [];
  const values = [source];
  for (const line of source.split(/\r?\n/)) {
    const candidate = line.replace(/^data:\s*/i, "").trim();
    if (candidate && candidate !== source) values.push(candidate);
  }
  return [...new Set(values)].filter((candidate) => /^[\[{]/.test(candidate));
}

function devspaceToolNameFromPath(value) {
  const raw = cleanText(value, 1_024);
  if (!raw) return null;
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch {}

  const dotted = decoded.match(/^(?:DevSpace_Local_Gateway|DevSpace Local Gateway)\.([A-Za-z0-9_.:-]{1,220})$/);
  if (dotted) return cleanToolName(dotted[1]);

  const segments = decoded.split("/").map((item) => item.trim()).filter(Boolean);
  if (segments.length < 3) return null;
  const connector = segments[0];
  const link = segments.at(-2);
  const tool = segments.at(-1);
  if (!["DevSpace Local Gateway", "DevSpace_Local_Gateway"].includes(connector)) return null;
  if (!/^link_[A-Za-z0-9_-]{8,200}$/.test(link || "")) return null;
  return cleanToolName(tool);
}

function messageText(message) {
  const content = plainObject(message?.content) || {};
  if (typeof content.text === "string") return content.text;
  if (Array.isArray(content.parts)) return content.parts.filter((item) => typeof item === "string").join("\n");
  return "";
}

function toolInvocationFromMessage(message, { conversationId, observedAtMs } = {}) {
  const conversation = cleanConversationId(conversationId);
  const author = plainObject(message?.author);
  if (!conversation || author?.role !== "assistant") return null;
  const recipient = cleanText(message?.recipient, 300);
  const text = messageText(message);
  let parsed = null;
  for (const candidate of jsonCandidates(text)) {
    try {
      const value = JSON.parse(candidate);
      if (plainObject(value)) {
        parsed = value;
        break;
      }
    } catch {}
  }
  if (!parsed) return null;

  let toolName = null;
  let args = null;
  if (recipient === "api_tool.call_tool") {
    toolName = devspaceToolNameFromPath(parsed.path);
    args = plainObject(parsed.args) || plainObject(parsed.arguments) || {};
  } else {
    toolName = devspaceToolNameFromPath(recipient);
    args = plainObject(parsed.args) || plainObject(parsed.arguments) || parsed;
  }
  if (!toolName || !plainObject(args)) return null;

  const callFingerprint = fingerprintMcpToolCall("tools/call", {
    name: toolName,
    arguments: args,
  });
  if (!callFingerprint) return null;

  const metadata = plainObject(message?.metadata) || {};
  const messageId = cleanText(message?.id, 240);
  const turnId = cleanText(
    metadata.working_turn_id
      || metadata.turn_exchange_id
      || metadata.turn_id,
    240,
  );
  const requestId = cleanText(metadata.request_id, 240);
  const atMs = Number(observedAtMs);
  const boundedAtMs = Number.isFinite(atMs) ? atMs : Date.now();
  const invocationFingerprint = digest([
    conversation,
    messageId || "message-unavailable",
    turnId || "turn-unavailable",
    callFingerprint,
  ].join(":"));
  if (!invocationFingerprint) return null;

  return {
    conversationId: conversation,
    toolName,
    callFingerprint,
    invocationFingerprint,
    messageIdFingerprint: digest(messageId),
    turnFingerprint: digest(turnId),
    requestFingerprint: digest(requestId),
    observedAtMs: boundedAtMs,
    observedAt: new Date(boundedAtMs).toISOString(),
    source: "classic-websocket-tool-invocation",
    rawArgumentsPersisted: false,
    rawMessageIdsPersisted: false,
  };
}

function walkPayload(value, options, output, depth = 0, seen = new WeakSet()) {
  if (depth > MAX_JSON_DEPTH || value == null) return;
  if (typeof value === "string") {
    for (const candidate of jsonCandidates(value)) {
      try { walkPayload(JSON.parse(candidate), options, output, depth + 1, seen); } catch {}
    }
    return;
  }
  if (typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) walkPayload(item, options, output, depth + 1, seen);
    return;
  }

  const candidate = plainObject(value.message) || value;
  const invocation = toolInvocationFromMessage(candidate, options);
  if (invocation) output.push(invocation);
  for (const child of Object.values(value)) walkPayload(child, options, output, depth + 1, seen);
}

export function parseClassicToolInvocationPayload(payloadData, options = {}) {
  const output = [];
  walkPayload(payloadData, options, output);
  const unique = new Map();
  for (const event of output) {
    if (!unique.has(event.invocationFingerprint)) unique.set(event.invocationFingerprint, event);
  }
  return [...unique.values()];
}

export class ClassicToolInvocationStreamTracker {
  constructor({
    now = () => Date.now(),
    ttlMs = DEFAULT_TTL_MS,
    maxSeen = DEFAULT_MAX_SEEN,
  } = {}) {
    this.now = now;
    this.ttlMs = Math.max(1_000, Number(ttlMs) || DEFAULT_TTL_MS);
    this.maxSeen = Math.max(16, Number(maxSeen) || DEFAULT_MAX_SEEN);
    this.seen = new Map();
    this.observed = 0;
    this.duplicates = 0;
  }

  notePayload({ payloadData, conversationId, observedAtMs = this.now() } = {}) {
    this.prune();
    const events = parseClassicToolInvocationPayload(payloadData, {
      conversationId,
      observedAtMs,
    });
    const accepted = [];
    for (const event of events) {
      if (this.seen.has(event.invocationFingerprint)) {
        this.duplicates += 1;
        continue;
      }
      this.seen.set(event.invocationFingerprint, {
        conversationId: event.conversationId,
        observedAtMs: event.observedAtMs,
      });
      this.observed += 1;
      accepted.push(event);
    }
    this.#enforceCap();
    return accepted;
  }

  completeConversation(conversationId) {
    const conversation = cleanConversationId(conversationId);
    if (!conversation) return 0;
    let removed = 0;
    for (const [key, value] of this.seen) {
      if (value.conversationId !== conversation) continue;
      this.seen.delete(key);
      removed += 1;
    }
    return removed;
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, value] of this.seen) {
      if (Number(value?.observedAtMs || 0) < cutoff) this.seen.delete(key);
    }
    this.#enforceCap();
  }

  #enforceCap() {
    if (this.seen.size <= this.maxSeen) return;
    const oldest = [...this.seen.entries()]
      .sort((left, right) => Number(left[1]?.observedAtMs || 0) - Number(right[1]?.observedAtMs || 0));
    for (const [key] of oldest) {
      if (this.seen.size <= this.maxSeen) break;
      this.seen.delete(key);
    }
  }

  diagnostics() {
    this.prune();
    return {
      seen: this.seen.size,
      observed: this.observed,
      duplicates: this.duplicates,
      ttlMs: this.ttlMs,
      maxSeen: this.maxSeen,
      rawArgumentsPersisted: false,
      rawMessageIdsPersisted: false,
    };
  }
}

export const classicToolInvocationStreamInternals = {
  cleanConversationId,
  cleanToolName,
  devspaceToolNameFromPath,
  digest,
  jsonCandidates,
  messageText,
  toolInvocationFromMessage,
};
