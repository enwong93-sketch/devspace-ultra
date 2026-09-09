import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GoalProgressNarrator,
  activeProgressRows,
  decideGoalProgressNarration,
  goalRoundReportNarration,
} from "./goal-progress-narrator.js";

assert.equal(decideGoalProgressNarration({
  row: { goalId: "goal-a", conversationId: "conversation-a", stepCount: 99, lastSuccess: false },
}), null, "tool boundaries, failures, silence, and cadence must never generate program-written narration");

const reportGoal = {
  id: "goal-a",
  conversationId: "conversation-a",
  round: 2,
  lastRoundReport: {
    round: 2,
    reportedAt: "2026-09-08T00:00:00.000Z",
    summary: "我已經完成 Gateway session reconnect 驗證，跨回合冇再出現 502。\n\n而家轉入雙 Blender Runtime 隔離，會以兩個 port 各自讀回同儲存作準。",
  },
};
const rows = goalRoundReportNarration(reportGoal);
assert.equal(rows.length, 2);
assert.deepEqual(rows.map((row) => row.text), [
  "我已經完成 Gateway session reconnect 驗證，跨回合冇再出現 502。",
  "而家轉入雙 Blender Runtime 隔離，會以兩個 port 各自讀回同儲存作準。",
]);
assert.equal(rows.every((row) => row.kind === "agent-round-report"), true);
assert.equal(rows.every((row) => row.source === "goal-round-report"), true);
assert.equal(rows.some((row) => /第 \d+ 輪|本輪進度|工具步驟|仍然進行中/.test(row.text)), false);

const now = Date.parse("2026-09-08T00:00:00.000Z");
const activeRows = activeProgressRows({
  progressState: {
    active: { goalId: "goal-a", round: 2, conversationId: "conversation-a", progressKind: "goal", heartbeatAt: new Date(now).toISOString() },
    runs: [
      { goalId: "plan:plan-b", planId: "plan-b", round: 1, conversationId: "conversation-b", progressKind: "plan", heartbeatAt: new Date(now).toISOString() },
      { goalId: "conversation:conversation-c", round: 1, conversationId: "conversation-c", progressKind: "conversation", inFlightCount: 1, turnObservedAt: new Date(now).toISOString() },
    ],
  },
  planState: { plans: { "plan-b": { id: "plan-b", status: "active", conversationId: "conversation-b" } } },
  goalState: { goals: { "goal-a": { id: "goal-a", status: "active", round: 2, conversationId: "conversation-a" } } },
  nowMs: now,
});
assert.deepEqual(new Set(activeRows.map((row) => row.conversationId)), new Set(["conversation-a", "conversation-b", "conversation-c"]));

const root = await mkdtemp(join(tmpdir(), "devspace-agent-authored-narrator-"));
try {
  const goalStatePath = join(root, "goal-state.json");
  await writeFile(goalStatePath, JSON.stringify({ goals: { "goal-a": reportGoal } }));
  const messages = [];
  const humanProgress = {
    snapshot() { return { messages: structuredClone(messages) }; },
    async update(value) {
      if (!messages.some((item) => item.dedupeKey === value.dedupeKey)) {
        messages.push({ ...value, text: value.message || value.text, at: new Date(now).toISOString() });
      }
      return { messages: structuredClone(messages) };
    },
  };
  const narrator = new GoalProgressNarrator({ goalStatePath, humanProgress });
  const first = await narrator.start({ schedule: false });
  assert.equal(first.published, true);
  assert.equal(first.agentAuthoredOnly, true);
  assert.deepEqual(messages.map((item) => item.text), rows.map((row) => row.text));
  const duplicate = await narrator.pollOnce();
  assert.equal(duplicate.published, false);
  assert.equal(messages.length, 2);
  assert.equal(narrator.status().automaticToolNarration, false);
  assert.equal(narrator.status().periodicNarration, false);
  await narrator.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  gate: "goal-progress-narrator",
  agentAuthoredOnly: true,
  automaticToolNarration: false,
  periodicNarration: false,
  exactReportText: true,
  deterministicDedupe: true,
  multiConversationContext: true,
}));
