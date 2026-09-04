import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanRuntime } from "./plan-runtime.js";

const root = await mkdtemp(join(tmpdir(), "devspace-plan-runtime-"));

try {
  const runtime = new PlanRuntime({ stateDir: root });
  await runtime.ready;

  const started = await runtime.start({
    title: "Ship progress card",
    steps: [
      { text: "Inspect current UI", status: "in_progress" },
      { text: "Implement runtime", status: "pending" },
      { text: "Verify live card", status: "pending" },
    ],
  });

  assert.match(started.id, /^plan_[a-f0-9]{16}$/);
  assert.equal(started.title, "Ship progress card");
  assert.equal(started.status, "active");
  assert.equal(started.revision, 1);
  assert.equal(started.steps.length, 3);
  assert.equal(started.steps.filter((step) => step.status === "in_progress").length, 1);
  assert.ok(started.steps.every((step) => /^step_[a-f0-9]{16}$/.test(step.id)));

  await assert.rejects(
    () => runtime.update({
      planId: started.id,
      steps: [
        { id: started.steps[0].id, text: started.steps[0].text, status: "completed" },
        { id: started.steps[1].id, text: started.steps[1].text, status: "completed" },
        { id: started.steps[2].id, text: started.steps[2].text, status: "in_progress" },
      ],
    }),
    /pending step .* cannot jump directly to completed/i,
  );

  const advanced = await runtime.update({
    planId: started.id,
    explanation: "UI inspection finished; runtime implementation is next.",
    steps: [
      { id: started.steps[0].id, text: started.steps[0].text, status: "completed" },
      { id: started.steps[1].id, text: started.steps[1].text, status: "in_progress" },
      { id: started.steps[2].id, text: started.steps[2].text, status: "pending" },
    ],
  });

  assert.equal(advanced.revision, 2);
  assert.equal(advanced.steps[0].status, "completed");
  assert.equal(advanced.steps[1].status, "in_progress");
  assert.equal(advanced.lastExplanation, "UI inspection finished; runtime implementation is next.");

  await assert.rejects(
    () => runtime.update({
      planId: started.id,
      steps: [
        { id: advanced.steps[0].id, text: advanced.steps[0].text, status: "in_progress" },
        { id: advanced.steps[1].id, text: advanced.steps[1].text, status: "pending" },
        { id: advanced.steps[2].id, text: advanced.steps[2].text, status: "pending" },
      ],
    }),
    /completed step .* cannot regress/i,
  );

  const stepThree = await runtime.update({
    planId: started.id,
    steps: [
      { id: advanced.steps[0].id, text: advanced.steps[0].text, status: "completed" },
      { id: advanced.steps[1].id, text: advanced.steps[1].text, status: "completed" },
      { id: advanced.steps[2].id, text: advanced.steps[2].text, status: "in_progress" },
    ],
  });
  assert.equal(stepThree.revision, 3);

  const completed = await runtime.update({
    planId: started.id,
    explanation: "All acceptance checks passed.",
    steps: stepThree.steps.map((step) => ({ ...step, status: "completed" })),
  });

  assert.equal(completed.status, "completed");
  assert.equal(completed.revision, 4);
  assert.match(completed.completedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(completed.steps.every((step) => step.status === "completed"), true);

  await assert.rejects(
    () => runtime.update({
      planId: started.id,
      steps: completed.steps,
    }),
    /completed plan .* is immutable/i,
  );

  await runtime.close();

  const reloaded = new PlanRuntime({ stateDir: root });
  await reloaded.ready;
  const restored = await reloaded.status(started.id);
  assert.deepEqual(restored, completed);

  const state = JSON.parse(await readFile(join(root, "plan-state.json"), "utf8"));
  assert.equal(state.version, 1);
  assert.equal(state.plans[started.id].revision, 4);
  await reloaded.close();

  await assert.rejects(
    async () => {
      const invalid = new PlanRuntime({ stateDir: root });
      await invalid.ready;
      await invalid.start({
        title: "Invalid plan",
        steps: [
          { text: "First", status: "in_progress" },
          { text: "Second", status: "in_progress" },
        ],
      });
    },
    /exactly one in_progress/i,
  );

  console.log(JSON.stringify({
    ok: true,
    gate: "plan-runtime",
    revision: completed.revision,
    persisted: true,
    transitionGuards: true,
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
