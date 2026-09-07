import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityRuntime } from "./capability-runtime.js";
import { attachAutoCompactContract } from "./auto-compact-contract.js";

const root = await mkdtemp(join(tmpdir(), "devspace-auto-compact-plugin-"));
const configDir = join(root, "config");
const stateDir = join(root, "state");
const pluginsDir = join(root, "plugins");
const capsuleDir = join(stateDir, "continuity", "capsules");
const pluginRoot = fileURLToPath(new URL("../capabilities/devspace-auto-compact/", import.meta.url));
const priorConfigDir = process.env.DEVSPACE_CONFIG_DIR;
try {
  await mkdir(configDir, { recursive: true });
  await mkdir(capsuleDir, { recursive: true });
  await mkdir(pluginsDir, { recursive: true });
  const capsule = attachAutoCompactContract({
    goal: "Complete DevSpace Auto Compact",
    userIntent: "Continue one user-facing conversation through selective context compression.",
    constraints: ["Preserve Goal/Plan authority", "Do not inherit the full transcript"],
    decisions: ["Backend conversation ID may change"],
    completed: ["Compression contract implemented"],
    currentState: "Goal goal-test and Plan plan-test remain active.",
    files: [{ path: "dist/auto-compact-contract.js", status: "verified" }],
    tests: ["auto-compact-contract passed"],
    blockers: [],
    nextSteps: ["Verify the target continuation is materially smaller"],
    toolState: ["goalId=goal-test", "planId=plan-test", "runtime=main-02"],
    memoryRefs: ["PowerMem:auto-compact-test"],
  }, {
    source: {
      conversationId: "source-conversation",
      currentNode: "source-boundary",
      payloadBytes: 1_500_000,
      branchMessageCount: 2_400,
      textChars: 600_000,
    },
    uiContinuityKey: "goal:goal-test",
    runtimeKey: "main-02",
    goalId: "goal-test",
    planId: "plan-test",
  });
  const capsulePath = join(capsuleDir, "capsule-test.json");
  await writeFile(capsulePath, JSON.stringify({
    id: "capsule-test",
    createdAt: "2026-09-07T10:00:00.000Z",
    status: "verified-continuation",
    continuityKey: "context-guardian:goal:goal-test",
    toConversationId: "target-conversation",
    verifiedAt: "2026-09-07T10:01:00.000Z",
    capsule,
  }));
  await writeFile(join(stateDir, "continuity", "state.json"), JSON.stringify({
    version: 1,
    workerPressure: {},
    capsules: {
      "capsule-test": {
        id: "capsule-test",
        createdAt: "2026-09-07T10:00:00.000Z",
        status: "verified-continuation",
        continuityKey: "context-guardian:goal:goal-test",
        filePath: capsulePath,
        strategy: "selective-hidden-capsule-continuation",
        acceptedCompressionContract: true,
      },
    },
  }));
  await writeFile(join(configDir, "config.json"), JSON.stringify({
    stateDir,
    autoCompactEnabled: true,
    contextGuardianEnabled: true,
    contextGuardianThresholdPercent: 90,
  }));
  process.env.DEVSPACE_CONFIG_DIR = configDir;

  const runtime = new CapabilityRuntime({
    enabled: true,
    pluginsDir,
    registryPath: join(pluginsDir, "registry.json"),
    pluginPaths: [pluginRoot],
  });
  try {
    await runtime.ready;
    const inspected = await runtime.inspect("devspace-auto-compact", { probeMcp: false });
    assert.equal(inspected.enabled, true);
    assert.equal(inspected.trusted, true);
    assert.equal(inspected.tools[0].name, "auto-compact-status");
    assert.equal(inspected.skills.some((item) => /auto-compact[\\/]SKILL\.md$/i.test(item.filePath || item.path || item)), true);

    const called = await runtime.call({
      pluginId: "devspace-auto-compact",
      kind: "tool",
      toolName: "auto-compact-status",
      arguments: { action: "status", continuityKey: "context-guardian:goal:goal-test" },
    });
    const result = called.result;
    assert.equal(result.ok, true);
    assert.equal(result.enabled, true);
    assert.equal(result.strategy, "selective-hidden-capsule-continuation");
    assert.equal(result.latestSelectiveCapsuleAvailable, true);
    assert.equal(result.latest.continuity.sourceConversationId, "source-conversation");
    assert.equal(result.latest.toConversationId, "target-conversation");
    assert.equal(result.latest.compression.fullHistoryInherited, false);
    assert.equal(result.latest.compression.zeroContextContinuation, false);
    assert.ok(result.latest.compression.ratios.payloadByteRatio < 0.25);
    assert.equal(result.stateDirReturned, false);
    assert.equal(result.rawCapsuleContentReturned, false);
    assert.equal(result.credentialsReturned, false);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await runtime.close();
  }

  console.log(JSON.stringify({
    ok: true,
    gate: "auto-compact-plugin",
    builtInCapability: true,
    trustedOperatorPath: true,
    skillDiscovered: true,
    commandToolInvoked: true,
    selectiveCapsuleReported: true,
    rawCapsuleReturned: false,
    statePathReturned: false,
    credentialsReturned: false,
  }));
} finally {
  if (priorConfigDir === undefined) delete process.env.DEVSPACE_CONFIG_DIR;
  else process.env.DEVSPACE_CONFIG_DIR = priorConfigDir;
  await rm(root, { recursive: true, force: true });
}
