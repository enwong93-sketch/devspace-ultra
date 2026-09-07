import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClassicExactUsageAuthority,
  classifyExactNativeUsageCandidate,
  selectExactNativeUsage,
} from "./classic-exact-usage-authority.js";

const base = Date.parse("2026-09-07T09:30:00.000Z");

assert.deepEqual(classifyExactNativeUsageCandidate({
  source: "response-body",
  path: "event_12.usage.input_tokens",
  value: 12345,
}), {
  source: "response-body",
  path: "event_12.usage.input_tokens",
  value: 12345,
  kind: "input_tokens",
  priority: 100,
  eventType: null,
});
assert.equal(classifyExactNativeUsageCandidate({ source: "request-header", path: "headers.input_tokens", value: 10 }), null);
assert.equal(classifyExactNativeUsageCandidate({ source: "response-body", path: "event.stop_tokens.0", value: 200002 }), null);
assert.equal(classifyExactNativeUsageCandidate({ source: "response-body", path: "message.metadata.message_content_token_count", value: 99 }), null);
assert.equal(classifyExactNativeUsageCandidate({ source: "response-body", path: "usage.output_tokens", value: 99 }), null);
assert.equal(classifyExactNativeUsageCandidate({ source: "response-body", path: "context_window", value: 410000 }), null);
assert.equal(classifyExactNativeUsageCandidate({ source: "response-body", path: "attachment.size_bytes", value: 50153 }), null);
assert.equal(classifyExactNativeUsageCandidate({ source: "response-body", path: "usage.input_tokens", value: 1.5 }), null);

const events = [
  {
    conversationId: "conversation-a",
    observedAt: new Date(base - 1_000).toISOString(),
    candidates: [
      { source: "response-body", path: "event.create_time", value: 1788770000 },
      { source: "response-body", path: "event.usage.prompt_tokens", value: 12000 },
      { source: "response-body", path: "event.usage.input_tokens", value: 12345 },
    ],
  },
  {
    conversationId: "conversation-b",
    observedAt: new Date(base - 500).toISOString(),
    candidates: [{ source: "response-body", path: "event.usage.input_tokens", value: 777 }],
  },
];
const selected = selectExactNativeUsage(events, {
  conversationId: "conversation-a",
  nowMs: base,
  maxAgeMs: 60_000,
});
assert.equal(selected.available, true);
assert.equal(selected.exactUsedTokens, 12345);
assert.equal(selected.usageKind, "input_tokens");
assert.equal(selected.source, "classic-native-protocol");
assert.equal(selected.conversationId, "conversation-a");
assert.equal(selectExactNativeUsage(events, { nowMs: base }).reason, "conversation-id-required");
assert.equal(selectExactNativeUsage(events, { conversationId: "conversation-missing", nowMs: base }).reason, "fresh-native-usage-evidence-unavailable");
assert.equal(selectExactNativeUsage(events, { conversationId: "conversation-a", nowMs: base + 120_000, maxAgeMs: 60_000 }).reason, "fresh-native-usage-evidence-unavailable");

const irrelevant = selectExactNativeUsage([{
  conversationId: "conversation-a",
  observedAt: new Date(base).toISOString(),
  candidates: [
    { source: "response-body", path: "event.input_message.create_time", value: 1788770000 },
    { source: "response-body", path: "event.input_message.weight", value: 1 },
    { source: "response-body", path: "event.input_message.metadata.attachments.0.size", value: 50153 },
    { source: "response-body", path: "event.finish_details.stop_tokens.0", value: 200002 },
  ],
}], { conversationId: "conversation-a", nowMs: base });
assert.equal(irrelevant.available, false);
assert.equal(irrelevant.reason, "exact-native-token-field-not-exposed");

const ambiguous = selectExactNativeUsage([{
  conversationId: "conversation-a",
  observedAt: new Date(base).toISOString(),
  candidates: [
    { source: "response-body", path: "event_a.usage.input_tokens", value: 100 },
    { source: "response-body", path: "event_b.usage.input_tokens", value: 101 },
  ],
}], { conversationId: "conversation-a", nowMs: base });
assert.equal(ambiguous.available, false);
assert.equal(ambiguous.reason, "ambiguous-exact-native-usage");

const root = await mkdtemp(join(tmpdir(), "devspace-exact-usage-authority-"));
try {
  const statePath = join(root, "classic-native-usage-evidence.json");
  await writeFile(statePath, JSON.stringify({ version: 1, events }));
  const authority = new ClassicExactUsageAuthority({
    statePath,
    maxAgeMs: 60_000,
    now: () => base,
  });
  const status = await authority.status({ conversationId: "conversation-a" });
  assert.equal(status.available, true);
  assert.equal(status.exactUsedTokens, 12345);
  assert.equal(status.estimatorFallbackUsed, false);
  assert.equal(status.ledgerFallbackUsed, false);
  assert.equal(status.domFallbackUsed, false);

  const missing = new ClassicExactUsageAuthority({ statePath: join(root, "missing.json") });
  assert.equal((await missing.status({ conversationId: "conversation-a" })).reason, "native-usage-evidence-file-unavailable");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  gate: "classic-exact-usage-authority",
  nativeResponseOnly: true,
  conversationBound: true,
  freshnessRequired: true,
  ambiguityFailsClosed: true,
  timestampRejected: true,
  stopTokensRejected: true,
  messageContentCountRejected: true,
  attachmentSizeRejected: true,
  estimatorFallback: false,
  ledgerFallback: false,
  domFallback: false,
}));
