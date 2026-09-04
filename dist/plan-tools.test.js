import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanRuntime } from "./plan-runtime.js";
import { registerPlanTools } from "./plan-tools.js";

const root = await mkdtemp(join(tmpdir(), "devspace-plan-tools-"));

try {
  const runtime = new PlanRuntime({ stateDir: root });
  await runtime.ready;
  const registered = new Map();
  const server = {
    registerTool(name, config, handler) {
      registered.set(name, { name, config, handler });
      return { name, config, handler };
    },
  };

  registerPlanTools(server, runtime, { resourceUri: "ui://devspace/plan-card.html" });

  assert.deepEqual([...registered.keys()].sort(), [
    "devspace_plan_mount",
    "devspace_plan_start",
    "devspace_plan_status",
    "devspace_update_plan",
  ]);

  const start = registered.get("devspace_plan_start");
  const update = registered.get("devspace_update_plan");
  const status = registered.get("devspace_plan_status");
  const mount = registered.get("devspace_plan_mount");

  assert.equal(start.config._meta.ui.resourceUri, "ui://devspace/plan-card.html");
  assert.deepEqual(start.config._meta.ui.visibility, ["model"]);
  assert.equal(mount.config._meta.ui.resourceUri, "ui://devspace/plan-card.html");
  assert.deepEqual(mount.config._meta.ui.visibility, ["model"]);
  assert.equal(update.config._meta?.ui?.resourceUri, undefined);
  assert.deepEqual(update.config._meta.ui.visibility, ["model"]);
  assert.equal(status.config._meta?.ui?.resourceUri, undefined);
  assert.deepEqual(status.config._meta.ui.visibility, ["model", "app"]);
  assert.equal(status.config.annotations.readOnlyHint, true);
  assert.equal(mount.config.annotations.readOnlyHint, true);
  assert.equal(start.config.annotations.readOnlyHint, false);
  assert.equal(update.config.annotations.readOnlyHint, false);

  const startResult = await start.handler({
    title: "Verify plan tools",
    steps: [
      { text: "Create plan", status: "in_progress" },
      { text: "Update plan", status: "pending" },
      { text: "Read plan", status: "pending" },
    ],
  });
  assert.equal(startResult.isError, undefined);
  assert.equal(startResult.structuredContent.plan.revision, 1);
  assert.equal(startResult.structuredContent.plan.steps[0].status, "in_progress");
  const planId = startResult.structuredContent.plan.id;

  const updateResult = await update.handler({
    planId,
    explanation: "Plan creation is complete.",
    steps: [
      { ...startResult.structuredContent.plan.steps[0], status: "completed" },
      { ...startResult.structuredContent.plan.steps[1], status: "in_progress" },
      { ...startResult.structuredContent.plan.steps[2], status: "pending" },
    ],
  });
  assert.equal(updateResult.structuredContent.plan.revision, 2);
  assert.equal(updateResult.structuredContent.plan.steps[1].status, "in_progress");

  const statusResult = await status.handler({ planId });
  assert.deepEqual(statusResult.structuredContent.plan, updateResult.structuredContent.plan);

  const mountResult = await mount.handler({ planId });
  assert.deepEqual(mountResult.structuredContent.plan, statusResult.structuredContent.plan);
  assert.match(mountResult.content[0].text, /Mounted plan/i);

  await runtime.close();
  console.log(JSON.stringify({
    ok: true,
    gate: "plan-tools",
    tools: registered.size,
    renderTools: 2,
    dataTools: 2,
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
