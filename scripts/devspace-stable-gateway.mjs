#!/usr/bin/env node
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStableGatewayController } from "../dist/stable-gateway-controller.js";
import { StableGatewaySessionRegistry } from "../dist/stable-gateway-runtime.js";
import { loadStableGatewaySessionDescriptors, saveStableGatewaySessionDescriptors } from "../dist/stable-gateway-session-descriptors.js";
import { createStableGatewayActivityJournal } from "../dist/stable-gateway-activity.js";
import { handleStableGatewayLiveRequest } from "../dist/stable-gateway-live-ui.js";
import { createStableGatewayHumanProgress, handleStableGatewayHumanProgressRequest } from "../dist/stable-gateway-human-progress.js";
import { migrateAgentAuthoredProgressState } from "../dist/agent-authored-progress-state.js";
import { GoalProgressNarrator } from "../dist/agent-authored-progress-journal.js";
import { createLogRetentionSupervisor } from "../dist/log-retention.js";
import { probeCandidate, readCoreSchemaFingerprint } from "../dist/stable-gateway-candidate.js";
import { loadDevspaceFiles } from "../dist/user-config.js";
import { nodeArgsForCoreHeapProfile } from "../dist/core-node-options.js";
import { createCandidateSnapshot, startCoreSlot, stopCoreSlot } from "./devspace-core-slot.mjs";

const CONTROL_FILE_NAME = "stable-gateway-control.json";
const DEFAULT_CORE_START_RETRY_MS = 2_000;

function normalizePort(value, { allowZero = false, label = "port" } = {}) {
  const port = Number(value);
  const min = allowZero ? 0 : 1024;
  if (!Number.isInteger(port) || port < min || port > 65535) throw new Error(`${label} is invalid.`);
  return port;
}

function isLoopback(remoteAddress) {
  const value = String(remoteAddress ?? "").toLowerCase();
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

function safeTokenEquals(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue ?? ""));
  const right = Buffer.from(String(rightValue ?? ""));
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

async function drainRequest(req, maxBytes = 64 * 1024) {
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("Gateway control request is too large.");
  }
}

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(body.length));
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

function controlPath(configDir) {
  return join(resolve(configDir), "logs", CONTROL_FILE_NAME);
}

async function writeControlFile(configDir, gatewayPort, controlToken, { progressStatePath = null } = {}) {
  const path = controlPath(configDir);
  mkdirSync(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({
    version: 2,
    gatewayPort,
    controlToken,
    progressStatePath: progressStatePath ? resolve(String(progressStatePath)) : null,
  })}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

export async function readGatewayControlFile(configDir) {
  const path = controlPath(configDir);
  const parsed = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
  return {
    path,
    gatewayPort: Number(parsed.gatewayPort),
    controlToken: String(parsed.controlToken ?? ""),
    progressStatePath: parsed.progressStatePath ? resolve(String(parsed.progressStatePath)) : null,
  };
}

export async function startStableGatewayRuntime({
  host = "127.0.0.1",
  gatewayPort,
  configDir,
  stateDir,
  controller,
  activityJournal,
  humanProgress,
  controlToken = randomBytes(32).toString("base64url"),
  coreStartRetryMs = DEFAULT_CORE_START_RETRY_MS,
} = {}) {
  const bindHost = String(host ?? "127.0.0.1").trim();
  if (!["127.0.0.1", "::1", "localhost"].includes(bindHost)) throw new Error("Stable Gateway listener must bind to loopback.");
  const requestedPort = normalizePort(gatewayPort, { allowZero: true, label: "gatewayPort" });
  const resolvedConfigDir = resolve(String(configDir ?? ""));
  const stateDirText = String(stateDir ?? "").trim();
  const resolvedStateDir = stateDirText ? resolve(stateDirText) : null;
  if (!String(configDir ?? "").trim() || !existsSync(resolvedConfigDir)) throw new Error("Stable Gateway configDir is missing.");
  if (resolvedStateDir && !existsSync(resolvedStateDir)) throw new Error("Stable Gateway stateDir does not exist.");
  if (!controller || typeof controller.start !== "function" || typeof controller.handover !== "function") throw new Error("Stable Gateway controller is required.");
  const token = String(controlToken);
  if (token.length < 24) throw new Error("Stable Gateway controlToken is too short.");
  const retryMs = Number(coreStartRetryMs);
  if (!Number.isFinite(retryMs) || retryMs < 10 || retryMs > 60_000) throw new Error("coreStartRetryMs is invalid.");

  let handoverInProgress = false;
  let closing = false;
  let startupRetryTimer = null;
  let startupRetryPromise = null;
  let startupAttempts = 0;
  let startupLastErrorName = null;
  let startupLastErrorAt = null;

  const startupStatus = () => ({
    attempts: startupAttempts,
    retrying: Boolean(startupRetryTimer || startupRetryPromise),
    lastErrorName: startupLastErrorName,
    lastErrorAt: startupLastErrorAt,
  });

  const scheduleStartupRetry = () => {
    if (closing || startupRetryTimer || controller.status().ok) return;
    startupRetryTimer = setTimeout(() => {
      startupRetryTimer = null;
      void ensureControllerStarted();
    }, retryMs);
    startupRetryTimer.unref?.();
  };

  const ensureControllerStarted = async () => {
    if (closing || controller.status().ok) return controller.status();
    if (startupRetryPromise) return startupRetryPromise;
    startupRetryPromise = (async () => {
      startupAttempts += 1;
      try {
        const status = await controller.start();
        startupLastErrorName = null;
        startupLastErrorAt = null;
        return status;
      } catch (error) {
        startupLastErrorName = error instanceof Error ? error.name : "Error";
        startupLastErrorAt = new Date().toISOString();
        scheduleStartupRetry();
        return controller.status();
      } finally {
        startupRetryPromise = null;
      }
    })();
    return startupRetryPromise;
  };
  const server = createServer((req, res) => {
    const path = new URL(req.url || "/", `http://${bindHost}`).pathname;
    if (path === "/__devspace/progress") {
      void handleStableGatewayHumanProgressRequest(req, res, { progress: humanProgress })
        .catch(() => sendJson(res, 500, { ok: false, error: "progress-failed" }));
      return;
    }
    if (path === "/__devspace/live" || path === "/__devspace/live/snapshot") {
      void handleStableGatewayLiveRequest(req, res, {
        stateDir: resolvedStateDir,
        controller,
        journal: activityJournal,
      }).catch((error) => sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }));
      return;
    }
    if (path === "/__devspace/gateway/healthz") {
      if (req.method !== "GET") {
        sendJson(res, 405, { ok: false, gateway: "stable", state: "method-not-allowed" });
        return;
      }
      const current = controller.status();
      sendJson(res, current.ok ? 200 : 503, {
        ok: current.ok,
        gateway: "stable",
        state: current.ok ? "ready" : "degraded",
        ...(current.ok ? {} : { coreStartup: startupStatus() }),
      });
      return;
    }
    if (path === "/__devspace/gateway/handover" || path === "/__devspace/gateway/status") {
      if (!isLoopback(req.socket?.remoteAddress)) {
        sendJson(res, 403, { ok: false, error: "loopback-only" });
        return;
      }
      if (!safeTokenEquals(req.headers["x-devspace-gateway-control"], token)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      if (path.endsWith("/status")) {
        sendJson(res, 200, { ...controller.status(), coreStartup: startupStatus() });
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method-not-allowed" });
        return;
      }
      if (handoverInProgress) {
        sendJson(res, 409, { ok: false, error: "handover-in-progress" });
        return;
      }
      handoverInProgress = true;
      void drainRequest(req)
        .then(() => controller.handover())
        .then((result) => sendJson(res, result.ok ? 200 : 409, result))
        .catch((error) => sendJson(res, 500, { ok: false, state: "failed", error: error instanceof Error ? error.message : String(error) }))
        .finally(() => { handoverInProgress = false; });
      return;
    }
    controller.handlePublicRequest(req, res);
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(requestedPort, bindHost, resolvePromise);
  });
  const actualPort = Number(server.address().port);
  const controlFile = await writeControlFile(resolvedConfigDir, actualPort, token, {
    progressStatePath: humanProgress?.statePath || null,
  });
  await ensureControllerStarted();

  return {
    ok: true,
    gatewayPort: actualPort,
    controlFile,
    controller,
    server,
    async close() {
      closing = true;
      if (startupRetryTimer) clearTimeout(startupRetryTimer);
      startupRetryTimer = null;
      await startupRetryPromise?.catch(() => {});
      if (server.listening) await new Promise((resolvePromise) => server.close(resolvePromise));
      await controller.close();
      await rm(controlFile, { force: true }).catch(() => {});
    },
  };
}

export function stableGatewayOptionsFromEnvironment(env = process.env) {
  const files = loadDevspaceFiles(env);
  const config = files.config ?? {};
  const gatewayPort = Number(env.PORT ?? config.stableGatewayPort ?? config.edgeBackendPort ?? 7678);
  const stateDir = env.DEVSPACE_STATE_DIR ?? config.stableGatewayStateDir ?? config.edgeFixedStateDir ?? config.stateDir;
  const publicBaseUrl = env.DEVSPACE_PUBLIC_BASE_URL ?? config.stableGatewayPublicBaseUrl ?? config.edgePublicBaseUrl ?? config.publicBaseUrl;
  const configDir = env.DEVSPACE_CONFIG_DIR ?? files.dir;
  const stableGatewayCoreHeapProfile = env.DEVSPACE_STABLE_GATEWAY_CORE_HEAP_PROFILE
    ?? config.stableGatewayCoreHeapProfile
    ?? "system";
  const coreNodeArgs = nodeArgsForCoreHeapProfile(stableGatewayCoreHeapProfile);
  return {
    host: env.HOST ?? "127.0.0.1",
    gatewayPort,
    configDir,
    stableGatewayCoreHeapProfile,
    controllerOptions: {
      publicBaseUrl,
      configDir,
      stateDir,
      corePorts: {
        a: Number(env.DEVSPACE_CORE_A_PORT ?? config.stableGatewayCoreAPort ?? gatewayPort + 10),
        b: Number(env.DEVSPACE_CORE_B_PORT ?? config.stableGatewayCoreBPort ?? gatewayPort + 11),
      },
      dependencies: {
        createCandidateSnapshot,
        startCoreSlot: (options) => startCoreSlot({ ...options, nodeArgs: coreNodeArgs, allowDiagnosticGc: true }),
        stopCoreSlot,
        probeCandidate,
        readCoreSchemaFingerprint,
      },
    },
  };
}

async function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (await isMainModule()) {
  const options = stableGatewayOptionsFromEnvironment();
  const activityJournal = createStableGatewayActivityJournal();
  const humanProgressStatePath = join(options.controllerOptions.stateDir, "devspace-live-progress.json");
  const progressMigration = await migrateAgentAuthoredProgressState(humanProgressStatePath);
  const humanProgress = await createStableGatewayHumanProgress({
    statePath: join(options.controllerOptions.stateDir, "devspace-live-progress.json"),
  });
  const progressNarrator = new GoalProgressNarrator({
    progressStatePath: join(options.controllerOptions.stateDir, "devspace-goal-run-live.json"),
    planStatePath: join(options.controllerOptions.stateDir, "plan-state.json"),
    goalStatePath: join(options.controllerOptions.stateDir, "goal-state.json"),
    humanProgress,
  });
  await progressNarrator.start();
  const logRetention = createLogRetentionSupervisor({
    roots: [join(options.configDir, "logs"), options.controllerOptions.logDir],
  });
  await logRetention.start();
  const descriptorPath = join(options.controllerOptions.stateDir, "stable-gateway-session-descriptors.json");
  const registry = new StableGatewaySessionRegistry();
  registry.restoreDescriptors(await loadStableGatewaySessionDescriptors(descriptorPath));
  const controller = createStableGatewayController({ ...options.controllerOptions, activityJournal, registry });
  const persistDescriptors = () => saveStableGatewaySessionDescriptors(descriptorPath, registry.snapshotDescriptors()).catch(() => {});
  const descriptorTimer = setInterval(() => { void persistDescriptors(); }, 2_000);
  descriptorTimer.unref?.();
  const runtime = await startStableGatewayRuntime({
    host: options.host,
    gatewayPort: options.gatewayPort,
    configDir: options.configDir,
    stateDir: options.controllerOptions.stateDir,
    controller,
    activityJournal,
    humanProgress,
  });
  console.log(JSON.stringify({
    ok: true,
    state: "stable-gateway-running",
    gatewayPort: runtime.gatewayPort,
    activeSlot: controller.status().activeSlot,
    activePid: controller.status().activePid,
    coreHeapProfile: options.stableGatewayCoreHeapProfile,
    liveUiUrl: `http://127.0.0.1:${runtime.gatewayPort}/__devspace/live`,
    secretValuesLogged: false,
  }));
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(descriptorTimer);
    await persistDescriptors();
    await progressNarrator.close();
    await logRetention.close();
    await runtime.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
