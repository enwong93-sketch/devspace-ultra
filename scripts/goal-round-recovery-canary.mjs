#!/usr/bin/env node
// One isolated hidden same-round Goal recovery send in the reserved Main-06
// canary. It never mutates production Goal/Plan state, navigates a page, or
// creates a user message. Run only with --execute and an explicit conversation.
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClassicCdpClient } from '../dist/classic-cdp-client.js';
import { readComposerDraft } from '../dist/classic-composer-draft.js';
import { GoalRuntime } from '../dist/goal-runtime.js';
import { ClassicGoalRoundCompletionGuard } from '../dist/goal-round-completion-guard.js';
import { ClassicGoalHostBridge, inspectGoalContinuationPages } from '../dist/goal-host-bridge.js';

if (!process.argv.includes('--execute')) throw new Error('Pass --execute for the explicitly authorized isolated canary.');
const conversationId = String(process.argv.find(arg => arg.startsWith('--conversation='))?.slice(15)
  || '6aacc828-96f0-83e8-b368-a550e2c8ae27').trim();
if (!/^[A-Za-z0-9_-]{8,200}$/.test(conversationId)) throw new Error('Explicit valid Main-06 conversation id is required.');
const port = 9736;
const runtimeKey = 'main-06';
const root = await mkdtemp(join(tmpdir(), 'devspace-goal-round-recovery-canary-'));
let runtime;
let guard;
const record = { state: 'preflight', conversationId, runtimeKey, productionStateTouched: false,
  sends: 0, pageNavigation: false, visibleUserMessagesCreated: 0 };

async function inspectNativeBranch(candidate) {
  const client = new ClassicCdpClient(candidate.pageWebSocketDebuggerUrl, { callTimeoutMs: 15_000, maxPendingCalls: 4 });
  await client.open();
  try {
    const result = await client.call('Runtime.evaluate', { awaitPromise: true, returnByValue: true,
      expression: `(${async function inspect(conversationId, readDraft) {
        if (location.pathname.match(/\/c\/([^/?#]+)/)?.[1] !== conversationId) return { ok:false, state:'route-changed' };
        const editor=document.querySelector('#prompt-textarea,textarea,div.ProseMirror[contenteditable="true"],[data-lexical-editor="true"][contenteditable="true"],[contenteditable="true"][role="textbox"]');
        const draft=readDraft(editor);
        const session=await fetch('/api/auth/session',{credentials:'include',cache:'no-store',signal:AbortSignal.timeout(4000)}).then(r=>r.json());
        const access=session?.accessToken||session?.access_token;
        const response=await fetch('/backend-api/conversation/'+encodeURIComponent(conversationId),{credentials:'include',cache:'no-store',signal:AbortSignal.timeout(8000),headers:access?{authorization:'Bearer '+access}:undefined});
        if(!response.ok)return {ok:false,state:'conversation-fetch-'+response.status};
        const payload=await response.json();const branch=[];const seen=new Set();let id=payload.current_node;
        while(id&&payload.mapping?.[id]&&!seen.has(id)&&branch.length<4096){seen.add(id);const node=payload.mapping[id];if(node.message)branch.push(node.message);id=node.parent;}
        branch.reverse();
        const users=branch.filter(m=>m.author?.role==='user').map(m=>m.id);
        const assistants=branch.filter(m=>m.author?.role==='assistant').map(m=>m.id);
        const current=branch.at(-1)||null;
        return {ok:true,currentNode:payload.current_node||null,currentRole:current?.author?.role||null,
          currentStatus:current?.status||null,userIds:users,assistantIds:assistants,
          latestUserMessageId:users.at(-1)||null,latestAssistantMessageId:assistants.at(-1)||null,
          composerKnown:draft!==null,composerEmpty:draft==='',draftChars:typeof draft==='string'?draft.length:null};
      }.toString()})(${JSON.stringify(conversationId)}, ${readComposerDraft.toString()})` });
    if (result?.exceptionDetails) throw new Error('Native branch inspection failed.');
    return result?.result?.value;
  } finally { client.close(); }
}

try {
  const pages = await inspectGoalContinuationPages({ conversationId }, { ports: [port] });
  if (pages.length !== 1 || pages[0].runtimeKey !== runtimeKey) throw new Error('Main-06 exact canary page is not uniquely available.');
  const page = pages[0];
  const before = await inspectNativeBranch(page.candidate);
  if (!before?.ok || before.currentRole !== 'assistant' || before.composerEmpty !== true
    || page.generating === true || !page.latestAssistantText?.trim()) {
    throw new Error(`Main-06 is not one idle assistant-completed page: ${JSON.stringify({before,page:{generating:page.generating,role:page.latestMessageRole}})}`);
  }
  record.baseline = {
    userMessageCount: before.userIds.length,
    assistantMessageCount: before.assistantIds.length,
    latestUserMessageId: before.latestUserMessageId,
    latestAssistantMessageId: before.latestAssistantMessageId,
    latestAssistantSha256: createHash('sha256').update(String(page.latestAssistantText)).digest('hex'),
  };

  let now = Date.now();
  const canaryDocumentId = `canary-document-${now}`;
  runtime = new GoalRuntime({ stateDir: root, now: () => now });
  const goal = await runtime.start({ conversationId,
    objective: 'Isolated hidden same-round recovery transport acceptance',
    successCriteria: ['One hidden assistant recovery, no user message and no composer mutation'] });
  const host = new ClassicGoalHostBridge({ ports: [port], hiddenConfirmTimeoutMs: 30_000 });
  let phase = 'active';
  const snapshot = () => ({
    ...page,
    runtimePort: port,
    runtimeKey,
    pageTargetId: page.candidate.pageTargetId,
    documentId: canaryDocumentId,
    routeEpoch: 1,
    conversationId,
    chatMode: true,
    documentReadyState: 'complete',
    composerReady: true,
    routeHydrated: true,
    routeStableForMs: 10_000,
    routeEnteredAt: new Date(Date.parse(goal.roundBeganAt) - 1_000).toISOString(),
    turnRequestObservedAt: new Date(Date.parse(goal.roundBeganAt) + 100).toISOString(),
    latestUserMessageId: before.latestUserMessageId,
    latestAssistantMessageId: before.latestAssistantMessageId,
    latestAssistantText: page.latestAssistantText,
    generating: phase === 'active',
    streamStatus: phase === 'active' ? 'STREAMING' : 'COMPLETE',
    turnFinishedObservedAt: phase === 'active' ? null : new Date(now - 100).toISOString(),
  });
  guard = new ClassicGoalRoundCompletionGuard({
    goalRuntime: runtime,
    now: () => now,
    minimumRoundSettleMs: 0,
    routeSettleMs: 0,
    pollMs: 0,
    inspect: async () => snapshot(),
    dispatch: async (claim, terminal) => {
      record.sends += 1;
      if (record.sends > 1) throw new Error('Hidden recovery send budget exceeded.');
      const prompt = [
        '[DEVSPACE_GOAL_ROUND_RECOVERY]',
        'This is an isolated hidden same-round recovery transport acceptance check.',
        'Do not call tools and do not create or request any user message.',
        'Reply exactly CANARY_HIDDEN_ROUND_READY.',
      ].join('\n');
      return host.dispatchRoundRecovery({ ...claim, prompt, conversationId,
        runtimePort: port, expectedPageTargetId: terminal.pageTargetId,
        sourceUserMessageId: before.latestUserMessageId,
        baselineAssistantMessageId: before.latestAssistantMessageId });
    },
  });
  await guard.start({ schedule: false });
  assertNoRecovery(await guard.pollOnce(), 'active phase');
  phase = 'complete'; now += 2_000;
  const recovered = await guard.pollOnce();
  if (recovered.recovered !== 1) throw new Error(`Hidden recovery did not complete: ${JSON.stringify(recovered)}`);
  assertNoRecovery(await guard.pollOnce(), 'duplicate poll');

  let after = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    after = await inspectNativeBranch(page.candidate);
    if (after?.ok && after.assistantIds.some(id => !before.assistantIds.includes(id))) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!after?.ok || after.composerEmpty !== true) throw new Error('Composer was not empty after hidden recovery.');
  if (after.userIds.length !== before.userIds.length
    || after.userIds.some((id,index)=>id!==before.userIds[index])) {
    throw new Error('Hidden same-round recovery created a visible/synthetic user message.');
  }
  const newAssistants = after.assistantIds.filter(id => !before.assistantIds.includes(id));
  if (!newAssistants.length) throw new Error('Hidden same-round recovery did not create an assistant turn.');
  if (record.sends !== 1) throw new Error('Hidden same-round recovery was sent more than once.');
  record.state = 'passed';
  record.tests = ['round-1-recoverable','exact-hidden-host-relay','no-visible-user-message',
    'composer-empty-before-and-after','new-assistant-turn','one-send','second-poll-no-send'];
  record.userMessageCountBefore = before.userIds.length;
  record.userMessageCountAfter = after.userIds.length;
  record.newAssistantCount = newAssistants.length;
  record.tempGoalRound = (await runtime.status(goal.id)).round;
  record.tempRoundRecoveryState = (await runtime.status(goal.id)).roundRecovery.state;
  console.log(JSON.stringify({ ok:true, gate:'goal-round-recovery-live-canary', ...record }, null, 2));
} catch (error) {
  record.state = 'failed'; record.error = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok:false, gate:'goal-round-recovery-live-canary', ...record }, null, 2));
  process.exitCode = 1;
} finally {
  await guard?.close?.().catch(() => {});
  await runtime?.close?.().catch(() => {});
  await rm(root, { recursive: true, force: true });
}

function assertNoRecovery(result, stage) {
  if (result?.recovered !== 0) throw new Error(`${stage} unexpectedly recovered: ${JSON.stringify(result)}`);
}
