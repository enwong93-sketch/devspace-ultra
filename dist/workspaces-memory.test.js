import assert from "node:assert/strict";
import { WorkspaceRegistry } from "./workspaces.js";

const fakeConfig = {};
const fakeStore = { touchSession() {} };
const registry = new WorkspaceRegistry(fakeConfig, fakeStore, { maxInMemoryWorkspaces: 3 });
for (let index = 1; index <= 4; index += 1) {
  registry.rememberWorkspace({ id: `ws-${index}`, root: `root-${index}` });
}
assert.equal(registry.inMemorySize, 3, "workspace context cache must have a hard bound");
assert.equal(registry.workspaces.has("ws-1"), false, "oldest workspace context must be evicted first");
assert.equal(registry.workspaces.has("ws-4"), true);

assert.equal(registry.touchWorkspaceMemory("ws-2")?.id, "ws-2");
registry.rememberWorkspace({ id: "ws-5", root: "root-5" });
assert.equal(registry.workspaces.has("ws-3"), false, "recently touched workspace must survive the next LRU eviction");
assert.equal(registry.workspaces.has("ws-2"), true);
assert.deepEqual([...registry.workspaces.keys()], ["ws-4", "ws-2", "ws-5"]);

registry.rememberWorkspace({ id: "ws-2", root: "root-2-updated" });
assert.equal(registry.inMemorySize, 3, "refreshing an existing workspace must not grow the cache");
assert.equal(registry.workspaces.get("ws-2")?.root, "root-2-updated");
assert.deepEqual([...registry.workspaces.keys()], ["ws-4", "ws-5", "ws-2"]);

console.log(JSON.stringify({ ok: true, gate: "workspace-memory-lru", hardBound: true, lru: true }));
