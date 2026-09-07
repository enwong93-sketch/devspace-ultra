import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [retention, gateway] = await Promise.all([
  readFile(new URL("../dist/log-retention.js", import.meta.url), "utf8"),
  readFile(new URL("./devspace-stable-gateway.mjs", import.meta.url), "utf8"),
]);

assert.match(retention, /export async function trimAppendOnlyLog/);
assert.match(retention, /await open\(path, "r\+"\)/);
assert.match(retention, /await handle\.read\(/);
assert.match(retention, /await handle\.truncate\(0\)/);
assert.doesNotMatch(retention, /readFile\s*\(/, "Retention must never read an entire log into V8 memory.");
assert.match(retention, /DEFAULT_FILE_LIMIT_BYTES = 16 \* MIB/);
assert.match(retention, /DEFAULT_KEEP_TAIL_BYTES = 4 \* MIB/);
assert.match(retention, /DEFAULT_TOTAL_LIMIT_BYTES = 256 \* MIB/);
assert.match(retention, /DEFAULT_MAX_FILES = 256/);
assert.match(retention, /DEFAULT_MAX_AGE_MS = 14 \* 24 \* 60 \* 60_000/);
assert.match(retention, /setInterval\(/);
assert.match(retention, /this\.timer\.unref\?\.\(\)/);
assert.match(retention, /entry\.isSymbolicLink\(\)/);
assert.match(retention, /actions\.slice\(0, 512\)/);
assert.match(retention, /logs are observability, never authority/i);

assert.match(gateway, /createLogRetentionSupervisor/);
assert.match(gateway, /roots:\s*\[join\(options\.configDir, "logs"\), options\.controllerOptions\.logDir\]/);
assert.match(gateway, /await logRetention\.start\(\)/);
assert.match(gateway, /await logRetention\.close\(\)/);

console.log(JSON.stringify({
  ok: true,
  gate: "log-retention-static",
  fullFileReads: false,
  appendInodePreserved: true,
  perFileLimitMiB: 16,
  retainedTailMiB: 4,
  directoryQuotaMiB: 256,
  maxFiles: 256,
  maxAgeDays: 14,
  boundedActionHistory: true,
  gatewayLifecycleWired: true,
}));
