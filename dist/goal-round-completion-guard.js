const DEFAULT_POLL_MS = 2_000;
const DEFAULT_ROUND_SETTLE_MS = 2_000;
const DEFAULT_NATIVE_COMPLETE_GRACE_MS = 5_000;
const DEFAULT_ROUTE_SETTLE_MS = 3_000;
const DEFAULT_REQUEST_PRE_ROUND_SLOP_MS = 30_000;
const DEFAULT_NATIVE_FINAL_RETRY_MS = 5 * 60_000;
const DEFAULT_ASSISTANT_FINAL_SLOP_MS = 1_000;
const ACTIVE_STREAM_STATES = new Set(["IN_PROGRESS", "IS_STREAMING", "STREAMING", "RUNNING"]);

function upper(value) {
  return String(value ?? "").trim().toUpperCase();
}

function timestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function recoveryRunKey(goal) {
  return goal?.id && Number.isInteger(goal?.round) ? `${goal.id}:${goal.round}` : null;
}

function recoveryPageIdentity(snapshot) {
  const runtime = Number.isInteger(snapshot?.runtimePort)
    ? `port:${snapshot.runtimePort}`
    : String(snapshot?.runtimeKey || "").trim();
  const pageTargetId = String(snapshot?.pageTargetId || "").trim();
  const documentId = String(snapshot?.documentId || "").trim();
  const routeEpoch = Number(snapshot?.routeEpoch);
  const conversationId = String(snapshot?.conversationId || "").trim();
  if (!runtime || !pageTargetId || !documentId || !Number.isInteger(routeEpoch) || routeEpoch < 1 || !conversationId) return null;
  return `${runtime}:${pageTargetId}:${documentId}:${routeEpoch}:${conversationId}`;
}

export function shouldInspectNativeCurrentRoundFinal(snapshot) {
  return snapshot?.chatMode === true
    && snapshot?.generating === false
    && upper(snapshot?.streamStatus) === "COMPLETE"
    && snapshot?.safetyCheckVisible !== true
    && snapshot?.deliveryTimeoutVisible !== true
    && snapshot?.latestMessageRole === "assistant"
    && Boolean(String(snapshot?.latestAssistantMessageId || "").trim())
    && Boolean(String(snapshot?.latestUserMessageId || "").trim())
    && Boolean(String(snapshot?.latestAssistantText || "").trim());
}

export function provesNativeCurrentRoundFinal(goal, snapshot, {
  nowMs = Date.now(),
  requestPreRoundSlopMs = DEFAULT_REQUEST_PRE_ROUND_SLOP_MS,
} = {}) {
  if (!shouldInspectNativeCurrentRoundFinal(snapshot)) return false;
  const native = snapshot?.nativeContinuation;
  if (native?.resolved !== true || native?.currentRole !== "assistant" || native?.currentEndTurn !== true) return false;
  if (ACTIVE_STREAM_STATES.has(upper(native?.currentStatus))) return false;
  const latestAssistantId = String(snapshot?.latestAssistantMessageId || "").trim();
  const latestUserId = String(snapshot?.latestUserMessageId || "").trim();
  if (!latestAssistantId || !latestUserId) return false;
  if (String(native?.currentNodeId || "").trim() !== latestAssistantId) return false;
  if (String(native?.currentMessageId || "").trim() !== latestAssistantId) return false;
  if (String(native?.latestAssistantMessageId || "").trim() !== latestAssistantId) return false;
  if (String(native?.latestUserMessageId || "").trim() !== latestUserId) return false;
  const roundBeganAtMs = timestamp(goal?.roundBeganAt);
  const assistantCreatedAtMs = timestamp(native?.latestAssistantCreatedAt || native?.currentCreatedAt);
  const currentCreatedAtMs = timestamp(native?.currentCreatedAt);
  const userCreatedAtMs = timestamp(native?.latestUserCreatedAt);
  if (roundBeganAtMs == null || assistantCreatedAtMs == null || currentCreatedAtMs == null || userCreatedAtMs == null) return false;
  if (assistantCreatedAtMs !== currentCreatedAtMs) return false;
  if (assistantCreatedAtMs < roundBeganAtMs - DEFAULT_ASSISTANT_FINAL_SLOP_MS) return false;
  if (assistantCreatedAtMs > nowMs + 60_000) return false;
  if (userCreatedAtMs < roundBeganAtMs - requestPreRoundSlopMs) return false;
  if (userCreatedAtMs > assistantCreatedAtMs) return false;
  return true;
}

export function shouldRecoverWorkingRound(goal, snapshot, {
  nowMs = Date.now(),
  minimumRoundSettleMs = DEFAULT_ROUND_SETTLE_MS,
} = {}) {
  if (!goal || goal.status !== "active" || goal.roundState !== "working") return false;
  if (!Number.isInteger(goal.round) || goal.round < 1) return false;
  if (!goal.roundBeganAt) return false;
  const beganAt = Date.parse(String(goal.roundBeganAt));
  if (!Number.isFinite(beganAt) || nowMs - beganAt < minimumRoundSettleMs) return false;
  if (snapshot?.chatMode !== true || snapshot?.recoverySessionEligible === false) return false;
  if (goal?.conversationId && snapshot?.conversationId && snapshot.conversationId !== goal.conversationId) return false;
  const nativeCompleteStableMs = Math.max(0, Number(snapshot?.nativeCompleteStableMs || 0));
  const requestObservedAtMs = timestamp(snapshot?.turnRequestObservedAt);
  const finishedObservedAtMs = timestamp(snapshot?.turnFinishedObservedAt);
  const currentTurnTransportFinished = (
    requestObservedAtMs != null
    && finishedObservedAtMs != null
    && finishedObservedAtMs >= requestObservedAtMs
    && finishedObservedAtMs >= beganAt - DEFAULT_REQUEST_PRE_ROUND_SLOP_MS
  );
  const currentRoundAssistantCommitted = (
    snapshot?.recoverySession?.sawCurrentRoundAssistant === true
    && snapshot?.latestMessageRole === "assistant"
    && typeof snapshot?.latestAssistantText === "string"
    && snapshot.latestAssistantText.trim().length > 0
  );
  const staleGuiGeneratingOverride = (
    snapshot?.generating === true
    && nativeCompleteStableMs >= DEFAULT_NATIVE_COMPLETE_GRACE_MS
    && currentTurnTransportFinished
    && currentRoundAssistantCommitted
  );
  const nativeComplete = (
    upper(snapshot?.streamStatus) === "COMPLETE"
    && snapshot?.safetyCheckVisible !== true
    && (
      snapshot?.generating === false
      || staleGuiGeneratingOverride
    )
  );
  if (nativeComplete) return true;

  // ChatGPT can terminate the browser-side turn transport after an additional
  // safety check and surface "Message delivery timed out" while stream_status
  // remains stale. Recovery is allowed only when BOTH a native transport
  // failure was observed for this round and the host UI confirms the explicit
  // delivery-timeout terminal surface. The UI is confirmation, never the sole
  // recovery authority; an active safety-check notice always fails closed.
  const deliveryFailed = (
    snapshot?.deliveryTransportFailed === true
    && snapshot?.deliveryTimeoutVisible === true
    && snapshot?.retryVisible === true
    && snapshot?.safetyCheckVisible !== true
    && snapshot?.generating !== true
  );
  return deliveryFailed;
}

export class ClassicGoalRoundCompletionGuard {
  constructor({
    goalRuntime,
    inspect,
    dispatch,
    pollMs = DEFAULT_POLL_MS,
    minimumRoundSettleMs = DEFAULT_ROUND_SETTLE_MS,
    routeSettleMs = DEFAULT_ROUTE_SETTLE_MS,
    requestPreRoundSlopMs = DEFAULT_REQUEST_PRE_ROUND_SLOP_MS,
    nativeFinalRetryMs = DEFAULT_NATIVE_FINAL_RETRY_MS,
    now = () => Date.now(),
  } = {}) {
    if (!goalRuntime || typeof goalRuntime.recoverableWorkingRounds !== "function") {
      throw new Error("ClassicGoalRoundCompletionGuard requires GoalRuntime recovery APIs.");
    }
    if (typeof inspect !== "function" || typeof dispatch !== "function") {
      throw new Error("ClassicGoalRoundCompletionGuard requires inspect and dispatch adapters.");
    }
    this.goalRuntime = goalRuntime;
    this.inspect = inspect;
    this.dispatch = dispatch;
    this.pollMs = Math.max(0, Number(pollMs) || 0);
    this.minimumRoundSettleMs = Math.max(0, Number(minimumRoundSettleMs) || 0);
    this.routeSettleMs = Math.max(0, Number(routeSettleMs) || 0);
    this.requestPreRoundSlopMs = Math.max(0, Number(requestPreRoundSlopMs) || 0);
    this.nativeFinalRetryMs = Math.max(5_000, Number(nativeFinalRetryMs) || DEFAULT_NATIVE_FINAL_RETRY_MS);
    this.now = now;
    this.nativeCompleteSince = new Map();
    this.nativeFinalRetryAt = new Map();
    this.recoverySessions = new Map();
    this.timer = null;
    this.polling = null;
    this.closed = false;
    this.lastError = null;
    this.lastPollAt = null;
    this.lastRecovered = 0;
    this.lastResults = [];
  }

  observeRecoverySession(goal, snapshot) {
    const runKey = recoveryRunKey(goal);
    const pageIdentity = recoveryPageIdentity(snapshot);
    if (!runKey || !pageIdentity) {
      if (runKey) this.recoverySessions.delete(runKey);
      return { eligible: false, reason: "page-session-unresolved", reset: true };
    }
    let session = this.recoverySessions.get(runKey);
    const reset = !session || session.pageIdentity !== pageIdentity;
    if (reset) {
      session = {
        pageIdentity,
        firstObservedAtMs: this.now(),
        lastObservedAtMs: this.now(),
        sawActiveTurn: false,
        sawCurrentRouteRequest: false,
        baselineAssistantMessageId: String(snapshot?.latestAssistantMessageId || "").trim() || null,
        sawCurrentRoundAssistant: false,
        sawNativeCurrentRoundFinal: false,
      };
      this.recoverySessions.set(runKey, session);
    }

    const streamStatus = upper(snapshot?.streamStatus);
    if (snapshot?.generating === true && streamStatus !== "COMPLETE") session.sawActiveTurn = true;
    if (ACTIVE_STREAM_STATES.has(streamStatus)) session.sawActiveTurn = true;

    const routeEnteredAtMs = timestamp(snapshot?.routeEnteredAt);
    const roundBeganAtMs = timestamp(goal?.roundBeganAt);
    const requestObservedAtMs = timestamp(snapshot?.turnRequestObservedAt);
    const finishedObservedAtMs = timestamp(snapshot?.turnFinishedObservedAt);
    let currentRoundTransportFinished = false;
    if (routeEnteredAtMs != null && requestObservedAtMs != null) {
      const roundLowerBound = roundBeganAtMs == null
        ? routeEnteredAtMs
        : roundBeganAtMs - this.requestPreRoundSlopMs;
      const lowerBound = Math.max(routeEnteredAtMs, roundLowerBound);
      if (requestObservedAtMs >= lowerBound && requestObservedAtMs <= this.now() + 60_000) {
        session.sawCurrentRouteRequest = true;
        currentRoundTransportFinished = finishedObservedAtMs != null
          && finishedObservedAtMs >= requestObservedAtMs
          && finishedObservedAtMs >= lowerBound;
      }
    }

    const latestMessageRole = String(snapshot?.latestMessageRole || "").trim().toLowerCase();
    const latestAssistantMessageId = String(snapshot?.latestAssistantMessageId || "").trim() || null;
    const assistantMessageChanged = Boolean(
      latestAssistantMessageId
      && latestAssistantMessageId !== session.baselineAssistantMessageId
    );
    if (
      session.sawCurrentRouteRequest
      && latestMessageRole === "assistant"
      && (
        assistantMessageChanged
        || snapshot?.generating === true
        // After a Core/guard restart the first observation may already be the
        // committed final, so there is no in-memory "assistant changed" edge.
        // Persisted exact request+finished evidence for this route/round is the
        // restart-safe authority; an old request from a later route still fails
        // the lower-bound check above.
        || currentRoundTransportFinished
      )
    ) {
      session.sawCurrentRoundAssistant = true;
    }

    const nativeCurrentRoundFinal = provesNativeCurrentRoundFinal(goal, snapshot, {
      nowMs: this.now(),
      requestPreRoundSlopMs: this.requestPreRoundSlopMs,
    });
    if (nativeCurrentRoundFinal) {
      session.sawCurrentRoundAssistant = true;
      session.sawNativeCurrentRoundFinal = true;
    }

    session.lastObservedAtMs = this.now();
    const routeStableForMs = Math.max(0, Number(snapshot?.routeStableForMs || 0));
    const stableOpenRoute = (
      snapshot?.chatMode === true
      && (!goal?.conversationId || snapshot?.conversationId === goal.conversationId)
      && snapshot?.documentReadyState === "complete"
      && snapshot?.composerReady === true
      && snapshot?.routeHydrated === true
      && routeStableForMs >= this.routeSettleMs
    );
    const eligible = stableOpenRoute && (
      session.sawActiveTurn
      || session.sawCurrentRouteRequest
      || session.sawNativeCurrentRoundFinal
    );
    return {
      eligible,
      reset,
      pageIdentity,
      stableOpenRoute,
      sawActiveTurn: session.sawActiveTurn,
      sawCurrentRouteRequest: session.sawCurrentRouteRequest,
      sawCurrentRoundAssistant: session.sawCurrentRoundAssistant,
      sawNativeCurrentRoundFinal: session.sawNativeCurrentRoundFinal,
      reason: eligible
        ? session.sawNativeCurrentRoundFinal && !session.sawActiveTurn && !session.sawCurrentRouteRequest
          ? "restart-safe-native-current-round-final"
          : "same-route-active-turn-observed"
        : !stableOpenRoute
          ? "route-not-stable"
          : "reentry-or-unobserved-turn",
    };
  }

  async start({ schedule = true } = {}) {
    await this.pollOnce();
    if (schedule && !this.closed && this.pollMs > 0 && !this.timer) {
      this.timer = setInterval(() => { void this.pollOnce(); }, this.pollMs);
      this.timer.unref?.();
    }
    return { ok: true };
  }

  async pollOnce() {
    if (this.closed) return { ok: true, skipped: "closed", recovered: 0, results: [] };
    if (this.polling) return this.polling;
    this.polling = this.#pollOnceImpl()
      .then((result) => {
        this.lastError = null;
        this.lastPollAt = new Date(this.now()).toISOString();
        this.lastRecovered = Math.max(0, Number(result?.recovered || 0));
        this.lastResults = (Array.isArray(result?.results) ? result.results : [])
          .slice(-16)
          .map((row) => ({
            goalId: String(row?.goalId || "").slice(0, 200) || null,
            round: Number.isInteger(row?.round) ? row.round : null,
            recovered: row?.recovered === true,
            reason: /^[A-Za-z0-9_.:-]{1,160}$/.test(String(row?.reason || ""))
              ? String(row.reason)
              : null,
            attempt: Number.isInteger(row?.attempt) ? row.attempt : null,
            transport: /^[A-Za-z0-9_.:-]{1,160}$/.test(String(row?.transport || ""))
              ? String(row.transport)
              : null,
            errorObserved: Boolean(row?.error),
          }));
        return result;
      }, (error) => {
        this.lastError = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
        this.lastPollAt = new Date(this.now()).toISOString();
        this.lastRecovered = 0;
        this.lastResults = [];
        throw error;
      })
      .finally(() => { this.polling = null; });
    return this.polling;
  }

  status() {
    return {
      enabled: this.closed !== true,
      running: Boolean(this.timer),
      closed: this.closed === true,
      polling: Boolean(this.polling),
      pollMs: this.pollMs,
      trackedRecoverySessions: this.recoverySessions.size,
      trackedNativeCompletions: this.nativeCompleteSince.size,
      lastError: this.lastError,
      lastPollAt: this.lastPollAt,
      lastRecovered: this.lastRecovered,
      lastResults: this.lastResults.map((row) => ({ ...row })),
      rawPromptReturned: false,
      rawConversationContentReturned: false,
    };
  }

  async #pollOnceImpl() {
    const goals = await this.goalRuntime.recoverableWorkingRounds();
    const activeRunKeys = new Set(goals.map(recoveryRunKey).filter(Boolean));
    for (const key of this.recoverySessions.keys()) {
      if (!activeRunKeys.has(key)) this.recoverySessions.delete(key);
    }
    for (const key of this.nativeCompleteSince.keys()) {
      if (!activeRunKeys.has(key)) this.nativeCompleteSince.delete(key);
    }
    for (const key of this.nativeFinalRetryAt.keys()) {
      if (!activeRunKeys.has(key)) this.nativeFinalRetryAt.delete(key);
    }
    const results = [];
    let recovered = 0;
    for (const goal of goals) {
      let snapshot;
      try {
        snapshot = await this.inspect(goal);
        const key = `${goal.id}:${goal.round}`;
        let recoverySession = this.observeRecoverySession(goal, snapshot);
        if (recoverySession.reset) this.nativeCompleteSince.delete(key);
        if (
          recoverySession.eligible !== true
          && recoverySession.reason === "reentry-or-unobserved-turn"
          && shouldInspectNativeCurrentRoundFinal(snapshot)
          && Number(this.nativeFinalRetryAt.get(key) || 0) <= this.now()
        ) {
          this.nativeFinalRetryAt.set(key, this.now() + this.nativeFinalRetryMs);
          try {
            const nativeSnapshot = await this.inspect(goal, { includeNativeBranch: true });
            if (nativeSnapshot) {
              snapshot = nativeSnapshot;
              recoverySession = this.observeRecoverySession(goal, snapshot);
            }
          } catch {
            // Native branch inspection is supplementary authority. Preserve
            // the original fail-closed result and retry only after the bounded delay.
          }
        }
        snapshot = {
          ...snapshot,
          recoverySessionEligible: recoverySession.eligible,
          recoverySession,
        };
        if (upper(snapshot?.streamStatus) === "COMPLETE") {
          const since = this.nativeCompleteSince.get(key) ?? this.now();
          this.nativeCompleteSince.set(key, since);
          snapshot = { ...snapshot, nativeCompleteStableMs: Math.max(0, this.now() - since) };
        } else {
          this.nativeCompleteSince.delete(key);
        }
      } catch (error) {
        results.push({ goalId: goal.id, round: goal.round, recovered: false, reason: "inspect-failed", error: String(error?.message || error) });
        continue;
      }
      if (!shouldRecoverWorkingRound(goal, snapshot, {
        nowMs: this.now(),
        minimumRoundSettleMs: this.minimumRoundSettleMs,
      })) {
        results.push({
          goalId: goal.id,
          round: goal.round,
          recovered: false,
          reason: snapshot?.recoverySession?.reason || "round-still-active-or-not-safe",
        });
        continue;
      }

      const recovery = await this.goalRuntime.claimRoundRecovery({ goalId: goal.id });
      if (!recovery?.claimed || !recovery.claim) {
        results.push({ goalId: goal.id, round: goal.round, recovered: false, reason: recovery?.reason || "recovery-not-claimed" });
        continue;
      }

      let sent;
      try {
        sent = await this.dispatch(recovery.claim, snapshot);
      } catch (error) {
        sent = { ok: false, error: String(error?.message || error) };
      }
      if (sent?.ok === true) {
        await this.goalRuntime.roundRecovery({
          goalId: goal.id,
          action: "ack",
          recoveryId: recovery.claim.recoveryId,
        });
        this.nativeCompleteSince.delete(`${goal.id}:${goal.round}`);
        this.nativeFinalRetryAt.delete(`${goal.id}:${goal.round}`);
        this.recoverySessions.delete(`${goal.id}:${goal.round}`);
        recovered += 1;
        results.push({ goalId: goal.id, round: goal.round, recovered: true, attempt: recovery.claim.attempt, transport: sent.transport || null });
      } else if (sent?.dispatchCommitted === true) {
        // The exact page accepted the send click, but the follow-up message was
        // not confirmed visible within the bounded verification window. Close
        // the recovery episode rather than risking a duplicate user turn.
        await this.goalRuntime.roundRecovery({
          goalId: goal.id,
          action: "ack",
          recoveryId: recovery.claim.recoveryId,
        });
        this.nativeCompleteSince.delete(`${goal.id}:${goal.round}`);
        this.nativeFinalRetryAt.delete(`${goal.id}:${goal.round}`);
        this.recoverySessions.delete(`${goal.id}:${goal.round}`);
        results.push({
          goalId: goal.id,
          round: goal.round,
          recovered: false,
          attempt: recovery.claim.attempt,
          reason: "dispatch-committed-unverified-no-retry",
          transport: sent.transport || null,
          error: sent?.error || sent?.state || "exact-page recovery submission could not be visibly confirmed",
        });
      } else {
        await this.goalRuntime.roundRecovery({
          goalId: goal.id,
          action: "release",
          recoveryId: recovery.claim.recoveryId,
        }).catch(() => {});
        results.push({ goalId: goal.id, round: goal.round, recovered: false, reason: "dispatch-failed", error: sent?.error || "exact-page round recovery dispatch failed" });
      }
    }
    return { ok: true, recovered, results };
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.nativeCompleteSince.clear();
    this.nativeFinalRetryAt.clear();
    this.recoverySessions.clear();
    if (this.polling) await this.polling.catch(() => {});
  }
}
