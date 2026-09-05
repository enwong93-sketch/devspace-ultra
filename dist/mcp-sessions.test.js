import assert from "node:assert/strict";
import { McpSessionRegistry } from "./mcp-sessions.js";

let now = 0;
const registry = new McpSessionRegistry({ maxSessions: 2, now: () => now });
const closed = [];
const transport = (id) => ({ async close() { closed.push(id); } });
async function add(id) {
    const slot = await registry.reserve();
    assert.ok(slot);
    registry.register(id, transport(id));
    slot.release();
    slot.release(); // release is idempotent
}
await add("old");
now++;
await add("recent");
now++;
registry.get("old"); // recently used, so evict the other idle transport
await add("replacement");
assert.deepEqual(closed, ["recent"]);
assert.equal(registry.size, 2);
assert.equal(registry.get("recent"), undefined);
const releaseOld = registry.beginRequest("old");
const releaseReplacement = registry.beginRequest("replacement");
assert.equal(await registry.reserve(), undefined, "active requests must not be evicted");
now += 100_000;
assert.deepEqual(await registry.closeIdle(10), [], "idle timer must not close active streams");
releaseOld();
releaseOld();
await add("next");
assert.ok(closed.includes("old"));
assert.ok(!closed.includes("replacement"));
releaseReplacement();
now += 100;
assert.equal((await registry.closeIdle(10)).length, 2);
assert.equal(registry.size, 0);

// Concurrent initialization reservations count toward the same capacity.
const race = new McpSessionRegistry({ maxSessions: 2 });
const [first, second, refused] = await Promise.all([race.reserve(), race.reserve(), race.reserve()]);
assert.ok(first && second);
assert.equal(refused, undefined);
first.release(); // failed initialize releases capacity
const retry = await race.reserve();
assert.ok(retry);
second.release();
retry.release();
assert.equal(race.reservations, 0);

const failure = new McpSessionRegistry({ maxSessions: 1 });
failure.register("broken", { async close() { throw new Error("close failed"); } });
await assert.rejects(failure.reserve(), /close failed/);
assert.equal(failure.reservations, 0);
assert.equal(failure.size, 0);

// Large disconnect-like churn remains bounded without reducing idle TTL.
const churn = new McpSessionRegistry({ maxSessions: 8 });
let evictions = 0;
for (let i = 0; i < 1000; i++) {
    const slot = await churn.reserve();
    assert.ok(slot);
    churn.register(String(i), { async close() { evictions++; } });
    slot.release();
    assert.ok(churn.size <= 8);
}
assert.equal(evictions, 992);
await churn.closeAll();
assert.equal(churn.size, 0);
assert.equal(evictions, 1000);
assert.throws(() => new McpSessionRegistry({ maxSessions: 0 }), /positive integer/);
console.log(JSON.stringify({ ok: true, boundedChurn: 1000, activeRequestsProtected: true, concurrentAdmission: true, idleCleanup: true, failureRelease: true }));
