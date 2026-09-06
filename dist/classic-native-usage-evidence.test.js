import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClassicNativeUsageEvidenceStore,
  extractClassicNativeUsageEvidence,
} from "./classic-native-usage-evidence.js";

const sensitivePrompt = "SUPER SECRET USER PROMPT MUST NEVER PERSIST";
const sensitiveBearer = "Bearer secret-token-value";
const body = [
  `data: ${JSON.stringify({
    type: "message_delta",
    message: {
      content: { parts: [sensitivePrompt] },
      metadata: {
        usage: { input_tokens: 12345, output_tokens: 678, cached_tokens: "321" },
        context_window: 262144,
        unrelated_number: 999,
        authorization: sensitiveBearer,
      },
    },
  })}`,
  "",
  `data: ${JSON.stringify({
    type: "usage",
    usage: { total_tokens: 13023 },
    remaining_tokens: 249121,
  })}`,
  "",
  "data: [DONE]",
].join("\n");

const evidence = extractClassicNativeUsageEvidence({
  conversationId: "conversation-usage-a",
  requestHeaders: {
    "x-openai-token-count": "12000",
    "authorization": sensitiveBearer,
  },
  responseHeaders: {
    "x-openai-context-tokens": "262144",
    "authorization": sensitiveBearer,
    "x-request-duration-ms": "42",
  },
  responseBody: body,
  observedAt: "2026-09-06T06:00:00.000Z",
});

assert.equal(evidence.conversationId, "conversation-usage-a");
assert.ok(evidence.candidates.some((item) => item.path.endsWith("usage.input_tokens") && item.value === 12345));
assert.ok(evidence.candidates.some((item) => item.path.endsWith("usage.output_tokens") && item.value === 678));
assert.ok(evidence.candidates.some((item) => item.path.endsWith("usage.cached_tokens") && item.value === 321));
assert.ok(evidence.candidates.some((item) => item.path.endsWith("remaining_tokens") && item.value === 249121));
assert.ok(evidence.candidates.some((item) => item.source === "request-header" && item.path === "headers.x-openai-token-count" && item.value === 12000));
assert.ok(evidence.candidates.some((item) => item.source === "response-header" && item.path === "headers.x-openai-context-tokens" && item.value === 262144));
assert.equal(evidence.candidates.some((item) => item.path.endsWith("unrelated_number")), false, "unrelated numeric fields must not pollute usage evidence");
assert.equal(evidence.candidates.some((item) => /duration/i.test(item.path)), false);
const serialized = JSON.stringify(evidence);
assert.equal(serialized.includes(sensitivePrompt), false, "raw prompt text must never enter usage evidence");
assert.equal(serialized.includes("secret-token-value"), false, "credential values must never enter usage evidence");
assert.equal(serialized.includes("authorization"), false, "credential header names should not be preserved in the usage evidence surface");

const root = await mkdtemp(join(tmpdir(), "classic-native-usage-evidence-"));
try {
  const statePath = join(root, "usage.json");
  const store = new ClassicNativeUsageEvidenceStore({ statePath, limit: 3 });
  await store.load();
  await store.record(evidence);
  await store.record(extractClassicNativeUsageEvidence({
    conversationId: "conversation-usage-b",
    responseBody: `data: ${JSON.stringify({ type: "usage", usage: { input_tokens: 200 } })}\n`,
    observedAt: "2026-09-06T06:01:00.000Z",
  }));
  assert.equal(store.snapshot().events.length, 2);
  assert.equal(store.snapshot({ conversationId: "conversation-usage-a" }).events.length, 1);

  const diskText = await readFile(statePath, "utf8");
  assert.equal(diskText.includes(sensitivePrompt), false);
  assert.equal(diskText.includes("secret-token-value"), false);

  const restored = new ClassicNativeUsageEvidenceStore({ statePath, limit: 3 });
  await restored.load();
  assert.equal(restored.snapshot().events.length, 2);
  assert.equal(restored.snapshot().events[0].conversationId, "conversation-usage-b");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  gate: "classic-native-usage-evidence",
  numericPathsOnly: true,
  rawContentPersisted: false,
  credentialValuesPersisted: false,
}));
