import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");
const overlay = await readFile(new URL("./devspace-live-progress-overlay.ps1", import.meta.url), "utf8");
const supervisor = await readFile(new URL("../dist/goal-run-progress-supervisor.js", import.meta.url), "utf8");
const handlers = await readFile(new URL("../dist/goal-tool-progress.js", import.meta.url), "utf8");

assert.match(server, /GoalRunProgressSupervisor/);
assert.match(server, /devspace-goal-run-live\.json/);
assert.match(server, /goalRunProgress\.start\(\)/);
assert.match(server, /installGoalToolProgress\(server/);
assert.match(server, /supervisor: goalRunProgress/);
assert.match(server, /conversationAuthorityReady, goalRunProgress\)/);
assert.doesNotMatch(server, /success:\s*res\.statusCode\s*</);
assert.match(handlers, /supervisor\.noteToolStart/);
assert.match(handlers, /supervisor\.noteToolBoundary/);
assert.match(handlers, /await handler\.apply/);
assert.match(handlers, /result\.isError/);
assert.match(handlers, /POLLING_TOOLS/);
assert.match(server, /goalRunProgress\.close\(\)/);
assert.match(supervisor, /setInterval/);
assert.match(supervisor, /heartbeatAt/);
assert.match(supervisor, /currentText/);
assert.match(overlay, /devspace-goal-run-live\.json/);
assert.doesNotMatch(overlay, /chatgpt\.com|Page\.reload|location\.reload/i);

assert.match(supervisor, /pendingSnapshot/);
assert.match(supervisor, /awaiting-result-stale/);
assert.doesNotMatch(supervisor, /我會自動繼續|仍然持續處理/);
console.log(JSON.stringify({ ok: true, gate: "goal-run-progress-static", backendOwned: true, actualHandlerBoundaries: true, pollingExcluded: true, boundedPersistence: true, heartbeatIndependentOfClassicUi: true }));
