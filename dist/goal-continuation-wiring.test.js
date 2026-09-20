import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GoalRuntime} from './goal-runtime.js';
import {registerGoalTools} from './goal-tools.js';

test('real report handler arms backend owner and app relay delegates without a second sender', async t=>{
  const root=await mkdtemp(join(tmpdir(),'goal-backend-wiring-'));
  const runtime=new GoalRuntime({stateDir:root});
  t.after(async()=>{await runtime.close();await rm(root,{recursive:true,force:true});});
  const tools=new Map(); const calls=[];
  registerGoalTools({registerTool:(name,config,handler)=>{tools.set(name,{config,handler});return{};}},runtime,{
    resourceUri:'ui://devspace/goal-dock.html',relayResourceUri:'ui://devspace/goal-continuation-relay.html',
    resolveConversation:async()=>({conversationId:'conversation-wiring'}),
    hostBridge:{dispatch:async()=>{throw new Error('legacy duplicate sender must not execute');},continuationSupervisor:{
      arm:async(goal,options)=>{calls.push({kind:'arm',goal,options});return {armed:true};},
      requestDispatch:async(goalId)=>{calls.push({kind:'dispatch',goalId});return {state:'waiting',dispatched:false};},
    }},
  });
  const goal=await runtime.start({conversationId:'conversation-wiring',objective:'Goal integration test',successCriteria:['Remain single-owner']});
  const report=await tools.get('devspace_goal_turn_report').handler({goalId:goal.id,summary:'Completed this round',meaningfulProgress:true},{});
  assert.equal(report.isError,undefined);assert.equal(calls[0].goal.roundState,'reported');
  assert.match(report.content[0].text,/backend will dispatch/);
  const dispatched=await tools.get('devspace_goal_continuation').handler({goalId:goal.id,action:'dispatch'},{});
  assert.equal(dispatched.isError,undefined);assert.equal(dispatched.structuredContent.acknowledged,false);
  assert.equal(dispatched.structuredContent.hostDispatch.transport,'backend-exact-page-continuation');
  assert.equal(calls.filter(x=>x.kind==='dispatch').length,1);
});

test('production owns one passive-aware persistent dispatcher and closes it', async()=>{
  const source=await readFile(new URL('./server.js',import.meta.url),'utf8');
  assert.match(source,/new GoalContinuationSupervisor\(/);
  assert.match(source,/enabled: !config\.passiveCore/);
  assert.match(source,/goalHostBridge\.continuationSupervisor = goalContinuationSupervisor/);
  assert.match(source,/goalContinuationSupervisor\.start\(\)/);
  assert.match(source,/await goalContinuationSupervisor\.close\(\)/);
});
