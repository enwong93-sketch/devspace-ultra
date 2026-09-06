import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStableGatewayBackendSnapshot, renderStableGatewayLiveHtml } from "./stable-gateway-live-ui.js";

const root = await mkdtemp(join(tmpdir(), "stable-gateway-live-ui-test-"));
try {
  await writeFile(join(root, "goal-state.json"), JSON.stringify({
    version: 1,
    goals: {
      goal_old: { id: "goal_old", objective: "Old terminal", status: "completed", round: 2, roundState: "working", revision: 9, updatedAt: "2026-09-05T00:00:00.000Z" },
      goal_live: { id: "goal_live", objective: "Current Goal", status: "active", round: 3, roundState: "working", revision: 4, updatedAt: "2026-09-06T00:00:00.000Z" },
    },
  }), "utf8");
  await writeFile(join(root, "plan-state.json"), JSON.stringify({
    version: 1,
    plans: {
      plan_old: { id: "plan_old", title: "Old", status: "completed", revision: 2, updatedAt: "2026-09-05T00:00:00.000Z", steps: [] },
      plan_live: { id: "plan_live", title: "Current Plan", status: "active", revision: 7, updatedAt: "2026-09-06T00:00:00.000Z", steps: [{ id: "s1", text: "Working", status: "in_progress" }] },
    },
  }), "utf8");

  const snapshot = await readStableGatewayBackendSnapshot(root);
  assert.equal(snapshot.goal.id, "goal_live");
  assert.equal(snapshot.plan.id, "plan_live");
  assert.equal(snapshot.goal.objective, "Current Goal");
  assert.equal(snapshot.plan.title, "Current Plan");

  const html = renderStableGatewayLiveHtml();
  assert.match(html, /DevSpace Ultra Live/i);
  assert.match(html, /backend activity/i);
  assert.doesNotMatch(html, /Page\.reload|location\.reload/i, "local activity UI must never contain a ChatGPT page-refresh recovery path");
  assert.match(html, /__devspace\/live\/snapshot/);
  assert.match(html, /prefers-reduced-motion/);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, gate: "stable-gateway-live-ui", stateFileAuthority: true, noChatGptReload: true }));
