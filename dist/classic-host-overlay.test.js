import assert from "node:assert/strict";
import {
  ClassicHostOverlayCdpAdapter,
  ClassicHostOverlayContextAdapter,
  ClassicHostOverlayProjection,
  buildClassicHostOverlayScript,
  conversationBoundProjectionMap,
  normalizeClassicHostOverlayProjection,
} from "./classic-host-overlay.js";

function sampleGoal(overrides = {}) {
  return {
    id: "goal_0123456789abcdef",
    objective: "Keep a long DevSpace Goal visible without moving backend truth into the host UI.",
    status: "active",
    round: 3,
    roundState: "working",
    revision: 11,
    updatedAt: "2026-09-05T15:00:00.000Z",
    ...overrides,
  };
}

function samplePlan(overrides = {}) {
  return {
    id: "plan_0123456789abcdef",
    title: "Context Guardian v2",
    status: "active",
    revision: 9,
    updatedAt: "2026-09-05T15:00:00.000Z",
    steps: [
      { id: "step_0000000000000001", text: "Research", status: "completed" },
      { id: "step_0000000000000002", text: "Implement host overlay", status: "in_progress" },
      { id: "step_0000000000000003", text: "Frontend acceptance", status: "pending" },
    ],
    ...overrides,
  };
}

const projection = normalizeClassicHostOverlayProjection({
  goal: sampleGoal(),
  plan: samplePlan(),
});
assert.equal(projection.schemaVersion, 1);
assert.equal(projection.goal.objective, sampleGoal().objective);
assert.equal(projection.goal.round, 3);
assert.equal(projection.goal.revision, 11);
assert.equal(projection.plan.currentStepIndex, 1);
assert.equal(projection.plan.currentStepNumber, 2);
assert.equal(projection.plan.totalSteps, 3);
assert.equal(projection.plan.completedSteps, 1);
assert.equal(projection.plan.steps[1].status, "in_progress");

const hostile = normalizeClassicHostOverlayProjection({
  goal: sampleGoal({ objective: "</script><script>globalThis.__overlayXss = 1</script>" }),
  plan: samplePlan({ title: "<img src=x onerror=globalThis.__overlayXss=2>" }),
});
const script = buildClassicHostOverlayScript(hostile);
assert.ok(script.includes("devspace-host-overlay-root"));
assert.ok(script.includes("#prompt-textarea"));
assert.ok(script.includes("#thread-bottom-container"));
assert.ok(script.includes("main#main"));
assert.ok(script.includes("textContent"));
assert.ok(script.includes("surface=work"));
assert.ok(script.includes("position:fixed"));
assert.ok(script.includes("devspace-goal-strip"));
assert.ok(script.includes("devspace-plan-hud"));
assert.ok(script.includes("'Step ' + String(state.plan.currentStepNumber"), "Plan HUD progress must say Step X / N instead of looking like X/N completed");
assert.equal(script.includes("</script><script>globalThis.__overlayXss"), false);
assert.equal(script.includes("<img src=x onerror=globalThis.__overlayXss"), false);

const goalRuntime = {
  calls: 0,
  async projectableGoals() {
    this.calls += 1;
    return [sampleGoal({ revision: 10 + this.calls })];
  },
};
const planRuntime = {
  calls: 0,
  async activePlans() {
    this.calls += 1;
    return [samplePlan({ revision: 8 + this.calls })];
  },
};
const projected = [];
const projectionAdapter = {
  async syncAll(value) {
    projected.push(value);
    return { connected: 2, synced: 2, results: [] };
  },
};
const manager = new ClassicHostOverlayProjection({
  goalRuntime,
  planRuntime,
  adapter: projectionAdapter,
  pollMs: 0,
});
await manager.start({ schedule: false });
assert.equal(projected.length, 1);
assert.equal(projected[0].goal.revision, 11);
assert.equal(projected[0].plan.revision, 9);
await manager.syncOnce();
assert.equal(projected.length, 2);
assert.equal(projected[1].goal.revision, 12);
assert.equal(projected[1].plan.revision, 10);
await manager.close();
assert.equal(projected.length, 3);
assert.equal(projected[2].goal, null);
assert.equal(projected[2].plan, null);

{
  const unchangedSyncs = [];
  const stableManager = new ClassicHostOverlayProjection({
    goalRuntime: { async projectableGoals() { return [sampleGoal()]; } },
    planRuntime: { async activePlans() { return [samplePlan()]; } },
    adapter: {
      status() {
        return { connected: 1, runtimes: [{ runtimeKey: "main-02", port: 9732 }] };
      },
      async syncAll(value, options) {
        unchangedSyncs.push({ value, options });
        return { connected: 1, synced: 1, results: [] };
      },
    },
    resolveOwner: async (goal) => ({ goalId: goal.id, runtimeKey: "main-02", conversationId: "conversation-main-02" }),
    pollMs: 0,
  });
  await stableManager.start({ schedule: false });
  await stableManager.syncOnce();
  assert.equal(unchangedSyncs.length, 1, "unchanged Goal/Plan revision, owner, and runtime topology must cause zero repeated DOM syncs");
  await stableManager.close();
}

{
  const boundMap = conversationBoundProjectionMap({
    goals: [
      sampleGoal({ id: "goal_aaaaaaaaaaaaaaaa", conversationId: "conversation-a", objective: "Goal A", revision: 21 }),
      sampleGoal({ id: "goal_bbbbbbbbbbbbbbbb", conversationId: "conversation-b", objective: "Goal B", revision: 31 }),
    ],
    plans: [
      samplePlan({ id: "plan_aaaaaaaaaaaaaaaa", conversationId: "conversation-a", title: "Plan A", revision: 22 }),
      samplePlan({ id: "plan_bbbbbbbbbbbbbbbb", conversationId: "conversation-b", title: "Plan B", revision: 32 }),
    ],
  });
  assert.deepEqual(Object.keys(boundMap).sort(), ["conversation-a", "conversation-b"]);
  assert.equal(boundMap["conversation-a"].goal.objective, "Goal A");
  assert.equal(boundMap["conversation-b"].plan.title, "Plan B");

  const mapScript = buildClassicHostOverlayScript({}, { conversationProjections: boundMap });
  assert.match(mapScript, /conversationProjectionMap/);
  assert.match(mapScript, /conversationProjectionMap\[currentConversationId\]/, "renderer must select the projection for the conversation currently displayed in that runtime");
  assert.match(mapScript, /conversation-a/);
  assert.match(mapScript, /conversation-b/);
  assert.match(mapScript, /Goal A/);
  assert.match(mapScript, /Goal B/);

  const mapSyncs = [];
  let legacyOwnerResolutions = 0;
  let persistedOwner = { goalId: "goal_legacy00000000", runtimeKey: "main-02", conversationId: "legacy-owner" };
  const boundManager = new ClassicHostOverlayProjection({
    goalRuntime: {
      async projectableGoals() {
        return [
          sampleGoal({ id: "goal_aaaaaaaaaaaaaaaa", conversationId: "conversation-a", objective: "Goal A", revision: 21 }),
          sampleGoal({ id: "goal_bbbbbbbbbbbbbbbb", conversationId: "conversation-b", objective: "Goal B", revision: 31 }),
        ];
      },
    },
    planRuntime: {
      async activePlans() {
        return [
          samplePlan({ id: "plan_aaaaaaaaaaaaaaaa", conversationId: "conversation-a", title: "Plan A", revision: 22 }),
          samplePlan({ id: "plan_bbbbbbbbbbbbbbbb", conversationId: "conversation-b", title: "Plan B", revision: 32 }),
        ];
      },
    },
    adapter: {
      status() { return { connected: 2, runtimes: [{ runtimeKey: "main-02", port: 9732 }, { runtimeKey: "main-03", port: 9733 }] }; },
      async syncAll() { throw new Error("bound conversation state must not use the legacy runtime-owner projection path"); },
      async syncConversationMap(value) {
        mapSyncs.push(value);
        return { connected: 2, synced: 2, results: [] };
      },
    },
    ownerStore: {
      async load() { return persistedOwner; },
      async save(owner) { persistedOwner = owner; },
    },
    resolveOwner: async () => {
      legacyOwnerResolutions += 1;
      return { goalId: "goal_aaaaaaaaaaaaaaaa", runtimeKey: "main-02", conversationId: "conversation-a" };
    },
    pollMs: 0,
  });
  const firstBound = await boundManager.start({ schedule: false });
  assert.equal(firstBound.mode, "conversation-bound");
  assert.equal(legacyOwnerResolutions, 0, "conversation-bound state must not resolve or migrate a runtime owner pointer");
  assert.equal(persistedOwner, null, "entering conversation-bound mode must clear the legacy runtime owner pointer");
  assert.equal(mapSyncs.length, 1);
  await boundManager.syncOnce();
  assert.equal(mapSyncs.length, 2, "conversation-bound map should be re-evaluated cheaply so route changes on the same runtime are reflected without backend ownership changes");
  await boundManager.close();
  assert.deepEqual(mapSyncs.at(-1), {}, "closing the projection must clear all conversation-bound visual projections");
}

const stableScript = buildClassicHostOverlayScript({ goal: sampleGoal(), plan: samplePlan() }, { expectedConversationId: "conversation-main-02" });
assert.match(stableScript, /projectionKey/, "host overlay script must fingerprint rendered state before mutating DOM");
assert.match(stableScript, /ResizeObserver/, "host overlay positioning must use a bounded geometry observer");
assert.doesNotMatch(stableScript, /observer\.observe\(document\.body,\s*\{\s*childList:true,\s*subtree:true\s*\}\)/, "host overlay must not observe the whole document subtree");
assert.doesNotMatch(stableScript, /addEventListener\('scroll'/, "host overlay must not attach a global scroll feedback loop");
assert.match(stableScript, /data-visible/, "Goal and Plan lifecycle should hide/show persistent nodes for natural transitions instead of remounting them");
assert.match(stableScript, /LEASE_MS/, "host overlay projection must carry a bounded visual lease");
assert.match(stableScript, /leaseNonce/, "host overlay must refresh a lease nonce on each backend projection sync");
assert.match(stableScript, /setTimeout\(\(\) => \{[\s\S]*currentRoot\.dataset\.hidden = 'true'/,
  "stale projection lease expiry must hide old Goal/Plan visuals instead of leaving misleading state on screen");
assert.match(stableScript, /if \(root\.dataset\.renderKey === renderKey\)[\s\S]*root\.dataset\.hidden = shouldHide \? 'true' : 'false'/,
  "same-render-key fast path must self-heal root visibility without rewriting card content");
assert.match(stableScript, /if \(root\.dataset\.renderKey === renderKey\)[\s\S]*root\.dataset\.goalRevision = String\(state\.goal\?\.revision \?\? ''\)/,
  "same-render-key fast path must self-heal backend Goal revision metadata");
assert.match(stableScript, /if \(root\.dataset\.renderKey === renderKey\)[\s\S]*unchangedGoal\.dataset\.visible = state\.goal \? 'true' : 'false'/,
  "same-render-key fast path must self-heal Goal visibility");
assert.match(stableScript, /if \(root\.dataset\.renderKey === renderKey\)[\s\S]*unchangedPlan\.dataset\.visible = state\.plan \? 'true' : 'false'/,
  "same-render-key fast path must self-heal Plan visibility");
assert.match(stableScript, /if \(root\.dataset\.renderKey === renderKey\)[\s\S]*existingController\.bind\?\.\(\)[\s\S]*existingController\.schedule\?\.\(\)[\s\S]*existingController\.position\?\.\(\)/,
  "same-render-key fast path must rebind and reposition persistent Goal/Plan nodes after reload/handover");

const connected = [];
const delegated = [];
const closed = [];
const adapter = new ClassicHostOverlayCdpAdapter({
  ports: [9732, 9733],
  connectionPollMs: 0,
  connectPort: async (port) => {
    connected.push(port);
    return {
      runtimeKey: `main-${String(port - 9730).padStart(2, "0")}`,
      port,
      async sync(value) {
        delegated.push({ port, goalRevision: value.goal?.revision ?? null, planRevision: value.plan?.revision ?? null });
        return { mounted: true, mode: "chat" };
      },
      async inspect() {
        return { mounted: true, mode: "chat", goalVisible: true, planVisible: true };
      },
      async close() { closed.push(port); },
    };
  },
});
await adapter.start({ schedule: false });
assert.deepEqual(connected, [9732, 9733]);
const syncResult = await adapter.syncAll(projection);
assert.equal(syncResult.connected, 2);
assert.equal(syncResult.synced, 2);
assert.deepEqual(delegated.map((item) => item.port), [9732, 9733]);
assert.equal((await adapter.inspect("main-03")).planVisible, true);
await adapter.close();
assert.deepEqual(closed.sort((a, b) => a - b), [9732, 9733]);

{
  const ownerSyncs = [];
  let ownerResolutions = 0;
  const ownerManager = new ClassicHostOverlayProjection({
    goalRuntime: { async projectableGoals() { return [sampleGoal()]; } },
    planRuntime: { async activePlans() { return [samplePlan()]; } },
    adapter: {
      async syncAll(value, options) {
        ownerSyncs.push({ value, options });
        return { connected: 1, synced: 1, results: [] };
      },
    },
    resolveOwner: async (goal) => {
      ownerResolutions += 1;
      return { goalId: goal.id, runtimeKey: "main-02", conversationId: "conversation-main-02" };
    },
    pollMs: 0,
  });
  await ownerManager.start({ schedule: false });
  assert.equal(ownerResolutions, 1);
  assert.deepEqual(ownerSyncs[0]?.options?.owner, {
    goalId: sampleGoal().id,
    runtimeKey: "main-02",
    conversationId: "conversation-main-02",
  });
  assert.equal(typeof ownerManager.noteVerifiedRollover, "function", "Host Overlay must expose an explicit verified-rollover owner migration hook");
  const migrated = await ownerManager.noteVerifiedRollover({
    goalId: sampleGoal().id,
    runtimeKey: "main-02",
    oldConversationId: "conversation-main-02",
    newConversationId: "conversation-main-02-fresh",
  });
  assert.equal(migrated, true);
  await ownerManager.syncOnce();
  assert.equal(ownerResolutions, 1, "a verified rollover must migrate the existing owner without re-resolving from a transcript widget");
  assert.equal(ownerSyncs.at(-1)?.options?.owner?.conversationId, "conversation-main-02-fresh");
  const refused = await ownerManager.noteVerifiedRollover({
    goalId: sampleGoal().id,
    runtimeKey: "main-03",
    oldConversationId: "conversation-main-02-fresh",
    newConversationId: "wrong-runtime-conversation",
  });
  assert.equal(refused, false, "a different Main runtime must not steal ownership through the rollover hook");
  await ownerManager.close();
}

{
  let persistedOwner = {
    goalId: sampleGoal().id,
    runtimeKey: "main-03",
    conversationId: "conversation-persisted",
  };
  let ownerLoads = 0;
  let fallbackResolutions = 0;
  const persistedSyncs = [];
  const persistedManager = new ClassicHostOverlayProjection({
    goalRuntime: { async projectableGoals() { return [sampleGoal()]; } },
    planRuntime: { async activePlans() { return [samplePlan()]; } },
    adapter: {
      async syncAll(value, options) {
        persistedSyncs.push({ value, options });
        return { connected: 1, synced: 1, results: [] };
      },
    },
    ownerStore: {
      async load() { ownerLoads += 1; return persistedOwner; },
      async save(owner) { persistedOwner = owner; },
    },
    resolveOwner: async () => {
      fallbackResolutions += 1;
      return { goalId: sampleGoal().id, runtimeKey: "main-02", conversationId: "conversation-fallback" };
    },
    pollMs: 0,
  });
  await persistedManager.start({ schedule: false });
  assert.equal(ownerLoads, 1, "Host Overlay should hydrate its owner pointer once on startup");
  assert.equal(fallbackResolutions, 0, "a persisted owner for the same active Goal must win over transcript re-discovery after backend reload");
  assert.equal(persistedSyncs[0]?.options?.owner?.conversationId, "conversation-persisted");
  await persistedManager.noteVerifiedRollover({
    goalId: sampleGoal().id,
    runtimeKey: "main-03",
    oldConversationId: "conversation-persisted",
    newConversationId: "conversation-persisted-fresh",
  });
  assert.equal(persistedOwner?.conversationId, "conversation-persisted-fresh", "verified rollover migration must persist the new owner conversation");
  await persistedManager.close();
}

{
  let persistedOwner = {
    goalId: sampleGoal().id,
    runtimeKey: "main-03",
    conversationId: "conversation-deleted-owner",
  };
  let ownerResolutions = 0;
  const rebindSyncs = [];
  const rebindManager = new ClassicHostOverlayProjection({
    goalRuntime: { async projectableGoals() { return [sampleGoal()]; } },
    planRuntime: { async activePlans() { return [samplePlan()]; } },
    adapter: {
      status() { return { connected: 1, runtimes: [{ runtimeKey: "main-01", port: 9721 }] }; },
      async syncAll(value, options) {
        rebindSyncs.push({ value, options });
        return { connected: 1, synced: 1, results: [] };
      },
      async inspect() { return { mounted: false, mode: "chat", conversationId: null, goalRevision: null, planRevision: null }; },
    },
    ownerStore: {
      async load() { return persistedOwner; },
      async save(owner) { persistedOwner = owner; },
    },
    resolveOwner: async () => {
      ownerResolutions += 1;
      return { goalId: sampleGoal().id, runtimeKey: "main-01", conversationId: "conversation-fresh-mount" };
    },
    pollMs: 0,
  });
  await rebindManager.start({ schedule: false });
  assert.equal(ownerResolutions, 0, "persisted exact owner must remain authoritative until an explicit mount arms recovery");
  assert.equal(typeof rebindManager.requestOwnerRebind, "function", "Host Overlay must expose explicit mount-driven owner recovery");
  assert.equal(await rebindManager.requestOwnerRebind({ goalId: "goal_wrong0000000000" }), false, "wrong Goal must not arm owner recovery");
  assert.equal(await rebindManager.requestOwnerRebind({ goalId: sampleGoal().id }), true);
  await rebindManager.syncOnce();
  assert.equal(ownerResolutions, 1, "explicit mount recovery must resolve a fresh exact owner once");
  assert.deepEqual(persistedOwner, {
    goalId: sampleGoal().id,
    runtimeKey: "main-01",
    conversationId: "conversation-fresh-mount",
  });
  assert.equal(rebindSyncs.at(-1)?.options?.owner?.conversationId, "conversation-fresh-mount");
  await rebindManager.close();
}

{
  let persistedOwner = {
    goalId: sampleGoal().id,
    runtimeKey: "main-03",
    conversationId: "conversation-deleted-owner-delayed",
  };
  let committed = false;
  let ownerResolutions = 0;
  const delayedManager = new ClassicHostOverlayProjection({
    goalRuntime: { async projectableGoals() { return [sampleGoal()]; } },
    planRuntime: { async activePlans() { return [samplePlan()]; } },
    adapter: {
      status() { return { connected: 1, runtimes: [{ runtimeKey: "main-01", port: 9721 }] }; },
      async syncAll() { return { connected: 1, synced: 1, results: [] }; },
      async inspect() { return { mounted: false, mode: "chat", conversationId: null, goalRevision: null, planRevision: null }; },
    },
    ownerStore: {
      async load() { return persistedOwner; },
      async save(owner) { persistedOwner = owner; },
    },
    resolveOwner: async () => {
      ownerResolutions += 1;
      return committed
        ? { goalId: sampleGoal().id, runtimeKey: "main-01", conversationId: "conversation-delayed-mount" }
        : null;
    },
    pollMs: 0,
  });
  await delayedManager.start({ schedule: false });
  assert.equal(await delayedManager.requestOwnerRebind({ goalId: sampleGoal().id, ttlMs: 1_000 }), true);
  await delayedManager.syncOnce();
  assert.equal(ownerResolutions, 1, "mount recovery should wait when the fresh Goal Dock has not committed yet");
  assert.equal(persistedOwner.conversationId, "conversation-deleted-owner-delayed");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  committed = true;
  await delayedManager.syncOnce();
  assert.equal(ownerResolutions, 2, "explicit mount recovery must survive a long physical turn until a matching Goal Dock actually commits");
  assert.equal(persistedOwner.conversationId, "conversation-delayed-mount");
  await delayedManager.close();
}

{
  const evaluated = [];
  const contextAdapter = {
    status() {
      return {
        connected: 2,
        runtimes: [
          { runtimeKey: "main-02", port: 9732 },
          { runtimeKey: "main-03", port: 9733 },
        ],
      };
    },
    async evaluateRuntime(runtimeKey, expression) {
      evaluated.push({ runtimeKey, expression });
      return { mounted: true, mode: "chat" };
    },
  };
  const shared = new ClassicHostOverlayContextAdapter({ contextAdapter });
  const owned = await shared.syncAll(projection, {
    owner: { goalId: projection.goal.id, runtimeKey: "main-02", conversationId: "conversation-main-02" },
  });
  assert.equal(owned.connected, 2);
  assert.equal(owned.synced, 2);
  const ownerEval = evaluated.find((entry) => entry.runtimeKey === "main-02");
  const nonOwnerEval = evaluated.find((entry) => entry.runtimeKey === "main-03");
  assert.ok(ownerEval?.expression.includes(sampleGoal().objective), "the exact owner runtime must receive the Goal/Plan projection");
  assert.ok(ownerEval?.expression.includes("conversation-main-02"), "the owner conversation id must be embedded as a fail-closed DOM guard");
  assert.equal(nonOwnerEval?.expression.includes(sampleGoal().objective), false, "other Main runtimes must receive an empty projection rather than another Main's Goal");
}

console.log(JSON.stringify({
  ok: true,
  gate: "classic-host-overlay",
  backendAuthoritative: true,
  chatOnlyProjection: true,
  composerGoalStrip: true,
  topRightPlanHud: true,
  multiMainAdapter: true,
}));
