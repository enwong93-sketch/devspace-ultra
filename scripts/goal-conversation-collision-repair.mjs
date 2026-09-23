#!/usr/bin/env node
// Explicit, exact-page verified repair for pre-invariant duplicate Goal records.
// It never navigates a page, edits a composer, stops a runtime, or chooses a Goal
// by timestamp/activity alone. The currently rendered Goal strip is authority.
import { loadConfig } from '../dist/config.js';
import { loadDevspaceFiles } from '../dist/user-config.js';
import { GoalRuntime } from '../dist/goal-runtime.js';
import { ClassicCdpClient } from '../dist/classic-cdp-client.js';
import { defaultMainDebugPorts } from '../dist/goal-host-bridge.js';

const args = process.argv.slice(2);
const value = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const conversationId = String(value('--conversation-id') || '').trim();
const keepGoalId = String(value('--keep-goal-id') || '').trim();
const execute = args.includes('--execute');
if (!/^[A-Za-z0-9_-]{8,240}$/.test(conversationId)) throw new Error('Exact conversation id is required.');
if (!/^goal_[a-f0-9]{16}$/.test(keepGoalId)) throw new Error('Exact keep Goal id is required.');

const inspectPage = async target => {
  const client = new ClassicCdpClient(target.webSocketDebuggerUrl, { callTimeoutMs: 3_000, maxPendingCalls: 2 });
  await client.open();
  try {
    const result = await client.call('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const id=${JSON.stringify(conversationId)};
        if(location.pathname.match(/\\/c\\/([^/?#]+)/)?.[1]!==id)return {ok:false,state:'route-changed'};
        const root=document.getElementById('devspace-host-overlay-root');
        const raw=String(root?.dataset?.renderKey||'');
        const json=raw.split('|mode=')[0];
        try {
          const data=JSON.parse(json);
          return {ok:true,conversationId:data?.expectedConversationId||null,goalId:data?.goal?.id||null,
            goalStatus:data?.goal?.status||null,goalRound:Number.isInteger(data?.goal?.round)?data.goal.round:null,
            schemaVersion:data?.schemaVersion||null,composerMutated:false,pageNavigated:false};
        } catch { return {ok:false,state:'overlay-render-key-unavailable'}; }
      })()`,
    });
    return result?.result?.value || { ok: false, state: 'evaluation-unavailable' };
  } finally {
    client.close();
  }
};

const pages = [];
for (const port of defaultMainDebugPorts()) {
  let targets = [];
  try {
    targets = await fetch(`http://127.0.0.1:${port}/json/list`, {
      cache: 'no-store', signal: AbortSignal.timeout(1_200),
    }).then(response => response.ok ? response.json() : []);
  } catch { continue; }
  for (const target of Array.isArray(targets) ? targets : []) {
    if (target?.type !== 'page' || !target?.webSocketDebuggerUrl) continue;
    let candidateId = null;
    try { candidateId = new URL(target.url).pathname.match(/\/c\/([^/?#]+)/)?.[1] || null; } catch {}
    if (candidateId !== conversationId) continue;
    pages.push({ port, targetId: target.id, proof: await inspectPage(target) });
  }
}
if (!pages.length) throw new Error('Exact conversation page is not open; refusing offline Goal selection.');
if (pages.some(page => page.proof?.ok !== true || page.proof?.conversationId !== conversationId)) {
  throw new Error('Every matching display must expose a valid exact-conversation Goal overlay proof.');
}
const renderedGoalIds = [...new Set(pages.map(page => page.proof.goalId).filter(Boolean))];
if (renderedGoalIds.length !== 1 || renderedGoalIds[0] !== keepGoalId) {
  throw new Error(`Rendered Goal authority is ${renderedGoalIds.join(',') || 'none'}, not requested ${keepGoalId}.`);
}
if (pages.some(page => page.proof.goalStatus !== 'active')) {
  throw new Error('Rendered Goal is not active; refusing legacy collision repair.');
}

const runtime = new GoalRuntime({ stateDir: loadConfig().stateDir });
let runtimeClosed = false;
try {
  await runtime.ready;
  const before = (await runtime.conversationCollisions({ limit: 100 }))
    .find(row => row.conversationId === conversationId) || null;
  if (!before) {
    console.log(JSON.stringify({ ok: true, state: 'no-collision', conversationId, keepGoalId,
      exactDisplays: pages.length, executed: false, rawGoalContentReturned: false }, null, 2));
  } else {
    const preflight = {
      ok: true,
      state: execute ? 'executing' : 'preflight',
      conversationId,
      keepGoalId,
      exactDisplays: pages.length,
      collidingGoalIds: before.goals.map(goal => goal.id),
      candidateStopGoalIds: before.goals.filter(goal => goal.id !== keepGoalId).map(goal => goal.id),
      pageNavigation: false,
      composerMutation: false,
      runtimeRestart: false,
      rawGoalContentReturned: false,
    };
    if (!execute) {
      console.log(JSON.stringify(preflight, null, 2));
    } else {
      // Never write the shared Goal file from a second process while the active
      // Core is serving requests. Close the read-only snapshot and ask that Core
      // to re-verify projection/page authority and serialize the mutation.
      await runtime.close();
      runtimeClosed = true;
      const files = loadDevspaceFiles();
      const response = await fetch('http://127.0.0.1:7678/__devspace/goal/repair-collision', {
        method: 'POST',
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
        headers: {
          'content-type': 'application/json',
          'x-devspace-owner-token': files.auth.ownerToken,
        },
        body: JSON.stringify({ conversationId, keepGoalId }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true) {
        throw new Error(result?.error || `Active Core collision repair HTTP ${response.status}.`);
      }
      console.log(JSON.stringify({ ...preflight, state: 'repaired', executed: true,
        stoppedGoalIds: result.stoppedGoalIds || [], collisionRemaining: false,
        activeCoreSerialized: true }, null, 2));
    }
  }
} finally {
  if (!runtimeClosed) await runtime.close();
}
