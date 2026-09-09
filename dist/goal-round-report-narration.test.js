import assert from "node:assert/strict";
import { goalRoundReportNarration } from "./goal-progress-narrator.js";

const paragraphs = [
  "壓縮合約已完成：後端 ID 可以轉換，但 UI continuity、Goal 同 Plan authority 必須保持連續。",
  "驗證結果：carry capsule 只保留目標、硬性約束、決策、完成摘要、目前 frontier、阻塞、下一步、重要檔案同測試證據。",
  "禁止內容：完整舊 mapping、逐字 transcript、原始工具輸出、隱藏思考、過期 transport state 同任何憑證。",
  "下一步：用真實 user turn 建立 continuation branch，量度 source payload／branch messages 對 carry capsule 同 target branch 嘅壓縮比。",
];
const goal = {
  id: "goal_aaaaaaaaaaaaaaaa",
  conversationId: "conversation-main-02",
  objective: "Complete genuine selective Auto Compact.",
  status: "active",
  round: 4,
  roundState: "reported",
  lastRoundReport: {
    round: 4,
    summary: paragraphs.join("\n\n"),
    meaningfulProgress: true,
    reportedAt: "2026-09-07T10:00:00.000Z",
  },
  recentReports: [
    {
      round: 3,
      summary: "上一輪已完成 Gateway 116-tool schema 指紋穩定性同圖片工具路由修復。",
      meaningfulProgress: true,
      reportedAt: "2026-09-07T09:00:00.000Z",
    },
  ],
};

const rows = goalRoundReportNarration(goal);
assert.equal(Array.isArray(rows), true, "Round report narration must return message rows.");
assert.equal(rows.length, paragraphs.length, "Only the agent-authored report paragraphs should be projected.");
assert.deepEqual(rows.map((row) => row.text), paragraphs, "Visible card text must remain exactly agent-authored.");
assert.equal(rows.every((row) => typeof row?.text === "string" && row.text.trim().length > 0), true);
assert.equal(rows.every((row) => row.text.length <= 1_600), true, "Each card paragraph must remain bounded.");
assert.equal(rows.every((row) => row.kind === "agent-round-report"), true);
assert.equal(rows.every((row) => row.goalId === goal.id), true);
assert.equal(rows.every((row) => row.conversationId === goal.conversationId), true);
assert.equal(rows.every((row) => row.round === 4), true);
assert.equal(rows.every((row) => row.source === "goal-round-report"), true);
assert.equal(new Set(rows.map((row) => row.dedupeKey)).size, rows.length, "Each report paragraph needs a stable unique dedupe key.");
const combined = rows.map((row) => row.text).join("\n");
for (const prohibited of ["第 4 輪工作匯報", "本輪進度 1/", "已有實質進展", "工具步驟", "仍然進行中"]) {
  assert.equal(combined.includes(prohibited), false, `Program-written narration must not appear: ${prohibited}`);
}
assert.equal(combined.includes("上一輪已完成"), false, "The current report helper must not duplicate older reports into the current report payload.");

const repeated = goalRoundReportNarration(goal);
assert.deepEqual(repeated, rows, "The same persisted round report must produce deterministic rows for deduplication.");

console.log(JSON.stringify({
  ok: true,
  gate: "goal-round-report-narration",
  agentAuthoredOnly: true,
  exactParagraphs: true,
  boundedParagraphs: true,
  conversationBound: true,
  roundBound: true,
  deterministicDedupe: true,
  previousReportNotDuplicated: true,
  programTextAdded: false,
}));
