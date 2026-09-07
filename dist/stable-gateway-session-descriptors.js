import { readFile } from "node:fs/promises";
import { atomicWriteJson } from "./atomic-file.js";

const VERSION = 2;
const LEGACY_VERSION = 1;
const MAX_DESCRIPTORS = 256;

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
  return {
    publicSessionId,
    initializeBody: structuredClone(item.initializeBody),
    initialized: item?.initialized === true,
    lastActivityAt: Number.isFinite(lastActivityAt) ? lastActivityAt : 0,
    schemaFingerprint: cleanFingerprint(item?.schemaFingerprint),
    toolCount: Number.isInteger(toolCount) && toolCount >= 0 ? toolCount : null,
  };
}

export async function loadStableGatewaySessionDescriptors(path) {
  try {
    const parsed = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
    if (![LEGACY_VERSION, VERSION].includes(parsed?.version) || !Array.isArray(parsed.descriptors)) return [];
    return parsed.descriptors.map(normalize).filter(Boolean).slice(0, MAX_DESCRIPTORS);
  } catch {
    return [];
  }
}

export async function saveStableGatewaySessionDescriptors(path, descriptors) {
  const safe = (Array.isArray(descriptors) ? descriptors : []).map(normalize).filter(Boolean).slice(0, MAX_DESCRIPTORS);
  const payload = { version: VERSION, descriptors: safe };
  await atomicWriteJson(path, payload);
  return structuredClone(payload);
}
