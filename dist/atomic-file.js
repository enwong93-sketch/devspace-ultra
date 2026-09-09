import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const RETRYABLE_RENAME_CODES = new Set(["EACCES", "EBUSY", "ENOTEMPTY", "EPERM"]);
const ATOMIC_TEMP_NAME = /(?:\.\d+\.[A-Za-z0-9-]{4,}\.tmp|\.tmp-\d+-[A-Za-z0-9-]{4,})$/;

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function integer(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

const RETRYABLE_ATOMIC_RENAME_CODES =
  new Set(["EPERM", "EACCES", "EBUSY"]);

async function renameWithRetry(sourcePath, destinationPath) {
  let delayMs = 8;

  while (true) {
    try {
      await rename(sourcePath, destinationPath);
      return;
    }
    catch (error) {
      if (!RETRYABLE_ATOMIC_RENAME_CODES.has(error?.code)) {
        throw error;
      }

      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, delayMs)
      );

      delayMs = Math.min(
        250,
        Math.ceil(delayMs * 1.5)
      );
    }
  }
}
export async function atomicWriteFile(path, data, {
  encoding = "utf8",
  mode = 0o600,
  retries = 6,
  retryDelayMs = 20,
} = {}) {
  const destination = resolve(String(path));
  await mkdir(dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let committed = false;
  try {
    await writeFile(temp, data, { encoding, mode });
    const attempts = integer(retries, 6, 0, 20) + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await renameWithRetry(temp, destination);
        committed = true;
        return { ok: true, path: destination, attempts: attempt + 1 };
      } catch (error) {
        const retryable = RETRYABLE_RENAME_CODES.has(String(error?.code || ""));
        if (!retryable || attempt + 1 >= attempts) throw error;
        await sleep(Math.min(500, integer(retryDelayMs, 20, 1, 500) * (attempt + 1)));
      }
    }
    throw new Error(`Atomic rename did not complete for ${basename(destination)}.`);
  } finally {
    if (!committed) await rm(temp, { force: true }).catch(() => {});
  }
}

export async function atomicWriteJson(path, value, options = {}) {
  return await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

export function isAtomicTempFileName(value) {
  return ATOMIC_TEMP_NAME.test(String(value || ""));
}

export async function pruneStaleAtomicTempFiles(root, {
  olderThanMs = 15 * 60_000,
  maxRetained = 64,
  maxDepth = 4,
  maxVisited = 10_000,
  now = Date.now,
} = {}) {
  const base = resolve(String(root));
  const cutoff = Number(now()) - Math.max(60_000, Number(olderThanMs) || 15 * 60_000);
  const depthLimit = integer(maxDepth, 4, 0, 12);
  const visitLimit = integer(maxVisited, 10_000, 1, 100_000);
  const retainLimit = integer(maxRetained, 64, 0, 10_000);
  const candidates = [];
  let visited = 0;

  async function walk(directory, depth) {
    if (depth > depthLimit || visited >= visitLimit) return;
    let entries = [];
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (visited >= visitLimit) break;
      visited += 1;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isAtomicTempFileName(entry.name)) continue;
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        candidates.push({ path, mtimeMs: info.mtimeMs, size: info.size });
      } catch { /* raced with another cleanup */ }
    }
  }

  await walk(base, 0);
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path));
  let removedFiles = 0;
  let removedBytes = 0;
  let retainedFiles = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const stale = candidate.mtimeMs < cutoff;
    const overRetention = index >= retainLimit;
    if (!stale && !overRetention) {
      retainedFiles += 1;
      continue;
    }
    try {
      await rm(candidate.path, { force: true });
      removedFiles += 1;
      removedBytes += candidate.size;
    } catch {
      retainedFiles += 1;
    }
  }
  return {
    ok: true,
    root: base,
    visited,
    matchedFiles: candidates.length,
    removedFiles,
    removedBytes,
    retainedFiles,
    olderThanMs: Math.max(60_000, Number(olderThanMs) || 15 * 60_000),
    maxRetained: retainLimit,
  };
}
