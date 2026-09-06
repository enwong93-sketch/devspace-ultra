# Progress evidence integrity — 2026-09-07

Scope: continue the existing v0.5 working tree; do not reset, branch away from, or overwrite earlier changes. This is a backend-only correction, not a redesign of the Windows/Classic interface. PowerMem is the existing local service shared by Codex and ChatGPT Classic (`codex-global`, namespace `global`); do not create another store. Its endpoint was recovered from the existing Codex configuration. A direct MCP discovery call was denied; do not reroute that denied read.

## Defects to prove before fixing

1. A durable active Goal and a timer heartbeat are incorrectly narrated as proof of executing work and future automatic continuation.
2. The progress supervisor chooses the most recently updated Goal globally rather than the native conversation associated with the tool call.
3. HTTP status is not a tool result: HTTP 200 can carry `isError:true`, and accepting an MCP request is not completing its handler.
4. Every timer/event retains a full snapshot in an unbounded promise chain when disk writes are slow.

## Gates

- [x] RED tests: idle/stale heartbeat must not manufacture work; native conversation A cannot update Goal B; unidentified calls cannot be assigned to a bound Goal; concurrent calls remain independently pending; restart cannot resurrect an executing tool from a saved timestamp.
- [x] GREEN implementation: preserve service heartbeat but expose evidence state separately, correlate starts/results, and retain only bounded current progress snapshots. No timer performs conversation recovery or other control operations.
- [x] RED/GREEN real MCP in-memory integration: start at actual handler entry, end only after actual return/throw, respect `isError`, and exclude status polling. Observation must never break tool execution.
- [x] Wire instrumentation to all ordinary registered tools and remove HTTP-success inference/double counting; retain the native identity observer and binding rules.
- [x] Focused tests, static wiring, full `npm test`, and an isolated bounded-memory canary. Do not claim production deployment or frontend timeout recovery from these gates.
- [x] Append exact evidence and remaining blockers to the rolling handoff and continuation capsule. Saved as `capsule_9c68087d3dac4e24` under the existing v0.5 continuity key; production deployment remains pending.

## Source basis

- MCP progress is associated with an in-progress request, and must stop on completion: https://modelcontextprotocol.io/specification/2025-03-26/basic/utilities/progress (consulted as request-lifetime background, not a claim about the latest negotiated version).
- MCP tool-result errors differ from transport errors; inspect the installed SDK's McpServer tool handler and the project's tool results.
- Node fs/promises operations are not synchronized; concurrent modifications require application-level serialization: https://nodejs.org/api/fs.html#promises-api
- Installed SDK source inspection shows StreamableHTTP transport dispatches `onmessage` separately; use actual handler boundaries rather than an HTTP-success heuristic.

Safety: no ChatGPT refresh, Retry click, synthetic user message, guessed conversation identity, automatic recovery dispatch, public port exposure, credential changes, service restart or bypass of a safety decision in this stage.

## Verified implementation result

The instrumentation wraps the complete SDK `tools/call` request handler through the public `setRequestHandler` API before tool registration. A callback-only wrapper was explicitly rejected by a RED output-validation test: SDK validation errors happen after the callback returns. Late observation and legacy-counter migration also have RED/GREEN coverage.

Final `verify:goal-progress`: 15 PASS, 0 FAIL. Final full `npm test`: PASS. The isolated real-GoalRuntime/disk canary completed 4096 operations at 64-way concurrency with actual total V8 heap limit 512 MiB; sampled peak 7.8 MiB and retained heap 5.1 MiB after both waves. This does not validate full-Core RSS or production frontend recovery.

The initial old-space-only canary configuration was rejected because Node v25.4.0 reported total heap limit 704 MiB despite `--max-old-space-size=512`. The fixed gate uses old-space 464 MiB + semi-space 16 MiB and checks the actual limit before running. See Node CLI primary documentation: https://nodejs.org/api/cli.html

Production deployment and actual no-refresh frontend/continuation acceptance remain PENDING. No production process was restarted or switched in this stage.
