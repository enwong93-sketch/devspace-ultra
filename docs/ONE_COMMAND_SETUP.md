# DevSpace Ultra one-command setup

DevSpace Ultra uses a tagged Windows installer to install the package, create the Local Gateway/Core supervisor, write a user-local configuration, and configure one selected ingress route. Local health is **not** proof that a public ChatGPT Connector works.

The product target is **ChatGPT Classic—not Codex**. Infrastructure installation is followed immediately by the mandatory [ChatGPT Classic MCP connection, OAuth and read/write/reconnect workflow](CHATGPT_CLASSIC_MCP_INSTALLATION.md). Codex can execute setup commands but is never substitute acceptance. Continuity features do not alter OpenAI token, context, usage or rate limits.

For an **existing** installation, use the transactional updater instead of reinstalling over the running global package. Builds old enough not to contain `devspace update` can bootstrap the current updater once from the latest stable GitHub Release; the updater verifies the release digest, stages the new package before replacement, migrates legacy package/task paths, preserves user state and rolls the old package/shims back if post-swap verification fails. After migration, `devspace update` and the daily safe-update task handle future stable releases automatically and defer while non-stream Agent/tool work is active.

```powershell
$r=irm https://api.github.com/repos/enwong93-sketch/devspace-ultra/releases/latest
$a=$r.assets | Where-Object name -eq 'update.ps1' | Select-Object -First 1
if (-not $a -or -not $a.digest) { throw 'Stable release updater/digest unavailable.' }
$p=Join-Path $env:TEMP 'devspace-ultra-update.ps1'
iwr $a.browser_download_url -OutFile $p
if ((Get-FileHash $p -Algorithm SHA256).Hash.ToLowerInvariant() -ne ([string]$a.digest).Replace('sha256:','').ToLowerInvariant()) { throw 'Updater digest mismatch.' }
& $p
```

Fresh-install `install.ps1` also detects an older official installation and routes it through this updater before reconciling Local Gateway/ingress configuration. If legacy `DevSpace-Ultra-DuckDNS` or `DevSpace-Ultra-Caddy` tasks exist, interactive setup asks for a one-time `MIGRATE` confirmation (or requires explicit `-MigrateLegacyIngress` for unattended setup). It exports those task definitions, reuses the existing Caddyfile when one is present, verifies the maintained ingress, and only then disables the old tasks. It does not start a competing Caddy task while the old entry is still unverified.

## Install the guided Agent Skill first

DuckDNS account creation, router login, WAN/CGNAT checks, and port forwarding cannot be completed safely by a generic unattended command. Install the packaged Skill first so the Agent can execute all local steps and guide those external actions interactively:

```powershell
$p=Join-Path $env:TEMP 'devspace-ultra-install-skill.ps1'
iwr https://raw.githubusercontent.com/enwong93-sketch/devspace-ultra/v0.5.22/install-skill.ps1 -OutFile $p
& $p
```

Then ask the Agent to **use `devspace-ultra-setup` to install or repair DevSpace Ultra**. The normal root installer also installs or updates this Skill automatically.

## Recommended route: DuckDNS/DDNS direct to the local machine

Run the following from a normal PowerShell window. The installer requests elevation only for the machine-level operations that need it. It prompts before requesting router UPnP mappings for TCP 80/443; declining makes **no router change** and stops before public ingress setup.

```powershell
$p=Join-Path $env:TEMP 'devspace-ultra-install.ps1'; iwr https://raw.githubusercontent.com/enwong93-sketch/devspace-ultra/v0.5.22/install.ps1 -OutFile $p; & $p -Network DuckDNS
```

The installer prompts for the DuckDNS subdomain and token. The token is protected with Windows DPAPI for the current user; it is not written to `config.json`, Task Scheduler arguments, logs, or Git. It then:

1. verifies or installs a supported Node.js and Git;
2. downloads the exact GitHub Release `.tgz`, verifies its SHA-256 digest, installs it, rebuilds `better-sqlite3`, and proves the native binding loads;
3. creates the Stable Gateway task with no execution-time ceiling;
4. keeps the Core on system-managed heap sizing;
5. identifies a physical LAN interface and obtains the router WAN IPv4, never a VPN exit IP;
6. checks router mappings and requests TCP 80/443 UPnP mappings only after explicit consent, without replacing unrelated mappings;
7. updates DuckDNS with that explicit router WAN IPv4 and installs LAN-bound Caddy with a public MCP/OAuth allowlist;
8. opens the local firewall only for the selected LAN interface and starts the maintained ingress task;
9. waits for real Gateway and Core health, then reports public Connector acceptance as **pending**.

Rerunning the same route reuses an existing DPAPI token unless a new process-scoped token is supplied. An old standalone DuckDNS/Caddy task is **not** silently replaced by the maintained ingress task; the task XML and Caddyfile are backed up under the selected config directory before guarded adoption.

Direct DDNS requires a publicly routable router WAN address and inbound TCP 80/443. If the router does not support UPnP or returns an ambiguous UPnP error, configure both forwards manually to this computer and run with `-ManualPortForward -PublicWanIPv4 '<router WAN IPv4>'`. The manual switch never requests a router mapping; the address must come from the router WAN page, not a VPN-based "what is my IP" site. If the ISP uses CGNAT or inbound forwarding is unavailable, use the Cloudflare fallback. In either mode, prove the HTTPS/OAuth endpoint from an independent external network and then complete ChatGPT Connector OAuth, `tools/list`, and a real write-capable tool call before calling setup complete.

## Cloudflare fallback

Create a stable named Cloudflare Tunnel route to `http://127.0.0.1:7678`, then run:

```powershell
$env:DEVSPACE_CLOUDFLARE_TUNNEL_TOKEN = '<one-time tunnel token>'
$p=Join-Path $env:TEMP 'devspace-ultra-install.ps1'
iwr https://raw.githubusercontent.com/enwong93-sketch/devspace-ultra/v0.5.22/install.ps1 -OutFile $p
& $p `
  -Network Cloudflare `
  -PublicHostname 'devspace.example.com'
Remove-Item Env:DEVSPACE_CLOUDFLARE_TUNNEL_TOKEN
```

The token is immediately converted to a user-bound DPAPI secret. The scheduled runner decrypts it into a short-lived ACL-restricted token file and deletes that file when `cloudflared` exits.

Cloudflare fallback must not be described as unlimited. A deployment that passes requests through Cloudflare Workers is subject to the request allowance of the selected Workers plan, including a daily request quota on the Free plan. Check the current official limits before deployment. DevSpace therefore defaults to DuckDNS direct ingress and avoids unnecessary polling or synthetic MCP traffic.

Quick Tunnels are suitable for temporary diagnostics, not the persistent ChatGPT connector URL. Use a named tunnel and stable hostname for production.

## Non-interactive automation

Set secrets in process-scoped environment variables and pass the remaining values explicitly:

```powershell
$env:DEVSPACE_DUCKDNS_TOKEN = '<token>'
$p=Join-Path $env:TEMP 'devspace-ultra-install.ps1'
iwr https://raw.githubusercontent.com/enwong93-sketch/devspace-ultra/v0.5.22/install.ps1 -OutFile $p
& $p `
  -Network DuckDNS `
  -DuckDnsDomain 'your-own-subdomain.duckdns.org' `
  -AllowedRoot "$HOME" `
  -EnableRouterUpnp `
  -NonInteractive
Remove-Item Env:DEVSPACE_DUCKDNS_TOKEN
```

`-EnableRouterUpnp` is the explicit authorization for a non-interactive router mapping request. The public default exposes only the selected workspace root, not every drive. Add further roots deliberately after installation.

The on-disk compatibility directory may still be named `.devspace-tailscale-bootstrap` on upgraded installations. That name is retained so existing OAuth, state, and Scheduled Task migrations remain lossless; it does **not** make Tailscale the public ingress route. New public routing follows the explicit `-Network DuckDNS`, `-Network Cloudflare`, or `-Network Local` selection.

## Release integrity

Every tagged GitHub release contains the exact `install.ps1` used by the tagged raw URL, an npm-compatible `.tgz` archive, and `SHA256SUMS.txt`. Inspect the script and compare the archive checksum before installation when the machine is used for sensitive work.

## Safe feature defaults

The public setup enables Local Gateway, plugin/Skill routing, progress overlay, Context Guardian, stream recovery, and exact-conversation Goal recovery. Normal Goal continuation follows the native completed assistant turn: an active, incomplete Goal queues one hidden next round without a manual bind, report or completed Plan. Interrupted-turn Rescue is separate and may send one verified `- 繼續` for an interrupted episode; hidden Goal recovery must not race that episode or inject a visible user message. Both preserve the exact conversation and computer, never navigate to another chat or use another Connector as fallback. Repeated Core replacement must retain Rescue's original episode and clocks. `Auto Compact` remains disabled until its separate acceptance is complete. Operators can temporarily hold Goal recovery with `DEVSPACE_GOAL_ROUND_RECOVERY=0` without pausing or rebinding the Goal. Local health, a passed test suite or one operator-assisted rescue does not establish stable Classic end-to-end acceptance.
