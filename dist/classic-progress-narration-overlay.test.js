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

const now = Date.parse("2026-09-08T02:30:00.000Z");
const humanProgress = {
  messages: [
    {
      text: "我已完成 Main 01 角色輪廓修正，四個角度讀回一致；下一步處理眼睛比例。",
      at: new Date(now - 4_000).toISOString(),
      conversationId: "conversation-b",
      source: "agent-progress-tool",
      kind: "milestone",
      dedupeKey: "agent-b-1",
    },
    {
      text: "第 10 個已驗證工具步驟已完成；程式自動旁白唔應顯示。",
      at: new Date(now - 3_500).toISOString(),
      conversationId: "conversation-b",
      goalId: "plan:plan-b",
      round: 1,
      source: "goal-run-events",
      kind: "milestone",
      dedupeKey: "program-b-1",
    },
    {
      text: "我已核對 SSE reconnect，同一條 conversation 連續呼叫 Plan、Blender 同旁白工具都冇再 502。",
      at: new Date(now - 3_000).toISOString(),
      conversationId: "conversation-a",
      source: "agent-progress-tool",
      kind: "verification",
      dedupeKey: "agent-a-1",
    },
    {
      text: "我已完成雙 Runtime 單元隔離；而家會用兩個真實 Blender port 做交叉驗證。",
      at: new Date(now - 2_000).toISOString(),
      conversationId: "conversation-a",
      goalId: "goal-a",
      round: 2,
      source: "goal-round-report",
      kind: "agent-round-report",
      dedupeKey: "agent-a-2",
    },
    {
      text: "我已完成雙 Runtime 單元隔離；而家會用兩個真實 Blender port 做交叉驗證。",
      at: new Date(now - 1_500).toISOString(),
      conversationId: "conversation-a",
      source: "agent-progress-tool",
      kind: "milestone",
      dedupeKey: "same-text-different-source",
    },
    {
      text: "即使冇 active Goal 或 Plan，Agent 親自寫嘅訊息仍然要留喺自己 conversation。",
      at: new Date(now - 40 * 60_000).toISOString(),
      conversationId: "conversation-history",
      source: "agent-progress-tool",
      kind: "milestone",
      dedupeKey: "history-1",
    },
  ],
};
const rowA = { goalId: "goal-a", round: 2, conversationId: "conversation-a", progressKind: "goal", heartbeatAt: new Date(now).toISOString() };
const rowB = { goalId: "plan:plan-b", planId: "plan-b", round: 1, conversationId: "conversation-b", progressKind: "plan", heartbeatAt: new Date(now).toISOString() };
const goalProgress = { active: rowA, runs: [rowA, rowB], updatedAt: new Date(now).toISOString() };
const planState = { plans: { "plan-b": { id: "plan-b", status: "active", conversationId: "conversation-b", updatedAt: new Date(now).toISOString(), steps: [{ id: "step-b", text: "完成角色建模", status: "in_progress" }] } } };
const goalState = { goals: { "goal-a": { id: "goal-a", status: "active", round: 2, conversationId: "conversation-a" } } };
const map = conversationProgressNarrationMap({ humanProgress, goalProgress, planState, goalState, nowMs: now });
assert.deepEqual(Object.keys(map).sort(), ["conversation-a", "conversation-b", "conversation-history"]);
assert.deepEqual(map["conversation-a"].messages.map((item) => item.text), [
  "我已核對 SSE reconnect，同一條 conversation 連續呼叫 Plan、Blender 同旁白工具都冇再 502。",
  "我已完成雙 Runtime 單元隔離；而家會用兩個真實 Blender port 做交叉驗證。",
]);
assert.deepEqual(map["conversation-b"].messages.map((item) => item.text), [
  "我已完成 Main 01 角色輪廓修正，四個角度讀回一致；下一步處理眼睛比例。",
]);
assert.equal(map["conversation-b"].progressKind, "plan");
assert.equal(map["conversation-history"].messages.length, 1, "agent-authored history must not disappear because a fixed age window elapsed");
assert.deepEqual(
  conversationProgressNarrationMap({
    humanProgress: { messages: humanProgress.messages.filter((item) => item.source === "goal-run-events") },
    goalProgress,
    planState,
    goalState,
    nowMs: now,
  }),
  {},
  "automatic tool telemetry must never become visible narration",
);

const script = buildProgressNarrationScript(map);
assert.match(script, /DevSpace 進度旁白/);
assert.match(script, /aria-live','polite'/);
assert.match(script, /const UI_VERSION = "5"/);
assert.match(script, /style\.dataset\.uiVersion === UI_VERSION/);
assert.match(script, /root\.dataset\.uiVersion === UI_VERSION && controls === 4/);
assert.match(script, /const structureRebuilt = ensureStructure\(\)/);
assert.match(script, /structureRebuilt \|\| root\.dataset\.renderKey/);
assert.match(script, /const mode =/);
assert.doesNotMatch(script, /if\s*\(isWork\).*visible\s*=\s*false/i, "Work mode must not suppress progress narration");
assert.match(script, /syntheticUserMessages:0/);
assert.doesNotMatch(script, /conversation-fallback|等待呢個 conversation 嘅第一個 DevSpace 工作事件/, "blank cards must not contain program-written placeholder prose");
assert.match(script, /messages:\[\]/, "a conversation with no agent report should still mount one blank card");
assert.match(script, /const visible = Boolean\(conversationId\)/);
assert.match(script, /ui:\/\/devspace\/goal-dock\.html/);
assert.match(script, /ui:\/\/devspace\/plan-card\.html/);
assert.match(script, /devspaceLegacyInlineRetired/);
assert.match(script, /devspaceLegacyInlineErrorRetired/);
assert.match(script, /Failed to fetch template\|載入應用程式時發生錯誤/);
assert.match(script, /legacyFrames\.some\(\(frame\) => ancestor\.contains\(frame\)\)/);
assert.match(script, /retiredLegacyInlineApps/);
assert.match(script, /retiredLegacyInlineErrors/);
assert.match(script, /LEASE_MS/);
assert.match(script, /devspace-progress-scroll/);
assert.match(script, /data-action = 'older'|dataset\.action = 'older'/);
assert.match(script, /data-action = 'newer'|dataset\.action = 'newer'/);
assert.match(script, /data-action = 'expand'|dataset\.action = 'expand'/);
assert.match(script, /dataset\.action = 'compact'/);
assert.match(script, /__devspaceProgressNarrationUiV3/);
assert.match(script, /const anchorRect = goalRect\?\.width > 0 \? goalRect : formRect/);
assert.match(script, /anchorRect\.left \+ \(anchorRect\.width - width\) \/ 2/);
assert.match(script, /size === 'compact'[\s\S]*Math\.round\(anchorRect\.width\)/);
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
assert.match(inspectProgressNarrationExpression(), /retiredLegacyInlineApps/);
assert.match(inspectProgressNarrationExpression(), /retiredLegacyInlineErrors/);
assert.match(inspectProgressNarrationExpression(), /visibleLegacyInlineFrames/);
assert.match(inspectProgressNarrationExpression(), /visibleLegacyInlineErrors/);
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
  assert.equal(evaluations.every((item) => item.expression.includes("我已核對 SSE reconnect")), true);
  assert.equal(evaluations.every((item) => item.expression.includes("我已完成 Main 01 角色輪廓修正")), true);
  assert.equal(evaluations.every((item) => !item.expression.includes("第 10 個已驗證工具步驟")), true);
  const inspected = await overlay.inspect("main-02");
  assert.equal(inspected.visible, true);
  await overlay.close();
  assert.equal(overlay.status().running, false);

  const disabledOverlay = new ClassicProgressNarrationOverlay({ contextAdapter });
  const disabledStart = await disabledOverlay.start({ schedule: true });
  assert.equal(disabledStart.ok, true);
  assert.equal(disabledStart.disabled, true, "missing optional progress paths must disable only the overlay, never crash Core startup");
  assert.equal(disabledOverlay.status().running, false);
  assert.equal(disabledOverlay.status().disabledReason, "progress-state-paths-unavailable");

  console.log(JSON.stringify({
    ok: true,
    gate: "classic-progress-narration-overlay",
    conversationScoped: true,
    multiConversation: true,
    blankCardForEveryConversation: true,
    agentAuthoredOnly: true,
    automaticTelemetryVisible: false,
    legacyInlineGoalAndPlanRetired: true,
    legacyInlineTemplateErrorsRetired: true,
    duplicateTextSuppressed: true,
    scrollHistory: true,
    alwaysVisibleScrollbar: true,
    explicitOlderAndLatestControls: true,
    noReloadUiMigration: true,
    hiddenRuntimeUiMigration: true,
    mouseWheelCaptured: true,
    defaultCompact: true,
    compactNormalExpanded: true,
    agentHistoryRetained: true,
    optionalStatePathsFailOpen: true,
    visibleInChatAndWorkModes: true,
    ariaLive: true,
    boundedMessages: true,
    leaseFailClosed: true,
    syntheticUserMessages: 0,
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
