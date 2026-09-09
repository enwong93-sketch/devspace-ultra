# Network ingress policy

## Route order

1. **DuckDNS/DDNS + Caddy** is the production default. Traffic reaches the user's machine directly over HTTPS and does not consume a Cloudflare Worker request allowance.
2. **Cloudflare named tunnel** is the fallback when the user has CGNAT, cannot forward ports, or has no usable DDNS route.
3. **Local-only** is for backend development and cannot be used as a public ChatGPT MCP endpoint.

Tailscale is no longer the primary public setup path. Existing state-directory names containing `tailscale-bootstrap` are compatibility identifiers only and do not change the selected ingress provider.

## DuckDNS requirements

- A DuckDNS hostname and token.
- A publicly routable IPv4 or IPv6 address.
- Router forwarding of TCP 80 and 443 to the DevSpace computer.
- Caddy must be able to complete public certificate validation.

The updater stores only domain, provider, success state, and observation time. It never records the DuckDNS token or the complete authenticated update URL.

## Cloudflare fallback and quotas

DevSpace supports a stable named tunnel token. It deliberately does not make an ephemeral Quick Tunnel the production default because the ChatGPT connector and OAuth resource identity need a stable public base URL.

When a Cloudflare Worker relay is part of the fallback path, every MCP/OAuth/health request passing through that Worker counts against the selected Workers plan. The Free plan has a daily request allowance, and Cloudflare may revise plan limits. Review the official Workers limits page during installation and before scaling the number of agents. Named Tunnel traffic and Worker execution are distinct Cloudflare products; do not claim that the entire fallback is quota-free merely because the tunnel itself is running.

Official references used by the release documentation:

- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/
- https://www.duckdns.org/spec.jsp

## Exposure boundaries

- Gateway, Core, Blender MCP, and other local application ports remain loopback-only.
- Only the HTTPS reverse proxy or named tunnel is public.
- OAuth remains mandatory at the MCP endpoint.
- Secrets are kept out of repository files, logs, Scheduled Task arguments, and generated status JSON.
- The installer defaults `allowedRoots` to the current user's home directory.
