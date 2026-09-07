import { readFile, stat } from "node:fs/promises";

const DEFAULT_MAX_AGE_MS = 30 * 60_000;
const MAX_EVENTS = 256;
const EXACT_RULES = Object.freeze([
  { kind: "input_tokens", priority: 100, pattern: /(?:^|[._-])input[_-]?tokens?(?:$|[._-])/i },
  { kind: "prompt_tokens", priority: 98, pattern: /(?:^|[._-])prompt[_-]?tokens?(?:$|[._-])/i },
  { kind: "total_input_tokens", priority: 96, pattern: /(?:^|[._-])total[_-]?input[_-]?tokens?(?:$|[._-])/i },
  { kind: "context_used_tokens", priority: 94, pattern: /(?:^|[._-])context[_-]?used[_-]?tokens?(?:$|[._-])/i },
  { kind: "input_token_count", priority: 92, pattern: /(?:^|[._-])input[_-]?token[_-]?count(?:$|[._-])/i },
  { kind: "prompt_token_count", priority: 90, pattern: /(?:^|[._-])prompt[_-]?token[_-]?count(?:$|[._-])/i },
]);
const REJECTED_PATH = /(?:create[_-]?time|update[_-]?time|timestamp|weight|width|height|size(?:[_-]?bytes)?|attachment|image|file|stop[_-]?tokens?|output[_-]?tokens?|completion[_-]?tokens?|cached[_-]?tokens?|cache|remaining|context[_-]?window|max[_-]?tokens?|limit|capacity|budget|latency|duration|request[_-]?count|message[_-]?content[_-]?token[_-]?count)/i;

function cleanText(value, max = 300) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, max) : null;
}

function parseObservedAt(value, fallbackMs = null) {
  const ms = Date.parse(String(value || ""));
  if (Number.isFinite(ms)) return ms;
  return Number.isFinite(Number(fallbackMs)) ? Number(fallbackMs) : null;
}

function exactInteger(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function classifyExactNativeUsageCandidate(candidate) {
  const source = cleanText(candidate?.source, 80);
  const path = cleanText(candidate?.path, 600);
  const value = exactInteger(candidate?.value);
  if (!source || !path || value == null) return null;
  if (!["response-header", "response-body"].includes(source)) return null;
  if (REJECTED_PATH.test(path)) return null;
  const rule = EXACT_RULES.find((item) => item.pattern.test(path));
  if (!rule) return null;
  return {
    source,
    path,
    value,
    kind: rule.kind,
    priority: rule.priority,
    eventType: cleanText(candidate?.eventType, 100),
  };
}

export function selectExactNativeUsage(events, {
  conversationId,
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  const id = cleanText(conversationId, 240);
  if (!id) {
    return { available: false, reason: "conversation-id-required", source: "unavailable", conversationId: null };
  }
  const maxAge = Math.max(1_000, Number(maxAgeMs) || DEFAULT_MAX_AGE_MS);
  const rows = (Array.isArray(events) ? events : [])
    .filter((event) => cleanText(event?.conversationId, 240) === id)
    .map((event, index) => ({
      event,
      index,
      observedAtMs: parseObservedAt(event?.observedAt),
    }))
    .filter((row) => row.observedAtMs != null && nowMs - row.observedAtMs >= -60_000 && nowMs - row.observedAtMs <= maxAge)
    .sort((left, right) => right.observedAtMs - left.observedAtMs || left.index - right.index)
    .slice(0, MAX_EVENTS);

  if (!rows.length) {
    return { available: false, reason: "fresh-native-usage-evidence-unavailable", source: "unavailable", conversationId: id };
  }

  for (const row of rows) {
    const candidates = (Array.isArray(row.event?.candidates) ? row.event.candidates : [])
      .map(classifyExactNativeUsageCandidate)
      .filter(Boolean);
    if (!candidates.length) continue;
    const topPriority = Math.max(...candidates.map((candidate) => candidate.priority));
    const top = candidates.filter((candidate) => candidate.priority === topPriority);
    const values = [...new Set(top.map((candidate) => candidate.value))];
    if (values.length !== 1) {
      return {
        available: false,
        reason: "ambiguous-exact-native-usage",
        source: "unavailable",
        conversationId: id,
        observedAt: new Date(row.observedAtMs).toISOString(),
        candidatesConsidered: top.length,
      };
    }
    const selected = top.sort((left, right) => left.path.localeCompare(right.path))[0];
    return {
      available: true,
      exactUsedTokens: selected.value,
      usageKind: selected.kind,
      evidencePath: selected.path,
      evidenceSource: selected.source,
      eventType: selected.eventType,
      observedAt: new Date(row.observedAtMs).toISOString(),
      ageMs: Math.max(0, nowMs - row.observedAtMs),
      source: "classic-native-protocol",
      conversationId: id,
      candidatesConsidered: candidates.length,
    };
  }

  return {
    available: false,
    reason: "exact-native-token-field-not-exposed",
    source: "unavailable",
    conversationId: id,
    newestEvidenceAt: new Date(rows[0].observedAtMs).toISOString(),
  };
}

export class ClassicExactUsageAuthority {
  constructor({
    statePath,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    now = () => Date.now(),
  } = {}) {
    this.statePath = cleanText(statePath, 4096);
    if (!this.statePath) throw new Error("ClassicExactUsageAuthority requires statePath.");
    this.maxAgeMs = Math.max(1_000, Number(maxAgeMs) || DEFAULT_MAX_AGE_MS);
    this.now = now;
  }

  async status({ conversationId } = {}) {
    let payload;
    let info;
    try {
      [payload, info] = await Promise.all([
        readFile(this.statePath, "utf8").then((text) => JSON.parse(text.replace(/^\uFEFF/, ""))),
        stat(this.statePath),
      ]);
    } catch {
      return {
        available: false,
        reason: "native-usage-evidence-file-unavailable",
        source: "unavailable",
        conversationId: cleanText(conversationId, 240),
      };
    }
    const events = Array.isArray(payload?.events) ? payload.events : [];
    const result = selectExactNativeUsage(events, {
      conversationId,
      nowMs: Number(this.now()),
      maxAgeMs: this.maxAgeMs,
    });
    return {
      ...result,
      evidenceFileObservedAt: Number.isFinite(info?.mtimeMs) ? new Date(info.mtimeMs).toISOString() : null,
      estimatorFallbackUsed: false,
      ledgerFallbackUsed: false,
      domFallbackUsed: false,
    };
  }
}
