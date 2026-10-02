import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { createServer } from "./server.js";
import { PROGRESS_CLAIM_RELAY_URI } from "./goal-relay-resource.js";

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
  const listed = await post({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} }, sessionId, protocolVersion);
  const reportTool = listed.body?.result?.tools?.find((tool) => tool.name === "devspace_progress_report");
  assert.equal(reportTool?._meta?.ui?.resourceUri, PROGRESS_CLAIM_RELAY_URI,
    "the existing report tool must mount its own exact-page bootstrap relay");
  const legacyBindTool = listed.body?.result?.tools?.find((tool) => tool.name === "devspace_progress_bind");
  assert.deepEqual(legacyBindTool?._meta?.ui?.visibility, ["app"],
    "the legacy bind endpoint may remain callable for cached App relays but must not be model-visible");

  const resourceResult = await post({
    jsonrpc: "2.0", id: 2, method: "resources/read",
    params: { uri: PROGRESS_CLAIM_RELAY_URI },
  }, sessionId, protocolVersion);
  const relayHtml = resourceResult.body?.result?.contents?.[0]?.text || "";
  assert.match(relayHtml, /ui\/initialize/);
  assert.match(relayHtml, /ui\/notifications\/initialized/);
  assert.doesNotMatch(relayHtml, /__DEVSPACE_RELAY_APP_BRIDGE__/);
  const legacyResource = await post({
    jsonrpc: "2.0", id: 102, method: "resources/read",
    params: { uri: "ui://devspace/progress-claim-relay.html" },
  }, sessionId, protocolVersion);
  assert.equal(legacyResource.body?.result?.contents?.[0]?.uri, "ui://devspace/progress-claim-relay.html");
  assert.match(legacyResource.body?.result?.contents?.[0]?.text || "", /ui\/initialize/,
    "cached Classic tool descriptors must retain working resource compatibility");
  const probeMatch = relayHtml.match(/https:\/\/computer-a\.example\/__devspace\/relay-origin-probe\?t=[0-9a-f-]+/i);
  assert.ok(probeMatch, "relay resource must contain one unguessable instance-origin probe URL");
  const publicProbe = new URL(probeMatch[0]);
  const localProbe = new URL(`${publicProbe.pathname}${publicProbe.search}`, base);
  const appOrigin = "https://asdk_app_computera.web-sandbox.oaiusercontent.com";
  const probed = await fetch(localProbe, { headers: { origin: appOrigin } });
  assert.equal(probed.status, 204);
  assert.equal(probed.headers.get("access-control-allow-origin"), appOrigin);
  let persistedOrigins = null;
  for (let attempt = 0; attempt < 20 && !persistedOrigins; attempt += 1) {
    try { persistedOrigins = JSON.parse(readFileSync(join(config.stateDir, "classic-relay-app-origins-v1.json"), "utf8")); }
    catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  assert.equal(persistedOrigins?.serverInstanceId, "computer-a-instance");
  assert.equal(persistedOrigins?.resourceOrigin, "https://computer-a.example");
  assert.deepEqual(persistedOrigins?.origins, [appOrigin]);
  const rejectedProbe = await fetch(new URL(`${localProbe.pathname}?t=wrong`, base), { headers: { origin: "https://asdk_app_remote.web-sandbox.oaiusercontent.com" } });
  assert.equal(rejectedProbe.status, 404);

  const workspace = await post({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "open_workspace", arguments: { path: root } },
  }, sessionId, protocolVersion);
  assert.equal(workspace.body?.result?.structuredContent?.root, root,
    "workspace tools must not require an unrelated progress-card claim");
  const workspaceId = workspace.body.result.structuredContent.workspaceId;
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=', 'base64');
  writeFileSync(join(root, 'workspace-qa.png'), imageBytes);
  const imageRequest = {
    jsonrpc: '2.0', id: 30, method: 'tools/call',
    params: { name: 'view_image', arguments: { workspaceId, path: 'workspace-qa.png' } },
  };
  const image = await post(imageRequest, sessionId, protocolVersion);
  assert.equal(image.body?.result?.structuredContent?.ok, true,
    'workspace image reads must use the same OAuth/workspace authority as ordinary file reads, without an unrelated Classic page claim');
  const imageBlock = image.body.result.content.find(block => block.type === 'image');
  assert.equal(imageBlock.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(imageBlock.data, 'base64'), imageBytes);
  const unauthenticatedImage = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(imageRequest),
  });
  assert.equal(unauthenticatedImage.status, 401, 'workspace image reads still require OAuth');
  for (const [id, arguments_, expectedError] of [
    [31, { workspaceId, path: '../outside.png' }, /outside|escape|not allowed|denied/i],
    [32, { workspaceId: 'nonexistent-workspace', path: 'workspace-qa.png' }, /workspaceId|workspace/i],
  ]) {
    const deniedImage = await post({ ...imageRequest, id, params: { name: 'view_image', arguments: arguments_ } }, sessionId, protocolVersion);
    assert.equal(deniedImage.body?.result?.isError, true);
    assert.match(JSON.stringify(deniedImage.body.result), expectedError);
    assert.equal(deniedImage.body.result.content.some(block => block.type === 'image'), false);
  }
  writeFileSync(join(root, 'not-an-image.png'), 'Not an image');
  const invalidImage = await post({ ...imageRequest, id: 33,
    params: { name: 'view_image', arguments: { workspaceId, path: 'not-an-image.png' } } }, sessionId, protocolVersion);
  assert.equal(invalidImage.body?.result?.isError, true, 'file signature validation remains enforced');
  const blender = await post({
    jsonrpc: "2.0", id: 11, method: "tools/call",
    params: { name: "blender_runtime", arguments: { action: "list" } },
  }, sessionId, protocolVersion);
  assert.notEqual(blender.body?.error?.code, -32031,
    "a Blender runtime listing must not depend on a ChatGPT conversation claim");
  const capabilityList = await post({
    jsonrpc: "2.0", id: 12, method: "tools/call",
    params: { name: "capability_list", arguments: {} },
  }, sessionId, protocolVersion);
  assert.equal(capabilityList.body?.result?.structuredContent?.ok, true,
    "shared capability metadata must be usable before page binding");
  const capabilityRoute = await post({
    jsonrpc: "2.0", id: 15, method: "tools/call",
    params: { name: "capability_route", arguments: { query: "local file workspace" } },
  }, sessionId, protocolVersion);
  assert.notEqual(capabilityRoute.body?.error?.code, -32031,
    "a routed metadata next step must not stop at the conversation gate");
  const staticInspect = await post({
    jsonrpc: "2.0", id: 13, method: "tools/call",
    params: { name: "capability_inspect", arguments: { pluginId: "missing-test-plugin", probeMcp: false } },
  }, sessionId, protocolVersion);
  assert.notEqual(staticInspect.body?.error?.code, -32031,
    "static capability inspection must not require a conversation claim");
  const liveInspect = await post({
    jsonrpc: "2.0", id: 14, method: "tools/call",
    params: { name: "capability_inspect", arguments: { pluginId: "missing-test-plugin", probeMcp: true } },
  }, sessionId, protocolVersion);
  assert.equal(liveInspect.body?.error?.code, -32031,
    "live capability probing must retain conversation isolation");

  const denied = await post({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "devspace_goal_status", arguments: {} },
  }, sessionId, protocolVersion);
  assert.equal(denied.body?.error?.code, -32031);
  assert.equal(denied.body?.error?.data?.type, "devspace_instance_binding_required");
  assert.equal(denied.body?.error?.data?.serverInstanceId, "computer-a-instance");
  assert.equal(denied.body?.error?.data?.resource, resource.toString());
  assert.equal(denied.body?.error?.data?.bootstrapTools.includes("devspace_progress_report"), true);

  const existingGoal = await post({
    jsonrpc: "2.0", id: 16, method: "tools/call",
    params: { name: "devspace_goal_status", arguments: { goalId: "goal_aaaaaaaaaaaaaaaa" } },
  }, sessionId, protocolVersion);
  assert.equal(existingGoal.body?.error?.code, -32031,
    "an opaque-looking but nonexistent Goal ID must never become conversation authority by itself");

  console.log(JSON.stringify({ ok: true, gate: "server-instance-isolation", workspaceAvailableWithoutClaim: true, blenderAvailableWithoutClaim: true, capabilityMetadataAvailableWithoutClaim: true, liveCapabilityProbeRequiresExactPage: true, newConversationStateRequiresExactPage: true, opaqueGoalIdNotAuthority: true, legacyBindAppOnly: true, tokenBoundAppOriginProbe: true }));
} finally {
  if (httpServer) {
    const closed = new Promise((resolve) => httpServer.close(resolve));
    httpServer.closeAllConnections?.();
    await closed;
  }
  if (closeApp) await closeApp();
  rmSync(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
}
