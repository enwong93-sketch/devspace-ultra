# Multi-Main Zero-Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `open another Main` a one-command agent UX that creates/opens Main-02+ as independent signed-in user-facing ChatGPT Classic runtimes without repeated manual login or Worker lifecycle ownership.

**Architecture:** Keep the existing `interactive` role and shared AppX provisioner. Add a source-pool authenticator that first seeds from any verified signed-in CDP Main/Worker, then falls back to a controlled Main-01 snapshot/restart path only when necessary, and finally uses the bounded OAuth relay only when no signed-in local source exists. Add high-level Main lifecycle/window orchestration and preserve canonical Main-01-only `chatgpt://` ownership.

**Tech Stack:** PowerShell, Node.js CDP/WebSocket, Windows AppX, ChatGPT Classic, existing DevSpace MCP tool registration.

**Spec:** `docs/superpowers/specs/2026-09-04-multi-main-zero-login-design.md`

## Global Constraints

- Main-01 is canonical Primary and the only global `chatgpt://` owner.
- Main-02..32 are `InteractiveNN` / `DevSpaceInteractive`, visible in app list, with independent profile/process/window.
- Interactive runtimes never enter Worker controller, Worker autojoin, elastic scaling, update rollout, recovery/minimize loops, or managed Auto Compact.
- Prefer zero-interruption signed-in sources; controlled Main-01 restart is permitted only when needed to satisfy zero-login UX.
- Any controlled Main-01 restart must restore and verify Main-01 before the operation can be reported successful.
- No cookie/OAuth secret material may be logged or persisted by DevSpace.
- OAuth relay is the final cold-start fallback, not the normal path.
- Final live acceptance creates Main-03 or later without asking the user to sign in again.

---

### Task 1: Generalized Interactive source discovery

**Files:**
- Create: `scripts/chat-classic-session-source.ps1`
- Modify: `scripts/chat-classic-interactive-runtime.ps1`
- Modify: `scripts/interactive-runtime-static-gate.mjs`

**Interfaces:**
- `Get-InteractiveSessionSources -TargetMainNumber N` returns ordered candidates with `Role`, `Label`, `DebugPort`, `ProfilePath`, `Running`, `SignedIn`, `Method`.
- Priority: signed-in Interactive CDP Main → signed-in Worker CDP → canonical Main-01 profile snapshot.

- [ ] Write failing static/unit expectations for source priority and exclusion of target runtime.
- [ ] Verify RED.
- [ ] Implement source discovery using existing CDP signed-in probes and package identity rules.
- [ ] Verify GREEN and no Worker-controller mutation.

### Task 2: CDP-to-CDP seed for secondary Main

**Files:**
- Reuse: `scripts/chat-swarm-classic-session-seed.mjs`
- Modify: `scripts/chat-classic-interactive-runtime.ps1`
- Modify: `scripts/interactive-runtime-static-gate.mjs`

**Interfaces:**
- `Seed-InteractiveFromCdpSource(Source, Target)` launches/uses target CDP, invokes existing in-memory allowlisted cookie transfer, verifies target composer, and returns non-secret aggregate state.

- [ ] Write failing tests asserting the Interactive manager calls the existing CDP seed helper before filesystem seeding/OAuth.
- [ ] Verify RED.
- [ ] Implement minimal source/target seed path and target verification.
- [ ] Verify GREEN.

### Task 3: Controlled Main-01 profile snapshot fallback

**Files:**
- Create: `scripts/chat-classic-primary-snapshot.ps1`
- Modify: `scripts/chat-classic-interactive-runtime.ps1`
- Modify: `scripts/chat-swarm-classic-auth-seed.mjs`
- Modify: `scripts/interactive-runtime-static-gate.mjs`

**Interfaces:**
- `Invoke-ControlledPrimarySnapshot(TargetProfile, VerifyTimeoutSeconds)` records Main-01 package/window state, closes only canonical Primary, waits for profile unlock, copies encrypted session state to target, relaunches canonical Primary, verifies visible signed-in composer/window, and returns `PrimaryRestored=true` or fails closed.

- [ ] Write failing tests for use only after all zero-interruption sources are unavailable/source-locked.
- [ ] Write failing tests that Primary restore failure prevents Main-ready result.
- [ ] Verify RED.
- [ ] Implement targeted Primary close/unlock/snapshot/relaunch/verify sequence without touching secondary Mains or Workers.
- [ ] Verify GREEN and no secret output.

### Task 4: One-command create/open lifecycle orchestration

**Files:**
- Create: `scripts/chat-classic-main-orchestrator.ps1`
- Modify: `dist/chat-swarm-classic-runtime.js`
- Modify: `scripts/interactive-runtime-static-gate.mjs`

**Interfaces:**
- New MCP surface: `chat_main_runtime_open` with optional `mainNumber`; omitted number selects the lowest free Main >=2.
- Also expose lifecycle actions for `show`, `minimize`, `stop`, and all-status without changing Worker tools.

- [ ] Write failing registration/static tests for `chat_main_runtime_open` and free-number selection.
- [ ] Verify RED.
- [ ] Implement orchestration by delegating AppX/setup/auth to existing manager; do not duplicate provisioning logic.
- [ ] Implement selected-window show/restore/minimize by package executable identity, not process name alone.
- [ ] Verify GREEN.

### Task 5: Update existing setup semantics and docs

**Files:**
- Modify: `scripts/chat-classic-interactive-runtime.ps1`
- Modify: `docs/runtime-identity.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `dist/chat-swarm-classic-runtime.js`

**Interfaces:**
- `setup` normal success states identify source/provisioning mode such as `cdp-session-seed`, `primary-controlled-snapshot`, `verified-existing-session`, `oauth-relay`.
- `Main01Unchanged` remains meaningful only for paths that do not restart Primary; controlled-snapshot path reports explicit `PrimaryRestarted`, `PrimaryRestored`, before/after PID/window evidence.

- [ ] Write failing static expectations replacing the obsolete “never restart Main-01” policy.
- [ ] Verify RED.
- [ ] Update implementation/descriptions/docs to the approved policy.
- [ ] Verify GREEN.

### Task 6: Canonical `chatgpt://` repair

**Files:**
- Modify: `scripts/chat-swarm-classic-runtime-identity.ps1`
- Modify: `scripts/runtime-identity-static-gate.mjs`
- Modify: `docs/runtime-identity.md`

**Interfaces:**
- Supported repair path may open/drive Windows Default Apps UI or use supported registered-app activation; it must never forge protected `UserChoice` hash.
- Acceptance: `ProtocolCanonical=true`, `WorkerIsolationSafe=true`, `InteractiveIsolationSafe=true`.

- [ ] Add failing/static test that direct protected UserChoice edits remain forbidden and canonical repair surface exists.
- [ ] Verify RED.
- [ ] Implement supported repair/activation flow with read-back verification.
- [ ] Verify GREEN.

### Task 7: Main-03 live zero-login gate

**Files/state:** live ChatGPT Classic packages/processes.

- [ ] Capture Main-01/Main-02/Worker baseline PIDs/windows/login states.
- [ ] Call high-level `chat_main_runtime_open` without manual login; select Main-03 if free.
- [ ] Verify independent package/profile/PID/window and signed-in composer.
- [ ] Verify source mode is CDP seed when an already signed-in secondary Main is available.
- [ ] Restart only Main-03 and verify signed-in persistence on a new PID.
- [ ] Exercise show/restore/minimize/stop/restart on Main-03.
- [ ] Verify Main-01/Main-02 remain healthy and Workers/Auto Compact/Swarm never own Main-03.
- [ ] Run runtime identity audit and protocol-canonical gate.

### Task 8: Full Multi-Main release verification

- [ ] Run `npm run verify:runtime-identity`.
- [ ] Run `npm run verify:ultra`.
- [ ] Run `git diff --check`.
- [ ] Run package dry-run and assert all required role/auth/orchestration scripts ship; temp scratch/handoff files do not.
- [ ] Run secret/personal-path scan.
- [ ] Record fresh live evidence in changelog/docs.
