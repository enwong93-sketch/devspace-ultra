/**
 * Build the loopback-only Goal/Plan durability snapshot without exposing
 * objectives, reports, Plan text, conversation content, or credentials.
 */
function boundedPersistence(goalRuntime, planRuntime) {
  const counter = (value) => Math.max(0, Number(value || 0));
  const lastError = (value) => value == null ? null : String(value).slice(0, 300);
  return {
    goal: {
      lastError: lastError(goalRuntime?.lastPersistError),
      failureCount: counter(goalRuntime?.persistFailureCount),
      recoveryCount: counter(goalRuntime?.persistRecoveryCount),
    },
    plan: {
      lastError: lastError(planRuntime?.lastPersistError),
      failureCount: counter(planRuntime?.persistFailureCount),
      recoveryCount: counter(planRuntime?.persistRecoveryCount),
    },
  };
}

export function goalDurabilityDiagnostics({
  goalRoundCompletionGuard,
  goalRuntime,
  planRuntime,
} = {}) {
  if (!goalRoundCompletionGuard || typeof goalRoundCompletionGuard.status !== "function") {
    throw new Error("Goal round recovery diagnostics require a status-capable guard.");
  }
  return {
    goalRoundRecovery: goalRoundCompletionGuard.status(),
    statePersistence: boundedPersistence(goalRuntime, planRuntime),
    diagnosticsAvailable: true,
    diagnosticsError: null,
    rawStateReturned: false,
    rawConversationContentReturned: false,
  };
}

/**
 * Diagnostics must never take down the loopback health endpoint. The strict
 * helper above remains testable and fails loudly when an implementation drifts;
 * this wrapper converts that drift into bounded diagnostic evidence instead of
 * an HTTP 500 that hides every other subsystem's state.
 */
export function safeGoalDurabilityDiagnostics(input = {}) {
  try {
    return goalDurabilityDiagnostics(input);
  } catch (error) {
    return {
      goalRoundRecovery: {
        available: false,
        enabled: false,
        running: false,
        closed: null,
        lastError: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
        rawPromptReturned: false,
        rawConversationContentReturned: false,
      },
      statePersistence: boundedPersistence(input.goalRuntime, input.planRuntime),
      diagnosticsAvailable: false,
      diagnosticsError: "goal-durability-contract-unavailable",
      rawStateReturned: false,
      rawConversationContentReturned: false,
    };
  }
}
