import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boundedLogOptionsFromEnv,
  createBoundedLogWriter,
  rotateLogFileSetSync,
} from "./bounded-log-files.js";

function finished(stream) {
  return new Promise((resolve, reject) => {
    stream.once("finish", resolve);
    stream.once("error", reject);
    stream.end();
  });
}

const root = await mkdtemp(join(tmpdir(), "devspace-bounded-logs-"));
try {
  assert.deepEqual(boundedLogOptionsFromEnv({
    DEVSPACE_LOG_MAX_BYTES: "65536",
    DEVSPACE_LOG_BACKUPS: "3",
    DEVSPACE_LOG_MAX_AGE_DAYS: "2",
  }), {
    maxBytes: 65536,
    maxBackups: 3,
    maxAgeMs: 2 * 86_400_000,
  });

  const path = join(root, "service.out.log");
  writeFileSync(path, "first-generation");
  rotateLogFileSetSync(path, { maxBytes: 8, maxBackups: 2, force: true });
  assert.equal(readFileSync(`${path}.1`, "utf8"), "first-generation".slice(-8), "legacy oversized logs retain only the bounded tail");

  writeFileSync(path, "second-generation");
  rotateLogFileSetSync(path, { maxBytes: 8, maxBackups: 2, force: true });
  assert.equal(readFileSync(`${path}.1`, "utf8"), "second-generation".slice(-8));
  assert.equal(readFileSync(`${path}.2`, "utf8"), "first-generation".slice(-8));
  assert.equal(existsSync(`${path}.3`), false);

  const old = (Date.now() - 10 * 86_400_000) / 1000;
  utimesSync(`${path}.2`, old, old);
  rotateLogFileSetSync(path, { maxBytes: 1024, maxBackups: 2, maxAgeMs: 86_400_000 });
  assert.equal(existsSync(`${path}.2`), false, "expired backup should be removed");

  const livePath = join(root, "live.log");
  const writer = createBoundedLogWriter(livePath, { maxBytes: 64, maxBackups: 2 });
  for (let index = 0; index < 20; index += 1) {
    writer.write(`${String(index).padStart(2, "0")}:${"x".repeat(12)}\n`);
  }
  await finished(writer);
  const files = (await readdir(root)).filter((name) => name === "live.log" || name.startsWith("live.log."));
  assert.equal(files.length <= 3, true, `writer retained too many files: ${files.join(",")}`);
  for (const name of files) assert.equal(statSync(join(root, name)).size <= 64, true, `${name} exceeded cap`);
  const diagnostics = writer.diagnostics();
  assert.equal(diagnostics.rotations > 0, true);
  assert.equal(diagnostics.bufferedBytes, 0);
  assert.equal(Object.hasOwn(writer, "chunks"), false, "writer must not retain an output history array");

  const hugePath = join(root, "huge.log");
  const huge = createBoundedLogWriter(hugePath, { maxBytes: 32, maxBackups: 1 });
  huge.write("a".repeat(128));
  await finished(huge);
  assert.equal(statSync(hugePath).size, 32, "oversized single writes keep only a bounded tail");

  console.log(JSON.stringify({
    ok: true,
    gate: "bounded-log-files",
    sizeRotation: true,
    generationBound: true,
    agePruning: true,
    streamBackpressure: true,
    inMemoryHistoryRetained: false,
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
