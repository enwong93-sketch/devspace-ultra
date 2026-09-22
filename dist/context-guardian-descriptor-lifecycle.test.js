import assert from "node:assert/strict";
import test from "node:test";
import {
  NativeConversationDescriptorCoordinator,
  classicSourcePageIdentity,
  parseNativeDescriptorRetryAfterMs,
  readStableClassicDescriptor,
  stableClassicSourceRoute,
} from "./context-guardian-cdp.js";

const descriptor = (id, node = "node-current") => ({ conversationId: id, currentNode: node });
const source = (overrides = {}) => ({
  ok: true, mode: "chat", conversationId: "conversation-a", documentId: "document-a",
  routeEpoch: 1, documentReadyState: "complete", composerReady: true,
  routeHydrated: true, routeStableForMs: 5_000, ...overrides,
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function httpError(status, retryAfter) {
  return Object.assign(new Error(`fixture HTTP ${status}`), {
    code: status === 429 ? "NATIVE_DESCRIPTOR_RATE_LIMIT" : "NATIVE_DESCRIPTOR_HTTP",
    status, retryAfter,
  });
}

test("unstable or incomplete source never reaches the fetch", async () => {
  let fetches = 0;
  for (const invalid of [
    { routeEpoch: 0 }, { documentId: "" }, { routeHydrated: false },
    { mode: "work" }, { ok: false }, { routeStableForMs: 2_999 },
  ]) {
    await assert.rejects(readStableClassicDescriptor({
      inspectSource: async () => source(invalid),
      fetchDescriptor: async () => { fetches += 1; return descriptor("conversation-a"); },
    }), { code: "NATIVE_DESCRIPTOR_SOURCE_UNSTABLE" });
  }
  assert.equal(fetches, 0);
  assert.equal(classicSourcePageIdentity(source({ documentId: "a:1" })), null);
  assert.equal(stableClassicSourceRoute(source()), true);
});

test("page, epoch, route and hydration changes reject the returned descriptor", async () => {
  for (const change of [
    { documentId: "document-reloaded" }, { routeEpoch: 2 },
    { conversationId: "conversation-b" }, { routeHydrated: false },
  ]) {
    let snapshot = source();
    const started = deferred(), response = deferred();
    const pending = readStableClassicDescriptor({
      inspectSource: async () => snapshot,
      fetchDescriptor: async () => { started.resolve(); return response.promise; },
    });
    const rejected = assert.rejects(pending, { code: "NATIVE_DESCRIPTOR_SOURCE_CHANGED" });
    await started.promise;
    snapshot = source(change);
    response.resolve(descriptor("conversation-a"));
    await rejected;
  }
});

test("source read accepts only its own descriptor and current boundary", async () => {
  const read = (value) => readStableClassicDescriptor({
    inspectSource: async () => source(), fetchDescriptor: async () => value,
  });
  assert.deepEqual(await read(descriptor("conversation-a")), descriptor("conversation-a"));
  await assert.rejects(read(descriptor("conversation-b")), { code: "NATIVE_DESCRIPTOR_SOURCE_MISMATCH" });
  await assert.rejects(read({ conversationId: "conversation-a" }), { code: "NATIVE_DESCRIPTOR_SOURCE_MISMATCH" });
});

test("late success after clear cannot overwrite the next generation cache", async () => {
  const coordinator = new NativeConversationDescriptorCoordinator({ retryDelaysMs: [0] });
  const response = deferred();
  const old = coordinator.load("conversation-a", { fetchDescriptor: () => response.promise });
  const rejected = assert.rejects(old, { code: "NATIVE_DESCRIPTOR_CLEARED" });
  coordinator.clear();
  await coordinator.load("conversation-a", { fetchDescriptor: async () => descriptor("conversation-a", "node-new") });
  response.resolve(descriptor("conversation-a", "node-old"));
  await rejected;
  const current = await coordinator.load("conversation-a", { fetchDescriptor: async () => { assert.fail("must use new cache"); } });
  assert.equal(current.currentNode, "node-new");
  assert.equal(coordinator.status().inFlight, 0);
});

test("late failure after clear cannot poison the next generation", async () => {
  const coordinator = new NativeConversationDescriptorCoordinator({ retryDelaysMs: [0], rateLimitScope: "shared" });
  const response = deferred();
  const old = coordinator.load("conversation-a", { fetchDescriptor: () => response.promise });
  const rejected = assert.rejects(old, { code: "NATIVE_DESCRIPTOR_CLEARED" });
  coordinator.clear();
  response.reject(httpError(429, "120"));
  await rejected;
  await coordinator.load("conversation-b", { fetchDescriptor: async () => descriptor("conversation-b") });
  assert.equal(coordinator.status().cooldownUntil, null);
  assert.equal(coordinator.status().failureCooldowns, 0);
});

test("force failure rejects instead of returning old cached success", async () => {
  let now = 1_000, fetches = 0;
  const coordinator = new NativeConversationDescriptorCoordinator({ now: () => now, retryDelaysMs: [0] });
  await coordinator.load("conversation-a", { fetchDescriptor: async () => descriptor("conversation-a", "old") });
  const failing = async () => { fetches += 1; throw httpError(404); };
  await assert.rejects(coordinator.load("conversation-a", { force: true, fetchDescriptor: failing }), { status: 404 });
  await assert.rejects(coordinator.load("conversation-a", { force: true, fetchDescriptor: failing }), { code: "NATIVE_DESCRIPTOR_FAILURE_COOLDOWN" });
  assert.equal(fetches, 1);
  now += 300_001;
  const fresh = await coordinator.load("conversation-a", { force: true, fetchDescriptor: async () => descriptor("conversation-a", "new") });
  assert.equal(fresh.currentNode, "new");
});

test("foreign descriptor cannot enter the cache, and returned values are independent", async () => {
  const coordinator = new NativeConversationDescriptorCoordinator({ retryDelaysMs: [0] });
  await assert.rejects(coordinator.load("conversation-a", { fetchDescriptor: async () => descriptor("conversation-b") }), { code: "NATIVE_DESCRIPTOR_IDENTITY" });
  assert.equal(coordinator.status().cachedConversations, 0);
  coordinator.clear();
  const current = await coordinator.load("conversation-a", { fetchDescriptor: async () => descriptor("conversation-a") });
  current.currentNode = "caller-mutation";
  const next = await coordinator.load("conversation-a", { fetchDescriptor: async () => { assert.fail("cache expected"); } });
  assert.equal(next.currentNode, "node-current");
});

test("concurrent different conversations obey one start-time pace", async () => {
  let now = 10_000;
  const times = [];
  const coordinator = new NativeConversationDescriptorCoordinator({
    now: () => now, sleepImpl: async (ms) => { now += ms; },
    minimumFetchGapMs: 2_000, retryDelaysMs: [0],
  });
  await Promise.all(["a", "b", "c"].map((id) => coordinator.load(id, {
    fetchDescriptor: async () => { times.push(now); return descriptor(id); },
  })));
  assert.deepEqual(times, [10_000, 12_000, 14_000]);
});

test("queued fetch rechecks the explicit shared cooldown after its wait", async () => {
  let now = 10_000, fetches = 0;
  const response = deferred(), sleeping = deferred(), wake = deferred();
  const coordinator = new NativeConversationDescriptorCoordinator({
    now: () => now, minimumFetchGapMs: 2_000, retryDelaysMs: [0], rateLimitScope: "shared",
    sleepImpl: async (ms) => { sleeping.resolve(); await wake.promise; now += ms; },
  });
  const first = coordinator.load("a", { fetchDescriptor: () => { fetches += 1; return response.promise; } });
  const rejectedFirst = assert.rejects(first, { status: 429 });
  const next = coordinator.load("b", { fetchDescriptor: async () => { fetches += 1; return descriptor("b"); } });
  const rejectedNext = assert.rejects(next, { code: "NATIVE_DESCRIPTOR_COOLDOWN" });
  await sleeping.promise;
  response.reject(httpError(429, "120"));
  await rejectedFirst;
  wake.resolve();
  await rejectedNext;
  assert.equal(fetches, 1);
});

test("default rate-limit scope does not block unrelated conversations", async () => {
  const coordinator = new NativeConversationDescriptorCoordinator({ retryDelaysMs: [0] });
  await assert.rejects(coordinator.load("a", { fetchDescriptor: async () => { throw httpError(429, "120"); } }));
  assert.equal((await coordinator.load("b", { fetchDescriptor: async () => descriptor("b") })).conversationId, "b");
  assert.equal(coordinator.status().rateLimitScope, "conversation");
  assert.equal(coordinator.status().cooldownUntil, null);
});

test("Retry-After is not shortened and invalid numeric forms are rejected", async () => {
  assert.equal(parseNativeDescriptorRetryAfterMs("3600", 1_000), 3_600_000);
  assert.equal(parseNativeDescriptorRetryAfterMs("Thu, 01 Jan 1970 00:02:00 GMT", 0), 120_000);
  for (const invalid of ["-1", "1.5", "1e3", "nonsense", "Infinity"]) assert.equal(parseNativeDescriptorRetryAfterMs(invalid, 0), null);
  let now = 1_000;
  const coordinator = new NativeConversationDescriptorCoordinator({ now: () => now, retryDelaysMs: [0] });
  await assert.rejects(coordinator.load("a", { fetchDescriptor: async () => { throw httpError(429, "3600"); } }));
  now += 300_001;
  await assert.rejects(coordinator.load("a", { fetchDescriptor: async () => { assert.fail("server interval not expired"); } }), { code: "NATIVE_DESCRIPTOR_COOLDOWN" });
});

test("in-flight and completed caches remain bounded", async () => {
  const coordinator = new NativeConversationDescriptorCoordinator({ maxCacheEntries: 2, retryDelaysMs: [0] });
  const responses = [deferred(), deferred()];
  const active = ["a", "b"].map((id, index) => coordinator.load(id, { fetchDescriptor: () => responses[index].promise }));
  await assert.rejects(coordinator.load("c", { fetchDescriptor: async () => descriptor("c") }), { code: "NATIVE_DESCRIPTOR_CAPACITY" });
  responses[0].resolve(descriptor("a")); responses[1].resolve(descriptor("b"));
  await Promise.all(active);
  await coordinator.load("c", { fetchDescriptor: async () => descriptor("c") });
  assert.equal(coordinator.status().cachedConversations, 2);
  assert.equal(coordinator.status().inFlight, 0);
});
