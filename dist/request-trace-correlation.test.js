import assert from "node:assert/strict";
import {
  mergeTraceCorrelationFingerprints,
  requestTraceCorrelationFingerprints,
  tracesIntersect,
} from "./request-trace-correlation.js";

const traceId = "0123456789abcdef000000000000002a";
const browser = requestTraceCorrelationFingerprints({
  traceparent: `00-${traceId}-1111111111111111-01`,
});
const direct = requestTraceCorrelationFingerprints({
  "x-datadog-trace-id": "42",
  traceparent: `00-${traceId}-2222222222222222-01`,
});
assert.equal(browser.length, 2);
assert.equal(direct.length, 2);
assert.equal(tracesIntersect(browser, direct), true, "the same distributed trace must match across W3C and Datadog headers");

const another = requestTraceCorrelationFingerprints({
  traceparent: "00-fedcba9876543210000000000000002b-3333333333333333-01",
  "x-datadog-trace-id": "43",
});
assert.equal(tracesIntersect(browser, another), false);
assert.deepEqual(requestTraceCorrelationFingerprints({ traceparent: "00-00000000000000000000000000000000-1111111111111111-01" }), []);
assert.deepEqual(requestTraceCorrelationFingerprints({ "x-datadog-trace-id": "0" }), []);
assert.deepEqual(requestTraceCorrelationFingerprints({ "x-datadog-trace-id": "not-a-number" }), []);

const merged = mergeTraceCorrelationFingerprints(browser, direct, ["not-a-fingerprint", browser[0]]);
assert.equal(merged.length, 2);
assert.equal(merged.every((value) => /^[a-f0-9]{64}$/.test(value)), true);
assert.equal(JSON.stringify({ browser, direct }).includes(traceId), false, "raw trace ids must not leave the parser");

console.log(JSON.stringify({
  ok: true,
  gate: "request-trace-correlation",
  w3cTraceMatch: true,
  datadogLow64Bridge: true,
  invalidTraceRejected: true,
  rawTracePersisted: false,
}));
