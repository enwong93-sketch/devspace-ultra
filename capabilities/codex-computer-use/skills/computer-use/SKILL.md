---
name: codex-computer-use
description: Route Windows GUI tasks to the installed OpenAI bundled Computer Use runtime through DevSpace codex_computer_use.
---

# Codex Computer Use routing

Use `codex_computer_use` automatically when a task requires observing or operating a Windows graphical application: visible windows, buttons, menus, dialogs, screenshots, accessibility state, clicking, typing, scrolling, dragging, or rendered-state verification.

Do not use it for repository/file edits, shell commands, APIs, database queries, or source-code search. Prefer Browser Use for ordinary browser automation.

The DevSpace tool is only a structured adapter over the installed OpenAI bundled Computer Use runtime. The execution path is the shared persistent Codex `node_repl` importing `@oai/sky`; DevSpace does not implement SendInput, UI Automation, screenshot capture, Selenium, Playwright, PowerShell UI automation, or another GUI driver.

Follow the official observe/action discipline:

1. Call `list_apps` or `list_windows` and choose exactly one returned target window.
2. Call `get_window_state` to observe. Use accessibility indexes only from that observation; use screenshot IDs only from that observation.
3. Perform at most one state-changing action.
4. Immediately call `get_window_state` again before deciding the next action.
5. Never reuse stale indexes, coordinates, or screenshot IDs after the UI changes.

Do not automate terminal applications, Windows Run, authentication/password/security/privacy UI, ChatGPT desktop UI, or Codex UI. Higher-priority assistant safety rules and action-time confirmation requirements still apply even though DevSpace's local execution policy is full-access/approval-never.
