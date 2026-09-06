import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClassicTurnDeliveryEvidenceStore } from "./classic-turn-delivery-evidence.js";

const root = await mkdtemp(join(tmpdir(), "devspace-delivery-evidence-"));
try {
  const path = join(root, "delivery.json");
  const store = new ClassicTurnDeliveryEvidenceStore({ statePath: path, limit: 8 });
  await store.load();
  await store.record({ runtimeKey: "main-02", conversationId: "conv-a", kind: "request", observedAt: "2026-09-06T10:00:00.000Z" });
  await store.record({ runtimeKey: "main-02", conversationId: "conv-a", kind: "failed", errorText: "net::ERR_FAILED", canceled: false, blockedReason: null, observedAt: "2026-09-06T10:00:10.000Z" });
  assert.equal(store.latest({ runtimeKey: "main-02", conversationId: "conv-a", kind: "failed" })?.errorText, "net::ERR_FAILED");
  assert.equal(store.latest({ runtimeKey: "main-02", conversationId: "conv-a", kind: "failed", since: "2026-09-06T10:00:11.000Z" }), null);
  const disk = await readFile(path, "utf8");
  assert.doesNotMatch(disk, /Bearer|password|prompt/i);
  const restored = new ClassicTurnDeliveryEvidenceStore({ statePath: path, limit: 8 });
  await restored.load();
  assert.equal(restored.snapshot().events.length, 2);
  console.log(JSON.stringify({ ok: true, gate: "classic-turn-delivery-evidence", bounded: true, rawContentPersisted: false }));
} finally {
  await rm(root, { recursive: true, force: true });
}
