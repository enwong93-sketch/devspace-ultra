import assert from "node:assert/strict";
import { ClassicCdpClient } from "./classic-cdp-client.js";

class FakeWebSocket {
  constructor() {
    this.listeners = new Map();
    this.sent = [];
    queueMicrotask(() => this.emit("open", {}));
  }
  addEventListener(type, handler, options = {}) {
    const list = this.listeners.get(type) || [];
    list.push({ handler, once: options?.once === true });
    this.listeners.set(type, list);
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(type, list.filter((entry) => entry.handler !== handler));
  }
  send(value) { this.sent.push(String(value)); }
  close() { this.emit("close", {}); }
  emit(type, event) {
    const list = [...(this.listeners.get(type) || [])];
    for (const entry of list) {
      entry.handler(event);
      if (entry.once) this.removeEventListener(type, entry.handler);
    }
  }
}

{
  let socket;
  class WebSocketImpl extends FakeWebSocket { constructor() { super(); socket = this; } }
  const client = new ClassicCdpClient("ws://test", { WebSocketImpl, callTimeoutMs: 50, maxPendingCalls: 2 });
  await client.open();
  const resultPromise = client.call("Runtime.enable");
  const sent = JSON.parse(socket.sent.at(-1));
  socket.emit("message", { data: JSON.stringify({ id: sent.id, result: { ok: true } }) });
  assert.deepEqual(await resultPromise, { ok: true });
  assert.equal(client.pendingSize, 0);
  client.close();
}

{
  class WebSocketImpl extends FakeWebSocket {}
  const client = new ClassicCdpClient("ws://timeout", { WebSocketImpl, callTimeoutMs: 10, maxPendingCalls: 2 });
  await client.open();
  const keepAlive = setTimeout(() => {}, 50);
  await assert.rejects(client.call("Runtime.evaluate"), /timed out/i);
  clearTimeout(keepAlive);
  assert.equal(client.pendingSize, 0, "timed-out CDP calls must be removed from the pending map");
  client.close();
}

{
  let socket;
  class WebSocketImpl extends FakeWebSocket { constructor() { super(); socket = this; } }
  const client = new ClassicCdpClient("ws://cap", { WebSocketImpl, callTimeoutMs: 200, maxPendingCalls: 2 });
  await client.open();
  const p1 = client.call("A").catch((error) => error);
  const p2 = client.call("B").catch((error) => error);
  await assert.rejects(client.call("C"), /pending-call cap/i);
  assert.equal(client.pendingSize, 2);
  socket.emit("close", {});
  assert.match(String((await p1)?.message), /closed/i);
  assert.match(String((await p2)?.message), /closed/i);
  assert.equal(client.pendingSize, 0, "disconnect must reject and clear every pending CDP call");
  client.close();
}

{
  let socket;
  class WebSocketImpl extends FakeWebSocket { constructor() { super(); socket = this; } }
  const client = new ClassicCdpClient("ws://events", { WebSocketImpl });
  await client.open();
  let observed = 0;
  const off = client.on("Network.loadingFinished", () => { observed += 1; });
  socket.emit("message", { data: JSON.stringify({ method: "Network.loadingFinished", params: { requestId: "x" } }) });
  assert.equal(observed, 1);
  off();
  socket.emit("message", { data: JSON.stringify({ method: "Network.loadingFinished", params: { requestId: "y" } }) });
  assert.equal(observed, 1);
  client.close();
  assert.equal(client.handlers.size, 0, "close must clear event handlers");
}

console.log(JSON.stringify({ ok: true, gate: "classic-cdp-client", boundedPending: true, timeoutCleanup: true, disconnectCleanup: true }));
