# Windows installation troubleshooting

Use the [guided Windows setup](ONE_COMMAND_SETUP.md) and keep its configuration, encrypted credentials and existing runtime state intact. A local `healthz` 200 is a preparation milestone, **not** proof that the public ChatGPT Connector works. Diagnose the first failing boundary below; do not repeatedly reinstall or reconnect the Connector.

## The package is missing or has no `package.json`

An incomplete Windows global npm junction can result from a Git-URL install. Use the tagged GitHub Release's SHA-256-verified `devspace-ultra-<version>.tgz` through the supported installer, then verify the installed package name, version and CLI before configuring services. Do not repair a running global package with a blind `npm install -g github:...#main`; use the transactional updater for existing installations.

## `better-sqlite3` cannot load

The Windows installer deliberately suppresses package install scripts until the release archive is verified. It must then rebuild the required native SQLite dependency under the installed Node ABI and open a temporary in-memory database before declaring the package ready. A successful `npm install` alone is insufficient. If that native check fails, stop before Gateway/OAuth setup and preserve the existing installation for rollback.

## Setup writes one configuration directory while Gateway reads another

Inspect the exact configuration directory reported by setup and the `--config-dir` path recorded in the `DevSpace-Stable-Gateway` task action. They must match; a process-scoped environment override used during an elevated setup is not a substitute for the persistent Scheduled Task argument. Never copy `auth.json` or paste the Owner secret into chat to make a health check green.

## DuckDNS reports `OK` but points to a VPN address

DuckDNS `OK` acknowledges its update request, not public reachability. Leaving `ip` blank asks DuckDNS to detect the request's IPv4; on a multi-adapter or VPN host this can select the wrong route. The supported direct-ingress path must read and validate the router WAN IPv4, submit it explicitly, and check public DNS after the update. If the router WAN address is unavailable or private/CGNAT, fail closed instead of publishing a VPN address. See [DuckDNS's API specification](https://www.duckdns.org/spec.jsp).

## DNS is correct but the public machine cannot be reached

Check the chain in order: public DNS → publicly routable WAN → router TCP 80/443 mapping to the current LAN IP → Windows Firewall → Caddy on the LAN IP → loopback Gateway. A successful LAN request or a request from the same PC through its public hostname does not replace an independent external-network test; VPN and NAT loopback can distort that result. A router's UPnP mapping lookup returning HTTP 500 is ambiguous until its SOAP fault and the actual add/readback path are checked. Never overwrite an unrelated router mapping or assume a mapping exists from the DuckDNS response.

If the user declines router ingress, preserve the local state but mark public Connector setup **blocked**. DNS cannot forward TCP packets through NAT on its own. A different stable ingress route requires a separate, explicit user choice; it must not be silently substituted.

## Caddy is installed but `caddy.exe` is not found

WinGet can install Caddy without making its command available in the current elevated PowerShell process. The installer should resolve the actual installed executable, validate the generated Caddyfile, and record the full executable path in its Scheduled Task. Do not install a second Caddy or start a second 80/443 listener to work around PATH.

## HTTPS or OAuth still fails after public TCP works

Check Caddy's newest ACME error for the selected hostname; public certificate validation normally needs the outside world to reach TCP 80 or 443. Do not disable TLS verification. Once HTTPS is valid, test the public `/.well-known/oauth-protected-resource/mcp` and authorization-server metadata, an unauthenticated `/mcp` OAuth challenge, then complete ChatGPT Connector authorization and one harmless read-only tool call. Only that final call proves product-level acceptance. See [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https).

## Other runtime boundaries

- Keep allowed workspace roots narrow. A rejected workspace path should be checked against the installed configuration; it is not a reason to grant the entire home directory.
- `bash` needs a compatible Bash installation. Other shell/terminal tools have their own runtime and platform requirements; do not describe every DevSpace command as Bash-only.
- Do not use `DEVSPACE_ALLOWED_HOSTS=*` as a public-ingress repair. The configured hostname and OAuth resource identity must match the accepted Connector URL.
- If the host shows a stale tool catalogue after the backend is healthy, distinguish a ChatGPT tool-snapshot refresh from a Gateway/Core outage before changing installation state.
