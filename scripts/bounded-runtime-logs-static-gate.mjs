import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [coreSlot, fixedBackend, config, server, boundedLogs, boundedDiagnostics] = await Promise.all([
  readFile("scripts/devspace-core-slot.mjs", "utf8"),
  readFile("scripts/devspace-fixed-backend.mjs", "utf8"),
  readFile("dist/config.js", "utf8"),
  readFile("dist/server.js", "utf8"),
  readFile("dist/bounded-log-files.js", "utf8"),
  readFile("dist/bounded-diagnostics.js", "utf8"),
]);

assert.match(coreSlot, /createBoundedLogWriter/);
assert.match(coreSlot, /stdio:\s*\["ignore",\s*"pipe",\s*"pipe"\]/);
assert.match(coreSlot, /child\.stdout\.pipe\(stdoutLog\)/);
assert.match(coreSlot, /child\.stderr\.pipe\(stderrLog\)/);
assert.doesNotMatch(coreSlot, /openSync\(stdoutPath,\s*"a"\)/);
assert.match(coreSlot, /inMemoryHistoryRetained:\s*false/);

assert.match(fixedBackend, /rotateLogFileSetSync\(stdoutPath, logOptions\)/);
assert.match(fixedBackend, /rotateLogFileSetSync\(stderrPath, logOptions\)/);
assert.match(fixedBackend, /inMemoryHistoryRetained:\s*false/);

assert.match(config, /requests:\s*env\.DEVSPACE_LOG_REQUESTS === undefined \? false/);
assert.match(server, /logEvent\(config\.logging, "debug", "mcp_session_created"/);
assert.match(server, /logEvent\(config\.logging, "debug", "mcp_session_closed"/);
assert.match(server, /logEvent\(config\.logging, "debug", "mcp_session_cleanup"/);

assert.match(boundedLogs, /DEFAULT_LOG_MAX_BYTES/);
assert.match(boundedLogs, /DEFAULT_LOG_BACKUPS/);
assert.match(boundedLogs, /highWaterMark:\s*64 \* 1024/);
assert.match(boundedLogs, /buffer\.subarray\(buffer\.length - this\.options\.maxBytes\)/);
assert.doesNotMatch(boundedLogs, /chunks\s*=\s*\[\]|this\.chunks/);
assert.match(server, /incrementBoundedCounter\(CHAT_SWARM_UI_DIAGNOSTICS\.mcpMethodCounts/);
assert.match(server, /incrementBoundedCounter\(CHAT_SWARM_UI_DIAGNOSTICS\.resourceReadUris/);
assert.match(server, /pruneStaleAtomicTempFiles\(config\.stateDir/);
assert.match(server, /olderThanMs:\s*15 \* 60_000/);
assert.match(boundedDiagnostics, /while \(keys\.length >= normalizedLimit\)/);

console.log(JSON.stringify({
  ok: true,
  gate: "bounded-runtime-logs-static",
  liveCoreRotation: true,
  fixedBackendStartupRotation: true,
  requestLoggingOptIn: true,
  sessionLifecycleDebugOnly: true,
  outputHistoryRetainedInHeap: false,
  diagnosticKeyCardinalityBounded: true,
  orphanAtomicTempsPruned: true,
}));
