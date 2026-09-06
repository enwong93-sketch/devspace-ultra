import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { StableGatewaySessionRegistry } from "./stable-gateway-runtime.js";
import { createStableGatewayProxy } from "./stable-gateway-proxy.js";
import { createStableGatewayActivityJournal } from "./stable-gateway-activity.js";

async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) { if (server?.listening) await new Promise((resolve) => server.close(resolve)); }
function postJson(baseUrl, body) {
  const target = new URL("/mcp", baseUrl);
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: target.hostname, port: target.port, path: target.pathname, method: "POST", headers: { "content-type": "application/json", "content-length": String(payload.length) } }, (res) => {
      const chunks = []; res.on("data", (chunk) => chunks.push(Buffer.from(chunk))); res.once("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject); req.end(payload);
  });
}

const core = createServer(async (req, res) => {
  for await (const _ of req) {}
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ jsonrpc: "2.0", id: 7, result: { ok: true } }));
});
const coreBaseUrl = await listen(core);
const journal = createStableGatewayActivityJournal();
const proxy = createStableGatewayProxy({
  activeCore: { id: "core-a", baseUrl: coreBaseUrl },
  publicBaseUrl: "https://devspace.example.test",
  registry: new StableGatewaySessionRegistry(),
  activityJournal: journal,
});
const gateway = createServer(proxy.handler);
const gatewayBaseUrl = await listen(gateway);
try {
  const response = await postJson(gatewayBaseUrl, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "read", arguments: { path: "dist/server.js" } } });
  assert.equal(response.status, 200);
  const activities = journal.snapshot().activities;
  assert.equal(activities.length, 1, "one tools/call must create one activity record");
  assert.equal(activities[0].toolName, "read");
  assert.equal(activities[0].state, "completed");
  assert.match(activities[0].title, /dist\/server\.js/);
  assert.equal(activities[0].statusCode, 200);
} finally {
  await close(gateway);
  await close(core);
}

console.log(JSON.stringify({ ok: true, gate: "stable-gateway-activity-proxy", toolTrafficMirrored: true }));
