#!/usr/bin/env node
// Isolated production Rescue canary. It may mutate only the reserved Main-06
// conversation supplied explicitly by id; no page navigation or other Main.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClassicCdpClient } from '../dist/classic-cdp-client.js';
import { ConversationProgressLivenessCdpAdapter, INTERRUPTED_TURN_RESCUE_TEXT } from '../dist/conversation-progress-liveness-cdp.js';
import { ConversationProgressLivenessSupervisor } from '../dist/conversation-progress-liveness.js';

const conversationId = String(process.argv[2] || '').trim();
if (!/^[A-Za-z0-9_-]{8,200}$/.test(conversationId)) throw new Error('Explicit Main-06 conversation id is required.');
const runtimeKey = 'main-06';
const port = 9736;
const markerId = `devspace-rescue-canary-${Date.now()}`;
const adapter = new ConversationProgressLivenessCdpAdapter({ runtimeKeys: [runtimeKey] });
const dispatchDiagnostics = [];
const supervisorAdapter = {
  find: input => adapter.find(input),
  clearReminder: input => adapter.clearReminder(input),
  resetInterruptedGeneration: input => adapter.resetInterruptedGeneration(input),
  async sendContinue(input) {
    const result = await adapter.sendContinue(input);
    dispatchDiagnostics.push({ sourceUserMessageId: input.sourceUserMessageId || null,
      state: result?.state || null, ok: result?.ok === true,
      dispatchCommitted: result?.dispatchCommitted === true,
      visibilityVerified: result?.visibilityVerified === true });
    return result;
  },
  close: () => adapter.close(),
};
const targetRows = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2500), cache: 'no-store' }).then(r => r.json());
const targets = targetRows.filter(target => {
  try { return target.type === 'page' && new URL(target.url).pathname.match(/\/c\/([^/?#]+)/)?.[1] === conversationId; }
  catch { return false; }
});
if (targets.length !== 1 || !targets[0].webSocketDebuggerUrl) throw new Error('Main-06 exact page is not uniquely available.');
const target = targets[0];
const client = new ClassicCdpClient(target.webSocketDebuggerUrl, { callTimeoutMs: 4000, maxPendingCalls: 8 });
const temp = await mkdtemp(join(tmpdir(), 'devspace-rescue-main06-'));
let supervisor = null;
let markerInjected = false;
const evaluate = async expression => {
  const result = await client.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result?.exceptionDetails) throw new Error('Main-06 page evaluation failed.');
  return result?.result?.value;
};
const countRescueMessages = () => evaluate(`(() => {
  const expected=${JSON.stringify(INTERRUPTED_TURN_RESCUE_TEXT)};
  const rows=[...document.querySelectorAll('[data-message-author-role="user"]')]
    .map(node=>String(node.innerText||node.textContent||'').replace(/^DevSpace Local Gateway\\s*/, '').trim());
  return { count:rows.filter(text=>text===expected).length, latest:rows.at(-1)||null };
})()`);
try {
  await client.open();
  await client.call('Runtime.enable');
  const baseline = await adapter.findAtRuntime({ conversationId, runtimeKey });
  if (!baseline?.exact || baseline.runtimeKey !== runtimeKey || baseline.generating || !baseline.normalCompletion || !baseline.composerEmpty) {
    throw new Error(`Main-06 is not an idle completed canary page (${baseline?.state || 'unsafe-state'}).`);
  }
  const before = await countRescueMessages();
  const injected = await evaluate(`(() => {
    const expected=${JSON.stringify(conversationId)};
    if(location.pathname.match(/\\/c\\/([^/?#]+)/)?.[1]!==expected) return {ok:false,state:'route-changed'};
    if(document.getElementById(${JSON.stringify(markerId)})) return {ok:false,state:'marker-exists'};
    const host=document.querySelector('main')||document.body;
    const section=document.createElement('section');
    section.id=${JSON.stringify(markerId)};
    section.setAttribute('data-testid','conversation-turn-devspace-rescue-canary');
    section.style.cssText='position:fixed;left:6px;top:6px;width:18px;height:18px;opacity:.01;pointer-events:none;z-index:1;overflow:hidden';
    const button=document.createElement('button'); button.type='button'; button.textContent='思考失敗';
    button.style.cssText='width:18px;height:18px;display:block'; section.appendChild(button); host.appendChild(section);
    return {ok:true};
  })()`);
  if (!injected?.ok) throw new Error(`Canary marker injection failed: ${injected?.state || 'unknown'}`);
  markerInjected = true;
  const failedPage = await adapter.findAtRuntime({ conversationId, runtimeKey });
  if (!failedPage?.exact || failedPage.hasTurnError !== true || failedPage.normalCompletion === true) {
    throw new Error('Localized Thinking-failed page evidence was not detected by the production adapter.');
  }
  const statePath = join(temp, 'liveness.json');
  const planPath = join(temp, 'plans.json');
  const progressPath = join(temp, 'progress.json');
  await writeFile(planPath, JSON.stringify({ plans: {} }), 'utf8');
  await writeFile(progressPath, JSON.stringify({ messages: [] }), 'utf8');
  let now = Date.now();
  supervisor = new ConversationProgressLivenessSupervisor({ statePath, planStatePath: planPath, progressStatePath: progressPath,
    adapter: supervisorAdapter, reportIntervalMs: 10 * 60_000, continueMs: 20 * 60_000, pollMs: 1_000, now: () => now });
  await supervisor.start({ schedule: false });
  await supervisor.noteTurn({ kind: 'started', conversationId, runtimeKey, observedAtMs: now });
  await supervisor.noteTurn({ kind: 'failed', conversationId, runtimeKey, canceled: false, observedAtMs: now + 1000 });
  now += 21 * 60_000;
  await supervisor.tick();
  let record = supervisor.status().records.find(row => row.conversationId === conversationId);
  if (record?.lastDispatchState !== 'interrupted-turn-idle-confirmation-armed') {
    throw new Error(`First confirmation was not armed (${record?.lastDispatchState || 'missing'}).`);
  }
  now += 30_000;
  await supervisor.tick();
  record = supervisor.status().records.find(row => row.conversationId === conversationId);
  if (!['rescue-dispatched', 'rescue-submitted-unverified'].includes(record?.turnState) || record?.continueAttempts !== 1) {
    throw new Error(`One-shot Rescue did not commit (${record?.turnState || 'missing'}).`);
  }
  await evaluate(`document.getElementById(${JSON.stringify(markerId)})?.remove(); true`);
  markerInjected = false;
  const after = await countRescueMessages();
  if (after.count !== before.count + 1 || after.latest !== INTERRUPTED_TURN_RESCUE_TEXT) {
    throw new Error(`Visible Rescue message count mismatch (${before.count} -> ${after.count}); ${JSON.stringify({ record, dispatchDiagnostics, baselineLatestUserMessageId: baseline.latestUserMessageId })}`);
  }
  now += 60_000;
  await supervisor.tick();
  const afterExtraTick = await countRescueMessages();
  if (afterExtraTick.count !== after.count) throw new Error('Rescue was sent more than once for one interruption episode.');
  let settled = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    settled = await adapter.findAtRuntime({ conversationId, runtimeKey });
    if (settled?.normalCompletion === true) break;
  }
  console.log(JSON.stringify({ ok: true, gate: 'rescue-main06-live-canary', conversationId, runtimeKey,
    localizedThinkingFailureDetected: true, twentyMinuteBoundarySimulated: true, doubleConfirmation: true,
    oneShotDispatch: true, beforeRescueMessages: before.count, afterRescueMessages: after.count,
    finalTurnState: record.turnState, assistantSettled: settled?.normalCompletion === true,
    exactConversationOnly: true, pageNavigation: false, otherMainMutations: 0 }, null, 2));
} finally {
  if (markerInjected) await evaluate(`document.getElementById(${JSON.stringify(markerId)})?.remove(); true`).catch(() => {});
  await supervisor?.close?.().catch(() => {});
  client.close();
  await rm(temp, { recursive: true, force: true });
}
