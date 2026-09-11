import assert from "node:assert/strict";
import {
  McpRequestCorrelationDiagnostics,
  summarizeMcpCorrelationRequest,
} from "./mcp-request-correlation-diagnostics.js";

const summary = summarizeMcpCorrelationRequest({
  headers: {
    authorization: "Bearer do-not-persist",
    cookie: "session=do-not-persist",
    "mcp-session-id": "backend-session-a",
    "x-devspace-client-session-fingerprint": "a".repeat(64),
    "x-oai-turn-trace-id": "opaque-turn-trace",
    traceparent: "00-0123456789abcdef000000000000002a-1111111111111111-01",
    "x-datadog-trace-id": "42",
  },
  body: {
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      name: "devspace_progress_report",
      arguments: { message: "private progress prose", nested: { secret: "no" } },
      _meta: {
        "openai/session": "opaque-openai-session",
        request_id: "request-a",
        turn_id: "turn-a",
      },
    },
  },
  mcpSessionId: "backend-session-a",
  clientSessionFingerprint: "a".repeat(64),
  turnTraceFingerprint: "b".repeat(64),
  observedAt: "2026-09-12T00:00:00.000Z",
});

assert.equal(summary.method, "tools/call");
assert.equal(summary.toolName, "devspace_progress_report");
assert.equal(summary.clientSessionFingerprint, "a".repeat(64));
assert.equal(summary.turnTraceFingerprint, "b".repeat(64));
assert.equal(summary.traceCorrelationFingerprints.length, 2);
assert.equal(summary.traceCorrelationFingerprints.every((value) => /^[a-f0-9]{64}$/.test(value)), true);
assert.deepEqual(summary.argumentKeys, ["message", "nested"]);
assert.deepEqual(summary.metaKeys.sort(), ["openai/session", "request_id", "turn_id"].sort());
assert.equal(summary.correlationScalarPaths.some((item) => item.path === "body.params._meta.request_id"), true);
assert.equal(summary.correlationScalarPaths.some((item) => item.path === "body.params._meta.turn_id"), true);
const encoded = JSON.stringify(summary);
for (const forbidden of [
  "do-not-persist",
  "private progress prose",
  "opaque-openai-session",
  "opaque-turn-trace",
  "backend-session-a",
  "0123456789abcdef000000000000002a",
]) {
  assert.equal(encoded.includes(forbidden), false, `diagnostics must not persist ${forbidden}`);
}
assert.equal(summary.rawHeaderValuesPersisted, false);
assert.equal(summary.rawBodyValuesPersisted, false);
assert.equal(summary.rawArgumentsPersisted, false);

const journal = new McpRequestCorrelationDiagnostics({ maxRecords: 4 });
for (let index = 0; index < 6; index += 1) {
  journal.note({ body: { method: "tools/call", params: { name: `tool-${index}`, arguments: {} } } });
}
const diagnostics = journal.diagnostics();
assert.equal(diagnostics.recordCount, 4);
assert.equal(diagnostics.records[0].toolName, "tool-5");
assert.equal(diagnostics.records.at(-1).toolName, "tool-2");

console.log(JSON.stringify({
  ok: true,
  gate: "mcp-request-correlation-diagnostics",
  bounded: true,
  secretsPersisted: false,
}));
