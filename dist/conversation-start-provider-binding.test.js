import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConversationStartClaimRegistry } from './conversation-start-claim-registry.js';
import { OpenaiConversationBindings, verifiedLocalProviderBinding } from './openai-conversation-binding.js';
import { completeConversationStart } from './conversation-start-completion.js';

function setup(toolName = 'devspace_goal_start', inspect = async (runtimeKey, conversationId) => ({ runtimeKey, conversationId, pageVerified: true })) {
  const registry = new ConversationStartClaimRegistry();
  const identity = { version: 1, key: 'a'.repeat(64) };
  const bindings = new OpenaiConversationBindings({ inspect, serverInstanceId: 'server-instance-qa' });
  const claim = registry.create({ toolName, input: { objective: 'Disposable QA objective', successCriteria: ['marker'], title: 'Disposable QA plan', steps: [{ text: 'marker', status: 'in_progress' }] }, providerIdentity: identity });
  const authority = { conversationId: 'conversation-real-client-qa', runtimeKey: 'main-05', claimId: claim.claimId, source: 'classic-exact-page-start-claim-cdp-page-verified', observedAt: new Date().toISOString(), pageVerified: true };
  let created = 0;
  const runtime = { startOrResume: async ({ conversationId }) => { created++; return { goal: { id: 'goal-qa', conversationId }, plan: { id: 'plan-qa', conversationId }, resumed: false }; } };
  const complete = args => completeConversationStart({ ...args, openaiBindings: bindings, goalRuntime: runtime, planRuntime: runtime });
  const redeem = proof => registry.claim({ claimId: claim.claimId, toolName, authority: proof, complete });
  return { registry, identity, bindings, claim, authority, redeem, created: () => created };
}

for (const toolName of ['devspace_goal_start', 'devspace_plan_start']) {
  test(`${toolName}: preserve verified receipt through registry into the real provider binder`, async () => {
    const qa = setup(toolName);
    const result = await qa.redeem(qa.authority);
    assert.equal((result.goal || result.plan).conversationId, qa.authority.conversationId);
    assert.ok(verifiedLocalProviderBinding(await qa.bindings.resolve(qa.identity), qa.identity));
    assert.equal(qa.created(), 1);
    assert.deepEqual(await qa.redeem(qa.authority), result);
    assert.equal(qa.created(), 1, 'duplicate receipt must not start another objective');
  });
}
test('unverified page cannot be promoted into verified authority', async () => {
  const qa = setup();
  await assert.rejects(qa.redeem({ ...qa.authority, pageVerified: false }), /exact page-verified/);
  assert.equal(qa.created(), 0);
});
test('authenticated current invocation keeps its validated proof across normalization', async () => {
  const qa = setup();
  const proof = { ...qa.authority, claimId: undefined,
    source: 'classic-native-current-invocation-page-verified',
    callFingerprint: 'b'.repeat(64), currentInvocationVerified: true };
  assert.ok((await qa.redeem(proof)).goal);
  assert.equal(qa.created(), 1);
});
test('generic page authority without verified invocation cannot bind an identity', async () => {
  const qa = setup();
  const proof = { ...qa.authority, claimId: undefined,
    source: 'classic-native-current-invocation-page-verified',
    callFingerprint: 'b'.repeat(64), currentInvocationVerified: false };
  await assert.rejects(qa.redeem(proof), /could not be attached/);
  assert.equal(qa.created(), 0);
});
test('wrong claim receipt is rejected before any provider or Goal mutation', async () => {
  const qa = setup();
  await assert.rejects(qa.redeem({ ...qa.authority, claimId: 'different_claim_receipt_20261002' }), /exact page-verified/);
  assert.equal(qa.created(), 0);
  assert.equal(qa.bindings.status().bindings, 0);
});
test('stale live page prevents orphan active Goal creation', async () => {
  const qa = setup('devspace_goal_start', async () => null);
  await assert.rejects(qa.redeem(qa.authority), /could not be attached/);
  assert.equal(qa.created(), 0);
});
test('page lost between binding and reuse verification leaves no orphan Goal', async () => {
  let inspections = 0;
  const qa = setup('devspace_goal_start', async (runtimeKey, conversationId) =>
    ++inspections === 1 ? { runtimeKey, conversationId, pageVerified: true } : null);
  await assert.rejects(qa.redeem(qa.authority), /did not survive live page verification/);
  assert.equal(qa.created(), 0);
});
test('provider bound to another conversation is not silently transferred', async () => {
  const qa = setup();
  await qa.bindings.bind(qa.identity, { ...qa.authority, conversationId: 'conversation-another-qa' }, { conversationStartClaimId: qa.claim.claimId });
  await assert.rejects(qa.redeem(qa.authority), /could not be attached/);
  assert.equal(qa.created(), 0);
  assert.equal(qa.bindings.status().conflicted, 1);
});
