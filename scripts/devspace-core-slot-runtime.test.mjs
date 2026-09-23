import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { coreSlotInternals } from "./devspace-core-slot.mjs";

function response(body, { ok = true } = {}) {
  return {
    ok,
    async json() { return structuredClone(body); },
  };
}

function liveChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.killedWith = [];
  child.kill = (signal) => {
    child.killedWith.push(signal);
    child.exitCode = 1;
    queueMicrotask(() => child.emit("exit", 1, signal));
    return true;
  };
  return child;
}

test("Core readiness accepts only the spawned process identity", async () => {
  const child = liveChild(41001);
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (String(url).endsWith("/healthz")) return response({ ok: true });
    if (String(url).includes("oauth-protected-resource")) {
      return response({ resource: "https://devspace.example.test/mcp" });
    }
    if (String(url).endsWith("/__devspace/memory/status")) return response({ pid: child.pid });
    throw new Error(`Unexpected URL ${url}`);
  };
  await coreSlotInternals.waitForCoreIdentity({
    baseUrl: "http://127.0.0.1:19080",
    publicBaseUrl: "https://devspace.example.test",
    child,
    fetchImpl,
  });
  assert.equal(seen.some((url) => url.endsWith("/__devspace/memory/status")), true);
});

test("a healthy listener owned by another PID cannot satisfy a new Core handle", async () => {
  const child = liveChild(42002);
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/healthz")) return response({ ok: true });
    if (String(url).includes("oauth-protected-resource")) {
      return response({ resource: "https://devspace.example.test/mcp" });
    }
    if (String(url).endsWith("/__devspace/memory/status")) return response({ pid: 41999 });
    throw new Error(`Unexpected URL ${url}`);
  };
  await assert.rejects(
    () => coreSlotInternals.waitForCoreIdentity({
      baseUrl: "http://127.0.0.1:19080",
      publicBaseUrl: "https://devspace.example.test",
      child,
      fetchImpl,
    }),
    (error) => {
      assert.equal(error?.code, "DEVSPACE_CORE_IDENTITY_MISMATCH");
      assert.equal(error?.expectedPid, child.pid);
      assert.equal(error?.observedPid, 41999);
      return true;
    },
  );
});

test("a rejected Core startup terminates the spawned foreign-listener child", async () => {
  const child = liveChild(43003);
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/healthz")) return response({ ok: true });
    if (String(url).includes("oauth-protected-resource")) {
      return response({ resource: "https://devspace.example.test/mcp" });
    }
    if (String(url).endsWith("/__devspace/memory/status")) return response({ pid: 42999 });
    throw new Error(`Unexpected URL ${url}`);
  };
  await assert.rejects(
    () => coreSlotInternals.completeCoreStartup({
      baseUrl: "http://127.0.0.1:19080",
      publicBaseUrl: "https://devspace.example.test",
      child,
      fetchImpl,
    }),
    (error) => error?.code === "DEVSPACE_CORE_IDENTITY_MISMATCH",
  );
  assert.deepEqual(child.killedWith, ["SIGTERM"],
    "a spawned process rejected by the listener PID proof must not survive as a handle-less Core");
  assert.equal(child.exitCode, 1);
});

test("candidate snapshot copy retries only transient atomic temp races", async () => {
  let calls = 0;
  const copied = await coreSlotInternals.copyCandidateState("source", "destination", {
    attempts: 3,
    cpImpl: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("lstat source/goal-state.json.123.tmp");
        error.code = "ENOENT";
        error.path = "source/goal-state.json.123.tmp";
        throw error;
      }
    },
  });
  assert.equal(copied.attempts, 2);
  assert.equal(calls, 2);

  const permanent = new Error("lstat source/goal-state.json");
  permanent.code = "ENOENT";
  permanent.path = "source/goal-state.json";
  await assert.rejects(
    () => coreSlotInternals.copyCandidateState("source", "destination", {
      attempts: 3,
      cpImpl: async () => { throw permanent; },
    }),
    permanent,
  );
});

console.log(JSON.stringify({
  ok: true,
  gate: "devspace-core-slot-runtime",
  spawnedPidRequired: true,
  foreignListenerRejected: true,
  rejectedStartupChildTerminated: true,
  transientAtomicCopyRetried: true,
}));
