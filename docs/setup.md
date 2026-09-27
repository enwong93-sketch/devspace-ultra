# DevSpace Ultra setup

This page is the current DevSpace Ultra entry point. For a new Windows installation, follow [the guided one-command setup](ONE_COMMAND_SETUP.md); for the selected public route and its prerequisites, read [network ingress](NETWORK_INGRESS.md). The separate upstream DevSpace CLI instructions are not an installation path for the Ultra Windows package.

## What the installer can prepare

The tagged Windows installer installs the verified release package and setup Skill, creates a user-local configuration and protected credentials, starts the Stable Gateway/Core on loopback, and prepares the selected public ingress. For the recommended DuckDNS route, Caddy terminates HTTPS and forwards only approved public MCP/OAuth paths to the loopback Gateway.

The public Connector is the product acceptance target. A healthy local Gateway, successful DuckDNS update or a running Caddy process is **not** evidence that ChatGPT can reach the machine. A direct DDNS route additionally needs a publicly routable WAN address, router TCP 80/443 ingress, a valid certificate, and an independent external-network test. The Agent guides account/router actions that require the user's involvement; it never silently changes another router mapping.

## Completion boundary

Keep these stages distinct in all installer output and support replies:

1. Package and native dependencies verified.
2. Local Gateway/Core healthy with the intended configuration and narrow allowed roots.
3. Public DNS, HTTPS certificate, OAuth metadata and MCP challenge verified from outside the LAN.
4. ChatGPT Connector OAuth completed and one harmless read-only DevSpace tool call succeeded.

Only stage 4 is a complete ChatGPT Connector installation. If the user cannot or chooses not to provide the required public ingress, preserve the local preparation and report an explicit public-connector blocker rather than success. Do not retry by broadening allowed roots, exposing Gateway/Core ports directly, disabling TLS verification, or replacing DuckDNS with a different provider without the user's choice.

For upgrades, use the [transactional update path](ONE_COMMAND_SETUP.md) rather than reinstalling on top of a running global package. For known installation failures and safe recovery, see [troubleshooting](gotchas.md).
