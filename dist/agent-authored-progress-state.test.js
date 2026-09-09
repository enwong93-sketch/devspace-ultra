import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  filterAgentAuthoredProgressState,
  isAgentAuthoredProgressMessage,
  migrateAgentAuthoredProgressState,
} from "./agent-authored-progress-state.js";

assert.equal(isAgentAuthoredProgressMessage({ source: "agent-progress-tool", message: "real" }), true);
assert.equal(isAgentAuthoredProgressMessage({ agentAuthored: true, message: "real" }), true);
assert.equal(isAgentAuthoredProgressMessage({ source: "goal-tool-progress", message: "synthetic" }), false);
assert.equal(isAgentAuthoredProgressMessage({ source: "stable-gateway", title: "Core recovery" }), false);

const filtered = filterAgentAuthoredProgressState({
  version: 3,
  messages: [
    { source: "goal-tool-progress", message: "Tool 42 completed" },
    { source: "agent-progress-tool", message: "I finished the routing gate." },
    { agentAuthored: true, message: "I verified the result." },
  ],
});
assert.equal(filtered.originalCount, 3);
assert.equal(filtered.retainedCount, 2);
assert.equal(filtered.removedCount, 1);
assert.deepEqual(filtered.state.messages.map((entry) => entry.message), [
  "I finished the routing gate.",
  "I verified the result.",
]);
assert.equal(filtered.state.visibleNarrationPolicy, "agent-authored-only");
assert.equal(filtered.state.automaticVisibleNarration, false);

const root = await mkdtemp(join(tmpdir(), "devspace-agent-progress-"));
const statePath = join(root, "devspace-live-progress.json");
try {
  await writeFile(statePath, JSON.stringify({
    version: 2,
    messages: [
      { source: "stable-gateway", detail: "Core recovery completed" },
      { source: "agent-progress-tool", message: "I completed the medium-sized step." },
    ],
  }), "utf8");
  const migrated = await migrateAgentAuthoredProgressState(statePath);
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.removedCount, 1);
  const saved = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(saved.messages.length, 1);
  assert.equal(saved.messages[0].source, "agent-progress-tool");
  assert.equal(saved.visibleNarrationPolicy, "agent-authored-only");
  assert.equal(JSON.parse(await readFile(migrated.backupPath, "utf8")).messages.length, 2);

  const second = await migrateAgentAuthoredProgressState(statePath);
  assert.equal(second.migrated, false);
  assert.equal(second.reason, "already-agent-authored-only");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  gate: "agent-authored-progress-state",
  legacySyntheticMessagesRemoved: true,
  explicitAgentMessagesRetained: true,
  backupCreated: true,
  idempotent: true,
}));
