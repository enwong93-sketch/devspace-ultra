# DevSpace Stable Gateway / Core Handover Design

**Date:** 2026-09-06
**Scope:** DevSpace Ultra v0.5 fixed public ingress and Core reload continuity for ChatGPT Classic Chat mode.

## Goal

Make the public DevSpace MCP/OAuth identity independent from the lifetime of any one Core process. A Core reload must not change the public URL, OAuth issuer, MCP resource identity, or force the ChatGPT App to reconnect/re-authorize.

## Existing failure

The current fixed backend binds the public edge target directly to a Core process. `reload:fixed-backend` stops that process and starts another one. The Core owns the MCP transport/session registry, so replacement destroys live MCP sessions. In addition, the fixed-backend launcher can select edge parameters from one `DEVSPACE_CONFIG_DIR` and then silently delete that variable before spawning Core, causing config/auth/state ownership to diverge.

The Tailscale bootstrap proved the ingress itself is healthy, but its isolated state directory cannot see the existing paused Goal and Plan held by the current fixed backend.

## Constraints

- ChatGPT Classic Chat mode only; no Work mode dependency.
- Public ingress for production is the WSL Tailscale Funnel hostname `https://devspace-gateway.tail18e977.ts.net`.
- Cloudflare Worker is removed from the normal request hot path; legacy configuration remains untouched until migration acceptance passes.
- The public URL, OAuth issuer, protected resource URL, and DCR identity must stay constant across Core reloads.
- Existing Goal/Plan state must not be duplicated into a competing live writer.
- Never run two active stateful Cores concurrently against the same JSON-backed state directory.
- No synthetic user turn, auto-navigation, or paused-Goal resume is permitted as part of reload/reconnect.
- A failed candidate or session replay must roll back without changing public identity.
- Existing 7676/7677/7678 processes must not be terminated during source-only development/canary tests.

## Architecture

### 1. Long-lived Stable Gateway

A dedicated Node process owns the local port targeted by Tailscale Funnel. It is the only process whose lifetime is coupled to the public ingress.

The Gateway proxies OAuth discovery, DCR, authorize/token/revoke, health, MCP assets, browser-control bridge endpoints, and `/mcp` to the currently active Core. It never changes the externally visible origin.

### 2. Internal Core slots

Core A and Core B listen only on loopback internal ports. Both are configured with the same external `DEVSPACE_PUBLIC_BASE_URL`, so generated OAuth/resource metadata always names the Gateway public origin rather than an internal port.

Only one Core is active against the canonical state directory at a time.

### 3. Candidate verification without shared-state writes

Before a reload, the replacement slot starts in candidate mode against a disposable snapshot/candidate state directory. Candidate verification checks:

1. `/healthz` is healthy.
2. OAuth protected-resource metadata names the fixed public resource.
3. Authorization-server metadata names the fixed public issuer and endpoints.
4. MCP initialize succeeds with the expected protocol.
5. `tools/list` produces a deterministic schema fingerprint compatible with the current active Core.
6. Required state files can be parsed and the state schema/version is compatible.

The candidate is not exposed to user traffic and does not run background Context Guardian, Host Overlay, Goal recovery, Stream Recovery, or Chat Swarm polling against canonical state.

### 4. Gateway-owned public MCP sessions

The Gateway does not expose a backend Core session ID directly. For each client MCP initialize it creates a stable public session ID and records, in memory only:

- public session ID;
- active Core slot;
- backend Core session ID;
- sanitized initialize request body required for replay;
- whether the initialized notification was observed;
- the current bearer credential needed to replay to the replacement Core, retained only in memory and never logged/persisted;
- active request count and last activity time.

Incoming `Mcp-Session-Id` headers are translated public -> backend before proxying; backend response IDs are translated back to the stable public ID.

### 5. Handover barrier

A reload uses a bounded admission barrier:

1. Start and verify candidate B.
2. Close Gateway admission for new MCP work while keeping the public HTTP listener alive; incoming MCP requests wait behind a bounded in-memory barrier instead of seeing the port disappear.
3. Wait until all active A requests reach zero.
4. Gracefully stop A so it can no longer mutate canonical state.
5. Start B in active mode against canonical state.
6. Re-verify health/public identity.
7. Replay each live public MCP session's initialize handshake into B and obtain a new backend session ID. Replay the initialized notification when required.
8. Atomically replace all public-session backend mappings with B mappings.
9. Open admission and release queued requests to B.
10. Retire the candidate/snapshot artifacts.

This provides A/B slotting without concurrent stateful writers.

### 6. Rollback

If candidate verification fails, A remains untouched and the Gateway never closes admission.

If active B startup, identity verification, or session replay fails after A has stopped, the Gateway starts A from canonical state, replays public sessions back into A, reopens admission, and reports the B failure. Public URL and OAuth identity never change.

### 7. Configuration ownership

The fixed-backend/Core launcher must preserve the explicit config directory chosen by the launcher. Silent `delete childEnv.DEVSPACE_CONFIG_DIR` is forbidden.

The config/auth/state preflight must report whether the chosen config directory has the owner auth material needed by Core before any live restart. Production migration must not depend on an accidental fallback to `~/.devspace`.

### 8. OAuth behavior

Default supported scopes are `devspace` and `offline_access`. Discovery advertises the configured scopes, authorization accepts them, token issuance returns rotating refresh tokens, and refresh/revocation remain backed by SQLite.

UTF-8 JSON readers accept an optional BOM; writers continue to emit UTF-8 without BOM.

## Data-flow invariants

- Public origin is a Gateway property, never a Core slot identity.
- Public MCP session IDs are Gateway identities and survive Core replacement.
- Backend session IDs are private implementation details.
- Canonical state has exactly one active Core writer.
- Candidate verification never mutates canonical state.
- Gateway session/auth replay material is memory-only and omitted from logs/status output.
- A handover either completes all session mappings or rolls back; partial mapping commits are forbidden.

## Error handling

- Candidate health/schema/public-identity mismatch: abort before barrier.
- Drain timeout: reopen admission on A and abort.
- B startup failure: restart/retain A and reopen admission.
- Any replay failure: discard all tentative B mappings, restore A mappings through replay, then reopen admission.
- Gateway crash is a separate failure domain; Core reload code must never intentionally restart Gateway.

## Testing

### Unit tests

- Public/backend session ID translation.
- Active-request accounting and drain barrier.
- Atomic session mapping replacement.
- Candidate schema/public-identity comparison.
- Rollback when one session replay fails.
- Sensitive replay credentials never appear in status/log structures.

### Integration tests

Use fake ephemeral loopback Core A/B servers:

1. Initialize through Gateway and confirm a stable public session ID.
2. Make a session-bound request and prove it reaches A with A's backend session ID.
3. Promote B and prove the same public session ID reaches B with a newly replayed backend session ID.
4. Force candidate mismatch and prove A remains active.
5. Force replay failure and prove rollback restores A.
6. Hold an in-flight A request during promotion and prove B switch waits for drain.

### Product acceptance

After source tests pass, deploy through a non-production canary port first. Only then migrate the Tailscale Funnel target to Stable Gateway. Validate ChatGPT DCR/authorize/token/refresh, reload Core without App reconnect, confirm the existing paused Goal/Plan remains visible and unchanged, and finally run Main-01/02/03 Chat-mode frontend acceptance.
