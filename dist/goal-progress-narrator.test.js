import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalProgressNarrator, decideGoalProgressNarration } from "./goal-progress-narrator.js";

const base = Date.parse("2026-09-07T06:30:00.000Z");
const row = {
  goalId: "goal-a",
  round: 1,
  conversationId: "conversation-a",
  objective: "Fix visible progress",
  stepCount: 0,
  lastBoundaryAt: null,
  lastToolCategory: null,
  lastSuccess: null,
  inFlightCount: 1,
  inFlightToolCategory: "inspection",
  inFlightStartedAt: new Date(base - 10_000).toISOString(),
};
const plan = { planId: "plan-a", stepId: "step-a", stepText: "後端事件驅動進度旁白" };
const first = decideGoalProgressNarration({
  row,
  plan,
  session: { initialized: false },
  nowMs: base,
  minGapMs: 45_000,
  maxSilenceMs: 180_000,
  longToolMs: 120_000,
  milestoneEvery: 4,
});
assert.equal(first.kind, "objective");
assert.match(first.text, /後端事件驅動進度旁白/);
assert.doesNotMatch(first.text, /chain.of.thought/i);

const stage = decideGoalProgressNarration({
  row,
  plan: { ...plan, stepId: "step-b", stepText: "圖片工具路由" },
  session: { initialized: true, lastPlanStepId: "step-a", lastMessageAtMs: base - 1_000 },
  nowMs: base,
  minGapMs: 45_000,
  maxSilenceMs: 180_000,
  longToolMs: 120_000,
  milestoneEvery: 4,
});
assert.equal(stage.kind, "stage");
assert.match(stage.text, /圖片工具路由/);

const failure = decideGoalProgressNarration({
  row: { ...row, stepCount: 1, lastBoundaryAt: new Date(base).toISOString(), lastToolCategory: "verification", lastSuccess: false, inFlightCount: 0 },
  plan,
  session: { initialized: true, lastPlanStepId: "step-a", lastBoundaryAt: null, lastMessageAtMs: base - 1_000 },
  nowMs: base,
  minGapMs: 45_000,
  maxSilenceMs: 180_000,
  longToolMs: 120_000,
  milestoneEvery: 4,
});
assert.equal(failure.kind, "blocker");
assert.match(failure.text, /未通過/);

const throttled = decideGoalProgressNarration({
  row: { ...row, stepCount: 4, lastBoundaryAt: new Date(base).toISOString(), lastToolCategory: "change", lastSuccess: true, inFlightCount: 0 },
  plan,
  session: { initialized: true, lastPlanStepId: "step-a", lastBoundaryAt: null, lastMessageAtMs: base - 5_000, lastNarratedCategory: "inspection", lastNarratedStepCount: 0 },
  nowMs: base,
  minGapMs: 45_000,
  maxSilenceMs: 180_000,
  longToolMs: 120_000,
  milestoneEvery: 4,
});
assert.equal(throttled, null);

const milestone = decideGoalProgressNarration({
  row: { ...row, stepCount: 4, lastBoundaryAt: new Date(base).toISOString(), lastToolCategory: "change", lastSuccess: true, inFlightCount: 0 },
  plan,
  session: { initialized: true, lastPlanStepId: "step-a", lastBoundaryAt: null, lastMessageAtMs: base - 60_000, lastNarratedCategory: "inspection", lastNarratedStepCount: 0 },
  nowMs: base,
  minGapMs: 45_000,
  maxSilenceMs: 180_000,
  longToolMs: 120_000,
  milestoneEvery: 4,
});
assert.equal(milestone.kind, "milestone");
assert.match(milestone.text, /核心修改已經落盤/);

const silence = decideGoalProgressNarration({
  row,
  plan,
  session: { initialized: true, lastPlanStepId: "step-a", lastBoundaryAt: null, lastMessageAtMs: base - 181_000, lastNarratedStepCount: 0 },
  nowMs: base,
  minGapMs: 45_000,
  maxSilenceMs: 180_000,
  longToolMs: 120_000,
  milestoneEvery: 4,
});
assert.equal(silence.kind, "continuing");
assert.match(silence.text, /等候真實結果/);

const root = await mkdtemp(join(tmpdir(), "devspace-goal-narrator-"));
try {
  const progressPath = join(root, "goal-progress.json");
  const planPath = join(root, "plan-state.json");
  let now = base;
  const messages = [];
  const humanProgress = {
    snapshot() { return { messages: structuredClone(messages) }; },
    async update(value) {
      if (messages.some((item) => item.dedupeKey === value.dedupeKey)) return { messages: structuredClone(messages) };
      messages.push({ ...value, at: new Date(now).toISOString() });
      return { messages: structuredClone(messages) };
    },
  };
  await writeFile(progressPath, JSON.stringify({ active: row }));
  await writeFile(planPath, JSON.stringify({ plans: { "plan-a": { id: "plan-a", status: "active", conversationId: "conversation-a", updatedAt: new Date(base).toISOString(), steps: [{ id: "step-a", text: "後端事件驅動進度旁白", status: "in_progress" }] } } }));
  const narrator = new GoalProgressNarrator({
    progressStatePath: progressPath,
    planStatePath: planPath,
    humanProgress,
    pollMs: 1_000,
    minGapMs: 45_000,
    maxSilenceMs: 180_000,
    now: () => now,
  });
  const published = await narrator.start({ schedule: false });
  assert.equal(published.published, true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].conversationId, "conversation-a");
  assert.equal(messages[0].source, "goal-run-events");
  assert.equal(messages[0].kind, "objective");

  const duplicate = await narrator.pollOnce();
  assert.equal(duplicate.published, false);
  assert.equal(messages.length, 1);

  now += 181_000;
  const continuing = await narrator.pollOnce();
  assert.equal(continuing.published, true);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].kind, "continuing");

  await narrator.close();
  assert.equal(narrator.status().running, false);

  const restored = new GoalProgressNarrator({
    progressStatePath: progressPath,
    planStatePath: planPath,
    humanProgress,
    pollMs: 1_000,
    minGapMs: 45_000,
    maxSilenceMs: 180_000,
    now: () => now,
  });
  const afterRestart = await restored.start({ schedule: false });
  assert.equal(afterRestart.published, false, "restart must not duplicate the last narration event");
  assert.equal(messages.length, 2);
  await restored.close();

  const multiProgressPath = join(root, "multi-progress.json");
  const multiPlanPath = join(root, "multi-plan.json");
  const multiGoalPath = join(root, "multi-goal.json");
  const rowB = {
    goalId: "plan:plan-b",
    planId: "plan-b",
    progressKind: "plan",
    round: 1,
    conversationId: "conversation-b",
    objective: "完成第二個工作 agent",
    stepCount: 1,
    lastBoundaryAt: new Date(now - 1_000).toISOString(),
    lastToolCategory: "change",
    lastSuccess: true,
    heartbeatAt: new Date(now).toISOString(),
  };
  const rowC = {
    goalId: "conversation:conversation-c",
    progressKind: "conversation",
    round: 1,
    conversationId: "conversation-c",
    objective: "3D 角色建模",
    stepCount: 0,
    inFlightCount: 1,
    inFlightToolCategory: "capability",
    inFlightStartedAt: new Date(now - 5_000).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
  };
  await writeFile(multiProgressPath, JSON.stringify({
    active: { ...row, progressKind: "goal", heartbeatAt: new Date(now).toISOString() },
    runs: [{ ...row, progressKind: "goal", heartbeatAt: new Date(now).toISOString() }, rowB, rowC],
    updatedAt: new Date(now).toISOString(),
  }));
  await writeFile(multiPlanPath, JSON.stringify({ plans: {
    "plan-a": { id: "plan-a", status: "active", conversationId: "conversation-a", updatedAt: new Date(now).toISOString(), steps: [{ id: "step-a", text: "後端事件驅動進度旁白", status: "in_progress" }] },
    "plan-b": { id: "plan-b", status: "active", conversationId: "conversation-b", updatedAt: new Date(now).toISOString(), steps: [{ id: "step-b", text: "Main 01 建模驗收", status: "in_progress" }] },
  } }));
  await writeFile(multiGoalPath, JSON.stringify({ goals: {
    "goal-a": { id: "goal-a", status: "active", round: 1, conversationId: "conversation-a" },
  } }));
  const multiMessages = [];
  const multiNarrator = new GoalProgressNarrator({
    progressStatePath: multiProgressPath,
    planStatePath: multiPlanPath,
    goalStatePath: multiGoalPath,
    humanProgress: {
      snapshot() { return { messages: structuredClone(multiMessages) }; },
      async update(value) {
        multiMessages.push({ ...value, text: value.message, at: new Date(now).toISOString() });
        return { messages: structuredClone(multiMessages) };
      },
    },
    now: () => now,
  });
  const multi = await multiNarrator.start({ schedule: false });
  assert.equal(multi.published, true);
  assert.equal(multi.publishedCount, 3);
  assert.equal(multi.activeConversationCount, 3);
  assert.deepEqual(new Set(multiMessages.map((item) => item.conversationId)), new Set(["conversation-a", "conversation-b", "conversation-c"]));
  assert.equal(multiMessages.find((item) => item.conversationId === "conversation-b")?.planStepId, "step-b");
  assert.match(multiMessages.find((item) => item.conversationId === "conversation-c")?.text || "", /3D 角色建模/);
  await multiNarrator.close();

  console.log(JSON.stringify({
    ok: true,
    gate: "goal-progress-narrator",
    backendEventDriven: true,
    objectiveBeforeWork: true,
    milestoneThrottle: true,
    failureImmediate: true,
    maxSilenceMs: 180000,
    dedupeAcrossRestart: true,
    planStepAware: true,
    multiConversation: true,
    ordinaryMainConversation: true,
    hiddenReasoningExposed: false,
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
