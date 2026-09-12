import assert from "node:assert/strict";
import { createMemoryDiagnostics, runPassiveDiagnosticGc } from "./memory-diagnostics.js";

const snapshot = createMemoryDiagnostics({
  transports: {
    diagnostics() {
      return {
        sessions: 7,
        activeRequests: 2,
        eventStreams: 3,
        eventStreamsClosing: 1,
        maxEventStreams: 40,
        oldestActivityAgeMs: 1200,
        newestActivityAgeMs: 10,
      };
    },
  },
  processSessions: { sessions: new Map([["process-1", {}]]) },
  workspaces: { inMemorySize: 4 },
  capabilityRuntime: {
    diagnostics() {
      return {
        enabled: true,
        discoveredPlugins: 2,
        mcpClients: 1,
        mcpConnecting: 0,
        mcpStartupTails: 0,
        mcpInstances: 1,
      };
    },
  },
  turnTransportObserver: {
    status() { return { connected: 1, pending: 2 }; },
  },
  mcpCallCorrelator: {
    diagnostics() {
      return {
        nativePending: 3,
        gatewayPending: 4,
        recentResolved: 5,
        waiters: 1,
        ambiguousMatches: 2,
      };
    },
  },
  activeTurnRegistry: {
    diagnostics() {
      return {
        activeTurns: 1,
        postTurnTurns: 2,
        trackedTurns: 3,
        waiters: 4,
        turnsWithTrace: 2,
        turnsWithRequestTrace: 3,
        turnsWithSessionAliases: 3,
        transportFinishedTurns: 1,
        placeholderOnlyTurns: 1,
        waitersWithTrace: 3,
        waitersWithRequestTrace: 2,
        waitersWithSessionAliases: 4,
        recentResolved: 5,
        ambiguousMatches: 6,
        postTurnGraceMs: 120000,
      };
    },
  },
  directRequestAuthorityRegistry: {
    diagnostics() {
      return {
        records: 2,
        conversations: 1,
        resolved: 7,
        ambiguousMatches: 3,
        ttlMs: 21600000,
      };
    },
  },
  contextMetadataAdapter: {
    status() {
      return {
        connected: 1,
        runtimes: [{ pendingCdpCalls: 2, pendingUsageRequests: 3, pendingIdentityCorrelations: 4 }],
      };
    },
  },
  streamRecoveryAdapter: {
    status() {
      return {
        connected: 1,
        runtimes: [{ pendingCdpCalls: 5, trackedRequestUrls: 6 }],
      };
    },
  },
  config: {
    passiveCore: true,
    goalRoundRecoveryEnabled: false,
    pluginsEnabled: true,
    skillsEnabled: true,
    artifactsEnabled: true,
    contextGuardianEnabled: true,
    classicHostOverlayEnabled: true,
    classicStreamRecoveryEnabled: true,
    conversationProgressLivenessEnabled: true,
    conversationProgressReportSeconds: 600,
    conversationProgressContinueSeconds: 1200,
    autoCompactEnabled: false,
    classicMainDebugPorts: [19001],
  },
  memoryUsage: () => ({
    rss: 100,
    heapTotal: 80,
    heapUsed: 60,
    external: 20,
    arrayBuffers: 10,
  }),
  heapStatistics: () => ({ heap_size_limit: 512 * 1024 * 1024 }),
  pid: 1234,
  uptime: () => 12.8,
});

assert.equal(snapshot.ok, true);
assert.equal(snapshot.pid, 1234);
assert.equal(snapshot.uptimeSeconds, 12);
assert.equal(snapshot.memory.heapSizeLimit, 512 * 1024 * 1024);
assert.equal(snapshot.registries.mcpSessions, 7);
assert.equal(snapshot.registries.mcpActiveRequests, 2);
assert.equal(snapshot.registries.processSessions, 1);
assert.equal(snapshot.registries.workspaceContexts, 4);
assert.equal(snapshot.registries.nativeMcpCallsPending, 3);
assert.equal(snapshot.registries.gatewayMcpCallsPending, 4);
assert.equal(snapshot.registries.mcpCallCorrelationsResolved, 5);
assert.equal(snapshot.registries.mcpCallCorrelationWaiters, 1);
assert.equal(snapshot.registries.mcpCallCorrelationAmbiguities, 2);
assert.equal(snapshot.registries.classicActiveTurns, 1);
assert.equal(snapshot.registries.classicPostTurnTurns, 2);
assert.equal(snapshot.registries.classicTrackedTurns, 3);
assert.equal(snapshot.registries.classicActiveTurnWaiters, 4);
assert.equal(snapshot.registries.classicTurnsWithTrace, 2);
assert.equal(snapshot.registries.classicTurnsWithRequestTrace, 3);
assert.equal(snapshot.registries.classicTurnsWithSessionAliases, 3);
assert.equal(snapshot.registries.classicTransportFinishedTurns, 1);
assert.equal(snapshot.registries.classicPlaceholderOnlyTurns, 1);
assert.equal(snapshot.registries.classicActiveTurnWaitersWithTrace, 3);
assert.equal(snapshot.registries.classicActiveTurnWaitersWithRequestTrace, 2);
assert.equal(snapshot.registries.classicActiveTurnWaitersWithSessionAliases, 4);
assert.equal(snapshot.registries.classicActiveTurnCorrelationsResolved, 5);
assert.equal(snapshot.registries.classicActiveTurnAmbiguities, 6);
assert.equal(snapshot.registries.classicPostTurnGraceMs, 120000);
assert.equal(snapshot.registries.directRequestAuthorities, 2);
assert.equal(snapshot.registries.directRequestAuthorityConversations, 1);
assert.equal(snapshot.registries.directRequestAuthorityResolved, 7);
assert.equal(snapshot.registries.directRequestAuthorityAmbiguities, 3);
assert.equal(snapshot.registries.directRequestAuthorityTtlMs, 21600000);
assert.equal(snapshot.capabilities.enabled, true);
assert.equal(snapshot.capabilities.mcpClients, 1);
assert.equal(snapshot.turnTransportCdp.connected, 1);
assert.equal(snapshot.turnTransportCdp.pending, 2);
assert.equal(snapshot.contextCdp.pendingCalls, 2);
assert.equal(snapshot.contextCdp.pendingUsageRequests, 3);
assert.equal(snapshot.contextCdp.pendingIdentityCorrelations, 4);
assert.equal(snapshot.streamRecoveryCdp.pendingCalls, 5);
assert.equal(snapshot.streamRecoveryCdp.trackedRequestUrls, 6);
assert.deepEqual(snapshot.features.classicMainDebugPorts, [19001]);
assert.equal(snapshot.features.passiveCore, true);
assert.equal(snapshot.features.goalRoundRecoveryEnabled, false);
assert.equal(snapshot.features.conversationProgressLivenessEnabled, true);
assert.equal(snapshot.features.conversationProgressReportSeconds, 600);
assert.equal(snapshot.features.conversationProgressRescueSeconds, 1200);
assert.equal(snapshot.features.tenMinuteAutomaticReminder, false);
assert.equal(snapshot.features.twentyMinuteInterruptedTurnRescueOnly, true);
assert.equal(snapshot.features.autoCompactEnabled, false);

const empty = createMemoryDiagnostics({
  memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
  heapStatistics: () => ({ heap_size_limit: 1 }),
  uptime: () => 0,
});
assert.equal(empty.registries.mcpSessions, 0);
assert.equal(empty.capabilities.mcpClients, 0);
assert.equal(empty.turnTransportCdp.connected, 0);
assert.deepEqual(empty.features.classicMainDebugPorts, []);

let gcCalls = 0;
assert.deepEqual(runPassiveDiagnosticGc({ requested: false, passiveCore: true, gc: () => { gcCalls += 1; } }), {
  requested: false,
  performed: false,
  reason: "not-requested",
});
assert.deepEqual(runPassiveDiagnosticGc({ requested: true, passiveCore: false, gc: () => { gcCalls += 1; } }), {
  requested: true,
  performed: false,
  reason: "active-core-forbidden",
});
assert.deepEqual(runPassiveDiagnosticGc({ requested: true, passiveCore: true, gc: undefined }), {
  requested: true,
  performed: false,
  reason: "gc-unavailable",
});
assert.deepEqual(runPassiveDiagnosticGc({ requested: true, passiveCore: true, gc: () => { gcCalls += 1; } }), {
  requested: true,
  performed: true,
  reason: null,
});
assert.equal(gcCalls, 2, "passive diagnostic GC should run twice for a stable retained-heap sample");

console.log(JSON.stringify({
  ok: true,
  gate: "memory-diagnostics",
  actualTotalHeapLimit: true,
  capabilityLifecycleVisible: true,
  allClassicObserversVisible: true,
  nativeMcpCallCorrelationVisible: true,
  delayedPostTurnCorrelationVisible: true,
}));
