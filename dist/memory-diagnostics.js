import { getHeapStatistics } from "node:v8";

function finiteNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function safeStatus(source) {
  try {
    return typeof source?.status === "function" ? source.status() || {} : {};
  } catch {
    return {};
  }
}

function safeDiagnostics(source) {
  try {
    return typeof source?.diagnostics === "function" ? source.diagnostics() || {} : {};
  } catch {
    return {};
  }
}

export function runPassiveDiagnosticGc({ requested = false, passiveCore = false, gc = globalThis.gc } = {}) {
  if (!requested) return { requested: false, performed: false, reason: "not-requested" };
  if (!passiveCore) return { requested: true, performed: false, reason: "active-core-forbidden" };
  if (typeof gc !== "function") return { requested: true, performed: false, reason: "gc-unavailable" };
  gc();
  gc();
  return { requested: true, performed: true, reason: null };
}

export function createMemoryDiagnostics({
  transports,
  processSessions,
  workspaces,
  capabilityRuntime,
  turnTransportObserver,
  mcpCallCorrelator,
  contextMetadataAdapter,
  streamRecoveryAdapter,
  config = {},
  memoryUsage = process.memoryUsage,
  heapStatistics = getHeapStatistics,
  pid = process.pid,
  uptime = process.uptime,
} = {}) {
  const memory = memoryUsage();
  const heap = heapStatistics();
  const mcp = safeDiagnostics(transports);
  const capabilities = safeDiagnostics(capabilityRuntime);
  const turn = safeStatus(turnTransportObserver);
  const callCorrelation = safeDiagnostics(mcpCallCorrelator);
  const context = safeStatus(contextMetadataAdapter);
  const stream = safeStatus(streamRecoveryAdapter);
  const contextRuntimes = Array.isArray(context?.runtimes) ? context.runtimes : [];
  const streamRuntimes = Array.isArray(stream?.runtimes) ? stream.runtimes : [];
  const debugPorts = Array.isArray(config?.classicMainDebugPorts)
    ? config.classicMainDebugPorts.map((port) => Number(port)).filter(Number.isInteger)
    : [];

  return {
    ok: true,
    pid: finiteNumber(pid),
    uptimeSeconds: Math.floor(finiteNumber(uptime())),
    memory: {
      rss: finiteNumber(memory?.rss),
      heapTotal: finiteNumber(memory?.heapTotal),
      heapUsed: finiteNumber(memory?.heapUsed),
      heapSizeLimit: finiteNumber(heap?.heap_size_limit),
      external: finiteNumber(memory?.external),
      arrayBuffers: finiteNumber(memory?.arrayBuffers),
    },
    registries: {
      mcpSessions: finiteNumber(mcp?.sessions),
      mcpActiveRequests: finiteNumber(mcp?.activeRequests),
      mcpEventStreams: finiteNumber(mcp?.eventStreams),
      mcpEventStreamsClosing: finiteNumber(mcp?.eventStreamsClosing),
      mcpMaxEventStreams: finiteNumber(mcp?.maxEventStreams),
      mcpOldestActivityAgeMs: finiteNumber(mcp?.oldestActivityAgeMs),
      mcpNewestActivityAgeMs: finiteNumber(mcp?.newestActivityAgeMs),
      processSessions: finiteNumber(processSessions?.sessions?.size),
      workspaceContexts: finiteNumber(workspaces?.inMemorySize),
      nativeMcpCallsPending: finiteNumber(callCorrelation?.nativePending),
      gatewayMcpCallsPending: finiteNumber(callCorrelation?.gatewayPending),
      mcpCallCorrelationsResolved: finiteNumber(callCorrelation?.recentResolved),
      mcpCallCorrelationWaiters: finiteNumber(callCorrelation?.waiters),
      mcpCallCorrelationAmbiguities: finiteNumber(callCorrelation?.ambiguousMatches),
    },
    capabilities: {
      enabled: capabilities?.enabled === true,
      discoveredPlugins: finiteNumber(capabilities?.discoveredPlugins),
      mcpClients: finiteNumber(capabilities?.mcpClients),
      mcpConnecting: finiteNumber(capabilities?.mcpConnecting),
      mcpStartupTails: finiteNumber(capabilities?.mcpStartupTails),
      mcpInstances: finiteNumber(capabilities?.mcpInstances),
    },
    turnTransportCdp: {
      connected: finiteNumber(turn?.connected),
      pending: finiteNumber(turn?.pending),
    },
    contextCdp: {
      connected: finiteNumber(context?.connected),
      pendingCalls: contextRuntimes.reduce((sum, runtime) => sum + finiteNumber(runtime?.pendingCdpCalls), 0),
      pendingUsageRequests: contextRuntimes.reduce((sum, runtime) => sum + finiteNumber(runtime?.pendingUsageRequests), 0),
      pendingIdentityCorrelations: contextRuntimes.reduce((sum, runtime) => sum + finiteNumber(runtime?.pendingIdentityCorrelations), 0),
    },
    streamRecoveryCdp: {
      connected: finiteNumber(stream?.connected),
      pendingCalls: streamRuntimes.reduce((sum, runtime) => sum + finiteNumber(runtime?.pendingCdpCalls), 0),
      trackedRequestUrls: streamRuntimes.reduce((sum, runtime) => sum + finiteNumber(runtime?.trackedRequestUrls), 0),
    },
    features: {
      passiveCore: config?.passiveCore === true,
      pluginsEnabled: config?.pluginsEnabled === true,
      skillsEnabled: config?.skillsEnabled === true,
      artifactsEnabled: config?.artifactsEnabled === true,
      contextGuardianEnabled: config?.contextGuardianEnabled === true,
      classicHostOverlayEnabled: config?.classicHostOverlayEnabled === true,
      classicStreamRecoveryEnabled: config?.classicStreamRecoveryEnabled === true,
      autoCompactEnabled: config?.autoCompactEnabled === true,
      classicMainDebugPorts: debugPorts,
    },
  };
}
