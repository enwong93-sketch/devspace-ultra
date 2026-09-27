import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { createServer } from "./server.js";

const root = mkdtempSync(join(tmpdir(), "devspace-instance-isolation-"));
const ownerToken = "0123456789abcdef0123456789abcdef";
const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_OAUTH_OWNER_TOKEN: ownerToken,
  DEVSPACE_ALLOWED_ROOTS: root,
  DEVSPACE_STATE_DIR: join(root, "state"),
  DEVSPACE_PUBLIC_BASE_URL: "https://computer-a.example",
  DEVSPACE_SERVER_INSTANCE_ID: "computer-a-instance",
  DEVSPACE_PLUGINS: "false",
  DEVSPACE_AUTO_COMPACT: "false",
  DEVSPACE_SUBAGENTS: "false",
  DEVSPACE_CLASSIC_MAIN_DEBUG_PORTS: "1",
});
const resource = new URL("https://computer-a.example/mcp");

async function issueToken() {
  const provider = new SingleUserOAuthProvider({ ...config.oauth, ownerToken }, resource, config.stateDir);
  try {
    const redirectUri = "http://127.0.0.1/callback";
    const client = provider.clientsStore.registerClient({
      client_name: "multi-server isolation test",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    const response = {
      req: { method: "POST", body: { owner_token: ownerToken } },
      statusCode: 200,
      redirectLocation: null,
      status(code) { this.statusCode = code; return this; },
      setHeader() { return this; },
      send() { return this; },
      redirect(code, location) { this.statusCode = code; this.redirectLocation = location; return this; },
    };
    await provider.authorize(client, {
      resource,
      scopes: config.oauth.scopes,
      redirectUri,
      codeChallenge: "devspace-instance-isolation-test",
      state: "instance-isolation",
    }, response);
    assert.equal(response.statusCode, 302);
    const code = new URL(response.redirectLocation).searchParams.get("code");
    const token = await provider.exchangeAuthorizationCode(client, code, undefined, redirectUri, resource);
    return token.access_token;
  } finally {
    provider.close();
  }
}

function payload(text) {
  const raw = String(text || "").trim();
  try { return JSON.parse(raw); } catch {}
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try { return JSON.parse(line.slice(5).trim()); } catch {}
  }
  return null;
}

let httpServer;
let closeApp;
try {
  const token = await issueToken();
  const created = createServer(config);
  closeApp = created.close;
  httpServer = await new Promise((resolve, reject) => {
    const server = created.app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  const post = async (body, sessionId = null, protocolVersion = null) => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "user-agent": "openai-mcp/1.0.0",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
      },
      body: JSON.stringify(body),
    });
    return { response, body: payload(await response.text()) };
  };
  const initialized = await post({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "ChatGPT", version: "1" } },
  });
  assert.equal(initialized.response.ok, true);
  const sessionId = initialized.response.headers.get("mcp-session-id");
  const protocolVersion = initialized.body?.result?.protocolVersion || "2025-11-25";
  await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, sessionId, protocolVersion);

  const denied = await post({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "open_workspace", arguments: { path: root } },
  }, sessionId, protocolVersion);
  assert.equal(denied.body?.error?.code, -32031);
  assert.equal(denied.body?.error?.data?.type, "devspace_instance_binding_required");
  assert.equal(denied.body?.error?.data?.serverInstanceId, "computer-a-instance");
  assert.equal(denied.body?.error?.data?.resource, resource.toString());
  assert.equal(denied.body?.error?.data?.bootstrapTools.includes("devspace_progress_report"), true);

  console.log(JSON.stringify({ ok: true, gate: "server-instance-isolation", wrongComputerCallDenied: true, exactLocalInvocationRequired: true }));
} finally {
  if (httpServer) {
    const closed = new Promise((resolve) => httpServer.close(resolve));
    httpServer.closeAllConnections?.();
    await closed;
  }
  if (closeApp) await closeApp();
  rmSync(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
}
