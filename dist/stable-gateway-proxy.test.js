import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { StableGatewaySessionRegistry } from "./stable-gateway-runtime.js";
import { createStableGatewayProxy } from "./stable-gateway-proxy.js";
import { schemaFingerprint } from "./stable-gateway-candidate.js";

const FAKE_TOOLS = [
  { name: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "view_image", inputSchema: { type: "object", properties: { path: { type: "string" } } }, annotations: { readOnlyHint: true } },
];
const CHANGED_TOOLS = [
  ...FAKE_TOOLS,
  { name: "inspect_attached_image", inputSchema: { type: "object", properties: { file: { type: "object" } } }, annotations: { readOnlyHint: true } },
];

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function postJson(baseUrl, body, headers = {}, { onData } = {}) {
  const target = new URL("/mcp", baseUrl);
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(payload.length),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
        onData?.(Buffer.from(chunk), res);
      });
      res.once("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.once("error", reject);
    req.end(payload);
  });
}

async function createFakeCore(id, { failInitializeAt, unknownSessionOnce = false, genericFailureStatus = null, tools = FAKE_TOOLS } = {}) {
  const observed = [];
  const state = {
    streamEnded: false,
    holdActive: false,
    releaseHold: null,
    sseActive: false,
    releaseSse: null,
  };
  let sessionCounter = 0;
  let unknownSessionTriggered = false;
  const server = createServer(async (req, res) => {
    const raw = await readRequestBody(req);
    const body = raw ? JSON.parse(raw) : {};
    observed.push({
      id: body.id,
      method: body.method,
      authorization: req.headers.authorization,
      sessionId: req.headers["mcp-session-id"],
    });

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
      if (failInitializeAt === sessionCounter) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: `${id}-initialize-failed` }));
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("mcp-session-id", `${id}-backend-${sessionCounter}`);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", serverInfo: { name: id, version: "1" }, capabilities: {} } }));
      return;
    }

    if (
      unknownSessionOnce
      && req.headers["mcp-session-id"]
      && body.id !== "devspace-schema-fingerprint"
      && !unknownSessionTriggered
    ) {
      unknownSessionTriggered = true;
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "Unknown MCP session" } }));
      return;
    }

    if (genericFailureStatus && req.headers["mcp-session-id"] && body.method !== "notifications/initialized") {
      res.statusCode = Number(genericFailureStatus);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: `${id}-generic-failure-${genericFailureStatus}` }));
      return;
    }

    if (body.method === "tools/list") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("mcp-session-id", req.headers["mcp-session-id"] ?? "");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          core: id,
          backendSessionId: req.headers["mcp-session-id"],
          tools,
        },
      }));
      return;
    }

    if (body.method === "test/hold") {
      state.holdActive = true;
      await new Promise((resolve) => { state.releaseHold = resolve; });
      state.holdActive = false;
      state.releaseHold = null;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("mcp-session-id", req.headers["mcp-session-id"] ?? "");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { core: id, held: true } }));
      return;
    }

    if (body.method === "test/stream") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("mcp-session-id", req.headers["mcp-session-id"] ?? "");
      res.write(`data: ${id}-first\n\n`);
      setTimeout(() => {
        state.streamEnded = true;
        res.end(`data: ${id}-second\n\n`);
      }, 80);
      return;
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("mcp-session-id", req.headers["mcp-session-id"] ?? "");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { core: id, backendSessionId: req.headers["mcp-session-id"] } }));
  });
  const baseUrl = await listen(server);
  return { id, server, baseUrl, observed, state };
}

async function testInitializeAndStablePublicSession() {
  const core = await createFakeCore("core-a");
  const registry = new StableGatewaySessionRegistry();
  const gateway = createStableGatewayProxy({
    activeCore: { id: core.id, baseUrl: core.baseUrl },
    publicBaseUrl: "https://devspace-gateway.example.test",
    registry,
  });
  const gatewayServer = createServer(gateway.handler);
  const gatewayBaseUrl = await listen(gatewayServer);

  try {
    const initializeBody = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } };
    const response = await postJson(gatewayBaseUrl, initializeBody, { authorization: "Bearer replay-secret" });
    assert.equal(response.status, 200);
    const publicSessionId = response.headers["mcp-session-id"];
    assert.match(publicSessionId, /^[0-9a-f-]{36}$/i);
    assert.notEqual(publicSessionId, "core-a-backend-1", "Gateway must never expose the Core session id");
    assert.equal(core.observed[0].sessionId, undefined);
    assert.equal(core.observed[0].authorization, "Bearer replay-secret");

    await waitUntil(() => Boolean(registry.lookup(publicSessionId)?.schemaFingerprint));
    const mapped = registry.lookup(publicSessionId);
    assert.equal(mapped.coreId, "core-a");
    assert.equal(mapped.backendSessionId, "core-a-backend-1");
    assert.deepEqual(mapped.initializeBody, initializeBody);
    assert.equal(mapped.authorization, "Bearer replay-secret");
    assert.equal(mapped.schemaFingerprint, schemaFingerprint(FAKE_TOOLS));
    assert.equal(mapped.toolCount, FAKE_TOOLS.length);
  } finally {
    await close(gatewayServer);
    await close(core.server);
  }
}

async function testSessionBoundRequestTranslation() {
  const core = await createFakeCore("core-a");
  const registry = new StableGatewaySessionRegistry();
  const gateway = createStableGatewayProxy({ activeCore: { id: core.id, baseUrl: core.baseUrl }, publicBaseUrl: "https://devspace-gateway.example.test", registry });
  const gatewayServer = createServer(gateway.handler);
  const gatewayBaseUrl = await listen(gatewayServer);

  try {
    const initialize = await postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { authorization: "Bearer replay-secret" });
    const publicSessionId = initialize.headers["mcp-session-id"];
    const response = await postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, {
      authorization: "Bearer refreshed-replay-secret",
      "mcp-session-id": publicSessionId,
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers["mcp-session-id"], publicSessionId, "Core backend id must be rewritten back to the stable public id");
    assert.equal(core.observed.at(-1).sessionId, "core-a-backend-1", "Gateway must translate public id to Core backend id");
    assert.equal(core.observed.at(-1).authorization, "Bearer refreshed-replay-secret", "Gateway must forward the latest OAuth access token");
    assert.deepEqual(JSON.parse(response.body).result, {
      core: "core-a",
      backendSessionId: "core-a-backend-1",
      tools: FAKE_TOOLS,
    });
    assert.match(registry.lookup(publicSessionId).schemaFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(registry.lookup(publicSessionId).toolCount, 2);
    assert.equal(registry.lookup(publicSessionId).authorization, "Bearer refreshed-replay-secret", "Gateway must rotate the in-memory replay/schema-probe credential whenever ChatGPT refreshes OAuth");
    assert.equal(registry.lookup(publicSessionId).activeRequests, 0, "request accounting must release after response completion");
  } finally {
    await close(gatewayServer);
    await close(core.server);
  }
}

async function testLongLivedMcpGetDoesNotBlockDrainAccounting() {
  const core = await createFakeCore("core-a");
  const registry = new StableGatewaySessionRegistry();
  const gateway = createStableGatewayProxy({ activeCore: { id: core.id, baseUrl: core.baseUrl }, publicBaseUrl: "https://devspace-gateway.example.test", registry });
  const gatewayServer = createServer(gateway.handler);
  const gatewayBaseUrl = await listen(gatewayServer);

  try {
    const initialize = await postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { authorization: "Bearer replay-secret" });
    const publicSessionId = initialize.headers["mcp-session-id"];
    const target = new URL("/mcp", gatewayBaseUrl);
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
    await firstChunk;
    await waitUntil(() => core.state.sseActive === true);
    assert.equal(registry.lookup(publicSessionId).activeRequests, 0, "replayable GET /mcp event stream must not block handover drain forever");
    core.state.releaseSse();
    await completed;
  } finally {
    if (core.state.releaseSse) core.state.releaseSse();
    await close(gatewayServer);
    await close(core.server);
  }
}

async function testStreamingResponseIsNotBuffered() {
  const core = await createFakeCore("core-a");
  const registry = new StableGatewaySessionRegistry();
  const gateway = createStableGatewayProxy({ activeCore: { id: core.id, baseUrl: core.baseUrl }, publicBaseUrl: "https://devspace-gateway.example.test", registry });
  const gatewayServer = createServer(gateway.handler);
  const gatewayBaseUrl = await listen(gatewayServer);

  try {
    const initialize = await postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { authorization: "Bearer replay-secret" });
    const publicSessionId = initialize.headers["mcp-session-id"];
    let firstChunkObservedBeforeCoreEnd = false;
    const response = await postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: 3, method: "test/stream", params: {} }, {
      authorization: "Bearer replay-secret",
      "mcp-session-id": publicSessionId,
    }, {
      onData: () => {
        if (!core.state.streamEnded) firstChunkObservedBeforeCoreEnd = true;
      },
    });

    assert.equal(firstChunkObservedBeforeCoreEnd, true, "Gateway must stream the first chunk before the Core finishes the response");
    assert.match(response.body, /core-a-first/);
    assert.match(response.body, /core-a-second/);
    assert.equal(registry.lookup(publicSessionId).activeRequests, 0);
  } finally {
    await close(gatewayServer);
    await close(core.server);
  }
}

await testInitializeAndStablePublicSession();
await testSessionBoundRequestTranslation();
async function waitUntil(predicate, timeoutMs = 500) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function testBarrierAlsoQueuesNewInitialize() {
  const core = await createFakeCore("core-a");
  const registry = new StableGatewaySessionRegistry();
  const gateway = createStableGatewayProxy({ activeCore: { id: core.id, baseUrl: core.baseUrl }, publicBaseUrl: "https://devspace-gateway.example.test", registry });
  const gatewayServer = createServer(gateway.handler);
  const gatewayBaseUrl = await listen(gatewayServer);

  try {
    registry.beginBarrier();
    let completed = false;
    const initializePromise = postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { authorization: "Bearer replay-secret" })
      .then((response) => { completed = true; return response; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(completed, false, "new initialize requests must wait behind the handover barrier");
    assert.equal(core.observed.length, 0, "barrier must prevent new initialize traffic from reaching Core A");
    registry.abortBarrier();
    const response = await initializePromise;
    assert.equal(response.status, 200);
  } finally {
    registry.abortBarrier();
    await close(gatewayServer);
    await close(core.server);
  }
}

async function testReplayPreservesPublicSessionAndInitializedNotification() {
  const coreA = await createFakeCore("core-a");
  const coreB = await createFakeCore("core-b");
  const registry = new StableGatewaySessionRegistry();
  const gateway = createStableGatewayProxy({ activeCore: { id: coreA.id, baseUrl: coreA.baseUrl }, publicBaseUrl: "https://devspace-gateway.example.test", registry });
  const gatewayServer = createServer(gateway.handler);
  const gatewayBaseUrl = await listen(gatewayServer);

  try {
    const initialize = await postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { authorization: "Bearer replay-secret" });
    const publicSessionId = initialize.headers["mcp-session-id"];
    await postJson(gatewayBaseUrl, { jsonrpc: "2.0", method: "notifications/initialized" }, {
      authorization: "Bearer replay-secret",
      "mcp-session-id": publicSessionId,
    });
    await postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, {
      authorization: "Bearer replay-secret",
      "mcp-session-id": publicSessionId,
    });
    assert.equal(registry.lookup(publicSessionId).initialized, true);
    assert.match(registry.lookup(publicSessionId).schemaFingerprint, /^[a-f0-9]{64}$/);

    const tentative = await gateway.replaySessionsToCore({ id: coreB.id, baseUrl: coreB.baseUrl });
    assert.deepEqual(tentative, {
      mappings: [{ publicSessionId, coreId: "core-b", backendSessionId: "core-b-backend-1" }],
      droppedPublicSessionIds: [],
    });
    assert.equal(registry.lookup(publicSessionId).coreId, "core-a", "replay must remain tentative until an atomic commit");
    assert.deepEqual(coreB.observed.map((entry) => entry.method), ["initialize", "notifications/initialized", "tools/list"]);
    assert.equal(coreB.observed[1].sessionId, "core-b-backend-1");
    assert.equal(coreB.observed[0].authorization, "Bearer replay-secret");
  } finally {
    await close(gatewayServer);
    await close(coreA.server);
    await close(coreB.server);
  }
}

async function testReplayDropsOnlyTheStaleSession() {
  const coreA = await createFakeCore("core-a");
  const coreB = await createFakeCore("core-b", { failInitializeAt: 2 });
  const registry = new StableGatewaySessionRegistry();
  const gateway = createStableGatewayProxy({ activeCore: { id: coreA.id, baseUrl: coreA.baseUrl }, publicBaseUrl: "https://devspace-gateway.example.test", registry });
  const gatewayServer = createServer(gateway.handler);
  const gatewayBaseUrl = await listen(gatewayServer);

  try {
    const publicIds = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: index + 1, method: "initialize", params: { clientInfo: { name: `client-${index}` } } }, { authorization: `Bearer replay-${index}` });
      publicIds.push(response.headers["mcp-session-id"]);
    }
    const replayed = await gateway.replaySessionsToCore({ id: coreB.id, baseUrl: coreB.baseUrl });
    assert.equal(replayed.mappings.length, 2, "one stale replay must not abort healthy session replay");
    assert.equal(replayed.droppedPublicSessionIds.length, 1, "exactly one failing backend mapping must be isolated");
    const dropped = replayed.droppedPublicSessionIds[0];
    assert.equal(publicIds.includes(dropped), true);
    assert.equal(registry.lookup(dropped)?.coreId, "unmapped", "failing replay must retain the lightweight public descriptor for lazy resurrection");
    registry.commitMappings(replayed.mappings);
    for (const publicId of publicIds.filter((id) => id !== dropped)) {
      assert.equal(registry.lookup(publicId).coreId, "core-b");
    }
  } finally {
    await close(gatewayServer);
    await close(coreA.server);
    await close(coreB.server);
  }
}

async function testPromotionWaitsForDrainThenSwitchesAtomically() {
  const coreA = await createFakeCore("core-a");
  const coreB = await createFakeCore("core-b");
  const registry = new StableGatewaySessionRegistry();
  const gateway = createStableGatewayProxy({ activeCore: { id: coreA.id, baseUrl: coreA.baseUrl }, publicBaseUrl: "https://devspace-gateway.example.test", registry });
  const gatewayServer = createServer(gateway.handler);
  const gatewayBaseUrl = await listen(gatewayServer);

  try {
    const initialize = await postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { authorization: "Bearer replay-secret" });
    const publicSessionId = initialize.headers["mcp-session-id"];
    const heldRequest = postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: 2, method: "test/hold", params: {} }, {
      authorization: "Bearer replay-secret",
      "mcp-session-id": publicSessionId,
    });
    await waitUntil(() => coreA.state.holdActive === true);

    let promotionCompleted = false;
    const promotion = gateway.promoteCore({ id: coreB.id, baseUrl: coreB.baseUrl }, { drainTimeoutMs: 500 })
      .then((result) => { promotionCompleted = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(promotionCompleted, false, "promotion must wait until Core A in-flight work drains");
    assert.equal(coreB.observed.length, 0, "session replay must not begin before drain");

    coreA.state.releaseHold();
    await heldRequest;
    const promoted = await promotion;
    assert.equal(promoted.activeCore.id, "core-b");
    assert.equal(registry.lookup(publicSessionId).coreId, "core-b");
    assert.equal(registry.lookup(publicSessionId).backendSessionId, "core-b-backend-1");

    const after = await postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, {
      authorization: "Bearer replay-secret",
      "mcp-session-id": publicSessionId,
    });
    assert.equal(JSON.parse(after.body).result.core, "core-b");
    assert.equal(JSON.parse(after.body).result.backendSessionId, "core-b-backend-1");
    assert.equal(JSON.parse(after.body).result.tools.length, 2);
  } finally {
    if (coreA.state.releaseHold) coreA.state.releaseHold();
    registry.abortBarrier();
    await close(gatewayServer);
    await close(coreA.server);
    await close(coreB.server);
  }
}

async function testPromotionDropsOnlyFailedReplaySession() {
  const coreA = await createFakeCore("core-a");
  const coreB = await createFakeCore("core-b", { failInitializeAt: 2 });
  const registry = new StableGatewaySessionRegistry();
  const gateway = createStableGatewayProxy({ activeCore: { id: coreA.id, baseUrl: coreA.baseUrl }, publicBaseUrl: "https://devspace-gateway.example.test", registry });
  const gatewayServer = createServer(gateway.handler);
  const gatewayBaseUrl = await listen(gatewayServer);

  try {
    const first = await postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { authorization: "Bearer first-secret" });
    const second = await postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: 2, method: "initialize", params: {} }, { authorization: "Bearer second-secret" });
    const firstPublic = first.headers["mcp-session-id"];
    const secondPublic = second.headers["mcp-session-id"];

    const promoted = await gateway.promoteCore({ id: coreB.id, baseUrl: coreB.baseUrl }, { drainTimeoutMs: 500 });
    assert.equal(gateway.getActiveCore().id, "core-b", "healthy Core promotion must not be blocked by one stale public session");
    assert.equal(promoted.replayedSessions, 1);
    assert.equal(promoted.droppedSessions, 1);
    const mapped = [firstPublic, secondPublic].filter((id) => registry.lookup(id)?.coreId === "core-b");
    const unmapped = [firstPublic, secondPublic].filter((id) => registry.lookup(id)?.coreId === "unmapped");
    assert.equal(unmapped.length, 1, "the stale backend mapping must be isolated without deleting the public descriptor");
    assert.equal(mapped.length, 1);
    assert.equal(registry.lookup(mapped[0]).coreId, "core-b", "healthy replayed sessions must atomically follow the promoted Core");
    assert.equal(registry.snapshotPublic().barrierActive, false, "partial replay promotion must reopen admission on the healthy Core");
  } finally {
    registry.abortBarrier();
    await close(gatewayServer);
    await close(coreA.server);
    await close(coreB.server);
  }
}

async function testExactUnknownSession404ResurrectsAndRetriesOnce() {
  const core = await createFakeCore("core-404", { unknownSessionOnce: true });
  const registry = new StableGatewaySessionRegistry();
  const gateway = createStableGatewayProxy({
    activeCore: { id: core.id, baseUrl: core.baseUrl },
    publicBaseUrl: "https://devspace-gateway.example.test",
    registry,
    backendSessionReinitIdleMs: 60_000,
  });
  const gatewayServer = createServer(gateway.handler);
  const gatewayBaseUrl = await listen(gatewayServer);
  try {
    const initialize = await postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }, { authorization: "Bearer current-request-token" });
    const publicSessionId = initialize.headers["mcp-session-id"];
    const result = await postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, {
      authorization: "Bearer current-request-token",
      "mcp-session-id": publicSessionId,
    });
    assert.equal(result.status, 200, "exact downstream unknown-session 404 must be healed inside the same public request");
    assert.equal(result.headers["mcp-session-id"], publicSessionId, "404 recovery must preserve the external public session id");
    assert.equal(core.observed.filter((entry) => entry.method === "initialize").length, 2, "404 recovery must perform exactly one replacement initialize");
    assert.equal(core.observed.filter((entry) => entry.method === "tools/list" && entry.id !== "devspace-schema-fingerprint").length, 2, "original request must be retried exactly once after 404 recovery");
    assert.equal(core.observed.filter((entry) => entry.id === "devspace-schema-fingerprint").length, 2, "original initialize and replacement resurrection must each verify the current Core tool schema exactly once");
    assert.equal(registry.lookup(publicSessionId).backendSessionId, "core-404-backend-2");
  } finally {
    await close(gatewayServer);
    await close(core.server);
  }
}

async function testNon404CoreFailureIsNeverResurrected() {
  const core = await createFakeCore("core-500", { genericFailureStatus: 500 });
  const registry = new StableGatewaySessionRegistry();
  const gateway = createStableGatewayProxy({
    activeCore: { id: core.id, baseUrl: core.baseUrl },
    publicBaseUrl: "https://devspace-gateway.example.test",
    registry,
    backendSessionReinitIdleMs: 60_000,
  });
  const gatewayServer = createServer(gateway.handler);
  const gatewayBaseUrl = await listen(gatewayServer);
  try {
    const initialize = await postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }, { authorization: "Bearer current-request-token" });
    const publicSessionId = initialize.headers["mcp-session-id"];
    const result = await postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, {
      authorization: "Bearer current-request-token",
      "mcp-session-id": publicSessionId,
    });
    assert.equal(result.status, 500);
    assert.equal(core.observed.filter((entry) => entry.method === "initialize").length, 1, "5xx must never trigger automatic session resurrection");
    assert.equal(core.observed.filter((entry) => entry.method === "tools/list" && entry.id !== "devspace-schema-fingerprint").length, 1, "5xx business request must never be replayed");
    assert.equal(core.observed.filter((entry) => entry.id === "devspace-schema-fingerprint").length, 1, "initialize must still stamp the schema exactly once before the later 5xx");
  } finally {
    await close(gatewayServer);
    await close(core.server);
  }
}

async function testRestoredPublicSessionLazyResurrectionIsSingleFlight() {
  const core = await createFakeCore("core-restored");
  const registry = new StableGatewaySessionRegistry();
  const publicSessionId = "12345678-1234-1234-1234-123456789abc";
  registry.restoreDescriptors([{
    publicSessionId,
    initializeBody: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    initialized: true,
    lastActivityAt: Date.now(),
    schemaFingerprint: schemaFingerprint(FAKE_TOOLS),
    toolCount: 2,
  }]);
  const gateway = createStableGatewayProxy({
    activeCore: { id: core.id, baseUrl: core.baseUrl },
    publicBaseUrl: "https://devspace-gateway.example.test",
    registry,
  });
  const gatewayServer = createServer(gateway.handler);
  const gatewayBaseUrl = await listen(gatewayServer);
  try {
    const headers = { authorization: "Bearer current-request-token", "mcp-session-id": publicSessionId };
    const [first, second] = await Promise.all([
      postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: 10, method: "tools/list", params: {} }, headers),
      postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: 11, method: "tools/list", params: {} }, headers),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.headers["mcp-session-id"], publicSessionId);
    assert.equal(second.headers["mcp-session-id"], publicSessionId);
    assert.equal(core.observed.filter((entry) => entry.method === "initialize").length, 1, "concurrent stale requests must share one resurrection initialize");
    assert.equal(core.observed.filter((entry) => entry.method === "notifications/initialized").length, 1, "initialized replay must also be single-flight");
    assert.equal(registry.lookup(publicSessionId).coreId, "core-restored");
    assert.equal(registry.lookup(publicSessionId).authorization, "Bearer current-request-token");
  } finally {
    await close(gatewayServer);
    await close(core.server);
  }
}

async function testReplayDropsSessionWhenToolSchemaChanges() {
  const coreA = await createFakeCore("core-a", { tools: FAKE_TOOLS });
  const coreB = await createFakeCore("core-b", { tools: CHANGED_TOOLS });
  const registry = new StableGatewaySessionRegistry();
  const gateway = createStableGatewayProxy({ activeCore: { id: coreA.id, baseUrl: coreA.baseUrl }, publicBaseUrl: "https://devspace-gateway.example.test", registry });
  const gatewayServer = createServer(gateway.handler);
  const gatewayBaseUrl = await listen(gatewayServer);
  try {
    const initialized = await postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { authorization: "Bearer schema-secret" });
    const publicSessionId = initialized.headers["mcp-session-id"];
    await postJson(gatewayBaseUrl, { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, {
      authorization: "Bearer schema-secret",
      "mcp-session-id": publicSessionId,
    });
    await postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, {
      authorization: "Bearer schema-secret",
      "mcp-session-id": publicSessionId,
    });
    assert.equal(registry.lookup(publicSessionId).schemaFingerprint, schemaFingerprint(FAKE_TOOLS));

    const replayed = await gateway.replaySessionsToCore({ id: coreB.id, baseUrl: coreB.baseUrl });
    assert.deepEqual(replayed.mappings, []);
    assert.deepEqual(replayed.droppedPublicSessionIds, [publicSessionId]);
    assert.equal(registry.lookup(publicSessionId), undefined, "schema-stale public sessions must be removed so the host performs a fresh initialize");
  } finally {
    await close(gatewayServer);
    await close(coreA.server);
    await close(coreB.server);
  }
}

async function testLegacyDescriptorWithoutSchemaRequiresFreshInitialize() {
  const core = await createFakeCore("core-legacy", { tools: FAKE_TOOLS });
  const registry = new StableGatewaySessionRegistry();
  const publicSessionId = "32345678-1234-1234-1234-123456789abc";
  registry.restoreDescriptors([{
    publicSessionId,
    initializeBody: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    initialized: true,
    lastActivityAt: Date.now(),
    schemaFingerprint: null,
    toolCount: null,
  }]);
  const gateway = createStableGatewayProxy({ activeCore: { id: core.id, baseUrl: core.baseUrl }, publicBaseUrl: "https://devspace-gateway.example.test", registry });
  const gatewayServer = createServer(gateway.handler);
  const gatewayBaseUrl = await listen(gatewayServer);
  try {
    const response = await postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: 10, method: "tools/list", params: {} }, {
      authorization: "Bearer current-token",
      "mcp-session-id": publicSessionId,
    });
    assert.equal(response.status, 404);
    assert.match(response.body, /schema changed|reinitialize/i);
    assert.equal(registry.lookup(publicSessionId), undefined);
    assert.equal(core.observed.filter((entry) => entry.method === "initialize").length, 1);
    assert.equal(core.observed.filter((entry) => entry.id === "devspace-schema-fingerprint").length, 1);
  } finally {
    await close(gatewayServer);
    await close(core.server);
  }
}

await testInitializeAndStablePublicSession();
await testSessionBoundRequestTranslation();
await testLongLivedMcpGetDoesNotBlockDrainAccounting();
await testStreamingResponseIsNotBuffered();
await testBarrierAlsoQueuesNewInitialize();
await testReplayPreservesPublicSessionAndInitializedNotification();
await testReplayDropsOnlyTheStaleSession();
await testPromotionWaitsForDrainThenSwitchesAtomically();
await testPromotionDropsOnlyFailedReplaySession();
await testExactUnknownSession404ResurrectsAndRetriesOnce();
await testNon404CoreFailureIsNeverResurrected();
await testRestoredPublicSessionLazyResurrectionIsSingleFlight();
await testReplayDropsSessionWhenToolSchemaChanges();
await testLegacyDescriptorWithoutSchemaRequiresFreshInitialize();

console.log(JSON.stringify({ ok: true, gate: "stable-gateway-proxy", lazyResurrection: true, resurrectionSingleFlight: true, exact404RetryOnce: true, no5xxReplay: true, schemaFingerprintCaptured: true, staleSchemaForcesFreshInitialize: true }));
