# Fixed MCP Edge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a permanent ChatGPT-facing MCP URL that survives reboots, uses the existing Tailscale Funnel as origin transport, and requires no temporary Quick Tunnel or repeated connector recreation.

**Architecture:** A Cloudflare Worker on a fixed `workers.dev` URL proxies only the DevSpace MCP/OAuth/public asset surface to the existing fixed Tailscale Funnel origin. DevSpace persists the Worker URL as `publicBaseUrl` while preserving the Tailscale hostname in `allowedHosts`; OAuth stays entirely in DevSpace. Backend OAuth authorization codes become handover-safe, and public Express errors become generic.

**Tech Stack:** Node.js ESM, Cloudflare Workers Fetch API, Wrangler, Express 5, MCP SDK OAuth router, better-sqlite3, Windows PowerShell/Tailscale startup.

**Spec:** `docs/superpowers/specs/2026-09-04-fixed-mcp-edge-design.md`

## Global Constraints

- Fixed public URL must not change across reboot or normal backend restart.
- Quick Tunnel is diagnostic-only and must not be required in steady state.
- Tailscale Funnel remains the fixed origin transport.
- Worker must be fixed-origin, not an open proxy.
- Worker must never proxy Browser Control bridge endpoints or arbitrary local routes.
- OAuth redirects must be returned to the client without edge-side redirect following.
- No Owner password, bearer token, OAuth code, refresh token, Cloudflare API token, or raw Authorization header may be persisted/logged by new code.
- Configuration changes must preserve unrelated `~/.devspace/config.json` fields.
- No public release/tag/push until fixed-edge, OAuth-handover, Express-error, Multi-Main, package, secret-scan, and live connector gates all pass.

---

### Task 1: Deterministic fixed-origin Worker proxy

**Files:**
- Create: `edge/cloudflare-worker/src/index.js`
- Create: `edge/cloudflare-worker/src/index.test.js`
- Create: `edge/cloudflare-worker/wrangler.jsonc`
- Modify: `package.json`

**Interfaces:**
- Consumes: `env.ORIGIN_BASE_URL: string`.
- Produces: `proxyRequest(request: Request, env: { ORIGIN_BASE_URL: string }, fetchImpl?: typeof fetch): Promise<Response>` and default Cloudflare Worker `{ fetch() }`.

- [ ] **Step 1: Write failing tests for allowed MCP/OAuth forwarding**

Create tests that assert `/mcp`, OAuth metadata, `/authorize`, `/token`, `/register`, `/revoke`, `/mcp-app-assets/*`, and `/` are forwarded to the configured origin with method/query/body and MCP/Authorization headers preserved, while upstream `Location` and `WWW-Authenticate` are returned unchanged.

- [ ] **Step 2: Write failing tests for denied non-MCP surfaces**

Assert `/browser-control/bridge/*`, `/healthz/private`, arbitrary `/foo`, and traversal-like paths return edge `404` without calling `fetchImpl`.

- [ ] **Step 3: Write failing redirect test**

Assert the proxy invokes `fetchImpl` with `redirect: "manual"` and returns an upstream `302` instead of following it.

- [ ] **Step 4: Run tests and verify RED**

Run: `node edge/cloudflare-worker/src/index.test.js`
Expected: failure because `index.js` does not yet exist.

- [ ] **Step 5: Implement minimal Worker proxy**

Implement a fixed allowlist, fixed `ORIGIN_BASE_URL`, path/query preservation, hop-by-hop/forwarding-header stripping, streaming request/response forwarding, and manual redirects. Do not inspect OAuth tokens or body contents.

- [ ] **Step 6: Run Worker tests and syntax checks**

Run: `node --check edge/cloudflare-worker/src/index.js && node edge/cloudflare-worker/src/index.test.js`
Expected: PASS.

- [ ] **Step 7: Add Worker gate to `verify:ultra`**

Add deterministic syntax/test commands to package scripts.

### Task 2: Fixed-edge config/deployment orchestration

**Files:**
- Create: `dist/edge-cloudflare.js`
- Create: `dist/edge-cloudflare.test.js`
- Modify: `dist/cli.js`
- Modify: `dist/config.js`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces CLI:
  - `devspace edge status`
  - `devspace edge cloudflare setup --origin <https-url> [--name <worker-name>]`
  - `devspace edge cloudflare verify`
  - `devspace edge disable`
- Persists non-secret config fields: `publicBaseUrl`, `allowedHosts`, `edgeProvider`, `edgeOriginBaseUrl`, `edgePublicBaseUrl`, `edgeWorkerName`.

- [ ] **Step 1: Write failing config tests**

Tests must prove setup-plan generation preserves all unrelated config fields, adds both Worker and origin hostnames, rejects non-HTTPS/open-proxy origins, and does not mutate persisted config before verification.

- [ ] **Step 2: Write failing status tests**

Status formatter must distinguish `fixed`, `temporary`, `direct`, and `misconfigured` public-base states without printing credentials.

- [ ] **Step 3: Verify RED**

Run: `node dist/edge-cloudflare.test.js`
Expected: FAIL before implementation.

- [ ] **Step 4: Implement orchestration module**

Implement pure helpers for config planning/status plus a Wrangler deploy adapter that invokes Wrangler without shell interpolation, injects `ORIGIN_BASE_URL`, captures the deployed `workers.dev` URL from output, and never prints deployment credentials.

- [ ] **Step 5: Extend CLI**

Route `edge` subcommands to the orchestration module and update help. `setup` verifies origin health/discovery, Wrangler auth/deploy, fixed edge challenge/metadata, then persists config atomically only after pre-commit verification.

- [ ] **Step 6: Run tests and full config regression**

Run: `node dist/edge-cloudflare.test.js && node dist/config.test.js`
Expected: PASS.

### Task 3: Handover-safe OAuth authorization codes

**Files:**
- Modify: `dist/db/migrations.js`
- Modify: `dist/oauth-store.js`
- Modify: `dist/oauth-provider.js`
- Create or modify: `dist/oauth-provider.test.js`
- Modify: `package.json`

**Interfaces:**
- `SqliteOAuthStore.saveAuthorizationCode(...)`
- `SqliteOAuthStore.getAuthorizationCode(hash/code-id)`
- `SqliteOAuthStore.consumeAuthorizationCode(...)`
- Authorization code remains one-time, client-bound, PKCE-bound, resource-bound, and expires after five minutes.

- [ ] **Step 1: Write failing persistence/replay test**

Issue a code with provider instance A, close it, instantiate provider B against the same state DB, exchange the code successfully once, then assert replay fails.

- [ ] **Step 2: Verify RED**

Run the dedicated OAuth provider test and confirm the process-local `Map` loses the code.

- [ ] **Step 3: Add SQLite authorization-code table migration/store methods**

Persist only the code identifier/hash plus required client/scopes/redirect/resource/PKCE metadata and expiry; never log the raw code.

- [ ] **Step 4: Replace process-local code map with persistent one-time consumption**

`authorize()` stores the record; `challengeForAuthorizationCode()` reads it; `exchangeAuthorizationCode()` consumes atomically only after validation.

- [ ] **Step 5: Verify GREEN and replay protection**

Run dedicated test plus `node --check` on provider/store/migrations.

### Task 4: Generic public Express errors

**Files:**
- Modify: `dist/server.js`
- Create or modify: `dist/server.test.js`
- Modify: `package.json`

**Interfaces:**
- Public malformed JSON/error responses contain stable generic JSON fields and request ID only.
- Logs may contain bounded internal error class/message but not response stack/local filesystem paths.

- [ ] **Step 1: Write failing malformed-JSON regression**

Start a local server/test harness, POST malformed JSON, and assert response body does not contain `C:\\Users`, package paths, stack frames, or HTML Express error page.

- [ ] **Step 2: Verify RED**

Confirm current body-parser path leaks stack/HTML.

- [ ] **Step 3: Add terminal error middleware**

Return generic JSON for externally visible errors, with correct 4xx/5xx status and no stack/path.

- [ ] **Step 4: Verify GREEN**

Run server regression and existing suite.

### Task 5: Fixed-edge live-gate script

**Files:**
- Create: `scripts/fixed-edge-live-gate.mjs`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Inputs: fixed public edge URL and optional origin URL via args/env.
- Output: non-secret JSON summary only.

- [ ] **Step 1: Write static expectations into deterministic gate/tests**

Gate checks public `/mcp` 401 challenge, PRM resource identity, OAuth issuer/token/register hosts, origin/local health, and rejects temporary `trycloudflare.com` as production fixed mode.

- [ ] **Step 2: Implement live gate**

Do protocol-level probes only; never print Owner password or bearer material.

- [ ] **Step 3: Add `verify:edge` script**

Keep network live gate separate from offline `verify:ultra` while syntax/static checks stay in `verify:ultra`.

### Task 6: Deploy the permanent Worker on this machine

**Files/state:**
- Cloudflare Worker control plane
- `~/.devspace/config.json`
- Existing `~/.devspace/Start-DevSpace-Stack.ps1` is preserved unless a startup fix is actually required.

- [ ] **Step 1: Verify Wrangler authentication**

Run `npx wrangler whoami`. If the existing API token cannot enumerate/deploy, use one-time `wrangler login`; complete browser authorization through the already-paired Browser Control session if possible.

- [ ] **Step 2: Deploy generic Worker with origin set to the fixed Tailscale base URL**

Use worker name `devspace-ultra-mcp-edge` unless unavailable; capture actual fixed `workers.dev` URL.

- [ ] **Step 3: Verify edge before config commit**

Probe edge `/mcp`, PRM, authorization metadata, and blocked `/browser-control/bridge/*` behavior. Confirm redirect manual behavior with an OAuth authorization request.

- [ ] **Step 4: Persist fixed publicBaseUrl/allowedHosts**

Preserve all unrelated DevSpace config fields and record origin/public edge metadata.

- [ ] **Step 5: Restart only DevSpace backend via handover**

Do not touch Main-01/Main-02. Confirm metadata now advertises fixed Worker identity while Worker still reaches Tailscale origin.

### Task 7: ChatGPT and reboot-style acceptance

**Files/state:** ChatGPT custom app, normal Windows startup stack.

- [ ] **Step 1: Create production connector on fixed Worker `/mcp`**

Use a production name distinct from the temporary CF Canary. Complete Owner-password OAuth once if required.

- [ ] **Step 2: Execute real DevSpace tool call through fixed connector**

Open workspace and run a harmless read-only command; record success evidence.

- [ ] **Step 3: Backend handover reconnect gate**

Replace only backend PID and confirm same connector/fixed URL reconnects and can invoke a tool without connector recreation.

- [ ] **Step 4: Startup-path gate**

Verify `DevSpace-Tailscale-Autostart.cmd`/`Start-DevSpace-Stack.ps1` still starts 7676 and refreshes Tailscale Funnel; confirm no Quick Tunnel is required and fixed edge recovers when origin returns.

- [ ] **Step 5: Stop diagnostic Quick Tunnel**

Remove the temporary CF Canary from the steady-state dependency path after the permanent connector is proven.

### Task 8: Full edge release verification

**Files:** all above.

- [ ] **Step 1: Run focused suites**

Run Worker, edge orchestration, OAuth provider, server error, config, and fixed-edge static tests.

- [ ] **Step 2: Run `npm run verify:ultra`**

Expected: exit 0, no failures.

- [ ] **Step 3: Run `git diff --check` and package dry-run**

Confirm edge files are included and no temp logs/Quick Tunnel artifacts are packaged.

- [ ] **Step 4: Run secret/personal-path scan**

No Cloudflare tokens, Owner password, OAuth codes/tokens, or contributor-specific fixed hostnames/account IDs may be committed.

- [ ] **Step 5: Record evidence in changelog/docs**

Document the permanent edge live gate and recovery behavior without secrets.
