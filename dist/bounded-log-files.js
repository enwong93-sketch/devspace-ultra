import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { Writable } from "node:stream";

export const DEFAULT_LOG_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_LOG_BACKUPS = 2;
export const DEFAULT_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function integer(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

export function boundedLogOptionsFromEnv(env = process.env) {
  const maxBytes = integer(env.DEVSPACE_LOG_MAX_BYTES, DEFAULT_LOG_MAX_BYTES, 64 * 1024, 1024 * 1024 * 1024);
  const maxBackups = integer(env.DEVSPACE_LOG_BACKUPS, DEFAULT_LOG_BACKUPS, 0, 20);
  const maxAgeDays = integer(env.DEVSPACE_LOG_MAX_AGE_DAYS, Math.round(DEFAULT_LOG_MAX_AGE_MS / 86_400_000), 1, 3650);
  return {
    maxBytes,
    maxBackups,
    maxAgeMs: maxAgeDays * 86_400_000,
  };
}

function backupPath(path, generation) {
  return `${path}.${generation}`;
}

function fileSize(path) {
  try { return statSync(path).size; }
  catch { return 0; }
}

function removeQuietly(path) {
  try { rmSync(path, { force: true }); }
  catch { /* Best-effort retention must never prevent service startup. */ }
}

function moveBoundedQuietly(from, to, maxBytes) {
  if (!existsSync(from)) return;
  try {
    removeQuietly(to);
    const size = fileSize(from);
    if (size <= maxBytes) {
      renameSync(from, to);
      return;
    }
    const sourceFd = openSync(from, "r");
    const destinationFd = openSync(to, "w");
    try {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes));
      let position = Math.max(0, size - maxBytes);
      let remaining = Math.min(size, maxBytes);
      while (remaining > 0) {
        const length = Math.min(buffer.length, remaining);
        const read = readSync(sourceFd, buffer, 0, length, position);
        if (read <= 0) break;
        writeSync(destinationFd, buffer, 0, read);
        position += read;
        remaining -= read;
      }
    } finally {
      closeSync(sourceFd);
      closeSync(destinationFd);
    }
    removeQuietly(from);
  } catch {
    // A diagnostic-file rotation failure is not allowed to take down Gateway/Core.
  }
}

export function rotateLogFileSetSync(path, {
  maxBytes = DEFAULT_LOG_MAX_BYTES,
  maxBackups = DEFAULT_LOG_BACKUPS,
  maxAgeMs = DEFAULT_LOG_MAX_AGE_MS,
  now = Date.now,
  force = false,
} = {}) {
  const normalizedMaxBytes = integer(maxBytes, DEFAULT_LOG_MAX_BYTES, 1, 1024 * 1024 * 1024);
  const normalizedBackups = integer(maxBackups, DEFAULT_LOG_BACKUPS, 0, 20);
  const normalizedMaxAgeMs = integer(maxAgeMs, DEFAULT_LOG_MAX_AGE_MS, 1, 10 * 3650 * 86_400_000);
  mkdirSync(dirname(path), { recursive: true });

  const cutoff = Number(now()) - normalizedMaxAgeMs;
  for (let generation = 1; generation <= normalizedBackups; generation += 1) {
    const candidate = backupPath(path, generation);
    try {
      if (statSync(candidate).mtimeMs < cutoff) removeQuietly(candidate);
    } catch { /* missing */ }
  }

  const currentBytes = fileSize(path);
  if (!force && currentBytes < normalizedMaxBytes) {
    return {
      rotated: false,
      currentBytes,
      maxBytes: normalizedMaxBytes,
      maxBackups: normalizedBackups,
    };
  }

  if (normalizedBackups === 0) {
    removeQuietly(path);
  } else {
    removeQuietly(backupPath(path, normalizedBackups));
    for (let generation = normalizedBackups - 1; generation >= 1; generation -= 1) {
      moveBoundedQuietly(backupPath(path, generation), backupPath(path, generation + 1), normalizedMaxBytes);
    }
    moveBoundedQuietly(path, backupPath(path, 1), normalizedMaxBytes);
  }
  return {
    rotated: currentBytes > 0,
    currentBytes: 0,
    maxBytes: normalizedMaxBytes,
    maxBackups: normalizedBackups,
  };
}

export class BoundedLogWriter extends Writable {
  constructor(path, options = {}) {
    super({ decodeStrings: true, highWaterMark: 64 * 1024 });
    this.path = path;
    this.options = {
      maxBytes: integer(options.maxBytes, DEFAULT_LOG_MAX_BYTES, 1, 1024 * 1024 * 1024),
      maxBackups: integer(options.maxBackups, DEFAULT_LOG_BACKUPS, 0, 20),
      maxAgeMs: integer(options.maxAgeMs, DEFAULT_LOG_MAX_AGE_MS, 1, 10 * 3650 * 86_400_000),
      now: options.now ?? Date.now,
    };
    this.fd = null;
    this.currentBytes = 0;
    this.rotations = 0;
    this.totalWrittenBytes = 0;
    this.#open();
  }

  #open() {
    const result = rotateLogFileSetSync(this.path, this.options);
    this.currentBytes = result.currentBytes;
    this.fd = openSync(this.path, "a");
  }

  #closeFd() {
    if (this.fd === null) return;
    try { closeSync(this.fd); }
    catch { /* best effort */ }
    this.fd = null;
  }

  #rotate() {
    this.#closeFd();
    rotateLogFileSetSync(this.path, { ...this.options, force: true });
    this.rotations += 1;
    this.currentBytes = 0;
    this.fd = openSync(this.path, "a");
  }

  _write(chunk, encoding, callback) {
    try {
      let buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      if (buffer.length > this.options.maxBytes) {
        buffer = buffer.subarray(buffer.length - this.options.maxBytes);
      }
      if (this.currentBytes > 0 && this.currentBytes + buffer.length > this.options.maxBytes) {
        this.#rotate();
      }
      if (this.fd === null) this.#open();
      writeSync(this.fd, buffer);
      this.currentBytes += buffer.length;
      this.totalWrittenBytes += buffer.length;
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _final(callback) {
    this.#closeFd();
    callback();
  }

  _destroy(error, callback) {
    this.#closeFd();
    callback(error);
  }

  diagnostics() {
    return {
      path: this.path,
      currentBytes: this.currentBytes,
      maxBytes: this.options.maxBytes,
      maxBackups: this.options.maxBackups,
      rotations: this.rotations,
      totalWrittenBytes: this.totalWrittenBytes,
      bufferedBytes: this.writableLength,
    };
  }
}

export function createBoundedLogWriter(path, options = {}) {
  return new BoundedLogWriter(path, options);
}
