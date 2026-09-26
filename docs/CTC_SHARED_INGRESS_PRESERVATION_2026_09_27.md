# Preserve the shared CTC controller and ingress across startup

CTC owns the existing ChatGPT Classic Interactive05 package as its single
controller on loopback port 19735. When its local ownership receipt exists,
the DevSpace canonical startup starts Main-01 through Main-04 and leaves that
package untouched. Without a CTC receipt, Main-05 keeps its original DevSpace
startup behavior. A malformed CTC receipt reserves Main-05 until ownership is
clarified rather than launching the same package on port 9735.

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
- `canonical-startup-static-gate.mjs`: startup conditionally excludes the
  CTC-reserved Main-05 listener while retaining ordinary Main startup and
  Worker boundaries.
- `local-ingress-static-gate.mjs`: existing ingress safety checks pass.

The installed local machine was separately observed with CTC on port 19735,
port 9735 absent, and the shared HTTPS gate returning CTC health 200,
unauthenticated MCP 401, both CTC OAuth metadata routes 200, original DevSpace
health and metadata unchanged, and private CTC routes 404. A full Windows
reboot was not performed as part of this patch.
