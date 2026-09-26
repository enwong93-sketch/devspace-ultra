import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStableGatewayHumanProgress } from "./stable-gateway-human-progress.js";
import { EXACT_CONVERSATION_REQUEST_PROOF } from "./progress-ownership-proof.js";

const root = await mkdtemp(join(tmpdir(), "devspace-human-progress-test-"));
const statePath = join(root, "devspace-live-progress.json");
try {
  const progress = await createStableGatewayHumanProgress({ statePath, limit: 3 });
  await progress.update({
    message: "啱啱我已經確認 Stable Gateway 正常。依家我會直接驗證原生 session 同 conversation ID 嘅對應，唔再靠畫面估。",
    conversationId: "conversation-a",
    goalId: "goal-a",
    round: 1,
    planId: "plan-a",
    planStepId: "step-a",
    source: "goal-run-events",
    kind: "objective",
    dedupeKey: "goal-a:1:objective:step-a",
    toolCategory: "inspection",
    toolStepCount: 0,
  });
  let snapshot = progress.snapshot();
  assert.equal(snapshot.version, 3);
  assert.equal(snapshot.messages.length, 1);
  assert.match(snapshot.messages[0].text, /啱啱我已經確認 Stable Gateway 正常/);
  assert.equal(snapshot.messages[0].conversationId, "conversation-a");
  assert.equal(snapshot.messages[0].goalId, "goal-a");
  assert.equal(snapshot.messages[0].source, "goal-run-events");
  assert.equal(snapshot.messages[0].kind, "objective");
  assert.equal(snapshot.messages[0].toolStepCount, 0);

  await progress.update({
    message: "呢個重複事件唔應該再次加入。",
    conversationId: "conversation-a",
    goalId: "goal-a",
    round: 1,
    source: "goal-run-events",
    kind: "objective",
    dedupeKey: "goal-a:1:objective:step-a",
  });
  assert.equal(progress.snapshot().messages.length, 1, "dedupeKey must suppress restart/event replay duplicates");

  await progress.update({ message: "第一個驗證已經通過。下一步我會將 Goal 同 Plan 真正綁落 conversation，而唔係 runtime。", conversationId: "conversation-a" });
  await progress.update({ message: "我而家開始做 conversation-bound state migration；舊資料會保留，唔會假完成。", conversationId: "conversation-a" });
  await progress.update({ message: "migration gate 已經完成，下一步係真實前端 A→B→A 切換驗收。", conversationId: "conversation-a" });
  snapshot = progress.snapshot();
  assert.equal(snapshot.messages.length, 3, "natural-language message history must stay bounded");
  assert.match(snapshot.messages.at(-1).text, /migration gate 已經完成/);

  const restored = await createStableGatewayHumanProgress({ statePath, limit: 3 });
  const restoredSnapshot = restored.snapshot();
  assert.equal(restoredSnapshot.messages.length, 3, "natural-language messages must survive Gateway restart");
  assert.match(restoredSnapshot.messages.at(-1).text, /真實前端 A→B→A/);
  assert.equal(restoredSnapshot.messages.some((item) => item.dedupeKey === "goal-a:1:objective:step-a"), false, "bounded history may evict old metadata without corrupting later messages");

  const isolatedPath = join(root, "per-conversation-retention.json");
  const isolated = await createStableGatewayHumanProgress({ statePath: isolatedPath, limit: 3 });
  for (const [conversationId, label, count] of [
    ["conversation-isolated-a", "A", 4],
    ["conversation-isolated-b", "B", 3],
  ]) {
    for (let index = 1; index <= count; index += 1) {
      await isolated.update({
        message: `${label}${index}`,
        conversationId,
        source: "goal-run-events",
        kind: "milestone",
        dedupeKey: `${conversationId}:${index}`,
      });
    }
  }
  const isolatedSnapshot = isolated.snapshot();
  assert.equal(isolatedSnapshot.retentionPolicy, "per-conversation-v1");
  assert.deepEqual(
    isolatedSnapshot.messages.filter((item) => item.conversationId === "conversation-isolated-a").map((item) => item.text),
    ["A2", "A3", "A4"],
    "one busy conversation may evict only its own oldest narration",
  );
  assert.deepEqual(
    isolatedSnapshot.messages.filter((item) => item.conversationId === "conversation-isolated-b").map((item) => item.text),
    ["B1", "B2", "B3"],
    "another conversation's narration must not be evicted by unrelated activity",
  );
  const isolatedReloaded = await createStableGatewayHumanProgress({ statePath: isolatedPath, limit: 3 });
  assert.deepEqual(isolatedReloaded.snapshot().messages, isolatedSnapshot.messages,
    "per-conversation narration history must survive Gateway/Core restart");

  await assert.rejects(() => restored.update({ message: "x".repeat(1601) }), /1600 characters/i);
  await assert.rejects(() => restored.update({ message: "Bearer secret-token-value" }), /sensitive/i);

  const proofPath = join(root, "proof-required.json");
  const proofProgress = await createStableGatewayHumanProgress({ statePath: proofPath });
  await assert.rejects(() => proofProgress.update({
    message: "unproved agent report",
    conversationId: "conversation-proof",
    source: "agent-progress-tool",
  }), /ownership proof/i);
  await proofProgress.update({
    message: "page-verified agent report",
    conversationId: "conversation-proof",
    source: "agent-progress-tool",
    kind: "verification",
    ownershipProof: EXACT_CONVERSATION_REQUEST_PROOF,
    ownershipSource: "classic-websocket-tool-invocation-correlation-page-verified",
    ownershipObservedAt: "2026-09-13T04:30:00.000Z",
    ownershipRuntimeKey: "main-02",
    ownershipCallFingerprint: "a".repeat(64),
  });
  assert.equal(proofProgress.snapshot().messages.length, 1);
  assert.equal(proofProgress.snapshot().messages[0].ownershipProof, EXACT_CONVERSATION_REQUEST_PROOF);

  // Legacy writers remain accepted for compatibility, but the user-facing overlay does not render them.
  await restored.update({ doing: "legacy doing", completed: "legacy completed" });
  assert.equal(restored.snapshot().current.text, "legacy doing");
  assert.equal(restored.snapshot().completed[0].text, "legacy completed");

  const defaultPath = join(root, "default-limit.json");
  const defaultProgress = await createStableGatewayHumanProgress({ statePath: defaultPath });
  for (let index = 0; index < 55; index += 1) {
    await defaultProgress.update({
      message: `第 ${index + 1} 個已驗證步驟已完成。`,
      conversationId: "conversation-history",
      goalId: "goal-history",
      round: 1,
      source: "goal-run-events",
      kind: "milestone",
      dedupeKey: `history:${index + 1}`,
      toolStepCount: index + 1,
    });
  }
  const defaultSnapshot = defaultProgress.snapshot();
  assert.equal(defaultSnapshot.messages.length, 48, "default progress history must retain 48 bounded entries for scrolling");
  assert.match(defaultSnapshot.messages[0].text, /第 8 個已驗證步驟/);
  assert.match(defaultSnapshot.messages.at(-1).text, /第 55 個已驗證步驟/);

  for (let index = 0; index < 55; index += 1) {
    await defaultProgress.update({
      message: `另一個 conversation 第 ${index + 1} 個已驗證步驟。`,
      conversationId: "conversation-history-other",
      goalId: "goal-history-other",
      round: 1,
      source: "goal-run-events",
      kind: "milestone",
      dedupeKey: `history-other:${index + 1}`,
      toolStepCount: index + 1,
    });
  }
  const twoConversationSnapshot = defaultProgress.snapshot();
  assert.equal(twoConversationSnapshot.messages.length, 96,
    "the default bound is 48 messages per conversation, not 48 shared by every conversation");
  assert.equal(twoConversationSnapshot.messages.filter((item) => item.conversationId === "conversation-history").length, 48);
  assert.equal(twoConversationSnapshot.messages.filter((item) => item.conversationId === "conversation-history-other").length, 48);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, gate: "stable-gateway-human-progress", durable: true, naturalLanguageStream: true, perConversationHistoryLimit: 48, hardPerConversationLimit: 64, crossConversationEviction: false, legacyCompatible: true }));
