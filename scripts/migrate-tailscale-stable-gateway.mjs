#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { closeSync, createReadStream, existsSync, mkdirSync, openSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { GoalRuntime } from "../dist/goal-runtime.js";
import { PlanRuntime } from "../dist/plan-runtime.js";
import { loadDevspaceFiles } from "../dist/user-config.js";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATEWAY_PORT = Number(process.env.DEVSPACE_STABLE_GATEWAY_PORT || 7678);
const CORE_A_PORT = Number(process.env.DEVSPACE_STABLE_GATEWAY_CORE_A_PORT || 7688);
const CORE_B_PORT = Number(process.env.DEVSPACE_STABLE_GATEWAY_CORE_B_PORT || 7689);
const GOAL_ID = "goal_deac9fadb6bc67dd";
const PLAN_ID = "plan_dfc1ea0e2b285119";
const BOOTSTRAP_CONFIG_DIR = process.env.DEVSPACE_STABLE_GATEWAY_CONFIG_DIR || process.env.DEVSPACE_TAILSCALE_CONFIG_DIR || join(homedir(), ".devspace-tailscale-bootstrap");
const BOOTSTRAP_STATE_DIR = process.env.DEVSPACE_STABLE_GATEWAY_STATE_DIR || process.env.DEVSPACE_TAILSCALE_STATE_DIR || join(homedir(), ".local", "share", "devspace-tailscale-bootstrap");
const CANONICAL_CONFIG_DIR = process.env.DEVSPACE_CANONICAL_CONFIG_DIR || join(homedir(), ".devspace");
const LEGACY_STATE_DIR = process.env.DEVSPACE_LEGACY_STATE_DIR || join(homedir(), ".local", "share", "devspace-fixed-candidate");
const STATUS_PATH = join(BOOTSTRAP_CONFIG_DIR, "logs", "stable-gateway-migration.json");
const dryRun = process.argv.includes("--dry-run");
const worker = process.argv.includes("--worker");

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function safeReport(payload) {
  return { ...payload, secretValuesLogged: false };
}

function normalizePublicBase(value) {
  const parsed = new URL(String(value || "").trim());
  if (parsed.protocol !== "https:") throw new Error("Stable Gateway public base must use https.");
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = "/";
  return parsed.toString().replace(/\/$/, "");
}

function resolvePublicBase(bootstrapConfig = {}) {
  const value = process.env.DEVSPACE_STABLE_GATEWAY_PUBLIC_BASE_URL
    || process.env.DEVSPACE_PUBLIC_BASE_URL
    || bootstrapConfig.stableGatewayPublicBaseUrl
    || bootstrapConfig.publicBaseUrl
    || bootstrapConfig.edgePublicBaseUrl;
  if (!String(value || "").trim()) throw new Error("Stable Gateway public base URL is unavailable.");
  return normalizePublicBase(value);
}

async function writeStatus(payload) {
  await mkdir(dirname(STATUS_PATH), { recursive: true });
  await writeFile(STATUS_PATH, `${JSON.stringify(safeReport({ observedAt: new Date().toISOString(), ...payload }))}\n`, "utf8");
}

async function listenerPid(port) {
  const command = `$c=Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | Select-Object -First 1; if($c){ $c.OwningProcess }; exit 0`;
  const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", command], { windowsHide: true });
  const pid = Number(String(stdout).trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function processIdentity(pid) {
  if (!pid) return null;
  const command = `$p=Get-CimInstance Win32_Process -Filter \"ProcessId = ${Number(pid)}\" -ErrorAction SilentlyContinue; if($p){ [pscustomobject]@{ProcessId=$p.ProcessId;Name=$p.Name;CommandLine=$p.CommandLine} | ConvertTo-Json -Compress }`;
  const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", command], { windowsHide: true });
  const raw = String(stdout).trim();
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  return {
    pid: Number(parsed.ProcessId),
    name: String(parsed.Name || ""),
    commandLine: String(parsed.CommandLine || ""),
  };
}

async function localIdentity(publicBase, port = GATEWAY_PORT) {
  try {
    const health = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2_500), cache: "no-store" });
    const healthBody = await health.json().catch(() => null);
    const prm = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`, { signal: AbortSignal.timeout(2_500), cache: "no-store" });
    const prmBody = await prm.json().catch(() => null);
    return {
      ok: health.ok && healthBody?.ok === true && prm.ok && prmBody?.resource === `${publicBase}/mcp`,
      healthStatus: health.status,
      resourceStatus: prm.status,
      resource: prmBody?.resource ?? null,
    };
  } catch {
    return { ok: false, healthStatus: null, resourceStatus: null, resource: null };
  }
}

async function localStableGatewayIdentity(publicBase, port = GATEWAY_PORT) {
  const base = await localIdentity(publicBase, port);
  try {
    const gateway = await fetch(`http://127.0.0.1:${port}/__devspace/gateway/healthz`, { signal: AbortSignal.timeout(2_500), cache: "no-store" });
    const gatewayBody = await gateway.json().catch(() => null);
    return {
      ...base,
      ok: base.ok && gateway.ok && gatewayBody?.gateway === "stable" && gatewayBody?.state === "ready",
      gatewayStatus: gateway.status,
      stableGateway: gatewayBody?.gateway === "stable",
      gatewayState: gatewayBody?.state ?? null,
    };
  } catch {
    return { ...base, ok: false, gatewayStatus: null, stableGateway: false, gatewayState: null };
  }
}

async function publicIdentity(publicBase) {
  try {
    const health = await fetch(`${publicBase}/healthz`, { signal: AbortSignal.timeout(8_000), cache: "no-store" });
    const healthBody = await health.json().catch(() => null);
    const prm = await fetch(`${publicBase}/.well-known/oauth-protected-resource/mcp`, { signal: AbortSignal.timeout(8_000), cache: "no-store" });
    const prmBody = await prm.json().catch(() => null);
    const as = await fetch(`${publicBase}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(8_000), cache: "no-store" });
    const asBody = await as.json().catch(() => null);
    const mcp = await fetch(`${publicBase}/mcp`, { signal: AbortSignal.timeout(8_000), cache: "no-store", redirect: "manual" });
    const challenge = mcp.headers.get("www-authenticate") || "";
    const expectedResource = `${publicBase}/mcp`;
    return {
      ok: health.ok && healthBody?.ok === true
        && prm.ok && prmBody?.resource === expectedResource
        && as.ok && asBody?.issuer === `${publicBase}/`
        && asBody?.scopes_supported?.includes("offline_access")
        && mcp.status === 401 && /resource_metadata=/i.test(challenge),
      healthStatus: health.status,
      resourceStatus: prm.status,
      authorizationStatus: as.status,
      mcpStatus: mcp.status,
      challengePresent: /resource_metadata=/i.test(challenge),
      resource: prmBody?.resource ?? null,
      issuer: asBody?.issuer ?? null,
      offlineAccess: Boolean(asBody?.scopes_supported?.includes("offline_access")),
    };
  } catch {
    return { ok: false, healthStatus: null, resourceStatus: null, authorizationStatus: null, mcpStatus: null, challengePresent: false, resource: null, issuer: null, offlineAccess: false };
  }
}

function buildProductionConfig(canonical, publicBase) {
  const copyKeys = [
    "allowedHosts",
    "allowedRoots",
    "worktreeRoot",
    "pluginPaths",
    "autoCompactEnabled",
    "autoCompactThreshold",
    "autoCompactContextWindowTokens",
    "autoCompactReserveTokens",
    "autoCompactPollSeconds",
    "autoCompactResumeTimeoutSeconds",
  ];
  const next = {};
  for (const key of copyKeys) {
    if (Object.hasOwn(canonical, key)) next[key] = canonical[key];
  }
  return {
    ...next,
    host: "127.0.0.1",
    port: GATEWAY_PORT,
    publicBaseUrl: publicBase,
    stateDir: BOOTSTRAP_STATE_DIR,
    stableGatewayPort: GATEWAY_PORT,
    stableGatewayPublicBaseUrl: publicBase,
    stableGatewayStateDir: BOOTSTRAP_STATE_DIR,
    stableGatewayCoreAPort: CORE_A_PORT,
    stableGatewayCoreBPort: CORE_B_PORT,
    edgeBackendPort: GATEWAY_PORT,
    edgePublicBaseUrl: publicBase,
    edgeFixedStateDir: BOOTSTRAP_STATE_DIR,
  };
}

const OAUTH_COUNT_TABLES = new Set(["oauth_clients", "oauth_access_tokens", "oauth_refresh_tokens", "workspace_sessions"]);

function oauthCounts(stateDir) {
  const db = new Database(join(stateDir, "devspace.sqlite"), { readonly: true, fileMustExist: true });
  try {
    const count = (table) => {
      if (!OAUTH_COUNT_TABLES.has(table)) throw new Error(`Unexpected table name: ${table}`);
      return db.prepare(`select count(*) as n from ${table}`).get().n;
    };
    return {
      clients: count("oauth_clients"),
      accessTokens: count("oauth_access_tokens"),
      refreshTokens: count("oauth_refresh_tokens"),
      workspaceSessions: count("workspace_sessions"),
    };
  } finally {
    db.close();
  }
}

async function verifyGoalPlan(stateDir) {
  const goalRuntime = new GoalRuntime({ stateDir });
  const planRuntime = new PlanRuntime({ stateDir });
  try {
    const goal = await goalRuntime.status(GOAL_ID);
    const plan = await planRuntime.status(PLAN_ID);
    assert.equal(goal.status, "paused");
    assert.equal(goal.round, 3);
    assert.equal(goal.roundState, "working");
    assert.equal(goal.revision, 31);
    assert.equal(goal.continuation?.state, "idle");
    assert.equal(plan.revision, 12);
    assert.equal(plan.steps.length, 10);
    assert.equal(plan.steps[9].status, "in_progress");
    return {
      goalStatus: goal.status,
      goalRound: goal.round,
      goalRevision: goal.revision,
      goalContinuationState: goal.continuation.state,
      planRevision: plan.revision,
      planStep10: plan.steps[9].status,
    };
  } finally {
    await Promise.all([goalRuntime.close(), planRuntime.close()]);
  }
}

async function makeBackup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = join(BOOTSTRAP_CONFIG_DIR, "migration-backups", stamp);
  await mkdir(join(backupDir, "config"), { recursive: true });
  await mkdir(join(backupDir, "state"), { recursive: true });
  for (const name of ["config.json", "auth.json"]) {
    const source = join(BOOTSTRAP_CONFIG_DIR, name);
    if (existsSync(source)) await copyFile(source, join(backupDir, "config", name));
  }
  for (const name of ["goal-state.json", "plan-state.json", "classic-host-overlay-owner.json"]) {
    const source = join(BOOTSTRAP_STATE_DIR, name);
    if (existsSync(source)) await copyFile(source, join(backupDir, "state", name));
  }
  const sqliteSource = join(BOOTSTRAP_STATE_DIR, "devspace.sqlite");
  const sqliteBackup = join(backupDir, "state", "devspace.sqlite");
  const db = new Database(sqliteSource, { readonly: true, fileMustExist: true });
  try { await db.backup(sqliteBackup); } finally { db.close(); }
  return backupDir;
}

async function atomicJson(path, value) {
  const temp = `${path}.migration-next-${process.pid}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

async function atomicCopy(source, destination) {
  const temp = `${destination}.migration-next-${process.pid}`;
  await copyFile(source, temp);
  await rename(temp, destination);
}

async function waitForPortState(port, wantedListening, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = await listenerPid(port);
    if (wantedListening ? Boolean(pid) : !pid) return pid;
    await sleep(200);
  }
  throw new Error(`Port ${port} did not reach expected listening=${wantedListening}.`);
}

async function stopLegacyPid(pid) {
  if (!pid) throw new Error("Legacy 7678 PID is missing.");
  try { process.kill(pid, "SIGTERM"); } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  await waitForPortState(GATEWAY_PORT, false, 12_000);
}

async function installStableGatewayTask() {
  const script = join(packageRoot, "scripts", "devspace-stable-gateway-startup.ps1");
  const { stdout, stderr } = await execFileAsync("powershell", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", script,
    "-Action", "install",
    "-ConfigDir", BOOTSTRAP_CONFIG_DIR,
  ], { cwd: packageRoot, windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
  if (String(stderr).trim()) throw new Error("Stable Gateway startup installer returned stderr.");
  const raw = String(stdout).trim().split(/\r?\n/).filter(Boolean).at(-1) || "";
  const parsed = JSON.parse(raw);
  if (parsed?.Ok !== true && parsed?.ok !== true) throw new Error("Stable Gateway Scheduled Task installation did not verify healthy.");
  return { taskName: parsed.TaskName ?? "DevSpace-Stable-Gateway", taskState: parsed.TaskState ?? null };
}

async function removeStableGatewayTask() {
  const script = join(packageRoot, "scripts", "devspace-stable-gateway-startup.ps1");
  await execFileAsync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Action", "remove", "-ConfigDir", BOOTSTRAP_CONFIG_DIR], {
    cwd: packageRoot,
    windowsHide: true,
    timeout: 30_000,
  }).catch(() => {});
}

async function restoreLegacyCore(publicBase) {
  const logDir = join(BOOTSTRAP_CONFIG_DIR, "logs");
  mkdirSync(logDir, { recursive: true });
  const stdoutFd = openSync(join(logDir, "legacy-rollback.out.log"), "a");
  const stderrFd = openSync(join(logDir, "legacy-rollback.err.log"), "a");
  const fixedHost = new URL(publicBase).hostname;
  const env = {
    ...process.env,
    PORT: String(GATEWAY_PORT),
    DEVSPACE_CONFIG_DIR: CANONICAL_CONFIG_DIR,
    DEVSPACE_PUBLIC_BASE_URL: publicBase,
    DEVSPACE_STATE_DIR: BOOTSTRAP_STATE_DIR,
    DEVSPACE_ALLOWED_HOSTS: ["localhost", "127.0.0.1", "::1", fixedHost].join(","),
    DEVSPACE_OAUTH_SCOPES: "devspace,offline_access",
  };
  const { spawn } = await import("node:child_process");
  try {
    const child = spawn(process.execPath, ["dist/cli.js", "serve"], {
      cwd: packageRoot,
      env,
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
    child.unref();
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  await waitForPortState(GATEWAY_PORT, true, 15_000);
  const identity = await localIdentity(publicBase);
  if (!identity.ok) throw new Error("Legacy rollback Core did not restore the stable public identity.");
}

async function restoreFilesFromBackup(backupDir) {
  for (const name of ["config.json", "auth.json"]) {
    const backup = join(backupDir, "config", name);
    const target = join(BOOTSTRAP_CONFIG_DIR, name);
    if (existsSync(backup)) await copyFile(backup, target);
    else await rm(target, { force: true });
  }
  for (const name of ["goal-state.json", "plan-state.json", "classic-host-overlay-owner.json"]) {
    const backup = join(backupDir, "state", name);
    const target = join(BOOTSTRAP_STATE_DIR, name);
    if (existsSync(backup)) await copyFile(backup, target);
    else await rm(target, { force: true });
  }
}

async function preflight() {
  const canonicalFiles = loadDevspaceFiles({ ...process.env, DEVSPACE_CONFIG_DIR: CANONICAL_CONFIG_DIR });
  const bootstrapFiles = loadDevspaceFiles({ ...process.env, DEVSPACE_CONFIG_DIR: BOOTSTRAP_CONFIG_DIR });
  if (!canonicalFiles.auth?.ownerToken) throw new Error("Canonical owner auth is unavailable.");
  if (!bootstrapFiles.configExists) throw new Error("Stable Gateway bootstrap config is unavailable.");
  if (!existsSync(join(BOOTSTRAP_STATE_DIR, "devspace.sqlite"))) throw new Error("Stable Gateway bootstrap SQLite is unavailable.");
  if (!existsSync(join(LEGACY_STATE_DIR, "goal-state.json")) || !existsSync(join(LEGACY_STATE_DIR, "plan-state.json"))) throw new Error("Legacy Goal/Plan state is unavailable.");
  const publicBase = resolvePublicBase(bootstrapFiles.config ?? {});
  const pid = await listenerPid(GATEWAY_PORT);
  const endpointDown = !pid;
  const identity = pid ? await localIdentity(publicBase) : { ok: false, healthStatus: null, resourceStatus: null, resource: null };
  const processInfo = await processIdentity(pid);
  const alreadyStable = Boolean(processInfo?.commandLine?.includes("devspace-stable-gateway.mjs"));
  const legacyCore = Boolean(processInfo?.commandLine?.includes("dist/cli.js") && processInfo?.commandLine?.includes("serve"));
  if (pid && !identity.ok) throw new Error("Current 7678 endpoint does not match the configured stable public identity.");
  if (pid && !alreadyStable && !legacyCore) throw new Error("Current 7678 listener is not an expected DevSpace Core/Gateway process.");
  return {
    canonicalFiles,
    bootstrapFiles,
    publicBase,
    pid,
    endpointDown,
    identity,
    processInfo,
    alreadyStable,
    legacyCore,
    oauth: oauthCounts(BOOTSTRAP_STATE_DIR),
    nextConfig: buildProductionConfig(canonicalFiles.config ?? {}, publicBase),
  };
}

async function migrate() {
  const before = await preflight();
  if (before.alreadyStable) {
    const state = await verifyGoalPlan(BOOTSTRAP_STATE_DIR);
    const result = safeReport({ ok: true, state: "already-migrated", port: GATEWAY_PORT, taskName: "DevSpace-Stable-Gateway", ...state, oauth: before.oauth });
    await writeStatus(result);
    return result;
  }
  if (dryRun) {
    return safeReport({
      ok: true,
      state: "dry-run-ready",
      port: GATEWAY_PORT,
      publicBaseUrl: before.publicBase,
      endpointDown: before.endpointDown,
      legacyPidVerified: Boolean(before.pid),
      localIdentityVerified: before.endpointDown ? null : true,
      bootstrapOauthClients: before.oauth.clients,
      bootstrapRefreshTokens: before.oauth.refreshTokens,
      bootstrapWorkspaceSessions: before.oauth.workspaceSessions,
      goalPlanSourceReady: true,
      scheduledTaskTarget: "DevSpace-Stable-Gateway",
      productionModified: false,
    });
  }

  const backupDir = await makeBackup();
  const rollbackCoreNeeded = !before.alreadyStable;
  let legacyStopped = false;
  let newTaskInstalled = false;
  try {
    if (before.pid) {
      await stopLegacyPid(before.pid);
      legacyStopped = true;
    }

    await atomicJson(join(BOOTSTRAP_CONFIG_DIR, "config.json"), before.nextConfig);
    await atomicJson(join(BOOTSTRAP_CONFIG_DIR, "auth.json"), before.canonicalFiles.auth);
    await atomicCopy(join(LEGACY_STATE_DIR, "goal-state.json"), join(BOOTSTRAP_STATE_DIR, "goal-state.json"));
    await atomicCopy(join(LEGACY_STATE_DIR, "plan-state.json"), join(BOOTSTRAP_STATE_DIR, "plan-state.json"));
    if (existsSync(join(LEGACY_STATE_DIR, "classic-host-overlay-owner.json"))) {
      await atomicCopy(join(LEGACY_STATE_DIR, "classic-host-overlay-owner.json"), join(BOOTSTRAP_STATE_DIR, "classic-host-overlay-owner.json"));
    }
    const state = await verifyGoalPlan(BOOTSTRAP_STATE_DIR);
    const task = await installStableGatewayTask();
    newTaskInstalled = true;
    await waitForPortState(GATEWAY_PORT, true, 20_000);
    const local = await localStableGatewayIdentity(before.publicBase);
    if (!local.ok) throw new Error("New Stable Gateway local process identity verification failed.");
    const publicProbe = await publicIdentity(before.publicBase);
    if (!publicProbe.ok) throw new Error("New Stable Gateway public ingress identity verification failed.");
    const oauth = oauthCounts(BOOTSTRAP_STATE_DIR);
    if (oauth.clients < before.oauth.clients || oauth.refreshTokens < before.oauth.refreshTokens) throw new Error("OAuth state regressed during Stable Gateway migration.");
    const result = safeReport({
      ok: true,
      state: "migrated",
      port: GATEWAY_PORT,
      coreAPort: CORE_A_PORT,
      coreBPort: CORE_B_PORT,
      taskName: task.taskName,
      taskState: task.taskState,
      publicBaseUrl: before.publicBase,
      publicIdentityVerified: true,
      localStableGatewayVerified: local.stableGateway === true,
      offlineAccessVerified: publicProbe.offlineAccess,
      bootstrapOauthClients: oauth.clients,
      bootstrapRefreshTokens: oauth.refreshTokens,
      bootstrapWorkspaceSessions: oauth.workspaceSessions,
      backupCreated: true,
      ...state,
      rollback: false,
    });
    await writeStatus(result);
    return result;
  } catch (error) {
    const primaryError = error instanceof Error ? error.message : String(error);
    if (newTaskInstalled) await removeStableGatewayTask();
    const newPid = await listenerPid(GATEWAY_PORT);
    if (newPid) {
      try { process.kill(newPid, "SIGTERM"); } catch {}
      await waitForPortState(GATEWAY_PORT, false, 10_000).catch(() => {});
    }
    await restoreFilesFromBackup(backupDir).catch(() => {});
    let rollbackRestored = false;
    if (rollbackCoreNeeded) {
      try {
        await restoreLegacyCore(before.publicBase);
        rollbackRestored = true;
      } catch {}
    }
    const result = safeReport({ ok: false, state: "migration-failed", error: primaryError, rollback: true, rollbackRestored, rollbackCoreNeeded, legacyStopped, backupCreated: true });
    await writeStatus(result).catch(() => {});
    if (!rollbackRestored && rollbackCoreNeeded) throw new Error(`${primaryError}; rollback Core restore also failed.`);
    return result;
  }
}

if (!worker && !dryRun) {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
    cwd: packageRoot,
    detached: true,
    windowsHide: true,
    shell: false,
    stdio: "ignore",
  });
  child.unref();
  console.log(JSON.stringify(safeReport({ ok: true, state: "migration-scheduled", delayMs: 2_000, statusPath: STATUS_PATH })));
  process.exit(0);
}

if (worker) await sleep(2_000);
const result = await migrate();
if (dryRun) console.log(JSON.stringify(result));
process.exitCode = result.ok ? 0 : 1;
