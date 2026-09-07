const MIB = 1024 * 1024;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function linearSlopePerMinute(rows, selector) {
  if (!Array.isArray(rows) || rows.length < 2) return 0;
  const origin = finite(rows[0]?.observedAtMs);
  const points = rows.map((row) => ({
    x: (finite(row?.observedAtMs) - origin) / 60_000,
    y: finite(selector(row)),
  }));
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    numerator += (point.x - meanX) * (point.y - meanY);
    denominator += (point.x - meanX) ** 2;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

function pendingCount(sample) {
  return finite(sample?.turnPending)
    + finite(sample?.contextPending)
    + finite(sample?.streamPending)
    + finite(sample?.capabilityConnecting)
    + finite(sample?.capabilityStartupTails);
}

export function isRetentionIdleSample(sample) {
  const activeRequests = finite(sample?.activeRequests);
  const eventStreams = finite(sample?.eventStreams);
  const nonSseActive = Math.max(0, finite(sample?.nonSseActive, activeRequests - eventStreams));
  return nonSseActive === 0
    && finite(sample?.processSessions) === 0
    && pendingCount(sample) === 0;
}

export function analyzeMemoryRetention(samples, {
  maxHeapUtilization = 0.95,
  maxSessions = 40,
  maxEventStreams = 40,
  minIdleSamples = 4,
  maxIdleNetGrowthBytes = 64 * MIB,
  maxIdleSlopeBytesPerMinute = 4 * MIB,
} = {}) {
  const rows = (Array.isArray(samples) ? samples : [])
    .filter((row) => Number.isFinite(Number(row?.observedAtMs)))
    .sort((left, right) => Number(left.observedAtMs) - Number(right.observedAtMs));
  if (!rows.length) throw new Error("At least one production memory sample is required.");

  const capBreaches = [];
  for (const row of rows) {
    const heapUsed = finite(row.heapUsed);
    const heapLimit = finite(row.heapLimit);
    const utilization = heapLimit > 0 ? heapUsed / heapLimit : null;
    if (!heapLimit || utilization >= maxHeapUtilization) {
      capBreaches.push({ observedAt: row.observedAt, type: "heap-utilization", value: utilization });
    }
    if (finite(row.sessions) > maxSessions) {
      capBreaches.push({ observedAt: row.observedAt, type: "mcp-sessions", value: finite(row.sessions) });
    }
    if (finite(row.eventStreams) > finite(row.maxEventStreams, maxEventStreams)) {
      capBreaches.push({ observedAt: row.observedAt, type: "event-streams", value: finite(row.eventStreams) });
    }
  }

  const idleRows = rows.filter(isRetentionIdleSample);
  const idleFirst = idleRows[0] || null;
  const idleLast = idleRows.at(-1) || null;
  const idleNetGrowthBytes = idleRows.length >= 2
    ? finite(idleLast.heapUsed) - finite(idleFirst.heapUsed)
    : null;
  const idleSlopeBytesPerMinute = idleRows.length >= 2
    ? linearSlopePerMinute(idleRows, (row) => row.heapUsed)
    : null;
  const sustainedIdleGrowth = idleRows.length >= minIdleSamples
    && idleNetGrowthBytes > maxIdleNetGrowthBytes
    && idleSlopeBytesPerMinute > maxIdleSlopeBytesPerMinute;

  const peakHeapUsed = Math.max(...rows.map((row) => finite(row.heapUsed)));
  const peakHeapLimit = Math.max(...rows.map((row) => finite(row.heapLimit)));
  const peakHeapUtilization = Math.max(...rows.map((row) => {
    const limit = finite(row.heapLimit);
    return limit > 0 ? finite(row.heapUsed) / limit : 1;
  }));
  const conclusion = capBreaches.length
    ? "hard-bound-breach"
    : sustainedIdleGrowth
      ? "suspected-idle-retention-growth"
      : idleRows.length >= minIdleSamples
        ? "bounded-during-idle"
        : "busy-observation-hard-bounds-only";

  return {
    ok: capBreaches.length === 0 && !sustainedIdleGrowth,
    conclusion,
    sampleCount: rows.length,
    durationMs: Math.max(0, finite(rows.at(-1).observedAtMs) - finite(rows[0].observedAtMs)),
    idleSampleCount: idleRows.length,
    busySampleCount: rows.length - idleRows.length,
    peak: {
      heapUsedBytes: peakHeapUsed,
      heapUsedMiB: Math.round((peakHeapUsed / MIB) * 10) / 10,
      heapLimitBytes: peakHeapLimit,
      heapLimitMiB: Math.round((peakHeapLimit / MIB) * 10) / 10,
      utilizationPercent: Math.round(peakHeapUtilization * 10_000) / 100,
      sessions: Math.max(...rows.map((row) => finite(row.sessions))),
      activeRequests: Math.max(...rows.map((row) => finite(row.activeRequests))),
      eventStreams: Math.max(...rows.map((row) => finite(row.eventStreams))),
      processSessions: Math.max(...rows.map((row) => finite(row.processSessions))),
    },
    idle: {
      netGrowthBytes: idleNetGrowthBytes,
      netGrowthMiB: idleNetGrowthBytes == null ? null : Math.round((idleNetGrowthBytes / MIB) * 10) / 10,
      slopeBytesPerMinute: idleSlopeBytesPerMinute,
      slopeMiBPerMinute: idleSlopeBytesPerMinute == null ? null : Math.round((idleSlopeBytesPerMinute / MIB) * 100) / 100,
      sustainedGrowth: sustainedIdleGrowth,
    },
    thresholds: {
      maxHeapUtilization,
      maxSessions,
      maxEventStreams,
      minIdleSamples,
      maxIdleNetGrowthBytes,
      maxIdleSlopeBytesPerMinute,
    },
    capBreaches,
  };
}
