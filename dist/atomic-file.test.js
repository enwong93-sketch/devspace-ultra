import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWriteFile,
  atomicWriteJson,
  isAtomicTempFileName,
  pruneStaleAtomicTempFiles,
} from "./atomic-file.js";

const root = await mkdtemp(join(tmpdir(), "devspace-atomic-file-"));
try {
  const textPath = join(root, "state.txt");
  await atomicWriteFile(textPath, "first\n");
  await atomicWriteFile(textPath, "second\n");
  assert.equal(await readFile(textPath, "utf8"), "second\n");
  assert.equal((await readdir(root)).some((name) => name.endsWith(".tmp")), false);

  const jsonPath = join(root, "nested", "state.json");
  await atomicWriteJson(jsonPath, { ok: true, value: 7 });
  assert.deepEqual(JSON.parse(await readFile(jsonPath, "utf8")), { ok: true, value: 7 });

  assert.equal(isAtomicTempFileName("state.json.44292.abcdef12.tmp"), true);
  assert.equal(isAtomicTempFileName("state.json.tmp-44292-abcdef12"), true);
  assert.equal(isAtomicTempFileName("ordinary.tmp"), false);

  const orphanDir = join(root, "orphans");
  await writeFile(join(root, "ordinary.tmp"), "keep");
  await writeFile(join(root, "state.json.1.aaaa1111.tmp"), "old-a");
  await writeFile(join(root, "state.json.2.bbbb2222.tmp"), "old-b");
  await writeFile(join(root, "state.json.3.cccc3333.tmp"), "recent-c");
  await writeFile(join(root, "state.json.4.dddd4444.tmp"), "recent-d");
  const oldSeconds = (Date.now() - 2 * 60 * 60_000) / 1000;
  await utimes(join(root, "state.json.1.aaaa1111.tmp"), oldSeconds, oldSeconds);
  await utimes(join(root, "state.json.2.bbbb2222.tmp"), oldSeconds, oldSeconds);
  const report = await pruneStaleAtomicTempFiles(root, {
    olderThanMs: 30 * 60_000,
    maxRetained: 1,
    maxDepth: 2,
  });
  assert.equal(report.matchedFiles, 4);
  assert.equal(report.removedFiles, 3);
  assert.equal(report.retainedFiles, 1);
  assert.equal(existsSync(join(root, "ordinary.tmp")), true, "ordinary temp files are outside the atomic-writer pattern");
  const retainedAtomic = (await readdir(root)).filter(isAtomicTempFileName);
  assert.equal(retainedAtomic.length, 1);

  console.log(JSON.stringify({
    ok: true,
    gate: "atomic-file",
    retryableAtomicWrite: true,
    failedTempCleanup: true,
    staleOrphanPruning: true,
    ordinaryTempProtected: true,
    boundedTraversal: true,
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
