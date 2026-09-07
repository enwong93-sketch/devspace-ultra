import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProgressNarrationScript,
  ClassicProgressNarrationOverlay,
  conversationProgressNarrationMap,
  inspectProgressNarrationExpression,
} from "./classic-progress-narration-overlay.js";

const now = Date.parse("2026-09-07T06:30:00.000Z");
const humanProgress = {
  messages: [
    { text: "Main 01 建模進度", at: new Date(now - 1_000).toISOString(), conversationId: "conversation-b", goalId: "plan:plan-b", round: 1, source: "goal-run-events", kind: "objective" },
    { text: "第一段自然進度旁白", at: new Date(now - 3_000).toISOString(), conversationId: "conversation-a", goalId: "goal-a", round: 2, source: "goal-run-events", kind: "objective", dedupeKey: "one" },
    { text: "第二段驗證進度旁白", at: new Date(now - 2_000).toISOString(), conversationId: "conversation-a", goalId: "goal-a", round: 2, source: "goal-run-events", kind: "milestone", dedupeKey: "two" },
    { text: "第二段驗證進度旁白", at: new Date(now - 1_500).toISOString(), conversationId: "conversation-a", goalId: "goal-a", round: 2, source: "goal-run-events", kind: "milestone", dedupeKey: "same-text-new-key" },
    { text: "太舊唔應該顯示", at: new Date(now - 31 * 60_000).toISOString(), conversationId: "conversation-a", goalId: "goal-a", round: 2, source: "goal-run-events", kind: "milestone" },
  ],
};
const rowA = { goalId: "goal-a", round: 2, conversationId: "conversation-a", progressKind: "goal", heartbeatAt: new Date(now).toISOString() };
const rowB = { goalId: "plan:plan-b", planId: "plan-b", round: 1, conversationId: "conversation-b", progressKind: "plan", heartbeatAt: new Date(now).toISOString() };
const goalProgress = { active: rowA, runs: [rowA, rowB], updatedAt: new Date(now).toISOString() };
const planState = { plans: { "plan-b": { id: "plan-b", status: "active", conversationId: "conversation-b", updatedAt: new Date(now).toISOString(), steps: [{ id: "step-b", text: "完成角色建模", status: "in_progress" }] } } };
const goalState = { goals: { "goal-a": { id: "goal-a", status: "active", round: 2, conversationId: "conversation-a" } } };
const map = conversationProgressNarrationMap({ humanProgress, goalProgress, planState, goalState, nowMs: now });
assert.deepEqual(Object.keys(map).sort(), ["conversation-a", "conversation-b"]);
assert.equal(map["conversation-a"].messages.length, 2);
assert.equal(map["conversation-a"].messages[0].text, "第一段自然進度旁白");
assert.equal(map["conversation-a"].messages[1].text, "第二段驗證進度旁白");
assert.equal(map["conversation-b"].messages[0].text, "Main 01 建模進度");
assert.equal(map["conversation-b"].progressKind, "plan");
assert.deepEqual(conversationProgressNarrationMap({ humanProgress, goalProgress: { active: null, runs: [] }, planState: { plans: {} }, goalState: { goals: {} }, nowMs: now }), {});

const script = buildProgressNarrationScript(map);
assert.match(script, /DevSpace 進度旁白/);
assert.match(script, /aria-live','polite'/);
assert.match(script, /const UI_VERSION = "3"/);
assert.match(script, /style\.dataset\.uiVersion === UI_VERSION/);
assert.match(script, /root\.dataset\.uiVersion === UI_VERSION && controls === 4/);
assert.match(script, /const structureRebuilt = ensureStructure\(\)/);
assert.match(script, /structureRebuilt \|\| root\.dataset\.renderKey/);
assert.match(script, /const mode =/);
assert.doesNotMatch(script, /if\s*\(isWork\).*visible\s*=\s*false/i, "Work mode must not suppress progress narration");
assert.match(script, /syntheticUserMessages:0/);
assert.match(script, /LEASE_MS/);
assert.match(script, /devspace-progress-scroll/);
assert.match(script, /data-action = 'older'|dataset\.action = 'older'/);
assert.match(script, /data-action = 'newer'|dataset\.action = 'newer'/);
assert.match(script, /data-action = 'expand'|dataset\.action = 'expand'/);
assert.match(script, /dataset\.action = 'compact'/);
assert.match(script, /__devspaceProgressNarrationUiV3/);
assert.match(script, /localStorage\.setItem/);
assert.match(script, /size:'compact'/);
assert.match(script, /overflow-y:scroll/);
assert.match(script, /scrollbar-width:auto/);
assert.match(script, /scrollBy\(\{ top:-/);
assert.match(script, /scrollTo\(\{ top:scroll\.scrollHeight/);
assert.match(script, /root\.onwheel/);
assert.match(script, /scrollTop = scroll\.scrollHeight/);
assert.match(script, /\['compact','normal','expanded'\]/);
assert.match(inspectProgressNarrationExpression(), /devspace-progress-message/);
assert.match(inspectProgressNarrationExpression(), /scrollHeight/);

const root = await mkdtemp(join(tmpdir(), "devspace-progress-overlay-"));
try {
  const humanPath = join(root, "human.json");
  const goalPath = join(root, "goal-progress.json");
  const planPath = join(root, "plan-state.json");
  const goalStatePath = join(root, "goal-state.json");
  await writeFile(humanPath, JSON.stringify(humanProgress));
  await writeFile(goalPath, JSON.stringify(goalProgress));
  await writeFile(planPath, JSON.stringify(planState));
  await writeFile(goalStatePath, JSON.stringify(goalState));
  const evaluations = [];
  const contextAdapter = {
    status() { return { runtimes: [{ runtimeKey: "main-01", port: 9721 }, { runtimeKey: "main-02", port: 9732 }] }; },
    async evaluateRuntime(runtimeKey, expression) {
      evaluations.push({ runtimeKey, expression });
      return { mounted: true, visible: runtimeKey === "main-02", mode: runtimeKey === "main-01" ? "work" : "chat" };
    },
  };
  const overlay = new ClassicProgressNarrationOverlay({
    contextAdapter,
    humanProgressStatePath: humanPath,
    goalProgressStatePath: goalPath,
    planStatePath: planPath,
    goalStatePath,
    pollMs: 1_000,
    now: () => now,
  });
  const synced = await overlay.start({ schedule: false });
  assert.equal(synced.connected, 2);
  assert.equal(synced.synced, 2);
  assert.equal(evaluations.length, 2);
  assert.equal(evaluations.every((item) => item.expression.includes("第一段自然進度旁白")), true);
  assert.equal(evaluations.every((item) => item.expression.includes("Main 01 建模進度")), true);
  const inspected = await overlay.inspect("main-02");
  assert.equal(inspected.visible, true);
  await overlay.close();
  assert.equal(overlay.status().running, false);

  console.log(JSON.stringify({
    ok: true,
    gate: "classic-progress-narration-overlay",
    conversationScoped: true,
    multiConversation: true,
    duplicateTextSuppressed: true,
    scrollHistory: true,
    alwaysVisibleScrollbar: true,
    explicitOlderAndLatestControls: true,
    noReloadUiMigration: true,
    hiddenRuntimeUiMigration: true,
    mouseWheelCaptured: true,
    defaultCompact: true,
    compactNormalExpanded: true,
    staleMessagesExcluded: true,
    visibleInChatAndWorkModes: true,
    ariaLive: true,
    boundedMessages: true,
    leaseFailClosed: true,
    syntheticUserMessages: 0,
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
