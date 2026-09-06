# DevSpace Ultra v0.5 — Retained Worktree Audit

> Date: 2026-09-07
> Scope: recovery and convergence of the v0.5 changes retained across interrupted ChatGPT/Codex agent sessions
> Release branch: `v0.5-convergence`

## 1. Safety boundary

No bulk deletion, `git reset --hard`, `git clean -fd`, or assumption that an untracked file is disposable was used.

Three independent local recovery points preserve the complete convergence history:

- `checkpoint/v0.5-pre-convergence-20260907` → `adc2e26e1f991cab926956c4fdf8b5540911abdb`
- all-files convergence checkpoint commit `51bc30c` on `v0.5-convergence`
- `checkpoint/v0.5-audited-20260907` → `4f2158705df02294a9a5b9753c7dc31a65ef57ab`

The first and third checkpoints were created with alternate Git indexes, so they did not alter the live index or working tree. The temporary all-files commit converted every retained file into tracked Git content before the history was split. The complete original and audited trees therefore remain recoverable even after the large checkpoint commit was replaced by coherent commits.

## 2. Inventory

The recovered worktree contained **159** unresolved paths:

| State | Count |
|---|---:|
| Modified tracked files | 41 |
| Previously untracked files | 118 |
| Staged before convergence | 0 |

Top-level distribution:

| Area | Count |
|---|---:|
| `dist/` | 83 |
| `scripts/` | 59 |
| `docs/` | 13 |
| Root files (`README`, `CHANGELOG`, `package.json`, `AGENTS.md`) | 4 |

There were no changed binary artifacts and no suspicious credential-like filenames. A bounded filename-only scan for private-key headers, common cloud keys, GitHub/OpenAI token forms, Bearer/JWT values returned no changed-file hits. All newly retained JavaScript/ESM files passed `node --check`; all newly retained PowerShell files passed the PowerShell parser.

## 3. Classification

### A. Runtime/tool/control-plane source — retain

These files implement or test the current Stable Gateway, Core lifecycle, bounded session/SSE registries, Capability Runtime, persistent tool-mode configuration, workspace LRU bounds, truthful progress feed, local ingress and runtime identity safety. They are active source or executable release gates, not generated output.

Representative groups:

- `dist/stable-gateway-*`
- `dist/mcp-sessions.js` and `dist/mcp-sessions.test.js`
- `dist/capability-runtime.js` and its test
- `dist/tool-mode.js` and its test
- `dist/workspaces.js`, `dist/workspaces-memory.test.js`
- `scripts/devspace-core-slot.mjs`, `scripts/devspace-stable-gateway*.{mjs,ps1}`
- `scripts/stable-gateway-*`, `scripts/tailscale-production-state-preflight.mjs`
- `scripts/devspace-live-progress-*`, `scripts/devspace-progress.mjs`
- `scripts/devspace-local-ingress.ps1`, `scripts/local-ingress-static-gate.mjs`
- modified Main/Worker identity/session-source scripts

### B. Classic conversation/Goal/Plan/safety source — retain

These files implement or verify native conversation authority, bounded CDP, delivery evidence, exact-usage research capture, zero-refresh recovery, conversation-bound Goal/Plan projection, Goal continuation/round recovery and progress integrity.

Representative groups:

- `dist/classic-*`
- `dist/context-guardian-*`
- `dist/goal-*`, `dist/plan-*`
- `dist/ui/goal-dock.html`, `dist/ui/plan-card.html`, `dist/ui/goal-continuation-relay.html`
- `scripts/classic-*`, `scripts/context-guardian-*`
- `scripts/goal-*`, `scripts/primary-debug-*`, `scripts/host-overlay-*`

### C. Architecture, plans and rolling evidence — retain

The authoritative framework, rolling handoff, design/implementation plans and operator safety documentation are durable development evidence. Old unchecked boxes are not used as the current execution queue; the canonical queue is `docs/superpowers/plans/2026-09-07-v0.5-release-completion-order.md`.

### D. Manual production/diagnostic gates not directly named in `package.json` — retain with explicit role

Twenty-four added paths were not directly named in `package.json`. They are explained below; none is an unexplained temporary artifact.

| Path/group | Classification |
|---|---|
| `AGENTS.md` | Repository-scoped execution/safety instruction |
| `dist/ui/goal-continuation-relay.html` | Runtime resource loaded by `dist/server.js` and Goal gates |
| New framework/safety/plan/spec Markdown files | Durable architecture and handoff evidence |
| `scripts/chat-classic-primary-debug.ps1` | Controlled canonical Main debug lifecycle helper |
| `scripts/classic-delivery-state-probe.mjs` | Bounded native delivery diagnosis |
| `scripts/classic-mcp-call-network-probe.mjs` | Bounded MCP/native network diagnosis |
| `scripts/core-memory-isolation-gate.mjs` | Required future full-Core memory phase |
| `scripts/devspace-live-progress-overlay.ps1` / `verify.ps1` | Installed user-facing progress surface and live verifier |
| `scripts/devspace-local-ingress.ps1` | Deferred but implemented local-ingress manager |
| `scripts/devspace-stable-gateway-startup.ps1` | Installed Scheduled Task entry point |
| `scripts/goal-host-bridge-memory-gate.mjs` | Host Bridge memory stress gate |
| `scripts/host-overlay-memory-stress.mjs` | Host Overlay memory stress gate |
| `scripts/migrate-tailscale-stable-gateway.mjs` | One-time/rollback-aware migration utility |
| `scripts/stable-gateway-core-exit-live-gate.ps1` | Production liveness acceptance helper |
| `scripts/tailscale-production-state-preflight.mjs` | Production-state compatibility preflight |
| `scripts/workspace-memory-stress.mjs` | Workspace-registry bounded-memory stress gate |

### E. Superseded mechanisms — neutralized, not silently deleted

Two recovered mechanisms encoded authority assumptions that the current framework forbids:

1. `dist/classic-conversation-identity.js` formerly accepted `openai/conversation_id` or camel-case MCP metadata as direct authority. It is now a fail-closed compatibility tombstone returning `null`; its test requires native request/session correlation.
2. `scripts/context-guardian-main-rollover-live-gate.mjs` formerly opened a fresh Chat and called that rollover acceptance. It is now an executable fail-closed tombstone explaining that fresh-conversation continuity is not true same-conversation Auto Compact. The Context Guardian static gate forbids reintroducing its old page/rollover behavior.

The original implementations remain recoverable from the checkpoint ref, but are no longer live acceptance mechanisms.

## 4. Test coverage gaps closed during convergence

The following retained tests existed but were not part of the normal full regression. Dedicated package gates now execute them:

- bounded shared `ClassicCdpClient` cleanup;
- retired direct-MCP conversation identity guard;
- bounded Classic delivery-evidence persistence;
- workspace-context LRU bound;
- stable public-session descriptor persistence without credentials.

These are included in `verify:ultra`, so a future agent cannot leave them as unexecuted orphan tests.

## 5. Commit convergence result

The all-files checkpoint was a recovery boundary, not the intended public history. The retained implementation is now separated into:

1. `f2dcee0` — `feat: add bounded stable gateway and tool substrate`
   - 61 files;
   - Stable Gateway/Core control plane, bounded MCP/SSE/workspace state, Capability Runtime/tool-mode/config, progress/local-ingress/runtime-identity operations.
2. `55ed6ba` — `feat: make Classic goals and context conversation-safe`
   - 83 files;
   - native conversation/session correlation, zero-refresh safety/recovery, Goal/Plan conversation state and projection, exact-usage evidence, truthful progress, Host Bridge and integration gates.
3. `docs: record v0.5 architecture and convergence evidence`
   - authoritative framework, operator documentation, implementation plans, rolling handoff, release order and this audit.

During the split, full `npm test` exposed a deterministic test-order race in `stable-gateway-liveness.test.js`: the test inspected session descriptors after replacement Core creation but before the recovery transaction had finished replay/invalidation. Production logic was not changed. The test now waits for `coreRecoveryInProgress=false`, the recovered active slot and `status.ok=true` before asserting the lazy-resurrection descriptor. Five consecutive focused runs and the complete regression then passed.

Every split was made only after full-tree checkpoints existed. The checkpoint refs remain local until release verification and remote push succeed.

## 6. Remaining known debt after this audit

- README, CHANGELOG, configuration and Classic safety documentation still contain superseded soft-reload, estimator/ledger, runtime-owner or fresh-chat compact wording. They must be corrected in the release documentation phase; their presence is now explicit rather than unexplained.
- Main Auto Compact remains unimplemented/unaccepted.
- Classic automation remains deliberately disabled in production until full-Core memory isolation and controlled full-feature deployment.
- Real native conversation binding, frontend lifecycle, delivery recovery and exact actual-usage gates remain pending.

This audit establishes that the former “large untracked tree” was predominantly interrupted but substantive work. It is now tracked on `v0.5-convergence`, recoverable from independent checkpoint refs, syntax-checked, security-screened at the changed-file level, included in normal regression where applicable, and assigned to a release subsystem or an explicit retired/deferred role. No unexplained generated or transient file remains in the convergence tree.
