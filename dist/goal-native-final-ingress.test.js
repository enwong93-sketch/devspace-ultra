import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClassicTurnTransportTracker, connectClassicTurnTransportPort } from './classic-turn-transport-observer.js';
import { GoalRuntime } from './goal-runtime.js';
import { ClassicGoalRoundCompletionGuard } from './goal-round-completion-guard.js';
import { GoalContinuationSupervisor } from './goal-continuation-supervisor.js';

const now = Date.parse('2026-10-02T15:30:00.000Z');
const cid = 'conversation-native-summary';
const userId = 'source-user-native-summary';
function frame(overrides = {}, envelope = {}) {
  return `data: ${JSON.stringify({ conversation_id: cid, message: {
    id: 'assistant-native-summary', author: { role: 'assistant' },
    channel: 'final', recipient: 'all', status: 'finished_successfully',
    end_turn: true, create_time: now / 1000,
    content: { content_type: 'text', parts: ['公開總結：目標尚未完成。'] },
    ...overrides,
  }, ...envelope })}\n\n`;
}
function track(callback) {
  const tracker = new ClassicTurnTransportTracker({ now: () => now, onAssistantFinal: callback });
  tracker.noteRequest({ requestId: 'native-request', request: {
    method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation',
    postData: JSON.stringify({ conversation_id: cid, model: 'test-fixture',
      messages: [{ id: userId, author: { role: 'user' } }] }),
  } });
  tracker.noteResponse({ requestId: 'native-request', response: {
    url: 'https://chatgpt.com/backend-api/f/conversation', status: 200,
  } });
  return tracker;
}

test('native completed public summary emits once, without DOM or summary disclosure', () => {
  const finals = []; const tracker = track(event => finals.push(event));
  const payload = Buffer.from(frame()); const cut = payload.indexOf(Buffer.from('總')) + 1;
  tracker.noteResponseData({ requestId: 'native-request', data: payload.subarray(0, cut).toString('base64'), base64Encoded: true });
  assert.equal(finals.length, 0);
  tracker.noteResponseData({ requestId: 'native-request', data: payload.subarray(cut).toString('base64'), base64Encoded: true });
  tracker.noteResponseData({ requestId: 'native-request', data: frame() });
  tracker.noteFinished({ requestId: 'native-request' });
  assert.equal(finals.length, 1);
  assert.equal(finals[0].source, 'native-assistant-turn-final');
  assert.equal(finals[0].ingress, 'native-response-stream');
  assert.equal(finals[0].conversationId, cid);
  assert.equal(finals[0].sourceUserMessageId, userId);
  assert.match(finals[0].assistantTextHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(finals).includes('公開總結'), false);
});

for (const [name, overrides, envelope] of [
  ['analysis', { channel: 'analysis' }],
  ['nested analysis channel', { channel: null, metadata: { channel: 'analysis' } }],
  ['commentary', { channel: 'commentary' }],
  ['tool recipient', { recipient: 'api_tool.call_tool' }],
  ['unfinished summary', { end_turn: false }],
  ['failed turn', { status: 'finished_error' }],
  ['missing native status', { status: null }],
  ['hidden content', { metadata: { is_visually_hidden_from_conversation: true } }],
  ['empty public text', { content: { content_type: 'text', parts: ['  '] } }],
  ['wrong conversation', {}, { conversation_id: 'different-conversation' }],
  ['invalid timestamp', { create_time: null }],
]) test(`${name} cannot become a completed-turn input`, () => {
  const finals = []; const tracker = track(event => finals.push(event));
  tracker.noteResponseData({ requestId: 'native-request', data: frame(overrides, envelope) });
  tracker.noteFinished({ requestId: 'native-request' });
  assert.equal(finals.length, 0);
});

test('transport EOF, [DONE], and failure alone cannot imply assistant completion', () => {
  const finals = []; const tracker = track(event => finals.push(event));
  tracker.noteResponseData({ requestId: 'native-request', data: 'data: [DONE]\n\n' });
  tracker.noteFinished({ requestId: 'native-request' });
  tracker.noteFailure({ requestId: 'native-request', canceled: true });
  assert.equal(finals.length, 0);
});

test('non-success native response and unrelated request cannot admit a final', () => {
  const finals = []; const tracker = track(event => finals.push(event));
  tracker.noteResponse({ requestId: 'native-request', response: { url: 'https://chatgpt.com/backend-api/f/conversation', status: 429 } });
  tracker.noteResponseData({ requestId: 'native-request', data: frame() });
  tracker.noteResponseData({ requestId: 'unrelated-request', data: frame() });
  assert.equal(finals.length, 0);
});

test('a quoted final envelope inside analysis is not a native completion event', () => {
  const finals = []; const tracker = track(event => finals.push(event));
  tracker.noteResponseData({ requestId: 'native-request', data: frame({ channel: 'analysis',
    content: { content_type: 'text', parts: [frame()] },
  }) });
  assert.equal(finals.length, 0);
});

test('production event-only guard never consults UI completion or dispatches UI recovery', async () => {
  let inspections = 0, dispatches = 0;
  const guard = new ClassicGoalRoundCompletionGuard({ nativeFinalIngressOnly: true,
    goalRuntime: { recoverableWorkingRounds: async () => [{ id: 'goal', status: 'active', roundState: 'working' }] },
    inspect: async () => { inspections++; return { generating: false, streamStatus: 'COMPLETE' }; },
    dispatch: async () => { dispatches++; return { ok: true }; },
  });
  const result = await guard.pollOnce();
  assert.equal(inspections, 0);
  assert.equal(dispatches, 0);
  assert.equal(result.recovered, 0);
});

test('native receipt closes round and arms same Goal without UI, report, or synthetic user', async t => {
  const { ClassicNativeFinalBoundaryStore } = await import('./classic-native-final-ingress.js');
  const root = await mkdtemp(join(tmpdir(), 'goal-native-final-'));
  const runtime = new GoalRuntime({ stateDir: root, now: () => now });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const goal = await runtime.start({ conversationId: cid, objective: 'Finish native ingress', successCriteria: ['Real acceptance'] });
  const boundary = new ClassicNativeFinalBoundaryStore();
  let clock = now, sends = 0;
  const supervisor = new GoalContinuationSupervisor({ goalRuntime: runtime,
    now: () => clock, settleMs: 0, nativeFinalIngressOnly: true, inspectNativeFinal: (g, row) => boundary.inspect(g, row),
    inspect: async () => { throw new Error('UI inspection is forbidden for native-final ingress'); },
    dispatch: async () => { sends++; return { ok: false, definiteFailure: true, dispatchCommitted: false, state: 'supported-sender-unavailable' }; },
  });
  t.after(() => supervisor.close());
  const guard = new ClassicGoalRoundCompletionGuard({ goalRuntime: runtime, nativeFinalIngressOnly: true,
    inspect: async () => { throw new Error('UI inspection forbidden'); }, dispatch: async () => { throw new Error('UI recovery forbidden'); },
    continueIncompleteGoal: async ({ goal, nativeCompletion }) => {
      const result = await runtime.autoCompleteAssistantTurn({ goalId: goal.id, nativeCompletion });
      if (result.continued) await supervisor.arm(result.goal, { resume: true });
      return result;
    },
  });
  const scope = { runtimeKey: 'main-02', port: 9732, pageTargetId: 'native-page-02' };
  boundary.noteTurn({ ...scope, kind: 'started', requestId: 'native-request', conversationId: cid, sourceUserMessageId: userId });
  let event;
  track(e => { event = { ...scope, ...e }; }).noteResponseData({ requestId: 'native-request', data: frame() });
  assert.equal(boundary.noteFinal(event), true);
  assert.equal((await guard.noteNativeAssistantFinal(event)).continued, true);
  const state = await runtime.status(goal.id);
  assert.equal(state.status, 'active'); assert.equal(state.round, 1);
  assert.equal(state.roundState, 'reported'); assert.equal(state.lastRoundReport, null);
  assert.equal(state.lastTurnCompletion.ingress, 'native-response-stream');
  assert.equal(supervisor.records.get(state.continuation.continuationId).state, 'waiting');
  await supervisor.pollOnce(); clock++;
  await supervisor.pollOnce();
  assert.equal(sends, 1, 'fixture exercises supported-dispatch boundary, not real host submission');
  assert.equal((await runtime.status(goal.id)).status, 'active', 'transport unavailability never decides semantic completion');
  assert.equal((await guard.noteNativeAssistantFinal(event)).continued, false, 'durable native final ledger rejects replay');
  boundary.noteTurn({ ...scope, kind: 'started', requestId: 'new-request', conversationId: cid, sourceUserMessageId: 'next-human-source-user' });
  assert.equal(boundary.inspect(state, supervisor.records.get(state.continuation.continuationId)).newUser, true);
});

async function scopedFinal() {
  let event;
  track(e => { event = { runtimeKey: 'main-02', port: 9732, pageTargetId: 'native-page-02', ...e }; })
    .noteResponseData({ requestId: 'native-request', data: frame() });
  return event;
}

test('optional report cannot trigger UI final guessing, and native completion preserves its exact pending ID', async t => {
  const root = await mkdtemp(join(tmpdir(), 'goal-native-reported-'));
  const runtime = new GoalRuntime({ stateDir: root, now: () => now });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const goal = await runtime.start({ conversationId: cid, objective: 'Finish actual work', successCriteria: ['Actual result'] });
  const reported = await runtime.turnReport({ goalId: goal.id, summary: 'Intermediate report', meaningfulProgress: true });
  let inspections = 0;
  const supervisor = new GoalContinuationSupervisor({ goalRuntime: runtime, nativeFinalIngressOnly: true,
    inspect: async () => { inspections++; return [{ generating: false, streamStatus: 'COMPLETE' }]; },
    dispatch: async () => { throw new Error('No physical final input'); },
  });
  t.after(() => supervisor.close());
  assert.equal((await supervisor.arm(reported)).reason, 'awaiting-native-final-ingress');
  await supervisor.pollOnce(); assert.equal(inspections, 0);
  const claimed = await runtime.continuation({ goalId: goal.id, action: 'claim' });
  const before = await runtime.status(goal.id);
  const completed = await runtime.autoCompleteAssistantTurn({ goalId: goal.id, nativeCompletion: await scopedFinal() });
  assert.equal(completed.continued, true);
  assert.deepEqual(completed.goal.continuation, before.continuation, 'unknown existing attempt must not be reset/reissued');
  assert.equal(completed.goal.continuation.leaseId, claimed.claim.leaseId);
  assert.equal(completed.goal.continuation.continuationId, reported.continuation.continuationId);
  assert.equal(completed.goal.status, 'active');
});

test('durable final receipt rejects replay after restart and stale/native wrong-owner input', async t => {
  const root = await mkdtemp(join(tmpdir(), 'goal-native-reopen-'));
  const runtime = new GoalRuntime({ stateDir: root, now: () => now });
  let reopened;
  t.after(async () => { await reopened?.close(); await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const goal = await runtime.start({ conversationId: cid, objective: 'Native receipt persistence', successCriteria: ['No duplicate final'] });
  const event = await scopedFinal();
  await assert.rejects(runtime.autoCompleteAssistantTurn({ goalId: goal.id, nativeCompletion: { ...event, port: 9731 } }), /scoped/);
  await assert.rejects(runtime.autoCompleteAssistantTurn({ goalId: goal.id, nativeCompletion: { ...event, assistantCreatedAt: new Date(now - 60_000).toISOString() } }), /exact native/);
  await runtime.autoCompleteAssistantTurn({ goalId: goal.id, nativeCompletion: event });
  await runtime.close();
  reopened = new GoalRuntime({ stateDir: root, now: () => now });
  assert.equal((await reopened.status(goal.id)).lastTurnCompletion.ingress, 'native-response-stream');
  assert.equal((await reopened.autoCompleteAssistantTurn({ goalId: goal.id, nativeCompletion: event })).reason, 'native-final-already-consumed');
  const { ClassicNativeFinalBoundaryStore } = await import('./classic-native-final-ingress.js');
  const emptyLiveStore = new ClassicNativeFinalBoundaryStore();
  assert.equal(emptyLiveStore.inspect(await reopened.status(goal.id), {}).pages, null, 'durable history alone cannot prove the current branch');
});

test('AI/user paused Goal is not resumed merely because a physical final arrived', async t => {
  const root = await mkdtemp(join(tmpdir(), 'goal-native-paused-'));
  const runtime = new GoalRuntime({ stateDir: root, now: () => now });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const goal = await runtime.start({ conversationId: cid, objective: 'Respect semantic state', successCriteria: ['Respect pause'] });
  await runtime.control({ goalId: goal.id, action: 'pause' });
  assert.equal((await runtime.autoCompleteAssistantTurn({ goalId: goal.id, nativeCompletion: await scopedFinal() })).continued, false);
  assert.equal((await runtime.status(goal.id)).status, 'paused');
});

test('production wires passive native-final input and event-only completion gates', async () => {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  assert.equal((source.match(/nativeFinalIngressOnly: true/g) || []).length, 2);
  assert.match(source, /onAssistantFinal: async \(event\)/);
  assert.match(source, /goalRoundCompletionGuard\.noteNativeAssistantFinal\(event\)/);
  assert.match(source, /nativeFinalBoundaries\.noteTurn\(event\)/);
  assert.match(source, /inspectNativeFinal: \(goal, row\) => nativeFinalBoundaries\.inspect\(goal, row\)/);
});

for (const split of [false, true]) test(`delayed native buffered response ${split ? 'prefix' : 'body'} is consumed before transport EOF`, async t => {
  const finals = [], calls = []; let socket;
  class FakeSocket extends EventTarget {
    constructor() { super(); socket = this; setTimeout(() => this.dispatchEvent(new Event('open')), 0); }
    send(raw) {
      const call = JSON.parse(raw); calls.push(call.method);
      if (call.method === 'Network.streamResourceContent') this.streamCall = call;
      else queueMicrotask(() => this.emit({ id: call.id, result: {} }));
    }
    emit(payload) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) })); }
    close() { this.dispatchEvent(new Event('close')); }
  }
  const session = await connectClassicTurnTransportPort(9732, {
    WebSocketImpl: FakeSocket,
    fetchImpl: async url => { assert.equal(url, 'http://127.0.0.1:9732/json/list'); return {
      ok: true, json: async () => [{ id: 'native-page-02', type: 'page', url: `https://chatgpt.com/c/${cid}`, webSocketDebuggerUrl: 'ws://fixture/native' }],
    }; },
    onAssistantFinal: event => finals.push(event),
  });
  t.after(() => session.close());
  socket.emit({ method: 'Network.requestWillBeSent', params: { requestId: 'native-request', request: {
    method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation',
    postData: JSON.stringify({ conversation_id: cid, model: 'test-fixture', messages: [{ id: userId, author: { role: 'user' } }] }),
  } } });
  socket.emit({ method: 'Network.responseReceived', params: { requestId: 'native-request', response: { url: 'https://chatgpt.com/backend-api/f/conversation', status: 200 } } });
  const body = Buffer.from(frame()); const cut = split ? 40 : body.length;
  if (split) socket.emit({ method: 'Network.dataReceived', params: { requestId: 'native-request', data: body.subarray(cut).toString('base64') } });
  socket.emit({ method: 'Network.loadingFinished', params: { requestId: 'native-request' } });
  assert.equal(finals.length, 0);
  socket.emit({ id: socket.streamCall.id, result: { bufferedData: body.subarray(0, cut).toString('base64') } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(finals.length, 1);
  assert.equal(finals[0].runtimeKey, 'main-02');
  assert.equal(finals[0].pageTargetId, 'native-page-02');
  assert.equal(session.pendingSize, 0);
  assert.equal(calls.some(method => /Runtime|Debugger|Input/.test(method)), false, 'native transport observation performs no UI execution');
});

test('lookalike page URL cannot become native-final ingress authority', async () => {
  const session = await connectClassicTurnTransportPort(9732, {
    fetchImpl: async () => ({ ok: true, json: async () => [{ id: 'wrong-page', type: 'page',
      url: 'https://example.invalid/chatgpt.com/c/conversation-native-summary', webSocketDebuggerUrl: 'ws://fixture/wrong',
    }] }),
    WebSocketImpl: class { constructor() { throw new Error('Must not attach to lookalike page'); } },
  });
  assert.equal(session, null);
});
