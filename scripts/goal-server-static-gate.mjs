import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");

assert.match(source, /import \{ GoalRuntime \} from "\.\/goal-runtime\.js";/);
assert.match(source, /import \{ registerGoalTools \} from "\.\/goal-tools\.js";/);
assert.match(source, /const GOAL_DOCK_URI = "ui:\/\/devspace\/goal-dock\.html";/);
assert.match(source, /new GoalRuntime\(\{\s*stateDir: config\.stateDir,?\s*\}\)/s);
assert.match(source, /registerAppResource\(server, "DevSpace Goal Dock", GOAL_DOCK_URI,/);
assert.match(source, /new URL\("\.\/ui\/goal-dock\.html", import\.meta\.url\)/);
assert.match(source, /registerGoalTools\(server, goalRuntime, \{\s*resourceUri: GOAL_DOCK_URI,?\s*\}\)/s);
assert.match(source, /createMcpServer\([^)]*goalRuntime/s);
assert.match(source, /await goalRuntime\.close\(\)/);

const resourceIndex = source.indexOf('registerAppResource(server, "DevSpace Goal Dock"');
const toolsIndex = source.indexOf("registerGoalTools(server, goalRuntime");
assert.ok(resourceIndex >= 0 && toolsIndex > resourceIndex, "Goal Dock resource must be registered before Goal tools.");

console.log(JSON.stringify({ ok: true, gate: "goal-server-static" }));
