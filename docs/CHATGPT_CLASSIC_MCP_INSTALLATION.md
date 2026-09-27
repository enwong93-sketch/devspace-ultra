# ChatGPT Classic MCP installation graph

## Core target

DevSpace Ultra is for **ChatGPT Classic on Windows**, not Codex. Codex may install or repair it, but acceptance must happen inside ChatGPT Classic.

It gives ChatGPT Classic local file, patch, command and process tools plus long-task checkpoint/handoff continuity. This does not increase or bypass OpenAI context, token, account usage or rate limits; it is not literal “unlimited tokens.”

## Required graph

```mermaid
flowchart TD
    A[Preserve existing state] --> B[Local Gateway and Core healthy]
    B --> C[Public HTTPS /mcp and OAuth metadata verified]
    C --> D[ChatGPT Classic: enable Developer mode]
    D --> E[Create one connection for exact https://host/mcp]
    E --> F[Complete OAuth]
    F --> G[Scan or refresh tools]
    G --> H{All required tools present?}
    H -- No --> G
    H -- Yes --> I[Enable connection in a fresh Classic chat]
    I --> J[Real read test]
    J --> K[Authorized disposable write/edit/command and read-back]
    K --> L[Reconnect or second fresh chat test]
    L --> M[Report every step PASS; installation complete]
```

If A–C already pass, start immediately at D. Do not reopen the router, reinstall Caddy or redo DNS. Do not do optional Multi-Main, Goal/Rescue or extra plugin work before D–L.

## Multi-computer isolation

Repeat the graph independently for every computer. One ChatGPT Classic account may keep several DevSpace connections, but each row must use that computer's own public `/mcp` URL, `serverInstanceId`, OAuth audience and Connector/App identity. A PASS from another same-named DevSpace connection is never evidence for this machine.

After OAuth, the first local bootstrap claim must resolve under a Classic Runtime page on the same computer. Every later non-bootstrap tool call requires a current exact local invocation. `devspace_instance_binding_required` means the selected connection is unbound or belongs to the wrong Runtime/server; do not try another computer's connection as a fallback.

## Required tool check

The authenticated ChatGPT Classic connection must show:

`read`, `write`, `edit`, `apply_patch`, `exec_command`, `write_stdin`, `devspace_progress_report`

A callback page, `tools/list`, read-only subset or working Codex connection is not complete acceptance.

OAuth may appear while creating/scanning the connection or on first protected-tool use. Complete it without copying passwords, MFA values, authorization codes, tokens or cookies into chat.

## Final report

Return one PASS/FAIL row for every graph node, the exact MCP URL, connection name, required tools observed, and read/write/reconnect evidence. Any missing row means incomplete.

Official OpenAI flow references:

- [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [MCP authentication](https://developers.openai.com/plugins/build/auth)
- [MCP server quickstart](https://developers.openai.com/plugins/build/app-quickstart)
