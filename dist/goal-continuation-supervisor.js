import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { atomicWriteJson } from './atomic-file.js';
import { enqueueRecoverablePersist } from './recoverable-persist-queue.js';

const digest = text => createHash('sha256').update(String(text || '')).digest('hex');
const pending = goal => goal?.status === 'active' && goal.roundState === 'reported'
  && goal.continuation?.state === 'pending' && Boolean(goal.conversationId);
const redeemable = goal => goal?.status === 'active' && goal.roundState === 'reported'
  && goal.continuation?.state !== 'idle' && Boolean(goal.continuation?.continuationId)
  && Boolean(goal.conversationId);
const finalPage = page => page?.chatMode === true && page.generating === false
  && page.streamStatus === 'COMPLETE' && page.latestMessageRole === 'assistant'
  && Boolean(page.latestAssistantMessageId) && Boolean(page.latestAssistantText?.trim())
  && !page.safetyCheckVisible && !page.nativeSafetyBlocked && !page.deliveryTimeoutVisible && !page.retryVisible;
const HUMAN_SUPERSESSION_REASONS = new Set([
  'new-user-turn-before-hidden-continuation',
  'new-user-turn-takes-precedence',
]);
const UNARMED_RECOVERY_RETRY_MS = 5_000;
const UNARMED_REPORT_TIME_SLOP_MS = 5_000;
const SOURCE_USER_REPORT_SLOP_MS = 1_000;
const NATIVE_RUNNING_STATES = new Set(['IN_PROGRESS', 'IS_STREAMING', 'STREAMING', 'RUNNING']);

const timeMs = value => {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
};
const nativeStopped = status => {
  const normalized = String(status || '').trim().toUpperCase();
  return Boolean(normalized) && !NATIVE_RUNNING_STATES.has(normalized);
};

function nativeCompletionProof(goal) {
  const proof = goal?.lastTurnCompletion;
  if (!proof || proof.source !== 'native-assistant-turn-final'
    || proof.round !== goal?.round
    || proof.conversationId !== goal?.conversationId
    || !/^main-(0[1-9]|[12][0-9]|3[0-2])$/.test(String(proof.runtimeKey || ''))
    || !String(proof.pageTargetId || '').trim()
    || !String(proof.sourceUserMessageId || '').trim()
    || !String(proof.assistantMessageId || '').trim()
    || !/^[a-f0-9]{64}$/i.test(String(proof.assistantTextHash || ''))
    || !Number.isFinite(Date.parse(String(proof.assistantCreatedAt || '')))
    || !Number.isFinite(Date.parse(String(proof.completedAt || '')))) return null;
  return proof;
}

function receiptNativeFinalProof(goal, page, nowMs) {
  const native = page?.nativeContinuation, witness = native?.goalStartWitness;
  const assistantAt = timeMs(native?.latestAssistantCreatedAt);
  const beganAt = timeMs(goal?.roundBeganAt);
  if (page?.boundarySource !== 'native-goal-start-tool-result' || !finalPage(page)
    || page.conversationId !== goal.conversationId || witness?.verified !== true
    || witness.goalId !== goal.id || witness.conversationId !== goal.conversationId
    || witness.sourceUserMessageId !== page.latestUserMessageId
    || witness.sourceUserMessageId !== native.latestUserMessageId
    || native.currentRole !== 'assistant' || native.currentEndTurn !== true
    || native.latestAssistantEndTurn !== true || native.currentStatus !== 'finished_successfully'
    || native.latestAssistantStatus !== 'finished_successfully'
    || native.currentMessageId !== page.latestAssistantMessageId
    || native.currentNodeId !== page.latestAssistantMessageId
    || native.latestAssistantMessageId !== page.latestAssistantMessageId
    || digest(native.latestPublicAssistantText?.trim()) !== digest(page.latestAssistantText)
    || timeMs(native.currentCreatedAt) !== assistantAt
    || timeMs(witness.toolCreatedAt) == null || timeMs(witness.toolCreatedAt) > assistantAt
    || !/^main-(0[1-9]|[12][0-9]|3[0-2])$/.test(String(page.runtimeKey || ''))
    || !page.pageTargetId || assistantAt == null || beganAt == null
    || assistantAt < beganAt - 1000 || assistantAt > nowMs + 60_000) return null;
  return { source: 'native-assistant-turn-final', round: goal.round,
    conversationId: goal.conversationId, runtimeKey: page.runtimeKey,
    pageTargetId: page.pageTargetId, sourceUserMessageId: page.latestUserMessageId,
    assistantMessageId: page.latestAssistantMessageId,
    assistantTextHash: digest(page.latestAssistantText),
    assistantCreatedAt: native.latestAssistantCreatedAt, completedAt: new Date(nowMs).toISOString() };
}

function exactNativeCompletionBoundary(goal, pages) {
  const expected = nativeCompletionProof(goal);
  if (!pending(goal) || !expected || !Array.isArray(pages) || pages.length !== 1) return null;
  const page = pages[0];
  if (page?.conversationId !== goal.conversationId
    || page?.runtimeKey !== expected.runtimeKey
    || page?.pageTargetId !== expected.pageTargetId) return null;
  const native = page?.nativeContinuation;
  const nativeAssistantAt = timeMs(native?.latestAssistantCreatedAt || native?.currentCreatedAt);
  const nativeUserAt = timeMs(native?.latestUserCreatedAt);
  const expectedAssistantAt = timeMs(expected.assistantCreatedAt);
  if (page.latestUserMessageId === expected.sourceUserMessageId
    && page.latestAssistantMessageId === expected.assistantMessageId
    && digest(page.latestAssistantText) === expected.assistantTextHash
    && finalPage(page)
    && native?.resolved === true
    && native.currentRole === 'assistant'
    && native.currentEndTurn === true
    && native.latestAssistantEndTurn === true
    && nativeStopped(native.currentStatus)
    && nativeStopped(native.latestAssistantStatus)
    && String(native.currentMessageId || '').trim() === expected.assistantMessageId
    && String(native.latestAssistantMessageId || '').trim() === expected.assistantMessageId
    && String(native.latestUserMessageId || '').trim() === expected.sourceUserMessageId
    && nativeAssistantAt != null
    && nativeAssistantAt === expectedAssistantAt
    && nativeUserAt != null
    && nativeUserAt <= expectedAssistantAt) {
    return {
      type: 'completed-final',
      sourceUserId: expected.sourceUserMessageId,
      finalAssistantId: expected.assistantMessageId,
      finalAssistantHash: expected.assistantTextHash,
    };
  }
  if (page.latestUserMessageId && page.latestUserMessageId !== expected.sourceUserMessageId
    && native?.resolved === true
    && String(page.assistantBeforeLatestUserMessageId || '').trim() === expected.assistantMessageId
    && String(native.assistantBeforeLatestUserMessageId || '').trim() === expected.assistantMessageId
    && String(page.previousUserMessageId || '').trim() === expected.sourceUserMessageId
    && String(native.previousUserMessageId || '').trim() === expected.sourceUserMessageId
    && native.assistantBeforeLatestUserEndTurn === true
    && nativeStopped(native.assistantBeforeLatestUserStatus)) {
    const newUserAtMs = timeMs(native.latestUserCreatedAt);
    const priorAssistantAtMs = timeMs(native.assistantBeforeLatestUserCreatedAt);
    if (newUserAtMs != null && priorAssistantAtMs != null && newUserAtMs > priorAssistantAtMs) {
      return {
        type: 'human-user',
        sourceUserId: expected.sourceUserMessageId,
        finalAssistantId: expected.assistantMessageId,
        finalAssistantCreatedAt: new Date(priorAssistantAtMs).toISOString(),
        newUserMessageId: page.latestUserMessageId,
        newUserObservedAt: new Date(newUserAtMs).toISOString(),
      };
    }
  }
  return null;
}

function exactMissingArmBoundary(goal, pages, nowMs = Date.now()) {
  const autoBoundary = exactNativeCompletionBoundary(goal, pages);
  if (autoBoundary) return autoBoundary;
  if (pages?.length === 1 && pages[0].nativeGoalSourceRequired === true) {
    const proof = receiptNativeFinalProof(goal, pages[0], nowMs);
    return proof ? { type: 'completed-final', sourceUserId: proof.sourceUserMessageId,
      finalAssistantId: proof.assistantMessageId, finalAssistantHash: proof.assistantTextHash,
      finalAssistantCreatedAt: proof.assistantCreatedAt, nativeCompletionProof: proof } : null;
  }
  if (!pending(goal) || !Array.isArray(pages) || !pages.length || pages.length > 4) return null;
  const reportedAtMs = timeMs(goal?.lastRoundReport?.reportedAt);
  if (reportedAtMs == null) return null;
  if (pages.some(page => page?.conversationId !== goal.conversationId || page?.chatMode !== true)) return null;
  const userIds = new Set(pages.map(page => String(page?.latestUserMessageId || '').trim()).filter(Boolean));
  if (userIds.size !== 1) return null;
  const latestUserMessageId = [...userIds][0];
  const proofs = pages.map(page => page?.nativeContinuation).filter(Boolean);
  if (proofs.length !== pages.length || proofs.some(proof => proof?.resolved !== true)) return null;
  if (proofs.some(proof => String(proof.latestUserMessageId || '').trim() !== latestUserMessageId)) return null;

  const latestUserTimes = proofs.map(proof => timeMs(proof.latestUserCreatedAt));
  if (latestUserTimes.some(value => value == null)) return null;
  const latestUserAtMs = Math.max(...latestUserTimes);
  if (latestUserTimes.some(value => Math.abs(value - latestUserAtMs) > 1_000)) return null;

  const domAssistantIds = new Set(pages.map(page => String(page?.latestAssistantMessageId || '').trim()).filter(Boolean));
  const nativeAssistantIds = new Set(proofs.map(proof => String(proof?.latestAssistantMessageId || '').trim()).filter(Boolean));
  const currentAssistantIds = new Set(proofs.map(proof => String(proof?.currentMessageId || '').trim()).filter(Boolean));
  const currentFinal = (
    domAssistantIds.size === 1
    && nativeAssistantIds.size === 1
    && currentAssistantIds.size === 1
    && [...domAssistantIds][0] === [...nativeAssistantIds][0]
    && [...domAssistantIds][0] === [...currentAssistantIds][0]
    && latestUserAtMs <= reportedAtMs + SOURCE_USER_REPORT_SLOP_MS
    && pages.every(page => page?.generating !== true
      && page?.latestMessageRole === 'assistant'
      && Boolean(String(page?.latestAssistantText || '').trim())
      && page?.safetyCheckVisible !== true
      && page?.deliveryTimeoutVisible !== true
      && page?.retryVisible !== true)
    && proofs.every(proof => proof.currentRole === 'assistant'
      && proof.currentEndTurn === true
      && proof.latestAssistantEndTurn === true
      && nativeStopped(proof.currentStatus)
      && nativeStopped(proof.latestAssistantStatus))
  );
  if (currentFinal) {
    const assistantTimes = proofs.map(proof => timeMs(proof.latestAssistantCreatedAt || proof.currentCreatedAt));
    if (assistantTimes.some(value => value == null)) return null;
    const assistantAtMs = Math.min(...assistantTimes);
    if (assistantTimes.some(value => Math.abs(value - assistantAtMs) > 1_000)) return null;
    if (assistantAtMs < reportedAtMs - UNARMED_REPORT_TIME_SLOP_MS
      || assistantAtMs > nowMs + 60_000
      || latestUserAtMs > assistantAtMs) return null;
    return {
      type: 'completed-final',
      sourceUserId: latestUserMessageId,
      finalAssistantId: [...domAssistantIds][0],
      finalAssistantHash: digest(pages[0]?.latestAssistantText),
      finalAssistantCreatedAt: new Date(assistantAtMs).toISOString(),
    };
  }

  const priorAssistantIds = new Set(pages
    .map(page => String(page?.assistantBeforeLatestUserMessageId || '').trim())
    .filter(Boolean));
  const nativePriorAssistantIds = new Set(proofs
    .map(proof => String(proof?.assistantBeforeLatestUserMessageId || '').trim())
    .filter(Boolean));
  const previousUserIds = new Set(pages
    .map(page => String(page?.previousUserMessageId || '').trim())
    .filter(Boolean));
  const nativePreviousUserIds = new Set(proofs
    .map(proof => String(proof?.previousUserMessageId || '').trim())
    .filter(Boolean));
  const newHumanAfterFinal = (
    priorAssistantIds.size === 1
    && nativePriorAssistantIds.size === 1
    && [...priorAssistantIds][0] === [...nativePriorAssistantIds][0]
    && previousUserIds.size === 1
    && nativePreviousUserIds.size === 1
    && [...previousUserIds][0] === [...nativePreviousUserIds][0]
    && proofs.every(proof => proof.assistantBeforeLatestUserEndTurn === true
      && nativeStopped(proof.assistantBeforeLatestUserStatus))
  );
  if (newHumanAfterFinal) {
    const priorAssistantTimes = proofs.map(proof => timeMs(proof.assistantBeforeLatestUserCreatedAt));
    if (priorAssistantTimes.some(value => value == null)) return null;
    const priorAssistantAtMs = Math.min(...priorAssistantTimes);
    if (priorAssistantTimes.some(value => Math.abs(value - priorAssistantAtMs) > 1_000)) return null;
    if (priorAssistantAtMs < reportedAtMs - UNARMED_REPORT_TIME_SLOP_MS
      || latestUserAtMs <= priorAssistantAtMs
      || latestUserAtMs > nowMs + 60_000) return null;
    return {
      type: 'human-user',
      sourceUserId: [...previousUserIds][0],
      finalAssistantId: [...priorAssistantIds][0],
      finalAssistantCreatedAt: new Date(priorAssistantAtMs).toISOString(),
      newUserMessageId: latestUserMessageId,
      newUserObservedAt: new Date(latestUserAtMs).toISOString(),
    };
  }

  const currentSourceTurn = latestUserAtMs <= reportedAtMs + SOURCE_USER_REPORT_SLOP_MS
    && pages.every(page => page?.generating === true || page?.latestMessageRole === 'user');
  if (!currentSourceTurn) return null;
  return {
    type: 'awaiting-final',
    sourceUserId: latestUserMessageId,
    baseline: pages.map(page => ({
      id: page?.latestAssistantMessageId || null,
      hash: digest(page?.latestAssistantText),
    })),
  };
}

/** Backend owner of one report -> one continuation.
 * No UI App, timer-authored narration, runtime-only owner or optimistic retry.
 * The original user boundary is captured while the report tool is executing.
 * An ambiguous send is durably quarantined, including across Core restarts.
 */
export class GoalContinuationSupervisor {
  constructor({ goalRuntime, inspect, dispatch, statePath = null, enabled = true,
    now = () => Date.now(), pollMs = 1000, settleMs = 750, maxRecords = 128,
    onHiddenContinuationStarted = null, relayDiagnostics = null } = {}) {
    if (!goalRuntime || typeof inspect !== 'function' || typeof dispatch !== 'function') throw new Error('Goal continuation adapters are required');
    Object.assign(this, { goalRuntime, inspect, dispatch, statePath, enabled, now, pollMs, settleMs, maxRecords });
    this.onHiddenContinuationStarted = typeof onHiddenContinuationStarted === 'function'
      ? onHiddenContinuationStarted : null;
    this.relayDiagnostics = typeof relayDiagnostics === 'function' ? relayDiagnostics : null;
    this.records = new Map(); this.timer = null; this.polling = null; this.closed = false;
    this.persistQueue = Promise.resolve(); this.lastError = null;
    this.missingArmRetryAt = new Map();
    this.missingArmAttempts = new Map();
    this.missingArmErrors = new Map();
    this.recoveredMissingArmCount = 0;
    this.lastArmError = null;
    this.ready = this.load();
  }
  async load() {
    if (!this.statePath) return;
    try {
      const state = JSON.parse(await readFile(this.statePath, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.records)) throw new Error('invalid continuation journal');
      for (const row of state.records.slice(-this.maxRecords)) {
        if (!row?.continuationId || !row.goalId || !row.conversationId || !row.sourceUserId) continue;
        // The prior process may have sent before losing its acknowledgement.
        if (row.state === 'dispatching') { row.state = 'uncertain'; row.reason = 'restart-during-send'; }
        this.records.set(row.continuationId, row);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') { this.enabled = false; this.lastError = 'journal-invalid-fail-closed'; }
    }
  }
  async save() {
    if (!this.statePath) return;
    const snapshot = { version: 1, records: [...this.records.values()].map(row => {
      const { candidateKey, settledAt, ...durable } = row; return durable;
    }) };
    await enqueueRecoverablePersist(this, () => atomicWriteJson(this.statePath, snapshot));
  }
  async pages(goal, options = {}) {
    const unavailable = reason => {
      if (options.inspectionOutcome) options.inspectionOutcome.reason = reason;
      return null;
    };
    let rows = await this.inspect(goal, options);
    if (Array.isArray(rows) && options.runtimeKey) rows = rows.filter(p => p.runtimeKey === options.runtimeKey);
    if (Array.isArray(rows) && options.pageTargetId) rows = rows.filter(p => p.pageTargetId === options.pageTargetId);
    if (!Array.isArray(rows) || !rows.length) return unavailable('no-exact-page');
    if (rows.length > 4) return unavailable('ambiguous-exact-pages');
    if (rows.some(p => p?.conversationId !== goal.conversationId || !p.latestUserMessageId || p.chatMode !== true)) return unavailable('invalid-exact-page-owner');
    if (rows.some(p => p.nativeSafetyBlocked === true)) return unavailable('native-safety-blocked');
    const unresolved = rows.find(p => p.nativeGoalSourceRequired === true && p.boundarySource !== 'native-goal-start-tool-result');
    if (unresolved) {
      const state = String(unresolved.nativeContinuation?.state || unresolved.nativeContinuation?.goalStartWitness?.reason || 'missing-start-witness');
      return unavailable('native-source-unavailable:' + (/^[a-z0-9-]{1,80}$/.test(state) ? state : 'unresolved'));
    }
    if (!options.allowDivergent && new Set(rows.map(p => p.latestUserMessageId)).size !== 1) return unavailable('divergent-source-users');
    return rows;
  }
  async arm(goal, { resume = false, reportAuthority = null } = {}) {
    await this.ready;
    if (!this.enabled || this.closed || !pending(goal)) return { armed: false, reason: 'not-eligible' };
    if (typeof this.goalRuntime.hasConversationCollision === 'function'
      && await this.goalRuntime.hasConversationCollision({ goalId: goal.id })) {
      return { armed: false, reason: 'conversation-goal-conflict' };
    }
    const id = goal.continuation.continuationId;
    if (this.records.has(id)) return { armed: this.records.get(id).state === 'waiting', state: this.records.get(id).state };
    // Never infer a source turn for old pending Goals merely found on disk.
    let autoFinal = nativeCompletionProof(goal);
    const boundaryAt = autoFinal?.completedAt || goal.lastRoundReport?.reportedAt || null;
    const reportAge = this.now() - Date.parse(boundaryAt || '');
    if (!resume && (!Number.isFinite(reportAge) || reportAge < -1000 || reportAge > 120_000)) return { armed: false, reason: 'report-not-current' };
    // A live one-time receipt belonging to THIS report request can disambiguate
    // stale duplicate displays. Mere runtime preference can never do that.
    const sourceRuntimeKey = autoFinal?.runtimeKey || (reportAuthority?.pageVerified === true
      && reportAuthority?.source === 'exact-progress-bootstrap-lease-page-verified'
      && reportAuthority?.conversationId === goal.conversationId
      && /^main-(0[1-9]|[12][0-9]|3[0-2])$/.test(reportAuthority?.runtimeKey || '')
      ? reportAuthority.runtimeKey : null);
    let pages;
    try {
      pages = await this.pages(goal, {
        sourceOnly: !autoFinal,
        runtimeKey: sourceRuntimeKey,
        pageTargetId: autoFinal?.pageTargetId || null,
        allowDivergent: true,
      });
      this.lastArmError = null;
    } catch (error) {
      this.lastArmError = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      return { armed: false, reason: 'source-boundary-inspection-failed' };
    }
    if (!pages) return { armed: false, reason: 'source-page-unresolved' };
    if (!autoFinal && pages.length === 1) autoFinal = receiptNativeFinalProof(goal, pages[0], this.now());
    if (autoFinal && (!Array.isArray(pages) || pages.length !== 1
      || pages[0]?.conversationId !== goal.conversationId
      || pages[0]?.runtimeKey !== autoFinal.runtimeKey
      || pages[0]?.pageTargetId !== autoFinal.pageTargetId
      || pages[0]?.latestUserMessageId !== autoFinal.sourceUserMessageId
      || pages[0]?.latestAssistantMessageId !== autoFinal.assistantMessageId
      || digest(pages[0]?.latestAssistantText) !== autoFinal.assistantTextHash
      || !finalPage(pages[0]))) {
      return { armed: false, reason: 'native-final-page-not-current' };
    }
    const current = await this.goalRuntime.status(goal.id);
    if (!pending(current) || current.continuation.continuationId !== id || this.closed) return { armed: false, reason: 'goal-changed' };
    if (this.records.has(id)) {
      const existing = this.records.get(id);
      return { armed: existing.state === 'waiting', state: existing.state };
    }
    if (this.records.size >= this.maxRecords) {
      for (const [key,row] of this.records) {
        if (['delivered','cancelled','superseded'].includes(row.state)) { this.records.delete(key); break; }
      }
      if (this.records.size >= this.maxRecords) return { armed: false, reason: 'journal-capacity-protected' };
    }
    const causalDisplayProof = !sourceRuntimeKey && new Set(pages.map(p=>p.latestUserMessageId)).size > 1;
    if (causalDisplayProof) {
      const awaiting = pages.filter(p => p.generating === true || p.latestMessageRole === 'user');
      // A later final is not causal proof if two different unfinished branches
      // were already present when the report arrived. Do not race the first
      // branch to finish; require an exact request receipt to disambiguate it.
      if (new Set(awaiting.map(p => p.latestUserMessageId)).size !== 1) {
        return { armed: false, reason: 'ambiguous-unfinished-source-turns' };
      }
    }
    const row = {
      goalId: goal.id, continuationId: id, conversationId: goal.conversationId, round: goal.round,
      reportedAt: boundaryAt, sourceUserId: pages[0].latestUserMessageId,
      sourceRuntimeKey,
      sourcePageTargetId: pages[0].pageTargetId || null,
      nativeCompletionProof: autoFinal ? { ...autoFinal } : null,
      recoveredMissingArm: Boolean(autoFinal),
      nativeFinalVerified: Boolean(autoFinal),
      finalAssistantId: autoFinal ? autoFinal.assistantMessageId : null,
      finalAssistantHash: autoFinal ? autoFinal.assistantTextHash : null,
      causalDisplayProof,
      sourceCandidates: causalDisplayProof ? pages.map(p=>({pageTargetId:p.pageTargetId,
        userId:p.latestUserMessageId,assistantId:p.latestAssistantMessageId,hash:digest(p.latestAssistantText),
        awaitingAssistant:p.generating===true||p.latestMessageRole==='user'})) : null,
      baseline: autoFinal ? [] : (resume && !causalDisplayProof ? [] : pages.map(p => ({ id: p.latestAssistantMessageId || null, hash: digest(p.latestAssistantText) }))),
      state: 'waiting', reason: autoFinal ? 'verified-native-final-auto-continuation' : 'awaiting-visible-final', attempts: 0, createdAt: this.now(),
    };
    this.records.set(id, row);
    try { await this.save(); }
    catch (error) {
      // An unpersisted record must not remain armed only in this process.
      this.records.delete(id);
      throw error;
    }
    return { armed: true, state: row.state };
  }
  start() {
    if (this.enabled && !this.closed && !this.timer) {
      this.timer = setInterval(() => { void this.pollOnce().catch(error => { this.lastError = error.message; }); }, this.pollMs);
      this.timer.unref?.();
    }
  }
  scheduleMissingArmRetry(continuationId, error) {
    const attempts = Math.max(0, Number(this.missingArmAttempts.get(continuationId) || 0)) + 1;
    const delayMs = Math.min(5 * 60_000, UNARMED_RECOVERY_RETRY_MS * (2 ** Math.min(6, attempts - 1)));
    this.missingArmAttempts.set(continuationId, attempts);
    this.missingArmRetryAt.set(continuationId, this.now() + delayMs);
    this.missingArmErrors.set(continuationId, String(error || 'exact-boundary-unresolved').slice(0, 500));
    return { attempts, delayMs };
  }
  clearMissingArmRetry(continuationId) {
    this.missingArmRetryAt.delete(continuationId);
    this.missingArmAttempts.delete(continuationId);
    this.missingArmErrors.delete(continuationId);
  }
  async recoverMissingArms() {
    if (typeof this.goalRuntime.activeGoals !== 'function' || this.closed || !this.enabled) return [];
    const goals = await this.goalRuntime.activeGoals({ limit: 50 });
    const activeContinuationIds = new Set(goals
      .filter(goal => pending(goal))
      .map(goal => goal.continuation?.continuationId)
      .filter(Boolean));
    for (const continuationId of this.missingArmRetryAt.keys()) {
      if (!activeContinuationIds.has(continuationId)) this.missingArmRetryAt.delete(continuationId);
    }
    for (const continuationId of this.missingArmErrors.keys()) {
      if (!activeContinuationIds.has(continuationId)) this.missingArmErrors.delete(continuationId);
    }
    for (const continuationId of this.missingArmAttempts.keys()) {
      if (!activeContinuationIds.has(continuationId)) this.missingArmAttempts.delete(continuationId);
    }

    const results = [];
    const candidates = goals.filter(goal => pending(goal)
      && goal.continuation?.continuationId
      && !this.records.has(goal.continuation.continuationId)).slice(0, 3);
    for (const goal of candidates) {
      if (!pending(goal)) continue;
      const continuationId = goal.continuation?.continuationId;
      if (!continuationId || this.records.has(continuationId)) continue;
      if (typeof this.goalRuntime.hasConversationCollision === 'function'
        && await this.goalRuntime.hasConversationCollision({ goalId: goal.id }).catch(() => true)) {
        results.push({ goalId: goal.id, round: goal.round, recovered: false, reason: 'conversation-goal-conflict' });
        continue;
      }
      const retryAt = Number(this.missingArmRetryAt.get(continuationId) || 0);
      if (retryAt > this.now()) {
        results.push({ goalId: goal.id, round: goal.round, recovered: false, reason: 'missing-arm-retry-floor' });
        continue;
      }
      let pages;
      const inspectionOutcome = {};
      const nativeFinal = nativeCompletionProof(goal);
      try {
        pages = await this.pages(goal, {
          // A persisted exact native-final receipt is revalidated with the
          // authoritative stream_status endpoint as well as the native branch.
          // sourceOnly skips that endpoint, leaving streamStatus=null and
          // forcing a valid completion into the human-supersession fallback.
          sourceOnly: !nativeFinal,
          runtimeKey: nativeFinal?.runtimeKey || null,
          pageTargetId: nativeFinal?.pageTargetId || null,
          allowDivergent: !nativeFinal,
          includeNativeBranch: true,
          inspectionOutcome,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.scheduleMissingArmRetry(continuationId, message);
        results.push({ goalId: goal.id, round: goal.round, recovered: false, reason: 'missing-arm-inspection-failed' });
        continue;
      }
      const proof = exactMissingArmBoundary(goal, pages, this.now());
      if (!proof) {
        this.scheduleMissingArmRetry(continuationId, inspectionOutcome.reason || 'exact-boundary-unresolved');
        results.push({ goalId: goal.id, round: goal.round, recovered: false, reason: 'missing-arm-boundary-unresolved' });
        continue;
      }

      const current = await this.goalRuntime.status(goal.id).catch(() => null);
      if (!pending(current) || current.continuation?.continuationId !== continuationId || this.records.has(continuationId)) {
        this.clearMissingArmRetry(continuationId);
        results.push({ goalId: goal.id, round: goal.round, recovered: false, reason: 'missing-arm-race-superseded' });
        continue;
      }

      if (proof.type === 'human-user') {
        await this.goalRuntime.roundBegin({
          goalId: goal.id,
          continuationId,
          roundBeganAt: proof.newUserObservedAt,
        });
        const row = {
          goalId: goal.id,
          continuationId,
          conversationId: goal.conversationId,
          round: goal.round,
          reportedAt: nativeCompletionProof(goal)?.completedAt || goal.lastRoundReport?.reportedAt || null,
          sourceUserId: proof.sourceUserId || proof.newUserMessageId,
          sourceRuntimeKey: pages.length === 1 ? pages[0].runtimeKey || null : null,
          causalDisplayProof: false,
          sourceCandidates: null,
          baseline: proof.finalAssistantId ? [{ id: proof.finalAssistantId, hash: null }] : [],
          state: 'delivered',
          reason: 'human-user-turn-started-next-round',
          attempts: 0,
          createdAt: this.now(),
          finalAssistantId: proof.finalAssistantId || null,
          redeemed: true,
          deliveryMode: 'human-user-continuation',
          manualUserMessageId: proof.newUserMessageId,
          manualUserObservedAt: proof.newUserObservedAt,
          manualTimestampRetryAt: null,
          hiddenEpisodeNotified: true,
          hiddenEpisodeSkipReason: 'human-user-turn-started-next-round',
          recoveredMissingArm: true,
        };
        this.records.set(continuationId, row);
        try { await this.save(); }
        catch (error) {
          // GoalRuntime consumption is the durable exactly-once authority. A
          // lost diagnostic row must never roll the Goal back or replay it.
          this.records.delete(continuationId);
          throw error;
        }
        this.recoveredMissingArmCount += 1;
        this.clearMissingArmRetry(continuationId);
        results.push({ goalId: goal.id, round: goal.round, recovered: true, reason: 'missing-arm-human-user-redeemed' });
        continue;
      }

      if (this.records.size >= this.maxRecords) {
        for (const [key, row] of this.records) {
          if (['delivered', 'cancelled', 'superseded'].includes(row.state)) { this.records.delete(key); break; }
        }
      }
      if (this.records.size >= this.maxRecords) {
        this.scheduleMissingArmRetry(continuationId, 'journal-capacity-protected');
        results.push({ goalId: goal.id, round: goal.round, recovered: false, reason: 'journal-capacity-protected' });
        continue;
      }
      const row = {
        goalId: goal.id,
        continuationId,
        conversationId: goal.conversationId,
        round: goal.round,
        reportedAt: nativeCompletionProof(goal)?.completedAt || goal.lastRoundReport?.reportedAt || null,
        sourceUserId: proof.sourceUserId,
        sourceRuntimeKey: pages.length === 1 ? pages[0].runtimeKey || null : null,
        sourcePageTargetId: pages.length === 1 ? pages[0].pageTargetId || null : null,
        causalDisplayProof: false,
        sourceCandidates: null,
        baseline: proof.type === 'completed-final'
          ? []
          : (Array.isArray(proof.baseline) ? proof.baseline : []),
        state: 'waiting',
        reason: proof.type === 'completed-final'
          ? 'recovered-missing-arm-current-final'
          : 'recovered-missing-arm-awaiting-final',
        attempts: 0,
        createdAt: this.now(),
        recoveredMissingArm: true,
        nativeFinalVerified: proof.type === 'completed-final',
        nativeCompletionProof: proof.type === 'completed-final' && (proof.nativeCompletionProof || nativeFinal)
          ? { ...(proof.nativeCompletionProof || nativeFinal) }
          : null,
        finalAssistantId: proof.type === 'completed-final' ? proof.finalAssistantId : null,
        finalAssistantHash: proof.type === 'completed-final' ? proof.finalAssistantHash : null,
      };
      this.records.set(continuationId, row);
      try { await this.save(); }
      catch (error) {
        this.records.delete(continuationId);
        throw error;
      }
      this.recoveredMissingArmCount += 1;
      this.clearMissingArmRetry(continuationId);
      results.push({ goalId: goal.id, round: goal.round, recovered: true, reason: row.reason });
    }
    return results;
  }
  async pollOnce() {
    await this.ready;
    if (!this.enabled || this.closed) return { ok: true, skipped: true };
    if (this.polling) return this.polling;
    this.polling = this.poll().finally(() => { this.polling = null; });
    return this.polling;
  }
  async poll() {
    let cycleError = null;
    try { await this.recoverMissingArms(); }
    catch (error) { cycleError = error instanceof Error ? error.message : String(error); }
    for (const row of this.records.values()) {
      if (this.closed) break;
      if (row.state === 'superseded' && row.reason === 'goal-stopped-paused-or-consumed'
        && row.dispatchCommitted === false) {
        try { await this.repairLegacyLeaseSupersession(row); }
        catch (error) { cycleError = error.message; }
        continue;
      }
      if (row.state === 'cancelled' && HUMAN_SUPERSESSION_REASONS.has(row.reason)) {
        try { await this.reconcileHumanSupersession(row); }
        catch (error) { cycleError = error.message; }
        continue;
      }
      if (row.state === 'delivered' && row.redeemed === true
        && row.deliveryMode === 'human-user-continuation'
        && !row.manualUserObservedAt
        && (row.manualTimestampRetryAt || 0) <= this.now()) {
        try { await this.repairHumanRoundBoundary(row); }
        catch (error) { cycleError = error.message; }
        continue;
      }
      if (row.state === 'delivered' && row.redeemed === true
        && row.deliveryMode === 'hidden-assistant-continuation'
        && row.hiddenEpisodeNotified !== true) {
        try { await this.notifyHiddenContinuationStarted(row); }
        catch (error) { cycleError = error.message; }
        continue;
      }
      if (!['waiting','uncertain'].includes(row.state) || (row.retryAt || 0) > this.now()) continue;
      try { if (row.state === 'uncertain') await this.reconcile(row); else await this.advance(row); }
      catch (error) { cycleError = error.message; row.reason = 'inspection-or-persistence-error'; }
    }
    this.lastError = cycleError;
    return { ok: !this.lastError, ...this.status() };
  }
  async notifyHiddenContinuationStarted(row) {
    if (row.hiddenEpisodeNotified === true || row.redeemed !== true
      || row.deliveryMode !== 'hidden-assistant-continuation') return false;
    const goal = await this.goalRuntime.status(row.goalId).catch(() => null);
    if (!goal || goal.status !== 'active' || goal.roundState !== 'working'
      || goal.round !== Number(row.round || 0) + 1
      || goal.lastConsumedContinuationId !== row.continuationId) {
      row.hiddenEpisodeNotified = true;
      row.hiddenEpisodeSkipReason = 'goal-already-advanced-or-not-working';
      await this.save();
      return false;
    }
    const pages = await this.pages(goal, {
      sourceOnly: true,
      runtimeKey: row.dispatchRuntimeKey || row.sourceRuntimeKey || null,
      pageTargetId: row.dispatchPageTargetId || null,
      allowDivergent: true,
    });
    if (!pages?.length) return false;
    const currentUsers = new Set(pages.map(page => page.latestUserMessageId).filter(Boolean));
    if (row.sourceUserId && (currentUsers.size !== 1 || !currentUsers.has(row.sourceUserId))) {
      row.hiddenEpisodeNotified = true;
      row.hiddenEpisodeSkipReason = 'new-user-superseded-hidden-continuation';
      await this.save();
      return false;
    }
    if (this.onHiddenContinuationStarted) {
      await this.onHiddenContinuationStarted({
        goalId: row.goalId,
        conversationId: row.conversationId,
        continuationId: row.continuationId,
        sourceUserMessageId: row.sourceUserId,
        runtimeKey: row.dispatchRuntimeKey || row.sourceRuntimeKey || null,
        round: Number(row.round || 0) + 1,
        observedAtMs: Number(row.sentAt || row.createdAt || this.now()),
      });
    }
    row.hiddenEpisodeNotified = true;
    row.hiddenEpisodeSkipReason = null;
    await this.save();
    return true;
  }
  matchesFinal(row, pages) {
    const recoveredExactFinal = Boolean(
      row?.recoveredMissingArm === true
      && row?.nativeFinalVerified === true
      && row?.finalAssistantId
      && row?.finalAssistantHash
      && pages?.length
      && pages.every(p => p.latestUserMessageId === row.sourceUserId
        && p.latestAssistantMessageId === row.finalAssistantId
        && digest(p.latestAssistantText) === row.finalAssistantHash
        && p.latestMessageRole === 'assistant'
        && p.generating !== true
        && Boolean(p.latestAssistantText?.trim())
        && !p.safetyCheckVisible
        && !p.nativeSafetyBlocked
        && !p.deliveryTimeoutVisible
        && !p.retryVisible
        && (!row.nativeCompletionProof
          || (p.runtimeKey === row.nativeCompletionProof.runtimeKey
            && p.pageTargetId === row.nativeCompletionProof.pageTargetId)))
    );
    // A persisted native final is an exact boundary, not permission to accept
    // any later final just because the recovered row has an empty baseline.
    if (row?.recoveredMissingArm === true && row?.nativeFinalVerified === true) return recoveredExactFinal;
    return pages && pages.every(p => p.latestUserMessageId === row.sourceUserId && finalPage(p))
      && new Set(pages.map(p => `${p.latestAssistantMessageId}:${digest(p.latestAssistantText)}`)).size === 1
      && !row.baseline.some(b => b.id === pages[0].latestAssistantMessageId && b.hash === digest(pages[0].latestAssistantText));
  }
  async finalCandidates(goal,row) {
    if (!row.causalDisplayProof) return {pages:await this.pages(goal,{
      runtimeKey:row.sourceRuntimeKey,
      pageTargetId:row.sourcePageTargetId||row.nativeCompletionProof?.pageTargetId||row.dispatchPageTargetId||null,
    })};
    const all=await this.pages(goal,{allowDivergent:true});
    if(!all)return {pages:null};
    const knownUsers=new Set(row.sourceCandidates.map(p=>p.userId));
    // Synchronizing a stale display to an already-captured user is harmless;
    // an actually NEW user in any display cancels this report's continuation.
    const newUserPage=all.find(p=>!knownUsers.has(p.latestUserMessageId));
    if(newUserPage)return {pages:null,newUser:true,newUserMessageId:newUserPage.latestUserMessageId||null};
    const changed=all.filter(p=>{
      const before=row.sourceCandidates.find(b=>b.pageTargetId===p.pageTargetId);
      return before?.awaitingAssistant===true && p.latestUserMessageId===before.userId && finalPage(p)
        && (p.latestAssistantMessageId!==before.assistantId || digest(p.latestAssistantText)!==before.hash);
    });
    const outcomes=new Set(changed.map(p=>`${p.latestUserMessageId}:${p.latestAssistantMessageId}:${digest(p.latestAssistantText)}`));
    if(outcomes.size!==1)return {pages:null};
    // The causal proof is a new final AFTER this exact report's captured
    // boundary, not a guess based on which Runtime happens to look active.
    row.sourceUserId=changed[0].latestUserMessageId;
    return {pages:changed};
  }
  async redeemHumanContinuation(row, {
    userMessageId = null,
    observedAt = null,
    reason = 'human-user-turn-started-next-round',
  } = {}) {
    const goal = await this.goalRuntime.status(row.goalId).catch(() => null);
    if (!goal || goal.status !== 'active') return false;
    if (goal.lastConsumedContinuationId === row.continuationId) {
      if (observedAt) {
        await this.goalRuntime.roundBegin({
          goalId:row.goalId,
          continuationId:row.continuationId,
          roundBeganAt:observedAt,
        });
      }
      row.state='delivered'; row.redeemed=true; row.reason=reason;
      row.deliveryMode='human-user-continuation';
      row.manualUserMessageId=userMessageId||row.manualUserMessageId||null;
      row.manualUserObservedAt=observedAt||row.manualUserObservedAt||null;
      row.manualTimestampRetryAt=null;
      row.hiddenEpisodeNotified=true;
      row.hiddenEpisodeSkipReason='human-user-turn-started-next-round';
      await this.save();
      return true;
    }
    if (!redeemable(goal) || goal.round !== row.round
      || goal.continuation?.continuationId !== row.continuationId) return false;
    await this.goalRuntime.roundBegin({
      goalId:row.goalId,
      continuationId:row.continuationId,
      roundBeganAt:observedAt,
    });
    if (row.leaseId) {
      await this.goalRuntime.continuation({goalId:row.goalId,action:'ack',leaseId:row.leaseId}).catch(() => {});
    }
    row.state='delivered'; row.redeemed=true; row.reason=reason;
    row.deliveryMode='human-user-continuation';
    row.manualUserMessageId=userMessageId||null;
    row.manualUserObservedAt=observedAt||null;
    row.manualTimestampRetryAt=observedAt?null:this.now()+5_000;
    row.hiddenEpisodeNotified=true;
    row.hiddenEpisodeSkipReason='human-user-turn-started-next-round';
    await this.save();
    return true;
  }
  async humanSupersessionProof(row, goal) {
    const baselineIds=row.finalAssistantId
      ? [row.finalAssistantId]
      : [...new Set((Array.isArray(row.baseline)?row.baseline:[]).map(item=>item?.id).filter(Boolean))];
    if (baselineIds.length !== 1) return null;
    const pages = await this.pages(goal, {
      runtimeKey: row.dispatchRuntimeKey || row.sourceRuntimeKey || null,
      pageTargetId: row.dispatchPageTargetId || null,
      allowDivergent: true,
      includeNativeBranch: true,
      sourceUserMessageId: row.sourceUserId,
      baselineAssistantMessageId: baselineIds[0],
    });
    if (!pages || pages.length !== 1) return null;
    const proof=pages[0].nativeContinuation;
    if (!proof?.resolved || proof.sourceUserFound !== true || proof.baselineAssistantFound !== true) return null;
    const userIndex=Number(proof.newUserAfterBaselineIndex);
    const assistantIndex=Number(proof.newAssistantAfterBaselineIndex);
    const userFirst=userIndex>=0 && (assistantIndex<0 || userIndex<assistantIndex);
    if (!userFirst || !proof.newUserAfterBaselineMessageId) return null;
    return {
      userMessageId: proof.newUserAfterBaselineMessageId,
      observedAt: proof.newUserAfterBaselineCreatedAt || null,
    };
  }
  async repairHumanRoundBoundary(row) {
    const goal = await this.goalRuntime.status(row.goalId).catch(() => null);
    if (!goal || goal.status !== 'active'
      || goal.lastConsumedContinuationId !== row.continuationId
      || goal.round !== Number(row.round || 0) + 1
      || goal.roundState !== 'working') {
      row.manualTimestampResolution='superseded';
      row.manualTimestampRetryAt=null;
      await this.save();
      return false;
    }
    const proof=await this.humanSupersessionProof(row,goal);
    if (!proof?.observedAt) {
      row.manualTimestampRetryAt=this.now()+30_000;
      row.manualTimestampAttempts=Number(row.manualTimestampAttempts||0)+1;
      await this.save();
      return false;
    }
    return await this.redeemHumanContinuation(row, {
      ...proof,
      reason:'human-user-turn-started-next-round',
    });
  }
  async reconcileHumanSupersession(row) {
    const goal = await this.goalRuntime.status(row.goalId).catch(() => null);
    if (!goal || goal.status !== 'active') return false;
    const alreadyConsumed=goal.lastConsumedContinuationId === row.continuationId;
    if (!alreadyConsumed && (
      !redeemable(goal)
      || goal.round !== row.round
      || goal.continuation?.continuationId !== row.continuationId
    )) return false;
    const proof=await this.humanSupersessionProof(row,goal);
    if (!proof && !alreadyConsumed) return false;
    return await this.redeemHumanContinuation(row, {
      userMessageId: proof?.userMessageId || row.manualUserMessageId || null,
      observedAt: proof?.observedAt || row.manualUserObservedAt || null,
      reason: 'human-user-turn-started-next-round',
    });
  }
  async repairLegacyLeaseSupersession(row) {
    const goal = await this.goalRuntime.status(row.goalId).catch(() => null);
    if (!goal || goal.status !== 'active' || goal.conversationId !== row.conversationId) return false;
    const sameContinuation = redeemable(goal) && goal.round === row.round
      && goal.continuation?.continuationId === row.continuationId;
    const alreadyConsumed = goal.lastConsumedContinuationId === row.continuationId
      && goal.round === Number(row.round) + 1 && goal.roundState === 'working';
    if (!sameContinuation && !alreadyConsumed) return false;
    // The old driver treated a temporarily foreign lease as a stopped Goal.
    // A real human turn repairs accounting; it never becomes an automatic pass.
    const proof = await this.humanSupersessionProof(row, goal);
    if (proof?.userMessageId) return this.redeemHumanContinuation(row, {
      ...proof, reason: 'human-user-turn-started-next-round',
    });
    if (!sameContinuation) return false;
    // We cannot prove what that other lease owner sent. Do not replay it merely
    // because the lease expired or because our own earlier attempt was unsent.
    row.state = 'uncertain'; row.reason = 'legacy-active-lease-awaiting-native-reconciliation';
    row.dispatchDefiniteFailure = false;
    await this.save();
    return true;
  }
  async reconcile(row) {
    const goal = await this.goalRuntime.status(row.goalId);
    if (goal.status !== 'active' || this.closed) return;
    if (goal.lastConsumedContinuationId === row.continuationId) {
      row.state='delivered'; row.redeemed=true; row.reason='agent-redeemed-uncertain-delivery';
      await this.save();
      await this.notifyHiddenContinuationStarted(row);
      return;
    }
    if (goal.continuation?.continuationId !== row.continuationId || !row.finalAssistantId) return;
    if (row.deliveryMode === 'hidden-assistant-continuation') {
      const pages = await this.pages(goal, {
        runtimeKey: row.dispatchRuntimeKey || row.sourceRuntimeKey,
        pageTargetId: row.dispatchPageTargetId,
        allowDivergent: true,
        includeNativeBranch: true,
        sourceUserMessageId: row.sourceUserId,
        baselineAssistantMessageId: row.finalAssistantId,
      });
      if (this.closed || !pages || pages.length !== 1) return;
      const proof = pages[0].nativeContinuation;
      if (!proof?.resolved || proof.sourceUserFound !== true || proof.baselineAssistantFound !== true) {
        row.reconciliationAttempts = Number(row.reconciliationAttempts || 0) + 1;
        row.retryAt = this.now() + Math.min(60_000, 5_000 * (2 ** Math.min(4, row.reconciliationAttempts - 1)));
        row.reconciliationState = proof?.state || 'native-branch-unresolved';
        await this.save();
        return;
      }
      const assistantIndex = Number(proof.newAssistantAfterBaselineIndex);
      const userIndex = Number(proof.newUserAfterBaselineIndex);
      const hiddenAssistantFirst = assistantIndex >= 0 && (userIndex < 0 || assistantIndex < userIndex);
      if (!hiddenAssistantFirst) {
        if (userIndex >= 0) {
          const redeemed=await this.redeemHumanContinuation(row, {
            userMessageId: proof.newUserAfterBaselineMessageId || null,
            observedAt: proof.newUserAfterBaselineCreatedAt || null,
            reason: 'human-user-turn-started-next-round',
          });
          if (!redeemed) {
            row.state='cancelled'; row.reason='new-user-turn-before-hidden-continuation'; await this.save();
          }
        }
        return;
      }
      if (proof.latestUserMessageId !== row.sourceUserId || !proof.newAssistantAfterBaselineMessageId) return;
      row.state='delivered'; row.reason='uncertain-hidden-send-confirmed-by-native-branch';
      await this.save();
      try {
        await this.goalRuntime.roundBegin({goalId:row.goalId,continuationId:row.continuationId});
        if (row.leaseId) {
          await this.goalRuntime.continuation({goalId:row.goalId,action:'ack',leaseId:row.leaseId}).catch(() => {});
        }
        row.redeemed=true;
      } catch { row.reason='delivered-awaiting-agent-redemption'; }
      await this.save();
      await this.notifyHiddenContinuationStarted(row);
      return;
    }
    const pages = await this.pages(goal, { runtimeKey: row.sourceRuntimeKey });
    if (this.closed || !pages || !pages.every(p =>
      p.latestUserMessageId !== row.sourceUserId && p.previousUserMessageId === row.sourceUserId
      && p.assistantBeforeLatestUserMessageId === row.finalAssistantId
      && String(p.latestUserText || '').replace(/^DevSpace Local Gateway\s*/, '').trim() === '- 繼續')) return;
    row.state='delivered'; row.reason='uncertain-send-confirmed-by-exact-message-sequence';
    await this.save();
    try { await this.goalRuntime.roundBegin({goalId:row.goalId,continuationId:row.continuationId}); row.redeemed=true; }
    catch { row.reason='delivered-awaiting-agent-redemption'; }
    await this.save();
  }
  async advance(row) {
    const goal = await this.goalRuntime.status(row.goalId);
    if (redeemable(goal) && goal.round === row.round
      && goal.continuation?.continuationId === row.continuationId
      && ['dispatching', 'dispatched'].includes(goal.continuation.state)) {
      row.state = 'uncertain'; row.reason = 'active-lease-awaiting-native-reconciliation';
      row.deliveryMode = 'hidden-assistant-continuation';
      row.leaseId = goal.continuation.leaseId || row.leaseId;
      row.dispatchDefiniteFailure = false;
      await this.save();
      return;
    }
    if (!pending(goal) || goal.continuation.continuationId !== row.continuationId || goal.round !== row.round) {
      row.state = 'superseded'; row.reason = 'goal-stopped-paused-or-consumed'; await this.save(); return;
    }
    let selected = await this.finalCandidates(goal,row);
    if(selected.newUser){
      const redeemed=await this.redeemHumanContinuation(row, {
        userMessageId:selected.newUserMessageId||null,
        reason:'human-user-turn-started-next-round',
      });
      if(!redeemed){row.state='cancelled';row.reason='new-user-turn-takes-precedence';await this.save();}
      return;
    }
    let pages = selected.pages;
    if (!pages) { row.reason = 'exact-page-unavailable'; return; }
    if (pages.some(p => p.latestUserMessageId !== row.sourceUserId)) {
      const nextUser=pages.find(p=>p.latestUserMessageId!==row.sourceUserId)?.latestUserMessageId||null;
      const redeemed=await this.redeemHumanContinuation(row, {
        userMessageId:nextUser,
        reason:'human-user-turn-started-next-round',
      });
      if(!redeemed){row.state = 'cancelled'; row.reason = 'new-user-turn-takes-precedence'; await this.save();}
      return;
    }
    if (!this.matchesFinal(row, pages)) { row.reason = 'awaiting-current-final'; row.candidateKey = null; return; }
    if (pages.length === 1 && pages[0].boundarySource === 'native-goal-start-tool-result') {
      const nativeProof = receiptNativeFinalProof(goal, pages[0], this.now());
      if (!nativeProof) { row.reason = 'native-start-final-proof-unavailable'; row.candidateKey = null; return; }
      row.nativeCompletionProof = nativeProof;
      row.nativeFinalVerified = true;
    }
    const key = pages.map(p => `${p.pageTargetId}:${p.latestAssistantMessageId}:${digest(p.latestAssistantText)}`).join('|');
    if (row.candidateKey !== key) { row.candidateKey = key; row.settledAt = this.now(); return; }
    if (this.now() - row.settledAt < this.settleMs || this.closed) return;
    // Exclusive GoalRuntime lease also arbitrates the legacy app dispatch path.
    const claimed = await this.goalRuntime.continuation({ goalId: row.goalId, action: 'claim' });
    const leaseId = claimed.claim.leaseId;
    try {
      selected = await this.finalCandidates(goal,row);
    } catch {
      // No host transport has run. An inspection timeout is unavailable
      // evidence, not proof that a user changed the boundary.
      selected = { pages: null };
    }
    pages = selected.pages;
    const current = await this.goalRuntime.status(row.goalId);
    if (this.closed || current.status !== 'active' || current.roundState !== 'reported'
      || current.round !== row.round || current.continuation?.continuationId !== row.continuationId
      || current.continuation?.leaseId !== leaseId || selected.newUser) {
      await this.goalRuntime.continuation({ goalId: row.goalId, action: 'release', leaseId }).catch(() => {});
      row.state = 'cancelled'; row.reason = 'pre-send-boundary-changed'; await this.save(); return;
    }
    if (!pages) {
      // Release only this uncommitted lease, retain the journal, and require
      // another fresh settled boundary after bounded backoff. Never send from
      // the earlier positive inspection, revive a cancelled row, or replay a
      // possibly committed transport.
      await this.goalRuntime.continuation({ goalId: row.goalId, action: 'release', leaseId });
      row.state = 'waiting'; row.reason = 'pre-send-boundary-unavailable';
      row.retryAt = this.now() + 5000; row.candidateKey = null; row.settledAt = null;
      await this.save(); return;
    }
    if (!this.matchesFinal(row, pages)) {
      await this.goalRuntime.continuation({ goalId: row.goalId, action: 'release', leaseId }).catch(() => {});
      row.state = 'cancelled'; row.reason = 'pre-send-boundary-changed'; await this.save(); return;
    }
    row.state = 'dispatching'; row.attempts += 1; row.leaseId = leaseId; row.sentAt = this.now();
    row.finalAssistantId = pages[0].latestAssistantMessageId;
    row.deliveryMode = 'hidden-assistant-continuation';
    row.dispatchRuntimeKey = pages[0].runtimeKey || row.sourceRuntimeKey || null;
    row.dispatchPageTargetId = pages[0].pageTargetId || null;
    if(row.causalDisplayProof)row.sourceRuntimeKey=pages[0].runtimeKey||null;
    try {
      await this.save(); // durable before any possible transport side effect
    } catch (error) {
      // No host transport has run yet. Roll back the in-memory dispatch marker
      // and release the exclusive Goal lease so one transient disk failure
      // cannot leave this round permanently stuck in `dispatching`.
      await this.goalRuntime.continuation({ goalId: row.goalId, action: 'release', leaseId }).catch(() => {});
      row.state = 'waiting'; row.reason = 'pre-send-journal-persist-failed';
      row.retryAt = this.now() + 5000; row.leaseId = null; row.sentAt = null;
      row.finalAssistantId = null; row.deliveryMode = null;
      row.dispatchRuntimeKey = null; row.dispatchPageTargetId = null;
      await this.save().catch(() => {});
      this.lastError = error instanceof Error ? error.message : String(error);
      return;
    }
    const authorized = await this.goalRuntime.status(row.goalId);
    if (this.closed || authorized.status !== 'active' || authorized.roundState !== 'reported'
      || authorized.continuation?.leaseId !== leaseId) {
      row.state='cancelled'; row.reason='control-change-before-transport';
      await this.save(); return;
    }
    let sent;
    try {
      sent = await this.dispatch({ goal: current, page: pages[0], sourceUserId: row.sourceUserId,
        assistantMessageId: pages[0].latestAssistantMessageId,
        nativeCompletionProof: row.nativeCompletionProof || null,
        prompt: claimed.claim.prompt,
        continuationId: claimed.claim.continuationId,
        leaseId: claimed.claim.leaseId,
        round: claimed.claim.round,
        reportedAt: row.reportedAt || null });
    } catch (error) { sent = { ok: false, definiteFailure: false, error: error.message }; }
    row.dispatchCommitted = sent?.dispatchCommitted === true;
    row.dispatchDefiniteFailure = sent?.definiteFailure === true;
    row.dispatchState = sent?.state || null;
    row.dispatchError = sent?.error || null;
    if (sent?.ok === true && (sent.backgroundAccepted === true || sent.visibilityVerified === true)) {
      row.state = 'delivered'; row.reason = sent.backgroundAccepted === true
        ? 'one-hidden-continuation'
        : 'one-visible-continuation';
      await this.save();
      try {
        await this.goalRuntime.roundBegin({ goalId: row.goalId, continuationId: row.continuationId });
        await this.goalRuntime.continuation({ goalId: row.goalId, action: 'ack', leaseId });
        row.redeemed = true;
      } catch { row.reason = 'delivered-awaiting-agent-redemption'; }
      await this.save();
      await this.notifyHiddenContinuationStarted(row);
      return;
    }
    if (sent?.definiteFailure === true && sent.dispatchCommitted === false) {
      await this.goalRuntime.continuation({ goalId: row.goalId, action: 'release', leaseId }).catch(() => {});
      row.state = 'waiting';
      row.retryAt = this.now() + Math.min(60_000, 5_000 * (2 ** Math.min(4, row.attempts - 1)));
      row.reason = sent.state || 'definite-preflight-failure';
    } else {
      row.state = 'uncertain'; row.reason = sent?.state || 'delivery-acknowledgement-lost';
      // Never release an uncertain send for an automatic retry.
    }
    await this.save();
  }
  async requestDispatch(goalId) {
    await this.pollOnce();
    const rows = [...this.records.values()].filter(r => r.goalId === goalId);
    const row = rows.at(-1);
    return { ok: true, backendOwned: true, state: row?.state || 'unarmed', dispatched: row?.state === 'delivered' };
  }
  status() {
    return { enabled: this.enabled, running: Boolean(this.timer), lastError: this.lastError,
      relayLookup: this.relayDiagnostics?.() ?? null,
      lastArmError: this.lastArmError,
      lastPersistError: this.lastPersistError || null,
      persistFailureCount: Number(this.persistFailureCount || 0),
      persistRecoveryCount: Number(this.persistRecoveryCount || 0),
      recoveredMissingArmCount: this.recoveredMissingArmCount,
      missingArmPending: this.missingArmErrors.size,
      missingArmErrors: [...this.missingArmErrors.entries()].map(([continuationId, error]) => ({
        continuationId,
        error,
        attempts: Number(this.missingArmAttempts.get(continuationId) || 0),
        retryAt: this.missingArmRetryAt.get(continuationId) || null,
      })),
      records: [...this.records.values()].map(r => ({ goalId: r.goalId, round: r.round, state: r.state,
        reason: r.reason, attempts: r.attempts, redeemed: r.redeemed === true,
        deliveryMode: r.deliveryMode || null,
        recoveredMissingArm: r.recoveredMissingArm === true,
        nativeFinalVerified: r.nativeFinalVerified === true,
        manualUserObservedAt: r.manualUserObservedAt || null,
        manualTimestampResolution: r.manualTimestampResolution || null,
        manualTimestampAttempts: Number(r.manualTimestampAttempts || 0),
        hiddenEpisodeNotified: r.hiddenEpisodeNotified === true,
        hiddenEpisodeSkipReason: r.hiddenEpisodeSkipReason || null })) };
  }
  async close() {
    this.closed = true; clearInterval(this.timer); this.timer = null;
    this.missingArmRetryAt.clear();
    this.missingArmAttempts.clear();
    this.missingArmErrors.clear();
    await this.polling?.catch(() => {}); await this.persistQueue.catch(() => {});
  }
}

export const goalContinuationSupervisorInternals = {
  finalPage,
  pending,
  exactMissingArmBoundary,
  nativeStopped,
};
