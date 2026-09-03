import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatSwarmCoordinator } from "../dist/chat-swarm.js";
import { contextPressure, normalizeCompactCapsule } from "../dist/conversation-continuity.js";

const temp = await mkdtemp(join(tmpdir(), "devspace-auto-compact-stress-"));
const rotations = Math.max(10, Math.min(2_000, Number(process.env.DEVSPACE_COMPACT_STRESS_ROTATIONS || 500)));

try {
  const coordinator = new ChatSwarmCoordinator({ stateDir: temp });
  const created = await coordinator.create({ name: "auto-compact-stress", workerSlots: 1, peer: { identitySource: "stress" } });
  const worker = await coordinator.join({ inviteCode: created.inviteCode, label: "Runtime-31", peer: { identitySource: "stress-0" } });
  const originalWorkerId = worker.workerId;
  const initialWorkerToken = worker.workerToken;
  const seenTokenHashes = new Set([coordinator.activeWorkerByLabel("Runtime-31").worker.tokenHash]);
  const seenTickets = new Set();
  let currentPeer;

  for (let i = 1; i <= rotations; i += 1) {
    // Synthetic pressure alternates just below and at the exact 90% boundary.
    const below = contextPressure({ asciiChars: 3_200 }, { contextWindowTokens: 10_000, reserveTokens: 7_999, threshold: 0.90 });
    const at = contextPressure({ asciiChars: 3_200 }, { contextWindowTokens: 10_000, reserveTokens: 8_000, threshold: 0.90 });
    assert.equal(below.shouldCompact, false);
    assert.equal(at.shouldCompact, true);

    await coordinator.markCompactRequiredByLabel("Runtime-31", { utilization: 0.90 + Math.min(0.079, i / 100_000), syntheticCycle: i });
    const checkpoint = i === 1
      ? await coordinator.next({ workerToken: initialWorkerToken, waitMs: 0 })
      : await coordinator.next({ peer: currentPeer, waitMs: 0 });
    assert.equal(checkpoint.state, "compact_required");

    const capsule = normalizeCompactCapsule({
      goal: "Stress-test an ultra-long agent implementation across repeated context windows",
      decisions: [`cycle=${i}`, "preserve worker identity", "rotate private token"],
      currentState: `Completed compact cycle ${i - 1}; preparing cycle ${i}.`,
      files: [{ path: "src/main.ts", status: "modified", notes: `cycle-${i}` }],
      tests: [`cycle-${i - 1}-PASS`],
      nextSteps: [`resume cycle ${i}`, `run cycle ${i + 1}`],
      notes: `workerToken=must-never-survive-${i}-abcdefghijklmnop`,
    });
    assert.match(JSON.stringify(capsule), /REDACTED_SECRET/);
    assert.doesNotMatch(JSON.stringify(capsule), /must-never-survive/);

    const prepared = i === 1
      ? await coordinator.prepareContinuationByWorkerToken(initialWorkerToken)
      : await coordinator.prepareContinuationByLabel("Runtime-31");
    assert.equal(prepared.workerId, originalWorkerId);
    assert.equal(seenTickets.has(prepared.continuationTicket), false);
    seenTickets.add(prepared.continuationTicket);

    currentPeer = { identitySource: "openai/session", identityFingerprint: `stress-peer-${i}` };
    const resumed = await coordinator.resumeContinuation({ continuationTicket: prepared.continuationTicket, peer: currentPeer });
    assert.equal(resumed.workerId, originalWorkerId);
    assert.equal(resumed.continuationCount, i);
    assert.equal(resumed.sessionBound, true);
    assert.equal(resumed.workerToken, undefined);
    const currentHash = coordinator.activeWorkerByLabel("Runtime-31").worker.tokenHash;
    assert.equal(seenTokenHashes.has(currentHash), false);
    seenTokenHashes.add(currentHash);
    if (i === 1) await assert.rejects(() => coordinator.status(initialWorkerToken), /Invalid or inactive worker token/);
    assert.equal((await coordinator.status(undefined, currentPeer)).workerId, originalWorkerId);
  }

  const status = await coordinator.status(undefined, currentPeer);
  const row = status.workers.find((item) => item.workerId === originalWorkerId);
  assert.equal(row.continuationCount, rotations);
  assert.equal(row.compactRequired, false);
  assert.equal(seenTokenHashes.size, rotations + 1);
  assert.equal(seenTickets.size, rotations);

  const persisted = await readFile(join(temp, "chat-swarm-state.json"), "utf8");
  assert.doesNotMatch(persisted, /continuationTicket/);
  assert.doesNotMatch(persisted, /workerToken/);
  assert.doesNotMatch(persisted, /ticketHash.*ticketHash/s);
  // Only the latest token hash and latest continuation identity are persisted;
  // rotation history does not grow linearly with every private token/ticket.
  assert.ok(persisted.length < 80_000, `Unexpected Chat Swarm state growth: ${persisted.length} bytes`);

  await coordinator.closeSwarm({ orchestratorToken: created.orchestratorToken, cancelPending: true });
  await coordinator.close();
  console.log(JSON.stringify({
    ok: true,
    rotations,
    sameWorkerIdentity: true,
    uniqueWorkerTokenHashes: seenTokenHashes.size,
    noContinuationSecretOutput: true,
    uniqueContinuationTickets: seenTickets.size,
    oldTokensInvalidated: true,
    compactSecretsRedacted: true,
    persistedRawTokens: false,
    persistedStateBytes: persisted.length,
  }));
} finally {
  await rm(temp, { recursive: true, force: true });
}
