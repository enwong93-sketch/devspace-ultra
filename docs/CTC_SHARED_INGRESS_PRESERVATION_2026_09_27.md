# Preserve the shared CTC controller and ingress across startup

CTC owns the existing ChatGPT Classic Interactive05 package as its single
controller on loopback port 19735. The DevSpace canonical startup now starts
Main-01 through Main-04. It no longer opens that same package on the retired
Main-05 port 9735.

DevSpace and CTC share the DuckDNS hostname, Caddy process and TLS certificate.
When DHCP changes the LAN address, DevSpace regenerates the Caddyfile. The
generator now retains exactly one bounded CTC route block already present in
that file while updating its own LAN bind and DevSpace routes. A missing block
remains missing; ambiguous markers or an unexpected CTC upstream stop the
rewrite before the existing configuration changes. This does not make CTC a
dependency of DevSpace Core, Gateway or Rescue.

Focused verification:

- `devspace-local-ingress.test.ps1`: CTC block and DevSpace proxy survive LAN
  rebinding; duplicate markers are rejected without changing the file.
- `canonical-startup-static-gate.mjs`: startup excludes the retired Main-05
  listener while retaining the Main-01 through Main-04 and Worker boundaries.
- `local-ingress-static-gate.mjs`: existing ingress safety checks pass.

The installed local machine was separately observed with CTC on port 19735,
port 9735 absent, and the shared HTTPS gate returning CTC health 200,
unauthenticated MCP 401, both CTC OAuth metadata routes 200, original DevSpace
health and metadata unchanged, and private CTC routes 404. A full Windows
reboot was not performed as part of this patch.
