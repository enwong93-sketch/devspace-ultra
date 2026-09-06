import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStableGatewayHumanProgress } from "./stable-gateway-human-progress.js";

const root = await mkdtemp(join(tmpdir(), "devspace-human-progress-test-"));
const statePath = join(root, "devspace-live-progress.json");
try {
  const progress = await createStableGatewayHumanProgress({ statePath, limit: 3 });
  await progress.update({ message: "啱啱我已經確認 Stable Gateway 正常。依家我會直接驗證原生 session 同 conversation ID 嘅對應，唔再靠畫面估。" });
  let snapshot = progress.snapshot();
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.messages.length, 1);
  assert.match(snapshot.messages[0].text, /啱啱我已經確認 Stable Gateway 正常/);

  await progress.update({ message: "第一個驗證已經通過。下一步我會將 Goal 同 Plan 真正綁落 conversation，而唔係 runtime。" });
  await progress.update({ message: "我而家開始做 conversation-bound state migration；舊資料會保留，唔會假完成。" });
  await progress.update({ message: "migration gate 已經完成，下一步係真實前端 A→B→A 切換驗收。" });
  snapshot = progress.snapshot();
  assert.equal(snapshot.messages.length, 3, "natural-language message history must stay bounded");
  assert.match(snapshot.messages.at(-1).text, /migration gate 已經完成/);

  const restored = await createStableGatewayHumanProgress({ statePath, limit: 3 });
  const restoredSnapshot = restored.snapshot();
  assert.equal(restoredSnapshot.messages.length, 3, "natural-language messages must survive Gateway restart");
  assert.match(restoredSnapshot.messages.at(-1).text, /真實前端 A→B→A/);

  await assert.rejects(() => restored.update({ message: "x".repeat(1601) }), /1600 characters/i);
  await assert.rejects(() => restored.update({ message: "Bearer secret-token-value" }), /sensitive/i);

  // Legacy writers remain accepted for compatibility, but the user-facing overlay does not render them.
  await restored.update({ doing: "legacy doing", completed: "legacy completed" });
  assert.equal(restored.snapshot().current.text, "legacy doing");
  assert.equal(restored.snapshot().completed[0].text, "legacy completed");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, gate: "stable-gateway-human-progress", durable: true, naturalLanguageStream: true, legacyCompatible: true }));
