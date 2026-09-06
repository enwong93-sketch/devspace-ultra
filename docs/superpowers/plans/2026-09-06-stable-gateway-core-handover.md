# Stable Gateway / Core Handover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep DevSpace's public MCP/OAuth identity and public MCP sessions alive while an internal Core is verified, drained, replaced, replayed, or rolled back.

**Architecture:** A long-lived loopback Stable Gateway owns the public-facing local port and stable public session IDs. Internal Core A/B slots are private loopback servers; candidate verification uses disposable state, then a bounded handover barrier drains A, starts B on canonical state, replays sessions, and atomically switches mappings. Only one Core writes canonical JSON state at a time.

**Tech Stack:** Node.js 22+, native `http`/`fetch`, existing Express/MCP server, existing SQLite OAuth store, Node `assert` tests.

**Spec:** `docs/superpowers/specs/2026-09-06-stable-gateway-core-handover-design.md`

## Global Constraints

- ChatGPT Classic Chat mode only; no Work mode dependency.
- Production public origin remains `https://devspace-gateway.tail18e977.ts.net` during Core reload.
- Never run two active stateful Cores concurrently against the same JSON-backed state directory.
- Candidate verification never mutates canonical state.
- Public MCP session IDs and OAuth identity are Gateway-owned and survive Core replacement.
- Replay bearer credentials are memory-only and must never be logged or persisted.
- Existing 7676/7677/7678 processes are untouched during source-only implementation and ephemeral-port tests.
- Do not resume `goal_deac9fadb6bc67dd` automatically.
- The repository has pre-existing uncommitted v0.5 work; do not reset or overwrite unrelated changes. Commit steps are intentionally omitted until the existing dirty-tree ownership is resolved.

---

### Task 1: Gateway Session Registry and Drain Barrier

**Files:**
- Create: `dist/stable-gateway-runtime.js`
- Create: `dist/stable-gateway-runtime.test.js`

**Interfaces:**
- Produces: `StableGatewaySessionRegistry` with `registerInitialize`, `lookup`, `acquire`, `release`, `markInitialized`, `beginBarrier`, `waitForDrain`, `commitMappings`, `abortBarrier`, `snapshotPublic`.
- Public snapshots must contain no authorization header/token or raw initialize body.

- [x] **Step 1: Write failing tests** for stable public/backend ID translation, active request accounting, barrier admission, all-or-nothing mapping commit, and secret-free status snapshots.
- [x] **Step 2: Run** `node dist/stable-gateway-runtime.test.js` and verify the tests fail because the runtime module/API does not exist.
- [x] **Step 3: Implement the minimal registry/state machine** with an in-memory `Map`, per-session active request count, a barrier promise, and atomic mapping replacement after validating every proposed mapping.
- [x] **Step 4: Run** `node dist/stable-gateway-runtime.test.js` and verify all Task 1 tests pass.

### Task 2: Transparent MCP Proxy with Stable Public Session IDs

**Files:**
- Create: `dist/stable-gateway-proxy.js`
- Create: `dist/stable-gateway-proxy.test.js`

**Interfaces:**
- Consumes: `StableGatewaySessionRegistry`.
- Produces: `createStableGatewayProxy({ activeCore, publicBaseUrl, registry, requestTimeoutMs })` and `setActiveCore(core)`.
- Core descriptor: `{ id, baseUrl }` where `baseUrl` is loopback HTTP only.

- [x] **Step 1: Write failing integration tests** with two fake loopback Core servers. Initialize must return a Gateway-generated public `Mcp-Session-Id`, while the fake Core sees/returns a different backend ID.
- [x] **Step 2: Add a failing session-bound request test** proving the Gateway rewrites the public ID to A's backend ID and rewrites response headers back to the public ID.
- [x] **Step 3: Add a failing streaming test** proving an SSE/streamable response body is piped rather than buffered to completion.
- [x] **Step 4: Run** `node dist/stable-gateway-proxy.test.js` and confirm expected RED failures.
- [x] **Step 5: Implement native HTTP proxying** with hop-by-hop header filtering, body streaming, session header translation, request acquire/release accounting, and no token logging.
- [x] **Step 6: Run** both Task 1 and Task 2 tests and verify GREEN.

### Task 3: Session Replay and Atomic Core Promotion

**Files:**
- Modify: `dist/stable-gateway-runtime.js`
- Modify: `dist/stable-gateway-proxy.js`
- Modify: `dist/stable-gateway-runtime.test.js`
- Modify: `dist/stable-gateway-proxy.test.js`

**Interfaces:**
- Produces: `replaySessionsToCore(core)` returning a complete tentative mapping set without mutating live mappings.
- Produces: `promoteCore(core, { drainTimeoutMs })` that closes admission, waits for active requests to drain, replays all sessions, atomically commits mappings, switches active Core, and reopens admission.

- [x] **Step 1: Write a failing replay test**: initialize on A, replay to B, keep the same public session ID, and use B's new backend session ID afterwards.
- [x] **Step 2: Write a failing drain test** that holds one A request open and proves promotion does not commit until the request releases.
- [x] **Step 3: Write a failing atomicity test** where the second of two session replays fails; verify no session mapping moves to B.
- [x] **Step 4: Implement replay using the stored initialize request and in-memory authorization value.** Replay `notifications/initialized` only for sessions that observed it on A.
- [x] **Step 5: Implement the bounded admission barrier and atomic promotion.**
- [x] **Step 6: Run Task 1-3 tests and verify GREEN with no secret material in assertions/logs.**

### Task 4: Candidate Identity / Schema Gate

**Files:**
- Create: `dist/stable-gateway-candidate.js`
- Create: `dist/stable-gateway-candidate.test.js`

**Interfaces:**
- Produces: `probeCandidate({ coreBaseUrl, publicBaseUrl, bearerToken, expectedSchemaFingerprint })`.
- Produces: deterministic `schemaFingerprint(toolsList)` that excludes unstable ordering while preserving tool names/input schemas/annotations.

- [x] **Step 1: Write failing tests** for health mismatch, protected-resource mismatch, issuer mismatch, schema mismatch, and successful compatibility.
- [x] **Step 2: Run** `node dist/stable-gateway-candidate.test.js` and verify RED.
- [x] **Step 3: Implement candidate probes** for `/healthz`, OAuth metadata, MCP initialize, and `tools/list`; hash a canonicalized schema representation.
- [x] **Step 4: Verify GREEN** and add the test to `verify:edge-static`/`verify:ultra` only after it is independently green.

### Task 5: Core A/B Process Coordinator and Rollback

**Files:**
- Create: `scripts/devspace-core-slot.mjs`
- Create: `scripts/devspace-stable-gateway.mjs`
- Create: `scripts/stable-gateway-handover-gate.mjs`
- Modify: `scripts/devspace-fixed-backend.mjs`
- Modify: `scripts/devspace-fixed-backend-reload.mjs`
- Modify: `scripts/fixed-edge-static-gate.mjs`
- Modify: `package.json`

**Interfaces:**
- `devspace-stable-gateway.mjs` owns the externally targeted loopback port.
- Core slot helper starts candidate/active Core on private ports with explicit config/state/public-base settings.
- Reload helper sends a local authenticated/loopback-only handover request to Gateway; it never stops the Gateway process.

- [ ] **Step 1: Write failing static/integration gates** requiring reload to target Gateway handover rather than Scheduled Task stop/start.
- [ ] **Step 2: Implement candidate slot startup** using disposable state and explicit `DEVSPACE_CONFIG_DIR`.
- [ ] **Step 3: Implement active-slot startup** against canonical state only after the previous active Core is drained/stopped.
- [ ] **Step 4: Implement rollback**: if active B startup or replay fails, restart A on canonical state, replay sessions to A, and reopen admission.
- [ ] **Step 5: Run the ephemeral handover gate** on non-production ports and prove A->B success, B failure rollback, and no public listener PID change.

### Task 6: Config/OAuth Regression Integration

**Files:**
- Modify: `dist/config.test.js`
- Modify: `dist/user-config.js`
- Modify: `dist/config.js`
- Modify: `scripts/fixed-edge-static-gate.mjs`
- Modify: `scripts/devspace-fixed-backend.mjs`

**Interfaces:**
- JSON config/auth readers accept one leading UTF-8 BOM.
- Default OAuth scopes are `['devspace', 'offline_access']` unless explicitly overridden.
- Fixed Core retains the launcher's explicit `DEVSPACE_CONFIG_DIR`.

- [x] **Step 1: Add BOM regression assertion and verify RED.**
- [x] **Step 2: Strip a leading BOM in `readJsonFile` and verify GREEN.**
- [x] **Step 3: Add default OAuth scope assertion and verify RED.**
- [x] **Step 4: Add `offline_access` to the default scope set and verify GREEN.**
- [x] **Step 5: Add config-ownership static assertions and verify RED.**
- [x] **Step 6: Preserve `DEVSPACE_CONFIG_DIR: files.dir` in Core child environment and verify GREEN.**

### Task 7: Verification and Canary Migration Gate

**Files:**
- Modify: `package.json`
- Modify: `docs/configuration.md`
- Modify: `docs/classic-chat-safety.md`
- Modify: current v0.5 handoff after acceptance.

- [ ] **Step 1: Run focused tests** for stable gateway, config, OAuth, MCP sessions, Goal, Plan, Context Guardian, Host Overlay, and Stream Recovery.
- [ ] **Step 2: Run** `npm test` and record exact result.
- [ ] **Step 3: Start Stable Gateway + A/B Cores on ephemeral canary ports** and run real initialize/tools-list/replay/reload/rollback tests.
- [ ] **Step 4: Verify production 7676/7677/7678 PIDs remain unchanged during canary.**
- [ ] **Step 5: Only after canary passes, migrate the WSL Tailscale Funnel target to the Stable Gateway and verify public `/healthz`, `/mcp` 401 challenge, OAuth metadata, DCR/authorize/token/refresh.**
- [ ] **Step 6: Read `goal_deac9fadb6bc67dd` and `plan_dfc1ea0e2b285119` through the new Gateway; verify the Goal is still paused at round 3 and Plan step 10 remains in progress. Do not resume it.**
- [ ] **Step 7: Reload only a Core through Gateway and prove the ChatGPT App stays connected without OAuth re-authorization.**
- [ ] **Step 8: Proceed to the existing Main-01/02/03 real Classic Chat frontend acceptance only after the control-plane gate is green.**
