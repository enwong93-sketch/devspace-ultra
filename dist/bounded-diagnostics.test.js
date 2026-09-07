import assert from "node:assert/strict";
import { incrementBoundedCounter } from "./bounded-diagnostics.js";

const counters = {};
for (let index = 0; index < 100; index += 1) incrementBoundedCounter(counters, `key-${index}`, { limit: 8 });
assert.equal(Object.keys(counters).length, 8);
assert.equal(Object.hasOwn(counters, "key-0"), false);
assert.equal(Object.hasOwn(counters, "key-99"), true);
assert.equal(incrementBoundedCounter(counters, "key-99", { limit: 8 }), 2);
assert.equal(Object.keys(counters).length, 8);

const longKey = "x".repeat(5000);
incrementBoundedCounter(counters, longKey, { limit: 8, maxKeyLength: 64 });
assert.equal(Object.keys(counters).some((key) => key.length === 64), true);
assert.throws(() => incrementBoundedCounter(null, "x"), /mutable object/);

console.log(JSON.stringify({
  ok: true,
  gate: "bounded-diagnostics",
  keyCountBounded: true,
  oldestEvicted: true,
  keyLengthBounded: true,
}));
