import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalRuntime } from "./goal-runtime.js";
import { registerGoalTools } from "./goal-tools.js";

const root = await mkdtemp(join(tmpdir(), "devspace-goal-tools-"));

try {
  const runtime = new GoalRuntime({ stateDir: root });
  await runtime.ready;
  const registered = new Map();
  const server = {
    registerTool(name, config, handler) {
      registered.set(name, { name, config, handler });
      return { name, config, handler };
    },
  };

  registerGoalTools(server, runtime, { resourceUri: "ui://devspace/goal-dock.html" });

  const expectedNames = [
    "devspace_goal_blocked",
    "devspace_goal_complete",
    "devspace_goal_continuation",
    "devspace_goal_control",
    "devspace_goal_mount",
    "devspace_goal_round_begin",
    "devspace_goal_start",
    "devspace_goal_status",
    "devspace_goal_turn_report",
  ];
  assert.deepEqual([...registered.keys()].sort(), expectedNames);

  const start = registered.get("devspace_goal_start");
  const status = registered.get("devspace_goal_status");
  const roundBegin = registered.get("devspace_goal_round_begin");
  const turnReport = registered.get("devspace_goal_turn_report");
  const complete = registered.get("devspace_goal_complete");
  const blocked = registered.get("devspace_goal_blocked");
  const control = registered.get("devspace_goal_control");
  const continuation = registered.get("devspace_goal_continuation");
  const mount = registered.get("devspace_goal_mount");

  assert.equal(start.config._meta.ui.resourceUri, "ui://devspace/goal-dock.html");
  assert.deepEqual(start.config._meta.ui.visibility, ["model"]);
  assert.equal(mount.config._meta.ui.resourceUri, "ui://devspace/goal-dock.html");
  assert.deepEqual(mount.config._meta.ui.visibility, ["model"]);

  assert.deepEqual(status.config._meta.ui.visibility, ["model", "app"]);
  assert.deepEqual(control.config._meta.ui.visibility, ["model", "app"]);
  assert.deepEqual(continuation.config._meta.ui.visibility, ["app"]);
  assert.equal(continuation.config._meta.ui.resourceUri, undefined);

  for (const tool of [roundBegin, turnReport, complete, blocked]) {
    assert.deepEqual(tool.config._meta.ui.visibility, ["model"]);
    assert.equal(tool.config._meta.ui.resourceUri, undefined);
  }

  assert.equal(status.config.annotations.readOnlyHint, true);
  assert.equal(mount.config.annotations.readOnlyHint, true);
  for (const tool of [start, roundBegin, turnReport, complete, blocked, control, continuation]) {
    assert.equal(tool.config.annotations.readOnlyHint, false);
  }

  const startedResult = await start.handler({
    objective: "Verify Goal tool surface",
    successCriteria: ["Goal starts", "Continuation stays app-only"],
  });
  assert.equal(startedResult.isError, undefined);
  const goal1 = startedResult.structuredContent.goal;
  assert.equal(goal1.round, 1);
  assert.equal(goal1.roundState, "working");

  const statusResult = await status.handler({ goalId: goal1.id });
  assert.deepEqual(statusResult.structuredContent.goal, goal1);

  const reportResult = await turnReport.handler({
    goalId: goal1.id,
    summary: "Round one visibly reported.",
    meaningfulProgress: true,
  });
  assert.equal(reportResult.structuredContent.goal.roundState, "reported");
  assert.equal(reportResult.structuredContent.goal.continuation.state, "pending");
  assert.match(reportResult.content[0].text, /End this turn now/i);
  assert.match(reportResult.content[0].text, /no additional user-visible text/i);

  const claimResult = await continuation.handler({
    goalId: goal1.id,
    action: "claim",
  });
  assert.equal(claimResult.structuredContent.goal.continuation.state, "dispatching");
  assert.match(claimResult.structuredContent.claim.leaseId, /^lease_/);
  assert.match(claimResult.structuredContent.claim.prompt, /devspace_goal_round_begin/);

  const round2Result = await roundBegin.handler({
    goalId: goal1.id,
    continuationId: claimResult.structuredContent.claim.continuationId,
  });
  assert.equal(round2Result.structuredContent.goal.round, 2);
  assert.equal(round2Result.structuredContent.goal.roundState, "working");

  const lateAck = await continuation.handler({
    goalId: goal1.id,
    action: "ack",
    leaseId: claimResult.structuredContent.claim.leaseId,
  });
  assert.equal(lateAck.structuredContent.acknowledged, true);
  assert.equal(lateAck.structuredContent.consumed, true);

  const pausedResult = await control.handler({ goalId: goal1.id, action: "pause" });
  assert.equal(pausedResult.structuredContent.goal.status, "paused");
  const resumedResult = await control.handler({ goalId: goal1.id, action: "resume" });
  assert.equal(resumedResult.structuredContent.goal.status, "active");

  const mountResult = await mount.handler({ goalId: goal1.id });
  assert.deepEqual(mountResult.structuredContent.goal, resumedResult.structuredContent.goal);

  const completionGoalResult = await start.handler({
    objective: "Verify Goal completion tool",
    successCriteria: ["Criterion A", "Criterion B"],
  });
  const completionGoal = completionGoalResult.structuredContent.goal;
  const completeResult = await complete.handler({
    goalId: completionGoal.id,
    evidence: completionGoal.successCriteria.map((criterion) => ({
      criterionId: criterion.id,
      evidence: `Verified ${criterion.text}`,
    })),
  });
  assert.equal(completeResult.structuredContent.goal.status, "completed");

  const finalReport = await turnReport.handler({
    goalId: completionGoal.id,
    summary: "Final Goal report is visible.",
    meaningfulProgress: true,
  });
  assert.equal(finalReport.structuredContent.goal.status, "completed");
  assert.equal(finalReport.structuredContent.goal.continuation.state, "idle");

  const blockedGoalResult = await start.handler({
    objective: "Verify blocked tool rejects early",
    successCriteria: ["Blocked guard enforced"],
  });
  const blockedEarly = await blocked.handler({ goalId: blockedGoalResult.structuredContent.goal.id });
  assert.equal(blockedEarly.isError, true);
  assert.equal(blockedEarly.structuredContent, undefined);
  assert.match(blockedEarly.content[0].text, /3 consecutive/i);

  await runtime.close();
  console.log(JSON.stringify({
    ok: true,
    gate: "goal-tools",
    tools: registered.size,
    continuationAppOnly: true,
    renderTools: 2,
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
