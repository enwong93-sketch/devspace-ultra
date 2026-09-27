# DevSpace Ultra setup

This page is the current DevSpace Ultra entry point. For a new Windows installation, follow [the guided one-command setup](ONE_COMMAND_SETUP.md); for the selected public route and its prerequisites, read [network ingress](NETWORK_INGRESS.md). The separate upstream DevSpace CLI instructions are not an installation path for the Ultra Windows package.

## What the installer can prepare

The tagged Windows installer installs the verified release package and setup Skill, creates a user-local configuration and protected credentials, starts the Stable Gateway/Core on loopback, and prepares the selected public ingress. For the recommended DuckDNS route, Caddy terminates HTTPS and forwards only approved public MCP/OAuth paths to the loopback Gateway.

The public Connector is the product acceptance target. A healthy local Gateway, successful DuckDNS update or a running Caddy process is **not** evidence that ChatGPT can reach the machine. A direct DDNS route additionally needs a publicly routable WAN address, router TCP 80/443 ingress, a valid certificate, and an independent external-network test. The Agent guides account/router actions that require the user's involvement; it never silently changes another router mapping.

## Completion boundary

Follow the [ChatGPT Classic MCP installation graph](CHATGPT_CLASSIC_MCP_INSTALLATION.md). Only its final node is complete acceptance; package install, local health, public ingress, OAuth, tool discovery or a read-only call on their own are intermediate evidence. If a required node cannot pass, preserve working state and report that exact blocker.

For upgrades, use the [transactional update path](ONE_COMMAND_SETUP.md) rather than reinstalling on top of a running global package. For known installation failures and safe recovery, see [troubleshooting](gotchas.md).
