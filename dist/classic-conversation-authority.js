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

export function sessionFingerprintFromMcpExtra(extra = {}) {
  const meta = extra?._meta && typeof extra._meta === "object" ? extra._meta : {};
  const rawMeta = typeof meta["openai/session"] === "string" ? meta["openai/session"] : "";
  if (rawMeta.trim()) return fingerprintClassicSession(rawMeta);
  const headers = normalizedHeaders(extra?.requestInfo?.headers);
  const rawHeader = Array.isArray(headers["x-openai-session"])
    ? headers["x-openai-session"][0]
    : headers["x-openai-session"];
  return fingerprintClassicSession(rawHeader);
}

export function sessionFingerprintFromClassicRequest(request = {}) {
  const headers = normalizedHeaders(request?.headers);
  const raw = Array.isArray(headers["x-openai-session"])
    ? headers["x-openai-session"][0]
    : headers["x-openai-session"];
  return fingerprintClassicSession(raw);
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

  async observeNativeTurn({ sessionFingerprint, conversationId, runtimeKey, observedAt } = {}) {
    const fingerprint = requireText(sessionFingerprint, "sessionFingerprint").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("sessionFingerprint must be a SHA-256 hex digest.");
    const conversation = requireText(conversationId, "conversationId");
    const runtime = String(runtimeKey || "").trim();
    const at = String(observedAt || new Date().toISOString());
    const existing = this.entries.get(fingerprint) || cleanEntry(fingerprint);
    if (!existing.conversationIds.includes(conversation)) existing.conversationIds.push(conversation);
    if (runtime && !existing.runtimeKeys.includes(runtime)) existing.runtimeKeys.push(runtime);
    existing.ambiguous = existing.conversationIds.length > 1;
    existing.updatedAt = at;
    this.entries.set(fingerprint, existing);
    await this.#persist();
    return this.resolveFingerprint(fingerprint);
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

  resolveMcpExtra(extra) {
    const fingerprint = sessionFingerprintFromMcpExtra(extra);
    if (!fingerprint) return null;
    return this.resolveFingerprint(fingerprint);
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
