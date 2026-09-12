import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const root = mkdtempSync(join(tmpdir(), "devspace-server-error-"));
let httpServer;
let appClose;

try {
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, "config"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "0123456789abcdef0123456789abcdef",
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: join(root, "state"),
    DEVSPACE_PUBLIC_BASE_URL: "https://edge.example",
    DEVSPACE_PLUGINS: "false",
    DEVSPACE_AUTO_COMPACT: "false",
    DEVSPACE_SUBAGENTS: "false",
    DEVSPACE_LOG_REQUESTS: "false",
    DEVSPACE_LOG_TOOL_CALLS: "false",
  });
  const created = createServer(config);
  appClose = created.close;
  httpServer = await new Promise((resolve, reject) => {
    const server = created.app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true);
  assert.deepEqual(healthBody.executionPolicy, {
    mode: "danger-full-access",
    approvalPolicy: "never",
    sandboxEnabled: false,
    alternativeModes: [],
    ownerSelected: true,
    scope: "single-user-local-workspace",
  });
  const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: "{not-json",
  });
  const body = await response.text();
  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-type") || "", /application\/json/i);
  assert.doesNotMatch(body, /<!DOCTYPE|<html|SyntaxError|body-parser|node_modules|C:\\Users|\\AppData\\/i);
  const parsed = JSON.parse(body);
  assert.equal(parsed.error, "bad_request");
  assert.equal(typeof parsed.requestId, "string");
  assert.ok(parsed.requestId.length >= 8);

  console.log(JSON.stringify({ ok: true, gate: "server-public-error", healthStatus: health.status, status: response.status }));
} finally {
  if (httpServer) {
    const closed = new Promise((resolve) => httpServer.close(resolve));
    httpServer.closeAllConnections?.();
    await closed;
  }
  if (appClose) await appClose();
  rmSync(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
}
