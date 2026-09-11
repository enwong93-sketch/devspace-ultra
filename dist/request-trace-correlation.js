import { createHash } from "node:crypto";

function normalizedHeaders(headers = {}) {
  const result = {};
  for (const [name, raw] of Object.entries(headers || {})) {
    const key = String(name || "").trim().toLowerCase();
    if (!key) continue;
    const value = Array.isArray(raw) ? raw[0] : raw;
    result[key] = String(value ?? "").trim();
  }
  return result;
}

function digest(kind, value) {
  return createHash("sha256").update(`${kind}:${value}`).digest("hex");
}

function canonicalDatadogTraceId(value) {
  const text = String(value ?? "").trim();
  if (!/^[0-9]{1,40}$/.test(text)) return null;
  try {
    const parsed = BigInt(text);
    if (parsed <= 0n || parsed > 0xffffffffffffffffn) return null;
    return parsed.toString(10);
  } catch {
    return null;
  }
}

function canonicalW3cTraceId(value) {
  const text = String(value ?? "").trim().toLowerCase();
  const match = text.match(/^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}(?:$|,)/);
  if (!match || /^0{32}$/.test(match[1])) return null;
  return match[1];
}

/**
 * Return bounded, non-secret fingerprints that can join the browser turn
 * request with the server-side MCP tool request belonging to the same
 * distributed trace. The raw trace ids never leave this function.
 *
 * A W3C 128-bit trace also yields its lower 64-bit Datadog-compatible key so
 * a browser that exposes only traceparent can still match a Core request that
 * exposes only x-datadog-trace-id (and vice versa).
 */
export function requestTraceCorrelationFingerprints(headers = {}) {
  const normalized = normalizedHeaders(headers);
  const values = new Set();
  const w3cTraceId = canonicalW3cTraceId(normalized.traceparent);
  if (w3cTraceId) {
    values.add(digest("w3c", w3cTraceId));
    try {
      const low64 = BigInt(`0x${w3cTraceId.slice(-16)}`);
      if (low64 > 0n) values.add(digest("dd64", low64.toString(10)));
    } catch {}
  }
  const datadogTraceId = canonicalDatadogTraceId(normalized["x-datadog-trace-id"]);
  if (datadogTraceId) values.add(digest("dd64", datadogTraceId));
  return [...values].sort().slice(0, 4);
}

export function mergeTraceCorrelationFingerprints(...collections) {
  const values = new Set();
  for (const collection of collections) {
    for (const raw of Array.isArray(collection) ? collection : []) {
      const value = String(raw ?? "").trim().toLowerCase();
      if (/^[a-f0-9]{64}$/.test(value)) values.add(value);
    }
  }
  return [...values].sort().slice(0, 8);
}

export function tracesIntersect(left, right) {
  const first = new Set(mergeTraceCorrelationFingerprints(left));
  if (!first.size) return false;
  return mergeTraceCorrelationFingerprints(right).some((value) => first.has(value));
}

export const _test = {
  canonicalDatadogTraceId,
  canonicalW3cTraceId,
  digest,
  normalizedHeaders,
};
