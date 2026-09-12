import { createHash } from "node:crypto";
import { requestTraceCorrelationFingerprints } from "./request-trace-correlation.js";
import { sessionCorrelationFingerprintsFromHeaders } from "./session-correlation.js";

const DEFAULT_MAX_RECORDS = 24;
const MAX_NAMES = 120;
const MAX_PATHS = 120;

function cleanText(value, max = 512) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function cleanFingerprint(value) {
  const text = cleanText(value, 64)?.toLowerCase();
  return text && /^[a-f0-9]{64}$/.test(text) ? text : null;
}

function digest(value) {
  const text = cleanText(value, 8_192);
  if (!text) return null;
  return createHash("sha256").update(text).digest("hex");
}

function normalizedHeaders(headers = {}) {
  const result = {};
  for (const [name, raw] of Object.entries(headers || {})) {
    const key = String(name || "").trim().toLowerCase();
    if (!key) continue;
    const value = Array.isArray(raw) ? raw.join(",") : raw;
    result[key] = String(value ?? "");
  }
  return result;
}

function safeKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).map((key) => String(key)).sort().slice(0, MAX_NAMES);
}

function correlationScalarPaths(value, {
  prefix = "body",
  depth = 0,
  seen = new WeakSet(),
  output = [],
} = {}) {
  if (output.length >= MAX_PATHS || depth > 7 || value == null) return output;
  if (typeof value !== "object") return output;
  if (seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < Math.min(value.length, 20); index += 1) {
      correlationScalarPaths(value[index], {
        prefix: `${prefix}[${index}]`,
        depth: depth + 1,
        seen,
        output,
      });
      if (output.length >= MAX_PATHS) break;
    }
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    const path = `${prefix}.${key}`;
    const interesting = /(conversation|session|trace|turn|request|message|call|invocation|thread|owner|runtime|client)/i.test(key);
    if (interesting && ["string", "number", "boolean"].includes(typeof child)) {
      const raw = cleanText(child, 8_192);
      if (raw) {
        output.push({
          path,
          kind: typeof child,
          length: raw.length,
          sha256: digest(raw),
          ...(cleanFingerprint(raw) ? { fingerprint: cleanFingerprint(raw) } : {}),
        });
      }
    }
    if (child && typeof child === "object") {
      correlationScalarPaths(child, {
        prefix: path,
        depth: depth + 1,
        seen,
        output,
      });
    }
    if (output.length >= MAX_PATHS) break;
  }
  return output;
}

export function summarizeMcpCorrelationRequest({
  headers = {},
  body = {},
  mcpSessionId = null,
  clientSessionFingerprint = null,
  turnTraceFingerprint = null,
  observedAt = new Date().toISOString(),
} = {}) {
  const normalized = normalizedHeaders(headers);
  const headerNames = Object.keys(normalized).sort().slice(0, MAX_NAMES);
  const correlationHeaders = [];
  for (const name of headerNames) {
    if (!/(conversation|session|trace|turn|request|message|call|invocation|thread|owner|runtime|client|openai|mcp|devspace)/i.test(name)) continue;
    const raw = cleanText(normalized[name], 8_192);
    if (!raw) continue;
    correlationHeaders.push({
      name,
      length: raw.length,
      sha256: digest(raw),
      ...(cleanFingerprint(raw) ? { fingerprint: cleanFingerprint(raw) } : {}),
    });
  }
  const params = body?.params && typeof body.params === "object" ? body.params : {};
  const meta = params?._meta && typeof params._meta === "object"
    ? params._meta
    : body?._meta && typeof body._meta === "object"
      ? body._meta
      : {};
  return {
    observedAt: cleanText(observedAt, 80),
    method: cleanText(body?.method, 120),
    toolName: cleanText(params?.name, 220),
    mcpSessionIdPresent: Boolean(cleanText(mcpSessionId, 512)),
    mcpSessionIdHash: digest(mcpSessionId),
    clientSessionFingerprint: cleanFingerprint(clientSessionFingerprint),
    turnTraceFingerprint: cleanFingerprint(turnTraceFingerprint),
    traceCorrelationFingerprints: requestTraceCorrelationFingerprints(normalized),
    sessionCorrelationFingerprints: sessionCorrelationFingerprintsFromHeaders(normalized),
    headerNames,
    correlationHeaders,
    bodyKeys: safeKeys(body),
    paramsKeys: safeKeys(params),
    metaKeys: safeKeys(meta),
    argumentKeys: safeKeys(params?.arguments),
    correlationScalarPaths: correlationScalarPaths(body),
    rawHeaderValuesPersisted: false,
    rawBodyValuesPersisted: false,
    rawArgumentsPersisted: false,
  };
}

export class McpRequestCorrelationDiagnostics {
  constructor({ maxRecords = DEFAULT_MAX_RECORDS } = {}) {
    this.maxRecords = Math.max(4, Math.min(128, Number(maxRecords) || DEFAULT_MAX_RECORDS));
    this.records = [];
  }

  note(input = {}) {
    const record = summarizeMcpCorrelationRequest(input);
    this.records.unshift(record);
    this.records = this.records.slice(0, this.maxRecords);
    return structuredClone(record);
  }

  diagnostics() {
    return {
      recordCount: this.records.length,
      maxRecords: this.maxRecords,
      records: structuredClone(this.records),
      rawHeaderValuesPersisted: false,
      rawBodyValuesPersisted: false,
      rawArgumentsPersisted: false,
    };
  }
}

export const _test = {
  cleanFingerprint,
  correlationScalarPaths,
  digest,
  normalizedHeaders,
  safeKeys,
};
