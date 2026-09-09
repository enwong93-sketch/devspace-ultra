import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const server = await readFile(resolve(root, "dist/server.js"), "utf8");
const registry = await readFile(resolve(root, "dist/mcp-sessions.js"), "utf8");

assert.match(server, /new McpSessionRegistry\(\)/, "Core must use connection-lifecycle cleanup rather than an artificial session-count ceiling");
assert.doesNotMatch(server, /MCP_SESSION_IDLE_TIMEOUT_MS|MCP_MAX_INACTIVE_SESSIONS|MCP_MAX_EVENT_STREAMS|MCP_MAX_SESSIONS|closeExcessInactive|closeIdle\(/, "Core MCP lifetime must not be terminated by idle clocks or count caps");
assert.match(server, /transports\.acquire\(sessionId\)/, "existing session requests must be marked in-flight");
assert.match(server, /transports\.markEventStreamOpen\(trackedSessionId\)/, "Core must bind session lifetime to the real standalone SSE stream");
assert.match(server, /transports\.release\(trackedSessionId,\s*\{\s*eventStream:\s*mcpEventStreamRequest\s*\}\)/, "Core must observe the actual SSE disconnect in a finally path");
assert.match(server, /transports\.closeAll\(\)/, "server shutdown must still close every remaining transport explicitly");

assert.match(registry, /everHadEventStream/);
assert.match(registry, /disconnectObserved/);
assert.match(registry, /clientSessions/);
assert.match(registry, /superseded/);
assert.match(registry, /#closeRetiredIfIdle/);
assert.match(registry, /entry\.activeRequests\s*>\s*0/, "an in-flight tool request must protect its transport after the SSE disconnects");
assert.match(registry, /scheduleMaintenanceGc/, "released per-session MCP server/tool registries must become collectible promptly");
assert.doesNotMatch(registry, /this\.maxInactiveSessions|this\.maxEventStreams|this\.maxSessions|closeIdle\(|closeExcessInactive\(|idleTimeout|setTimeout|SIGKILL/, "session cleanup must be event-driven and must not impose memory/count/time limits or force-kill work");

console.log(JSON.stringify({
  ok: true,
  gate: "mcp-session-lifecycle-static",
  actualDisconnectLifecycle: true,
  clientSessionSupersession: true,
  inFlightProtected: true,
  artificialCapsRemoved: true,
  wallClockTerminationRemoved: true,
}));
