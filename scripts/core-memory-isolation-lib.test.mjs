import assert from "node:assert/strict";
import {
  MEMORY_MODE_NAMES,
  TOTAL_HEAP_LIMIT_MB,
  assertMemorySnapshot,
  memoryModeProfile,
  nodeArgsForTotalHeapLimit,
  parseMcpResponseText,
} from "./core-memory-isolation-lib.mjs";

assert.equal(TOTAL_HEAP_LIMIT_MB, 512);
assert.deepEqual(MEMORY_MODE_NAMES, [
  "baseline",
  "context",
  "stream",
  "overlay",
  "capability",
  "full-product",
]);

assert.deepEqual(memoryModeProfile("baseline"), {
  context: false,
  stream: false,
  overlay: false,
  plugins: false,
  skills: false,
  artifacts: false,
});
assert.equal(memoryModeProfile("overlay").context, true, "Host Overlay requires the shared Context CDP adapter");
assert.equal(memoryModeProfile("overlay").overlay, true);
assert.equal(memoryModeProfile("capability").plugins, true);
assert.equal(memoryModeProfile("capability").skills, true);
assert.equal(memoryModeProfile("full-product").context, true);
assert.equal(memoryModeProfile("full-product").stream, true);
assert.equal(memoryModeProfile("full-product").overlay, true);
assert.equal(memoryModeProfile("full-product").plugins, true);
assert.throws(() => memoryModeProfile("unknown"), /Unknown memory isolation mode/);

const nodeArgs = nodeArgsForTotalHeapLimit(512);
assert.deepEqual(nodeArgs, [
  "--max-old-space-size=464",
  "--max-semi-space-size=16",
  "--expose-gc",
]);

const valid = assertMemorySnapshot({
  memory: {
    heapSizeLimit: 512 * 1024 * 1024,
    heapUsed: 120 * 1024 * 1024,
    rss: 200 * 1024 * 1024,
  },
}, { targetTotalHeapMb: 512 });
assert.equal(valid.heapSizeLimitMb, 512);
assert.equal(valid.heapUsedMb, 120);
assert.equal(valid.rssMb, 200);

assert.throws(
  () => assertMemorySnapshot({ memory: { heapSizeLimit: 704 * 1024 * 1024 } }, { targetTotalHeapMb: 512 }),
  /exceeds the verified 512 MiB ceiling/,
);
assert.throws(
  () => assertMemorySnapshot({ memory: {} }, { targetTotalHeapMb: 512 }),
  /heapSizeLimit/,
);

const jsonRpcResponse = {
  jsonrpc: "2.0",
  id: 42,
  result: { structuredContent: { ok: true } },
};
assert.deepEqual(
  parseMcpResponseText(JSON.stringify(jsonRpcResponse), {
    contentType: "application/json",
    expectedId: 42,
  }),
  jsonRpcResponse,
);
assert.deepEqual(
  parseMcpResponseText([
    "event: message",
    "data: {}",
    "",
    "event: message",
    `data: ${JSON.stringify(jsonRpcResponse)}`,
    "",
  ].join("\n"), {
    contentType: "text/event-stream",
    expectedId: 42,
  }),
  jsonRpcResponse,
  "SSE priming events must not hide the actual JSON-RPC response",
);
assert.equal(
  parseMcpResponseText("event: message\ndata: {}\n\n", {
    contentType: "text/event-stream",
    expectedId: 42,
  }),
  null,
  "a priming event alone is not a completed JSON-RPC response",
);

console.log(JSON.stringify({
  ok: true,
  gate: "core-memory-isolation-lib",
  totalHeapNotOldSpaceOnly: true,
  isolatedModes: MEMORY_MODE_NAMES,
}));
