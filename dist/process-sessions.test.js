import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessSessionManager } from "./process-sessions.js";

const root = await mkdtemp(join(tmpdir(), "devspace-process-sessions-"));
try {
  const disposed = [];
  const manager = new ProcessSessionManager({ completedSessionTtlMs: 50 });
  const direct = await manager.start({
    workspaceId: "ws_direct",
    workspaceRoot: root,
    cwd: root,
    executable: process.execPath,
    args: ["-e", "process.stdout.write(process.env.DIRECT_VALUE || 'missing')"],
    environment: { DIRECT_VALUE: "direct-ok", REMOVE_ME: null },
    yieldTimeMs: 10_000,
    maxOutputTokens: 100,
    onDispose: () => { disposed.push("direct"); },
  });
  assert.equal(direct.running, false);
  assert.equal(direct.exitCode, 0);
  assert.equal(direct.output, "direct-ok");
  assert.deepEqual(disposed, ["direct"], "completed direct execution must dispose its owned temporary resources");

  let longDisposed = false;
  const running = await manager.start({
    workspaceId: "ws_long",
    workspaceRoot: root,
    cwd: root,
    executable: process.execPath,
    args: ["-e", "setTimeout(()=>{process.stdout.write('later')},80)"],
    yieldTimeMs: 0,
    maxOutputTokens: 100,
    onDispose: async () => { longDisposed = true; },
  });
  assert.equal(running.running, true);
  assert.equal(Number.isInteger(running.sessionId), true);
  assert.equal(longDisposed, false, "running process must retain its temporary resources");
  await new Promise((resolve) => setTimeout(resolve, 120));
  const completed = await manager.write({
    workspaceId: "ws_long",
    sessionId: running.sessionId,
    chars: "",
    yieldTimeMs: 1_000,
    maxOutputTokens: 100,
  });
  assert.equal(completed.running, false);
  assert.equal(completed.exitCode, 0);
  assert.equal(completed.output, "later");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(longDisposed, true, "completed interactive session must dispose its temporary resources");

  let shutdownDisposed = false;
  const shutdownRun = await manager.start({
    workspaceId: "ws_shutdown",
    workspaceRoot: root,
    cwd: root,
    executable: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    yieldTimeMs: 0,
    maxOutputTokens: 100,
    onDispose: () => { shutdownDisposed = true; },
  });
  assert.equal(shutdownRun.running, true);
  manager.shutdown();
  assert.equal(shutdownDisposed, true, "manager shutdown must dispose resources even for running processes");
  assert.equal(manager.sessions.size, 0);

  console.log(JSON.stringify({
    ok: true,
    gate: "process-sessions",
    directExecutableAndArgs: true,
    scopedEnvironment: true,
    asyncSessionCleanup: true,
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
