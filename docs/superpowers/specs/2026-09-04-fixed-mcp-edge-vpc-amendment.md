# Fixed MCP Edge — Workers VPC Amendment

**Date:** 2026-09-04

**Status:** Approved-by-delegation implementation amendment after live origin failure. The user delegated the implementation choice as long as the final MCP URL is fixed and the UX is automatic.

## Why the original origin path changed

The first fixed Worker deployment successfully produced the stable public URL:

`https://devspace-ultra-mcp-edge.<account-subdomain>.workers.dev`

However, a live request through the Worker to the existing public Tailscale Funnel origin returned Cloudflare `525 SSL handshake failed`. The response identified the Tailscale `*.ts.net` hostname as the failing origin. This is a Cloudflare-Worker-to-Tailscale TLS interoperability problem, separate from DevSpace OAuth and separate from the ChatGPT validator issue already observed on direct Tailscale.

A second live gate used Cloudflare Workers VPC instead:

1. create a named Cloudflare Tunnel;
2. keep `cloudflared` connected outbound from the Windows machine;
3. register `127.0.0.1:7676` as an HTTP VPC Service on that tunnel;
4. bind the VPC Service to the fixed Worker as `PRIVATE_ORIGIN`;
5. have the Worker call `env.PRIVATE_ORIGIN.fetch(...)` for approved MCP/OAuth paths.

That path immediately returned real DevSpace `/healthz` `200` and `/mcp` `401` through the same fixed `workers.dev` URL. No public Tailscale TLS hop is involved.

## Revised production data path

```text
ChatGPT / OpenAI validator
        |
        v
fixed https://<worker>.<account>.workers.dev
        |
        v
Cloudflare Worker
        |
        | PRIVATE_ORIGIN.fetch()
        v
Workers VPC Service
        |
        v
named Cloudflare Tunnel (outbound-only cloudflared)
        |
        v
http://127.0.0.1:7677  (isolated fixed backend by default)
        |
        v
DevSpace Ultra fixed plane

separate control/dev backend (for example 7676) remains untouched
```

The existing Tailscale Funnel remains installed and may continue serving the machine for other DevSpace/local services, but it is no longer on the ChatGPT fixed-edge data path.

## Why Workers VPC is preferred

- fixed ChatGPT-facing `workers.dev` URL;
- no random Quick Tunnel URL;
- no custom domain required;
- no inbound port or public origin required;
- VPC Service is fixed-target and prevents the Worker from becoming an open proxy;
- Worker-to-local traffic stays inside Cloudflare's tunnel/VPC path;
- avoids the observed Worker -> Tailscale `525` TLS failure;
- currently available on Workers Free/Paid plans during the Workers VPC open beta.

## Worker behavior

When `PRIVATE_ORIGIN` exists, the Worker must prefer it over public `fetch`.

The VPC Service configuration fixes the actual target to loopback and the dedicated fixed-backend port (`7677` by default). The fixed backend receives the Worker public identity, a dedicated state directory and its Host allowlist through child-process environment overrides; edge setup must never rewrite the existing/default control backend's `publicBaseUrl`, port, or state directory. The synthetic Worker fetch URL uses `http://127.0.0.1/<path>` so DevSpace's loopback Host allowlist accepts the private hop. Path, query, method, MCP/OAuth headers, request body, status, response headers, and streaming response body remain preserved. OAuth redirects remain manual/pass-through.

The old `ORIGIN_BASE_URL` public-fetch path remains only as a generic fallback for operators who intentionally configure a compatible HTTPS origin. It is not the production path on this machine.

## Cloudflare resources

Production setup owns non-secret resource identifiers in local DevSpace edge metadata:

- Worker name and fixed public URL;
- named Tunnel ID/name;
- Workers VPC Service ID/name;
- transport mode `workers-vpc`.

Tunnel credentials/OAuth tokens remain outside the repository and must never be printed by DevSpace normal status output.

## Startup UX

Normal Windows startup must automatically ensure:

1. the isolated fixed DevSpace backend is listening on its dedicated loopback port;
2. the named Cloudflare Tunnel is running and connected;
3. any separate control/dev DevSpace backend remains independent and untouched;
4. existing Tailscale startup/routes continue independently;
5. the fixed Worker remains unchanged in Cloudflare;
6. ChatGPT keeps the same connector URL.

No `trycloudflare.com` process is required in steady state.

Windows installs two explicit logon tasks: one owns `wrangler tunnel run <tunnel-id>` in the foreground for the lifetime of the named tunnel, and one owns the isolated fixed backend in the foreground. The tasks have no short execution timeout. Setup replaces older task definitions safely and removes legacy duplicate wrappers only when their command line names the exact configured tunnel ID; unrelated Quick Tunnels and other Cloudflare processes are not touched. If later hardening obtains a dedicated tunnel credential/token, the launcher may move to direct `cloudflared` service mode without changing the public Worker URL.

## Health status

`devspace edge status` must distinguish:

- Worker public health;
- VPC Service/Tunnel reachability;
- local backend health;
- direct Tailscale fallback health (informational only);
- fixed OAuth metadata identity.

A VPC tunnel outage is an origin-down state; it never rotates the public URL.

## Acceptance

The fixed edge is accepted only when:

- `workers.dev/healthz` reaches the local backend through VPC;
- unauthenticated `/mcp` returns the expected 401 challenge;
- after the production backend advertises the Worker as `publicBaseUrl`, PRM and authorization metadata use the Worker URL;
- ChatGPT custom-app validator reaches the backend through Worker/VPC;
- OAuth and a real tool call succeed;
- backend restart and startup-style tunnel reconnect do not require connector recreation;
- Quick Tunnel can be stopped without affecting the fixed connector.
