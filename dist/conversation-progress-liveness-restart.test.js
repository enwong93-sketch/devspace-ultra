import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConversationProgressLivenessSupervisor} from './conversation-progress-liveness.js';

test('repeated Core replacement retains the original interrupted episode and clock',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'devspace-rescue-restart-'));
  const statePath=join(dir,'state.json');
  const started=Date.parse('2026-10-01T12:27:00Z');
  let now=started+30*60_000;
  const cid='conversation-repeat-restart';
  const adapter={find:async()=>({exact:false,state:'conversation-page-not-open'}),clearReminder:async()=>({ok:true})};
  await writeFile(statePath,JSON.stringify({version:4,records:{[cid]:{conversationId:cid,sourceUserMessageId:'user-source-original',armed:true,turnState:'running',episodeRevision:5,startedAt:new Date(started).toISOString(),lastActivityAt:new Date(started+10*60_000).toISOString(),continueAttempts:0}}}));
  try {
    for(let i=0;i<3;i++){
      const supervisor=new ConversationProgressLivenessSupervisor({statePath,adapter,now:()=>now});
      await supervisor.start({schedule:false});
      const record=supervisor.status().records.find(r=>r.conversationId===cid);
      assert.equal(record.armed,true);
      assert.equal(record.turnState,'restart-interrupted');
      assert.equal(record.sourceUserMessageId,'user-source-original');
      assert.equal(record.episodeRevision,5);
      assert.equal(record.startedAt,new Date(started).toISOString());
      assert.equal(record.interruptedAt,new Date(started+10*60_000).toISOString());
      assert.equal(record.continueAttempts,0);
      await supervisor.close();
      now+=5*60_000;
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('an already rescued restart-interrupted episode is not rearmed',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'devspace-rescue-used-'));
  const statePath=join(dir,'state.json');
  const now=Date.parse('2026-10-01T14:00:00Z');
  const cid='conversation-used-restart';
  await writeFile(statePath,JSON.stringify({version:4,records:{[cid]:{conversationId:cid,armed:true,turnState:'restart-interrupted',episodeRevision:4,startedAt:new Date(now-60_000).toISOString(),continueAttempts:1}}}));
  try {
    const supervisor=new ConversationProgressLivenessSupervisor({statePath,now:()=>now});
    await supervisor.start({schedule:false});
    assert.equal(supervisor.status().records.find(r=>r.conversationId===cid).armed,false);
    await supervisor.close();
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('repeated Core replacement still dispatches exactly one verified failure rescue',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'devspace-rescue-restart-dispatch-'));
  const statePath=join(dir,'state.json');
  const started=Date.parse('2026-10-01T12:27:00Z');
  let now=started+1_000;
  const cid='conversation-restart-dispatch';
  const sent=[];
  const adapter={
    find:async()=>({exact:true,conversationId:cid,hydrated:true,generating:false,composerEmpty:true,latestUserMessageId:'user-source-original',latestMessageRole:'assistant',hasTurnError:true,normalCompletion:false,incompleteUserTurn:false}),
    clearReminder:async()=>({ok:true}),
    sendContinue:async request=>{sent.push(request);return {ok:true};},
  };
  await writeFile(statePath,JSON.stringify({version:4,records:{[cid]:{conversationId:cid,sourceUserMessageId:'user-source-original',armed:true,turnState:'running',episodeRevision:5,startedAt:new Date(started).toISOString(),lastActivityAt:new Date(started).toISOString(),continueAttempts:0}}}));
  let supervisor;
  try {
    for(let i=0;i<3;i++){
      supervisor=new ConversationProgressLivenessSupervisor({statePath,adapter,now:()=>now,pollMs:1_000});
      await supervisor.start({schedule:false});
      assert.equal(supervisor.status().records.find(r=>r.conversationId===cid).armed,true);
      assert.equal(sent.length,0);
      if(i<2) await supervisor.close();
      now+=i===0?10_000:35_000;
    }
    await supervisor.tick();
    assert.equal(sent.length,1);
    assert.equal(sent[0].conversationId,cid);
    assert.equal(sent[0].sourceUserMessageId,'user-source-original');
    assert.equal(sent[0].attempt,1);
    assert.equal(supervisor.status().records.find(r=>r.conversationId===cid).turnState,'rescue-dispatched');
    now+=60_000;
    await supervisor.tick();
    assert.equal(sent.length,1,'the old failed episode must never be sent twice');
  } finally {await supervisor?.close();await rm(dir,{recursive:true,force:true});}
});
