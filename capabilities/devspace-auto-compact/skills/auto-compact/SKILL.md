---
name: devspace-auto-compact
summary: Build, inspect, or validate DevSpace UI-continuous selective context compression for ChatGPT Classic.
---

# DevSpace Auto Compact

Use this skill when work concerns context pressure, context truncation, compact capsules, backend continuation branches, Goal/Plan continuity, or Auto Compact acceptance.

## Product definition

A successful compact operation has two identities:

- **UI continuity identity:** stable logical key such as `goal:<goalId>`, presented to the user as one continuous conversation.
- **Backend conversation identity:** ChatGPT may assign a new conversation ID to the compact continuation branch.

Changing the backend ID is neither success nor failure by itself. The operation is accepted only when all conditions below hold.

## Capsule contract

The hidden capsule must preserve:

1. Goal objective and success criteria.
2. Current user intent and hard constraints.
3. Accepted decisions and concise completed-work summary.
4. Active Plan frontier, blockers, and next actions.
5. Current volatile-state warning and required re-checks.
6. Important files, commits, IDs, tests, and evidence.
7. PowerMem/handoff references needed to recover durable context.

It must exclude:

1. Full conversation mapping.
2. Verbatim old transcript.
3. Raw tool-output history.
4. Hidden chain-of-thought or reasoning content.
5. Duplicate progress chatter.
6. Expired request/session transport state.
7. Credentials and secrets.

## Acceptance gates

- Capsule is non-empty and contains the required continuity categories.
- Capsule is within the configured character/token carry budget.
- At least one measurable ratio—exact input tokens, payload bytes, or current-branch message count—is below the maximum carry ratio.
- Target backend conversation ID differs from the source when a continuation branch is used.
- Target contains the hidden capsule and a completed assistant continuation; user-turn mode also contains the original visible user message unchanged.
- Target payload/current branch is materially smaller than the source.
- The hidden source marker, capsule fingerprint, and UI continuity key match.
- Goal, Plan, MCP authority, progress narration, and Host Overlay migrate only after verification.
- No page reload, navigation recovery, synthetic user message, full-history inheritance, or zero-context continuation occurs.

## Operating sequence

1. Read current Context Guardian and native conversation descriptor.
2. Build a selective capsule from authoritative Goal/Plan/PowerMem state.
3. Create and persist the compression contract.
4. At an idle safe boundary, arm either the next real user turn or a hidden Goal continuation request.
5. Rewrite only the matching ChatGPT request, preserving the visible user message when present.
6. Verify target branch size, continuity metadata, and assistant completion.
7. Migrate backend authorities transactionally; roll back on failure.
8. Record the result in the capsule state, narration card, handoff, and PowerMem.

Use `capability_call` on `auto-compact-status` for a secret-free operational snapshot. Never infer success from a changed URL or backend ID alone.
