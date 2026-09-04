# DevSpace Plan Progress Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent Codex-style multi-step plan runtime and one live MCP Apps progress card for non-trivial ChatGPT Classic work.

**Architecture:** A new `PlanRuntime` owns durable structured plan state in `stateDir`. Model-facing start/update tools mutate that state; read-only status/mount tools retrieve it. Only start/mount attach `ui://devspace/plan-card.html`; the mounted widget polls the app-callable status tool so updates render in place without repeated iframe mounts.

**Tech Stack:** Node.js ESM, `@modelcontextprotocol/ext-apps`, MCP Apps bridge, Zod v4, vanilla HTML/CSS/JS, existing DevSpace test harness.

**Spec:** `docs/superpowers/specs/2026-09-05-plan-progress-card-design.md`

## Global Constraints

- This plan implements only step-plan state and its card; Goal Mode and Context Window work are separate later features.
- Preserve `DEVSPACE_WIDGETS=off` as the default for ordinary workspace/read/edit/bash tools.
- Chat Swarm workers must not create or mount user-facing plan cards.
- Backend state is authoritative; widget state may contain presentation preferences only.
- Active plans have exactly one `in_progress` step; all-completed plans are terminal.
- Existing `pending` steps cannot jump directly to `completed`; completed steps cannot regress.
- A completed plan is immutable.
- UI must degrade to inline if PiP/display-mode requests are unavailable or rejected.

---

### Task 1: Persistent Plan Runtime

**Files:**
- Create: `dist/plan-runtime.js`
- Create: `dist/plan-runtime.test.js`

**Interfaces:**
- Produces: `PlanRuntime({ stateDir })`
- Produces: `start({ title, steps }) -> Promise<Plan>`
- Produces: `update({ planId, explanation?, steps }) -> Promise<Plan>`
- Produces: `status(planId) -> Promise<Plan>`
- Produces: `close() -> Promise<void>`

- [ ] **Step 1: Write the failing runtime tests**

Create `dist/plan-runtime.test.js` with cases that assert:

```js
const started = await runtime.start({
  title: "Ship progress card",
  steps: [
    { text: "Inspect current UI", status: "in_progress" },
    { text: "Implement runtime", status: "pending" },
    { text: "Verify live card", status: "pending" },
  ],
});
assert.match(started.id, /^plan_/);
assert.equal(started.revision, 1);
assert.equal(started.steps.filter((step) => step.status === "in_progress").length, 1);
```

Then verify a direct pending → completed transition rejects, a legal completed → next-in-progress update passes, an all-completed update makes the plan terminal, a terminal plan rejects further update, and a second runtime instance reloads the final plan from the same state directory.

- [ ] **Step 2: Run the runtime test and verify red**

Run:

`node --check dist/plan-runtime.test.js && node dist/plan-runtime.test.js`

Expected: FAIL because `dist/plan-runtime.js` does not exist.

- [ ] **Step 3: Implement the minimal runtime**

Implement a versioned JSON store with a serialized persist queue. Generate opaque `plan_...` and `step_...` IDs with `randomBytes`. Normalize bounded strings, validate 2–12 steps, exactly one in-progress active step, stable supplied IDs, transition invariants, revision increments, and terminal immutability.

- [ ] **Step 4: Run the runtime test and verify green**

Run the same test command. Expected output:

`{"ok":true,"gate":"plan-runtime",...}`

- [ ] **Step 5: Commit runtime task**

Commit message:

`feat: add persistent plan runtime`

---

### Task 2: MCP Plan Tool Surface

**Files:**
- Create: `dist/plan-tools.js`
- Create: `dist/plan-tools.test.js`
- Modify: `dist/server.js`

**Interfaces:**
- Consumes: `PlanRuntime`
- Produces: `registerPlanTools(server, planRuntime, { resourceUri })`
- Tool names: `devspace_plan_start`, `devspace_update_plan`, `devspace_plan_status`, `devspace_plan_mount`

- [ ] **Step 1: Write failing tool-registration tests**

Use a fake server that captures `registerTool` / app-tool descriptors and assert:

- four expected tool names are present;
- start and mount include `_meta.ui.resourceUri = "ui://devspace/plan-card.html"`;
- update and status do not attach a resource URI;
- status visibility includes `app` so the widget can call it;
- annotations match read-only/mutating behavior;
- invoking start/update against a temporary runtime returns the public plan state.

- [ ] **Step 2: Run registration test and verify red**

Run:

`node --check dist/plan-tools.test.js && node dist/plan-tools.test.js`

Expected: FAIL because `plan-tools.js` does not exist.

- [ ] **Step 3: Implement tool registration**

Use `registerAppTool` for start/mount and normal app-compatible tool registration for update/status. Expose exact Zod input/output schemas. Start creates plan state and renders once. Update mutates only state. Status is read-only/model+app. Mount is read-only and renders current state.

- [ ] **Step 4: Wire runtime into server lifecycle**

In `createServer`, construct one `PlanRuntime({ stateDir: config.stateDir })`; pass it into every MCP server instance; close it during server shutdown. Register the plan-card resource and plan tools in `createMcpServer`.

- [ ] **Step 5: Run tool tests and server syntax checks**

Run:

`node --check dist/plan-tools.js && node --check dist/server.js && node dist/plan-tools.test.js`

Expected: PASS.

- [ ] **Step 6: Commit tool surface**

Commit message:

`feat: expose plan progress tools`

---

### Task 3: Live Plan Card MCP App

**Files:**
- Create: `dist/ui/plan-card.html`
- Create: `scripts/plan-card-static-gate.mjs`
- Modify: `dist/server.js`

**Interfaces:**
- Consumes: initial `structuredContent.plan` from start/mount.
- Consumes: `devspace_plan_status({ planId })` via widget-initiated tool calls.
- Produces: compact collapsed state, expanded checklist, elapsed time, current step counter, terminal state.

- [ ] **Step 1: Write the failing static gate**

The gate reads `dist/ui/plan-card.html` and asserts presence of:

- `devspace_plan_status`;
- `tools/call` or `window.openai.callTool` path;
- active polling interval and hidden-document backoff;
- terminal polling stop;
- `window.openai.widgetState` / `setWidgetState` presentation persistence;
- optional `requestDisplayMode` / PiP handling;
- host theme CSS variables such as `--color-text-primary`;
- no external third-party script or stylesheet dependency.

- [ ] **Step 2: Run static gate and verify red**

Run:

`node scripts/plan-card-static-gate.mjs`

Expected: FAIL because the card does not exist.

- [ ] **Step 3: Implement the self-contained plan card**

Build a small semantic card with:

- compact header: title, active/current step, `Step X / N`, elapsed time;
- disclosure button showing all steps;
- completed check, active pulse/spinner, pending dot;
- focus-visible and keyboard-accessible controls;
- host-theme CSS variables with light/dark-safe fallbacks;
- ~1.5 s visible polling / slower hidden polling;
- immediate refresh when widget regains visibility;
- optional PiP request for active plans with inline fallback;
- polling stop and completed presentation at terminal state.

Use no external asset dependency.

- [ ] **Step 4: Register the resource**

`dist/server.js` registers `ui://devspace/plan-card.html`, reads the static HTML from the package, and returns `RESOURCE_MIME_TYPE` plus the existing CSP metadata. It is registered regardless of `DEVSPACE_WIDGETS` because it is a dedicated progress feature, not a per-tool workspace card.

- [ ] **Step 5: Run the static gate**

Expected output:

`{"ok":true,"gate":"plan-card-static"}`

- [ ] **Step 6: Commit widget task**

Commit message:

`feat: add live plan progress card`

---

### Task 4: Codex-Style Model Instructions

**Files:**
- Modify: `dist/server.js`
- Create: `scripts/plan-instructions-static-gate.mjs`

**Interfaces:**
- Produces server instructions used by ChatGPT Classic Main conversations.

- [ ] **Step 1: Write failing instruction gate**

Assert server source/instruction text contains behavior equivalent to:

- use plans only for meaningful multi-step/long tasks;
- start once and reuse plan ID;
- exactly one in-progress step;
- mark current step complete before advancing;
- update before executing a scope pivot;
- do not repeat the full plan in prose because the card shows it;
- finish with all steps completed;
- never use user-facing plan cards inside Chat Swarm worker loops.

- [ ] **Step 2: Run gate and verify red**

Run:

`node scripts/plan-instructions-static-gate.mjs`

Expected: FAIL before instruction wiring.

- [ ] **Step 3: Add concise plan instruction block**

Add a dedicated plan instruction string in `serverInstructions(config)`. Keep it separate from Goal Mode and Context Continuity instructions so later features can evolve independently.

- [ ] **Step 4: Run instruction gate**

Expected output:

`{"ok":true,"gate":"plan-instructions-static"}`

- [ ] **Step 5: Commit instruction task**

Commit message:

`feat: teach main agents to maintain plans`

---

### Task 5: Integrate Verification and Acceptance

**Files:**
- Modify: `package.json`
- Create: `scripts/plan-progress-live-gate.mjs`
- Modify: `docs/chatgpt-coding-workflow.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Adds `verify:plan` and integrates it into `verify:ultra`.

- [ ] **Step 1: Add verification script**

`verify:plan` runs syntax checks plus `plan-runtime.test.js`, `plan-tools.test.js`, `plan-card-static-gate.mjs`, and `plan-instructions-static-gate.mjs`.

- [ ] **Step 2: Add a local live gate**

The live gate starts an isolated DevSpace server/state directory on a free loopback port, initializes MCP, calls plan start, performs a legal update, reads status, simulates restart with the same state directory, and mounts/reads the same plan revision. It must not require ChatGPT credentials or alter production state.

- [ ] **Step 3: Run plan verification**

Run:

`npm run verify:plan`

Expected: PASS.

- [ ] **Step 4: Run full static/regression verification**

Run the repository `verify:ultra` test sequence using the worktree dependency-resolution shim if required by the managed worktree environment. Expected: all existing and new gates PASS.

- [ ] **Step 5: Validate fixed edge remains healthy**

Run production read-only edge live gate from the unchanged production checkout. Expected health 200, MCP 401 challenge, metadata 200, private surface 404.

- [ ] **Step 6: Document behavior**

Document when DevSpace starts a plan, how the card updates/remounts, and that this feature is independent from Goal Mode and Context Guardian.

- [ ] **Step 7: Final commit**

Commit message:

`test: verify plan progress card end to end`

## Self-review

- Spec coverage: runtime, tools, render lifecycle, persistence, instructions, regression, and live restart recovery are all assigned to tasks.
- Placeholder scan: no TBD/TODO/future implementation placeholders are used in implementation steps.
- Type consistency: all tasks use the same four tool names, resource URI, statuses, and PlanRuntime interfaces.
- Scope: Goal Mode and Context Window remain explicitly excluded.
