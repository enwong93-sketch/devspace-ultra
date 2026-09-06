import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStableGatewayController } from "./stable-gateway-controller.js";
import { createStableGatewayActivityJournal } from "./stable-gateway-activity.js";

const PUBLIC_BASE = "https://devspace-gateway.example.test";

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

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function createFakeCore(id, marker, { failInitializeAt = null } = {}) {
  let sessionCounter = 0;
  const child = new EventEmitter();
  child.exitCode = null;
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    if (body.method === "initialize") {
      sessionCounter += 1;
      if (Number(failInitializeAt) === sessionCounter) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: `${id}-forced-stale-replay` }));
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("mcp-session-id", `${id}-session-${sessionCounter}`);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: marker, version: "1" } } }));
      return;
    }
    if (body.method === "notifications/initialized") {
      res.statusCode = 202;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("mcp-session-id", req.headers["mcp-session-id"] ?? "");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { marker, backendSessionId: req.headers["mcp-session-id"] } }));
  });
  const baseUrl = await listen(server);
  return {
    id,
    marker,
    baseUrl,
    pid: Math.floor(Math.random() * 100000) + 1000,
    server,
    child,
    async crash(code = 1) {
      await closeServer(server);
      child.exitCode = code;
      child.emit("exit", code, null);
    },
  };
}

function postJson(baseUrl, body, headers = {}) {
  const target = new URL("/mcp", baseUrl);
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(payload.length), ...headers },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.once("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    req.end(payload);
  });
}

async function waitUntil(predicate, timeoutMs = 1_000) {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const temp = await mkdtemp(join(tmpdir(), "stable-gateway-liveness-test-"));
const initial = await createFakeCore("core-a", "a-initial");
const activeHandles = [];
let bGeneration = 0;

const dependencies = {
  async createCandidateSnapshot() {
    const stateDir = await mkdtemp(join(temp, "candidate-"));
    return { stateDir, async cleanup() { await rm(stateDir, { recursive: true, force: true }); } };
  },
  async startCoreSlot(options) {
    if (options.candidate) return await createFakeCore(options.id, `${options.id}-candidate`);
    if (options.id === "core-b") bGeneration += 1;
    const marker = options.id === "core-b" ? `b-active-${bGeneration}` : "a-restarted";
    const handle = await createFakeCore(options.id, marker, {
      failInitializeAt: options.id === "core-b" && bGeneration === 2 ? 1 : null,
    });
    activeHandles.push(handle);
    return handle;
  },
  async stopCoreSlot(handle) {
    if (handle?.server) await closeServer(handle.server);
    if (handle?.child && handle.child.exitCode === null) {
      handle.child.exitCode = 0;
      handle.child.emit("exit", 0, "SIGTERM");
    }
    return { stopped: true };
  },
  async probeCandidate() {
    return { ok: true, stage: "compatible" };
  },
  async readCoreSchemaFingerprint() {
    return { schemaFingerprint: "a".repeat(64), toolCount: 2 };
  },
};

const activityJournal = createStableGatewayActivityJournal();
const controller = createStableGatewayController({
  publicBaseUrl: PUBLIC_BASE,
  configDir: temp,
  stateDir: temp,
  corePorts: { a: 19081, b: 19082 },
  initialSlot: "a",
  initialCoreHandle: initial,
  dependencies,
  activityJournal,
  drainTimeoutMs: 500,
  requestTimeoutMs: 500,
});
await controller.start();
const gatewayServer = createServer(controller.handlePublicRequest);
const gatewayBaseUrl = await listen(gatewayServer);

try {
  const publicSessionIds = [];
  for (let index = 0; index < 2; index += 1) {
    const init = await postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: index + 1, method: "initialize", params: { protocolVersion: "2025-11-25", clientInfo: { name: `client-${index}` } } }, { authorization: `Bearer replay-secret-${index}` });
    const publicSessionId = init.headers["mcp-session-id"];
    assert.ok(publicSessionId);
    publicSessionIds.push(publicSessionId);
    await postJson(gatewayBaseUrl, { jsonrpc: "2.0", method: "notifications/initialized" }, {
      authorization: `Bearer replay-secret-${index}`,
      "mcp-session-id": publicSessionId,
    });
  }

  const handover = await controller.handover();
  assert.equal(handover.ok, true);
  assert.equal(handover.activeSlot, "b");
  assert.equal(bGeneration, 1);

  const activeB = activeHandles.find((handle) => handle.marker === "b-active-1");
  assert.ok(activeB, "handover must have created the first active B handle");
  await activeB.crash(1);

  await waitUntil(() => bGeneration === 2, 1_000);
  assert.equal(controller.status().activeSlot, "b", "unexpected Core exit must recover the same active slot");

  const preLazySessions = controller.status().sessions.sessions;
  assert.equal(preLazySessions.length, 2, "partial replay must retain both lightweight public descriptors after active-Core restart");
  assert.equal(preLazySessions.filter((session) => session.coreId === "unmapped").length, 1, "the failed replay must become an unmapped descriptor awaiting lazy resurrection");

  const results = [];
  for (let index = 0; index < publicSessionIds.length; index += 1) {
    results.push(await postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: 20 + index, method: "tools/list", params: {} }, {
      authorization: `Bearer replay-secret-${index}`,
      "mcp-session-id": publicSessionIds[index],
    }));
  }
  const successful = results.filter((result) => result.status === 200);
  assert.equal(successful.length, 2, "the healthy mapping and the stale descriptor must both remain usable after transparent lazy resurrection");
  assert.equal(successful.every((result) => JSON.parse(result.body).result.marker === "b-active-2"), true, "all recovered requests must reach the recovered active B Core");
  assert.equal(controller.status().sessions.sessions.filter((session) => session.coreId === "unmapped").length, 0, "lazy resurrection must atomically restore the previously unmapped descriptor");
  assert.equal(controller.status().fatal, false);
  assert.equal(controller.status().ok, true);

  const fresh = await postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: 40, method: "initialize", params: { protocolVersion: "2025-11-25" } }, { authorization: "Bearer fresh-after-recovery" });
  assert.equal(fresh.status, 200, "fresh initialize must work after partial replay recovery");
  const activityTitles = activityJournal.snapshot().activities.map((item) => item.title);
  assert.equal(activityTitles.includes("Core recovery started"), true, "unexpected active-Core exit must be visible in the local activity feed");
  assert.equal(activityTitles.includes("Core recovery completed"), true, "successful same-slot recovery must be visible in the local activity feed");
} finally {
  await closeServer(gatewayServer);
  await controller.close().catch(() => {});
  await closeServer(initial.server);
  for (const handle of activeHandles) await closeServer(handle.server).catch(() => {});
  await rm(temp, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, gate: "stable-gateway-liveness", partialReplayRecovery: true }));
