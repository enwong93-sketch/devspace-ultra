import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { atomicWriteJson } from './atomic-file.js';

const digest = text => createHash('sha256').update(String(text || '')).digest('hex');
const pending = goal => goal?.status === 'active' && goal.roundState === 'reported'
  && goal.continuation?.state === 'pending' && Boolean(goal.conversationId);
const finalPage = page => page?.chatMode === true && page.generating === false
  && page.streamStatus === 'COMPLETE' && page.latestMessageRole === 'assistant'
  && Boolean(page.latestAssistantMessageId) && Boolean(page.latestAssistantText?.trim())
  && !page.safetyCheckVisible && !page.deliveryTimeoutVisible && !page.retryVisible;

/** Backend owner of one report -> one continuation.
 * No UI App, timer-authored narration, runtime-only owner or optimistic retry.
 * The original user boundary is captured while the report tool is executing.
 * An ambiguous send is durably quarantined, including across Core restarts.
 */
export class GoalContinuationSupervisor {
  constructor({ goalRuntime, inspect, dispatch, statePath = null, enabled = true,
    now = () => Date.now(), pollMs = 1000, settleMs = 750, maxRecords = 128 } = {}) {
    if (!goalRuntime || typeof inspect !== 'function' || typeof dispatch !== 'function') throw new Error('Goal continuation adapters are required');
    Object.assign(this, { goalRuntime, inspect, dispatch, statePath, enabled, now, pollMs, settleMs, maxRecords });
    this.records = new Map(); this.timer = null; this.polling = null; this.closed = false;
    this.persistQueue = Promise.resolve(); this.lastError = null;
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
    this.persistQueue = this.persistQueue.then(() => atomicWriteJson(this.statePath, snapshot));
    await this.persistQueue;
  }
  async pages(goal, options = {}) {
    let rows = await this.inspect(goal, options);
    if (Array.isArray(rows) && options.runtimeKey) rows = rows.filter(p => p.runtimeKey === options.runtimeKey);
    if (Array.isArray(rows) && options.pageTargetId) rows = rows.filter(p => p.pageTargetId === options.pageTargetId);
    if (!Array.isArray(rows) || !rows.length || rows.length > 4) return null;
    if (rows.some(p => p?.conversationId !== goal.conversationId || !p.latestUserMessageId || p.chatMode !== true)) return null;
    if (!options.allowDivergent && new Set(rows.map(p => p.latestUserMessageId)).size !== 1) return null;
    return rows;
  }
  async arm(goal, { resume = false, reportAuthority = null } = {}) {
    await this.ready;
    if (!this.enabled || this.closed || !pending(goal)) return { armed: false, reason: 'not-eligible' };
    const id = goal.continuation.continuationId;
    if (this.records.has(id)) return { armed: this.records.get(id).state === 'waiting', state: this.records.get(id).state };
    // Never infer a source turn for old pending Goals merely found on disk.
    const reportAge = this.now() - Date.parse(goal.lastRoundReport?.reportedAt || '');
    if (!resume && (!Number.isFinite(reportAge) || reportAge < -1000 || reportAge > 120_000)) return { armed: false, reason: 'report-not-current' };
    // A live one-time receipt belonging to THIS report request can disambiguate
    // stale duplicate displays. Mere runtime preference can never do that.
    const sourceRuntimeKey = reportAuthority?.pageVerified === true
      && reportAuthority?.source === 'exact-progress-bootstrap-lease-page-verified'
      && reportAuthority?.conversationId === goal.conversationId
      && /^main-(0[1-9]|[12][0-9]|3[0-2])$/.test(reportAuthority?.runtimeKey || '')
      ? reportAuthority.runtimeKey : null;
    const pages = await this.pages(goal, { sourceOnly: true, runtimeKey: sourceRuntimeKey, allowDivergent: true });
    if (!pages) return { armed: false, reason: 'source-page-unresolved' };
    const current = await this.goalRuntime.status(goal.id);
    if (!pending(current) || current.continuation.continuationId !== id || this.closed) return { armed: false, reason: 'goal-changed' };
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
      reportedAt: goal.lastRoundReport.reportedAt, sourceUserId: pages[0].latestUserMessageId,
      sourceRuntimeKey,
      causalDisplayProof,
      sourceCandidates: causalDisplayProof ? pages.map(p=>({pageTargetId:p.pageTargetId,
        userId:p.latestUserMessageId,assistantId:p.latestAssistantMessageId,hash:digest(p.latestAssistantText),
        awaitingAssistant:p.generating===true||p.latestMessageRole==='user'})) : null,
      baseline: resume && !causalDisplayProof ? [] : pages.map(p => ({ id: p.latestAssistantMessageId || null, hash: digest(p.latestAssistantText) })),
      state: 'waiting', reason: 'awaiting-visible-final', attempts: 0, createdAt: this.now(),
    };
    this.records.set(id, row); await this.save();
    return { armed: true, state: row.state };
  }
  start() {
    if (this.enabled && !this.closed && !this.timer) {
      this.timer = setInterval(() => { void this.pollOnce().catch(error => { this.lastError = error.message; }); }, this.pollMs);
      this.timer.unref?.();
    }
  }
  async pollOnce() {
    await this.ready;
    if (!this.enabled || this.closed) return { ok: true, skipped: true };
    if (this.polling) return this.polling;
    this.polling = this.poll().finally(() => { this.polling = null; });
    return this.polling;
  }
  async poll() {
    for (const row of this.records.values()) {
      if (this.closed) break;
      if (!['waiting','uncertain'].includes(row.state) || (row.retryAt || 0) > this.now()) continue;
      try { if (row.state === 'uncertain') await this.reconcile(row); else await this.advance(row); }
      catch (error) { this.lastError = error.message; row.reason = 'inspection-or-persistence-error'; }
    }
    return { ok: !this.lastError, ...this.status() };
  }
  matchesFinal(row, pages) {
    return pages && pages.every(p => p.latestUserMessageId === row.sourceUserId && finalPage(p))
      && new Set(pages.map(p => `${p.latestAssistantMessageId}:${digest(p.latestAssistantText)}`)).size === 1
      && !row.baseline.some(b => b.id === pages[0].latestAssistantMessageId && b.hash === digest(pages[0].latestAssistantText));
  }
  async finalCandidates(goal,row) {
    if (!row.causalDisplayProof) return {pages:await this.pages(goal,{runtimeKey:row.sourceRuntimeKey})};
    const all=await this.pages(goal,{allowDivergent:true});
    if(!all)return {pages:null};
    const knownUsers=new Set(row.sourceCandidates.map(p=>p.userId));
    // Synchronizing a stale display to an already-captured user is harmless;
    // an actually NEW user in any display cancels this report's continuation.
    if(all.some(p=>!knownUsers.has(p.latestUserMessageId)))return {pages:null,newUser:true};
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
  async reconcile(row) {
    const goal = await this.goalRuntime.status(row.goalId);
    if (goal.status !== 'active' || this.closed) return;
    if (goal.lastConsumedContinuationId === row.continuationId) {
      row.state='delivered'; row.redeemed=true; row.reason='agent-redeemed-uncertain-delivery'; await this.save(); return;
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
      if (!proof?.resolved || proof.sourceUserFound !== true || proof.baselineAssistantFound !== true) return;
      const assistantIndex = Number(proof.newAssistantAfterBaselineIndex);
      const userIndex = Number(proof.newUserAfterBaselineIndex);
      const hiddenAssistantFirst = assistantIndex >= 0 && (userIndex < 0 || assistantIndex < userIndex);
      if (!hiddenAssistantFirst) {
        if (userIndex >= 0) {
          row.state='cancelled'; row.reason='new-user-turn-before-hidden-continuation'; await this.save();
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
    if (!pending(goal) || goal.continuation.continuationId !== row.continuationId || goal.round !== row.round) {
      row.state = 'superseded'; row.reason = 'goal-stopped-paused-or-consumed'; await this.save(); return;
    }
    let selected = await this.finalCandidates(goal,row);
    if(selected.newUser){row.state='cancelled';row.reason='new-user-turn-takes-precedence';await this.save();return;}
    let pages = selected.pages;
    if (!pages) { row.reason = 'exact-page-unavailable'; return; }
    if (pages.some(p => p.latestUserMessageId !== row.sourceUserId)) {
      row.state = 'cancelled'; row.reason = 'new-user-turn-takes-precedence'; await this.save(); return;
    }
    if (!this.matchesFinal(row, pages)) { row.reason = 'awaiting-current-final'; row.candidateKey = null; return; }
    const key = pages.map(p => `${p.pageTargetId}:${p.latestAssistantMessageId}:${digest(p.latestAssistantText)}`).join('|');
    if (row.candidateKey !== key) { row.candidateKey = key; row.settledAt = this.now(); return; }
    if (this.now() - row.settledAt < this.settleMs || this.closed) return;
    // Exclusive GoalRuntime lease also arbitrates the legacy app dispatch path.
    const claimed = await this.goalRuntime.continuation({ goalId: row.goalId, action: 'claim' });
    const leaseId = claimed.claim.leaseId;
    selected = await this.finalCandidates(goal,row);
    pages = selected.pages;
    const current = await this.goalRuntime.status(row.goalId);
    if (this.closed || current.status !== 'active' || current.continuation?.leaseId !== leaseId || !this.matchesFinal(row, pages)) {
      await this.goalRuntime.continuation({ goalId: row.goalId, action: 'release', leaseId }).catch(() => {});
      row.state = 'cancelled'; row.reason = 'pre-send-boundary-changed'; await this.save(); return;
    }
    row.state = 'dispatching'; row.attempts += 1; row.leaseId = leaseId; row.sentAt = this.now();
    row.finalAssistantId = pages[0].latestAssistantMessageId;
    row.deliveryMode = 'hidden-assistant-continuation';
    row.dispatchRuntimeKey = pages[0].runtimeKey || row.sourceRuntimeKey || null;
    row.dispatchPageTargetId = pages[0].pageTargetId || null;
    if(row.causalDisplayProof)row.sourceRuntimeKey=pages[0].runtimeKey||null;
    await this.save(); // durable before any possible transport side effect
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
        prompt: claimed.claim.prompt,
        continuationId: claimed.claim.continuationId,
        leaseId: claimed.claim.leaseId,
        round: claimed.claim.round,
        reportedAt: current.lastRoundReport?.reportedAt || null });
    } catch (error) { sent = { ok: false, definiteFailure: false, error: error.message }; }
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
      await this.save(); return;
    }
    if (sent?.definiteFailure === true && sent.dispatchCommitted === false) {
      await this.goalRuntime.continuation({ goalId: row.goalId, action: 'release', leaseId }).catch(() => {});
      row.state = row.attempts >= 3 ? 'cancelled' : 'waiting';
      row.retryAt = this.now() + 5000; row.reason = sent.state || 'definite-preflight-failure';
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
      records: [...this.records.values()].map(r => ({ goalId: r.goalId, round: r.round, state: r.state,
        reason: r.reason, attempts: r.attempts, redeemed: r.redeemed === true })) };
  }
  async close() {
    this.closed = true; clearInterval(this.timer); this.timer = null;
    await this.polling?.catch(() => {}); await this.persistQueue.catch(() => {});
  }
}

export const goalContinuationSupervisorInternals = { finalPage, pending };
