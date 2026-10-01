import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GoalRuntime } from './goal-runtime.js';
import { nativeGoalStartWitness, projectNativeGoalSource } from './goal-native-start-witness.js';
import { provesNativeCurrentRoundFinal } from './goal-round-completion-guard.js';
import { inspectVisibleReportCommit } from './goal-host-bridge.js';

const receipt = { source: 'server-created-goal-start', goalId: 'goal_0123456789abcdef',
  receiptId: 'a'.repeat(48), conversationId: 'conversation-native-qa', issuedAt: '2026-09-30T12:04:00.000Z' };
const marker = `[DEVSPACE_NATIVE_GOAL_START:${receipt.goalId}:${receipt.receiptId}]`;
const epoch = Date.parse('2026-09-30T12:00:00.000Z') / 1000;
function payload() {
  return { id: receipt.conversationId, current_node: 'final', mapping: {
    user: { parent: null, message: { id: 'user', author: { role: 'user' }, create_time: epoch } },
    tool: { parent: 'user', message: { id: 'tool', author: { role: 'tool', name: 'devspace_local_gateway.devspace_goal_start' },
      status: 'finished_successfully', create_time: epoch + 241,
      content: { content_type: 'text', parts: [marker] } } },
    final: { parent: 'tool', message: { id: 'final', author: { role: 'assistant' }, channel: 'final',
      end_turn: true, status: 'finished_successfully', create_time: epoch + 300 } },
  } };
}
const goal = { id: receipt.goalId, conversationId: receipt.conversationId,
  round: 1, roundBeganAt: receipt.issuedAt, nativeStartReceipt: receipt };
function snapshot() {
  return { conversationId: receipt.conversationId, pageTargetId: 'exact-page', runtimeKey: 'main-05',
    chatMode: true, generating: false, streamStatus: 'COMPLETE', latestMessageRole: 'assistant',
    latestUserMessageId: 'old-displayed-user', latestAssistantMessageId: 'old-displayed-final',
    latestAssistantText: 'Old display', nativeGoalSourceRequired: true,
    nativeContinuation: { resolved: true, currentNodeId: 'final', currentMessageId: 'final',
      currentRole: 'assistant', currentEndTurn: true, currentStatus: 'finished_successfully',
      currentCreatedAt: new Date((epoch + 300) * 1000).toISOString(),
      latestAssistantMessageId: 'final', latestAssistantEndTurn: true,
      latestAssistantStatus: 'finished_successfully',
      latestAssistantCreatedAt: new Date((epoch + 300) * 1000).toISOString(),
      latestPublicAssistantText: 'Completed public round one.',
      latestUserMessageId: 'user', latestUserCreatedAt: new Date(epoch * 1000).toISOString(),
      goalStartWitness: nativeGoalStartWitness(payload(), receipt, receipt.conversationId) } };
}

test('a fixture start-tool witness correlates a request four minutes before Goal creation', () => {
  const witness = nativeGoalStartWitness(payload(), receipt, receipt.conversationId);
  assert.equal(witness.verified, true);
  assert.equal(witness.sourceUserMessageId, 'user');
  const old = snapshot(), projected = projectNativeGoalSource(old, goal);
  assert.equal(projected.latestUserMessageId, 'user');
  assert.equal(projected.latestAssistantMessageId, 'final');
  assert.equal(projected.displaySourceUserMessageId, 'old-displayed-user');
  assert.equal(old.latestUserMessageId, 'old-displayed-user');
  assert.equal(provesNativeCurrentRoundFinal(goal, projected, { nowMs: (epoch + 301) * 1000 }), true);
});
for (const [label, mutate] of [
  ['wrong native conversation', p => { p.id = 'another-conversation'; }],
  ['conflicting native conversation IDs', p => { p.conversation_id = 'another-conversation'; }],
  ['wrong receipt', p => { p.mapping.tool.message.content.parts = [marker.replace('a'.repeat(48), 'b'.repeat(48))]; }],
  ['assistant echo', p => { p.mapping.tool.message.author.role = 'assistant'; }],
  ['user echo', p => { p.mapping.tool.message.author.role = 'user'; }],
  ['another tool echo', p => { p.mapping.tool.message.author.name = 'shell.exec_command'; }],
  ['failed tool response', p => { p.mapping.tool.message.status = 'failed'; }],
  ['broken branch', p => { p.mapping.tool.parent = 'missing'; }],
  ['cyclic branch', p => { p.mapping.tool.parent = 'final'; }],
  ['new user after receipt issue', p => { p.mapping.user.message.create_time = epoch + 242; }],
  ['missing tool time', p => { delete p.mapping.tool.message.create_time; }],
]) test(`${label} cannot become native Goal source authority`, () => {
  const p = payload(); mutate(p);
  assert.equal(nativeGoalStartWitness(p, receipt, receipt.conversationId).verified, false);
});

test('assistant analysis content is never accessed to find a start receipt', () => {
  const p = payload();
  p.mapping.analysis = { parent: 'tool', message: { id: 'analysis', author: { role: 'assistant' }, channel: 'analysis',
    get content() { throw new Error('private content must not be accessed'); } } };
  p.mapping.final.parent = 'analysis';
  assert.equal(nativeGoalStartWitness(p, receipt, receipt.conversationId).verified, true);
});
test('an api_tool wrapper requires the exact structured start invocation, never an arbitrary echo', () => {
  const p = payload();
  p.mapping.call = { parent: 'user', message: { id: 'call', author: { role: 'assistant' }, recipient: 'api_tool.call_tool',
    content: { content_type: 'text', parts: [JSON.stringify({ path: '/fixture/devspace_goal_start', args: {} })] } } };
  p.mapping.tool.parent = 'call'; p.mapping.tool.message.author.name = 'api_tool';
  assert.equal(nativeGoalStartWitness(p, receipt, receipt.conversationId).verified, true);
  p.mapping.call.message.content.parts = [JSON.stringify({ path: '/fixture/exec_command', args: { echo: marker } })];
  assert.equal(nativeGoalStartWitness(p, receipt, receipt.conversationId).verified, false);
  p.mapping.call.message.content.parts = ['A free-form explanation mentioning /fixture/devspace_goal_start'];
  assert.equal(nativeGoalStartWitness(p, receipt, receipt.conversationId).verified, false);
});
test('the witness extractor stays self-contained when serialized into the existing inspector', () => {
  const extract = new Function(`return (${nativeGoalStartWitness.toString()})`)();
  assert.deepEqual(extract(payload(), receipt, receipt.conversationId), nativeGoalStartWitness(payload(), receipt, receipt.conversationId));
});
test('the existing inspector emits compilable JS and never requests a user gesture', async () => {
  const calls = [];
  class FixtureSocket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(text) {
      const call = JSON.parse(text); calls.push(call);
      if (call.method === 'Runtime.evaluate') new Function(`return ${call.params.expression};`);
      const result = call.method === 'Runtime.evaluate' ? { result: { value: snapshot() } } : {};
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: call.id, result }) })));
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  const s = await inspectVisibleReportCommit({ pageWebSocketDebuggerUrl: 'ws://fixture-only', pageTargetId: 'exact-page' },
    { WebSocketImpl: FixtureSocket, includeNativeBranch: true, nativeGoalStartReceipt: receipt });
  assert.equal(s.latestAssistantMessageId, 'final');
  assert.equal(calls.find(call => call.method === 'Runtime.evaluate').params.userGesture, false);
  assert.deepEqual(calls.map(call => call.method), ['Runtime.enable', 'Runtime.evaluate']);
});
for (const field of ['safetyCheckVisible', 'deliveryTimeoutVisible', 'retryVisible']) {
  test(`native source projection does not override ${field}`, () => {
    const s = { ...snapshot(), [field]: true };
    assert.equal(projectNativeGoalSource(s, goal), s);
  });
}
test('wrong current source and wrong durable receipt cannot override a stale display', () => {
  const s = snapshot(); s.nativeContinuation.latestUserMessageId = 'later-user';
  assert.equal(projectNativeGoalSource(s, goal), s);
  const other = { ...goal, nativeStartReceipt: { ...receipt, receiptId: 'b'.repeat(48) } };
  const s2 = snapshot(); assert.equal(projectNativeGoalSource(s2, other), s2);
});
test('missing final/public text, a running node and an old final stay ineligible', () => {
  for (const change of [{ currentEndTurn: false }, { currentStatus: 'IN_PROGRESS' }, { latestPublicAssistantText: null }]) {
    const s = snapshot(); Object.assign(s.nativeContinuation, change);
    assert.equal(projectNativeGoalSource(s, goal).generating, true);
  }
  const s = snapshot();
  s.nativeContinuation.currentCreatedAt = s.nativeContinuation.latestAssistantCreatedAt = new Date((epoch - 1) * 1000).toISOString();
  assert.equal(provesNativeCurrentRoundFinal(goal, projectNativeGoalSource(s, goal), { nowMs: (epoch + 301) * 1000 }), false);
});
test('missing or forged start evidence does not simply relax the initial 30-second guard', () => {
  const s = projectNativeGoalSource(snapshot(), goal);
  s.nativeContinuation.goalStartWitness = { verified: true };
  assert.equal(provesNativeCurrentRoundFinal(goal, s, { nowMs: (epoch + 301) * 1000 }), false);
});
test('server receipts survive restart; corruption discards evidence without discarding Goals', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devspace-start-witness-test-'));
  try {
    const runtime = new GoalRuntime({ stateDir: dir });
    const g = await runtime.start({ objective: 'Anonymous fixture', successCriteria: ['Fixture only'], conversationId: receipt.conversationId });
    const minted = await runtime.nativeStartReceipt(g.id);
    assert.match(minted.receiptId, /^[a-f0-9]{48}$/);
    assert.equal(Object.hasOwn(await runtime.status(g.id), 'nativeStartReceipt'), false);
    const resumed = new GoalRuntime({ stateDir: dir });
    assert.deepEqual(await resumed.nativeStartReceipt(g.id), minted);
    const statePath = join(dir, 'goal-state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.nativeStartReceipts[g.id].conversationId = 'wrong-owner';
    await writeFile(statePath, JSON.stringify(state));
    const invalid = new GoalRuntime({ stateDir: dir });
    assert.equal((await invalid.status(g.id)).id, g.id);
    assert.equal(await invalid.nativeStartReceipt(g.id), null);
    await invalid.rebindConversation({ goalId: g.id, oldConversationId: receipt.conversationId, newConversationId: 'new-native-conversation' });
    assert.equal((await new GoalRuntime({ stateDir: dir }).status(g.id)).conversationId, 'new-native-conversation');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('a start retry flushes an earlier failed save before returning its receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devspace-start-save-retry-test-'));
  try {
    const runtime = new GoalRuntime({ stateDir: dir }); await runtime.ready;
    const save = runtime.save.bind(runtime);
    runtime.save = async () => { throw new Error('injected first start save failure'); };
    const input = { objective: 'Anonymous retry fixture', successCriteria: ['Persist before receipt'], conversationId: receipt.conversationId };
    await assert.rejects(runtime.start(input), /injected first start save failure/);
    runtime.save = save;
    const resumed = await runtime.startOrResume(input);
    assert.equal(resumed.resumed, true);
    assert.deepEqual(await new GoalRuntime({ stateDir: dir }).nativeStartReceipt(resumed.goal.id),
      await runtime.nativeStartReceipt(resumed.goal.id));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
