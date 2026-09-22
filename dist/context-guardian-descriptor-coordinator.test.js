import assert from "node:assert/strict";
import {
  NativeConversationDescriptorCoordinator,
  classicSourcePageIdentity,
  stableClassicSourceRoute,
} from "./context-guardian-cdp.js";

function descriptor(id) {
  return { conversationId: id, currentNode: `node-${id}`, estimatedTokens: 100 };
}

{
  const snapshot = {
    mode: "chat",
    conversationId: "conversation-a",
    documentId: "document-a",
    routeEpoch: 3,
    documentReadyState: "complete",
    composerReady: true,
    routeHydrated: true,
    routeStableForMs: 3_500,
  };
  assert.equal(classicSourcePageIdentity(snapshot), "document-a:3:conversation-a");
  assert.equal(stableClassicSourceRoute(snapshot, 3_000), true);
  assert.equal(stableClassicSourceRoute({ ...snapshot, routeStableForMs: 2_999 }, 3_000), false);
  assert.equal(stableClassicSourceRoute({ ...snapshot, routeHydrated: false }, 3_000), false);
  assert.equal(stableClassicSourceRoute({ ...snapshot, mode: "work" }, 3_000), false);
  assert.equal(classicSourcePageIdentity({ ...snapshot, routeEpoch: 0 }), null);
}

{
  let fetches = 0;
  let resolveFetch;
  const pendingFetch = new Promise((resolve) => { resolveFetch = resolve; });
  const coordinator = new NativeConversationDescriptorCoordinator({
    minimumFetchGapMs: 0,
    retryDelaysMs: [0],
  });
  const first = coordinator.load("conversation-singleflight", {
    fetchDescriptor: async () => {
      fetches += 1;
      await pendingFetch;
      return descriptor("conversation-singleflight");
    },
  });
  const second = coordinator.load("conversation-singleflight", {
    fetchDescriptor: async () => {
      fetches += 1;
      return descriptor("conversation-singleflight");
    },
  });
  await Promise.resolve();
  assert.equal(fetches, 1, "same-conversation descriptor requests must share one in-flight fetch");
  resolveFetch();
  assert.deepEqual(await first, descriptor("conversation-singleflight"));
  assert.deepEqual(await second, descriptor("conversation-singleflight"));
}

{
  let now = 10_000;
  const sleeps = [];
  const fetchedAt = [];
  const coordinator = new NativeConversationDescriptorCoordinator({
    now: () => now,
    sleepImpl: async (ms) => { sleeps.push(ms); now += ms; },
    minimumFetchGapMs: 2_000,
    retryDelaysMs: [0],
  });
  await coordinator.load("conversation-paced-a", {
    fetchDescriptor: async () => {
      fetchedAt.push(now);
      return descriptor("conversation-paced-a");
    },
  });
  await coordinator.load("conversation-paced-b", {
    fetchDescriptor: async () => {
      fetchedAt.push(now);
      return descriptor("conversation-paced-b");
    },
  });
  assert.deepEqual(fetchedAt, [10_000, 12_000]);
  assert.ok(sleeps.includes(2_000), "fresh descriptor fetches across conversations must be globally paced");
  assert.equal(coordinator.status().minimumFetchGapMs, 2_000);
}

{
  let now = 20_000;
  let fetches = 0;
  const coordinator = new NativeConversationDescriptorCoordinator({
    now: () => now,
    sleepImpl: async (ms) => { now += ms; },
    minimumFetchGapMs: 0,
    failureCooldownMs: 300_000,
    retryDelaysMs: [0],
  });
  const notFound = async () => {
    fetches += 1;
    const error = new Error("descriptor not found");
    error.code = "NATIVE_DESCRIPTOR_NOT_FOUND";
    error.status = 404;
    throw error;
  };
  await assert.rejects(
    coordinator.load("conversation-missing", { fetchDescriptor: notFound }),
    (error) => error?.code === "NATIVE_DESCRIPTOR_NOT_FOUND",
  );
  await assert.rejects(
    coordinator.load("conversation-missing", { force: true, fetchDescriptor: notFound }),
    (error) => error?.code === "NATIVE_DESCRIPTOR_FAILURE_COOLDOWN" && error?.status === 404,
  );
  assert.equal(fetches, 1, "404/non-retryable descriptors must be negative-cached even for force=true callers");
  assert.equal(coordinator.status().failureCooldowns, 1);
  now += 300_001;
  await assert.rejects(coordinator.load("conversation-missing", { fetchDescriptor: notFound }));
  assert.equal(fetches, 2, "negative cache may retry only after its bounded cooldown expires");
}

{
  let now = 30_000;
  let fetches = 0;
  const coordinator = new NativeConversationDescriptorCoordinator({
    now: () => now,
    sleepImpl: async (ms) => { now += ms; },
    minimumFetchGapMs: 0,
    transientCooldownMs: 30_000,
    retryDelaysMs: [0, 10, 20],
  });
  const unavailable = async () => {
    fetches += 1;
    const error = new Error("temporary upstream failure");
    error.code = "NATIVE_DESCRIPTOR_HTTP";
    error.status = 503;
    throw error;
  };
  await assert.rejects(coordinator.load("conversation-transient", { fetchDescriptor: unavailable }));
  assert.equal(fetches, 3, "transient descriptor errors receive only the bounded retry schedule");
  await assert.rejects(
    coordinator.load("conversation-transient", { fetchDescriptor: unavailable }),
    (error) => error?.code === "NATIVE_DESCRIPTOR_FAILURE_COOLDOWN" && error?.status === 503,
  );
  assert.equal(fetches, 3, "transient retry exhaustion must open a per-conversation circuit");
}

{
  let now = 40_000;
  let fetches = 0;
  const coordinator = new NativeConversationDescriptorCoordinator({
    now: () => now,
    sleepImpl: async (ms) => { now += ms; },
    minimumFetchGapMs: 0,
    rateLimitCooldownMs: 90_000,
    // This fixture explicitly models a shared quota domain. Production keeps
    // the conversation-isolated default asserted by context-guardian-cdp.test.
    rateLimitScope: "shared",
    retryDelaysMs: [0, 1, 2],
  });
  const limited = async () => {
    fetches += 1;
    const error = new Error("rate limited");
    error.code = "NATIVE_DESCRIPTOR_RATE_LIMIT";
    error.status = 429;
    error.retryAfter = "120";
    throw error;
  };
  await assert.rejects(coordinator.load("conversation-limited-a", { fetchDescriptor: limited }));
  assert.equal(fetches, 1, "429 must not be retried immediately");
  await assert.rejects(
    coordinator.load("conversation-limited-b", {
      fetchDescriptor: async () => {
        fetches += 1;
        return descriptor("conversation-limited-b");
      },
    }),
    (error) => error?.code === "NATIVE_DESCRIPTOR_COOLDOWN",
  );
  assert.equal(fetches, 1, "one 429 must open the shared descriptor circuit before other runtimes fetch");
  assert.equal(coordinator.status().cooldownUntil, new Date(160_000).toISOString());
}

console.log(JSON.stringify({
  ok: true,
  gate: "context-guardian-descriptor-coordinator",
  sourcePageIdentityBound: true,
  stableRouteRequired: true,
  singleflight: true,
  globallyPaced: true,
  negativeCache404: true,
  transientCircuit: true,
  global429Circuit: true,
}));
