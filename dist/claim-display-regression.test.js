import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationStartClaimCdpResolver } from './conversation-start-claim-cdp.js';

const claimId = 'claim_duplicate_display_20260920';
const page = (id, chat) => ({ id, type: 'page', url: `https://chatgpt.com/c/${chat}` });
const frame = (id, parentId) => ({ id, parentId, type: 'iframe', webSocketDebuggerUrl: `ws://${id}` });

test('the identical claim in two displays of ONE conversation has one conversation owner', async () => {
  const targets = { 9721: [page('p1', 'conversation-a'), frame('f1', 'p1')], 9732: [page('p2', 'conversation-a'), frame('f2', 'p2')] };
  const r = new ConversationStartClaimCdpResolver({ ports: [9721,9732], listTargets: async port => targets[port], evaluateTarget: async () => true });
  const proof = await r.find({ claimId, claimType: 'progress' });
  assert.equal(proof?.conversationId, 'conversation-a');
  assert.equal(proof?.matchingDisplays, 2);
});

test('a second conflicting page in a later batch must not be skipped', async () => {
  const targets = [page('p1', 'conversation-a'), page('p2', 'conversation-b'), frame('f1', 'p1'), frame('f2', 'p2')];
  const r = new ConversationStartClaimCdpResolver({ ports: [9721], batchSize: 1, listTargets: async () => targets, evaluateTarget: async () => true });
  assert.equal(await r.find({ claimId }), null);
});

test('lookalike host URLs cannot prove ownership', async () => {
  const r = new ConversationStartClaimCdpResolver({ ports: [9721], listTargets: async () => [{...page('p1', 'conversation-a'), url:'https://notchatgpt.com/c/conversation-a'}, frame('f1', 'p1')], evaluateTarget: async () => true });
  assert.equal(await r.find({ claimId }), null);
});

test('a parent route changing during inspection invalidates the proof', async () => {
  let scans = 0;
  const r = new ConversationStartClaimCdpResolver({ ports: [9721], listTargets: async () => [page('p1', ++scans === 1 ? 'conversation-a' : 'conversation-b'), frame('f1', 'p1')], evaluateTarget: async () => true });
  assert.equal(await r.find({ claimId }), null);
});
