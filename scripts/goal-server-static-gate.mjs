import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");

assert.match(source, /import \{ GoalRuntime \} from "\.\/goal-runtime\.js";/);
assert.match(source, /import \{ registerGoalTools \} from "\.\/goal-tools\.js";/);
assert.match(source, /import \{ ClassicGoalHostBridge \} from "\.\/goal-host-bridge\.js";/);
assert.match(source, /const GOAL_DOCK_URI = "ui:\/\/devspace\/goal-dock\.html";/);
assert.match(source, /const GOAL_RELAY_URI = "ui:\/\/devspace\/goal-continuation-relay\.html";/);
assert.match(source, /new GoalRuntime\(\{\s*stateDir: config\.stateDir,?\s*\}\)/s);
assert.match(source, /new ClassicGoalHostBridge\(\{\s*beforeDispatch:\s*config\.passiveCore\s*\?\s*undefined\s*:\s*\(\) => primaryDebugGuard\.pollOnce\(\),?\s*\}\)/s);
assert.match(source, /registerAppResource\(server, "DevSpace Goal Dock", GOAL_DOCK_URI,/);
assert.match(source, /new URL\("\.\/ui\/goal-dock\.html", import\.meta\.url\)/);
assert.match(source, /registerAppResource\(server, "DevSpace Goal Continuation Relay", GOAL_RELAY_URI,/);
assert.match(source, /new URL\("\.\/ui\/goal-continuation-relay\.html", import\.meta\.url\)/);
assert.match(source, /const resolveConversation = async \(extra\) => \{[\s\S]*conversationAuthority\.resolveMcpExtra\(extra\)/, "production Goal tools must resolve conversation identity only through the native authority registry");
assert.match(source, /registerGoalTools\(server, goalRuntime, \{\s*resourceUri: GOAL_DOCK_URI,\s*relayResourceUri: GOAL_RELAY_URI,\s*hostBridge: goalHostBridge,\s*onMount:\s*\(\{ goal \}\) => hostOverlayProjection\?\.requestOwnerRebind\?\.\(\{ goalId: goal\?\.id \}\),\s*resolveConversation,?\s*\}\)/s, "Goal tools must receive the native conversation resolver while explicit mount remains read-only for Goal state");
assert.match(source, /createMcpServer\([^)]*goalRuntime[^)]*goalHostBridge[^)]*hostOverlayProjection[^)]*conversationAuthority[^)]*conversationAuthorityReady/s);
assert.match(source, /await goalRuntime\.close\(\)/);

const resourceIndex = source.indexOf('registerAppResource(server, "DevSpace Goal Dock"');
const relayResourceIndex = source.indexOf('registerAppResource(server, "DevSpace Goal Continuation Relay"');
const toolsIndex = source.indexOf("registerGoalTools(server, goalRuntime");
assert.ok(resourceIndex >= 0 && toolsIndex > resourceIndex, "Goal Dock resource must be registered before Goal tools.");
assert.ok(relayResourceIndex >= 0 && toolsIndex > relayResourceIndex, "Goal continuation relay resource must be registered before Goal tools.");

console.log(JSON.stringify({ ok: true, gate: "goal-server-static" }));
