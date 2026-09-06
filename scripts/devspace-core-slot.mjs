import { spawn } from "node:child_process";
import { closeSync, createReadStream, existsSync, mkdirSync, openSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_START_TIMEOUT_MS = 15_000;
const DEFAULT_STOP_TIMEOUT_MS = 8_000;
const CORE_RUNTIME_ENV_KEYS = new Set([
  "DEVSPACE_TOOL_MODE",
  "DEVSPACE_MINIMAL_TOOLS",
  "DEVSPACE_TOOL_NAMING",
  "DEVSPACE_WIDGETS",
  "DEVSPACE_ARTIFACTS",
  "DEVSPACE_SKILLS",
  "DEVSPACE_SKILL_PATHS",
  "DEVSPACE_PLUGINS",
  "DEVSPACE_PLUGIN_PATHS",
  "DEVSPACE_PLUGINS_DIR",
  "DEVSPACE_CAPABILITY_REGISTRY",
  "DEVSPACE_PASSIVE_CORE",
  "DEVSPACE_CONTEXT_GUARDIAN",
  "DEVSPACE_CLASSIC_HOST_OVERLAY",
  "DEVSPACE_CLASSIC_STREAM_RECOVERY",
  "DEVSPACE_CLASSIC_MAIN_DEBUG_PORTS",
  "DEVSPACE_AUTO_COMPACT",
  "DEVSPACE_SUBAGENTS",
  "DEVSPACE_AGENT_DIR",
]);

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function requirePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`${label} must be a valid non-privileged TCP port.`);
  return port;
}

function requireDirectory(value, label) {
  const path = resolve(String(value ?? "").trim());
  if (!String(value ?? "").trim()) throw new Error(`${label} is required.`);
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
  return path;
}

function normalizePublicBaseUrl(value) {
  const parsed = new URL(String(value ?? "").trim());
  if (parsed.protocol !== "https:") throw new Error("Core publicBaseUrl must use https.");
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = "/";
  return parsed.toString().replace(/\/$/, "");
}

async function listJsonFiles(root) {
  const results = [];
  const visit = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.includes(".tmp")) continue;
      results.push(path);
    }
  };
  await visit(root);
  return results;
}

async function validateSnapshotJson(stateDir) {
  const jsonFiles = await listJsonFiles(stateDir);
  for (const path of jsonFiles) {
    const text = (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
    JSON.parse(text);
  }
  return jsonFiles.length;
}

async function backupSqlite(sourcePath, destinationPath) {
  if (!existsSync(sourcePath)) return false;
  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destinationPath);
    return true;
  } finally {
    db.close();
  }
}

export async function createCandidateSnapshot({ sourceStateDir, tempRoot } = {}) {
  const source = requireDirectory(sourceStateDir, "sourceStateDir");
  const parent = tempRoot ? resolve(tempRoot) : tmpdir();
  mkdirSync(parent, { recursive: true });
  const stateDir = await mkdtemp(join(parent, "devspace-core-candidate-"));
  const sqliteName = "devspace.sqlite";
  try {
    await cp(source, stateDir, {
      recursive: true,
      force: true,
      filter: (sourcePath) => ![sqliteName, `${sqliteName}-wal`, `${sqliteName}-shm`].includes(basename(sourcePath)),
    });
    const sqliteBackedUp = await backupSqlite(join(source, sqliteName), join(stateDir, sqliteName));
    const jsonFiles = await validateSnapshotJson(stateDir);
    return {
      stateDir,
      sqliteBackedUp,
      jsonFiles,
      async cleanup() {
        await rm(stateDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export function buildCoreEnvironment({
  port,
  configDir,
  stateDir,
  publicBaseUrl,
  candidate,
  baseEnv = process.env,
  runtimeEnvOverrides = {},
}) {
  const publicHost = new URL(publicBaseUrl).hostname;
  const environment = { ...baseEnv };
  for (const key of CORE_RUNTIME_ENV_KEYS) delete environment[key];
  for (const [key, value] of Object.entries(runtimeEnvOverrides || {})) {
    if (!CORE_RUNTIME_ENV_KEYS.has(key)) throw new Error(`Unsupported Core runtime environment override: ${key}`);
    if (value !== undefined && value !== null) environment[key] = String(value);
  }
  Object.assign(environment, {
    PORT: String(port),
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
    DEVSPACE_ALLOWED_HOSTS: ["localhost", "127.0.0.1", "::1", publicHost].join(","),
  });
  if (candidate) {
    Object.assign(environment, {
      DEVSPACE_PASSIVE_CORE: "true",
      DEVSPACE_CONTEXT_GUARDIAN: "false",
      DEVSPACE_CLASSIC_HOST_OVERLAY: "false",
      DEVSPACE_CLASSIC_STREAM_RECOVERY: "false",
      DEVSPACE_AUTO_COMPACT: "false",
    });
  }
  return environment;
}

async function waitForCoreIdentity({ baseUrl, publicBaseUrl, child, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  const expectedResource = `${publicBaseUrl}/mcp`;
  let lastReason = "core-not-ready";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Core process exited before readiness (code ${child.exitCode}).`);
    try {
      const health = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1_000), cache: "no-store" });
      if (!health.ok) {
        lastReason = `health-${health.status}`;
        await sleep(100);
        continue;
      }
      const healthBody = await health.json().catch(() => null);
      if (healthBody?.ok !== true) {
        lastReason = "health-body";
        await sleep(100);
        continue;
      }
      const prm = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`, { signal: AbortSignal.timeout(1_000), cache: "no-store" });
      const prmBody = await prm.json().catch(() => null);
      if (prm.ok && prmBody?.resource === expectedResource) return;
      lastReason = `resource-${prm.status}`;
    } catch (error) {
      lastReason = error instanceof Error ? error.name : "probe-error";
    }
    await sleep(100);
  }
  throw new Error(`Core readiness timed out (${lastReason}).`);
}

export async function startCoreSlot({
  id,
  port,
  configDir,
  stateDir,
  publicBaseUrl,
  candidate = false,
  logDir,
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  baseEnv = process.env,
  runtimeEnvOverrides = {},
} = {}) {
  const coreId = String(id ?? "").trim();
  if (!coreId) throw new Error("Core slot id is required.");
  const corePort = requirePort(port, "Core port");
  const coreConfigDir = requireDirectory(configDir, "configDir");
  const coreStateDir = requireDirectory(stateDir, "stateDir");
  const publicBase = normalizePublicBaseUrl(publicBaseUrl);
  const outputDir = resolve(logDir || join(coreConfigDir, "logs", "stable-gateway"));
  mkdirSync(outputDir, { recursive: true });
  const stdoutPath = join(outputDir, `${coreId}.out.log`);
  const stderrPath = join(outputDir, `${coreId}.err.log`);
  const stdoutFd = openSync(stdoutPath, "a");
  const stderrFd = openSync(stderrPath, "a");
  const child = spawn(process.execPath, ["dist/cli.js", "serve"], {
    cwd: packageRoot,
    env: buildCoreEnvironment({
      port: corePort,
      configDir: coreConfigDir,
      stateDir: coreStateDir,
      publicBaseUrl: publicBase,
      candidate: Boolean(candidate),
      baseEnv,
      runtimeEnvOverrides,
    }),
    windowsHide: true,
    shell: false,
    stdio: ["ignore", stdoutFd, stderrFd],
  });
  closeSync(stdoutFd);
  closeSync(stderrFd);
  const baseUrl = `http://127.0.0.1:${corePort}`;
  try {
    await waitForCoreIdentity({ baseUrl, publicBaseUrl: publicBase, child, timeoutMs: Number(startTimeoutMs) });
  } catch (error) {
    try { child.kill("SIGTERM"); } catch {}
    throw error;
  }
  return {
    id: coreId,
    port: corePort,
    baseUrl,
    pid: child.pid,
    child,
    candidate: Boolean(candidate),
    stateDir: coreStateDir,
    stdoutPath,
    stderrPath,
  };
}

export async function stopCoreSlot(handle, { timeoutMs = DEFAULT_STOP_TIMEOUT_MS } = {}) {
  if (!handle?.child) return { stopped: false, reason: "missing-handle" };
  const child = handle.child;
  if (child.exitCode !== null) return { stopped: true, exitCode: child.exitCode };
  const exit = new Promise((resolvePromise) => child.once("exit", (code) => resolvePromise(code)));
  try { child.kill("SIGTERM"); } catch {}
  const timer = sleep(Number(timeoutMs)).then(() => "timeout");
  const result = await Promise.race([exit, timer]);
  if (result !== "timeout") return { stopped: true, exitCode: result };
  try { child.kill("SIGKILL"); } catch {}
  const forced = await Promise.race([exit, sleep(2_000).then(() => "timeout")]);
  return { stopped: true, forced: true, exitCode: forced === "timeout" ? null : forced };
}

export const coreSlotDefaults = Object.freeze({
  packageRoot,
  startTimeoutMs: DEFAULT_START_TIMEOUT_MS,
  stopTimeoutMs: DEFAULT_STOP_TIMEOUT_MS,
});
