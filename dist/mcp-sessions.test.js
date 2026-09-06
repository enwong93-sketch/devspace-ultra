import assert from "node:assert/strict";
import { McpSessionRegistry } from "./mcp-sessions.js";

function fakeTransport(name, closed, eventStreamsClosed = []) {
  return {
    name,
    async close() { closed.push(name); },
    closeStandaloneSSEStream() { eventStreamsClosed.push(name); },
  };
}

{
  let now = 1_000;
  const closed = [];
  const registry = new McpSessionRegistry({ now: () => now });
  registry.register("active", fakeTransport("active", closed));
  assert.ok(registry.acquire("active"), "acquire must return the registered transport");
  now = 120_000;
  const results = await registry.closeIdle(30_000);
  assert.equal(results.length, 0, "an in-flight session must never be closed by idle cleanup");
  assert.equal(registry.size, 1);
  registry.release("active");
  now = 151_000;
  const afterRelease = await registry.closeIdle(30_000);
  assert.equal(afterRelease.length, 1, "released session may be cleaned once it is truly idle");
  assert.deepEqual(closed, ["active"]);
}

{
  let now = 0;
  const closed = [];
  const registry = new McpSessionRegistry({ now: () => now });
  for (let i = 0; i < 10; i += 1) {
    registry.register(`stale-${i}`, fakeTransport(`stale-${i}`, closed));
    now += 1;
  }
  registry.register("busy", fakeTransport("busy", closed));
  registry.acquire("busy");
  const results = await registry.closeExcessInactive(3);
  assert.equal(results.length, 7, "overflow cleanup must retain only the newest inactive sessions");
  assert.equal(registry.size, 4, "three inactive plus one in-flight session should remain");
  assert.ok(registry.get("busy"), "overflow cleanup must never evict an in-flight session");
  assert.deepEqual(closed, ["stale-0", "stale-1", "stale-2", "stale-3", "stale-4", "stale-5", "stale-6"]);
}

{
  let now = 0;
  const closed = [];
  const registry = new McpSessionRegistry({ now: () => now, maxInactiveSessions: 3 });
  for (let i = 0; i < 6; i += 1) {
    registry.register(`burst-${i}`, fakeTransport(`burst-${i}`, closed));
    now += 1;
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(registry.size, 3, "register-time hard cap must prevent a reconnect/replay burst from accumulating inactive Core sessions before the cleanup timer runs");
  assert.deepEqual(closed, ["burst-0", "burst-1", "burst-2"], "oldest inactive transports must be closed immediately when the hard cap is exceeded");
  assert.ok(registry.get("burst-3"));
  assert.ok(registry.get("burst-4"));
  assert.ok(registry.get("burst-5"));
}

{
  let now = 0;
  const closed = [];
  const eventStreamsClosed = [];
  const registry = new McpSessionRegistry({ now: () => now, maxEventStreams: 3 });
  for (let index = 0; index < 5; index += 1) {
    const id = `stream-${index}`;
    registry.register(id, fakeTransport(id, closed, eventStreamsClosed));
    assert.ok(registry.acquire(id));
    registry.markEventStreamOpen(id);
    now += 1;
  }
  assert.deepEqual(eventStreamsClosed, ["stream-0", "stream-1"], "oldest standalone SSE streams must be asked to close once the global event-stream cap is exceeded");
  assert.equal(registry.diagnostics().maxEventStreams, 3);
  registry.release("stream-0", { eventStream: true });
  registry.release("stream-1", { eventStream: true });
  assert.equal(registry.diagnostics().eventStreams, 3, "event-stream count must fall when closed stream requests finish");
  assert.equal(closed.length, 0, "event-stream eviction must not destroy the whole MCP session transport");
}

{
  let now = 5_000;
  const closed = [];
  const registry = new McpSessionRegistry({ now: () => now });
  registry.register("touch", fakeTransport("touch", closed));
  now = 20_000;
  assert.ok(registry.acquire("touch"));
  registry.release("touch");
  now = 45_000;
  assert.equal((await registry.closeIdle(30_000)).length, 0, "release must refresh last activity so a recently completed request is retained");
  now = 51_000;
  assert.equal((await registry.closeIdle(30_000)).length, 1);
}

console.log(JSON.stringify({ ok: true, gate: "mcp-session-registry", inFlightProtected: true, inactiveBounded: true, eventStreamsBounded: true }));
