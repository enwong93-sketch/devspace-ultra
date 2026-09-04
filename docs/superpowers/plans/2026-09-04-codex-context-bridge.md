# Codex ContextBridge Implementation Plan

> **Execution mode:** Inline on the existing v0.4.0 working tree per user delegation. Follow TDD for each behavioral task.

**Goal:** Import a selected Codex project/thread into the current ChatGPT/DevSpace conversation as a bounded, sanitized, reusable context capsule in one MCP action.

**Architecture:** Read thread metadata from Codex `state_5.sqlite`, prefer projected `thread_history_1.sqlite` when usable, otherwise stream the exact rollout JSONL. Anchor long imports at the latest Codex `compacted` record, append bounded user/assistant context after it, exclude developer/system/reasoning/raw tool material, redact obvious credentials, persist sanitized capsules in DevSpace state, and return the capsule text in the MCP tool result.

**Spec:** `docs/superpowers/specs/2026-09-04-codex-context-bridge-design.md`

### Task 1: Codex metadata catalog

**Files:**
- Create `dist/codex-context-bridge.js`
- Create `dist/codex-context-bridge.test.js`

- [ ] Create fixture SQLite state/history plus rollout files in a temp directory.
- [ ] RED: tests for list/search by ID/title/cwd/project path/archive state and ambiguity.
- [ ] Implement read-only metadata catalog using `better-sqlite3`.
- [ ] GREEN: thread metadata tests pass.

### Task 2: Streaming rollout extractor

**Files:** same.

- [ ] RED: fixture with developer/user/assistant/reasoning/tool records and compaction boundary.
- [ ] Assert importer never uses full-file `readFile` for rollout content.
- [ ] Implement line streaming with bounded retained state.
- [ ] Include latest compaction + post-compaction user/assistant messages; omit excluded record classes/images.
- [ ] GREEN: extraction/order/dedup tests pass.

### Task 3: Sanitization and capsule budgeting

**Files:** same.

- [ ] RED: bearer/API/private-key/password fixture redactions.
- [ ] RED: size/message truncation and newest-message preference.
- [ ] Implement obvious-secret redactor, per-message cap, global character cap, redaction/truncation metadata.
- [ ] GREEN.

### Task 4: Local sanitized capsule store

**Files:**
- Modify `dist/codex-context-bridge.js`
- tests.

- [ ] RED: persisted capsule under temp DevSpace state, no raw tool/reasoning fields.
- [ ] Implement atomic sanitized JSON persistence and lookup by capsule/thread ID.
- [ ] GREEN.

### Task 5: MCP tools

**Files:**
- Modify `dist/server.js`
- Create `scripts/codex-context-bridge-static-gate.mjs`

Tools:
- `context_bridge_codex_list`
- `context_bridge_codex_import`
- `context_bridge_codex_capsule`

- [ ] RED static/tool registration expectations.
- [ ] Register bounded schemas and call shared ContextBridge runtime.
- [ ] Import tool returns the sanitized `contextText` in normal MCP text content plus structured metadata so current ChatGPT immediately gains context.
- [ ] GREEN.

### Task 6: CLI

**Files:**
- Modify `dist/cli.js`
- tests/static gate.

Commands:
- `devspace context codex list`
- `devspace context codex import --thread <id>`
- `devspace context codex latest --project <path>`

- [ ] Implement thin adapters to same runtime; no duplicate extraction logic.
- [ ] Verify bounded output/no secrets.

### Task 7: Real Codex live gate

**Files:**
- Create `scripts/codex-context-bridge-live-gate.mjs`

- [ ] Pick a real harmless existing Codex coding/research thread.
- [ ] Verify list finds it.
- [ ] Import exact thread and verify no excluded roles/reasoning/tool output.
- [ ] Verify compaction anchor when present and bounded recent context.
- [ ] Reopen persisted capsule and compare hash/content.
- [ ] Never print the full user context in gate logs; report only IDs prefix/title length/count/hash-style evidence.

### Task 8: Documentation and release verification

**Files:**
- Modify `README.md`, `CHANGELOG.md`, `package.json`.

- [ ] Add `verify:context-bridge` and include deterministic tests/static gate in `verify:ultra`.
- [ ] Run `npm run verify:context-bridge`, `verify:edge-static`, `verify:runtime-identity`, `verify:ultra`.
- [ ] Run `git diff --check`, package dry-run, user-path/credential scan.
- [ ] Record live ContextBridge/Multi-Main/fixed-edge evidence without committing user-specific source data.
