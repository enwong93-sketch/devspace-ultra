import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { readGoalRelayHtml } from './goal-relay-resource.js';
import { ConversationProgressLivenessCdpAdapter } from './conversation-progress-liveness-cdp.js';
import { readComposerDraft } from './classic-composer-draft.js';

const relayHtml=readGoalRelayHtml('goal-continuation-relay.html');
const relayScript=relayHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(relayScript,'Goal continuation relay script missing');

function relayHarness({initialGoal,statusGoals=[]}={}){
  const timers=[];const cleared=new Set();const listeners=new Map();const calls=[];let sends=0;let statusIndex=0;let released=0;
  const document={
    title:'',documentElement:{dataset:{}},body:{replaceChildren(){released+=1;}},
  };
  const window={
    parent:{},
    addEventListener(name,handler){listeners.set(name,handler);},
    removeEventListener(name,handler){if(listeners.get(name)===handler)listeners.delete(name);},
    openai:{
      toolOutput:{structuredContent:{goal:initialGoal}},
      sendFollowUpMessage(){sends+=1;throw new Error('relay must not invoke sendFollowUpMessage directly');},
      async callTool(name,args){
        calls.push({name,args});
        if(name==='devspace_goal_status'){
          const goal=statusGoals[Math.min(statusIndex,statusGoals.length-1)]||initialGoal;statusIndex+=1;
          return{structuredContent:{goal}};
        }
        if(name==='devspace_goal_continuation'){
          const goal=statusGoals[Math.min(statusIndex,statusGoals.length-1)]||initialGoal;
          return{structuredContent:{goal}};
        }
        throw new Error('unexpected tool '+name);
      },
    },
  };
  runInNewContext(relayScript,{window,document,Date,
    setTimeout:(callback,ms)=>{timers.push({callback,ms});return timers.length;},
    clearTimeout:(id)=>{cleared.add(id);},
  });
  return{window,document,timers,cleared,listeners,calls,sends:()=>sends,released:()=>released};
}

const conversationId='conversation-transport-test';
const target={id:'page-canary',type:'page',url:`https://chatgpt.com/c/${conversationId}`,webSocketDebuggerUrl:'ws://fake-test-page'};
const input={conversationId,sourceUserId:'user-1',assistantMessageId:'assistant-1',target:{exact:true,conversationId,runtimeKey:'main-06',port:9736,target:{runtimeKey:'main-06',port:9736,targetId:target.id,url:target.url,webSocketDebuggerUrl:target.webSocketDebuggerUrl}}};
function make() {
  const calls=[]; const expressions=[];
  const adapter=new ConversationProgressLivenessCdpAdapter({runtimeKeys:['main-06'],listTargets:async()=>[target],sleep:async()=>{},
    connect:async()=>({evaluate:async expression=>{
      expressions.push(expression); return {ok:true,state:'visible'};
    },call:async(method,args)=>{calls.push({method,args});return{};},close(){} }),
  });
  return {adapter,calls,expressions};
}
test('visible-composer Goal continuation transport is permanently retired',async()=>{
  const h=make(); const result=await h.adapter.sendGoalContinuation(input);
  assert.deepEqual(result,{
    ok:false,
    definiteFailure:true,
    dispatchCommitted:false,
    visibilityVerified:false,
    state:'visible-goal-continuation-transport-retired',
  });
  assert.equal(h.calls.length,0);
  assert.equal(h.expressions.length,0);
});
test('legacy callers cannot revive visible Goal continuation even with malformed boundary',async()=>{
  const h=make();const result=await h.adapter.sendGoalContinuation({...input,sourceUserId:null});
  assert.equal(result.state,'visible-goal-continuation-transport-retired');
  assert.equal(result.dispatchCommitted,false);assert.equal(h.calls.length,0);assert.equal(h.expressions.length,0);
});
test('plain typed text and non-text attachments are not mistaken for empty composer',()=>{
  assert.equal(readComposerDraft({tagName:'TEXTAREA',value:' user draft '}),'user draft');
  const cloned={textContent:'',querySelectorAll:()=>[],querySelector:()=>({type:'attachment'})};
  assert.equal(readComposerDraft({tagName:'DIV',cloneNode:()=>cloned}),null);
});
test('only recognized app mention nodes may be ignored and live editor is untouched',()=>{
  let liveMutated=false;
  const cloned={textContent:'DevSpace Local Gateway ',querySelectorAll:selector=>{
    assert.match(selector,/data-symbol="ecosystemMention"/);
    return[{remove:()=>{cloned.textContent='';}}];
  },querySelector:()=>null};
  const editor={tagName:'DIV',cloneNode:()=>cloned,remove:()=>{liveMutated=true;}};
  assert.equal(readComposerDraft(editor),'');assert.equal(liveMutated,false);
});

test('Goal report App remains a persistent exact relay and delegates pending dispatch to backend',async()=>{
  const initialGoal={id:'goal_persistent_transport',conversationId:'conversation-persistent-transport',status:'active',round:17,roundState:'reported',revision:17,
    continuation:{state:'pending',continuationId:'continuation-persistent-transport'}};
  const h=relayHarness({initialGoal,statusGoals:[initialGoal,{...initialGoal,round:18,roundState:'working',revision:18,continuation:{state:'idle',continuationId:null}}]});
  assert.equal(h.window.__DEVSPACE_GOAL_RELAY_STATE__.active,true);
  assert.equal(h.window.__DEVSPACE_GOAL_RELAY_STATE__.goalId,initialGoal.id);
  assert.equal(h.window.__DEVSPACE_GOAL_RELAY_STATE__.conversationId,initialGoal.conversationId);
  assert.equal(h.listeners.size,0,'hydration listeners retire after the exact Goal is adopted');
  const firstPoll=h.timers.find(timer=>timer.ms===250);assert.ok(firstPoll);
  await firstPoll.callback();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(h.calls.map(call=>call.name),['devspace_goal_status','devspace_goal_continuation','devspace_goal_continuation']);
  assert.equal(h.calls[1].args.goalId,initialGoal.id);
  assert.equal(h.calls[1].args.action,'public_message');
  assert.equal(h.calls[2].args.action,'dispatch');
  assert.equal(h.window.__DEVSPACE_GOAL_RELAY_STATE__.lastDispatchContinuationId,initialGoal.continuation.continuationId);
  assert.equal(h.window.__DEVSPACE_GOAL_RELAY_STATE__.active,true);
  assert.equal(h.sends(),0);
  assert.equal(h.released(),0);
});

test('persistent Goal relay fails closed on exact conversation mismatch',async()=>{
  const initialGoal={id:'goal_persistent_guard',conversationId:'conversation-a',status:'active',round:5,roundState:'working',revision:5,
    continuation:{state:'idle',continuationId:null}};
  const h=relayHarness({initialGoal,statusGoals:[{...initialGoal,conversationId:'conversation-b',roundState:'reported',continuation:{state:'pending',continuationId:'continuation-wrong'}}]});
  const firstPoll=h.timers.find(timer=>timer.ms===250);assert.ok(firstPoll);
  await firstPoll.callback();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(h.calls.map(call=>call.name),['devspace_goal_status']);
  assert.match(h.window.__DEVSPACE_GOAL_RELAY_STATE__.lastError,/Exact Goal status unavailable/);
  assert.equal(h.window.__DEVSPACE_GOAL_RELAY_STATE__.active,true);
  assert.equal(h.sends(),0);
});

test('persistent Goal relay retires only after exact Goal becomes terminal',async()=>{
  const initialGoal={id:'goal_persistent_terminal',conversationId:'conversation-terminal',status:'active',round:9,roundState:'working',revision:9,
    continuation:{state:'idle',continuationId:null}};
  const terminal={...initialGoal,status:'completed',roundState:'working',revision:10};
  const h=relayHarness({initialGoal,statusGoals:[terminal]});
  await h.timers.find(timer=>timer.ms===250).callback();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.window.__DEVSPACE_GOAL_RELAY_STATE__.active,false);
  assert.equal(h.window.__DEVSPACE_GOAL_RELAY_STATE__.stoppedReason,'goal-completed');
  assert.equal(h.released(),1);
  assert.equal(h.sends(),0);
});
