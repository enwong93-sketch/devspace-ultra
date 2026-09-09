import assert from "node:assert/strict";
import { WorkspaceRegistry } from "./workspaces.js";

const fakeConfig = {};
const fakeStore = { touchSession() {} };
const registry = new WorkspaceRegistry(fakeConfig, fakeStore, { maxInMemoryWorkspaces: 1 });

for (let index = 1; index <= 6; index += 1) {
  registry.rememberWorkspace({ id: `ws-${index}`, root: `root-${index}`, mode: "checkout" });
}
assert.equal(registry.inMemorySize, 6, "workspace contexts must not be evicted by an artificial memory-count ceiling");
for (let index = 1; index <= 6; index += 1) assert.ok(registry.workspaces.has(`ws-${index}`));

const shared = { id: "ws-shared", root: "C:/Project/Same", mode: "checkout", skills: [], skillDiagnostics: [] };
registry.rememberWorkspace(shared);
assert.equal(registry.workspaceIdentities.get(registry.workspaceIdentity("c:/project/same", "checkout")), shared, "Windows path identity must be case-insensitive");

const aliasStore = {
  touchSession() {},
  getSession(id) {
    if (id !== "ws-old-alias") return undefined;
    return {
      id,
      root: "C:/Project/Same",
      mode: "checkout",
      managed: false,
    };
  },
};
registry.store = aliasStore;
registry.assertWorkspaceRootAllowed = (root) => root;
const restored = registry.getWorkspace("ws-old-alias");
assert.equal(restored, shared, "persisted duplicate workspace ids must reuse one shared in-memory context");
assert.equal(registry.workspaces.get("ws-old-alias"), shared);

console.log(JSON.stringify({
  ok: true,
  gate: "workspace-memory-dedupe",
  artificialContextCapRemoved: true,
  sameRootReusesContext: true,
}));
