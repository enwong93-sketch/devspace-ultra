import assert from "node:assert/strict";
import { McpSessionRegistry } from "./mcp-sessions.js";

function fakeTransport(name, closed) {
  return {
    name,
    async close() { closed.push(name); },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

{
  const closed = [];
  const registry = new McpSessionRegistry();
  registry.register("session", fakeTransport("session", closed));
  assert.ok(registry.acquire("session"));
  registry.markEventStreamOpen("session");
  assert.ok(registry.acquire("session"), "concurrent tool request must share the same live MCP session");

  registry.release("session", { eventStream: true });
  await settle();
  assert.equal(registry.size, 1, "closing the event stream must not interrupt a concurrent tool request");
  assert.deepEqual(closed, []);

  registry.release("session");
  await settle();
  assert.equal(registry.size, 0, "once the disconnected session has no real work left, it must be released immediately without an idle timeout");
  assert.deepEqual(closed, ["session"]);
}

{
  const closed = [];
  const registry = new McpSessionRegistry({
    maxInactiveSessions: 1,
    maxEventStreams: 1,
    maxSessions: 1,
  });
  for (let index = 0; index < 64; index += 1) {
    assert.equal(registry.register(`session-${index}`, fakeTransport(`session-${index}`, closed)), true);
  }
  assert.equal(registry.size, 64, "legacy capacity options must not impose an artificial Core session or memory ceiling");
  assert.equal(registry.diagnostics().maxSessions, null);
  assert.equal(registry.diagnostics().maxEventStreams, null);
  assert.deepEqual(closed, []);
  await registry.closeAll();
  assert.equal(registry.size, 0);
  assert.equal(closed.length, 64);
}

{
  const closed = [];
  const registry = new McpSessionRegistry();
  assert.equal(registry.register("same", fakeTransport("original", closed)), true);
  assert.equal(registry.register("same", fakeTransport("duplicate", closed)), false);
  await settle();
  assert.deepEqual(closed, ["duplicate"], "a duplicate session id must close only the rejected transport");
  assert.equal(registry.get("same")?.name, "original");
}

{
  const closed = [];
  const registry = new McpSessionRegistry();
  registry.register("post-only", fakeTransport("post-only", closed));
  assert.ok(registry.acquire("post-only"));
  registry.release("post-only");
  await settle();
  assert.equal(registry.size, 1, "a POST-only session must remain valid until an explicit disconnect or close");
  assert.deepEqual(closed, []);
}

{
  const closed = [];
  const registry = new McpSessionRegistry();
  const clientSessionFingerprint = "a".repeat(64);
  registry.register("old", fakeTransport("old", closed), { clientSessionFingerprint });
  registry.markEventStreamOpen("old");
  registry.register("new", fakeTransport("new", closed), { clientSessionFingerprint });
  await settle();
  assert.equal(registry.size, 1, "a fresh initialize for the same ChatGPT client session must retire the inactive Core transport immediately");
  assert.equal(registry.get("new")?.name, "new");
  assert.equal(registry.get("old"), undefined);
  assert.deepEqual(closed, ["old"]);
  assert.equal(registry.diagnostics().clientSessions, 1);
}

{
  const closed = [];
  const registry = new McpSessionRegistry();
  const clientSessionFingerprint = "b".repeat(64);
  registry.register("old-active", fakeTransport("old-active", closed), { clientSessionFingerprint });
  assert.ok(registry.acquire("old-active"));
  registry.markEventStreamOpen("old-active");
  registry.register("new-active", fakeTransport("new-active", closed), { clientSessionFingerprint });
  await settle();
  assert.equal(registry.size, 2, "supersession must not interrupt an in-flight tool request");
  assert.deepEqual(closed, []);
  assert.equal(registry.diagnostics().supersededSessions, 1);
  registry.release("old-active");
  await settle();
  assert.equal(registry.size, 1, "the superseded Core transport must close as soon as its real work drains");
  assert.deepEqual(closed, ["old-active"]);
  assert.equal(registry.get("new-active")?.name, "new-active");
}

console.log(JSON.stringify({
  ok: true,
  gate: "mcp-session-registry",
  artificialCapacityLimitsRemoved: true,
  eventStreamDisconnectCleanup: true,
  clientSessionSupersession: true,
  inFlightProtected: true,
}));
