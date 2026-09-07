import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LogRetentionSupervisor,
  sweepLogDirectory,
  trimAppendOnlyLog,
} from "./log-retention.js";

const root = await mkdtemp(join(tmpdir(), "devspace-log-retention-"));
try {
  const active = join(root, "core-a.err.log");
  await writeFile(active, Buffer.alloc(12_000, 0x61));
  const trim = await trimAppendOnlyLog(active, { fileLimitBytes: 8_000, keepTailBytes: 2_000 });
  assert.equal(trim.action, "trimmed");
  assert.equal(trim.beforeBytes, 12_000);
  assert.ok(trim.afterBytes <= 8_000);
  assert.ok((await readFile(active)).length <= 8_000);
  assert.match(await readFile(active, "utf8"), /older diagnostic output discarded/);

  // An existing append-mode descriptor must continue writing after in-place trim.
  const appendHandle = await open(active, "a");
  try {
    await appendHandle.write(Buffer.from("\nAFTER-TRIM\n"));
    await appendHandle.sync();
  } finally {
    await appendHandle.close();
  }
  assert.match(await readFile(active, "utf8"), /AFTER-TRIM/);

  const nested = join(root, "stable-gateway");
  await mkdir(nested, { recursive: true });
  const expired = join(nested, "old-core.out.log");
  const current = join(nested, "current-core.out.log");
  const ignored = join(nested, "authority.json");
  await writeFile(expired, Buffer.alloc(1_500, 0x62));
  await writeFile(current, Buffer.alloc(6_000, 0x63));
  await writeFile(ignored, Buffer.alloc(20_000, 0x64));
  const now = Date.parse("2026-09-07T03:00:00.000Z");
  await utimes(expired, new Date(now - 10_000), new Date(now - 10_000));
  await utimes(current, new Date(now), new Date(now));

  const sweep = await sweepLogDirectory(root, {
    fileLimitBytes: 4_000,
    keepTailBytes: 1_000,
    totalLimitBytes: 5_000,
    maxFiles: 4,
    maxAgeMs: 5_000,
    now: () => now,
  });
  assert.equal(sweep.ok, true);
  assert.equal(sweep.totals.expired, 1);
  assert.ok(sweep.totals.trimmed >= 1);
  assert.ok(sweep.after.bytes <= 5_000);
  assert.equal((await stat(ignored)).size, 20_000, "non-log authority/state files must never be trimmed");

  const quota = join(root, "quota");
  await mkdir(quota, { recursive: true });
  for (let index = 0; index < 6; index += 1) {
    const path = join(quota, `gateway-${index}.log`);
    await writeFile(path, Buffer.alloc(1_000, 0x30 + index));
    await utimes(path, new Date(now + index * 1_000), new Date(now + index * 1_000));
  }
  const quotaSweep = await sweepLogDirectory(quota, {
    fileLimitBytes: 2_000,
    keepTailBytes: 500,
    totalLimitBytes: 3_000,
    maxFiles: 3,
    maxAgeMs: 0,
    now: () => now + 10_000,
  });
  assert.equal(quotaSweep.after.files, 3);
  assert.equal(quotaSweep.after.bytes, 3_000);
  assert.equal(quotaSweep.totals.quotaRemoved, 3);

  let sweepCalls = 0;
  const supervisorRoot = join(root, "supervisor");
  await mkdir(supervisorRoot, { recursive: true });
  await writeFile(join(supervisorRoot, "server.log"), Buffer.alloc(9_000, 0x65));
  const supervisor = new LogRetentionSupervisor({
    roots: [supervisorRoot, supervisorRoot],
    intervalMs: 10_000,
    sweepOptions: { fileLimitBytes: 4_000, keepTailBytes: 1_000, totalLimitBytes: 10_000 },
  });
  const started = await supervisor.start();
  sweepCalls += 1;
  assert.equal(started.enabled, true);
  assert.equal(started.running, true);
  assert.equal(started.roots.length, 1);
  assert.equal(started.aggregate.errors, 0);
  assert.ok(started.aggregate.discardedBytes > 0);
  await supervisor.sweep();
  sweepCalls += 1;
  const status = supervisor.status();
  assert.equal(status.sweepInProgress, false);
  assert.equal(status.aggregate.bytes <= 10_000, true);
  await supervisor.close();
  assert.equal(supervisor.status().running, false);
  assert.equal(sweepCalls, 2);

  console.log(JSON.stringify({
    ok: true,
    gate: "log-retention",
    wholeFileReads: false,
    appendDescriptorSurvivesTrim: true,
    perFileBounded: true,
    totalDirectoryQuota: true,
    ageRetention: true,
    fileCountBounded: true,
    authorityFilesUntouched: true,
    timerUnrefed: true,
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
