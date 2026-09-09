# DevSpace Network Setup capability

Use the `devspace-network-setup` Skill for installation, upgrade, public ingress, DuckDNS/DDNS, Caddy, Cloudflare fallback, OAuth endpoint validation, CGNAT diagnosis, or router-forwarding guidance.

The working Agent executes every safe local command itself. Ask the user to act only where identity, account ownership, physical-router access, or security-sensitive browser interaction makes automation inappropriate. After each user action, verify the actual result before continuing.

DuckDNS/DDNS plus Caddy is the preferred production route. Cloudflare named tunnel is a fallback for CGNAT, unavailable inbound port forwarding, or unusable DDNS. Never describe a Worker relay as unlimited; explain that requests passing through Workers count against the selected plan.

Never request a token in normal chat text. Use a masked secure prompt, process-scoped environment variable, or the setup script's DPAPI-backed secret prompt. Never write credentials to Git, logs, generated status JSON, command history, Task Scheduler arguments, or progress narration.

Visible progress remains Agent-authored through `devspace_progress_report`. Report after each meaningful medium-sized setup phase—not per command and not on a timer.
