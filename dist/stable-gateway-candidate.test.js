import assert from "node:assert/strict";
import { createServer } from "node:http";
import { MODEL_SURFACE_FINGERPRINT_VERSION, probeCandidate, readCoreRuntimeIdentity, readCoreSchemaFingerprint, readSessionSchemaFingerprint, schemaFingerprint } from "./stable-gateway-candidate.js";

const PUBLIC_BASE = "https://devspace-gateway.example.test";
const EXPECTED_TOOLS = [
  {
    name: "read",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "bash",
    description: "Run a command",
    inputSchema: { properties: { command: { type: "string" } }, type: "object", required: ["command"] },
    annotations: { readOnlyHint: false },
  },
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

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function createCandidateCore({
  healthOk = true,
  resource = `${PUBLIC_BASE}/mcp`,
  issuer = `${PUBLIC_BASE}/`,
  tools = EXPECTED_TOOLS,
  pid = 45678,
} = {}) {
  const observed = [];
  const server = createServer(async (req, res) => {
    observed.push({ method: req.method, url: req.url, authorization: req.headers.authorization, sessionId: req.headers["mcp-session-id"] });
    if (req.url === "/healthz") {
      res.statusCode = healthOk ? 200 : 503;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: healthOk }));
      return;
    }
    if (req.url === "/__devspace/memory/status") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        pid,
        features: { passiveCore: false, autoCompactEnabled: false },
      }));
      return;
    }
    if (req.url === "/.well-known/oauth-protected-resource/mcp") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ resource, authorization_servers: [`${PUBLIC_BASE}/`] }));
      return;
    }
    if (req.url === "/.well-known/oauth-authorization-server") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        issuer,
        authorization_endpoint: `${PUBLIC_BASE}/authorize`,
        token_endpoint: `${PUBLIC_BASE}/token`,
        registration_endpoint: `${PUBLIC_BASE}/register`,
        revocation_endpoint: `${PUBLIC_BASE}/revoke`,
        scopes_supported: ["devspace", "offline_access"],
      }));
      return;
    }
    if (req.url === "/mcp" && req.method === "POST") {
      const body = await readJson(req);
      if (body.method === "initialize") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.setHeader("mcp-session-id", "candidate-backend-session");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "candidate", version: "1" } } }));
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
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools } }));
        return;
      }
    }
    res.statusCode = 404;
    res.end();
  });
  const baseUrl = await listen(server);
  return { server, baseUrl, observed };
}

function reorderedTools() {
  return [
    {
      annotations: { readOnlyHint: false },
      inputSchema: { required: ["command"], type: "object", properties: { command: { type: "string" } } },
      description: "Run a command",
      name: "bash",
    },
    {
      inputSchema: { required: ["path"], properties: { path: { type: "string" } }, type: "object" },
      name: "read",
      annotations: { readOnlyHint: true },
      description: "Read a file",
    },
  ];
}

assert.equal(MODEL_SURFACE_FINGERPRINT_VERSION, 2);
assert.equal(schemaFingerprint(EXPECTED_TOOLS), schemaFingerprint(reorderedTools()), "schema fingerprint must ignore object-key and tool ordering");
assert.notEqual(schemaFingerprint(EXPECTED_TOOLS), schemaFingerprint(EXPECTED_TOOLS.slice(0, 1)), "tool removal must change the fingerprint");
assert.notEqual(
  schemaFingerprint(EXPECTED_TOOLS),
  schemaFingerprint(EXPECTED_TOOLS.map((tool, index) => index === 0 ? { ...tool, description: "Read a file with refreshed agent routing" } : tool)),
  "tool-description changes must force a fresh MCP initialize so connected agents receive updated routing instructions",
);
assert.notEqual(
  schemaFingerprint(EXPECTED_TOOLS),
  schemaFingerprint(EXPECTED_TOOLS.map((tool, index) => index === 0 ? { ...tool, outputSchema: { type: "object", properties: { result: { type: "string" } } } } : tool)),
  "tool output-schema changes must invalidate a resurrected MCP session",
);
assert.notEqual(
  schemaFingerprint(EXPECTED_TOOLS),
  schemaFingerprint(EXPECTED_TOOLS.map((tool, index) => index === 0 ? { ...tool, _meta: { ui: { visibility: ["model"], resourceUri: "ui://devspace/refreshed.html" } } } : tool)),
  "tool UI metadata changes must invalidate legacy inline-card sessions",
);
assert.notEqual(
  schemaFingerprint(EXPECTED_TOOLS),
  schemaFingerprint(EXPECTED_TOOLS.map((tool, index) => index === 0 ? {
    ...tool,
    _meta: { devspace: { routingContractVersion: "1", routingFingerprint: "a".repeat(64), modelInstructionsFingerprint: "b".repeat(64) } },
  } : tool)),
  "plugin routing or model-instruction metadata changes must force agents onto a freshly initialized MCP surface",
);

async function testReadsBaselineSchemaFromExistingSession() {
  const core = await createCandidateCore();
  try {
    const result = await readSessionSchemaFingerprint({
      coreBaseUrl: core.baseUrl,
      bearerToken: "Bearer baseline-secret",
      backendSessionId: "existing-backend-session",
      protocolVersion: "2025-11-25",
    });
    assert.equal(result.schemaFingerprint, schemaFingerprint(EXPECTED_TOOLS));
    assert.equal(result.toolCount, EXPECTED_TOOLS.length);
    const request = core.observed.find((entry) => entry.url === "/mcp" && entry.sessionId === "existing-backend-session");
    assert.equal(request.authorization, "Bearer baseline-secret");
    assert.doesNotMatch(JSON.stringify(result), /baseline-secret|existing-backend-session/);
  } finally {
    await close(core.server);
  }
}

async function testReadsExactCoreRuntimeIdentity() {
  const core = await createCandidateCore({ pid: 54321 });
  try {
    const result = await readCoreRuntimeIdentity({ coreBaseUrl: core.baseUrl });
    assert.deepEqual(result, {
      ok: true,
      baseUrl: core.baseUrl,
      pid: 54321,
      passiveCore: false,
      autoCompactEnabled: false,
    });
    assert.equal(core.observed.some((entry) => entry.url === "/__devspace/memory/status"), true);
  } finally {
    await close(core.server);
  }
}

async function testReadsBaselineSchemaFromFreshEphemeralSession() {
  const core = await createCandidateCore();
  try {
    assert.equal(typeof readCoreSchemaFingerprint, "function");
    const result = await readCoreSchemaFingerprint({
      coreBaseUrl: core.baseUrl,
      bearerToken: "Bearer latest-active-secret",
    });
    assert.equal(result.schemaFingerprint, schemaFingerprint(EXPECTED_TOOLS));
    assert.equal(result.toolCount, EXPECTED_TOOLS.length);
    const mcp = core.observed.filter((entry) => entry.url === "/mcp");
    assert.equal(mcp.length, 3, "fresh active-Core baseline probe must initialize, notify initialized, then list tools");
    assert.equal(mcp[0].sessionId, undefined);
    assert.equal(mcp[0].authorization, "Bearer latest-active-secret");
    assert.equal(mcp[1].sessionId, "candidate-backend-session");
    assert.equal(mcp[2].sessionId, "candidate-backend-session");
    assert.doesNotMatch(JSON.stringify(result), /latest-active-secret|candidate-backend-session/);
  } finally {
    await close(core.server);
  }
}

async function testCompatibleCandidatePasses() {
  const core = await createCandidateCore();
  try {
    const expectedSchemaFingerprint = schemaFingerprint(EXPECTED_TOOLS);
    const result = await probeCandidate({
      coreBaseUrl: core.baseUrl,
      publicBaseUrl: PUBLIC_BASE,
      bearerToken: "Bearer candidate-secret",
      expectedSchemaFingerprint,
    });
    assert.equal(result.ok, true);
    assert.equal(result.stage, "compatible");
    assert.equal(result.schemaFingerprint, expectedSchemaFingerprint);
    assert.equal(result.resource, `${PUBLIC_BASE}/mcp`);
    assert.equal(result.issuer, `${PUBLIC_BASE}/`);
    assert.equal(result.scopes.includes("offline_access"), true);
    assert.equal(core.observed.some((entry) => entry.url === "/mcp" && entry.authorization === "Bearer candidate-secret"), true);
    assert.doesNotMatch(JSON.stringify(result), /candidate-secret/);
  } finally {
    await close(core.server);
  }
}

async function testHealthMismatchFailsBeforeMcp() {
  const core = await createCandidateCore({ healthOk: false });
  try {
    const result = await probeCandidate({ coreBaseUrl: core.baseUrl, publicBaseUrl: PUBLIC_BASE, bearerToken: "Bearer secret", expectedSchemaFingerprint: schemaFingerprint(EXPECTED_TOOLS) });
    assert.equal(result.ok, false);
    assert.equal(result.stage, "health");
    assert.equal(core.observed.some((entry) => entry.url === "/mcp"), false, "unhealthy candidate must not reach MCP compatibility probes");
  } finally {
    await close(core.server);
  }
}

async function testPublicResourceMismatchFails() {
  const core = await createCandidateCore({ resource: "https://wrong.example/mcp" });
  try {
    const result = await probeCandidate({ coreBaseUrl: core.baseUrl, publicBaseUrl: PUBLIC_BASE, bearerToken: "Bearer secret", expectedSchemaFingerprint: schemaFingerprint(EXPECTED_TOOLS) });
    assert.equal(result.ok, false);
    assert.equal(result.stage, "protected-resource");
  } finally {
    await close(core.server);
  }
}

async function testIssuerMismatchFails() {
  const core = await createCandidateCore({ issuer: "https://wrong.example/" });
  try {
    const result = await probeCandidate({ coreBaseUrl: core.baseUrl, publicBaseUrl: PUBLIC_BASE, bearerToken: "Bearer secret", expectedSchemaFingerprint: schemaFingerprint(EXPECTED_TOOLS) });
    assert.equal(result.ok, false);
    assert.equal(result.stage, "authorization-server");
  } finally {
    await close(core.server);
  }
}

async function testSchemaMismatchFails() {
  const core = await createCandidateCore({ tools: EXPECTED_TOOLS.slice(0, 1) });
  try {
    const result = await probeCandidate({ coreBaseUrl: core.baseUrl, publicBaseUrl: PUBLIC_BASE, bearerToken: "Bearer secret", expectedSchemaFingerprint: schemaFingerprint(EXPECTED_TOOLS) });
    assert.equal(result.ok, false);
    assert.equal(result.stage, "schema");
    assert.notEqual(result.schemaFingerprint, result.expectedSchemaFingerprint);
  } finally {
    await close(core.server);
  }
}

async function testExplicitSchemaChangePassesOnlyAfterFullCandidateValidation() {
  const changedTools = EXPECTED_TOOLS.slice(0, 1);
  const core = await createCandidateCore({ tools: changedTools });
  try {
    const previousSchemaFingerprint = schemaFingerprint(EXPECTED_TOOLS);
    const result = await probeCandidate({
      coreBaseUrl: core.baseUrl,
      publicBaseUrl: PUBLIC_BASE,
      bearerToken: "Bearer schema-change-secret",
      expectedSchemaFingerprint: previousSchemaFingerprint,
      allowSchemaChange: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.stage, "schema-change-compatible");
    assert.equal(result.schemaChanged, true);
    assert.equal(result.requiresFreshInitialize, true);
    assert.equal(result.previousSchemaFingerprint, previousSchemaFingerprint);
    assert.equal(result.schemaFingerprint, schemaFingerprint(changedTools));
    assert.notEqual(result.schemaFingerprint, previousSchemaFingerprint);
    assert.equal(result.resource, `${PUBLIC_BASE}/mcp`);
    assert.equal(result.issuer, `${PUBLIC_BASE}/`);
    assert.equal(core.observed.some((entry) => entry.url === "/mcp" && entry.authorization === "Bearer schema-change-secret"), true);
    assert.doesNotMatch(JSON.stringify(result), /schema-change-secret/);
  } finally {
    await close(core.server);
  }
}

async function testExplicitSchemaChangeRejectsEmptyToolSurface() {
  const core = await createCandidateCore({ tools: [] });
  try {
    const result = await probeCandidate({
      coreBaseUrl: core.baseUrl,
      publicBaseUrl: PUBLIC_BASE,
      bearerToken: "Bearer empty-schema-secret",
      expectedSchemaFingerprint: schemaFingerprint(EXPECTED_TOOLS),
      allowSchemaChange: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.stage, "tools-list");
    assert.equal(result.emptyToolSurface, true);
  } finally {
    await close(core.server);
  }
}

await testReadsBaselineSchemaFromExistingSession();
await testReadsExactCoreRuntimeIdentity();
await testReadsBaselineSchemaFromFreshEphemeralSession();
await testCompatibleCandidatePasses();
await testHealthMismatchFailsBeforeMcp();
await testPublicResourceMismatchFails();
await testIssuerMismatchFails();
await testSchemaMismatchFails();
await testExplicitSchemaChangePassesOnlyAfterFullCandidateValidation();
await testExplicitSchemaChangeRejectsEmptyToolSurface();

console.log(JSON.stringify({ ok: true, gate: "stable-gateway-candidate", schemaChangeRequiresExplicitOptIn: true, schemaChangeStillRunsFullCandidateValidation: true, emptyToolSurfaceRejected: true }));
