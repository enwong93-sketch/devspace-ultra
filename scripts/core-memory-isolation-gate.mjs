#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const mode = String(process.argv[2] || "baseline").toLowerCase();
const durationSeconds = Math.max(20, Math.min(600, Number(process.argv[3] || 90)));
const intervalMs = 5_000;
const heapLimitMb = 512;
const modes = {
  baseline: { context: false, stream: false, overlay: false },
  context: { context: true, stream: false, overlay: false },
  stream: { context: false, stream: true, overlay: false },
  "context-stream": { context: true, stream: true, overlay: false },
  "context-overlay": { context: true, stream: false, overlay: true },
  "full-observer": { context: true, stream: true, overlay: true },
};
if (!modes[mode]) throw new Error(`Unknown mode ${mode}. Expected one of: ${Object.keys(modes).join(", ")}`);

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const port = Number(server.address().port);
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

async function waitForHealth(baseUrl, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "not-ready";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Isolation Core exited before readiness (code ${child.exitCode}).`);
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1_000), cache: "no-store" });
      if (response.ok) return;
      last = `health-${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.name : String(error);
    }
    await sleep(150);
  }
  throw new Error(`Isolation Core readiness timed out (${last}).`);
}

function appendTail(current, chunk, max = 64_000) {
  const next = current + String(chunk || "");
  return next.length > max ? next.slice(-max) : next;
}

function mb(bytes) { return Math.round((Number(bytes || 0) / 1024 / 1024) * 10) / 10; }

const stateDir = await mkdtemp(join(tmpdir(), `devspace-memory-${mode}-`));
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const feature = modes[mode];
const configDir = process.env.DEVSPACE_CANARY_SOURCE_CONFIG_DIR || join(homedir(), ".devspace-tailscale-bootstrap");
const env = {
  ...process.env,
  PORT: String(port),
  DEVSPACE_CONFIG_DIR: configDir,
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_PUBLIC_BASE_URL: "https://memory-isolation.invalid",
  DEVSPACE_ALLOWED_HOSTS: "localhost,127.0.0.1,::1,memory-isolation.invalid",
  DEVSPACE_OAUTH_SCOPES: "devspace,offline_access",
  DEVSPACE_PASSIVE_CORE: "false",
  DEVSPACE_CONTEXT_GUARDIAN: feature.context ? "true" : "false",
  DEVSPACE_CLASSIC_STREAM_RECOVERY: feature.stream ? "true" : "false",
  DEVSPACE_CLASSIC_HOST_OVERLAY: feature.overlay ? "true" : "false",
  DEVSPACE_AUTO_COMPACT: "false",
  DEVSPACE_PLUGINS: "false",
  DEVSPACE_SUBAGENTS: "false",
  DEVSPACE_SKILLS: "false",
  DEVSPACE_ARTIFACTS: "false",
  DEVSPACE_LOG_REQUESTS: "false",
  DEVSPACE_LOG_TOOL_CALLS: "false",
};

let stdoutTail = "";
let stderrTail = "";
const child = spawn(process.execPath, [`--max-old-space-size=${heapLimitMb}`, "dist/cli.js", "serve"], {
  cwd: packageRoot,
  env,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => { stdoutTail = appendTail(stdoutTail, chunk); });
child.stderr.on("data", (chunk) => { stderrTail = appendTail(stderrTail, chunk); });

const samples = [];
try {
  await waitForHealth(baseUrl, child);
  const startedAt = Date.now();
  const deadline = startedAt + durationSeconds * 1_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Isolation Core exited during soak (code ${child.exitCode}).\n${stderrTail}`);
    const response = await fetch(`${baseUrl}/__devspace/memory/status`, { signal: AbortSignal.timeout(2_000), cache: "no-store" });
    assert.equal(response.status, 200, `memory status HTTP ${response.status}`);
    const snapshot = await response.json();
    samples.push({
      t: Math.round((Date.now() - startedAt) / 1000),
      heapUsed: Number(snapshot?.memory?.heapUsed || 0),
      heapTotal: Number(snapshot?.memory?.heapTotal || 0),
      rss: Number(snapshot?.memory?.rss || 0),
      mcpSessions: Number(snapshot?.registries?.mcpSessions || 0),
      processSessions: Number(snapshot?.registries?.processSessions || 0),
      contextConnected: Number(snapshot?.contextCdp?.connected || 0),
      contextPending: Number(snapshot?.contextCdp?.pendingCalls || 0),
      usagePending: Number(snapshot?.contextCdp?.pendingUsageRequests || 0),
      identityPending: Number(snapshot?.contextCdp?.pendingIdentityCorrelations || 0),
      streamConnected: Number(snapshot?.streamRecoveryCdp?.connected || 0),
      streamPending: Number(snapshot?.streamRecoveryCdp?.pendingCalls || 0),
      trackedUrls: Number(snapshot?.streamRecoveryCdp?.trackedRequestUrls || 0),
    });
    await sleep(intervalMs);
  }
  const first = samples[0];
  const last = samples.at(-1);
  const minHeap = Math.min(...samples.map((sample) => sample.heapUsed));
  const maxHeap = Math.max(...samples.map((sample) => sample.heapUsed));
  const minRss = Math.min(...samples.map((sample) => sample.rss));
  const maxRss = Math.max(...samples.map((sample) => sample.rss));
  console.log(JSON.stringify({
    ok: child.exitCode === null,
    gate: "core-memory-isolation",
    mode,
    durationSeconds,
    heapLimitMb,
    samples: samples.length,
    first: { ...first, heapUsedMb: mb(first.heapUsed), rssMb: mb(first.rss) },
    last: { ...last, heapUsedMb: mb(last.heapUsed), rssMb: mb(last.rss) },
    range: {
      heapMinMb: mb(minHeap),
      heapMaxMb: mb(maxHeap),
      heapGrowthMb: mb(last.heapUsed - first.heapUsed),
      rssMinMb: mb(minRss),
      rssMaxMb: mb(maxRss),
      rssGrowthMb: mb(last.rss - first.rss),
    },
    maxObserved: {
      contextPending: Math.max(...samples.map((sample) => sample.contextPending)),
      usagePending: Math.max(...samples.map((sample) => sample.usagePending)),
      identityPending: Math.max(...samples.map((sample) => sample.identityPending)),
      streamPending: Math.max(...samples.map((sample) => sample.streamPending)),
      trackedUrls: Math.max(...samples.map((sample) => sample.trackedUrls)),
    },
  }));
} finally {
  try { child.kill("SIGTERM"); } catch {}
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    sleep(3_000),
  ]).catch(() => {});
  await rm(stateDir, { recursive: true, force: true }).catch(() => {});
}
