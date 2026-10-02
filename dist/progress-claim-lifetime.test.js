import test from 'node:test';
import assert from 'node:assert/strict';
import {readGoalRelayHtml} from './goal-relay-resource.js';
import {runInNewContext} from 'node:vm';
const html=readGoalRelayHtml('progress-claim-relay.html');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const now=Date.now();
const claim={claimId:'claim_lifetime_test_20260920',expiresAt:new Date(now+90_000).toISOString(),state:'pending'};
function harness(callTool){
  const timers=[];const cleared=new Set();const listeners=new Map();const removed=[];let hostCloseRequests=0;
  const window={
    addEventListener(name,handler){listeners.set(name,handler);},
    removeEventListener(name,handler){if(listeners.get(name)===handler){listeners.delete(name);removed.push(name);}},
    parent:{},
    openai:{
      toolOutput:{structuredContent:{progressClaim:claim}},
      callTool,
      requestClose:async()=>{hostCloseRequests++;},
    },
  };
  runInNewContext(script,{window,Date,
    setTimeout:(callback,ms)=>{timers.push({callback,ms});return timers.length;},
    clearTimeout:(id)=>{cleared.add(id);},
  });
  return {timers,cleared,listeners,removed,hostCloseRequests:()=>hostCloseRequests};
}
test('a completed receipt remains available until expiry without closing ChatGPT host UI',async()=>{
  const h=harness(async()=>({structuredContent:{ok:true,claimed:true}}));
  await Promise.resolve();await Promise.resolve();
  assert.equal(h.hostCloseRequests(),0,'the hidden relay must never request host UI closure');
  assert.equal(h.listeners.size,2,'the exact-page receipt remains available during its bounded lifetime');
  const expiry=h.timers.find(t=>t.ms>80_000&&t.ms<=90_000);assert.ok(expiry);
  await expiry.callback();
  assert.equal(h.hostCloseRequests(),0,'expiry performs local retirement only');
  assert.deepEqual([...h.removed].sort(),['message','openai:set_globals']);
  assert.equal(h.listeners.size,0);
});

test('an exact Goal start result keeps one persistent relay and requests backend dispatch only when pending',async()=>{
  const timers=[];const cleared=new Set();const listeners=new Map();const calls=[];
  const goal={
    id:'goal_persistent_relay_20260929',
    conversationId:'conversation-persistent-relay',
    status:'active',round:17,roundState:'working',revision:10,
    continuation:{state:'idle',continuationId:null},
  };
  const window={
    addEventListener(name,handler){listeners.set(name,handler);},
    removeEventListener(name,handler){if(listeners.get(name)===handler)listeners.delete(name);},
    parent:{},
    openai:{
      toolOutput:{structuredContent:{goal}},
      sendFollowUpMessage(){throw new Error('the relay must not call sendFollowUpMessage directly');},
      async callTool(name,args){
        calls.push({name,args});
        if(name==='devspace_goal_status')return{structuredContent:{goal:{...goal,roundState:'reported',revision:11,
          continuation:{state:'pending',continuationId:'continuation-persistent-relay'}}}};
        if(name==='devspace_goal_continuation')return{structuredContent:{goal:{...goal,round:18,revision:12,
          continuation:{state:'idle',continuationId:null}}}};
        throw new Error('unexpected tool '+name);
      },
    },
  };
  runInNewContext(script,{window,Date,
    setTimeout:(callback,ms)=>{timers.push({callback,ms});return timers.length;},
    clearTimeout:(id)=>{cleared.add(id);},
  });
  assert.equal(window.__DEVSPACE_GOAL_RELAY_STATE__.active,true);
  assert.equal(window.__DEVSPACE_GOAL_RELAY_STATE__.goalId,goal.id);
  assert.equal(window.__DEVSPACE_GOAL_RELAY_STATE__.conversationId,goal.conversationId);
  assert.equal(listeners.size,0,'claim listeners retire while the persistent Goal relay remains active');
  const firstPoll=timers.find(timer=>timer.ms===250);assert.ok(firstPoll);
  await firstPoll.callback();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls.map(call=>call.name),['devspace_goal_status','devspace_goal_continuation','devspace_goal_continuation']);
  assert.equal(calls[1].args.goalId,goal.id);
  assert.equal(calls[1].args.action,'public_message');
  assert.equal(calls[2].args.action,'dispatch');
  assert.equal(window.__DEVSPACE_GOAL_RELAY_STATE__.lastDispatchContinuationId,'continuation-persistent-relay');
  assert.equal(window.__DEVSPACE_GOAL_RELAY_STATE__.active,true);
});

test('a persistent Goal relay fails closed on conversation mismatch and never dispatches',async()=>{
  const timers=[];const calls=[];
  const goal={id:'goal_conversation_guard',conversationId:'conversation-a',status:'active',round:2,
    roundState:'working',revision:2,continuation:{state:'idle',continuationId:null}};
  const window={
    addEventListener(){},removeEventListener(){},parent:{},
    openai:{toolOutput:{structuredContent:{goal}},sendFollowUpMessage(){},async callTool(name,args){
      calls.push({name,args});
      return{structuredContent:{goal:{...goal,conversationId:'conversation-b',roundState:'reported',
        continuation:{state:'pending',continuationId:'continuation-wrong-conversation'}}}};
    }},
  };
  runInNewContext(script,{window,Date,
    setTimeout:(callback,ms)=>{timers.push({callback,ms});return timers.length;},clearTimeout(){} });
  await timers.find(timer=>timer.ms===250).callback();
  await Promise.resolve();await Promise.resolve();await Promise.resolve();
  assert.deepEqual(calls.map(call=>call.name),['devspace_goal_status']);
  assert.match(window.__DEVSPACE_GOAL_RELAY_STATE__.lastError,/exact Goal status unavailable/);
  assert.equal(window.__DEVSPACE_GOAL_RELAY_STATE__.active,true,
    'a transient mismatch keeps the exact relay fail-closed and available for bounded retry');
});
test('a hung host call cannot prevent bounded local relay retirement',async()=>{
  const h=harness(()=>new Promise(()=>{}));
  const expiry=h.timers.find(t=>t.ms>80_000&&t.ms<=90_000);assert.ok(expiry);
  await expiry.callback();
  assert.equal(h.hostCloseRequests(),0);
  assert.deepEqual([...h.removed].sort(),['message','openai:set_globals']);
  assert.equal(h.listeners.size,0);
});
