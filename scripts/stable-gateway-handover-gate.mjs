#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStableGatewayController } from "../dist/stable-gateway-controller.js";
import { startStableGatewayRuntime } from "./devspace-stable-gateway.mjs";

const execFileAsync = promisify(execFile);
const PUBLIC_BASE = "https://devspace-gateway.example.test";
const CONTROL_TOKEN = "gate-control-token-0123456789abcdef";
const FAKE_TOOLS = Object.freeze([
  { name: "read", description: "Read a workspace file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "view_image", description: "Inspect a workspace image", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
]);

async function productionPortSnapshot() {
  if (process.platform !== "win32") return [];
  const { stdout } = await execFileAsync("netstat", ["-ano"], { windowsHide: true });
  return String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /LISTENING/i.test(line) && /:(?:7676|7677|7678)\s/i.test(line))
    .sort();
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function createFakeCore(id, { failInitialize = false, failInitializeAt = null } = {}) {
  let sessionCounter = 0;
  const server = createServer(async (req, res) => {
    const body = await readJsonBody(req);
    if (body.method === "initialize") {
      sessionCounter += 1;
      if (failInitialize || Number(failInitializeAt) === sessionCounter) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "forced-replay-failure" }));
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("mcp-session-id", `${id}-session-${sessionCounter}`);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: id, version: "1" } } }));
      return;
    }
    if (body.method === "notifications/initialized") {
      res.statusCode = 202;
      res.end();
      return;
    }
    if (body.method === "tools/list") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("mcp-session-id", req.headers["mcp-session-id"] ?? "");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: FAKE_TOOLS, core: id } }));
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("mcp-session-id", req.headers["mcp-session-id"] ?? "");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { core: id, backendSessionId: req.headers["mcp-session-id"] } }));
  });
  const baseUrl = await listen(server);
  return { id, baseUrl, pid: process.pid, server };
}

function requestJson(baseUrl, path, { method = "POST", body = {}, headers = {} } = {}) {
  const target = new URL(path, baseUrl);
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method,
      headers: {
        ...(method === "POST" ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.once("error", reject);
    if (method === "POST") req.end(payload);
    else req.end();
  });
}

async function createRuntimeHarness({ staleReplay = false, failReplacementProbe = false } = {}) {
  const temp = await mkdtemp(join(tmpdir(), "stable-gateway-handover-gate-"));
  const initial = await createFakeCore("core-a");
  let probeCount = 0;
  const dependencies = {
    async createCandidateSnapshot() {
      const stateDir = await mkdtemp(join(temp, "candidate-"));
      return { stateDir, async cleanup() { await rm(stateDir, { recursive: true, force: true }); } };
    },
    async startCoreSlot(options) {
      if (options.candidate) return createFakeCore(`${options.id}-candidate`);
      if (options.id === "core-b") return createFakeCore("core-b", { failInitializeAt: staleReplay ? 1 : null });
      return createFakeCore("core-a-restarted");
    },
    async stopCoreSlot(handle) {
      await closeServer(handle.server);
      return { stopped: true };
    },
    async probeCandidate() {
      probeCount += 1;
      if (failReplacementProbe && probeCount === 2) return { ok: false, stage: "schema" };
      return { ok: true, stage: "compatible" };
    },
    async readCoreSchemaFingerprint() {
      return { schemaFingerprint: "b".repeat(64), toolCount: 2 };
    },
  };
  const controller = createStableGatewayController({
    publicBaseUrl: PUBLIC_BASE,
    configDir: temp,
    stateDir: temp,
    corePorts: { a: 19181, b: 19182 },
    initialSlot: "a",
    initialCoreHandle: initial,
    dependencies,
    drainTimeoutMs: 500,
    requestTimeoutMs: 500,
  });
  const runtime = await startStableGatewayRuntime({
    gatewayPort: 0,
    configDir: temp,
    controller,
    controlToken: CONTROL_TOKEN,
  });
  const baseUrl = `http://127.0.0.1:${runtime.gatewayPort}`;
  return {
    temp,
    controller,
    runtime,
    baseUrl,
    async close() {
      await runtime.close();
      await rm(temp, { recursive: true, force: true });
    },
  };
}

async function initializePublicSession(harness) {
  const initialized = await requestJson(harness.baseUrl, "/mcp", {
    body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    headers: { authorization: "Bearer replay-secret" },
  });
  assert.equal(initialized.status, 200);
  const publicSessionId = initialized.headers["mcp-session-id"];
  await requestJson(harness.baseUrl, "/mcp", {
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
    headers: { authorization: "Bearer replay-secret", "mcp-session-id": publicSessionId },
  });
  const listed = await requestJson(harness.baseUrl, "/mcp", {
    body: { jsonrpc: "2.0", id: 99, method: "tools/list", params: {} },
    headers: { authorization: "Bearer replay-secret", "mcp-session-id": publicSessionId },
  });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json?.result?.tools, FAKE_TOOLS);
  return publicSessionId;
}

async function runSuccessGate() {
  const harness = await createRuntimeHarness();
  try {
    const gatewayPortBefore = harness.runtime.gatewayPort;
    const gatewayHealth = await requestJson(harness.baseUrl, "/__devspace/gateway/healthz", { method: "GET" });
    assert.equal(gatewayHealth.status, 200);
    assert.deepEqual(gatewayHealth.json, { ok: true, gateway: "stable", state: "ready" });
    const publicSessionId = await initializePublicSession(harness);
    const rejected = await requestJson(harness.baseUrl, "/__devspace/gateway/status", { method: "GET" });
    assert.equal(rejected.status, 401, "control surface must reject requests without the local credential");

    const handover = await requestJson(harness.baseUrl, "/__devspace/gateway/handover", {
      headers: { "x-devspace-gateway-control": CONTROL_TOKEN },
    });
    assert.equal(handover.status, 200);
    assert.equal(handover.json?.ok, true);
    assert.equal(handover.json?.activeSlot, "b");
    assert.equal(handover.json?.rollback, false);
    assert.equal(harness.runtime.gatewayPort, gatewayPortBefore, "public listener port must stay unchanged across Core handover");

    const after = await requestJson(harness.baseUrl, "/mcp", {
      body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      headers: { authorization: "Bearer replay-secret", "mcp-session-id": publicSessionId },
    });
    assert.equal(after.headers["mcp-session-id"], publicSessionId);
    assert.equal(after.json?.result?.core, "core-b");
  } finally {
    await harness.close();
  }
}

async function runStaleReplayIsolationGate() {
  const harness = await createRuntimeHarness({ staleReplay: true });
  try {
    const publicSessionId = await initializePublicSession(harness);
    const handover = await requestJson(harness.baseUrl, "/__devspace/gateway/handover", {
      headers: { "x-devspace-gateway-control": CONTROL_TOKEN },
    });
    assert.equal(handover.status, 200);
    assert.equal(handover.json?.ok, true);
    assert.equal(handover.json?.activeSlot, "b");
    assert.equal(handover.json?.droppedSessions, 1);

    const resurrected = await requestJson(harness.baseUrl, "/mcp", {
      body: { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
      headers: { authorization: "Bearer replay-secret", "mcp-session-id": publicSessionId },
    });
    assert.equal(resurrected.status, 200, "stale live mapping must resurrect transparently instead of invalidating the ChatGPT-held public session id");
    assert.equal(resurrected.headers["mcp-session-id"], publicSessionId);
    assert.equal(resurrected.json?.result?.core, "core-b");

    const fresh = await requestJson(harness.baseUrl, "/mcp", {
      body: { jsonrpc: "2.0", id: 4, method: "initialize", params: { protocolVersion: "2025-11-25" } },
      headers: { authorization: "Bearer replay-secret" },
    });
    assert.equal(fresh.status, 200);
  } finally {
    await harness.close();
  }
}

async function runRollbackGate() {
  const harness = await createRuntimeHarness({ failReplacementProbe: true });
  try {
    const publicSessionId = await initializePublicSession(harness);
    const handover = await requestJson(harness.baseUrl, "/__devspace/gateway/handover", {
      headers: { "x-devspace-gateway-control": CONTROL_TOKEN },
    });
    assert.equal(handover.status, 409);
    assert.equal(handover.json?.rollback, true);
    assert.equal(handover.json?.activeSlot, "a");

    const after = await requestJson(harness.baseUrl, "/mcp", {
      body: { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
      headers: { authorization: "Bearer replay-secret", "mcp-session-id": publicSessionId },
    });
    assert.equal(after.headers["mcp-session-id"], publicSessionId);
    assert.equal(after.json?.result?.core, "core-a-restarted");
  } finally {
    await harness.close();
  }
}

const productionBefore = await productionPortSnapshot();
await runSuccessGate();
await runStaleReplayIsolationGate();
await runRollbackGate();
const productionAfter = await productionPortSnapshot();
const productionPidsUnchanged = JSON.stringify(productionAfter) === JSON.stringify(productionBefore);
const productionPortsUnchanged = productionPidsUnchanged;
assert.equal(productionPortsUnchanged, true, "ephemeral Stable Gateway gate must not change production 7676/7677/7678 listeners");

console.log(JSON.stringify({
  ok: true,
  gate: "stable-gateway-handover",
  rollback: true,
  staleReplayIsolation: true,
  productionPidsUnchanged,
  productionPortsUnchanged,
}));
