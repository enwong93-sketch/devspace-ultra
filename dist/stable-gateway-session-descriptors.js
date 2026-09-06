import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const VERSION = 1;
const MAX_DESCRIPTORS = 256;

function cleanId(value) {
  const text = String(value ?? "").trim();
  return /^[0-9a-f-]{16,80}$/i.test(text) ? text : null;
}

function normalize(item) {
  const publicSessionId = cleanId(item?.publicSessionId);
  if (!publicSessionId || !item?.initializeBody || typeof item.initializeBody !== "object") return null;
  const lastActivityAt = Number(item?.lastActivityAt || 0);
  return {
    publicSessionId,
    initializeBody: structuredClone(item.initializeBody),
    initialized: item?.initialized === true,
    lastActivityAt: Number.isFinite(lastActivityAt) ? lastActivityAt : 0,
  };
}

export async function loadStableGatewaySessionDescriptors(path) {
  try {
    const parsed = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
    if (parsed?.version !== VERSION || !Array.isArray(parsed.descriptors)) return [];
    return parsed.descriptors.map(normalize).filter(Boolean).slice(0, MAX_DESCRIPTORS);
  } catch {
    return [];
  }
}

export async function saveStableGatewaySessionDescriptors(path, descriptors) {
  const safe = (Array.isArray(descriptors) ? descriptors : []).map(normalize).filter(Boolean).slice(0, MAX_DESCRIPTORS);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const payload = { version: VERSION, descriptors: safe };
  await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
  return structuredClone(payload);
}
