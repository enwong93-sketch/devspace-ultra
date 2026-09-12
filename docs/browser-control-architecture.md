# Codex native browser gate

> Status: **current production architecture**. The former DevSpace Chrome-extension `browser_control_*` driver described in older releases is retired.

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

The production server does not register `browser_control_pair`, `browser_control_status`, `browser_control_claim`, `browser_control_inspect`, `browser_control_act`, `browser_control_navigate`, `browser_control_wait`, `browser_control_release`, or `browser_control_cdp`.

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

## Migration from the retired extension

No extension pairing, claim token, tab sharing, Developer mode, or Chrome Debugger attachment is required. Existing extension files remain in the source repository only as historical migration material and are excluded from newly packed releases. They are not started, registered, or accepted as a browser automation fallback.
