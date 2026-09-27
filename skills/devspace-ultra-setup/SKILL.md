---
name: devspace-ultra-setup
description: Install, upgrade, repair, or expose DevSpace Ultra through the recommended DuckDNS/DDNS + Caddy route, with a Cloudflare named-tunnel fallback when direct inbound access is unavailable. Use this Skill when the user asks to set up DevSpace Ultra, Local Gateway, DDNS, DuckDNS, Caddy, OAuth, public MCP access, backend recovery, or a one-command installation.
---

# DevSpace Ultra guided setup

Use this Skill as an interactive installation and recovery runbook. The Agent executes every safe local command it can execute, verifies each result itself, and asks the user only for account, router, or physical-network actions that cannot be completed locally. Do not merely paste a long command and leave the user to diagnose it.

## Core product contract

- The primary client and product acceptance target is **ChatGPT Classic on Windows**.
- Codex may act as the installer or repair executor, but Codex is **not** the product client and a working Codex connection is never DevSpace Ultra acceptance.
- The core outcome is one OAuth-protected ChatGPT Classic MCP connection that exposes verified local development tools.
- One ChatGPT account may contain several DevSpace connections for different computers. Each installation needs its own DDNS/tunnel URL, persisted `serverInstanceId`, OAuth resource, and Connector entry. Never reuse or test another computer's DevSpace connection as acceptance for this machine.
- Long-context checkpoint, handoff and recovery can keep a project moving beyond one conversation's usable context. This is continuity, not a literal increase or bypass of model, account, rate or token limits; never advertise “unlimited tokens” as a technical entitlement.
- Local setup, DDNS, Caddy, health checks, optional Multi-Main, Goal/Rescue and extra capabilities are incomplete until the ChatGPT Classic MCP connection, OAuth and real read/write/reconnect tests pass.

## Mandatory order — never omit or silently reorder

Infrastructure checks are prerequisites, not the product goal. Resume at the earliest incomplete gate. If the public endpoint already passes external checks, go directly to ChatGPT Classic connection and OAuth; do not reopen the router, reinstall Caddy or redo DNS.

1. Inspect and preserve existing state.
2. Prepare or verify local Gateway/Core and the public OAuth-protected `/mcp` endpoint.
3. In **ChatGPT Classic**, enable Developer mode, create the exact MCP connection and complete OAuth.
   - Confirm the connection URL is this machine's exact public `/mcp` resource and its reported `serverInstanceId` matches this installation. A similarly named connection for another computer is a separate authority.
4. Scan or refresh the authenticated tool catalogue and verify all required development tools.
5. Enable the connection in a fresh ChatGPT Classic conversation.
6. Run a real read test.
7. Run an explicitly authorized disposable write/edit/command test and verify it on disk.
8. Reconnect or open another fresh Classic conversation and prove authenticated tools persist.
9. Report every gate as pass/fail. A missing or unverified row means installation is incomplete.

Follow [the canonical ChatGPT Classic MCP installation contract](../../docs/CHATGPT_CLASSIC_MCP_INSTALLATION.md) for exact evidence and failure boundaries.

## Operating rules

- Prefer **DuckDNS/DDNS + Caddy direct ingress**.
- Use a **stable Cloudflare named tunnel** only when the user has CGNAT, cannot forward ports, or has no usable DDNS route.
- Treat Worker-based Cloudflare relay traffic as quota-governed; never describe it as unlimited.
- Keep Gateway, Core, Blender MCP, and application ports loopback-only. Public exposure terminates at Caddy or the named tunnel.
- Never ask the user to paste a DuckDNS token, Cloudflare token, OAuth token, cookie, API key, or password into chat. Use a secure local prompt or a process-scoped environment variable, then clear it.
- Never write secrets to Git, `config.json`, logs, generated status JSON, shell history, Task Scheduler arguments, or progress narration.
- Do not impose a Core heap cap, workspace limit, MCP-session count limit, or work timeout. Production Core uses the system-managed heap profile.
- Keep `autoCompactEnabled=false`. Enable `goalRoundRecoveryEnabled=true` only when the installed release contains the exact-conversation page-composer recovery gate: one successful recovery per Goal round, no Primary repair, no window activation, no page navigation/reload, and duplicate conversations fail closed. Retain `DEVSPACE_GOAL_ROUND_RECOVERY=0` as the explicit operator hold.
- Use `devspace_progress_report` before substantive work on a multi-step setup and after each meaningful medium-sized setup step, not after every command and not only at the very end. The Local Gateway may reject a second substantive tool, stale-report continuation, or Plan completion with `devspace_progress_preflight_required`; when that happens, author the progress update yourself, verify the current conversation owns it, and retry the blocked operation.

## Prerequisite A — inspect before changing anything

1. Call `devspace_route` for the requested setup/repair outcome and follow the returned route chain.
2. Open the installed DevSpace Ultra package workspace when present.
3. Inspect:
   - Windows version and administrator availability;
   - Node.js and Git versions;
   - `DevSpace-Stable-Gateway` Scheduled Task;
   - listeners on 7678, 7688, and 7689;
   - `http://127.0.0.1:7678/healthz`;
   - active Core memory status;
   - current `publicBaseUrl`, state directory, heap profile, Auto Compact, and Goal Recovery flags;
   - Caddy/cloudflared availability;
   - current ingress provider and hostname without displaying credentials.
4. Preserve working state. Never delete OAuth databases, conversation authority, progress history, Blender runtime state, or session descriptors merely because setup is being reconciled.

Report the resulting baseline in natural language.

## Prerequisite B — choose the route using evidence

### DuckDNS/DDNS route

Use DuckDNS when all of the following are true:

- the user has or can create a DuckDNS hostname;
- the router has a publicly routable WAN address;
- TCP 80 and 443 can be forwarded to the DevSpace computer;
- the ISP is not blocking required inbound traffic.

Compare the router WAN address with an external public-address observation without printing the full address unnecessarily. A mismatch consistent with CGNAT means direct DDNS is unlikely to work.

The user must personally complete account actions on DuckDNS and router-administration actions. Guide one action at a time:

1. create/select a DuckDNS subdomain;
2. obtain the token without posting it in chat;
3. identify the DevSpace computer's stable LAN address;
4. reserve that LAN address in DHCP when practical;
5. explicitly approve the installer's UPnP request for TCP 80/443, or manually forward those ports to that LAN address;
6. confirm no other local service already owns those ports.

After each user action, re-run the relevant local or external verification instead of asking the user to guess whether it worked.

### Cloudflare fallback

Use a Cloudflare named tunnel when direct ingress is unavailable. The user completes Cloudflare account authorization and hostname/DNS selection. The Agent may install and configure `cloudflared`, register the Scheduled Task, and validate the tunnel locally.

Do not use an ephemeral Quick Tunnel as the production ChatGPT Connector URL. Explain that named-tunnel traffic and Cloudflare Worker execution are separate products; when a Worker relay is used, its requests count against the selected plan's current limits.

## Prerequisite C — install or reconcile local infrastructure

Prefer the installed tagged release's root `install.ps1`. For a fresh machine, download the tagged installer to a temporary file, allow inspection, and execute the file rather than piping remote text directly into `Invoke-Expression`.

For an **existing older DevSpace Ultra installation**, prefer the repository bootstrap updater instead of reinstalling over the live package in place. Older releases may not contain the updater yet, so download the current `update.ps1` once; after that migration the installed `devspace update` command and daily safe-update task own future upgrades:

```powershell
$r = irm 'https://api.github.com/repos/enwong93-sketch/devspace-ultra/releases/latest'
$a = @($r.assets | Where-Object name -eq 'update.ps1')[0]
if (-not $a) { throw 'Latest release has no update.ps1' }
$p = Join-Path $env:TEMP 'devspace-ultra-update.ps1'
iwr $a.browser_download_url -OutFile $p
$expected = ([string]$a.digest -replace '^sha256:','').ToLowerInvariant()
if ((Get-FileHash $p -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Updater checksum mismatch' }
& $p
```

The updater must resolve the latest stable GitHub Release, verify the archive digest, stage/validate before replacing the live package, preserve config/auth/conversation/runtime state, defer automatic runs while Agent/tool work is active, and restore the previous package plus npm shims if verification fails. Do not replace this with a blind `npm install -g ...` on an already-running production backend.

DuckDNS example:

```powershell
$p = Join-Path $env:TEMP 'devspace-ultra-install.ps1'
iwr 'https://raw.githubusercontent.com/enwong93-sketch/devspace-ultra/v0.5.17/install.ps1' -OutFile $p
& $p -Network DuckDNS
```

Cloudflare named-tunnel fallback:

```powershell
$p = Join-Path $env:TEMP 'devspace-ultra-install.ps1'
iwr 'https://raw.githubusercontent.com/enwong93-sketch/devspace-ultra/v0.5.17/install.ps1' -OutFile $p
& $p -Network Cloudflare -PublicHostname '<stable-hostname>'
```

The installer should:

- install/reconcile supported Node.js, Git, DevSpace Ultra, Caddy or cloudflared;
- install this Agent Skill for future repair/upgrade work;
- preserve compatible user state;
- set system-managed Core heap;
- register restartable Scheduled Tasks with no execution-time ceiling;
- configure DPAPI-protected provider credentials;
- start Local Gateway and wait for both Gateway and Core health;
- print remaining external actions clearly.

The Windows installer downloads one exact Release archive and verifies its SHA-256 digest before installation; it does not use a moving Git URL global npm install. After `--ignore-scripts`, it rebuilds and loads `better-sqlite3`. The maintained direct-ingress helper publishes the router WAN IPv4 explicitly to DuckDNS and never auto-detects a VPN egress. Require explicit user consent for UPnP; if the router is incompatible, use confirmed manual port forwarding with the router WAN IPv4. Existing standalone DuckDNS/Caddy tasks require one-time guarded adoption: export task definitions and Caddyfile first, reuse the existing Caddy path, prove the new ingress, then disable the old tasks rather than start a competing route.

If the installer fails, diagnose the newest launch-specific log section. Do not mix old OOM, EPERM, or ReferenceError entries into the current diagnosis merely because they remain in an append-only file.

## Final acceptance — follow the graph

A setup is not complete until all applicable checks pass:

1. `7678` Gateway health returns success.
2. Exactly one active Core responds on `7688` or `7689` with a system-managed heap limit.
3. Gateway and Core PID remain stable during a short soak.
4. No new fatal exception or OOM signature is written during that soak.
5. DuckDNS resolves to the intended public address, or the named tunnel reports connected.
6. HTTPS certificate validation succeeds.
7. `/.well-known/oauth-protected-resource/mcp` and the authorization-server metadata are reachable through the public hostname.
8. An unauthenticated `/mcp` request receives the expected OAuth challenge rather than a generic proxy error.
9. The ChatGPT Classic connection exists for the exact stable `/mcp` URL and OAuth is complete.
10. The authenticated catalogue contains `read`, `write`, `edit`, `apply_patch`, `exec_command`, `write_stdin`, and `devspace_progress_report`.
11. A fresh ChatGPT Classic conversation can run verified read, disposable write/edit/command and read-back calls.
12. A reconnect or second fresh conversation retains authenticated tool access without recreating the connection.
13. Secrets are absent from logs, config, Scheduled Task command lines, evidence and Git status.

Report a pass/fail table for every prerequisite and core gate, the stable MCP URL, the ChatGPT Classic connection name, the required tool names observed, and the read/write/reconnect evidence. Never claim end-to-end success based only on local health, schemas, Codex access or an OAuth callback page.

## Repair mode

When Local Gateway is degraded:

- identify whether 7678, the active Core port, or both are missing;
- distinguish a living degraded Gateway from a dead launcher;
- read only log bytes written after the current restart boundary;
- preserve the user-opened Blender processes and conversation state;
- use the authoritative `DevSpace-Stable-Gateway` task;
- validate source syntax and focused tests before restarting;
- restart once, then verify actual readiness;
- do not repeatedly reconnect ChatGPT or create new sessions while the backend is still unhealthy.

When an Agent lacks newly added tools but the backend has them, diagnose MCP tool-schema refresh and `notifications/tools/list_changed`; do not mislabel the capability server as offline.
