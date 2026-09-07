import { mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";

const MIB = 1024 * 1024;
const DEFAULT_FILE_LIMIT_BYTES = 16 * MIB;
const DEFAULT_KEEP_TAIL_BYTES = 4 * MIB;
const DEFAULT_TOTAL_LIMIT_BYTES = 256 * MIB;
const DEFAULT_MAX_FILES = 256;
const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAX_DEPTH = 5;
const LOG_NAME_PATTERN = /(?:\.log|\.out|\.err|\.jsonl|\.ndjson|trace|history)(?:\.\d+)?$/i;

function finiteInteger(value, fallback, minimum = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.floor(number)) : fallback;
}

function isRetainedLogName(path) {
  const name = basename(String(path || ""));
  return LOG_NAME_PATTERN.test(name) && !/\.tmp$/i.test(name);
}

async function collectFiles(root, {
  maxDepth = DEFAULT_MAX_DEPTH,
  maxEntries = 10_000,
} = {}) {
  const absoluteRoot = resolve(root);
  const rows = [];
  const pending = [{ path: absoluteRoot, depth: 0 }];
  while (pending.length && rows.length < maxEntries) {
    const current = pending.shift();
    let entries;
    try { entries = await readdir(current.path, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (rows.length >= maxEntries) break;
      const path = resolve(current.path, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (current.depth < maxDepth) pending.push({ path, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !isRetainedLogName(path)) continue;
      try {
        const info = await stat(path);
        rows.push({ path, size: info.size, mtimeMs: info.mtimeMs });
      } catch {}
    }
  }
  return rows;
}

/**
 * Bound an append-only diagnostic file without ever loading the full file.
 *
 * The file is opened in r+ mode, only the requested tail is read, and the same
 * inode is truncated/re-written. Existing append-mode child descriptors keep
 * writing at the new end of file on supported platforms. Diagnostic log lines
 * racing the trim may be discarded; logs are observability, never authority.
 */
export async function trimAppendOnlyLog(path, {
  fileLimitBytes = DEFAULT_FILE_LIMIT_BYTES,
  keepTailBytes = DEFAULT_KEEP_TAIL_BYTES,
  marker = "[DevSpace log retention: older diagnostic output discarded]\n",
} = {}) {
  const limit = finiteInteger(fileLimitBytes, DEFAULT_FILE_LIMIT_BYTES, 1024);
  const keep = Math.min(limit, finiteInteger(keepTailBytes, DEFAULT_KEEP_TAIL_BYTES, 0));
  let handle;
  try {
    handle = await open(path, "r+");
    const before = await handle.stat();
    if (before.size <= limit) {
      return { path, action: "kept", beforeBytes: before.size, afterBytes: before.size, discardedBytes: 0 };
    }
    const tailLength = Math.min(before.size, keep);
    const tail = Buffer.allocUnsafe(tailLength);
    if (tailLength) await handle.read(tail, 0, tailLength, Math.max(0, before.size - tailLength));
    const prefix = Buffer.from(String(marker || ""), "utf8");
    const maxPrefix = Math.max(0, limit - tail.length);
    const boundedPrefix = prefix.length > maxPrefix ? prefix.subarray(0, maxPrefix) : prefix;
    await handle.truncate(0);
    if (boundedPrefix.length) await handle.write(boundedPrefix, 0, boundedPrefix.length, 0);
    if (tail.length) await handle.write(tail, 0, tail.length, boundedPrefix.length);
    await handle.sync();
    const afterBytes = boundedPrefix.length + tail.length;
    return {
      path,
      action: "trimmed",
      beforeBytes: before.size,
      afterBytes,
      discardedBytes: Math.max(0, before.size - afterBytes),
    };
  } catch (error) {
    return {
      path,
      action: "error",
      errorCode: String(error?.code || error?.name || "LOG_TRIM_FAILED").slice(0, 80),
      beforeBytes: null,
      afterBytes: null,
      discardedBytes: 0,
    };
  } finally {
    try { await handle?.close(); } catch {}
  }
}

export async function sweepLogDirectory(root, {
  fileLimitBytes = DEFAULT_FILE_LIMIT_BYTES,
  keepTailBytes = DEFAULT_KEEP_TAIL_BYTES,
  totalLimitBytes = DEFAULT_TOTAL_LIMIT_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = Date.now,
  maxDepth = DEFAULT_MAX_DEPTH,
} = {}) {
  const absoluteRoot = resolve(root);
  await mkdir(absoluteRoot, { recursive: true });
  const limit = finiteInteger(totalLimitBytes, DEFAULT_TOTAL_LIMIT_BYTES, 0);
  const countLimit = finiteInteger(maxFiles, DEFAULT_MAX_FILES, 1);
  const ageLimit = finiteInteger(maxAgeMs, DEFAULT_MAX_AGE_MS, 0);
  const observedAt = Number(now());
  const initial = await collectFiles(absoluteRoot, { maxDepth });
  const actions = [];

  for (const row of initial) {
    if (ageLimit && observedAt - row.mtimeMs > ageLimit) {
      try {
        await unlink(row.path);
        actions.push({ path: row.path, action: "expired", beforeBytes: row.size, afterBytes: 0, discardedBytes: row.size });
      } catch (error) {
        actions.push({ path: row.path, action: "error", errorCode: String(error?.code || error?.name || "LOG_DELETE_FAILED").slice(0, 80) });
      }
      continue;
    }
    if (row.size > fileLimitBytes) {
      actions.push(await trimAppendOnlyLog(row.path, { fileLimitBytes, keepTailBytes }));
    }
  }

  let rows = await collectFiles(absoluteRoot, { maxDepth });
  rows.sort((left, right) => left.mtimeMs - right.mtimeMs || right.size - left.size || left.path.localeCompare(right.path));
  let totalBytes = rows.reduce((sum, row) => sum + row.size, 0);
  let fileCount = rows.length;
  for (const row of rows) {
    if (fileCount <= countLimit && totalBytes <= limit) break;
    try {
      await unlink(row.path);
      actions.push({ path: row.path, action: "quota-removed", beforeBytes: row.size, afterBytes: 0, discardedBytes: row.size });
      totalBytes -= row.size;
      fileCount -= 1;
    } catch (error) {
      actions.push({ path: row.path, action: "error", errorCode: String(error?.code || error?.name || "LOG_DELETE_FAILED").slice(0, 80) });
    }
  }

  rows = await collectFiles(absoluteRoot, { maxDepth });
  const finalBytes = rows.reduce((sum, row) => sum + row.size, 0);
  return {
    ok: actions.every((item) => item.action !== "error"),
    root: absoluteRoot,
    observedAt: new Date(observedAt).toISOString(),
    policy: {
      fileLimitBytes: finiteInteger(fileLimitBytes, DEFAULT_FILE_LIMIT_BYTES, 1024),
      keepTailBytes: finiteInteger(keepTailBytes, DEFAULT_KEEP_TAIL_BYTES, 0),
      totalLimitBytes: limit,
      maxFiles: countLimit,
      maxAgeMs: ageLimit,
    },
    before: {
      files: initial.length,
      bytes: initial.reduce((sum, row) => sum + row.size, 0),
    },
    after: {
      files: rows.length,
      bytes: finalBytes,
    },
    actions: actions.slice(0, 512),
    totals: {
      trimmed: actions.filter((item) => item.action === "trimmed").length,
      expired: actions.filter((item) => item.action === "expired").length,
      quotaRemoved: actions.filter((item) => item.action === "quota-removed").length,
      errors: actions.filter((item) => item.action === "error").length,
      discardedBytes: actions.reduce((sum, item) => sum + Number(item.discardedBytes || 0), 0),
    },
  };
}

export class LogRetentionSupervisor {
  constructor({
    roots = [],
    intervalMs = DEFAULT_INTERVAL_MS,
    sweepOptions = {},
    now = Date.now,
  } = {}) {
    this.roots = [...new Set((Array.isArray(roots) ? roots : [roots]).filter(Boolean).map((root) => resolve(root)))];
    this.intervalMs = Math.max(10_000, finiteInteger(intervalMs, DEFAULT_INTERVAL_MS, 1));
    this.sweepOptions = { ...sweepOptions, now };
    this.timer = null;
    this.running = null;
    this.closed = false;
    this.lastStartedAt = null;
    this.lastCompletedAt = null;
    this.lastError = null;
    this.results = [];
  }

  async sweep() {
    if (this.closed) return this.status();
    if (this.running) return this.running;
    this.lastStartedAt = new Date().toISOString();
    this.running = Promise.all(this.roots.map((root) => sweepLogDirectory(root, this.sweepOptions)))
      .then((results) => {
        this.results = results;
        this.lastError = null;
        this.lastCompletedAt = new Date().toISOString();
        return this.status();
      })
      .catch((error) => {
        this.lastError = String(error?.code || error?.name || "LOG_RETENTION_FAILED").slice(0, 80);
        this.lastCompletedAt = new Date().toISOString();
        return this.status();
      })
      .finally(() => { this.running = null; });
    return this.running;
  }

  async start() {
    await this.sweep();
    if (!this.timer && !this.closed) {
      this.timer = setInterval(() => { void this.sweep(); }, this.intervalMs);
      this.timer.unref?.();
    }
    return this.status();
  }

  status() {
    return {
      enabled: this.roots.length > 0,
      running: Boolean(this.timer),
      sweepInProgress: Boolean(this.running),
      roots: this.roots,
      intervalMs: this.intervalMs,
      lastStartedAt: this.lastStartedAt,
      lastCompletedAt: this.lastCompletedAt,
      lastError: this.lastError,
      aggregate: {
        files: this.results.reduce((sum, row) => sum + Number(row.after?.files || 0), 0),
        bytes: this.results.reduce((sum, row) => sum + Number(row.after?.bytes || 0), 0),
        discardedBytes: this.results.reduce((sum, row) => sum + Number(row.totals?.discardedBytes || 0), 0),
        errors: this.results.reduce((sum, row) => sum + Number(row.totals?.errors || 0), 0),
      },
      results: this.results.map((row) => ({
        root: row.root,
        ok: row.ok,
        before: row.before,
        after: row.after,
        totals: row.totals,
        policy: row.policy,
      })),
    };
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch?.(() => {});
  }
}

export function createLogRetentionSupervisor(options) {
  return new LogRetentionSupervisor(options);
}

export const LOG_RETENTION_DEFAULTS = Object.freeze({
  fileLimitBytes: DEFAULT_FILE_LIMIT_BYTES,
  keepTailBytes: DEFAULT_KEEP_TAIL_BYTES,
  totalLimitBytes: DEFAULT_TOTAL_LIMIT_BYTES,
  maxFiles: DEFAULT_MAX_FILES,
  maxAgeMs: DEFAULT_MAX_AGE_MS,
  intervalMs: DEFAULT_INTERVAL_MS,
});
