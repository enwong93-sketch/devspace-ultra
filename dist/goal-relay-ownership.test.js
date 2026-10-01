import assert from 'node:assert/strict';
import test from 'node:test';
import { relayOwnershipRejection, probeClassicRelayPort, ClassicGoalHostBridge } from './goal-host-bridge.js';

const proof = { canFollowUp:true, relayStatePresent:true, relayActive:true,
  relayGoalId:'goal-canary', relayConversationId:'conversation-canary', relayHeartbeatAt:100_000 };
test('relay ownership remains exact and reports each rejected evidence layer', () => {
  const check = value => relayOwnershipRejection(value, 'goal-canary', 'conversation-canary', 100_100);
  assert.equal(check(proof), null);
  assert.equal(check({...proof,canFollowUp:false}), 'follow-up-bridge-unavailable');
  assert.equal(check({...proof,relayStatePresent:false}), 'relay-marker-missing');
  assert.equal(check({...proof,relayActive:false}), 'relay-inactive');
  assert.equal(check({...proof,relayGoalId:'another-goal'}), 'relay-goal-mismatch');
  assert.equal(check({...proof,relayConversationId:'another-conversation'}), 'relay-conversation-mismatch');
  assert.equal(check({...proof,relayHeartbeatAt:1}), 'relay-heartbeat-stale');
});
const page = (id, conversationId) => ({type:'page', id,
  url:`https://chatgpt.com/c/${conversationId}`, webSocketDebuggerUrl:`ws://127.0.0.1:9732/${id}`});
test('relay lookup selects the exact page rather than the first unrelated page', async () => {
  const notes=[];
  const result=await probeClassicRelayPort(9732, 'conversation-canary', {
    fetchImpl:async()=>({ok:true,json:async()=>[page('unrelated','other-conversation'),page('exact','conversation-canary')]}),
    onInspection:reason=>notes.push(reason),
  });
  assert.deepEqual(result, []);
  assert.deepEqual(notes, ['no-widget-targets']);
});
test('duplicate exact pages stay ambiguous without probing or selecting a widget', async () => {
  const notes=[];
  await probeClassicRelayPort(9732, 'conversation-canary', {
    fetchImpl:async()=>({ok:true,json:async()=>[page('one','conversation-canary'),page('two','conversation-canary')]}),
    onInspection:reason=>notes.push(reason),
  });
  assert.deepEqual(notes, ['duplicate-exact-pages']);
});
for(const origin of ['https://other.example','http://chatgpt.com','https://chatgpt.com.other.example']) {
  test(`a matching conversation path on ${origin} is not Classic authority`,async()=>{
    const notes=[];
    const wrong={...page('wrong','conversation-canary'),url:`${origin}/c/conversation-canary`};
    await probeClassicRelayPort(9732,'conversation-canary',{
      fetchImpl:async()=>({ok:true,json:async()=>[wrong]}),onInspection:reason=>notes.push(reason),
    });
    assert.deepEqual(notes,['exact-page-unavailable']);
  });
}
test('runtime lookup diagnostics retain only bounded reasons, not routing secrets', async () => {
  const bridge=new ClassicGoalHostBridge({ports:[9732], probeRelayPort:async(_port,_cid,options)=>{
    options.onInspection('relay-marker-missing'); return [];
  }});
  const result=await bridge.findExactConversationRelay('conversation-private', {goalId:'goal-private'});
  assert.equal(result.candidate, null);
  const report=bridge.relayDiagnostics();
  assert.equal(report.reasonCounts['relay-marker-missing'], 1);
  assert.equal(report.goalBound, true);
  assert.doesNotMatch(JSON.stringify(report), /conversation-private|goal-private|9732/);
});
