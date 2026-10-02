import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { GoalRuntime } from './goal-runtime.js';
import { GoalContinuationSupervisor } from './goal-continuation-supervisor.js';
import { ClassicNativeFinalBoundaryStore } from './classic-native-final-ingress.js';
import { ClassicTurnTransportTracker } from './classic-turn-transport-observer.js';
import { installGoalRelayAppBridge } from './goal-relay-app-bridge.js';
import { registerGoalTools } from './goal-tools.js';

const hash = text => createHash('sha256').update(text).digest('hex');
async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'goal-public-message-'));
  let now = Date.parse('2026-10-03T00:00:00Z');
  const runtime = new GoalRuntime({ stateDir: root, now: () => now });
  const boundary = new ClassicNativeFinalBoundaryStore();
  const options = { goalRuntime: runtime, statePath: join(root, 'driver.json'), now: () => now,
    settleMs: 0, nativeFinalIngressOnly: true, publicMessageContinuation: true,
    inspectNativeFinal: (g, row) => boundary.inspect(g, row),
    inspect: async () => { throw new Error('UI inspection forbidden'); },
    dispatch: async () => { throw new Error('Private host sender forbidden'); } };
  let supervisor = new GoalContinuationSupervisor(options);
  const goal = await runtime.start({ conversationId: 'exact-conversation', objective: 'Preserve original complete objective', successCriteria: ['Actually continue'] });
  const scope = { conversationId: goal.conversationId, runtimeKey: 'main-01', port: 9721, pageTargetId: 'exact-page-target' };
  let sequence = 0;
  const final = async (message = null, parent = null) => {
    now += 2000; sequence++;
    const event = { ...scope, source: 'native-assistant-turn-final', ingress: 'native-response-stream',
      status: 'finished_successfully', endTurn: true, publicFinal: true,
      sourceUserMessageId: `source-user-${sequence}`, requestId: `request-${sequence}`,
      assistantMessageId: `assistant-${sequence}`, assistantTextHash: hash(`summary-${sequence}`),
      assistantCreatedAt: new Date(now).toISOString(), observedAtMs: now,
      sourceUserTextHash: message ? hash(message) : null, parentMessageId: parent };
    boundary.noteTurn({ ...event, kind: 'started' }); boundary.noteFinal(event);
    await supervisor.notePublicMessageFinal(event);
    await supervisor.noteNativeFinalSupersession(event);
    const completed = await runtime.autoCompleteAssistantTurn({ goalId: goal.id, nativeCompletion: event });
    if (completed.continued) await supervisor.arm(completed.goal, { resume: true });
    await supervisor.pollOnce(); await supervisor.pollOnce();
    return event;
  };
  t.after(async () => { await supervisor.close(); await runtime.close(); await rm(root, { recursive: true, force: true }); });
  return { root, runtime, goal, boundary, scope, final, get supervisor() { return supervisor; },
    advance(ms) { now += ms; },
    async restart() { await supervisor.close(); supervisor = new GoalContinuationSupervisor(options); await supervisor.ready; } };
}

test('Rescue starting a new native request cannot redeem a round or insert another message before its final', async t => {
  const h = await harness(t);
  const previous = await h.final();
  h.boundary.noteTurn({ ...h.scope, kind: 'started', sourceUserMessageId: 'source-user-2', requestId: 'request-2' });
  assert.equal(h.boundary.noteFinal(previous), false, 'late previous final cannot finish rescued work');
  h.advance(60_000);
  for (let i = 0; i < 3; i++) {
    await h.supervisor.pollOnce();
    assert.equal(await h.supervisor.claimPublicMessage(h.goal.id), null);
    assert.equal((await h.runtime.status(h.goal.id)).round, 1, 'new user envelope is not round completion');
  }
  await h.final('- 繼續', previous.assistantMessageId);
  const claims = await Promise.all([h.supervisor.claimPublicMessage(h.goal.id), h.supervisor.claimPublicMessage(h.goal.id)]);
  assert.equal(claims.filter(Boolean).length, 1, 'only the new native final authorizes one continuation');
  assert.equal((await h.runtime.status(h.goal.id)).round, 2);
});

test('native resumed work invalidates its earlier final without requiring a new user envelope', async t => {
  const h = await harness(t);
  const previous = await h.final();
  h.boundary.noteTurn({ ...previous, kind: 'resumed', requestId: 'rescue-resumed-request' });
  assert.equal(h.boundary.noteFinal(previous), false);
  h.advance(60_000);
  assert.equal(await h.supervisor.claimPublicMessage(h.goal.id), null);
  assert.equal((await h.runtime.status(h.goal.id)).round, 1);
});

test('three public automatic rounds use native finals, not UI, RPC ack, or extra reports', async t => {
  const h = await harness(t);
  assert.equal(await h.supervisor.claimPublicMessage(h.goal.id), null, 'working round never sends');
  let receipt = await h.final();
  for (let i = 1; i <= 3; i++) {
    const jobs = await Promise.all(Array.from({ length: 4 }, () => h.supervisor.claimPublicMessage(h.goal.id)));
    assert.equal(jobs.filter(Boolean).length, 1, 'competing App frames get a single durable claim');
    const job = jobs.find(Boolean);
    assert.equal((await h.runtime.status(h.goal.id)).round, i, 'issuing a prompt is not successful delivery');
    receipt = await h.final(job.prompt, receipt.assistantMessageId);
    assert.equal((await h.runtime.status(h.goal.id)).round, i + 1);
    assert.equal((await h.runtime.status(h.goal.id)).objective, h.goal.objective);
  }
});

test('queued public message survives restart and expired unissued lease; issued message never replays', async t => {
  const h = await harness(t); await h.final();
  await h.restart(); h.advance(3_600_000);
  const job = await h.supervisor.claimPublicMessage(h.goal.id);
  assert.ok(job);
  assert.equal((await h.supervisor.pollOnce()).ok, true, 'unknown public delivery must not consult legacy UI inspection');
  await h.restart(); h.advance(3_600_000);
  assert.equal(await h.supervisor.claimPublicMessage(h.goal.id), null);
  assert.equal(h.supervisor.lastError, null, 'restart reconciliation stays native-only');
  const state = await h.runtime.status(h.goal.id);
  assert.equal(state.status, 'active'); assert.equal(state.round, 1);
  assert.match(await readFile(join(h.root, 'driver.json'), 'utf8'), /public-message-issued-awaiting-native-receipt/);
});

test('pause, new native user, disconnected boundary, and a foreign chat cannot acquire old job', async t => {
  for (const mode of ['pause', 'human', 'disconnect']) {
    const h = await harness(t); const event = await h.final();
    if (mode === 'pause') await h.runtime.control({ goalId: h.goal.id, action: 'pause' });
    if (mode === 'human') h.boundary.noteTurn({ ...event, kind: 'started', sourceUserMessageId: 'human-new-message', requestId: 'human-request' });
    if (mode === 'disconnect') h.boundary.invalidatePage(h.scope);
    assert.equal(await h.supervisor.claimPublicMessage(h.goal.id), null, mode);
  }
  const h = await harness(t); await h.final();
  const tools = new Map();
  registerGoalTools({ registerTool: (name, config, handler) => { tools.set(name, handler); return {}; } }, h.runtime, {
    resourceUri: 'ui://test/goal', relayResourceUri: 'ui://test/relay',
    resolveConversation: async () => ({ conversationId: 'foreign-conversation' }),
    hostBridge: { continuationSupervisor: h.supervisor } });
  assert.equal((await tools.get('devspace_goal_continuation')({ goalId: h.goal.id, action: 'public_message' }, {})).isError, true);
  assert.ok(await h.supervisor.claimPublicMessage(h.goal.id), 'foreign tool call did not consume owner job');
});

test('unrelated native assistant final cannot confirm public delivery', async t => {
  const h = await harness(t); const previous = await h.final();
  const job = await h.supervisor.claimPublicMessage(h.goal.id);
  for (const change of [{ sourceUserTextHash: hash('different') }, { parentMessageId: 'different' },
    { conversationId: 'different' }, { pageTargetId: 'different' }, { runtimeKey: 'main-02' }]) {
    assert.equal(await h.supervisor.notePublicMessageFinal({ ...previous,
      sourceUserMessageId: 'new-public-user', sourceUserTextHash: hash(job.prompt), parentMessageId: previous.assistantMessageId,
      ...change }), false);
  }
  assert.equal((await h.runtime.status(h.goal.id)).round, 1);
});

test('a failed claim journal write is definitely unsent and can recover without restart', async t => {
  const h = await harness(t); await h.final();
  const save = h.supervisor.save.bind(h.supervisor);
  let fail = true;
  h.supervisor.save = async () => {
    if (fail) { fail = false; throw new Error('fixture disk unavailable'); }
    return save();
  };
  await assert.rejects(h.supervisor.claimPublicMessage(h.goal.id), /disk unavailable/);
  assert.ok(await h.supervisor.claimPublicMessage(h.goal.id));
  assert.equal(await h.supervisor.claimPublicMessage(h.goal.id), null);
});

test('native source changed while persisting claim prevents prompt from leaving backend', async t => {
  const h = await harness(t); const event = await h.final();
  const save = h.supervisor.save.bind(h.supervisor);
  h.supervisor.save = async () => {
    await save();
    h.boundary.noteTurn({ ...event, kind: 'started', sourceUserMessageId: 'new-human-during-write', requestId: 'new-human-request' });
  };
  assert.equal(await h.supervisor.claimPublicMessage(h.goal.id), null);
  assert.equal((await h.runtime.status(h.goal.id)).round, 1);
});

test('public continuation tools reject missing owner and return one prompt only to exact owner', async t => {
  const h = await harness(t); await h.final();
  let owner = null; const tools = new Map();
  registerGoalTools({ registerTool: (name, config, handler) => { tools.set(name, handler); return {}; } }, h.runtime, {
    resourceUri: 'ui://test/goal', relayResourceUri: 'ui://test/relay', resolveConversation: async () => owner,
    hostBridge: { continuationSupervisor: h.supervisor } });
  const call = () => tools.get('devspace_goal_continuation')({ goalId: h.goal.id, action: 'public_message' }, {});
  assert.equal((await call()).isError, true);
  owner = { conversationId: h.goal.conversationId };
  const result = await call();
  assert.ok(result.structuredContent.publicMessage);
  assert.equal((await call()).structuredContent.publicMessage, undefined);
});

test('real native final after reboot supersedes old Main ownership without claiming automatic delivery', async t => {
  const h = await harness(t); const old = await h.final();
  const job = await h.supervisor.claimPublicMessage(h.goal.id);
  const event = { ...old, runtimeKey: 'main-02', port: 9732, pageTargetId: 'new-reboot-page',
    sourceUserMessageId: 'human-after-reboot', requestId: 'request-after-reboot',
    assistantMessageId: 'assistant-after-reboot', assistantCreatedAt: new Date(Date.parse(old.assistantCreatedAt) + 10_000).toISOString(),
    observedAtMs: old.observedAtMs + 10_000, sourceUserTextHash: hash('continue original task') };
  assert.equal(await h.supervisor.noteNativeFinalSupersession({ ...event, conversationId: 'other-conversation' }), false);
  h.advance(10_000);
  assert.equal(await h.supervisor.noteNativeFinalSupersession(event), true);
  assert.equal((await h.runtime.status(h.goal.id)).round, 2);
  const row = h.supervisor.records.get(job.continuationId);
  assert.equal(row.deliveryMode, 'human-user-continuation');
  assert.equal(row.reason, 'native-final-proves-external-user-continuation');
  assert.equal(await h.supervisor.claimPublicMessage(h.goal.id), null);
});

test('public bridge uses documented no-scroll API once; refusal/lost reply never selects another sender', async () => {
  for (const outcome of ['accepted', 'denied']) {
    const calls = []; let issued = false;
    const win = { parent: {}, openai: {
      callTool: async () => ({ structuredContent: { publicMessage: issued ? undefined : (issued = true, {
        goalId: 'goal', conversationId: 'chat', leaseId: 'lease', continuationId: 'next', prompt: 'continue' }) } }),
      sendFollowUpMessage: async params => { calls.push(params); if (outcome === 'denied') throw new Error('Host declined'); },
    } };
    const bridge = installGoalRelayAppBridge(win);
    if (outcome === 'denied') await assert.rejects(bridge.dispatchPublicMessage('goal', 'chat'), /declined/);
    else assert.equal(await bridge.dispatchPublicMessage('goal', 'chat'), true);
    assert.equal(await bridge.dispatchPublicMessage('goal', 'chat'), false);
    assert.deepEqual(calls, [{ prompt: 'continue', scrollToBottom: false }]);
    bridge.dispose();
  }
});

test('transport observer correlates public prompt hash and native parent, without exposing prose', () => {
  const finals = [];
  const tracker = new ClassicTurnTransportTracker({ onAssistantFinal: e => finals.push(e) });
  const url = 'https://chatgpt.com/backend-api/f/conversation';
  tracker.noteRequest({ requestId: 'public-request', request: { method: 'POST', url, postData: JSON.stringify({
    conversation_id: 'exact-conversation', model: 'fixture', parent_message_id: 'prior-final-message',
    messages: [{ id: 'public-user-message', author: { role: 'user' }, content: { content_type: 'text', parts: ['fixture continuation'] } }],
  }) } });
  tracker.noteResponse({ requestId: 'public-request', response: { url, status: 200 } });
  tracker.noteResponseData({ requestId: 'public-request', data: `data: ${JSON.stringify({ conversation_id: 'exact-conversation',
    message: { id: 'new-assistant-final', author: { role: 'assistant' }, channel: 'final', recipient: 'all', status: 'finished_successfully',
      end_turn: true, create_time: Date.now() / 1000, content: { content_type: 'text', parts: ['summary'] } } })}\n\n` });
  assert.equal(finals.length, 1);
  assert.equal(finals[0].sourceUserTextHash, hash('fixture continuation'));
  assert.equal(finals[0].parentMessageId, 'prior-final-message');
  assert.ok(!JSON.stringify(finals).includes('fixture continuation'));
});
