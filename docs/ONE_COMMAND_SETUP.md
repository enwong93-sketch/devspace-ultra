# DevSpace Ultra one-command setup

DevSpace Ultra uses one elevated Windows setup pass to install the package, create the Local Gateway/Core supervisor, write a user-local configuration, register restartable Scheduled Tasks, and configure one public ingress route.

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

Fresh-install `install.ps1` also detects an older official installation and routes it through this updater before reconciling Local Gateway/ingress configuration.

## Install the guided Agent Skill first

DuckDNS account creation, router login, WAN/CGNAT checks, and port forwarding cannot be completed safely by a generic unattended command. Install the packaged Skill first so the Agent can execute all local steps and guide those external actions interactively:

```powershell
$p=Join-Path $env:TEMP 'devspace-ultra-install-skill.ps1'
iwr https://raw.githubusercontent.com/enwong93-sketch/devspace-ultra/v0.5.8/install-skill.ps1 -OutFile $p
& $p
```

Then ask the Agent to **use `devspace-ultra-setup` to install or repair DevSpace Ultra**. The normal root installer also installs or updates this Skill automatically.

## Recommended route: DuckDNS/DDNS direct to the local machine

Run the following from a normal PowerShell window. The installer requests elevation only for the machine-level operations that need it.

```powershell
$p=Join-Path $env:TEMP 'devspace-ultra-install.ps1'; iwr https://raw.githubusercontent.com/enwong93-sketch/devspace-ultra/v0.5.8/install.ps1 -OutFile $p; & $p -Network DuckDNS
```

The installer prompts for the DuckDNS subdomain and token. The token is protected with Windows DPAPI for the current user; it is not written to `config.json`, Task Scheduler arguments, logs, or Git. It then:

1. verifies or installs a supported Node.js and Git;
2. installs DevSpace Ultra from GitHub;
3. creates the Stable Gateway task with no execution-time ceiling;
4. keeps the Core on system-managed heap sizing;
5. creates a five-minute DuckDNS updater;
6. installs/configures Caddy for HTTPS and reverse-proxies to `127.0.0.1:7678`;
7. opens local firewall ports 80/443;
8. starts the backend and waits for real Gateway and Core health.

Running the command again is idempotent for the same route. Existing DPAPI secrets are replaced only when a new token is supplied or entered.

Direct DDNS requires a publicly routable address and router forwarding for TCP 80 and 443. Router administration cannot be performed safely and portably by a generic installer. When the ISP uses CGNAT or inbound forwarding is unavailable, use the Cloudflare fallback.

## Cloudflare fallback

Create a stable named Cloudflare Tunnel route to `http://127.0.0.1:7678`, then run:

```powershell
$env:DEVSPACE_CLOUDFLARE_TUNNEL_TOKEN = '<one-time tunnel token>'
$p=Join-Path $env:TEMP 'devspace-ultra-install.ps1'
iwr https://raw.githubusercontent.com/enwong93-sketch/devspace-ultra/v0.5.8/install.ps1 -OutFile $p
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
iwr https://raw.githubusercontent.com/enwong93-sketch/devspace-ultra/v0.5.8/install.ps1 -OutFile $p
& $p `
  -Network DuckDNS `
  -DuckDnsDomain 'example.duckdns.org' `
  -AllowedRoot "$HOME" `
  -NonInteractive
Remove-Item Env:DEVSPACE_DUCKDNS_TOKEN
```

The public default exposes only the selected workspace root, not every drive. Add further roots deliberately after installation.

The on-disk compatibility directory may still be named `.devspace-tailscale-bootstrap` on upgraded installations. That name is retained so existing OAuth, state, and Scheduled Task migrations remain lossless; it does **not** make Tailscale the public ingress route. New public routing follows the explicit `-Network DuckDNS`, `-Network Cloudflare`, or `-Network Local` selection.

## Release integrity

Every tagged GitHub release contains the exact `install.ps1` used by the tagged raw URL, an npm-compatible `.tgz` archive, and `SHA256SUMS.txt`. Inspect the script and compare the archive checksum before installation when the machine is used for sensitive work.

## Safe feature defaults

The public setup enables the stable Local Gateway, plugin/Skill routing, progress overlay, Context Guardian, stream recovery, and exact-conversation `Goal Recovery`. Goal Recovery is accepted only through the page-composer gate shared with interrupted-turn rescue: it resolves exactly one bound conversation, never foregrounds or navigates a ChatGPT window, and permits only one successfully visible recovery message per Goal round. `Auto Compact` remains disabled until its separate prepare/commit/rollback and re-entry gates pass the release acceptance suite. Operators can temporarily hold Goal Recovery with `DEVSPACE_GOAL_ROUND_RECOVERY=0` without pausing or rebinding the Goal.
