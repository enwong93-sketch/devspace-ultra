// One authorized real send in the pre-existing isolated Main-06 canary only.
// No production Goal state, navigation, app launch, cancel, or service restart.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoalRuntime } from '../dist/goal-runtime.js';
import { GoalContinuationSupervisor } from '../dist/goal-continuation-supervisor.js';
import { inspectGoalContinuationPages } from '../dist/goal-host-bridge.js';
import { ConversationProgressLivenessCdpAdapter } from '../dist/conversation-progress-liveness-cdp.js';
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
  if (pages.length!==1 || pages[0].generating || pages[0].latestAssistantText.trim()!=='CANARY_READY') throw new Error('Canary is not the expected idle baseline; refusing to continue other work');
  const c = new ClassicCdpClient(pages[0].candidate.pageWebSocketDebuggerUrl,{callTimeoutMs:3000});
  await c.open();
  let draft;
  try {
    const r=await c.call('Runtime.evaluate',{returnByValue:true,expression:`(${readComposerDraft.toString()})(document.querySelector('#prompt-textarea'))`});
    draft=r.result?.value;
  } finally { c.close(); }
  if (draft!=='') throw new Error('Canary has user draft or attachment');
  runtime = new GoalRuntime({stateDir:root});
  const g = await runtime.start({conversationId,objective:'Isolated Goal continuation transport acceptance',successCriteria:['One accepted visible continuation and next working round']});
  const report=await runtime.turnReport({goalId:g.id,summary:'Resume reserved canary baseline once',meaningfulProgress:true});
  const adapter = new ConversationProgressLivenessCdpAdapter({runtimeKeys:['main-06']});
  driver = new GoalContinuationSupervisor({goalRuntime:runtime,statePath:join(root,'driver.json'),
    inspect: goal => inspectGoalContinuationPages(goal,{ports:[9736]}),
    dispatch: async ({goal,page,sourceUserId,assistantMessageId}) => {
      if (++record.sends>1) throw new Error('Canary send budget exhausted');
      await save();
      const t=page.candidate;
      const result = await adapter.sendGoalContinuation({conversationId:goal.conversationId,sourceUserId,assistantMessageId,
        target:{exact:true,conversationId,runtimeKey:'main-06',port:9736,target:{runtimeKey:'main-06',port:9736,targetId:t.pageTargetId,url:t.pageUrl,webSocketDebuggerUrl:t.pageWebSocketDebuggerUrl}}});
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
    if (['delivered','uncertain','cancelled'].includes(row?.state)) break;
    await new Promise(r=>setTimeout(r,1000));
  }
  const actual=await runtime.status(g.id);
  if (record.driver?.state!=='delivered'||!record.transport?.visibilityVerified||actual.round!==2) throw new Error('Real continuation not verified: '+JSON.stringify(record.driver));
  for(let i=0;i<3;i++) await driver.pollOnce();
  if(record.sends!==1) throw new Error('Duplicate send');
  const after=await inspectGoalContinuationPages({conversationId},{ports:[9736]});
  record.tests=['real-exact-page-composer','existing-app-mention-preserved','one-visible-control-turn','Goal-round-2-working','no-second-send'];
  record.sourceUserChanged=after[0]?.latestUserMessageId!==pages[0].latestUserMessageId;
  record.round=actual.round; record.roundState=actual.roundState;
  record.state='passed';
} catch(error) { record.state='failed'; record.error=error.message; process.exitCode=1; }
finally {
  await driver?.close(); await runtime?.close(); record.completedAt=new Date().toISOString();
  await save(); console.log(JSON.stringify(record,null,2));
}
