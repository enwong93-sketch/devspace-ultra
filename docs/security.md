# DevSpace Ultra security model

DevSpace exposes local coding capabilities over MCP. Treat it as remote access
to your development machine.

The security model is simple:

- you choose a narrow filesystem allowlist
- the MCP endpoint requires OAuth approval with your Owner password
- Host headers are allowlisted from the configured public URL
- every coding action happens through explicit MCP tool calls

## Filesystem Allowlist

DevSpace only opens workspaces under configured roots.

Good examples:

```text
~/work
~/personal/open-source
```

Avoid broad roots:

```text
~
/
C:\
```

The narrower the root, the easier it is to reason about what the MCP client can
reach.

## Owner approval

The guided installer keeps Owner/OAuth material under its selected user-local configuration directory and protects provider tokens with Windows DPAPI. Do not assume an upgraded installation uses the standalone CLI's default directory, and never paste an Owner token or provider token into chat, logs, Task Scheduler arguments or Git. Approve only the MCP client you intentionally want to access this machine.

## Public URL And Host Allowlist

DevSpace needs the exact stable `publicBaseUrl` so MCP clients can discover OAuth metadata and connect to the correct resource.

The value should be the origin only:

```text
https://your-own-subdomain.duckdns.org
```

Do not include `/mcp` in `publicBaseUrl`; the Connector URL adds `/mcp` to that origin. The public hostname must match the OAuth resource and the Caddy or named-tunnel route.

Each computer has its own `publicBaseUrl`, MCP Connector URL, OAuth resource, and server instance. Configure a ChatGPT Classic Connector with the URL for the computer it is meant to use; DevSpace does not substitute or fall back to another computer's endpoint. To connect another computer, configure its own independent endpoint and Connector.

By default, DevSpace derives allowed Host headers from the local host and public
URL. Use `DEVSPACE_ALLOWED_HOSTS=*` only for intentional local debugging.

## Public ingress

The Windows production default is DuckDNS/DDNS plus Caddy. Only Caddy's HTTPS/OAuth allowlisted route is public; Gateway `127.0.0.1:7678`, Core slots `7688`/`7689`, Blender and other application MCP ports stay on loopback. Direct ingress also needs a publicly routable WAN address and router TCP 80/443 mapping to the DevSpace computer. A healthy local Gateway or DuckDNS update is not evidence of that external path. For the selected provider and acceptance sequence, see [network ingress](NETWORK_INGRESS.md) and [Windows setup](ONE_COMMAND_SETUP.md).

A stable named tunnel is an explicit fallback when direct ingress is unavailable, not an automatically equivalent default. Neither a DDNS hostname nor a tunnel URL is an authentication secret; OAuth still protects the MCP endpoint. Never expose Gateway/Core ports directly or weaken TLS to make a reachability test pass.

## Shell Access

The shell tool is powerful by design. It is meant for tests, builds, git, and
package scripts.

Filesystem path containment applies to DevSpace file tools. Shell commands run
as local commands and can do what your user account can do. This is why the MCP
client must be trusted and the Owner password must stay private.

## Worktrees

Managed worktrees reduce accidental edits to your active checkout, but they are
not a security boundary. They are a workflow boundary for isolated coding
sessions.

## Native File Download

Native file download is an opt-in, one-shot transfer into an already-open
workspace. `download_artifact` accepts the MCP host's native file value, the
`workspaceId` returned by `open_workspace`, and an unused relative destination
path. It returns only the workspace-relative path and does not create a
persistent artifact service or reusable artifact ID.

DevSpace accepts only the documented native-file object and trusted OpenAI
download hosts and redirects. Arbitrary URL strings, local source paths,
credentials, malformed references, and unknown object fields are rejected.

Absolute paths, traversal, symlinked parents, and existing destinations also
fail closed. Downloads stream under the configured per-file limit and are
published without overwrite as owner-only files. DevSpace does not extract or
execute transferred content.

## Logs

By default, DevSpace logs requests and tool calls. Shell command previews are
disabled unless `DEVSPACE_LOG_SHELL_COMMANDS=1`.

Do not enable shell command logging if commands may contain secrets.

Artifact tool logs contain bounded workspace ID, validated hostname,
workspace-relative output path, byte count, hash, duration, and status metadata.
`download_artifact` does not log the opaque file value. Raw content, connector
references, native file IDs, bearer credentials, presigned URLs, host paths,
temporary paths, and base64 chunks are never included in tool logs or tool
results.
