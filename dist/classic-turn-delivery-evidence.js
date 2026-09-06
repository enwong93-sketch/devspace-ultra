import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const VERSION = 1;
const DEFAULT_LIMIT = 96;
const TEXT_LIMIT = 240;

function clean(value, max = TEXT_LIMIT) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function normalize(value) {
  const runtimeKey = clean(value?.runtimeKey, 80);
  const conversationId = clean(value?.conversationId, 240);
  const kind = ["request", "response", "finished", "failed"].includes(value?.kind) ? value.kind : null;
  if (!runtimeKey || !conversationId || !kind) throw new Error("Classic delivery evidence requires runtimeKey, conversationId and kind.");
  const status = Number.isFinite(Number(value?.status)) ? Number(value.status) : null;
  return {
    runtimeKey,
    conversationId,
    kind,
    status,
    errorText: kind === "failed" ? clean(value?.errorText, 180) : null,
    canceled: value?.canceled === true,
    blockedReason: kind === "failed" ? clean(value?.blockedReason, 120) : null,
    observedAt: clean(value?.observedAt, 80) || new Date().toISOString(),
  };
}

async function atomicWrite(path, payload) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

export class ClassicTurnDeliveryEvidenceStore {
  constructor({ statePath, limit = DEFAULT_LIMIT } = {}) {
    this.statePath = clean(statePath, 4096);
    if (!this.statePath) throw new Error("ClassicTurnDeliveryEvidenceStore requires statePath.");
    this.limit = Math.max(8, Math.min(512, Number(limit) || DEFAULT_LIMIT));
    this.events = [];
    this.persistQueue = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse((await readFile(this.statePath, "utf8")).replace(/^\uFEFF/, ""));
      this.events = parsed?.version === VERSION && Array.isArray(parsed.events)
        ? parsed.events.map(normalize).slice(0, this.limit)
        : [];
    } catch {
      this.events = [];
    }
    return this.snapshot();
  }

  async record(value) {
    const event = normalize(value);
    this.events.unshift(event);
    if (this.events.length > this.limit) this.events.length = this.limit;
    const snapshot = { version: VERSION, events: this.events };
    this.persistQueue = this.persistQueue.then(() => atomicWrite(this.statePath, snapshot));
    await this.persistQueue;
    return structuredClone(event);
  }

  latest({ runtimeKey, conversationId, kind, since } = {}) {
    const runtime = runtimeKey == null ? null : clean(runtimeKey, 80);
    const conversation = conversationId == null ? null : clean(conversationId, 240);
    const sinceMs = since == null ? null : Date.parse(String(since));
    return structuredClone(this.events.find((event) => {
      if (runtime && event.runtimeKey !== runtime) return false;
      if (conversation && event.conversationId !== conversation) return false;
      if (kind && event.kind !== kind) return false;
      if (Number.isFinite(sinceMs) && Date.parse(event.observedAt) < sinceMs) return false;
      return true;
    }) || null);
  }

  snapshot() {
    return { version: VERSION, events: structuredClone(this.events) };
  }
}
