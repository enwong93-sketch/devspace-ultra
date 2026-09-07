import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContextGuardianRuntime,
  normalizeClassicModelCatalog,
  resolveClassicModelWindow,
  registerContextGuardianTools,
  computeContextGuardianPressure,
} from "./context-guardian.js";

const nativeModels = [
  { slug: "gpt-5-6", max_tokens: 137000, title: "GPT-5.6 Sol", reasoning_type: "auto", is_work_mode_model: false },
  { slug: "gpt-5-6-thinking", max_tokens: 262144, title: "GPT-5.6 Sol", reasoning_type: "reasoning", is_work_mode_model: false },
  { slug: "gpt-5-6-pro", max_tokens: 410000, title: "GPT-5.6 Pro", reasoning_type: "pro", is_work_mode_model: false },
  { slug: "gpt-6-pro", max_tokens: 410000, title: "GPT-6 Pro", reasoning_type: "pro", is_work_mode_model: false },
  { slug: "gpt-5.6-sol-wm", max_tokens: 262144, title: "GPT-5.6 Sol", reasoning_type: "reasoning", is_work_mode_model: true },
  { slug: "broken", max_tokens: 0, title: "Broken" },
];

{
  const catalog = normalizeClassicModelCatalog(nativeModels);
  assert.equal(catalog["gpt-5-6"].maxTokens, 137000);
  assert.equal(catalog["gpt-5-6-thinking"].maxTokens, 262144);
  assert.equal(catalog["gpt-5-6-pro"].maxTokens, 410000);
  assert.equal(catalog["gpt-6-pro"].maxTokens, 410000);
  assert.equal(catalog["gpt-5.6-sol-wm"].isWorkModeModel, true);
  assert.equal(catalog.broken, undefined, "invalid/non-positive token windows must be ignored");
  assert.deepEqual(resolveClassicModelWindow(catalog, "gpt-5-6-thinking"), {
    modelSlug: "gpt-5-6-thinking",
    contextWindowTokens: 262144,
    source: "native-classic-model-catalog",
    supportedChatMode: true,
  });
  assert.deepEqual(resolveClassicModelWindow(catalog, "gpt-6-pro"), {
    modelSlug: "gpt-6-pro",
    contextWindowTokens: 410000,
    source: "native-classic-model-catalog",
    supportedChatMode: true,
  });
  assert.equal(resolveClassicModelWindow(catalog, "gpt-5.6-sol-wm").supportedChatMode, false);
  assert.equal(resolveClassicModelWindow(catalog, "unknown-model").contextWindowTokens, null);
}

{
  const estimated = computeContextGuardianPressure({
    contextWindowTokens: 262144,
    snapshotTokens: 150000,
    ledgerTokens: 180000,
    nextInputTokens: 12000,
  });
  assert.equal(estimated.usageSource, "devspace-ledger");
  assert.equal(estimated.usedTokens, 180000);
  assert.equal(estimated.predictedInputTokens, 192000);
  assert.ok(estimated.rolloverLimitTokens < 262144 * 0.90, "estimated usage must reserve more headroom than a blind 90% trigger");
  assert.equal(estimated.stage, "watch");

  const exact = computeContextGuardianPressure({
    contextWindowTokens: 410000,
    hostMeasuredTokens: 340000,
    snapshotTokens: 300000,
    ledgerTokens: 320000,
    nextInputTokens: 10000,
  });
  assert.equal(exact.usageSource, "host-measured");
  assert.equal(exact.usedTokens, 340000);
  assert.ok(exact.uncertaintyReserveTokens < estimated.uncertaintyReserveTokens, "host-measured usage should require less uncertainty reserve");

  const rollover = computeContextGuardianPressure({
    contextWindowTokens: 262144,
    snapshotTokens: 205000,
    ledgerTokens: 210000,
    nextInputTokens: 10000,
  });
  assert.equal(rollover.stage, "rollover");
  assert.equal(rollover.shouldRolloverBeforeNextRequest, true);
}

const stateDir = await mkdtemp(join(tmpdir(), "devspace-context-guardian-"));
try {
  let nativeExactTokens = null;
  const exactUsageAuthority = {
    async status({ conversationId }) {
      if (conversationId === "conv-main-02" && Number.isSafeInteger(nativeExactTokens)) {
        return {
          available: true,
          exactUsedTokens: nativeExactTokens,
          observedAt: "2026-09-05T02:43:30.000Z",
          usageKind: "input_tokens",
          evidencePath: "event.usage.input_tokens",
          source: "classic-native-protocol",
        };
      }
      return { available: false, reason: "exact-native-token-field-not-exposed", source: "unavailable" };
    },
  };
  const first = new ContextGuardianRuntime({ stateDir, exactUsageAuthority });
  await first.ready;
  await first.observeNativeModelCatalog({ models: nativeModels, observedAt: "2026-09-05T02:40:00.000Z" });
  await first.observeTurnRequest({
    runtimeKey: "main-01",
    modelSlug: "gpt-5-6-thinking",
    thinkingEffort: "max",
    conversationId: "conv-main-01",
    observedAt: "2026-09-05T02:41:00.000Z",
  });
  const thinking = await first.status("main-01");
  assert.equal(thinking.currentModelSlug, "gpt-5-6-thinking");
  assert.equal(thinking.contextWindowTokens, 262144);
  assert.equal(thinking.thinkingEffort, "max");
  assert.equal(thinking.windowSource, "native-classic-model-catalog");
  assert.equal(thinking.supportedChatMode, true);

  await first.observeTurnRequest({
    runtimeKey: "main-01",
    modelSlug: "gpt-5-6-pro",
    thinkingEffort: "standard",
    conversationId: "conv-main-01",
    observedAt: "2026-09-05T02:42:00.000Z",
  });
  const pro = await first.status("main-01");
  assert.equal(pro.contextWindowTokens, 410000, "switching from Thinking to Pro must immediately select the Pro window");

  await first.observeRuntimeSnapshot({
    runtimeKey: "main-02",
    modelSlug: "gpt-5-6-thinking",
    conversationId: "conv-main-02",
    mode: "chat",
    observedTokens: 120000,
    observedAt: "2026-09-05T02:43:00.000Z",
  });
  await first.observeTurnInputEstimate({ runtimeKey: "main-02", conversationId: "conv-main-02", estimatedTokens: 8000, observedAt: "2026-09-05T02:43:10.000Z" });
  const main02 = await first.status("main-02", { nextInputTokens: 5000 });
  assert.equal(main02.contextWindowTokens, 262144, "DOM/native snapshot may seed a runtime before its next turn request");
  assert.equal(main02.snapshotTokens, 120000);
  assert.equal(main02.ledgerTokens, 128000, "turn-input estimates must advance the monotonic ledger from the latest snapshot floor");
  assert.equal(main02.pressure.predictedInputTokens, 133000);

  await first.observeHostUsage({ runtimeKey: "main-02", conversationId: "conv-main-02", usedTokens: 125000, observedAt: "2026-09-05T02:43:20.000Z" });
  const untrustedHostObservation = await first.status("main-02");
  assert.equal(untrustedHostObservation.pressure.usageSource, "devspace-ledger", "legacy host observations must not become exact authority");
  assert.equal(untrustedHostObservation.hostMeasuredTokens, null);
  assert.equal(untrustedHostObservation.exactUsageAvailable, false);
  nativeExactTokens = 125000;
  const exactStatus = await first.status("main-02");
  assert.equal(exactStatus.pressure.usageSource, "host-measured");
  assert.equal(exactStatus.hostMeasuredTokens, 125000);
  assert.equal(exactStatus.hostUsageSource, "classic-native-protocol");
  assert.equal(exactStatus.exactUsageAvailable, true);
  assert.equal(exactStatus.estimatorFallbackUsedForExact, false);

  await first.observeRuntimeSnapshot({
    runtimeKey: "main-03",
    modelSlug: "gpt-5.6-sol-wm",
    conversationId: "conv-main-03",
    mode: "work",
    observedAt: "2026-09-05T02:44:00.000Z",
  });
  const work = await first.status("main-03");
  assert.equal(work.supportedChatMode, false, "Work mode must never be treated as a supported Context Guardian surface");

  await first.close();

  const second = new ContextGuardianRuntime({ stateDir });
  await second.ready;
  const restored = await second.status("main-01");
  assert.equal(restored.currentModelSlug, "gpt-5-6-pro");
  assert.equal(restored.contextWindowTokens, 410000);
  assert.equal(restored.catalogObservedAt, "2026-09-05T02:40:00.000Z");
  await second.close();
} finally {
  await rm(stateDir, { recursive: true, force: true });
}

{
  const registered = new Map();
  const fakeServer = { registerTool(name, spec, handler) { registered.set(name, { spec, handler }); } };
  const runtime = {
    async status(runtimeKey) {
      return { runtimeKey, currentModelSlug: "gpt-5-6-thinking", contextWindowTokens: 262144, windowSource: "native-classic-model-catalog", supportedChatMode: true };
    },
  };
  registerContextGuardianTools(fakeServer, runtime);
  assert.equal(registered.size, 1);
  const tool = registered.get("context_guardian_status");
  assert.ok(tool);
  const result = await tool.handler({ mainNumber: 1 });
  assert.equal(result.structuredContent.contextWindowTokens, 262144);
  assert.equal(result.structuredContent.runtimeKey, "main-01");
}

console.log(JSON.stringify({ ok: true, gate: "context-guardian-models", thinking: 262144, pro: 410000, persisted: true, prospectiveGuard: true, tools: 1 }));
