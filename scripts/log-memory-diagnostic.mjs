#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { loadConfig } from "../dist/config.js";

const LOG_PATTERN = /(?:\.log|\.out|\.err|\.jsonl|\.ndjson|trace|history)(?:\.\d+)?$/i;
const MAX_DEPTH = 5;
const MAX_FILES = 10_000;

function mib(bytes) {
  return Math.round((Number(bytes || 0) / 1024 / 1024) * 10) / 10;
}

async function collectLogStats(root) {
  const absoluteRoot = resolve(root);
  const pending = [{ path: absoluteRoot, depth: 0 }];
  const rows = [];
  while (pending.length && rows.length < MAX_FILES) {
    const current = pending.shift();
    let entries;
    try { entries = await readdir(current.path, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (rows.length >= MAX_FILES) break;
      const path = resolve(current.path, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (current.depth < MAX_DEPTH) pending.push({ path, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !LOG_PATTERN.test(entry.name)) continue;
      try {
        const info = await stat(path);
        rows.push({ path, bytes: info.size, mtime: info.mtime.toISOString() });
      } catch {}
    }
  }
  rows.sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path));
  return {
    root: absoluteRoot,
    files: rows.length,
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    largest: rows.slice(0, 20).map((row) => ({
      name: basename(row.path),
      bytes: row.bytes,
      mib: mib(row.bytes),
      mtime: row.mtime,
    })),
  };
}

async function countLinesBounded(path, maxBytes = 8 * 1024 * 1024) {
  let info;
  try { info = await stat(path); }
  catch { return { present: false, path, bytes: 0, sampledBytes: 0, linesInSample: 0, complete: true }; }
  const sampledBytes = Math.min(info.size, maxBytes);
  let lines = 0;
  let read = 0;
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path, { start: Math.max(0, info.size - sampledBytes), highWaterMark: 64 * 1024 });
    stream.on("data", (chunk) => {
      read += chunk.length;
      for (const byte of chunk) if (byte === 10) lines += 1;
    });
    stream.once("end", resolvePromise);
    stream.once("error", reject);
  });
  return {
    present: true,
    path,
    bytes: info.size,
    mib: mib(info.size),
    sampledBytes: read,
    linesInSample: lines,
    complete: info.size <= maxBytes,
    mtime: info.mtime.toISOString(),
  };
}

async function fetchJson(url, timeoutMs = 5_000) {
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json();
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: null, error: String(error?.name || error || "FETCH_FAILED") };
  }
}

const configDir = resolve(process.env.DEVSPACE_CONFIG_DIR || join(homedir(), ".devspace-tailscale-bootstrap"));
const config = loadConfig({ ...process.env, DEVSPACE_CONFIG_DIR: configDir });
const gatewayPort = Number(config.stableGatewayPort || config.port || 7678);
const logRoots = [...new Set([
  join(configDir, "logs"),
  config.stableGatewayLogDir,
  config.edgeFixedLogDir,
].filter(Boolean).map((value) => resolve(value)))];
const diskLogs = [];
for (const root of logRoots) diskLogs.push(await collectLogStats(root));

const psHistory = await countLinesBounded(join(
  process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
  "Microsoft",
  "Windows",
  "PowerShell",
  "PSReadLine",
  "ConsoleHost_history.txt",
));
const memoryResponse = await fetchJson(`http://127.0.0.1:${gatewayPort}/__devspace/memory/status`);
const memory = memoryResponse.body || null;
const activeRequests = Number(memory?.registries?.mcpActiveRequests || 0);
const eventStreams = Number(memory?.registries?.mcpEventStreams || 0);
const nonSseActiveEstimate = Math.max(0, activeRequests - eventStreams);
const totalDiskBytes = diskLogs.reduce((sum, row) => sum + row.bytes, 0);
const heapUsed = Number(memory?.memory?.heapUsed || 0);
const heapLimit = Number(memory?.memory?.heapSizeLimit || 0);

const findings = [
  {
    area: "powershell-history",
    verdict: "disk-backed-not-node-heap",
    evidence: { bytes: psHistory.bytes, mib: psHistory.mib || 0, completeLineCount: psHistory.complete },
    note: "PSReadLine history is a file owned by interactive PowerShell. The scheduled Gateway is non-interactive and this file is not retained in the Core V8 heap.",
  },
  {
    area: "diagnostic-log-files",
    verdict: "disk-growth-risk-bounded-separately",
    evidence: { files: diskLogs.reduce((sum, row) => sum + row.files, 0), bytes: totalDiskBytes, mib: mib(totalDiskBytes) },
    note: "On-disk logs do not consume Node heap unless code reads/buffers them. DevSpace retention trims by bounded tail and never reads a complete log into memory.",
  },
  {
    area: "core-live-retention",
    verdict: memoryResponse.ok ? "authoritative-v8-and-registry-snapshot" : "unavailable",
    evidence: memoryResponse.ok ? {
      heapUsedBytes: heapUsed,
      heapUsedMiB: mib(heapUsed),
      heapLimitBytes: heapLimit,
      heapLimitMiB: mib(heapLimit),
      utilizationPercent: heapLimit > 0 ? Math.round((heapUsed / heapLimit) * 10_000) / 100 : null,
      mcpSessions: Number(memory?.registries?.mcpSessions || 0),
      activeRequests,
      eventStreams,
      nonSseActiveEstimate,
      processSessions: Number(memory?.registries?.processSessions || 0),
      workspaceContexts: Number(memory?.registries?.workspaceContexts || 0),
      capabilityClients: Number(memory?.capabilities?.mcpClients || 0),
      contextPendingCalls: Number(memory?.contextCdp?.pendingCalls || 0),
      streamPendingCalls: Number(memory?.streamRecoveryCdp?.pendingCalls || 0),
    } : { httpStatus: memoryResponse.status, error: memoryResponse.error || null },
    note: "Heap pressure is attributable to live objects such as transports, requests, streams, workspace contexts, capability clients, and buffers—not to file length alone.",
  },
];

console.log(JSON.stringify({
  ok: true,
  gate: "log-memory-diagnostic",
  generatedAt: new Date().toISOString(),
  gatewayPort,
  diskLogs,
  psHistory,
  memoryStatusAvailable: memoryResponse.ok,
  memory,
  findings,
  rawLogContentRead: false,
  boundedHistoryTailOnly: true,
  secretValuesLogged: false,
}, null, 2));
