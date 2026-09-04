# DevSpace Ultra Fixed MCP Edge Design

**Date:** 2026-09-04

**Status:** Approved architecture — fixed public URL and zero-maintenance UX are the requirements; Cloudflare/Tailscale are implementation details.

## Goal

Give DevSpace Ultra one stable public MCP URL that ChatGPT can validate and reconnect to across reboots without the user starting a temporary tunnel, copying a new URL, re-creating the connector, or changing the Owner password.

The desired steady-state UX is:

1. Windows/Tailscale/DevSpace start normally.
2. A permanently deployed public edge remains available at the same URL.
3. ChatGPT connects to that fixed URL.
4. OAuth discovery, Owner-password authorization, refresh-token rotation, MCP initialize, tool calls, and reconnects work without manual tunnel maintenance.

## Evidence from the 2026-09-04 live incident

The existing direct Tailscale Funnel endpoint was:

`https://desktop-hc8eshn.tail18e977.ts.net/mcp`

Local and public probes proved:

- Tailscale daemon was online.
- `tailscale serve status` routed the public hostname to `127.0.0.1:7676`.
- DevSpace listened on `127.0.0.1:7676` and `/healthz` returned `ok:true`.
- `GET /mcp` and `POST /mcp` returned `401` with a valid `WWW-Authenticate` challenge.
- the challenge pointed at `/.well-known/oauth-protected-resource/mcp`.
- protected-resource metadata and authorization-server metadata were correct and used the Tailscale public hostname.
- dynamic client registration, `/authorize`, PKCE, `/token`, access-token issuance, and refresh-token issuance passed end to end.
- the previously registered ChatGPT OAuth client also passed a direct authorization-code/token exchange.

However, when ChatGPT attempted to create/validate the direct Tailscale connector, the DevSpace request log contained no validator request at all. ChatGPT reported that the MCP server did not implement OAuth before any request reached the local backend.

A Cloudflare Quick Tunnel was then created and the same DevSpace backend was restarted with the Quick Tunnel URL as `DEVSPACE_PUBLIC_BASE_URL`. The resulting endpoint passed the same metadata checks. ChatGPT then reached the backend, completed OAuth, and connected successfully. Logs showed the validator and MCP client traffic, including `Python/3.13 aiohttp/3.13.5` probes and authenticated `openai-mcp/1.0.0` requests. A real DevSpace tool call through `DevSpace CF Canary` succeeded.

Therefore the permanent design must not alter the working DevSpace OAuth protocol to compensate for a request that never reaches it. The compatibility boundary is the ChatGPT-facing public edge.

## Selected architecture

Use a permanently deployed **Cloudflare Worker on a fixed `workers.dev` URL** as the ChatGPT-facing edge, while keeping the existing fixed **Tailscale Funnel URL as the origin**.

Data path:

```text
ChatGPT / OpenAI validator
        |
        v
https://<worker>.<account>.workers.dev
        |
        | Cloudflare Worker transparent HTTP proxy
        v
https://desktop-hc8eshn.tail18e977.ts.net
        |
        | existing Tailscale Funnel / Serve
        v
http://127.0.0.1:7676
        |
        v
DevSpace Ultra
```

The Worker is a stable cloud-side deployment. It does not require `cloudflared` to run locally after deployment. The temporary `trycloudflare.com` tunnel remains a diagnostic-only path and is not part of production startup.

A custom domain is not required. A `workers.dev` route is sufficient for this personal fixed edge; the implementation must also allow a custom domain later without changing DevSpace OAuth semantics.

## Why this architecture

### Compared with direct Tailscale

Direct Tailscale is simpler and remains the origin transport, but the live ChatGPT validator did not reach it. Keeping it as the only public endpoint would preserve the exact failure mode.

### Compared with a Quick Tunnel

A Quick Tunnel is proven compatible with ChatGPT but changes its hostname whenever it is recreated. It therefore fails the fixed-URL and reboot UX requirements.

### Compared with a named Cloudflare Tunnel

A named tunnel can be stable, but it adds a local `cloudflared` service and normally a Cloudflare-managed hostname/domain route. The Worker-over-Tailscale design keeps the already-working Tailscale startup/origin path and moves only the compatibility edge into Cloudflare.

### Compared with changing DevSpace OAuth

OAuth itself already passed end-to-end tests. Replacing or weakening it would add security risk without addressing the observed boundary failure.

## Edge proxy behavior

The Worker is a **fixed-origin reverse proxy**, never an open proxy.

Configuration contains one origin base URL supplied at deploy time. No request parameter can select another upstream.

For every incoming request the Worker:

1. parses the public Worker URL;
2. replaces only scheme/host/port with the configured origin base;
3. preserves path and query exactly;
4. preserves HTTP method;
5. forwards request headers, including `Authorization`, `Accept`, `Content-Type`, MCP session headers, and OAuth form headers;
6. forwards the request body as a stream for methods that permit a body;
7. performs the upstream fetch with redirect following disabled;
8. returns upstream status, headers, and response body stream without buffering.

Redirect following must be disabled because `/authorize` intentionally returns a `302` to a ChatGPT callback URL. The edge must pass that redirect to the browser/client rather than follow it itself.

The edge does not terminate or reimplement DevSpace OAuth. It never receives or stores the Owner password outside the normal proxied request and never persists OAuth codes/tokens.

## Public-base identity

Once the fixed Worker is deployed, DevSpace's persisted `publicBaseUrl` becomes the Worker base URL, for example:

`https://devspace-ultra-edge.<account>.workers.dev`

This causes DevSpace itself to publish the Worker identity in:

- MCP `WWW-Authenticate resource_metadata`;
- Protected Resource Metadata `resource`;
- `authorization_servers`;
- OAuth `issuer`;
- `authorization_endpoint`;
- `token_endpoint`;
- `registration_endpoint`;
- `revocation_endpoint`.

No response-header rewriting should be required at the Worker when DevSpace is configured correctly.

## Origin Host allowlist

A Worker fetch to the Tailscale origin uses the Tailscale hostname at the upstream HTTP boundary. DevSpace therefore needs both identities in its allowed-host policy:

- the fixed Worker hostname, because it is the public identity;
- the Tailscale Funnel hostname, because it is the Worker-to-origin Host/SNI identity.

The edge setup must update `~/.devspace/config.json` atomically so `publicBaseUrl` and the required origin hostname cannot drift apart.

The existing `allowedRoots`, plugin settings, Auto Compact settings, and unrelated configuration must be preserved exactly.

## Product surface

The public DevSpace Ultra package gains a provider-neutral fixed-edge setup surface with a Cloudflare implementation.

Recommended CLI shape:

```text
devspace edge status
devspace edge cloudflare setup --origin <https-origin> [--name <worker-name>]
devspace edge cloudflare verify
devspace edge disable
```

`setup` is a one-time operation. It may require one Cloudflare browser authorization if Wrangler is not already authenticated. After that one-time deployment, no Cloudflare login or local tunnel command is required during normal reboot/startup.

The setup command must:

1. validate the origin URL;
2. verify the origin `/healthz` and OAuth discovery surfaces;
3. verify Cloudflare Wrangler authentication without printing credentials;
4. deploy the fixed Worker;
5. obtain the deployed `workers.dev` URL from Wrangler output/API rather than guessing the account subdomain;
6. verify Worker `/mcp` returns an OAuth challenge;
7. verify Worker PRM and authorization metadata name the Worker URL;
8. atomically persist `publicBaseUrl` plus the Tailscale origin hostname in allowed hosts;
9. restart/handover only the DevSpace backend when necessary;
10. run an authenticated or protocol-level MCP live gate through the fixed edge;
11. report the one final URL the user should register in ChatGPT.

The command must fail closed and leave the old persisted config unchanged until the newly deployed edge passes its pre-commit verification.

## Cloudflare project files

The repository contains generic Cloudflare edge assets only; no contributor-specific hostname or account ID is committed.

Planned responsibilities:

- `edge/cloudflare-worker/src/index.js` — transparent fixed-origin proxy.
- `edge/cloudflare-worker/wrangler.jsonc` — generic Worker metadata, `workers_dev=true`, current compatibility date, no user-specific origin.
- `dist/edge-cloudflare.js` — deployment/configuration orchestration used by the CLI.
- `dist/edge-cloudflare.test.js` — deterministic proxy/config tests.
- `scripts/fixed-edge-live-gate.mjs` — network/live acceptance gate that does not print OAuth secrets.

The origin URL is injected at deployment time as a Worker variable or secret-like binding and is not hard-coded into the public repository.

## Cloudflare authentication

Wrangler authentication is a one-time setup dependency, not a runtime dependency.

Priority:

1. valid `CLOUDFLARE_API_TOKEN` + account access;
2. existing Wrangler OAuth login;
3. one interactive `wrangler login` browser approval.

The current machine has a `CLOUDFLARE_API_TOKEN` environment variable, but the live `wrangler whoami` check could not enumerate an account, so setup must not assume the current token is deploy-capable. If a one-time browser login is required, the setup flow should pause at that single human authorization boundary and resume automatically afterwards.

No Cloudflare API token is stored in the repository or DevSpace config.

## Startup and reboot behavior

After setup:

- the Worker deployment remains live in Cloudflare independently of the PC;
- Tailscale continues to start using the existing machine configuration;
- Tailscale Serve/Funnel continues forwarding the fixed `.ts.net` origin to `127.0.0.1:7676`;
- DevSpace starts with the persisted Worker `publicBaseUrl`;
- no Quick Tunnel process is started;
- no URL is regenerated;
- the ChatGPT app/connector keeps the same MCP URL.

A brief origin-unavailable period during Windows boot may produce an edge 5xx until Tailscale/DevSpace are ready; this does not change the public URL or require connector recreation. Health diagnostics distinguish edge-up/origin-down from OAuth/MCP failures.

## Health diagnostics

`devspace edge status` must report, without secrets:

- configured public edge URL;
- configured origin hostname;
- local `/healthz` result;
- direct origin `/healthz` result;
- public edge `/healthz` result;
- public edge `/mcp` unauthenticated status and presence of `WWW-Authenticate`;
- PRM resource URL;
- authorization issuer/token endpoint host consistency;
- whether current configuration is fixed or temporary;
- whether the public edge matches persisted `publicBaseUrl`.

It must not report Owner passwords, bearer tokens, OAuth codes, refresh tokens, Cloudflare API tokens, or raw Authorization headers.

## Security model

The Worker adds no new authentication bypass.

- DevSpace remains protected by the existing OAuth owner-token flow.
- The Worker forwards Authorization headers but does not inspect or persist token values.
- The Worker accepts no arbitrary upstream URL.
- Cloudflare credentials exist only for deployment/control-plane operations, never for MCP data-plane requests.
- The Tailscale Funnel origin remains public because it already serves as the current MCP endpoint; the Worker does not increase the origin's privilege.
- Production Express errors must return generic JSON and must not expose local paths or stack traces to either public edge.

The previously observed Express/body-parser stack-trace leak is part of the same hardening release gate, but it is a DevSpace server error-handler fix rather than Worker proxy logic.

## OAuth code persistence and handover

The live incident also exposed that authorization codes are currently held in `SingleUserOAuthProvider.codes = new Map()`, while access/refresh tokens are SQLite-backed.

That process-local code map is not the root cause of the Tailscale validator failure, but it is a genuine backend-handover race: replacing the backend after `/authorize` and before `/token` invalidates an in-flight code.

The v0.4.0 hardening work therefore moves authorization-code records into the persistent OAuth store or otherwise makes them shared/handover-safe. Code records remain one-time, client-bound, PKCE-bound, and five-minute TTL-limited.

This change requires its own regression test and must not weaken code replay prevention.

## ChatGPT connector acceptance

The permanent edge is not accepted merely because curl probes pass.

Final live acceptance requires:

1. stop the diagnostic Quick Tunnel;
2. start DevSpace from normal persisted configuration, with no temporary `DEVSPACE_PUBLIC_BASE_URL` override;
3. verify the fixed Worker URL remains unchanged;
4. create/connect the production DevSpace ChatGPT app using that fixed `/mcp` URL;
5. observe the OpenAI validator reaching the backend through the Worker;
6. complete Owner-password OAuth once if the app is newly created;
7. invoke a real DevSpace tool from ChatGPT;
8. restart only the DevSpace backend and verify refresh/reconnect through the same fixed URL;
9. simulate/restart the normal Windows/Tailscale/DevSpace startup path and verify the connector works without changing URL;
10. confirm no `cloudflared tunnel --url ...` process is required.

## Interaction with Multi-Main

Fixed-edge work and Multi-Main are separate subsystems but share the same release gate.

The fixed edge restores a reliable agent-to-DevSpace control plane. The Multi-Main design then uses that control plane to create Main-03+ automatically.

Final v0.4.0 user-level acceptance therefore includes both:

- the same fixed DevSpace MCP URL surviving backend/reboot-style recovery;
- Agent request `open another Main` creating a new signed-in secondary Main without repeated manual account login.

## Failure policy

- Cloudflare deployment/auth failure: do not change persisted `publicBaseUrl`.
- Worker reachable but origin unreachable: keep fixed edge configuration; report origin health failure rather than rotating URL.
- OAuth discovery mismatch: fail setup before config commit.
- Worker proxy follows an OAuth redirect: test failure; never deploy that build.
- fixed edge fails ChatGPT live validation: retain the proven Quick Tunnel only as a temporary recovery path while preserving evidence; do not silently claim the fixed solution is complete.
- backend handover loses an authorization code: regression failure; do not release.

## Release boundary

This work targets DevSpace Ultra v0.4.0 together with the approved Multi-Main work.

No public push/tag/release occurs until all of the following are green with fresh evidence:

- fixed Worker edge deterministic tests;
- fixed-edge protocol/live gate;
- OAuth code handover regression;
- generic public Express error-response regression;
- Multi-Main static/unit gates;
- live zero-login Main-03+ gate;
- canonical `chatgpt://` ownership gate;
- full `npm run verify:ultra`;
- package dry-run contents audit;
- secret/personal-path scan;
- fixed ChatGPT connector tool call after backend/reboot-style recovery.
