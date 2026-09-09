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

  assert.equal(start.config._meta.ui.resourceUri, undefined);
  assert.deepEqual(start.config._meta.ui.visibility, ["model"]);
  assert.equal(mount.config._meta.ui.resourceUri, undefined);
  assert.deepEqual(mount.config._meta.ui.visibility, ["model"]);
  assert.match(start.config.description, /floating Plan HUD.*progress narration card/i);
  assert.match(start.config.description, /legacy inline Plan card/i);
  assert.match(mount.config.description, /floating Plan HUD/i);
  assert.match(mount.config.description, /without rendering.*inline Plan card/i);
  assert.equal(update.config._meta?.ui?.resourceUri, undefined);
  assert.deepEqual(update.config._meta.ui.visibility, ["model"]);
  assert.equal(status.config._meta?.ui?.resourceUri, undefined);
  assert.deepEqual(status.config._meta.ui.visibility, ["model", "app"]);
  assert.equal(status.config.annotations.readOnlyHint, true);
  assert.equal(mount.config.annotations.readOnlyHint, true);
  assert.equal(start.config.annotations.readOnlyHint, false);
  assert.equal(update.config.annotations.readOnlyHint, false);
  assert.match(start.config.description, /fresh.*physical turn|fresh.*Goal round/i, "Plan start must describe a fresh turn-scoped plan rather than one persistent task-wide card");
  assert.match(start.config.description, /active plan.*resume|resume.*active plan/i, "Plan start must tell interrupted turns to resume the existing active plan instead of creating a duplicate");
  assert.match(update.config.description, /complete.*before.*final|complete.*before.*turn report/i, "Turn-scoped plan instructions must require completion before the physical turn ends");

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

  {
    const boundRoot = await mkdtemp(join(tmpdir(), "devspace-plan-tools-conversation-bound-"));
    try {
      const boundRuntime = new PlanRuntime({ stateDir: boundRoot });
      await boundRuntime.ready;
      const boundRegistered = new Map();
      const boundServer = {
        registerTool(name, config, handler) {
          boundRegistered.set(name, { name, config, handler });
          return { name, config, handler };
        },
      };
      registerPlanTools(boundServer, boundRuntime, {
        resourceUri: "ui://devspace/plan-card.html",
        resolveConversation: async (extra) => extra?.conversationId ? { conversationId: extra.conversationId } : null,
      });
      const boundStart = boundRegistered.get("devspace_plan_start");
      const unresolved = await boundStart.handler({
        title: "Must not become global",
        steps: [
          { text: "Current", status: "in_progress" },
          { text: "Next", status: "pending" },
        ],
      }, {});
      assert.equal(unresolved.isError, true);
      assert.match(unresolved.content[0].text, /conversation identity is unresolved|unbound Plan/i);

      const startedA = await boundStart.handler({
        title: "Conversation A tool plan",
        steps: [
          { text: "A current", status: "in_progress" },
          { text: "A next", status: "pending" },
        ],
      }, { conversationId: "conversation-tools-a" });
      assert.equal(startedA.structuredContent.plan.conversationId, "conversation-tools-a");

      const startedB = await boundStart.handler({
        title: "Conversation B tool plan",
        steps: [
          { text: "B current", status: "in_progress" },
          { text: "B next", status: "pending" },
        ],
      }, { conversationId: "conversation-tools-b" });
      assert.equal(startedB.structuredContent.plan.conversationId, "conversation-tools-b");
      await boundRuntime.close();
    } finally {
      await rm(boundRoot, { recursive: true, force: true });
    }
  }

  console.log(JSON.stringify({
    ok: true,
    gate: "plan-tools",
    tools: registered.size,
    legacyInlineCardTools: 0,
    dataTools: 4,
    conversationBound: true,
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
