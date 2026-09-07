import { readFile } from "node:fs/promises";
import { atomicWriteJson } from "./atomic-file.js";

const STATE_VERSION = 1;
const DEFAULT_LIMIT = 32;
const MAX_CANDIDATES = 256;
const MAX_PATH_CHARS = 320;
const USAGE_KEY = /(?:^|[._-])(?:usage|token|tokens|context|remaining|limit|input|output|cached|prompt|completion)(?:$|[._-])/i;
const SAFE_EVENT_TYPE = /^[A-Za-z0-9_.:/-]{1,100}$/;

function clipText(value, maxChars) {
  return String(value ?? "").trim().slice(0, maxChars);
}

function numericValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const text = value.trim();
    if (/^-?\d+(?:\.\d+)?$/.test(text)) {
      const number = Number(text);
      if (Number.isFinite(number)) return number;
    }
  }
  return null;
}

function candidatePath(parts) {
  return parts.map((part) => String(part).replace(/\s+/g, "_")).join(".").slice(0, MAX_PATH_CHARS);
}

function maybeEventType(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return SAFE_EVENT_TYPE.test(text) ? text : null;
}

function collectNumericCandidates(value, {
  source,
  path = [],
  eventType = null,
  output,
  depth = 0,
} = {}) {
  if (!output || output.length >= MAX_CANDIDATES || depth > 14 || value == null) return;
  if (typeof value !== "object") {
    const numeric = numericValue(value);
    const pathText = candidatePath(path);
    if (numeric !== null && USAGE_KEY.test(pathText)) {
      output.push({
        source,
        path: pathText,
        value: numeric,
        ...(eventType ? { eventType } : {}),
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length && output.length < MAX_CANDIDATES; index += 1) {
      collectNumericCandidates(value[index], {
        source,
        path: [...path, index],
        eventType,
        output,
        depth: depth + 1,
      });
    }
    return;
  }
  const nextEventType = eventType || maybeEventType(value.type) || maybeEventType(value.event_type);
  for (const [key, child] of Object.entries(value)) {
    if (output.length >= MAX_CANDIDATES) break;
    collectNumericCandidates(child, {
      source,
      path: [...path, key],
      eventType: nextEventType,
      output,
      depth: depth + 1,
    });
  }
}

function parseSseJson(text) {
  const events = [];
  const body = String(text ?? "");
  const trimmed = body.trim();
  if (!trimmed) return events;
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try { events.push(JSON.parse(trimmed)); } catch {}
    if (events.length) return events;
  }
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^data:\s*(.*)$/);
    if (!match) continue;
    const payload = match[1].trim();
    if (!payload || payload === "[DONE]") continue;
    try { events.push(JSON.parse(payload)); } catch {}
  }
  return events;
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const result = [];
  for (const item of candidates) {
    const key = `${item.source}|${item.path}|${item.value}|${item.eventType || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= MAX_CANDIDATES) break;
  }
  return result;
}

export function extractClassicNativeUsageEvidence({
  conversationId,
  requestHeaders = {},
  responseHeaders = {},
  responseBody = "",
  observedAt = new Date().toISOString(),
} = {}) {
  const id = clipText(conversationId, 240);
  const candidates = [];

  const collectHeaders = (headers, source) => {
    const safeHeaders = {};
    for (const [key, value] of Object.entries(headers || {})) {
      const normalizedKey = String(key).toLowerCase();
      if (!USAGE_KEY.test(normalizedKey)) continue;
      safeHeaders[normalizedKey] = Array.isArray(value) ? value[0] : value;
    }
    collectNumericCandidates(safeHeaders, {
      source,
      path: ["headers"],
      output: candidates,
    });
  };
  collectHeaders(requestHeaders, "request-header");
  collectHeaders(responseHeaders, "response-header");

  const events = parseSseJson(responseBody);
  for (let index = 0; index < events.length && candidates.length < MAX_CANDIDATES; index += 1) {
    const event = events[index];
    collectNumericCandidates(event, {
      source: "response-body",
      path: [`event_${index}`],
      eventType: maybeEventType(event?.type) || maybeEventType(event?.event_type),
      output: candidates,
    });
  }

  return {
    conversationId: id || null,
    observedAt: clipText(observedAt, 80) || new Date().toISOString(),
    candidates: dedupeCandidates(candidates),
  };
}

function normalizeEvidence(value) {
  const conversationId = clipText(value?.conversationId, 240);
  if (!conversationId) throw new Error("Native usage evidence requires conversationId.");
  const candidates = [];
  for (const candidate of Array.isArray(value?.candidates) ? value.candidates : []) {
    const source = ["request-header", "response-header", "response-body"].includes(candidate?.source) ? candidate.source : null;
    const path = clipText(candidate?.path, MAX_PATH_CHARS);
    const numeric = numericValue(candidate?.value);
    if (!source || !path || numeric === null || !USAGE_KEY.test(path)) continue;
    const eventType = maybeEventType(candidate?.eventType);
    candidates.push({ source, path, value: numeric, ...(eventType ? { eventType } : {}) });
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return {
    conversationId,
    observedAt: clipText(value?.observedAt, 80) || new Date().toISOString(),
    candidates: dedupeCandidates(candidates),
  };
}

async function atomicWrite(path, value) {
  await atomicWriteJson(path, value);
}

export class ClassicNativeUsageEvidenceStore {
  constructor({ statePath, limit = DEFAULT_LIMIT } = {}) {
    this.statePath = clipText(statePath, 4096);
    if (!this.statePath) throw new Error("ClassicNativeUsageEvidenceStore requires statePath.");
    this.limit = Math.max(1, Math.min(256, Number(limit) || DEFAULT_LIMIT));
    this.events = [];
    this.persistQueue = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse((await readFile(this.statePath, "utf8")).replace(/^\uFEFF/, ""));
      if (parsed?.version !== STATE_VERSION || !Array.isArray(parsed.events)) throw new Error("unsupported native usage evidence state");
      this.events = parsed.events.map(normalizeEvidence).slice(0, this.limit);
    } catch (error) {
      if (error?.code !== "ENOENT") this.events = [];
    }
    return this.snapshot();
  }

  async record(value) {
    const evidence = normalizeEvidence(value);
    this.events.unshift(evidence);
    if (this.events.length > this.limit) this.events.length = this.limit;
    const snapshot = { version: STATE_VERSION, events: this.events };
    this.persistQueue = this.persistQueue.then(() => atomicWrite(this.statePath, snapshot));
    await this.persistQueue;
    return structuredClone(evidence);
  }

  snapshot({ conversationId } = {}) {
    const id = conversationId == null ? null : clipText(conversationId, 240);
    const events = id ? this.events.filter((event) => event.conversationId === id) : this.events;
    return { version: STATE_VERSION, events: structuredClone(events) };
  }
}
