# DevSpace Ultra Agent Notes

## Mandatory interactive progress preflight

For every user-facing ChatGPT Classic Main task expected to require more than one substantive tool call, more than roughly 30 seconds, or multiple verification gates, start or resume the required Goal/Plan structure and then call `devspace_progress_report` **before the first substantive work tool**. The opening report is mandatory even before a medium-sized result exists; keep it concise and state the current objective plus the immediate first medium step. A genuinely atomic one-tool task is the only exception.

This is a product gate, not only a prompt preference. For an exact user-facing Main conversation, an active Plan blocks substantive tools until a verified current-turn report exists; without a Plan, the first substantive tool is the atomic exception but a second substantive tool is rejected until the Agent reports; a report older than the ten-minute ceiling blocks the next substantive tool; and the Plan cannot be completed until a fresh verified report exists. If a tool returns `devspace_progress_preflight_required`, do not bypass or rephrase the blocked operation: call `devspace_progress_report` yourself with a useful natural-language update, complete the exact-page claim/bridge when needed, then retry the original tool. Backend Chat Swarm workers remain excluded from this user-facing gate.

A `pending` claim, unresolved or unbound conversation identity, unavailable recipient, omitted tool, or timeout is not proof that the floating card was updated. Use the exact-conversation compatibility bridge once when the current conversation ID is known and verify that the report appeared on this conversation. If verification still fails, state one visible progress-routing blocker in the current chat, continue the requested safe work, and never claim that the card was updated. Re-check this gate before each new long phase and before the final response. Chat Swarm workers remain backend-only and must not write the user-facing progress card.

## Context-safe continuation work

A single user turn can contain hundreds of model/tool messages. Preserve the
finite chat budget: for a resumed task first read the latest checkpoint and
current diff/status, not the whole repository, commit history or old chat.
Prefer narrow local grep/read ranges (normally 40-100 lines) and command
outputs of roughly 1,000-2,000 tokens. Increase only for a specific unresolved
question. Keep complete test logs and detailed evidence on disk; return the
exit code, failures, audit id and next action instead of replaying full logs.
Do not repeatedly rediscover an already loaded tool catalogue or fetch the
same unchanged file/commit. A failed local identity proof is a routing blocker,
not permission to spend the whole turn rebuilding project history through
remote fetch_file/fetch_commit. Use the exact authorized compatibility path
once, preserve a bounded checkpoint and report the unresolved boundary.
Do not turn read-only investigation into state-changing Worker resume when a
router suggests a tool whose required ticket/worker preconditions are absent.
Goal reports should state new decisions/results and the immediate next step;
put detailed older evidence in a checkpoint path, not nested prior reports.
Never label character/byte accounting as native token usage. Do not enable
Auto Compact, copy full transcripts to a fresh chat, or discard full stored
Goal history merely to avoid the length limit. The UI card is not the only
place tool results consume context.

## Execution approval

When the user explicitly asks this DevSpace Ultra plugin session to investigate, research, diagnose, audit, inspect, or run a non-destructive read-only probe, treat that request itself as approval to begin immediately. Do not insert a separate “continue?”, “start?”, or design-approval checkpoint before gathering evidence.

Only add a new confirmation when a later step crosses into a materially different destructive, production-mutating, service-stopping, credential-changing, publishing, or otherwise higher-risk action that was not already authorized by the user.

## Interactive ChatGPT progress routing

Every user-facing ChatGPT Classic Main conversation uses one conversation-scoped floating DevSpace progress narration card. Never rely on, create, or remount the retired inline black Goal Dock or inline Plan Card as the progress surface.

Before the first substantive work tool in any task expected to require more than one tool call, more than roughly 30 seconds, or multiple verification gates, start or resume exactly one conversation-bound DevSpace Plan, then complete the mandatory opening `devspace_progress_report` preflight above. When the requested outcome needs autonomous continuation across assistant turns, start or resume Goal Mode first and keep a fresh turn-scoped Plan beneath it. Keep Goal and Plan state current as execution structure and backend telemetry; neither tool events nor timers may author visible narration.

Visible progress is authored only by the working Agent. Call `devspace_progress_report` when a meaningful medium-sized step has completed, an important verification result is available, the execution direction materially changes, or a genuine blocker is useful to report. During ongoing non-atomic work, the Agent must not leave more than ten minutes between its own natural-language reports; ten minutes is an Agent reporting ceiling only. No timer, supervisor, overlay, or hidden relay may send a ten-minute reminder, create a synthetic user turn, or project reminder prose. A rescue is a separate safety action: it may run only after at least twenty minutes and only when the exact conversation has authoritative evidence that its prior turn was interrupted or left incomplete. A page that remains visibly generating with the user's request still latest may count as incomplete only after the full twenty-minute window contains neither a fresh Agent report nor a newly observed substantive tool invocation, followed by a second exact-page confirmation; fresh activity resets only that conversation's rescue clock. A normally completed or explicitly cancelled turn must disarm rescue immediately. Runtime keys only locate pages; the exact conversation ID owns narration and rescue state. Low-level tool events, timers, heartbeat rows, step counters, and generic status boilerplate must never be shown as narration. Write the update yourself in natural language for this user and current task. The report binds to the current authoritative conversation and waits for identity correlation instead of failing on a short wall-clock deadline. Do not expose hidden reasoning, and do not create reloads or navigation merely to update progress. A genuinely atomic one-tool task may leave the blank conversation card untouched.

Before entering any long external wait, process watch, CI watch, or other phase that may keep the same assistant turn occupied long enough for the latest report to cross the ten-minute ceiling, write a useful Agent-authored report first. When that wait returns, report the material result before starting another long phase. This is still Agent-authored progress: no watchdog or timer invents the text, and the rule exists specifically so an otherwise healthy long wait cannot silently trip the progress safety boundary.

The only visible text emitted by a verified twenty-minute interrupted-turn rescue is exactly `- 繼續`. All interruption checks, ownership rules, deduplication, and continuation instructions remain backend-owned; never expand that rescue into policy prose or ask the resumed Agent to repeat a long recovery checklist.

For every qualifying interactive Main task, this is an execution requirement rather than optional presentation polish. Write the first useful report as soon as the first medium-sized result, verified direction, or real blocker exists; do not wait until several large phases have accumulated. Before starting another long phase, check that the current conversation has received a useful Agent-authored report within the preceding ten minutes. If the direct progress recipient is temporarily omitted, disabled, times out, or reports unavailable identity, immediately use the documented exact-conversation compatibility bridge once and continue only after the report is verified on this conversation's card or a genuine progress-routing blocker has been reported. Pass `--expected-conversation-id <current-id>` whenever the current ID is known; the bridge must inspect the Runtime's live page URL and reject stale authority rows instead of selecting another or prior conversation. Never compensate by asking a timer, supervisor, another Agent, or another conversation to author the text.

## Capability routing contract

### Provider conversation identity is not a transport session

OpenAI's official Plugins reference defines `_meta["openai/session"]` as an
anonymized conversation ID. Treat it separately from reusable `mcp-session-id`
and browser-session aliases. The `openai-conversation-binding` module accepts
it only after OAuth/resource validation, keys it with the authenticated client,
subject and organization, and requires an initial exact-page receipt or an
explicit owner-authorized local bootstrap. Reuse still verifies the exact live
conversation page; conflicts fail closed. Do not import legacy session maps.

For a Pro/background turn whose original pending progress receipt is not
rendered, the working Agent may use the existing local bridge once with
`bind-progress --runtime-key <verified-main> --expected-conversation-id <current-id> --claim-id <original-pending-claim>`.
This is an explicit operator pairing, not a native receipt claim: it needs the
local owner credential, validates the actual page, and uses only the message
and provider identity retained from the original authenticated request. It
never accepts a caller-supplied provider key or replacement message. Confirm
actual card text afterwards. Other chats cannot inherit this provider key.

Reference: https://developers.openai.com/plugins/reference

Routing is a Local Gateway product layer, not an informal prompt convention. Use `devspace_route` once at the start or resumption of a non-trivial task before generic implementation work. It is the single harness across direct tools, Agent Skills, capability plugins, MCP servers/tools, workflows, and application runtimes. After `open_workspace`, pass its `workspaceId` to `devspace_route` whenever project-local, user, or trusted plugin Agent Skills may apply. Follow every returned `routeChain` entry and its exact `nextAction`; discovery, catalog listing, or reading a Skill is never completion by itself. Use `capability_route` or `tool_search` only when `devspace_route` explicitly delegates to those compatibility sub-routers or when the user specifically requests a lower-level catalog search.

### Codex native browser gate

For ordinary Chrome, Edge, or other visible browser-window work, use `codex_computer_use`; the obsolete self-built Chrome-extension driver has been removed and must not be recreated or used as a fallback. Read the trusted `codex-computer-use` `SKILL.md`, then follow the native `@oai/sky` sequence: `list_windows` or `list_apps`, choose one returned browser window, call `get_window_state`, perform at most one state-changing action, and immediately call `get_window_state` again. Navigate through the visible address bar and native key actions. Never add a second browser driver through Chrome Debugger/CDP, Selenium, Playwright, SendInput, PowerShell UI automation, or a custom extension. Computer Use must not operate ChatGPT/Codex UI, terminals, password/authentication/security dialogs, or other prohibited surfaces.

Every Plugin/MCP connection is conversation-isolated. Never reuse a shared stateful application connection across ChatGPT conversations. For Blender, preserve work already in progress: when exactly one open, unclaimed Blender MCP runtime exists, `blender_mcp` may adopt it into the current conversation without restarting Blender. Once adopted, use that runtime's isolated connection for every read, mutation, screenshot, render, and save. When a conversation starts a future Blender project, call `blender_runtime(action=start)` to obtain a new process and port. Never guess when multiple unclaimed runtimes exist, never attach to a runtime owned by another conversation, and never stop another Agent's process.

The floating progress narration card is written only by the Agent through `devspace_progress_report`. Write one natural-language update after each meaningful medium-sized step, important verification, material direction change, or genuine blocker, and during active non-atomic work keep the silent interval below ten minutes. Do not report every tool call or turn this ceiling into mechanical boilerplate. The liveness supervisor must remain silent at ten minutes; only a verified interrupted or incomplete turn may receive one rescue after twenty minutes, and normal completion or cancellation disarms that episode. A useful report should tell the user what has just become true and what the next medium step is; it must not imitate a status template, heartbeat, trace, or program log.

Visible same-round Goal Recovery is retired. Current ChatGPT Desktop can expose host follow-up payloads in the user's composer, so no Goal guard, host RPC, app relay, CDP path, or fallback may dispatch `[DEVSPACE_GOAL_ROUND_RECOVERY]` or any Goal control metadata. Rescue alone may emit the exact visible user text `- 繼續`, and only after the ordinary exact-conversation interrupted-turn checks succeed. When that Rescue resumes a still-working Goal round, read backend Goal/Plan state and continue the same round without `devspace_goal_round_begin`. Normal continuation after a successful `devspace_goal_turn_report` remains a separate backend-owned path and must never fall back to visible composer automation. Never activate/show a window, navigate/reload a page, select by Runtime alone, or silently re-enable the retired recovery through legacy configuration.

Use progressive disclosure. Route from bounded names, aliases, descriptions, Codex-style `agents/openai.yaml` interface metadata, default prompts, declared tool dependencies, structured exclusions, trust/availability, exposure, and implicit-invocation policy. Read only the selected `SKILL.md`; inspect only the selected plugin or deferred MCP server; never bulk-load the full catalog. An explicit-only skill may be shown as blocked but must not be selected unless the user names it. A structured negative trigger is an applicability gate, not a small ranking penalty.

Plugin authors should provide precise positive and negative routing boundaries. Prefer `routing.aliases`, `routing.exclude`, `routing.priority`, and `policy.allow_implicit_invocation` in `devspace-plugin.json`, plus `interface.display_name`, `interface.short_description`, `interface.default_prompt`, `dependencies.tools`, and `policy.allow_implicit_invocation` in each skill's `agents/openai.yaml`. Tool names and descriptions must identify the actual operation and its prerequisites because they are part of the model-visible routing surface and Stable Gateway compatibility fingerprint.

For ordinary capability and linked Codex MCPs, `capability_connection` is the connection authority and every ChatGPT conversation receives an isolated MCP client/session transport even when the provider itself is stateless. Blender is the deliberate exception: its application runtime is isolated by `runtimeId` + Blender process + loopback port, not locked to one ChatGPT conversation, so a later conversation can continue the same open `.blend` and MCP session after context handoff. Do not infer a Blender target when several runtimes are online; pass the intended `runtimeId` explicitly. Other stateful application services remain bound by plugin/server/instance/runtime/conversation, have no lease timeout or arbitrary count ceiling, reconnect on the next real call after a transport failure, and are released only explicitly or at Local Gateway shutdown.

For live Blender work, the guidance packages (`arjun988-blender-skills`, `blender-retopology`) do not themselves prove that Blender was changed. Use `blender_runtime` to discover/start/attach Blender processes and identify each by `runtimeId` + process + port, then pass that `runtimeId` to `blender_mcp`. A Blender runtime may be continued by a new conversation; conversation identity is only an advisory recent-use hint, never an ownership lock. If exactly one Blender runtime is online it may be resumed automatically; if several are online, select the intended `runtimeId` explicitly. Call `action=list` only when that runtime's live schema is unknown, then immediately call `action=call` with a returned tool. Use `execute_blender_code` for mutations and Blender screenshot/summary tools for readback; never stop after merely listing the Blender MCP directory.

### Host lazy-tool fallback

A ChatGPT host may expose only part of a large MCP catalogue to one model turn. If `exec_command` is callable but a deferred `blender_runtime`, `blender_mcp`, or `devspace_progress_report` recipient is omitted, do **not** wait for the palette, repeatedly reconnect, restart Blender, or create a replacement runtime. Immediately call the installed compatibility entry point through `exec_command`:

`devspace-conversation-bridge <status|list|call|progress> --runtime-key <current-main-key> --expected-conversation-id <current-id> ...`

On a legacy `@waishnav/devspace` installation where the npm bin link has not yet been refreshed, the equivalent local entry is `node "%APPDATA%\npm\node_modules\@waishnav\devspace\scripts\devspace-conversation-bridge.mjs" ...`.

The bridge resolves the authoritative conversation, rejects a Blender runtime owned by another conversation, and routes the already assigned runtime through the same isolated `CapabilityRuntime` transport. For Blender, always pass the known `runtimeId`; run `status`, then `list` only if the live schema is unknown, then `call` a returned tool. For narration, the working Agent writes its own natural-language text and uses `progress --message-file <file>`. The bridge must never choose between multiple unclaimed runtimes or terminate/restart an existing Blender process.
