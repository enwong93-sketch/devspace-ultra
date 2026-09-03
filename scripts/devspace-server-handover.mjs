import { spawn } from "node:child_process";
import { resolve } from "node:path";

const pid = Number(process.argv[2]);
const root = process.argv[3] ? resolve(process.argv[3]) : process.cwd();
if (!Number.isInteger(pid) || pid <= 0) {
  console.error("Usage: node scripts/devspace-server-handover.mjs <old-pid> <package-root>");
  process.exit(2);
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
await sleep(1800);
if (process.platform === "win32") {
  await new Promise((resolvePromise) => {
    // Kill only the old DevSpace Node PID. Using /T also kills this detached
    // handover helper because it was launched from the old server process tree,
    // preventing the replacement server from ever being spawned.
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/F"], { windowsHide: true, stdio: "ignore" });
    killer.once("exit", resolvePromise);
    killer.once("error", resolvePromise);
  });
} else {
  try { process.kill(pid, "SIGTERM"); } catch {}
  await sleep(500);
}

const child = spawn(process.execPath, ["dist/cli.js", "serve"], {
  cwd: root,
  detached: true,
  windowsHide: true,
  stdio: "ignore",
});
child.unref();
