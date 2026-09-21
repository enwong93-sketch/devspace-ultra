export function assessVerifiedHandoverReadiness({ quiet, status } = {}) {
  if (quiet?.ok === true) {
    return {
      ok: true,
      mode: "pre-quiet",
      admissionActive: Number(status?.admission?.activeRequests || 0),
      sessionNonStreamActive: Number(status?.sessions?.totalNonStreamActiveRequests || 0),
    };
  }
  const sessionCount = Array.isArray(status?.sessions?.sessions)
    ? status.sessions.sessions.length
    : 0;
  const healthy = status?.ok === true
    && status?.fatal !== true
    && status?.handoverInProgress !== true
    && status?.coreRecoveryInProgress !== true
    && status?.admission?.closed !== true
    && sessionCount > 0;
  if (!healthy) {
    return {
      ok: false,
      mode: "refused",
      reason: sessionCount < 1 ? "no-live-mcp-session" : "gateway-not-ready",
    };
  }
  // The controller itself closes admission before drain and preserves every
  // current request. Continuing after a short pre-quiet window avoids
  // starvation when several interactive Mains continuously submit work; it
  // does not bypass the controller's authoritative barrier or replay checks.
  return {
    ok: true,
    mode: "controller-admission-drain",
    admissionActive: Number(status.admission?.activeRequests || 0),
    sessionNonStreamActive: Number(status.sessions?.totalNonStreamActiveRequests || 0),
    sessionCount,
  };
}
