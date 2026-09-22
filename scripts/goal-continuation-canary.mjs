// One authorized real send in the pre-existing isolated Main-06 canary only.
// No production Goal state, navigation, app launch, cancel, or service restart.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoalRuntime } from '../dist/goal-runtime.js';
import { GoalContinuationSupervisor } from '../dist/goal-continuation-supervisor.js';
import { ClassicGoalHostBridge, inspectGoalContinuationPages } from '../dist/goal-host-bridge.js';
import { readComposerDraft } from '../dist/classic-composer-draft.js';
import { ClassicCdpClient } from '../dist/classic-cdp-client.js';

if (!process.argv.includes('--execute')) throw new Error('Pass --execute for the explicitly authorized isolated canary');
const conversationId = '6aacc828-96f0-83e8-b368-a550e2c8ae27';
const root = await mkdtemp(join(tmpdir(),'devspace-goal-continuation-canary-'));
const resultPath = join(root, 'result.json');
const record = { state:'preflight', startedAt:new Date().toISOString(), resultPath,
  conversationId, runtime:'main-06', productionStateTouched:false, sends:0, tests:[] };
const save = async () => writeFile(resultPath,JSON.stringify(record,null,2));
await save(); console.log(JSON.stringify({resultPath,state:record.state}));
let driver; let runtime;
try {
  const pages = await inspectGoalContinuationPages({conversationId},{ports:[9736]});
  if (pages.length!==1 || pages[0].generating || pages[0].latestMessageRole!=='assistant' || !pages[0].latestAssistantText.trim()) throw new Error('Canary is not one exact idle assistant-completed page; refusing to continue other work');
  record.baselineAssistantMessageId=pages[0].latestAssistantMessageId;
  record.baselineAssistantTextSha256=(await import('node:crypto')).createHash('sha256').update(pages[0].latestAssistantText).digest('hex');
  await save();
  const c = new ClassicCdpClient(pages[0].candidate.pageWebSocketDebuggerUrl,{callTimeoutMs:3000});
  await c.open();
  let draft;
  try {
    const r=await c.call('Runtime.evaluate',{returnByValue:true,expression:`(${readComposerDraft.toString()})(document.querySelector('#prompt-textarea'))`});
    draft=r.result?.value;
  } finally { c.close(); }
  if (draft!=='') throw new Error('Canary has user draft or attachment');
  const inspectNativeBranch = async () => {
    const page = new ClassicCdpClient(pages[0].candidate.pageWebSocketDebuggerUrl,{callTimeoutMs:10000,maxPendingCalls:4});
    await page.open();
    try {
      const result = await page.call('Runtime.evaluate',{returnByValue:true,awaitPromise:true,expression:`(${async function inspect(conversationId) {
        if (location.pathname.match(/\/c\/([^/?#]+)/)?.[1] !== conversationId) return {ok:false,state:'route-changed'};
        const session=await fetch('/api/auth/session',{credentials:'include',cache:'no-store',signal:AbortSignal.timeout(4000)}).then(r=>r.json());
        const access=session?.accessToken||session?.access_token;
        const response=await fetch('/backend-api/conversation/'+encodeURIComponent(conversationId),{credentials:'include',cache:'no-store',signal:AbortSignal.timeout(8000),headers:access?{authorization:'Bearer '+access}:undefined});
        if(!response.ok)return {ok:false,state:'conversation-fetch-'+response.status};
        const payload=await response.json();const branch=[];const seen=new Set();let id=payload.current_node;
        while(id&&payload.mapping?.[id]&&!seen.has(id)){seen.add(id);const node=payload.mapping[id];if(node.message)branch.push(node.message);id=node.parent;}
        branch.reverse();
        return {ok:true,currentNode:payload.current_node||null,
          userIds:branch.filter(m=>m.author?.role==='user').map(m=>m.id),
          assistantIds:branch.filter(m=>m.author?.role==='assistant').map(m=>m.id),
          currentRole:branch.at(-1)?.author?.role||null,currentStatus:branch.at(-1)?.status||null};
      }.toString()})(${JSON.stringify(conversationId)})`});
      return result.result?.value;
    } finally { page.close(); }
  };
  const nativeBefore=await inspectNativeBranch();
  if(!nativeBefore?.ok)throw new Error('Native canary branch could not be inspected safely.');
  runtime = new GoalRuntime({stateDir:root});
  const g = await runtime.start({conversationId,objective:'Isolated Goal continuation transport acceptance',successCriteria:['One accepted visible continuation and next working round']});
  const report=await runtime.turnReport({goalId:g.id,summary:'Resume reserved canary baseline once',meaningfulProgress:true});
  const hostBridge = new ClassicGoalHostBridge({ports:[9736]});
  driver = new GoalContinuationSupervisor({goalRuntime:runtime,statePath:join(root,'driver.json'),
    inspect: (goal, options={}) => inspectGoalContinuationPages(goal,{ports:[9736],...options}),
    dispatch: async ({goal,page,prompt,continuationId,leaseId,round,reportedAt}) => {
      if (++record.sends>1) throw new Error('Canary send budget exhausted');
      await save();
      const t=page.candidate;
      // The canary GoalRuntime is intentionally isolated in a temp directory,
      // so the real Main must not attempt to redeem that synthetic Goal through
      // the production MCP store. Exercise the same hidden host transport with
      // a bounded no-tool assistant-only instruction instead.
      const transportPrompt = [
        '[DEVSPACE_GOAL_HIDDEN_TRANSPORT_CANARY]',
        'This is an isolated hidden-continuation transport acceptance check.',
        'Do not call tools and do not create or request any user message.',
        'Reply exactly CANARY_HIDDEN_READY.',
      ].join('\n');
      record.originalPromptWasGoalContinuation = String(prompt || '').startsWith('[DEVSPACE_GOAL_CONTINUATION]');
      if (!record.originalPromptWasGoalContinuation) throw new Error('Canary supervisor did not supply the real Goal continuation control prompt.');
      const result = await hostBridge.dispatch({goalId:goal.id,conversationId:goal.conversationId,prompt:transportPrompt,
        continuationId,leaseId,round,reportedAt,runtimePort:t.runtimePort,expectedPageTargetId:t.pageTargetId});
      record.transport=result; await save(); return result;
    },
  });
  const armed=await driver.arm(report,{resume:true});
  if (!armed.armed) throw new Error('Canary did not arm: '+JSON.stringify(armed));
  record.state='waiting-for-single-dispatch'; await save();
  const deadline=Date.now()+90_000;
  while(Date.now()<deadline) {
    await driver.pollOnce();
    const row=driver.status().records[0];
    record.driver=row;
    if (['delivered','cancelled'].includes(row?.state)) break;
    await new Promise(r=>setTimeout(r,1000));
  }
  const actual=await runtime.status(g.id);
  const acknowledgedHiddenSend = record.transport?.backgroundAccepted === true;
  const reconciledHiddenSend = record.transport?.dispatchCommitted === true
    && record.driver?.reason === 'uncertain-hidden-send-confirmed-by-native-branch'
    && record.driver?.redeemed === true;
  if (record.driver?.state!=='delivered'||(!acknowledgedHiddenSend&&!reconciledHiddenSend)
    ||record.transport?.visibleUserMessage===true||record.transport?.composerMutation===true||actual.round!==2) {
    throw new Error('Hidden continuation not verified: '+JSON.stringify({driver:record.driver,transport:record.transport,round:actual.round}));
  }
  for(let i=0;i<3;i++) await driver.pollOnce();
  if(record.sends!==1) throw new Error('Duplicate send');
  let nativeAfter=null;
  const deadlineAfter=Date.now()+60_000;
  while(Date.now()<deadlineAfter){
    nativeAfter=await inspectNativeBranch();
    if(nativeAfter?.ok && nativeAfter.assistantIds.some(id=>!nativeBefore.assistantIds.includes(id)))break;
    await new Promise(r=>setTimeout(r,500));
  }
  const after=await inspectGoalContinuationPages({conversationId},{ports:[9736]});
  const afterClient=new ClassicCdpClient(after[0].candidate.pageWebSocketDebuggerUrl,{callTimeoutMs:3000});
  await afterClient.open();let draftAfter;
  try{const r=await afterClient.call('Runtime.evaluate',{returnByValue:true,expression:`(${readComposerDraft.toString()})(document.querySelector('#prompt-textarea'))`});draftAfter=r.result?.value;}finally{afterClient.close();}
  if(!nativeAfter?.ok||nativeAfter.userIds.length!==nativeBefore.userIds.length
    ||nativeAfter.userIds.some((id,index)=>id!==nativeBefore.userIds[index]))throw new Error('Hidden continuation created a visible/synthetic user message.');
  if(!nativeAfter.assistantIds.some(id=>!nativeBefore.assistantIds.includes(id)))throw new Error('Hidden continuation did not start a new assistant turn.');
  if(draftAfter!=='')throw new Error('Hidden continuation changed the visible composer draft.');
  record.tests=['exact-parent-hidden-host-rpc','no-visible-user-message','composer-empty-before-and-after',
    'new-assistant-turn','Goal-round-2-working','one-hidden-send','no-second-send'];
  record.sourceUserChanged=after[0]?.latestUserMessageId!==pages[0].latestUserMessageId;
  record.userMessageCountBefore=nativeBefore.userIds.length;record.userMessageCountAfter=nativeAfter.userIds.length;
  record.newAssistantCount=nativeAfter.assistantIds.filter(id=>!nativeBefore.assistantIds.includes(id)).length;
  record.round=actual.round; record.roundState=actual.roundState;
  record.state='passed';
} catch(error) { record.state='failed'; record.error=error.message; process.exitCode=1; }
finally {
  await driver?.close(); await runtime?.close(); record.completedAt=new Date().toISOString();
  await save(); console.log(JSON.stringify(record,null,2));
}
