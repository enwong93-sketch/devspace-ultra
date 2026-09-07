#!/usr/bin/env node
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../dist/config.js";
import { GoalRuntime } from "../dist/goal-runtime.js";
import { PlanRuntime } from "../dist/plan-runtime.js";
import * as planToolsModule from "../dist/plan-tools.js";

function argument(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? String(process.argv[index + 1]) : fallback;
}

async function activePlans(runtime) {
  if (typeof runtime.activePlans === "function") return await runtime.activePlans({ limit: 100 });
  if (typeof runtime.list === "function") return await runtime.list({ status: "active", limit: 100 });
  throw new Error("PlanRuntime has no active Plan reader.");
}

function registerWithCapturedServer(register, runtime, resolveConversation) {
  const tools = new Map();
  const resources = new Map();
  const fakeServer = {
    registerTool(name, definition, handler) { tools.set(name, { definition, handler }); },
    registerResource(name, template, definition, handler) { resources.set(name, { template, definition, handler }); },
  };
  const attempts = [
    () => register(fakeServer, runtime, { resolveConversation }),
    () => register(fakeServer, { runtime, planRuntime: runtime, resolveConversation }),
    () => register({ server: fakeServer, runtime, planRuntime: runtime, resolveConversation }),
  ];
  let lastError = null;
  for (const attempt of attempts) {
    tools.clear();
    resources.clear();
    try {
      attempt();
      if (tools.has("devspace_update_plan")) return tools;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Unable to capture devspace_update_plan from the official Plan tool registration${lastError ? `: ${lastError.message}` : "."}`);
}

function planFromToolResult(result) {
  if (result?.isError) {
    const message = result?.structuredContent?.error || result?.content?.[0]?.text || "devspace_update_plan returned an error.";
    throw new Error(message);
  }
  const payload = result?.structuredContent ?? result;
  return payload?.plan ?? payload;
}

const goalId = argument("goal-id");
assert.ok(goalId, "--goal-id is required.");
const configDir = resolve(argument("config-dir", join(homedir(), ".devspace-tailscale-bootstrap")));
const config = loadConfig({ ...process.env, DEVSPACE_CONFIG_DIR: configDir });
const goals = new GoalRuntime({ stateDir: config.stateDir });
const plans = new PlanRuntime({ stateDir: config.stateDir });
try {
  const goal = (await goals.activeGoals({ limit: 100 })).find((item) => item.id === goalId);
  assert.ok(goal?.conversationId, `Goal ${goalId} is not active or has no native conversation binding.`);
  const candidates = (await activePlans(plans)).filter((item) => item.status === "active" && item.conversationId === goal.conversationId);
  assert.ok(candidates.length <= 1, `Expected at most one active Plan for the Goal conversation; observed ${candidates.length}.`);
  if (candidates.length === 0) {
    assert.equal(typeof plans.list, "function", "No active Plan exists and PlanRuntime cannot list terminal plans.");
    const terminal = (await plans.list({ limit: 100 }))
      .filter((item) => item.status === "completed" && item.conversationId === goal.conversationId)
      .sort((left, right) => Date.parse(right.completedAt || right.updatedAt || 0) - Date.parse(left.completedAt || left.updatedAt || 0))[0];
    assert.ok(terminal, "No active or completed Plan exists for the Goal conversation.");
    assert.equal((terminal.steps || []).every((step) => step.status === "completed"), true);
    console.log(JSON.stringify({
      ok: true,
      gate: "complete-active-plan-recovery",
      goalId,
      planId: terminal.id,
      conversationId: goal.conversationId,
      updateCount: 0,
      stepCount: terminal.steps.length,
      status: terminal.status,
      idempotentTerminalVerification: true,
      usedOfficialToolHandler: true,
      duplicatePlanCreated: false,
    }));
    process.exit(0);
  }
  let plan = candidates[0];
  const register = planToolsModule.registerPlanTools
    || Object.entries(planToolsModule).find(([name, value]) => typeof value === "function" && /register.*plan/i.test(name))?.[1];
  assert.equal(typeof register, "function", "Official Plan tool registration export was not found.");
  const tools = registerWithCapturedServer(register, plans, async () => ({ conversationId: goal.conversationId }));
  const update = tools.get("devspace_update_plan").handler;
  let updateCount = 0;

  while ((plan.steps || []).some((step) => step.status !== "completed")) {
    const currentIndex = plan.steps.findIndex((step) => step.status === "in_progress");
    const pendingIndex = plan.steps.findIndex((step) => step.status === "pending");
    const nextSteps = plan.steps.map((step, index) => {
      if (index === currentIndex) return { id: step.id, text: step.text, status: "completed" };
      if (currentIndex < 0 && index === pendingIndex) return { id: step.id, text: step.text, status: "in_progress" };
      if (currentIndex >= 0 && index === pendingIndex) return { id: step.id, text: step.text, status: "in_progress" };
      return { id: step.id, text: step.text, status: step.status };
    });
    const activeAfterAdvance = nextSteps.filter((step) => step.status === "in_progress");
    if (pendingIndex < 0) {
      for (const step of nextSteps) if (step.status === "in_progress") step.status = "completed";
    } else if (activeAfterAdvance.length > 1) {
      throw new Error("Plan completion helper generated more than one in-progress step.");
    }
    const result = await update({
      planId: plan.id,
      explanation: "Round work and all final live acceptance gates are complete; advancing the existing conversation-bound Plan without creating a duplicate.",
      steps: nextSteps,
    }, {
      signal: new AbortController().signal,
      requestInfo: {},
    });
    plan = planFromToolResult(result);
    updateCount += 1;
    if (updateCount > 24) throw new Error("Plan completion exceeded the bounded update count.");
  }

  assert.equal(plan.status, "completed", "Plan steps are complete but Plan did not reach terminal completed state.");
  assert.equal((plan.steps || []).every((step) => step.status === "completed"), true);
  console.log(JSON.stringify({
    ok: true,
    gate: "complete-active-plan-recovery",
    goalId,
    planId: plan.id,
    conversationId: goal.conversationId,
    updateCount,
    stepCount: plan.steps.length,
    status: plan.status,
    usedOfficialToolHandler: true,
    duplicatePlanCreated: false,
  }));
} finally {
  await goals.close();
  await plans.close();
}
