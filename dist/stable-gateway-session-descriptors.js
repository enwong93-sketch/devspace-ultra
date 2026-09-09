import { readFile } from "node:fs/promises";
import { atomicWriteJson } from "./atomic-file.js";

const VERSION = 3;
const LEGACY_VERSIONS = new Set([1, 2]);

function cleanId(value) {
  const text = String(value ?? "").trim();
  return /^[0-9a-f-]{16,80}$/i.test(text) ? text : null;
}

function cleanFingerprint(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : null;
}

function normalize(item) {
  const publicSessionId = cleanId(item?.publicSessionId);
  if (!publicSessionId || !item?.initializeBody || typeof item.initializeBody !== "object") return null;
  const lastActivityAt = Number(item?.lastActivityAt || 0);
  const toolCount = item?.toolCount == null ? Number.NaN : Number(item.toolCount);
  const fingerprint = cleanFingerprint(item?.schemaFingerprint);
  const clientSessionFingerprint = cleanFingerprint(item?.clientSessionFingerprint);
  const normalizedToolCount = Number.isInteger(toolCount) && toolCount >= 0 ? toolCount : null;
  if (item?.initialized === true && (!fingerprint || normalizedToolCount == null)) return null;
  return {
    publicSessionId,
    initializeBody: structuredClone(item.initializeBody),
    initialized: item?.initialized === true,
    lastActivityAt: Number.isFinite(lastActivityAt) ? lastActivityAt : 0,
    clientSessionFingerprint,
    schemaFingerprint: fingerprint,
    toolCount: normalizedToolCount,
  };
}

export async function loadStableGatewaySessionDescriptors(path) {
  try {
    const parsed = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
    if (!Array.isArray(parsed?.descriptors)) return [];
    if (LEGACY_VERSIONS.has(parsed?.version)) return [];
    if (parsed?.version !== VERSION) return [];
    return parsed.descriptors.map(normalize).filter(Boolean);
  } catch {
    return [];
  }
}

export async function saveStableGatewaySessionDescriptors(path, descriptors) {
  const safe = (Array.isArray(descriptors) ? descriptors : []).map(normalize).filter(Boolean);
  const payload = { version: VERSION, descriptors: safe };
  await atomicWriteJson(path, payload);
  return structuredClone(payload);
}
