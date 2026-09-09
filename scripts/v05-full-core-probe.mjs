#!/usr/bin/env node
import { createCandidateSnapshot, startCoreSlot, stopCoreSlot } from "./devspace-core-slot.mjs";
import { homedir } from "node:os";
import { join } from "node:path";

const sourceStateDir = process.env.DEVSPACE_PROBE_SOURCE_STATE_DIR || join(homedir(), ".local", "share", "devspace-tailscale-bootstrap");
const configDir = process.env.DEVSPACE_PROBE_CONFIG_DIR || join(homedir(), ".devspace-tailscale-bootstrap");
const publicBaseUrl = process.env.DEVSPACE_PROBE_PUBLIC_BASE_URL || "http://127.0.0.1:7798";
const port = Number(process.env.DEVSPACE_PROBE_PORT || 7798);
const logDir = process.env.DEVSPACE_PROBE_LOG_DIR || join(configDir, "logs", "v05-full-probe");

const snapshot = await createCandidateSnapshot({ sourceStateDir });
let handle = null;
try {
  handle = await startCoreSlot({
    id: "v05-full-probe",
    port,
    configDir,
    stateDir: snapshot.stateDir,
    publicBaseUrl,
    candidate: false,
    nodeArgs: ["--expose-gc"],
    allowDiagnosticGc: true,
    logDir,
  });
  const [memoryResponse, healthResponse] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/__devspace/memory/status`),
    fetch(`http://127.0.0.1:${port}/healthz`),
  ]);
  const memory = await memoryResponse.json();
  const health = await healthResponse.json();
  console.log(JSON.stringify({
    ok: memoryResponse.ok && healthResponse.ok && memory?.ok === true && health?.ok === true,
    pid: handle.pid,
    healthStatus: healthResponse.status,
    health,
    memory: {
      rss: memory?.memory?.rss ?? null,
      heapUsed: memory?.memory?.heapUsed ?? null,
      heapSizeLimit: memory?.memory?.heapSizeLimit ?? null,
    },
    registries: memory?.registries ?? null,
  }, null, 2));
} finally {
  if (handle) await stopCoreSlot(handle).catch(() => {});
  await snapshot.cleanup().catch(() => {});
}
