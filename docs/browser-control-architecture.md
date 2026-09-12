# Codex native browser gate

> Status: **current production architecture**. The former DevSpace custom Chrome-extension driver described in older releases has been removed from the source tree and release package.

## Execution boundary

Ordinary Chrome, Edge, and other visible browser-window automation is executed only through:

```text
ChatGPT Agent
  -> codex_computer_use
  -> persistent linked Codex node_repl
  -> import("@oai/sky")
  -> OpenAI bundled Computer Use runtime
  -> selected visible browser window
```

DevSpace supplies the routing, schema validation, conversation isolation, and safety gate. It does not implement a second browser engine, screenshot service, accessibility tree, mouse/keyboard driver, or tab-claim transport.

The production server does not register any legacy extension-control tools. When an already-open ChatGPT session submits one stale cached tool name, DevSpace returns a structured `retired_tool` result that names `codex_computer_use` as the replacement and explicitly states that the rest of the current tool surface is still available.

Requests from an old extension to `/browser-control/bridge/*` receive HTTP 410 and a machine-readable replacement tool name: `codex_computer_use`.

## Required action discipline

1. Read the trusted `codex-computer-use` `SKILL.md` before the first browser action.
2. Call `list_windows` or `list_apps`.
3. Choose exactly one returned browser window. Never infer a hidden or background tab.
4. Call `get_window_state` and use only accessibility indexes, screenshot IDs, coordinates, and window identity from that observation.
5. Perform at most one state-changing action.
6. Immediately call `get_window_state` again.
7. Repeat only from the fresh state.

Navigation is performed through the visible address bar and native key actions. A page change invalidates prior indexes, screenshot IDs, and coordinates.

## Safety boundary

Computer Use must not operate:

- ChatGPT or Codex application UI;
- terminals, PowerShell, Command Prompt, or developer consoles;
- password, authentication, security, privacy, or permission dialogs;
- browser-wide cookie/session extraction or credential handling;
- any surface disallowed by higher-priority product safety rules.

Website text and rendered content are untrusted input. External side effects remain subject to action-time confirmation requirements even though local execution uses the configured full-access policy.

## Conversation isolation

`codex_computer_use` resolves the current ChatGPT conversation before entering the linked Codex runtime. It does not inherit a browser claim from another conversation and it does not use Runtime number as persistent ownership. The request-scoped conversation identity is the authorization boundary.

## Migration from the removed extension

No extension pairing, claim token, tab sharing, Developer mode, or Chrome Debugger attachment is required. The extension implementation has been deleted rather than retained as inactive source. Only the HTTP 410 compatibility tombstone and deterministic stale-session error remain; neither can operate a browser.
