# MCP session memory stability

## Failure reproduced

A localhost, OAuth-authenticated Streamable HTTP rehearsal at the native-content
forwarding baseline retained about 1.28 MiB per disconnected session. After 250
clients performed initialize/listTools/call/close, registry size was 250 and
post-GC heap rose from 56.67 to 376.54 MiB. Closing the registry returned heap to
57.14 MiB. Explicit terminateSession (HTTP DELETE), followed by client.close,
kept registry size zero and post-GC heap around 56–57 MiB over 250 sessions.

The SDK's close is a connection disconnect, not session termination. Preserving
reconnectable sessions is intentional, but a 24-hour idle TTL without a capacity
bound allowed enough live server/tool-schema graphs to exhaust the heap before
the timer ran. A production log had 3,135 creates and no close records before a
roughly 4 GiB V8 OOM; the measured per-session cost is consistent with that event.
This is strong causal evidence for retention pressure, not a production heap
snapshot proving the exclusive source of every allocation.

## Behavior

McpSessionRegistry defaults to 256 sessions. Admission reserves capacity before
asynchronous initialization and closes the least-recently-used inactive session
when necessary. HTTP requests, including open SSE streams, hold a request lease
until response finish or disconnect. Active requests cannot be evicted by either
capacity pressure or the idle timer. If all slots are active/reserved, initialize
returns HTTP 503 with Retry-After rather than closing active work.

An evicted idle client receives the existing Unknown MCP session HTTP 404 and
must reinitialize. OAuth credentials, persistent workspaces and the shared
capability/backend coordinators are unchanged. The 24-hour timeout and five-minute
cleanup interval are unchanged. HTTP DELETE still immediately removes a session.
This bounds session cardinality, not the size of arbitrary tool results or
persistent task histories.

## Verification

- mcp-sessions.test.js: 1,000 admissions, bounded cardinality, LRU ordering,
  concurrent reservations, active-request protection, release/error handling,
  idle cleanup and shutdown.
- mcp-sessions-http.test.js: real OAuth/HTTP, active SSE protection, capacity 503,
  idle eviction 404, surviving session ping, explicit DELETE cleanup.
- Both regressions run in npm run build / verify:ultra.
- Rehearsal after the fix: 750 explicit terminations leave zero sessions; 750
  disconnect-only sessions plateau at 256. Post-GC heap at 250/500/750 disconnects
  is 374.62/383.19/383.98 MiB; explicit cleanup returns to 56.29 MiB.
- 50 Calculator screenshot observations retained no linear image growth
  (58.18 to 58.38 MiB); the shared upstream pool remained one client.

RSS may remain elevated after GC due to allocator/V8 page retention. These are
finite synthetic experiments, not a proof of unlimited uptime or all production
workloads. Monitor both heap and RSS; do not treat raising the heap limit as a
fix. At saturation a client may need to reinitialize; do not blindly replay a
non-idempotent operation after an uncertain response.
