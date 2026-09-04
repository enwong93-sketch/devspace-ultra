#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDevspaceFiles } from "../dist/user-config.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const statusOnly = process.argv.includes("--status");
const foreground = process.argv.includes("--foreground");
const files = loadDevspaceFiles();
const config = files.config ?? {};
const fixedBase = String(config.edgePublicBaseUrl ?? "").trim().replace(/\/$/, "");
const fixedPort = Number(config.edgeBackendPort ?? 7677);
const fixedStateDir = String(config.edgeFixedStateDir ?? join(homedir(), ".local", "share", "devspace-fixed"));
const logDir = join(files.dir, "logs");
const stdoutPath = join(logDir, "fixed-backend.out.log");
const stderrPath = join(logDir, "fixed-backend.err.log");

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const emit = (payload) => console.log(JSON.stringify({ ...payload, secretValuesLogged: false }));

async function localIdentity() {
  try {
    const health = await fetch(`http://127.0.0.1:${fixedPort}/healthz`, { signal: AbortSignal.timeout(2_500) });
    if (!health.ok) return { state: "occupied-unhealthy", status: health.status };
    const prmResponse = await fetch(`http://127.0.0.1:${fixedPort}/.well-known/oauth-protected-resource/mcp`, { signal: AbortSignal.timeout(2_500) });
    const prm = prmResponse.ok ? await prmResponse.json() : null;
    if (prmResponse.ok && prm?.resource === `${fixedBase}/mcp`) {
      return { state: "ready", resource: prm.resource };
    }
    return { state: "occupied-wrong-identity", resource: prm?.resource ?? null, status: prmResponse.status };
  } catch (error) {
    if (error?.cause?.code === "ECONNREFUSED" || error?.code === "ECONNREFUSED") return { state: "down" };
    if (String(error?.message ?? "").includes("fetch failed")) return { state: "down" };
    return { state: "probe-failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  if (!/^https:\/\//i.test(fixedBase)) {
    emit({ ok: false, state: "invalid-config", reason: "edgePublicBaseUrl-missing" });
    return 2;
  }
  if (!Number.isInteger(fixedPort) || fixedPort < 1024 || fixedPort > 65535 || fixedPort === 7676) {
    emit({ ok: false, state: "invalid-config", reason: "edgeBackendPort-invalid" });
    return 2;
  }

  const fixedHost = new URL(fixedBase).hostname;
  const expectedResource = `${fixedBase}/mcp`;
  const before = await localIdentity();

  if (before.state === "ready") {
    emit({ ok: true, state: "already-running", port: fixedPort, publicBaseUrl: fixedBase, resource: expectedResource });
    return 0;
  }
  if (statusOnly) {
    emit({ ok: true, state: before.state, port: fixedPort, publicBaseUrl: fixedBase, resource: expectedResource });
    return 0;
  }
  if (before.state !== "down") {
    emit({ ok: false, state: before.state, port: fixedPort, expectedResource, observedResource: before.resource ?? null });
    return 3;
  }

  mkdirSync(logDir, { recursive: true });
  mkdirSync(fixedStateDir, { recursive: true });
  const stdoutFd = openSync(stdoutPath, "a");
  const stderrFd = openSync(stderrPath, "a");
  const childEnv = {
    ...process.env,
    PORT: String(fixedPort),
    DEVSPACE_PUBLIC_BASE_URL: fixedBase,
    DEVSPACE_STATE_DIR: fixedStateDir,
    DEVSPACE_ALLOWED_HOSTS: ["localhost", "127.0.0.1", "::1", fixedHost].join(","),
  };
  delete childEnv.DEVSPACE_CONFIG_DIR;

  let child;
  try {
    child = spawn(process.execPath, ["dist/cli.js", "serve"], {
      cwd: packageRoot,
      env: childEnv,
      detached: !foreground,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
    if (!foreground) child.unref();
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }

  let after = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(300);
    after = await localIdentity();
    if (after.state === "ready") break;
    if (after.state !== "down") break;
  }

  if (after?.state !== "ready") {
    emit({
      ok: false,
      state: "start-verification-failed",
      port: fixedPort,
      pid: child.pid,
      observed: after,
      stdoutPath,
      stderrPath,
    });
    return 4;
  }

  emit({
    ok: true,
    state: foreground ? "running-foreground" : "started",
    port: fixedPort,
    pid: child.pid,
    publicBaseUrl: fixedBase,
    resource: expectedResource,
    stateDir: fixedStateDir,
    stdoutPath,
    stderrPath,
  });
  if (foreground) {
    return await new Promise((resolvePromise) => {
      child.once("error", () => resolvePromise(1));
      child.once("exit", (code) => resolvePromise(Number(code ?? 1)));
    });
  }
  return 0;
}

process.exitCode = await main();
