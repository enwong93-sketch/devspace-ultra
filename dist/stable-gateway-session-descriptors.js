import { readFile } from "node:fs/promises";
import { atomicWriteJson } from "./atomic-file.js";

const VERSION = 3;
const LEGACY_VERSIONS = new Set([1, 2]);
const MAX_PERSISTED_DESCRIPTORS = 512;

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

function boundedDescriptors(descriptors) {
  const normalized = (Array.isArray(descriptors) ? descriptors : []).map(normalize).filter(Boolean)
    .sort((a, b) => Number(b.lastActivityAt || 0) - Number(a.lastActivityAt || 0));
  const seenClients = new Set();
  const result = [];
  for (const descriptor of normalized) {
    const client = descriptor.clientSessionFingerprint;
    if (client && seenClients.has(client)) continue;
    if (client) seenClients.add(client);
    result.push(descriptor);
    if (result.length >= MAX_PERSISTED_DESCRIPTORS) break;
  }
  return result;
}

export async function loadStableGatewaySessionDescriptors(path) {
  try {
    const parsed = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
    if (!Array.isArray(parsed?.descriptors)) return [];
    if (LEGACY_VERSIONS.has(parsed?.version)) return [];
    if (parsed?.version !== VERSION) return [];
    return boundedDescriptors(parsed.descriptors);
  } catch {
    return [];
  }
}

export async function saveStableGatewaySessionDescriptors(path, descriptors) {
  const safe = boundedDescriptors(descriptors);
  const payload = { version: VERSION, descriptors: safe };
  await atomicWriteJson(path, payload);
  return structuredClone(payload);
}

export const stableGatewaySessionDescriptorInternals = {
  MAX_PERSISTED_DESCRIPTORS,
  boundedDescriptors,
};
