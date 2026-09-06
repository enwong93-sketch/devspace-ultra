# ChatGPT Coding Workflow

DevSpace brings a Codex-style coding-agent loop to ChatGPT and other MCP hosts:
inspect the repo, follow local instructions, make scoped edits, run
verification, and show the user what changed.

## Open One Workspace

ChatGPT should call `open_workspace` once for a project folder:

```json
{
  "path": "~/work/my-project"
}
```

The result includes a `workspaceId`. All later file, search, edit, show-changes,
and shell calls should reuse that same `workspaceId`.

Do not reopen the same folder unless:

- the `workspaceId` is rejected as unknown
- the user switches to another folder
- the user switches between checkout and worktree mode
- the user explicitly asks to reopen

## Checkout Mode

Checkout mode is the default. DevSpace opens the actual directory:

```json
{
  "path": "~/work/my-project"
}
```

Use this when the user wants ChatGPT to work in the current checkout.

## Worktree Mode

Use worktree mode for isolated parallel work:

```json
{
  "path": "~/work/my-project",
  "mode": "worktree"
}
```

Managed worktrees are created under:

```text
~/.devspace/worktrees
```

Worktree mode requires a Git repository with at least one commit. It starts from
`HEAD` unless `baseRef` is provided.

Uncommitted source checkout changes are not copied into the managed worktree.
DevSpace reports when the source checkout was dirty so the model can decide how
to proceed with the user.

## Project Instructions

When a workspace opens, DevSpace loads root-level instruction files:

- `AGENTS.md`
- `AGENTS.MD`
- `CLAUDE.md`
- `CLAUDE.MD`

Nested instruction files are returned as `availableAgentsFiles`. The model
should read the relevant nested file before working under that directory.

This keeps instructions explicit and inspectable instead of silently injecting
new context during later tool calls.

## Skills

Skills are enabled by default for coding-agent workflows.

DevSpace discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.devspace/skills`

It also keeps compatibility with:

- the bundled `subagent-delegation` skill when `DEVSPACE_SUBAGENTS=1`, unless `~/.devspace/skills/subagent-delegation/SKILL.md` exists
- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

When Subagents are enabled, DevSpace discovers agent profiles
from `~/.devspace/agents/*.md` and project `.devspace/agents/*.md`.
`open_workspace` exposes a compact catalog with profile names, descriptions,
providers, and optional models/thinking levels so the model can choose a configured agent
without seeing provider-specific launch details.

Example profiles are packaged under `examples/agents/` for users who want
starter templates. Copy or adapt them into one of the active profile directories
before use.

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

When `open_workspace` returns matching skills, the model should read the
advertised `SKILL.md` before following that skill.

Skill paths may be outside the workspace. DevSpace only permits reading:

- advertised `SKILL.md` files
- files under a skill directory after that skill's `SKILL.md` has been read

Set `DEVSPACE_SKILLS=0` to hide skills from workspace output. Set
`DEVSPACE_SUBAGENTS=1` to expose the experimental subagent catalog and
`subagent-delegation` skill. That skill teaches the minimal
`devspace agents ls`, `devspace agents run`, and `devspace agents show`
workflow. The catalog comes from `open_workspace`; `devspace agents ls` lists
existing subagent sessions for that workspace.

## Tool Names

DevSpace exposes these tool names:

- `open_workspace`
- `read`
- `write`
- `edit`
- `bash`

By default, DevSpace also runs in `DEVSPACE_TOOL_MODE=minimal`, so dedicated
`grep`, `glob`, and `ls` tools are hidden. Use `bash` with command-line tools
such as `rg`, `find`, and `ls` for search and directory inspection.

Use `DEVSPACE_TOOL_MODE=full` to restore dedicated search and directory tools.

The strict Codex-style surface is enabled with `DEVSPACE_TOOL_MODE=codex`. It exposes:

- `open_workspace`
- `read`
- `apply_patch`
- `exec_command`
- `write_stdin`

In this mode, `write`, `edit`, `bash`, `grep`, `glob`, and `ls` are not
registered. `exec_command` returns a process session ID when a command is still
running after its yield window. Use `write_stdin` to poll it, send input, resize
a PTY, or send Ctrl-C. Set `tty: true` only for commands that need a terminal.

For DevSpace Ultra production use, `DEVSPACE_TOOL_MODE=ultra` is the compatibility
superset. It exposes the Codex-style tools above together with `write`, `edit`,
`bash`, `grep`, `glob`, and `ls`. Prefer `apply_patch` and `exec_command` for new
agent workflows; retain the legacy aliases for ChatGPT clients with cached tool
schemas and for non-Codex agents. Never repeat one operation through both tool
families.

## Show Changes

By default, `DEVSPACE_WIDGETS=off`.

In that mode, DevSpace does not attach Apps iframe UI to workspace/file/edit/shell
tools, so repetitive cards such as `Ran command` do not appear. Tool execution
and model-readable results are unchanged.

Use `DEVSPACE_WIDGETS=changes` to expose only the aggregate show-changes flow,
or `DEVSPACE_WIDGETS=full` to opt back into per-tool widget cards.

When `show_changes` is exposed, models should call it exactly once after the
final file modification in any turn that changes files. The tool only requires
the `workspaceId`; DevSpace automatically compares against the last shown
checkpoint and advances that checkpoint after rendering the aggregate diff.

## Plan Progress Card

For genuinely multi-step or long-running interactive work, DevSpace exposes a
Codex-style persistent execution plan. `devspace_plan_start` creates the plan and
mounts one compact live progress card. Later `devspace_update_plan` calls mutate
backend state only, so advancing a step does not add a new card to the
conversation.

The card refreshes the backend-authoritative state through
`devspace_plan_status`, shows the current step and `Step X / N`, and can expand
to show the full checklist. Active cards request picture-in-picture when the
ChatGPT host supports it so progress can remain visible near the active
conversation; unsupported hosts stay inline. `devspace_plan_mount` re-mounts an
existing plan after an interrupt, later turn, or renderer reload without
creating a replacement plan.

Active plans keep exactly one `in_progress` step. Existing pending work must
become `in_progress` before it can become `completed`, completed steps cannot
regress, and a completed plan is immutable. Plan state is persisted under the
DevSpace state directory and survives backend restarts. Chat Swarm worker loops
do not mount user-facing plan cards.

This plan runtime is independent from Goal Mode and Context Guardian. Goal
continuation and context compaction are separate harness features rather than
implicit behaviors of the progress card.

## Goal Mode

Goal Mode is a separate persistent harness for outcomes that need to continue
across ordinary ChatGPT Classic assistant turns. `devspace_goal_start` stores an
immutable final objective plus explicit success criteria and mounts one compact
Goal Dock. A Plan can be used underneath the Goal as the current execution
route, but completing a Plan does not complete the Goal.

Each physical Goal turn remains a normal user-visible ChatGPT turn. The agent
does meaningful work and verifies progress, then calls
`devspace_goal_turn_report` as the final **tool call** immediately before its
visible final round report. After that tool returns it emits exactly one complete
visible final response and calls no more tools in that physical turn.

If the Goal remains active, the fresh zero-visual Relay for that report calls
app-only `devspace_goal_continuation(action="dispatch")`. The backend owns the
continuation lease and `ClassicGoalHostBridge` locates the matching Chat-mode
Goal widget by `goalId`, then invokes ChatGPT Classic's raw native hidden Tool
follow-up transport. The next turn begins by redeeming that continuation with
`devspace_goal_round_begin`. Public background widget
`window.openai.sendFollowUpMessage` is deliberately not used because third-party
Chat-mode widgets require synchronous user activation. The backend bridge keeps
the native hidden-follow-up semantics without typing into the composer or
inserting a synthetic user message into the visible transcript.

Goal completion requires evidence for every stored success criterion. A Goal
cannot be marked blocked until the runtime has observed three consecutive
reported rounds with the same normalized blocker and no meaningful progress.
The Goal Dock provides Pause, Resume, and Stop controls; pause/stop should not be
used by the model unless the user explicitly requests them. Continuation leases
are persisted and tolerate renderer reloads, send/ack races, bounded lease
expiry, duplicate redemption attempts, and backend restart.

The Goal Dock uses `devspace_goal_status` to refresh authoritative backend
state and owns Pause/Resume/Stop only. Resume arms one backend `dispatch`;
ordinary round-to-round dispatch comes from the fresh per-round Relay.
`devspace_goal_continuation` is app-only and is not exposed to the model. The
single persistent Goal Dock is not duplicated across rounds; the tiny Relay is
expected once per reported round.

Secondary Main runtimes already expose deterministic CDP ports. Canonical
Main-01 uses port 9721 when debug-enabled. `ClassicPrimaryDebugGuard` protects an
already-running long-lived Main-01 when the backend first starts, then repairs
only a fresh startup or later changed PID lacking 9721. The repair targets only
the canonical package, uses an expected-PID race guard, keeps debug access bound
to loopback, does not modify Windows `chatgpt://` ownership, and has a normal
canonical-app restore fallback. Chat Swarm worker loops remain backend-only and
do not start or mount user-facing Goal Mode.

Goal Mode still does not solve ChatGPT Classic context-window exhaustion. Main
Context Guardian / Auto Compact v2 is a separate later subsystem.

## Shell Use

The shell tool is for commands that belong in a terminal:

- tests
- builds
- git inspection
- package scripts
- environment checks

File writes should go through the edit/write tools rather than shell
redirection, heredocs, `tee`, `sed -i`, or generated scripts.
