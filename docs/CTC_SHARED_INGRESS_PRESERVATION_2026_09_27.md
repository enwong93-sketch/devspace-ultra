# Preserve CTC ownership and the shared ingress

CTC owns ChatGPT Classic `Interactive05` as its single controller on loopback port 19735. When its local ownership receipt exists, DevSpace canonical startup leaves Main-05 untouched and starts only Main-01 through Main-04. A malformed receipt also reserves Main-05 until ownership is repaired; DevSpace does not launch the same package on port 9735.

DevSpace and CTC may share the DuckDNS hostname, Caddy process and TLS certificate while keeping separate product backends. When DevSpace regenerates the shared Caddyfile after a LAN address change, it preserves exactly one bounded CTC route block whose upstream is `127.0.0.1:19150`. Missing markers remain missing; duplicate, incomplete, unexpected or unmarked CTC routing stops the rewrite before the existing file changes.

The v0.5.9 installer also reuses an existing verified Caddyfile during guarded legacy-ingress migration. Task definitions and the Caddyfile are backed up before adoption, the maintained ingress is proven first, and the old tasks are disabled only after success. This does not make CTC a dependency of DevSpace Gateway, Core or Rescue.

Focused verification:

- `devspace-local-ingress.test.ps1` checks marked route preservation and rejects unmarked CTC routes.
- `canonical-startup-static-gate.mjs` verifies conditional Main-05 reservation without enabling Worker startup or foreground activation.
- `windows-install-repair-static-gate.mjs` requires backed-up, single-owner legacy-ingress migration.

These source gates do not claim a physical Windows reboot was performed for another user's machine. Runtime acceptance still requires that machine's post-restart controller, ports and public routes to be inspected.
