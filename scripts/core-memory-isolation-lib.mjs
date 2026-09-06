const MIB = 1024 * 1024;

export const TOTAL_HEAP_LIMIT_MB = 512;
export const MEMORY_MODE_NAMES = Object.freeze([
  "baseline",
  "context",
  "stream",
  "overlay",
  "capability",
  "full-product",
]);

const MODE_PROFILES = Object.freeze({
  baseline: Object.freeze({
    context: false,
    stream: false,
    overlay: false,
    plugins: false,
    skills: false,
    artifacts: false,
  }),
  context: Object.freeze({
    context: true,
    stream: false,
    overlay: false,
    plugins: false,
    skills: false,
    artifacts: false,
  }),
  stream: Object.freeze({
    context: false,
    stream: true,
    overlay: false,
    plugins: false,
    skills: false,
    artifacts: false,
  }),
  overlay: Object.freeze({
    context: true,
    stream: false,
    overlay: true,
    plugins: false,
    skills: false,
    artifacts: false,
  }),
  capability: Object.freeze({
    context: false,
    stream: false,
    overlay: false,
    plugins: true,
    skills: true,
    artifacts: true,
  }),
  "full-product": Object.freeze({
    context: true,
    stream: true,
    overlay: true,
    plugins: true,
    skills: true,
    artifacts: true,
  }),
});

export function memoryModeProfile(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  const profile = MODE_PROFILES[normalized];
  if (!profile) throw new Error(`Unknown memory isolation mode: ${mode}. Expected one of ${MEMORY_MODE_NAMES.join(", ")}.`);
  return { ...profile };
}

export function nodeArgsForTotalHeapLimit(targetTotalHeapMb = TOTAL_HEAP_LIMIT_MB) {
  const target = Number(targetTotalHeapMb);
  if (target !== 512) {
    throw new Error(`No verified Node/V8 flag profile exists for a ${targetTotalHeapMb} MiB total heap ceiling.`);
  }
  return [
    "--max-old-space-size=464",
    "--max-semi-space-size=16",
    "--expose-gc",
  ];
}

function bytesToMb(value) {
  return Math.round((Number(value || 0) / MIB) * 10) / 10;
}

export function parseMcpResponseText(text, { contentType = "", expectedId } = {}) {
  const raw = String(text || "");
  const candidates = [];
  const consider = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (value.jsonrpc !== "2.0") return;
    if (!(Object.hasOwn(value, "result") || Object.hasOwn(value, "error"))) return;
    candidates.push(value);
  };
  const parseCandidate = (value) => {
    const payload = String(value || "").trim();
    if (!payload || payload === "[DONE]") return;
    try { consider(JSON.parse(payload)); } catch {}
  };

  if (/application\/json/i.test(String(contentType))) {
    parseCandidate(raw);
  } else {
    for (const block of raw.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      parseCandidate(data);
    }
    if (!candidates.length) parseCandidate(raw);
  }

  if (expectedId !== undefined) {
    return candidates.find((candidate) => candidate.id === expectedId) || null;
  }
  return candidates.at(-1) || null;
}

export function assertMemorySnapshot(snapshot, { targetTotalHeapMb = TOTAL_HEAP_LIMIT_MB } = {}) {
  const heapSizeLimit = Number(snapshot?.memory?.heapSizeLimit || 0);
  if (!Number.isFinite(heapSizeLimit) || heapSizeLimit <= 0) {
    throw new Error("Memory diagnostics did not report memory.heapSizeLimit.");
  }
  const ceilingBytes = Number(targetTotalHeapMb) * MIB;
  if (heapSizeLimit > ceilingBytes) {
    throw new Error(`Core V8 heapSizeLimit ${bytesToMb(heapSizeLimit)} MiB exceeds the verified ${targetTotalHeapMb} MiB ceiling.`);
  }
  return {
    heapSizeLimitMb: bytesToMb(heapSizeLimit),
    heapUsedMb: bytesToMb(snapshot?.memory?.heapUsed),
    heapTotalMb: bytesToMb(snapshot?.memory?.heapTotal),
    rssMb: bytesToMb(snapshot?.memory?.rss),
    externalMb: bytesToMb(snapshot?.memory?.external),
    arrayBuffersMb: bytesToMb(snapshot?.memory?.arrayBuffers),
  };
}
