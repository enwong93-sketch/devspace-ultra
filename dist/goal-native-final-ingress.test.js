import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClassicTurnTransportTracker, connectClassicTurnTransportPort } from './classic-turn-transport-observer.js';
import { GoalRuntime } from './goal-runtime.js';
import { ClassicGoalRoundCompletionGuard } from './goal-round-completion-guard.js';
import { GoalContinuationSupervisor } from './goal-continuation-supervisor.js';
import { ClassicGoalHostBridge } from './goal-host-bridge.js';
import { ClassicNativeFinalBoundaryStore } from './classic-native-final-ingress.js';

const now = Date.parse('2026-10-02T15:30:00.000Z');
const cid = 'conversation-native-summary';
const userId = 'source-user-native-summary';

for (const failedMethod of ['Network.enable', 'Page.enable']) {
  test(`failed ${failedMethod} initialization closes each observer socket before retry`, async () => {
    const sockets = [];
    class FailedSocket extends EventTarget {
      constructor() { super(); sockets.push(this); this.closeCount = 0; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
      send(raw) {
        const call = JSON.parse(raw);
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
          id: call.id, ...(call.method === failedMethod ? { error: { message: 'fixture initialization denied' } } : { result: {} }),
        }) })));
      }
      close() { this.closeCount++; this.dispatchEvent(new Event('close')); }
    }
    for (let i = 0; i < 3; i++) {
      await assert.rejects(connectClassicTurnTransportPort(9732, {
        WebSocketImpl: FailedSocket,
        fetchImpl: async () => ({ ok: true, json: async () => [{ id: 'native-page-02', type: 'page',
          url: `https://chatgpt.com/c/${cid}`, webSocketDebuggerUrl: 'ws://fixture/native' }] }),
      }), /fixture initialization denied/);
    }
    assert.equal(sockets.length, 3);
    assert.ok(sockets.every(socket => socket.closeCount === 1), 'failed retries cannot leave live observer sockets behind');
  });
}

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

test('native final dispatch reaches the trusted sender without UI completion inspection', async () => {
  const proof = await scopedFinal();
  const store = new ClassicNativeFinalBoundaryStore();
  store.noteTurn({ ...proof, kind: 'started' }); store.noteFinal(proof);
  let forbiddenCalls = 0, sends = 0;
  const forbidden = async () => { forbiddenCalls++; throw new Error('UI/relay inspection is not a native final gate'); };
  const bridge = new ClassicGoalHostBridge({ ports: [9732],
    inspectNativeFinal: (goal, row) => store.inspect(goal, row),
    beforeDispatch: forbidden, inspectVisibleReport: forbidden,
    probeRelayPort: async () => [{ runtimePort: proof.port, pageTargetId: proof.pageTargetId,
      targetId: 'fixture-relay', conversationId: cid, chatMode: true, webSocketDebuggerUrl: 'ws://fixture/relay' }],
    waitForVisibleReport: forbidden,
    sendRaw: async candidate => { sends++; assert.equal(candidate.pageTargetId, proof.pageTargetId); return { ok: true, dispatchCommitted: true }; },
  });
  bridge.waitForHiddenAssistant = async () => ({ ok: true }); // Fixture acknowledgement only.
  const result = await bridge.dispatch({ goalId: 'owned-goal', prompt: 'continue', conversationId: cid,
    runtimePort: proof.port, expectedPageTargetId: proof.pageTargetId, sourceUserId: userId,
    assistantMessageId: proof.assistantMessageId, nativeCompletionProof: proof });
  assert.equal(result.ok, true); assert.equal(sends, 1); assert.equal(forbiddenCalls, 0);
});

test('new native request during pre-send hook prevents dispatch from the old final', async () => {
  const proof = await scopedFinal();
  const store = new ClassicNativeFinalBoundaryStore();
  store.noteTurn({ ...proof, kind: 'started' }); store.noteFinal(proof);
  let sends = 0, hooks = 0;
  const bridge = new ClassicGoalHostBridge({ ports: [9732],
    inspectNativeFinal: (goal, row) => store.inspect(goal, row),
    probeRelayPort: async () => [{ runtimePort: proof.port, pageTargetId: proof.pageTargetId,
      targetId: 'fixture-relay', conversationId: cid, chatMode: true, webSocketDebuggerUrl: 'ws://fixture/relay' }],
    beforeRawDispatch: async () => { hooks++; store.noteTurn({ ...proof, kind: 'started', requestId: 'new-native-request' }); },
    sendRaw: async () => { sends++; return { ok: true }; },
  });
  const result = await bridge.dispatch({ goalId: 'owned-goal', prompt: 'continue', conversationId: cid,
    runtimePort: proof.port, expectedPageTargetId: proof.pageTargetId, sourceUserId: userId,
    assistantMessageId: proof.assistantMessageId, nativeCompletionProof: proof });
  assert.equal(hooks, 1); assert.equal(sends, 0);
  assert.equal(result.dispatchCommitted, false); assert.equal(result.state, 'native-final-preflight-unavailable');
});

test('disconnect invalidates only its exact native page, including completed finals', async () => {
  const proof = await scopedFinal(); const other = { ...proof, pageTargetId: 'another-native-page' };
  const store = new ClassicNativeFinalBoundaryStore();
  for (const event of [proof, other]) { store.noteTurn({ ...event, kind: 'started' }); store.noteFinal(event); }
  store.invalidatePage(proof);
  assert.equal(store.inspect({ conversationId: cid }, { nativeCompletionProof: proof }).pages, null);
  assert.equal(store.inspect({ conversationId: cid }, { nativeCompletionProof: other }).pages.length, 1);
  assert.equal(store.noteFinal(proof), false, 'late response cannot restore disconnected authority');
});

test('late response after observer loss cannot recreate an invalidated native final', () => {
  const finals = []; const tracker = track(event => finals.push(event));
  tracker.invalidateFinals();
  tracker.noteResponseData({ requestId: 'native-request', data: frame() });
  assert.equal(finals.length, 0);
});

test('native dispatch rejects unavailable or mismatched receipts without falling back to a UI report', async () => {
  const proof = await scopedFinal(); let sends = 0, uiReads = 0;
  const altered = [null, { pages: [] }, { pages: [{ nativeFinalReceipt: { ...proof, requestId: 'different-request' } }] },
    { pages: [{ nativeFinalReceipt: { ...proof, pageTargetId: 'another-page' } }] },
    { pages: [{ nativeFinalReceipt: { ...proof, assistantTextHash: '0'.repeat(64) } }] }];
  for (const response of altered) {
    const bridge = new ClassicGoalHostBridge({ inspectNativeFinal: async () => response,
      probeRelayPort: async () => { uiReads++; return []; },
      waitForVisibleReport: async () => { uiReads++; return { ok: true }; },
      sendRaw: async () => { sends++; return { ok: true }; } });
    const result = await bridge.dispatch({ goalId: 'owned-goal', prompt: 'continue', conversationId: cid,
      runtimePort: proof.port, expectedPageTargetId: proof.pageTargetId, sourceUserId: userId,
      assistantMessageId: proof.assistantMessageId, nativeCompletionProof: proof });
    assert.equal(result.state, 'native-final-preflight-unavailable');
    assert.equal(result.dispatchCommitted, false);
  }
  assert.equal(sends, 0); assert.equal(uiReads, 0);
});

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
  const finals = [], calls = [], invalidations = []; let socket;
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
    onNativeBoundaryInvalidated: event => invalidations.push(event),
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
  socket.close();
  assert.equal(invalidations.length, 2, 'new native request and socket loss both invalidate the former completion boundary');
  assert.equal(invalidations[0].pageTargetId, 'native-page-02');
});

for (const outcome of ['complete', 'failure', 'newer-request', 'disconnect', 'navigation', 'body-error', 'invalid-body', 'metadata-overflow']) {
  test(`omitted native request body: ${outcome} preserves source/final ordering`, async t => {
    const finals = [], turns = [], invalidations = [], calls = []; let socket;
    class BodySocket extends EventTarget {
      constructor() { super(); socket = this; setTimeout(() => this.dispatchEvent(new Event('open')), 0); }
      send(raw) {
        const call = JSON.parse(raw); calls.push(call);
        if (!['Network.getRequestPostData', 'Network.streamResourceContent'].includes(call.method)) {
          queueMicrotask(() => this.emit({ id: call.id, result: {} }));
        }
      }
      emit(payload) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) })); }
      close() { this.dispatchEvent(new Event('close')); }
    }
    const session = await connectClassicTurnTransportPort(9732, {
      WebSocketImpl: BodySocket,
      fetchImpl: async () => ({ ok: true, json: async () => [{ id: 'body-page', type: 'page',
        url: `https://chatgpt.com/g/project/c/${cid}`, webSocketDebuggerUrl: 'ws://fixture/native' }] }),
      onActiveTurn: event => turns.push(event), onAssistantFinal: event => finals.push(event),
      onNativeBoundaryInvalidated: event => invalidations.push(event),
    });
    t.after(() => session.close());
    const url = 'https://chatgpt.com/backend-api/f/conversation';
    const body = JSON.stringify({ conversation_id: cid, model: 'test-fixture',
      messages: [{ id: userId, author: { role: 'user' } }] });
    socket.emit({ method: 'Network.requestWillBeSent', params: { requestId: 'omitted-body',
      request: { method: 'POST', url, hasPostData: true } } });
    assert.equal(invalidations.length, 1, 'new unknown source immediately invalidates any older final');
    const getBody = calls.find(call => call.method === 'Network.getRequestPostData');
    assert.ok(getBody, 'recover only the existing observed native request body');
    if (outcome === 'metadata-overflow') {
      for (let i = 0; i < 33; i++) {
        socket.emit({ method: 'Network.requestWillBeSentExtraInfo', params: { requestId: 'omitted-body', headers: {} } });
      }
    }
    socket.emit({ method: 'Network.requestWillBeSentExtraInfo', params: { requestId: 'omitted-body', headers: {} } });
    socket.emit({ method: 'Network.responseReceived', params: { requestId: 'omitted-body', response: { url, status: 200 } } });
    if (outcome === 'failure') {
      socket.emit({ method: 'Network.loadingFailed', params: { requestId: 'omitted-body' } });
    } else {
      socket.emit({ method: 'Network.loadingFinished', params: { requestId: 'omitted-body' } });
    }
    if (outcome === 'newer-request') {
      socket.emit({ method: 'Network.requestWillBeSent', params: { requestId: 'newer-native',
        request: { method: 'POST', url, postData: body.replace(userId, 'newer-source-user') } } });
    }
    if (outcome === 'disconnect') socket.close();
    if (outcome === 'navigation') {
      socket.emit({ method: 'Page.frameNavigated', params: { frame: { url: 'https://chatgpt.com/c/different-native-cid' } } });
    }
    socket.emit(outcome === 'body-error' ? { id: getBody.id, error: { code: -32000, message: 'Body unavailable' } }
      : { id: getBody.id, result: { postData: outcome === 'invalid-body' ? '{}' : body } });
    await new Promise(resolve => setTimeout(resolve, 10));
    const stream = calls.find(call => call.method === 'Network.streamResourceContent');
    if (outcome === 'complete') {
      assert.ok(stream, 'response received before body recovery is not dropped');
      socket.emit({ id: stream.id, result: { bufferedData: Buffer.from(frame()).toString('base64') } });
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(finals.length, 1);
      assert.equal(finals[0].sourceUserMessageId, userId);
      assert.equal(finals[0].requestId, 'omitted-body');
      assert.equal(session.pendingSize, 0);
    } else {
      assert.equal(stream, undefined, 'late body cannot revive a failed, superseded or disconnected request');
      assert.equal(finals.length, 0);
      assert.equal(turns.some(event => event.requestId === 'omitted-body'), false);
    }
    assert.equal(calls.some(call => /Runtime|Debugger|Input|Fetch\./.test(call.method)), false);
  });
}

test('lookalike page URL cannot become native-final ingress authority', async () => {
  const session = await connectClassicTurnTransportPort(9732, {
    fetchImpl: async () => ({ ok: true, json: async () => [{ id: 'wrong-page', type: 'page',
      url: 'https://example.invalid/chatgpt.com/c/conversation-native-summary', webSocketDebuggerUrl: 'ws://fixture/wrong',
    }] }),
    WebSocketImpl: class { constructor() { throw new Error('Must not attach to lookalike page'); } },
  });
  assert.equal(session, null);
});

test('new-chat request binds its first native conversation ID before the public final, without page/DOM inference', () => {
  const turns = [], finals = [];
  const tracker = new ClassicTurnTransportTracker({ now: () => now,
    onActiveTurn: event => turns.push(event), onAssistantFinal: event => finals.push(event),
  });
  tracker.noteRequest({ requestId: 'first-native-request', request: {
    method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation',
    postData: JSON.stringify({ conversation_id: null, model: 'test-fixture',
      messages: [{ id: userId, author: { role: 'user' } }] }),
  } });
  assert.equal(turns.length, 0, 'a provisional request cannot invent a conversation identity');
  tracker.noteResponse({ requestId: 'first-native-request', response: { url: 'https://chatgpt.com/backend-api/f/conversation', status: 200 } });
  tracker.noteResponseData({ requestId: 'first-native-request', data: frame({ channel: 'analysis', end_turn: false, status: 'in_progress' }) });
  assert.equal(finals.length, 0);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].kind, 'started');
  assert.equal(turns[0].conversationId, cid);
  assert.equal(turns[0].sourceUserMessageId, userId);
  tracker.noteResponseData({ requestId: 'first-native-request', data: frame() });
  assert.equal(finals.length, 1);
  assert.equal(finals[0].requestId, 'first-native-request');
  assert.equal(finals[0].conversationId, cid);
  assert.equal(finals[0].sourceUserMessageId, userId);
  assert.equal(JSON.stringify(turns).includes('公開總結'), false);
});

test('new-chat native final can itself supply CID, but wrong response or missing original user cannot', () => {
  for (const [status, sourceUser, expected] of [[200, userId, 1], [429, userId, 0], [200, null, 0]]) {
    const finals = [];
    const tracker = new ClassicTurnTransportTracker({ now: () => now, onAssistantFinal: e => finals.push(e) });
    tracker.noteRequest({ requestId: 'cold-request', request: { method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation',
      postData: JSON.stringify({ model: 'test-fixture', messages: sourceUser ? [{ id: sourceUser, author: { role: 'user' } }] : [] }),
    } });
    tracker.noteResponse({ requestId: 'cold-request', response: { url: 'https://chatgpt.com/backend-api/f/conversation', status } });
    tracker.noteResponseData({ requestId: 'cold-request', data: frame() });
    assert.equal(finals.length, expected);
  }
});

test('a later streamed envelope cannot replace the originally supplied CID', () => {
  const finals = [], tracker = track(event => finals.push(event));
  tracker.noteResponseData({ requestId: 'native-request', data: frame({}, { conversation_id: 'other-native-conversation' }) });
  assert.equal(finals.length, 0);
  tracker.noteResponseData({ requestId: 'native-request', data: frame() });
  assert.equal(finals.length, 1);
  assert.equal(finals[0].conversationId, cid);
});
