import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDevspaceFiles } from "../dist/user-config.js";
import { waitForStableGatewayQuiet } from "../dist/stable-gateway-quiet.js";
import { readGatewayControlFile } from "./devspace-stable-gateway.mjs";

const isWorker = process.argv.includes("--worker");
const statusOnly = process.argv.includes("--status");
const allowSchemaChange = process.argv.includes("--allow-schema-change");
const handoverIdArgIndex = process.argv.indexOf("--handover-id");
const suppliedHandoverId = handoverIdArgIndex >= 0 ? String(process.argv[handoverIdArgIndex + 1] || "").trim() : "";
const scriptPath = fileURLToPath(import.meta.url);

async function writeLastResult(configDir, payload) {
  const path = join(configDir, "logs", "stable-gateway-last-handover.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload)}\n`, "utf8");
  return path;
}

async function readLastResult(configDir) {
  const path = join(configDir, "logs", "stable-gateway-last-handover.json");
  try {
    return { path, payload: JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, "")) };
  } catch (error) {
    if (error?.code === "ENOENT") return { path, payload: null };
    throw error;
  }
}

if (statusOnly && !isWorker) {
  const files = loadDevspaceFiles();
  const status = await readLastResult(files.dir);
  console.log(JSON.stringify({
    ok: Boolean(status.payload),
    state: status.payload?.state ?? "missing",
    handoverId: status.payload?.handoverId ?? null,
    statusPath: status.path,
    record: status.payload,
    secretValuesLogged: false,
  }));
  process.exit(status.payload ? 0 : 1);
}

if (!isWorker) {
  const files = loadDevspaceFiles();
  const handoverId = randomUUID();
  const statusPath = await writeLastResult(files.dir, {
    observedAt: new Date().toISOString(),
    handoverId,
    state: "pending",
    allowSchemaChange,
    httpStatus: null,
    result: null,
    secretValuesLogged: false,
  });
  const workerArgs = [scriptPath, "--worker", "--handover-id", handoverId];
  if (allowSchemaChange) workerArgs.push("--allow-schema-change");
  const child = spawn(process.execPath, workerArgs, {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
  console.log(JSON.stringify({ ok: true, scheduled: true, state: "pending", handoverId, action: "stable-gateway-handover", quietBoundary: true, allowSchemaChange, statusPath, secretValuesLogged: false }));
  process.exit(0);
}

const files = loadDevspaceFiles();
const handoverId = suppliedHandoverId || randomUUID();
try {
  const control = await readGatewayControlFile(files.dir);
  const gatewayStatus = async () => {
    const response = await fetch(`http://127.0.0.1:${control.gatewayPort}/__devspace/gateway/status`, {
      headers: { "x-devspace-gateway-control": control.controlToken },
    });
    if (!response.ok) throw new Error(`Stable Gateway status probe returned HTTP ${response.status}.`);
    return await response.json();
  };
  const quiet = await waitForStableGatewayQuiet({
    statusProbe: gatewayStatus,
    pollMs: 250,
    consecutiveQuietSamples: 2,
  });
  if (!quiet.ok) {
    await writeLastResult(files.dir, {
      observedAt: new Date().toISOString(),
      handoverId,
      state: quiet.state,
      httpStatus: null,
      result: quiet,
      secretValuesLogged: false,
    });
    process.exit(1);
  }
  const response = await fetch(`http://127.0.0.1:${control.gatewayPort}/__devspace/gateway/handover`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-devspace-gateway-control": control.controlToken,
    },
    body: JSON.stringify({ allowSchemaChange }),
  });
  const result = await response.json().catch(() => ({ ok: false, state: "invalid-response" }));
  await writeLastResult(files.dir, {
    observedAt: new Date().toISOString(),
    handoverId,
    state: response.ok && result?.ok === true ? "completed" : "failed",
    allowSchemaChange,
    httpStatus: response.status,
    result,
    secretValuesLogged: false,
  });
  process.exit(response.ok && result?.ok === true ? 0 : 1);
} catch (error) {
  await writeLastResult(files.dir, {
    observedAt: new Date().toISOString(),
    handoverId,
    state: "failed",
    allowSchemaChange,
    httpStatus: null,
    result: {
      ok: false,
      state: "handover-request-failed",
      error: error instanceof Error ? error.message : String(error),
    },
    secretValuesLogged: false,
  }).catch(() => {});
  process.exit(2);
}
