# DevSpace Plan Progress Card Design

## Goal

Add a Codex-style, backend-authoritative multi-step plan runtime to ChatGPT Classic through DevSpace Ultra, with one live progress card for long tasks that remains useful across tool calls, turns, server restarts, and card remounts.

## Scope

This feature implements only the execution plan / step card layer.

In scope:

- Persistent structured plan state owned by the DevSpace backend.
- One current plan with ordered steps and statuses `pending`, `in_progress`, and `completed`.
- Exactly one `in_progress` step while an active plan still has unfinished work.
- Timely state transitions: an existing `pending` step cannot jump directly to `completed`; it must be `in_progress` first.
- A render-once MCP Apps card that reads the backend state and refreshes itself without remounting on every update.
- Recovery/remount of the same plan after an interrupt, renderer reload, or later turn.
- Plan persistence across DevSpace backend restarts.
- Main-conversation instructions that make the model use and maintain the plan for non-trivial multi-step work.
- Explicit exclusion of Chat Swarm worker conversations from user-facing plan cards.

Out of scope:

- Goal Mode, success criteria, autonomous cross-turn continuation, and completion audit.
- Context-window accounting, model-specific token budgets, context compaction, and conversation rollover.
- Hiding ChatGPT Classic's native `Called tools` / tool activity renderer.
- Full-screen DevSpace Workbench, browser, terminal, or file editor surfaces.

## Product behavior

For a non-trivial task that benefits from a plan, the model starts one plan and receives a stable `planId`. The first call also mounts a compact progress card. The card shows the task title, current step, `Step X / N`, elapsed time, and an expandable full checklist.

Subsequent plan updates mutate only backend state. They do not attach an output template and therefore do not create a new widget for every step change. The existing card polls the read-only plan-status tool from inside the MCP App and updates in place.

If the existing card is no longer visible or its iframe is recreated, the model may call the read-only mount tool with the same `planId`. The backend is the source of truth, so the re-mounted card renders the latest revision.

When every step is completed, the plan becomes terminal, the card stops polling, and the completed state remains reviewable in the transcript.

## Plan state contract

A persisted plan contains:

```json
{
  "id": "plan_<opaque>",
  "title": "Repair DevSpace continuity",
  "status": "active",
  "revision": 3,
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "completedAt": null,
  "lastExplanation": "Context accounting is now verified.",
  "steps": [
    { "id": "step_<opaque>", "text": "Inspect current accounting", "status": "completed" },
    { "id": "step_<opaque>", "text": "Implement model-aware budget", "status": "in_progress" },
    { "id": "step_<opaque>", "text": "Run rollover soak gate", "status": "pending" }
  ]
}
```

Rules:

- 2–12 steps per plan.
- Step text is concise and bounded.
- An active plan with unfinished work has exactly one `in_progress` step.
- All-completed steps imply `status=completed` and set `completedAt`.
- A completed plan is immutable; new work starts a new plan.
- Existing step IDs are stable across updates when the caller supplies them.
- A matched existing `pending` step may transition to `in_progress`, but not directly to `completed`.
- A completed step cannot regress. A genuine scope replacement must be represented as a new step ID.

## MCP tool surface

### `devspace_plan_start`

Model-facing, mutating, idempotent=false. Creates a new plan and attaches the plan-card UI resource. Input: title and initial steps. Output: full public plan state.

### `devspace_update_plan`

Model-facing, mutating, no UI resource. Replaces the current ordered step set for one plan, preserving supplied step IDs, increments revision, and validates state transitions.

### `devspace_plan_status`

Read-only and callable by both model and MCP App. Returns one plan by ID. It has no UI resource.

### `devspace_plan_mount`

Read-only model-facing render tool. Returns the latest plan state and attaches the same plan-card resource so a stale/lost card can be re-mounted without creating a new plan.

## UI architecture

Register one dedicated resource:

`ui://devspace/plan-card.html`

The resource is independent of `DEVSPACE_WIDGETS`. The existing `DEVSPACE_WIDGETS=off` default continues to suppress noisy per-file/per-command workspace cards.

The plan card is a small, self-contained HTML/CSS/JS MCP App using ChatGPT host CSS variables when available. It follows a restrained Codex/Linear-style developer-tool language: neutral surfaces, one accent for active state, minimal borders, compact typography, and no decorative dashboard chrome.

The card:

- Renders from the initial `structuredContent.plan`.
- Calls `devspace_plan_status` from the widget every ~1.5 seconds while active and visible; it backs off when the document is hidden.
- Stops polling once completed.
- Keeps expand/collapse preference in widget state only; business state stays server-side.
- Requests picture-in-picture opportunistically only as a progressive enhancement for active long work. Failure falls back to inline without affecting execution.
- Returns to an inline/completed presentation when the plan becomes terminal when the host supports that transition.
- Degrades safely if `window.openai` optional extensions are missing.

## Persistence

`PlanRuntime` stores plan state under the configured DevSpace `stateDir`, separate from Chat Swarm and Context Continuity state. Persistence uses a serialized write queue so rapid model updates cannot interleave file writes.

Corrupt or unsupported state fails open with a fresh plan store and a warning; it must not prevent DevSpace boot.

## Model instruction behavior

DevSpace server instructions tell interactive/main conversations:

- Use a plan for genuinely multi-step or long-running work, not trivial one-step tasks.
- Start once, then keep the same plan current.
- Mark the current step completed before moving to the next.
- Keep exactly one `in_progress` step while unfinished.
- Update the plan before execution when scope changes.
- Do not repeat the entire plan in prose after each update; the card already presents it.
- Finish with every step completed or explicitly replace the plan if the user's objective changed.
- Chat Swarm workers must not mount user-facing plan cards or emit user-facing plan progress.

## Acceptance gates

1. Runtime unit tests prove persistence, revisioning, transition invariants, completion, and restart recovery.
2. Static server tests prove the four tools are registered with the intended UI/visibility metadata and only start/mount attach the plan card.
3. Widget static gate proves the plan resource contains the status tool call, active polling, terminal stop, host-theme variables, and optional PiP fallback.
4. `verify:ultra` includes the new plan tests.
5. Fixed-edge live verification remains green after the feature is integrated.
6. A ChatGPT Classic live gate starts a 3-step plan, verifies the card renders, updates step 1 → 2 without creating a second render tool call, and confirms a re-mounted card sees the latest revision.

## Design references

- OpenDesign functional skill: `frontend-design`.
- OpenDesign system: `linear-app`, adapted to ChatGPT host theme variables rather than copying brand colors.
- OpenAI MCP Apps guidance: decouple data/mutation tools from render tools; widget state is not durable business state; server storage owns cross-session data; PiP is appropriate for ongoing activity.
- Codex `update_plan` behavior: plan state is structured, user-visible, and must stay current; exactly one step is in progress during active work.
