#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadDevspaceFiles } from "../dist/user-config.js";

const durationSeconds = Math.max(30, Number(process.argv[2] || 300));
const sampleSeconds = Math.max(1, Number(process.argv[3] || 5));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const files = loadDevspaceFiles();
const logRoot = join(files.dir, "logs", "stable-gateway");
const descriptorPath = join(files.config?.stableGatewayStateDir || files.config?.stateDir, "stable-gateway-session-descriptors.json");

async function activeCore() {
  for (const port of [
    Number(files.config?.stableGatewayCoreAPort || 7688),
    Number(files.config?.stableGatewayCoreBPort || 7689),
  ]) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/__devspace/memory/status`, { cache: "no-store" });
      const body = await response.json();
      if (response.ok && body?.ok === true) return { port, body };
    } catch {}
  }
  throw new Error("No healthy Stable Gateway Core is available.");
}

async function gatewayHealth() {
  const response = await fetch(`http://127.0.0.1:${Number(files.config?.stableGatewayPort || 7678)}/healthz`, { cache: "no-store" });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok !== true) throw new Error(`Gateway health failed with HTTP ${response.status}.`);
  return body;
}

async function fileBoundary(path) {
  try { return (await stat(path)).size; }
  catch { return 0; }
}

async function appendedText(path, boundary) {
  try {
    const data = await readFile(path);
    return data.subarray(Math.min(boundary, data.length)).toString("utf8");
  } catch { return ""; }
}

async function descriptorSnapshot() {
  try {
    const text = await readFile(descriptorPath, "utf8");
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
    return { bytes: Buffer.byteLength(text), count: Array.isArray(parsed?.descriptors) ? parsed.descriptors.length : 0 };
  } catch { return { bytes: 0, count: 0 }; }
}

await gatewayHealth();
const baseline = await activeCore();
const coreId = baseline.port === Number(files.config?.stableGatewayCoreBPort || 7689) ? "core-b" : "core-a";
const errorPath = join(logRoot, `${coreId}.err.log`);
const logBoundary = await fileBoundary(errorPath);
const descriptorBaseline = await descriptorSnapshot();
const samples = [];
const startedAt = Date.now();

while (Date.now() - startedAt < durationSeconds * 1000) {
  await gatewayHealth();
  const current = await activeCore();
  if (current.body.pid !== baseline.body.pid || current.port !== baseline.port) {
    throw new Error(`Core identity changed during soak: ${baseline.body.pid}@${baseline.port} -> ${current.body.pid}@${current.port}.`);
  }
  samples.push({
    at: new Date().toISOString(),
    rss: Number(current.body.memory?.rss || 0),
    heapUsed: Number(current.body.memory?.heapUsed || 0),
    heapLimit: Number(current.body.memory?.heapSizeLimit || 0),
    sessions: Number(current.body.registries?.mcpSessions || 0),
    eventStreams: Number(current.body.registries?.mcpEventStreams || 0),
    correlationWaiters: Number(current.body.registries?.mcpCallCorrelationWaiters || 0),
  });
  await sleep(sampleSeconds * 1000);
}

const appendedErrors = await appendedText(errorPath, logBoundary);
if (/JavaScript heap out of memory|FATAL ERROR: Reached heap limit/i.test(appendedErrors)) {
  throw new Error("A new Core OOM signature appeared during the production soak.");
}
if (/uncaughtException|unhandledRejection|ReferenceError:|SyntaxError:/i.test(appendedErrors)) {
  throw new Error(`A new fatal Core error appeared during the production soak:\n${appendedErrors.slice(-4000)}`);
}

const first = samples[0];
const last = samples.at(-1);
const maximumHeap = Math.max(...samples.map((sample) => sample.heapUsed));
const maximumWaiters = Math.max(...samples.map((sample) => sample.correlationWaiters));
const descriptorFinal = await descriptorSnapshot();
const allowedFinalGrowth = Math.max(256 * 1024 * 1024, first.heapUsed);
if (last.heapUsed - first.heapUsed > allowedFinalGrowth) {
  throw new Error(`Core heap retained excessive growth during soak: ${first.heapUsed} -> ${last.heapUsed}.`);
}
if (maximumWaiters > 128) {
  throw new Error(`Conversation correlation waiters exceeded the bounded ceiling: ${maximumWaiters}.`);
}
if (descriptorFinal.count > descriptorBaseline.count + 128) {
  throw new Error(`Persistent MCP descriptors grew unexpectedly: ${descriptorBaseline.count} -> ${descriptorFinal.count}.`);
}

console.log(JSON.stringify({
  ok: true,
  gate: "production-core-soak",
  durationSeconds,
  sampleSeconds,
  samples: samples.length,
  core: { pid: baseline.body.pid, port: baseline.port, stable: true },
  heap: {
    firstMB: Math.round(first.heapUsed / 1024 / 1024 * 10) / 10,
    lastMB: Math.round(last.heapUsed / 1024 / 1024 * 10) / 10,
    maximumMB: Math.round(maximumHeap / 1024 / 1024 * 10) / 10,
    limitMB: Math.round(first.heapLimit / 1024 / 1024 * 10) / 10,
  },
  descriptors: { before: descriptorBaseline, after: descriptorFinal },
  maximumCorrelationWaiters: maximumWaiters,
  newOomSignatures: 0,
  newFatalCoreErrors: 0,
}));
