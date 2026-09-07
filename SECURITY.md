# Security Policy

DevSpace Ultra gives an AI client access to local files, tools, and terminal execution through MCP. Treat the DevSpace server as a privileged local service.

## Supported versions

Security fixes target the latest `main` branch and the latest tagged DevSpace Ultra release.

## Deployment guidance

- Bind the local service only to interfaces you intend to use.
- Use the authentication layer supplied by DevSpace.
- Prefer a private tunnel or private network you control; do not expose the MCP endpoint directly to the public Internet.
- Keep OS, Node.js, ChatGPT Classic, and DevSpace Ultra updated.
- Do not store worker/orchestrator tokens in scripts, screenshots, issue reports, or public logs.
- Review configured allowed roots before connecting an AI client.
- Worker runtime profiles contain authenticated ChatGPT session state. Treat profile backups as sensitive local data.
- Runtime-05 is reserved by default only as a convenience policy; it is not a security boundary.

## Reporting a vulnerability

Please use GitHub's private **Security Advisories** for `enwong93-sketch/devspace-ultra` rather than opening a public issue for an unpatched vulnerability.

Include:

- affected version/commit;
- operating system and Node.js version;
- minimal reproduction steps;
- impact and expected security property;
- logs with credentials, tokens, cookies, local usernames, and private paths removed.

## Scope notes

DevSpace Ultra includes upstream DevSpace functionality and additional Chat Swarm/runtime orchestration. Reports about upstream-only behavior may also be applicable to the upstream DevSpace project.

The Windows autonomous runtime layer uses local AppX development-package clones and authenticated ChatGPT profile state. Bugs that expose or cross-contaminate those profiles are considered security relevant.

## Full-access local execution policy

DevSpace Ultra is a local single-user development harness. The owner-selected command policy is intentionally `danger-full-access` with approvals disabled and no restricted sandbox mode. `exec_command` and delegated OpenAI Codex Computer Use can access the user's machine with the user's permissions.

Do not expose the local Gateway or control endpoints to untrusted users. Keep OAuth owner credentials private, review third-party capability plugins before enabling them, and use a dedicated operating-system account or virtual machine when running untrusted repositories. The `codex_computer_use` route delegates through the shared persistent Codex `node_repl` to OpenAI's bundled `@oai/sky` Computer Use runtime and does not add a separate DevSpace GUI driver.
