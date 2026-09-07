#!/usr/bin/env node
import { analyzeMemoryRetention } from "../dist/memory-retention-analysis.js";

const durationSeconds = Math.max(30, Math.min(300, Number(process.argv[2] || 180)));
const intervalSeconds = Math.max(5, Math.min(60, Number(process.argv[3] || 15)));
const gatewayPort = Math.max(1, Math.min(65535, Number(process.env.DEVSPACE_STABLE_GATEWAY_PORT || 7678)));
const memoryUrl = `http://127.0.0.1:${gatewayPort}/__devspace/memory/status`;
const healthUrl = `http://127.0.0.1:${gatewayPort}/__devspace/gateway/healthz`;

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function json(url) {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return await response.json();
}

function normalizeSample(payload, observedAtMs) {
  const registries = payload?.registries || {};
  const capabilities = payload?.capabilities || {};
  const turn = payload?.turnTransportCdp || {};
  const context = payload?.contextCdp || {};
  const stream = payload?.streamRecoveryCdp || {};
  const activeRequests = Number(registries.mcpActiveRequests || 0);
  const eventStreams = Number(registries.mcpEventStreams || 0);
  return {
    observedAtMs,
    observedAt: new Date(observedAtMs).toISOString(),
    pid: Number(payload?.pid || 0),
    uptimeSeconds: Number(payload?.uptimeSeconds || 0),
    heapUsed: Number(payload?.memory?.heapUsed || 0),
    heapTotal: Number(payload?.memory?.heapTotal || 0),
    heapLimit: Number(payload?.memory?.heapSizeLimit || 0),
    rss: Number(payload?.memory?.rss || 0),
    sessions: Number(registries.mcpSessions || 0),
    activeRequests,
    eventStreams,
    nonSseActive: Math.max(0, activeRequests - eventStreams),
    maxEventStreams: Number(registries.mcpMaxEventStreams || 40),
    eventStreamsClosing: Number(registries.mcpEventStreamsClosing || 0),
    processSessions: Number(registries.processSessions || 0),
    workspaceContexts: Number(registries.workspaceContexts || 0),
    capabilityClients: Number(capabilities.mcpClients || 0),
    capabilityConnecting: Number(capabilities.mcpConnecting || 0),
    capabilityStartupTails: Number(capabilities.mcpStartupTails || 0),
    capabilityInstances: Number(capabilities.mcpInstances || 0),
    turnPending: Number(turn.pending || 0),
    contextPending: Number(context.pendingCalls || 0) + Number(context.pendingUsageRequests || 0) + Number(context.pendingIdentityCorrelations || 0),
    streamPending: Number(stream.pendingCalls || 0),
  };
}

const startedAt = Date.now();
const deadline = startedAt + durationSeconds * 1_000;
const samples = [];
let expectedPid = null;
while (true) {
  const observedAtMs = Date.now();
  const [health, memory] = await Promise.all([json(healthUrl), json(memoryUrl)]);
  if (health?.ok !== true) throw new Error("Stable Gateway was not ready during the production memory soak.");
  const sample = normalizeSample(memory, observedAtMs);
  if (!sample.pid || !sample.heapLimit) throw new Error("Production memory diagnostics omitted pid or heap limit.");
  expectedPid ??= sample.pid;
  if (sample.pid !== expectedPid) throw new Error(`Core PID changed during retention soak (${expectedPid} -> ${sample.pid}).`);
  samples.push(sample);
  if (observedAtMs >= deadline) break;
  await sleep(Math.min(intervalSeconds * 1_000, Math.max(0, deadline - observedAtMs)));
}

const analysis = analyzeMemoryRetention(samples, {
  maxHeapUtilization: 0.95,
  maxSessions: 40,
  maxEventStreams: 40,
  minIdleSamples: 4,
  maxIdleNetGrowthBytes: 64 * 1024 * 1024,
  maxIdleSlopeBytesPerMinute: 4 * 1024 * 1024,
});
const compactSamples = samples.map((sample) => ({
  observedAt: sample.observedAt,
  pid: sample.pid,
  heapUsedMiB: Math.round((sample.heapUsed / 1024 / 1024) * 10) / 10,
  heapLimitMiB: Math.round((sample.heapLimit / 1024 / 1024) * 10) / 10,
  rssMiB: Math.round((sample.rss / 1024 / 1024) * 10) / 10,
  sessions: sample.sessions,
  activeRequests: sample.activeRequests,
  eventStreams: sample.eventStreams,
  nonSseActive: sample.nonSseActive,
  processSessions: sample.processSessions,
  workspaceContexts: sample.workspaceContexts,
  capabilityClients: sample.capabilityClients,
  pending: sample.turnPending + sample.contextPending + sample.streamPending + sample.capabilityConnecting + sample.capabilityStartupTails,
}));

const result = {
  ok: analysis.ok,
  gate: "production-memory-retention-soak",
  gatewayPort,
  corePid: expectedPid,
  durationSeconds,
  intervalSeconds,
  analysis,
  samples: compactSamples,
  rawRequestsPersisted: false,
  rawResponsesPersisted: false,
  rawLogContentRead: false,
  secretValuesLogged: false,
};
console.log(JSON.stringify(result));
if (!analysis.ok) process.exitCode = 1;
