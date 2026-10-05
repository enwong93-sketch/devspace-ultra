import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoalRuntime } from './goal-runtime.js';
import { registerGoalTools } from './goal-tools.js';

const root = await mkdtemp(join(tmpdir(), 'devspace-mount-transport-'));
try {
  const runtime = new GoalRuntime({ stateDir: root });
  await runtime.ready;
  const tools = new Map(), mounts = [], sends = [];
  const relayUri = 'ui://devspace/goal-continuation-relay-v3.html';
  registerGoalTools({ registerTool(name,config,handler) { tools.set(name,{config,handler}); } }, runtime, {
    resourceUri: 'ui://devspace/goal-dock.html', relayResourceUri: relayUri,
    resolveConversation: async extra => extra?.conversationId ? extra : null,
    hostBridge: { dispatch: async args => { sends.push(args); throw Error('Mount must not send'); } },
    onMount: async ({ goal }) => mounts.push(goal.id),
  });
  const mount = tools.get('devspace_goal_mount');
  assert.equal(mount.config._meta.ui.resourceUri, relayUri,
    'restoring the floating label alone cannot restore a lost public continuation component');
  assert.deepEqual(mount.config._meta.ui.visibility, ['model']);
  assert.equal(mount.config.annotations.readOnlyHint, true);
  const goal = await runtime.start({ conversationId:'mount-owner', objective:'Fixture existing Goal transport recovery',
    successCriteria:['Keep exact owner and original state'] });
  // No report is present: mounting must not depend on optional bookkeeping.
  const before = await runtime.status(goal.id);
  const correct = await mount.handler({ goalId:goal.id }, { conversationId:'mount-owner' });
  assert.equal(correct.isError, undefined);
  assert.match(correct.content[0].text, /Requested restoration/);
  assert.doesNotMatch(correct.content[0].text, /Mounted Goal|message sent/i);
  assert.deepEqual(correct.structuredContent.goal, before);
  assert.deepEqual(await runtime.status(goal.id), before);
  assert.deepEqual(mounts, [goal.id]);
  const foreign = await mount.handler({ goalId:goal.id }, { conversationId:'mount-other' });
  assert.equal(foreign.isError, true);
  const unknown = await mount.handler({ goalId:goal.id }, {});
  assert.equal(unknown.isError, true, 'unknown native caller must not mount another conversation\'s sender');
  assert.deepEqual(await runtime.status(goal.id), before);
  assert.deepEqual(mounts, [goal.id]);
  const unbound = await runtime.start({ objective:'Fixture unbound ownership is not a transport claim',
    successCriteria:['Do not infer an owner'] });
  const unboundBefore = await runtime.status(unbound.id);
  const rejectedUnbound = await mount.handler({ goalId:unbound.id }, { conversationId:'mount-owner' });
  assert.equal(rejectedUnbound.isError, true);
  assert.deepEqual(await runtime.status(unbound.id), unboundBefore);
  assert.deepEqual(mounts, [goal.id]);
  assert.equal(sends.length, 0);
  console.log(JSON.stringify({ok:true,gate:'goal-mount-hidden-transport',exactOwnerRequired:true,
    optionalReportNotRequired:true,goalStateUnchanged:true,mountDoesNotSend:true,legacyVisibleDockMounted:false}));
} finally { await rm(root,{recursive:true,force:true}); }
