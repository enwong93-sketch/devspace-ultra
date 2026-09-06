import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const server = await readFile(resolve(root, "dist/server.js"), "utf8");
const registry = await readFile(resolve(root, "dist/mcp-sessions.js"), "utf8");

assert.match(server, /MCP_SESSION_IDLE_TIMEOUT_MS\s*=\s*(?:30|60)\s*\*\s*1_000/, "stale MCP sessions must not be retained for hours");
assert.match(server, /MCP_SESSION_CLEANUP_INTERVAL_MS\s*=\s*5\s*\*\s*1_000/, "session cleanup must run frequently enough to bound reconnect storms");
assert.match(server, /MCP_MAX_INACTIVE_SESSIONS\s*=\s*\d+/, "server must define an inactive-session hard cap");
assert.match(server, /MCP_MAX_EVENT_STREAMS\s*=\s*\d+/, "server must define a global MCP event-stream hard cap");
assert.match(server, /new McpSessionRegistry\(\{[\s\S]*maxInactiveSessions:\s*MCP_MAX_INACTIVE_SESSIONS[\s\S]*maxEventStreams:\s*MCP_MAX_EVENT_STREAMS[\s\S]*\}\)/, "Core must enforce both inactive-session and long-event-stream caps at runtime rather than relying on delayed cleanup");
assert.match(server, /transports\.acquire\(sessionId\)/, "existing session requests must be marked in-flight");
assert.match(server, /transports\.release\(trackedSessionId,\s*\{\s*eventStream:\s*mcpEventStreamRequest\s*\}\)/, "in-flight session and long-event-stream state must be released in a finally path");
assert.match(server, /closeExcessInactive\(MCP_MAX_INACTIVE_SESSIONS\)/, "cleanup must enforce the inactive-session hard cap");
assert.match(registry, /entry\.activeRequests\s*>\s*0/, "idle cleanup must skip in-flight sessions");
assert.match(registry, /closeExcessInactive/, "registry must support bounded inactive-session cleanup");
assert.match(registry, /#enforceInactiveCap\(\)/, "registry register path must synchronously evict excess inactive sessions before reconnect bursts can accumulate");
assert.match(registry, /#enforceEventStreamCap\(\)/, "registry must actively close oldest standalone SSE streams when the event-stream cap is exceeded");
assert.match(registry, /closeStandaloneSSEStream/, "event-stream cap must close the heavy Core stream while allowing public-session identity to recover later");

console.log(JSON.stringify({ ok: true, gate: "mcp-session-lifecycle-static", inFlightProtected: true, staleSessionsBounded: true, eventStreamsBounded: true }));
