---
name: devspace-ultra-setup
description: Install, upgrade, repair, or expose DevSpace Ultra through the recommended DuckDNS/DDNS + Caddy route, with a Cloudflare named-tunnel fallback when direct inbound access is unavailable. Use this Skill when the user asks to set up DevSpace Ultra, Local Gateway, DDNS, DuckDNS, Caddy, OAuth, public MCP access, backend recovery, or a one-command installation.
---

# DevSpace Ultra guided setup

Use this Skill as an interactive installation and recovery runbook. The Agent executes every safe local command it can execute, verifies each result itself, and asks the user only for account, router, or physical-network actions that cannot be completed locally. Do not merely paste a long command and leave the user to diagnose it.

## Operating rules

- Prefer **DuckDNS/DDNS + Caddy direct ingress**.
- Use a **stable Cloudflare named tunnel** only when the user has CGNAT, cannot forward ports, or has no usable DDNS route.
- Treat Worker-based Cloudflare relay traffic as quota-governed; never describe it as unlimited.
- Keep Gateway, Core, Blender MCP, and application ports loopback-only. Public exposure terminates at Caddy or the named tunnel.
- Never ask the user to paste a DuckDNS token, Cloudflare token, OAuth token, cookie, API key, or password into chat. Use a secure local prompt or a process-scoped environment variable, then clear it.
- Never write secrets to Git, `config.json`, logs, generated status JSON, shell history, Task Scheduler arguments, or progress narration.
- Do not impose a Core heap cap, workspace limit, MCP-session count limit, or work timeout. Production Core uses the system-managed heap profile.
- Keep `autoCompactEnabled=false`. Enable `goalRoundRecoveryEnabled=true` only when the installed release contains the exact-conversation page-composer recovery gate: one successful recovery per Goal round, no Primary repair, no window activation, no page navigation/reload, and duplicate conversations fail closed. Retain `DEVSPACE_GOAL_ROUND_RECOVERY=0` as the explicit operator hold.
- Use `devspace_progress_report` after each meaningful medium-sized setup step, not after every command and not only at the very end.

## Phase 1 — inspect before changing anything

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

## Phase 2 — choose the route using evidence

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
5. forward TCP 80 and 443 to that LAN address;
6. confirm no other local service already owns those ports.

After each user action, re-run the relevant local or external verification instead of asking the user to guess whether it worked.

### Cloudflare fallback

Use a Cloudflare named tunnel when direct ingress is unavailable. The user completes Cloudflare account authorization and hostname/DNS selection. The Agent may install and configure `cloudflared`, register the Scheduled Task, and validate the tunnel locally.

Do not use an ephemeral Quick Tunnel as the production ChatGPT Connector URL. Explain that named-tunnel traffic and Cloudflare Worker execution are separate products; when a Worker relay is used, its requests count against the selected plan's current limits.

## Phase 3 — install or reconcile

Prefer the installed tagged release's root `install.ps1`. For a fresh machine, download the tagged installer to a temporary file, allow inspection, and execute the file rather than piping remote text directly into `Invoke-Expression`.

DuckDNS example:

```powershell
$p = Join-Path $env:TEMP 'devspace-ultra-install.ps1'
iwr 'https://raw.githubusercontent.com/enwong93-sketch/devspace-ultra/v0.5.7/install.ps1' -OutFile $p
& $p -Network DuckDNS
```

Cloudflare named-tunnel fallback:

```powershell
$p = Join-Path $env:TEMP 'devspace-ultra-install.ps1'
iwr 'https://raw.githubusercontent.com/enwong93-sketch/devspace-ultra/v0.5.7/install.ps1' -OutFile $p
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

If the installer fails, diagnose the newest launch-specific log section. Do not mix old OOM, EPERM, or ReferenceError entries into the current diagnosis merely because they remain in an append-only file.

## Phase 4 — verify the full path

A setup is not complete until all applicable checks pass:

1. `7678` Gateway health returns success.
2. Exactly one active Core responds on `7688` or `7689` with a system-managed heap limit.
3. Gateway and Core PID remain stable during a short soak.
4. No new fatal exception or OOM signature is written during that soak.
5. DuckDNS resolves to the intended public address, or the named tunnel reports connected.
6. HTTPS certificate validation succeeds.
7. `/.well-known/oauth-protected-resource/mcp` and the authorization-server metadata are reachable through the public hostname.
8. An unauthenticated `/mcp` request receives the expected OAuth challenge rather than a generic proxy error.
9. The ChatGPT Connector completes OAuth and can call a harmless read-only DevSpace tool.
10. Secrets are absent from logs, config, Scheduled Task command lines, and Git status.

Report what was verified, what remains a user-owned external action, and the stable MCP URL. Never claim end-to-end success based only on a local `healthz` result.

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
