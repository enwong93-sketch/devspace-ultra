import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStableGatewayController } from "./stable-gateway-controller.js";

const PUBLIC_BASE = "https://devspace-gateway.example.test";
const FAKE_TOOLS = Object.freeze([
  { name: "read", description: "Read a workspace file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "view_image", description: "Inspect a workspace image", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
]);

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

async function createFakeCore(id, { failInitialize = false, failInitializeAt = null } = {}) {
  const observed = [];
  const state = { sseActive: false, releaseSse: null };
  let sessionCounter = 0;
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    observed.push({ method: body.method, sessionId: req.headers["mcp-session-id"], authorization: req.headers.authorization });
    if (req.method === "GET" && req.url === "/mcp") {
      state.sseActive = true;
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("mcp-session-id", req.headers["mcp-session-id"] ?? "");
      res.write("event: ping\ndata: {}\n\n");
      await new Promise((resolve) => { state.releaseSse = resolve; });
      state.sseActive = false;
      state.releaseSse = null;
      res.end();
      return;
    }
    if (body.method === "initialize") {
      sessionCounter += 1;
      if (failInitialize || Number(failInitializeAt) === sessionCounter) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "forced-initialize-failure" }));
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
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: FAKE_TOOLS } }));
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("mcp-session-id", req.headers["mcp-session-id"] ?? "");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { core: id, backendSessionId: req.headers["mcp-session-id"] } }));
  });
  const baseUrl = await listen(server);
  return { id, baseUrl, pid: Math.floor(Math.random() * 100000) + 1000, server, observed, state };
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

async function createHarness({ failActiveB = false, failCandidate = false } = {}) {
  const temp = await mkdtemp(join(tmpdir(), "stable-gateway-controller-test-"));
  const initial = await createFakeCore("core-a");
  const starts = [];
  const stops = [];
  let activeBStarted = false;
  const dependencies = {
    async createCandidateSnapshot() {
      const stateDir = await mkdtemp(join(temp, "candidate-"));
      return { stateDir, async cleanup() { await rm(stateDir, { recursive: true, force: true }); } };
    },
    async startCoreSlot(options) {
      starts.push({ id: options.id, candidate: options.candidate });
      if (options.id === "core-b" && options.candidate) return createFakeCore("core-b-candidate");
      if (options.id === "core-b") {
        activeBStarted = true;
        return createFakeCore("core-b", { failInitializeAt: failActiveB ? 1 : null });
      }
      return createFakeCore("core-a-restarted");
    },
    async stopCoreSlot(handle) {
      stops.push(handle.id);
      if (handle?.state?.releaseSse) handle.state.releaseSse();
      await closeServer(handle.server);
      return { stopped: true };
    },
    async probeCandidate() {
      return failCandidate ? { ok: false, stage: "schema" } : { ok: true, stage: "compatible" };
    },
    async readCoreSchemaFingerprint() {
      return { schemaFingerprint: "a".repeat(64), toolCount: 2 };
    },
  };
  const controller = createStableGatewayController({
    publicBaseUrl: PUBLIC_BASE,
    configDir: temp,
    stateDir: temp,
    corePorts: { a: 19081, b: 19082 },
    initialSlot: "a",
    initialCoreHandle: initial,
    dependencies,
    drainTimeoutMs: 500,
    requestTimeoutMs: 500,
  });
  await controller.start();
  const gatewayServer = createServer(controller.handlePublicRequest);
  const gatewayBaseUrl = await listen(gatewayServer);
  return {
    temp, initial, starts, stops, dependencies, controller, gatewayServer, gatewayBaseUrl,
    activeBStarted: () => activeBStarted,
    async close() {
      await closeServer(gatewayServer);
      await controller.close();
      await rm(temp, { recursive: true, force: true });
    },
  };
}

function openMcpEventStream(baseUrl, publicSessionId) {
  const target = new URL("/mcp", baseUrl);
  let firstChunkResolve;
  const firstChunk = new Promise((resolve) => { firstChunkResolve = resolve; });
  const completed = new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "GET",
      headers: {
        accept: "text/event-stream",
        authorization: "Bearer replay-secret",
        "mcp-session-id": publicSessionId,
      },
    }, (res) => {
      res.once("data", () => firstChunkResolve());
      res.once("end", resolve);
      res.once("error", reject);
    });
    req.once("error", reject);
    req.end();
  });
  return { firstChunk, completed };
}

async function waitUntil(predicate, timeoutMs = 500) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function initializeSession(harness) {
  const init = await postJson(harness.gatewayBaseUrl, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }, { authorization: "Bearer replay-secret" });
  const publicSessionId = init.headers["mcp-session-id"];
  await postJson(harness.gatewayBaseUrl, { jsonrpc: "2.0", method: "notifications/initialized" }, {
    authorization: "Bearer replay-secret",
    "mcp-session-id": publicSessionId,
  });
  const tools = await postJson(harness.gatewayBaseUrl, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, {
    authorization: "Bearer replay-secret",
    "mcp-session-id": publicSessionId,
  });
  assert.equal(tools.status, 200);
  assert.deepEqual(JSON.parse(tools.body).result.tools, FAKE_TOOLS);
  return publicSessionId;
}

async function testLongLivedEventStreamDoesNotBlockHandoverDrain() {
  const h = await createHarness();
  let stream = null;
  try {
    const publicSessionId = await initializeSession(h);
    stream = openMcpEventStream(h.gatewayBaseUrl, publicSessionId);
    await stream.firstChunk;
    await waitUntil(() => h.initial.state.sseActive === true);
    assert.equal(h.controller.status().admission.activeRequests, 0, "replayable MCP GET/SSE must not count as an in-flight HTTP request that blocks handover forever");
    assert.equal(h.controller.status().sessions.totalActiveRequests, 0, "replayable MCP GET/SSE must not count as an in-flight MCP request either");
    const result = await h.controller.handover();
    assert.equal(result.ok, true, "handover must complete while an old-Core MCP event stream is open; stopping the old Core is allowed to terminate that replayable stream");
    assert.equal(result.activeSlot, "b");
    await stream.completed;
  } finally {
    if (h.initial.state.releaseSse) h.initial.state.releaseSse();
    await stream?.completed?.catch?.(() => {});
    await h.close();
  }
}

async function testSuccessfulHandover() {
  const h = await createHarness();
  try {
    const publicSessionId = await initializeSession(h);
    const beforePublic = publicSessionId;
    const result = await h.controller.handover();
    assert.equal(result.ok, true);
    assert.equal(result.activeSlot, "b");
    assert.equal(result.rollback, false);
    assert.deepEqual(h.starts, [{ id: "core-b", candidate: true }, { id: "core-b", candidate: false }]);
    assert.equal(h.stops.includes("core-a"), true);
    assert.equal(h.stops.includes("core-b-candidate"), true);

    const response = await postJson(h.gatewayBaseUrl, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, {
      authorization: "Bearer replay-secret",
      "mcp-session-id": beforePublic,
    });
    assert.equal(response.headers["mcp-session-id"], beforePublic);
    assert.deepEqual(JSON.parse(response.body).result.tools, FAKE_TOOLS);
    assert.equal(h.controller.status().sessions.sessions[0].publicSessionId, beforePublic);
    assert.equal(h.controller.status().sessions.sessions[0].toolCount, FAKE_TOOLS.length);
  } finally {
    await h.close();
  }
}

async function testReplayFailureDropsStaleSessionButKeepsHealthyCoreB() {
  const h = await createHarness({ failActiveB: true });
  try {
    const publicSessionId = await initializeSession(h);
    const result = await h.controller.handover();
    assert.equal(result.ok, true, "a healthy replacement Core must remain active even when the only old public session is stale");
    assert.equal(result.state, "handed-over");
    assert.equal(result.rollback, false);
    assert.equal(result.activeSlot, "b");
    assert.equal(result.replayedSessions, 0);
    assert.equal(result.droppedSessions, 1);
    assert.equal(h.activeBStarted(), true);
    assert.equal(h.stops.includes("core-b"), false, "stale session replay must not cause a healthy Core B rollback");

    const resurrected = await postJson(h.gatewayBaseUrl, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, {
      authorization: "Bearer replay-secret",
      "mcp-session-id": publicSessionId,
    });
    assert.equal(resurrected.status, 200, "a dropped live Core mapping must resurrect transparently when the lightweight public descriptor still exists");
    assert.equal(resurrected.headers["mcp-session-id"], publicSessionId, "transparent resurrection must preserve the ChatGPT-held public session id");
    assert.deepEqual(JSON.parse(resurrected.body).result.tools, FAKE_TOOLS);

    const fresh = await postJson(h.gatewayBaseUrl, { jsonrpc: "2.0", id: 4, method: "initialize", params: {} }, { authorization: "Bearer replay-secret" });
    assert.equal(fresh.status, 200, "fresh client initialization must remain available after all old sessions were dropped");
    const freshSessionId = fresh.headers["mcp-session-id"];
    const after = await postJson(h.gatewayBaseUrl, { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }, {
      authorization: "Bearer replay-secret",
      "mcp-session-id": freshSessionId,
    });
    assert.deepEqual(JSON.parse(after.body).result.tools, FAKE_TOOLS);
    assert.equal(h.controller.status().admission.closed, false);
  } finally {
    await h.close();
  }
}

async function testCandidateFailureNeverStopsA() {
  const h = await createHarness({ failCandidate: true });
  try {
    await initializeSession(h);
    await assert.rejects(h.controller.handover(), /compatibility gate failed/i);
    assert.equal(h.stops.includes("core-a"), false);
    assert.equal(h.controller.status().activeSlot, "a");
    assert.equal(h.controller.status().admission.closed, false);
  } finally {
    await h.close();
  }
}

await testLongLivedEventStreamDoesNotBlockHandoverDrain();
await testSuccessfulHandover();
await testReplayFailureDropsStaleSessionButKeepsHealthyCoreB();
await testCandidateFailureNeverStopsA();

console.log(JSON.stringify({ ok: true, gate: "stable-gateway-controller" }));
