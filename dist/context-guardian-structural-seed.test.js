import assert from "node:assert/strict";
import { ContextGuardianRolloverCoordinator } from "./context-guardian-rollover.js";

let descriptorCalls = 0;
let observedTokens = 3_654;
const observations = [];

const contextGuardian = {
  async observeRuntimeSnapshot(input) {
    observations.push(structuredClone(input));
    observedTokens = Math.max(observedTokens, Number(input?.observedTokens || 0));
  },
  async status(runtimeKey) {
    return {
      runtimeKey,
      mode: "chat",
      conversationId: "conversation-large-after-restart",
      currentModelSlug: "gpt-5-6-pro",
      contextWindowTokens: 410_000,
      supportedChatMode: true,
      pressure: {
        stage: observedTokens >= 300_000 ? "prepare" : "normal",
        usageSource: observedTokens > 3_654 ? "classic-conversation-snapshot" : "devspace-ledger",
        usedTokens: observedTokens,
        predictedInputTokens: observedTokens,
        rolloverLimitTokens: 360_000,
      },
    };
  },
};

const contextAdapter = {
  status() {
    return { connected: 1, runtimes: [{ runtimeKey: "main-02", port: 9732 }] };
  },
  async refreshSnapshot(runtimeKey) {
    return {
      ok: true,
      runtimeKey,
      mode: "chat",
      conversationId: "conversation-large-after-restart",
      modelSlug: "gpt-5-6-pro",
      generating: false,
      composerTextChars: 0,
    };
  },
  async nativeConversationDescriptor(runtimeKey) {
    assert.equal(runtimeKey, "main-02");
    descriptorCalls += 1;
    return {
      conversationId: "conversation-large-after-restart",
      currentNode: "node-current",
      defaultModelSlug: "gpt-5-6-pro",
      mappingCount: 3_413,
      branchMessageCount: 3_404,
      payloadBytes: 2_000_000,
      textChars: 1_000_000,
      estimatedTokens: 250_000,
      authenticatedBackendFetch: true,
      rawContentReturned: false,
      credentialsReturned: false,
    };
  },
};

const coordinator = new ContextGuardianRolloverCoordinator({
  contextGuardian,
  contextAdapter,
  continuityRuntime: { async checkpoint() { throw new Error("normal pressure must not checkpoint"); } },
  goalRuntime: { async activeGoals() { throw new Error("normal pressure must not resolve Goal"); } },
  planRuntime: { async activePlans() { throw new Error("normal pressure must not resolve Plan"); } },
  pollMs: 0,
});

try {
  const first = await coordinator.pollOnce();
  assert.equal(first.results[0].action, "normal");
  assert.equal(descriptorCalls, 1);
  assert.equal(observations.length, 2, "metadata refresh and structural usage seed are separate observations");
  assert.equal(observations[0].observedTokens, undefined, "metadata refresh must not invent a token value");
  assert.equal(observations[1].observedTokens, 250_000);
  assert.equal(observations[1].usageSource, "classic-conversation-snapshot");
  assert.equal(observedTokens, 250_000);
  assert.equal((await contextGuardian.status("main-02")).pressure.usageSource, "classic-conversation-snapshot");

  const second = await coordinator.pollOnce();
  assert.equal(second.results[0].action, "normal");
  assert.equal(descriptorCalls, 1, "the 60-second native structural seed cache must prevent repeated full descriptor fetches");
  assert.equal(observations.length, 3, "the cached structural descriptor must not be fetched again; metadata refresh remains a separate non-token observation");
  assert.equal(observations[2].observedTokens, undefined);

  console.log(JSON.stringify({
    ok: true,
    gate: "context-guardian-structural-seed",
    restartLedgerTokens: 3_654,
    structuralSnapshotTokens: 250_000,
    usageSource: "classic-conversation-snapshot",
    exactUsageClaimed: false,
    descriptorFetches: descriptorCalls,
    descriptorCacheBounded: true,
    rawContentReturned: false,
    credentialsReturned: false,
  }));
} finally {
  await coordinator.close();
}
