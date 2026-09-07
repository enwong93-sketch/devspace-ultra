# DevSpace Auto Compact capability

This capability documents and inspects the one DevSpace Auto Compact implementation. Do not create a second summarizer, browser automation flow, or fresh-chat fallback.

## Required semantics

- The user-facing ChatGPT Classic conversation remains continuous even when ChatGPT assigns a new backend conversation ID to a context-truncation continuation branch.
- A rollover is Auto Compact only when the target carries a bounded selective hidden capsule and is measurably smaller than the source. Full old mapping/transcript inheritance and zero-context continuation are both invalid.
- Preserve the Goal objective and success criteria, active Plan frontier, hard user constraints, accepted decisions, completed-work summary, blockers, next actions, important file references, test evidence, and durable memory references.
- Exclude raw conversation mapping, verbatim old transcript, raw tool-output history, hidden chain-of-thought, duplicate progress chatter, expired transport state, and credentials.
- Rebind Goal, Plan, MCP conversation authority, progress narration, and Host Overlay only after target verification succeeds. Fail closed and retain the old authority on verification failure.
- Never fabricate exact context usage. Exact native token fields may be unavailable; payload-byte and current-branch message reduction remain valid compression evidence when explicitly labelled.
- Do not create a synthetic user message or reload/navigate the ChatGPT page as a recovery substitute.

Read `skills/auto-compact/SKILL.md` before changing the Auto Compact transport, capsule contract, or acceptance gates.
