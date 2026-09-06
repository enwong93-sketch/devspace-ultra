import assert from "node:assert/strict";

let moduleUnderTest = null;
try {
  moduleUnderTest = await import("./primary-debug-guard.js");
} catch {
  // RED until implementation exists.
}

assert.equal(typeof moduleUnderTest?.ClassicPrimaryDebugGuard, "function", "ClassicPrimaryDebugGuard must exist");

const oldNow = 10_000_000;
const states = [
  { running: true, pid: 100, debugReady: false, startedAtMs: oldNow - 600_000 },
];
const repairs = [];
const guard = new moduleUnderTest.ClassicPrimaryDebugGuard({
  now: () => oldNow,
  pollMs: 60_000,
  startupRepairWindowMs: 60_000,
  async snapshot() {
    return states.at(-1);
  },
  async repair(request) {
    repairs.push(request);
    states.push({ running: true, pid: 101, debugReady: true, startedAtMs: oldNow });
    return { ok: true, pid: 101, debugReady: true };
  },
});

const initial = await guard.start({ schedule: false });
assert.equal(initial.state, "protected-existing-primary");
assert.equal(initial.protectedPid, 100);
assert.equal(repairs.length, 0, "existing long-running Main-01 must never be restarted at guard startup");

const same = await guard.pollOnce();
assert.equal(same.state, "protected-existing-primary");
assert.equal(repairs.length, 0);

states.push({ running: true, pid: 200, debugReady: false, startedAtMs: oldNow + 1_000 });
const changed = await guard.pollOnce();
assert.equal(changed.state, "repaired-primary-debug");
assert.equal(repairs.length, 1);
assert.equal(repairs[0].expectedPid, 200);
assert.equal(changed.pid, 101);
assert.equal(changed.debugReady, true);

states.push({ running: true, pid: 300, debugReady: true, startedAtMs: oldNow + 2_000 });
const alreadyReady = await guard.pollOnce();
assert.equal(alreadyReady.state, "primary-debug-ready");
assert.equal(repairs.length, 1);

await guard.close();

const freshStates = [
  { running: true, pid: 400, debugReady: false, startedAtMs: oldNow - 10_000 },
];
const freshRepairs = [];
const freshGuard = new moduleUnderTest.ClassicPrimaryDebugGuard({
  now: () => oldNow,
  startupRepairWindowMs: 60_000,
  async snapshot() { return freshStates.at(-1); },
  async repair(request) {
    freshRepairs.push(request);
    freshStates.push({ running: true, pid: 401, debugReady: true, startedAtMs: oldNow });
    return { ok: true, pid: 401, debugReady: true };
  },
});
const fresh = await freshGuard.start({ schedule: false });
assert.equal(fresh.state, "repaired-primary-debug");
assert.equal(freshRepairs.length, 1, "fresh logon/startup Main-01 should be repaired even if it appeared before backend startup");
await freshGuard.close();

const absentStates = [
  { running: false, pid: null, debugReady: false, startedAtMs: null },
];
const absentRepairs = [];
const absentGuard = new moduleUnderTest.ClassicPrimaryDebugGuard({
  now: () => oldNow,
  async snapshot() { return absentStates.at(-1); },
  async repair(request) {
    absentRepairs.push(request);
    absentStates.push({ running: true, pid: 501, debugReady: true, startedAtMs: oldNow });
    return { ok: true, pid: 501, debugReady: true };
  },
});
const absentStart = await absentGuard.start({ schedule: false });
assert.equal(absentStart.state, "primary-absent");
absentStates.push({ running: true, pid: 500, debugReady: false, startedAtMs: oldNow + 3_000 });
const appeared = await absentGuard.pollOnce();
assert.equal(appeared.state, "repaired-primary-debug");
assert.equal(absentRepairs.length, 1);
assert.equal(absentRepairs[0].expectedPid, 500);
await absentGuard.close();

console.log(JSON.stringify({
  ok: true,
  gate: "primary-debug-guard",
  protectsExisting: true,
  repairsFreshStartup: true,
  repairsNewPid: true,
  noExtraScheduledTaskRequired: true,
}));
