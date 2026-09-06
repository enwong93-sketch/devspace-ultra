#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceRegistry } from "../dist/workspaces.js";
import { loadConfig } from "../dist/config.js";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const count = Math.max(20, Math.min(1000, Number(process.argv[2] || 160)));
const cap = Math.max(1, Math.min(10000, Number(process.argv[3] || 32)));
const fullMode = process.argv.includes("--full");
const config = loadConfig({
  ...process.env,
  DEVSPACE_ALLOWED_ROOTS: packageRoot,
  ...(fullMode ? {} : {
    DEVSPACE_SKILLS: "false",
    DEVSPACE_SUBAGENTS: "false",
    DEVSPACE_PLUGINS: "false",
    DEVSPACE_ARTIFACTS: "false",
  }),
});
const storeRows = new Map();
const store = {
  createSession(input) {
    storeRows.set(input.id, { ...input, createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() });
  },
  getSession(id) { return storeRows.get(id); },
  touchSession(id) {
    const row = storeRows.get(id);
    if (row) row.lastUsedAt = new Date().toISOString();
  },
};
const registry = new WorkspaceRegistry(config, store, { maxInMemoryWorkspaces: cap });

function mb(value) { return Math.round((Number(value || 0) / 1024 / 1024) * 10) / 10; }
function snap(index) {
  globalThis.gc?.();
  const memory = process.memoryUsage();
  return {
    index,
    inMemory: registry.inMemorySize,
    persisted: storeRows.size,
    heapUsedMb: mb(memory.heapUsed),
    rssMb: mb(memory.rss),
  };
}

const samples = [snap(0)];
for (let index = 1; index <= count; index += 1) {
  await registry.openWorkspace({ path: packageRoot, mode: "checkout" });
  if (index % 20 === 0 || index === count) samples.push(snap(index));
}
const first = samples[0];
const last = samples.at(-1);
console.log(JSON.stringify({
  ok: true,
  gate: "workspace-memory-stress",
  count,
  cap,
  fullMode,
  first,
  last,
  heapGrowthMb: Math.round((last.heapUsedMb - first.heapUsedMb) * 10) / 10,
  samples,
}));
