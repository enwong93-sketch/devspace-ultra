import assert from "node:assert/strict";
import { loadConfig } from "../dist/config.js";

const config = loadConfig();
const baseUrl = `http://127.0.0.1:${config.port}`;
const authorization = `Bearer ${config.oauth.ownerToken}`;

function parsePayload(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5).trim();
    if (!value || value === "[DONE]") continue;
    try { return JSON.parse(value); } catch {}
  }
  return null;
}

async function request(body, sessionId, method = "POST") {
  const response = await fetch(`${baseUrl}/mcp`, {
    method,
    headers: {
      authorization,
      accept: "application/json, text/event-stream",
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
      ...(sessionId ? { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-11-25" } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { response, payload: parsePayload(text), text };
}

let sessionId = null;
try {
  const initialized = await request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "devspace-v05-live-gate", version: "1.0" },
    },
  });
  assert.equal(initialized.response.ok, true, `initialize failed with HTTP ${initialized.response.status}`);
  sessionId = initialized.response.headers.get("mcp-session-id");
  assert.ok(sessionId);
  await request({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, sessionId);

  const listed = await request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionId);
  const tools = listed.payload?.result?.tools || [];
  const names = new Set(tools.map((tool) => tool.name));
  const required = [
    "devspace_route",
    "devspace_skill_read",
    "capability_connection",
    "blender_runtime",
    "blender_mcp",
    "devspace_progress_report",
  ];
  for (const name of required) assert.ok(names.has(name), `missing live tool ${name}`);

  const routed = await request({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "devspace_route",
      arguments: {
        query: "Open two separate Blender runtimes for two agents on different ports",
        stage: "start",
        limit: 8,
      },
    },
  }, sessionId);
  assert.equal(routed.payload?.result?.isError, false);
  assert.equal(routed.payload?.result?.structuredContent?.primary?.nextAction?.tool, "blender_runtime");

  const connections = await request({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "capability_connection", arguments: { action: "status" } },
  }, sessionId);
  assert.equal(connections.payload?.result?.isError, false);
  assert.equal(connections.payload?.result?.structuredContent?.ok, true);

  console.log(JSON.stringify({
    ok: true,
    gate: "v05-local-mcp-surface-live",
    toolCount: tools.length,
    requiredTools: required,
    routeNextAction: routed.payload.result.structuredContent.primary.nextAction.tool,
    connectionManagerReachable: true,
  }));
} finally {
  if (sessionId) {
    await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: {
        authorization,
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-11-25",
      },
    }).catch(() => {});
  }
}
