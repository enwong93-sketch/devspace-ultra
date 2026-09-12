import { createHash } from "node:crypto";

const SESSION_HEADER_NAMES = ["x-openai-session", "oai-session-id", "openai-session-id"];
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/ig;
const MAX_RAW_VALUE_LENGTH = 2_048;
const MAX_CANDIDATES = 24;

function cleanText(value, max = MAX_RAW_VALUE_LENGTH) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function normalizedHeaders(headers = {}) {
  const result = {};
  for (const [name, raw] of Object.entries(headers || {})) {
    const key = String(name || "").trim().toLowerCase();
    if (!key) continue;
    result[key] = Array.isArray(raw) ? raw[0] : raw;
  }
  return result;
}

function addCandidate(set, value) {
  if (set.size >= MAX_CANDIDATES) return;
  const text = cleanText(value);
  if (!text) return;
  set.add(text);
}

function collectStructuredCandidates(value, output, keyHint = "", depth = 0, seen = new WeakSet()) {
  if (depth > 6 || output.size >= MAX_CANDIDATES || value == null) return;
  if (typeof value === "string" || typeof value === "number") {
    const text = cleanText(value);
    if (!text) return;
    if (/(?:^|[_-])(session|sessionid|session_id|sid|id|uuid)(?:$|[_-])/i.test(keyHint)
      || UUID_PATTERN.test(text)) addCandidate(output, text);
    UUID_PATTERN.lastIndex = 0;
    for (const match of text.matchAll(UUID_PATTERN)) addCandidate(output, match[0].toLowerCase());
    UUID_PATTERN.lastIndex = 0;
    return;
  }
  if (typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 16)) collectStructuredCandidates(item, output, keyHint, depth + 1, seen);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    collectStructuredCandidates(child, output, key, depth + 1, seen);
    if (output.size >= MAX_CANDIDATES) break;
  }
}

function maybeDecodedValues(raw) {
  const values = [raw];
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) values.push(decoded);
  } catch {}
  for (const segment of raw.split(/[.:|]/).filter((item) => item.length >= 16 && item.length <= 512)) {
    if (!/^[A-Za-z0-9_-]+$/.test(segment)) continue;
    try {
      const decoded = Buffer.from(segment, "base64url").toString("utf8").trim();
      if (decoded && /[\[{]/.test(decoded[0])) values.push(decoded);
    } catch {}
  }
  return [...new Set(values)].slice(0, 8);
}

/**
 * Produce bounded SHA-256 aliases for one opaque OpenAI session descriptor.
 *
 * ChatGPT browser turns currently expose a bare `oai-session-id`, while the
 * server-side MCP request can expose an `x-openai-session` descriptor that
 * wraps the same UUID. Hashing only the complete strings makes those two
 * representations impossible to join. This helper retains the full-string
 * digest for compatibility and adds digests for embedded UUID/structured
 * session identifiers. Raw values never leave the function.
 */
export function sessionCorrelationFingerprintsFromValue(value) {
  const raw = cleanText(value);
  if (!raw) return [];
  const candidates = new Set();
  addCandidate(candidates, raw);
  for (const decoded of maybeDecodedValues(raw)) {
    addCandidate(candidates, decoded);
    for (const match of decoded.matchAll(UUID_PATTERN)) addCandidate(candidates, match[0].toLowerCase());
    UUID_PATTERN.lastIndex = 0;
    try {
      collectStructuredCandidates(JSON.parse(decoded), candidates);
    } catch {}
    try {
      const params = new URLSearchParams(decoded);
      for (const [key, item] of params) {
        if (/(session|sid|id|uuid)/i.test(key)) addCandidate(candidates, item);
      }
    } catch {}
  }
  return [...candidates].map(digest).sort().slice(0, MAX_CANDIDATES);
}

export function sessionCorrelationFingerprintsFromHeaders(headers = {}) {
  const normalized = normalizedHeaders(headers);
  const values = new Set();
  for (const name of SESSION_HEADER_NAMES) {
    for (const fingerprint of sessionCorrelationFingerprintsFromValue(normalized[name])) values.add(fingerprint);
  }
  const trusted = cleanText(normalized["x-devspace-client-session-fingerprint"], 64)?.toLowerCase();
  if (/^[a-f0-9]{64}$/.test(trusted || "")) values.add(trusted);
  return [...values].sort().slice(0, MAX_CANDIDATES);
}

export function sessionCorrelationFingerprintsFromMcpExtra(extra = {}) {
  const values = new Set(sessionCorrelationFingerprintsFromHeaders(extra?.requestInfo?.headers || {}));
  const meta = extra?._meta && typeof extra._meta === "object" ? extra._meta : {};
  for (const fingerprint of sessionCorrelationFingerprintsFromValue(meta["openai/session"])) values.add(fingerprint);
  return [...values].sort().slice(0, MAX_CANDIDATES);
}

export function mergeSessionCorrelationFingerprints(...collections) {
  const values = new Set();
  for (const collection of collections) {
    for (const raw of Array.isArray(collection) ? collection : []) {
      const value = String(raw ?? "").trim().toLowerCase();
      if (/^[a-f0-9]{64}$/.test(value)) values.add(value);
    }
  }
  return [...values].sort().slice(0, MAX_CANDIDATES);
}

export function sessionsIntersect(left, right) {
  const first = new Set(mergeSessionCorrelationFingerprints(left));
  return first.size > 0 && mergeSessionCorrelationFingerprints(right).some((value) => first.has(value));
}

export const _test = {
  collectStructuredCandidates,
  digest,
  maybeDecodedValues,
  normalizedHeaders,
};
