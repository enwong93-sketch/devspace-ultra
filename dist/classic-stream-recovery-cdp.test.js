import assert from "node:assert/strict";
import { ClassicStreamRecoveryCdpAdapter } from "./classic-stream-recovery-cdp.js";

const connected = [];
const closed = [];
const failureHandlers = new Map();
const snapshots = new Map([
  [9732, { ok: true, mode: "chat", conversationId: "conv-2", progressSignature: "1:20:hello", generating: true }],
  [9733, { ok: true, mode: "chat", conversationId: "conv-3", progressSignature: "1:30:world", generating: true }],
]);

const adapter = new ClassicStreamRecoveryCdpAdapter({
  ports: [9732, 9733],
  connectionPollMs: 0,
  connectPort: async (port, { onTransportFailure }) => {
    connected.push(port);
    failureHandlers.set(port, onTransportFailure);
    return {
      runtimeKey: `main-${String(port - 9730).padStart(2, "0")}`,
      port,
      async inspect() { return snapshots.get(port); },
      async checkStreamStatus(conversationId) { return { ok: true, status: conversationId === `conv-${port - 9730}` ? "COMPLETE" : "UNKNOWN" }; },
      async close() { closed.push(port); },
    };
  },
});

const failures = [];
adapter.setFailureHandler((event) => failures.push(event));
await adapter.start({ schedule: false });
assert.deepEqual(connected, [9732, 9733]);
assert.equal(adapter.status().connected, 2);

const snap = await adapter.inspect("main-03");
assert.equal(snap.conversationId, "conv-3");
assert.equal(snap.progressSignature, "1:30:world");

const server = await adapter.checkStreamStatus("main-03", "conv-3");
assert.deepEqual(server, { ok: true, status: "COMPLETE" });
assert.equal(typeof adapter.reload, "undefined", "Stream Recovery adapter must not expose a page reload/navigation capability");

await failureHandlers.get(9733)({
  runtimeKey: "main-03",
  conversationId: "conv-3",
  url: "https://chatgpt.com/backend-api/conversation/conv-3/stream_status",
  errorText: "net::ERR_INTERNET_DISCONNECTED",
  progressSignature: "1:30:world",
});
assert.equal(failures.length, 1);
assert.equal(failures[0].conversationId, "conv-3");

await adapter.close();
assert.deepEqual(closed.sort((a, b) => a - b), [9732, 9733]);

console.log(JSON.stringify({
  ok: true,
  gate: "classic-stream-recovery-cdp-adapter",
  ports: 2,
  delegatedFailure: true,
  pageMutationCapability: false,
}));
