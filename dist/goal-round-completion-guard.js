const DEFAULT_POLL_MS = 2_000;
const DEFAULT_ROUND_SETTLE_MS = 2_000;
const DEFAULT_NATIVE_COMPLETE_GRACE_MS = 5_000;

function upper(value) {
  return String(value ?? "").trim().toUpperCase();
}

export function shouldRecoverWorkingRound(goal, snapshot, {
  nowMs = Date.now(),
  minimumRoundSettleMs = DEFAULT_ROUND_SETTLE_MS,
} = {}) {
  if (!goal || goal.status !== "active" || goal.roundState !== "working") return false;
  if (!Number.isInteger(goal.round) || goal.round < 2) return false;
  if (!goal.lastConsumedContinuationId || !goal.roundBeganAt) return false;
  const beganAt = Date.parse(String(goal.roundBeganAt));
  if (!Number.isFinite(beganAt) || nowMs - beganAt < minimumRoundSettleMs) return false;
  if (snapshot?.chatMode !== true) return false;
  const nativeCompleteStableMs = Math.max(0, Number(snapshot?.nativeCompleteStableMs || 0));
  const nativeComplete = (
    upper(snapshot?.streamStatus) === "COMPLETE"
    && snapshot?.safetyCheckVisible !== true
    && (
      snapshot?.generating === false
      || nativeCompleteStableMs >= DEFAULT_NATIVE_COMPLETE_GRACE_MS
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
    this.now = now;
    this.nativeCompleteSince = new Map();
    this.timer = null;
    this.polling = null;
    this.closed = false;
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
    this.polling = this.#pollOnceImpl().finally(() => { this.polling = null; });
    return this.polling;
  }

  async #pollOnceImpl() {
    const goals = await this.goalRuntime.recoverableWorkingRounds();
    const results = [];
    let recovered = 0;
    for (const goal of goals) {
      let snapshot;
      try {
        snapshot = await this.inspect(goal);
        const key = `${goal.id}:${goal.round}`;
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
        results.push({ goalId: goal.id, round: goal.round, recovered: false, reason: "round-still-active-or-not-safe" });
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
        recovered += 1;
        results.push({ goalId: goal.id, round: goal.round, recovered: true, attempt: recovery.claim.attempt, transport: sent.transport || null });
      } else {
        await this.goalRuntime.roundRecovery({
          goalId: goal.id,
          action: "release",
          recoveryId: recovery.claim.recoveryId,
        }).catch(() => {});
        results.push({ goalId: goal.id, round: goal.round, recovered: false, reason: "dispatch-failed", error: sent?.error || "hidden round recovery dispatch failed" });
      }
    }
    return { ok: true, recovered, results };
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.nativeCompleteSince.clear();
    if (this.polling) await this.polling.catch(() => {});
  }
}
