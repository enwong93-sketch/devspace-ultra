# DevSpace Ultra v0.5.9 installation audit

Audit date: 2026-09-27

## Scope

The audit reviewed the current public Windows/macOS/Linux install entry points, root README, setup/security/troubleshooting documentation, packaged setup Skills, release workflow, version surfaces and the implementation behind each claimed setup step. It also classified the eight previous release notes and sixteen dated `docs/superpowers` plans/specifications as historical records rather than current instructions.

Historical documents retain the ports, services and decisions that were true at the time. They are not linked as the current setup route and are not silently rewritten or deleted.

## Corrected current guidance

| Area | Previous current-facing problem | v0.5.9 result |
| --- | --- | --- |
| Windows source | Global npm install from a Git URL could leave an incomplete junction | Exact GitHub Release `.tgz`, mandatory GitHub SHA-256 digest, installed package/CLI identity check |
| Native dependency | `--ignore-scripts` left `better-sqlite3` without a binding | Rebuild under the installed Node runtime and open/close an in-memory database before setup |
| Empty configuration | StrictMode failed when adding the first property | Safe `PSObject.Properties.Match()` add/replace path with unit coverage |
| Configuration path | Setup could write a directory different from the Gateway task's directory | Scheduled task records the exact persistent `--config-dir` written by setup |
| Caddy discovery | Same shell could not find a new WinGet install | Resolve PATH, WinGet links or one unambiguous WinGet package executable |
| DuckDNS address | Empty `ip=` could publish a VPN/Radmin address | Read and validate router WAN IPv4; submit it explicitly; reject private/CGNAT/reserved values |
| LAN selection | A VPN default route could be selected | Require an active physical adapter with a private home-router gateway |
| Router entry | Documentation implied manual login was always required | Explicit-consent UPnP is supported; confirmed manual forwarding remains the fallback |
| UPnP errors | Any HTTP 500 could be mistaken for an absent mapping | Only SOAP fault 714 means absent; all other faults fail closed |
| PowerShell host | UPnP fault parsing/body encoding differed between 5.1 and 7 | Deterministic UTF-8 SOAP body and fault extraction tested on Windows PowerShell 5.1 and PowerShell 7 |
| Existing ingress | A second DuckDNS/Caddy route could race the first | Back up task XML/Caddyfile, reuse the existing Caddyfile, prove maintained ingress, then disable old tasks |
| Shared Caddy | Regeneration could erase a CTC route | Preserve exactly one bounded marked CTC route; reject ambiguous or unmarked CTC routing |
| DHCP change | Router mapping/Caddy bind could point at an old LAN address | Detect LAN IPv4 change, stage and validate a new Caddyfile, then reload the managed process |
| Completion claim | Local health could be presented as public product success | Report `publicConnectorVerified=false` until independent HTTPS/OAuth and real Connector calls pass |
| macOS/Linux | `install.sh` installed moving `main` | Exact stable Release archive, digest verification, package identity check and SQLite rebuild/load test |
| Current docs | Old upstream `npx @waishnav/devspace`, port 7676 and moving-branch commands appeared as current setup | Replaced with canonical Gateway 7678 and pinned Release instructions; history remains in dated documents |

## Acceptance boundary

Installation is not complete merely because npm, DuckDNS or local `/healthz` succeeds. Product acceptance requires:

1. exact package/version and native SQLite checks;
2. one canonical Gateway/Core startup path;
3. correct public DNS and router WAN path;
4. independent external HTTPS health and OAuth metadata;
5. unauthenticated `/mcp` returning the expected OAuth challenge;
6. private paths returning 404;
7. ChatGPT Connector OAuth, initialize and `tools/list`;
8. one read-only call and one explicitly authorized write-capable call in a disposable workspace.

## Verification included in the release

- `npm run verify:setup`
- `npm run verify:local-ingress`
- `npm run verify:public-release`
- `npm run verify:ultra`
- Windows PowerShell 5.1 and PowerShell 7 UPnP SOAP loopback regression
- isolated npm-prefix archive install, `better-sqlite3` rebuild and binding load
- `npm pack` package-content and version consistency gates

These automated gates prove packaging and local behavior. They do not impersonate an end user's router, public certificate authority or ChatGPT account; those remain explicit live acceptance gates.
