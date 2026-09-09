import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";
import { SingleUserOAuthProvider } from "../dist/oauth-provider.js";

const configDir = process.env.DEVSPACE_CONFIG_DIR || join(homedir(), ".devspace-tailscale-bootstrap");
const configPath = join(configDir, "config.json");
const authPath = join(configDir, "auth.json");
const config = JSON.parse((await readFile(configPath, "utf8")).replace(/^\uFEFF/, ""));
const auth = JSON.parse((await readFile(authPath, "utf8")).replace(/^\uFEFF/, ""));
const ownerToken = String(auth?.ownerToken || config?.oauth?.ownerToken || "").trim();
assert.ok(ownerToken, "Local owner password is required for the loopback-only live gate.");

async function resolveCorePort() {
  const configured = [process.env.DEVSPACE_PROBE_CORE_PORT, config?.stableGatewayCoreAPort, config?.stableGatewayCoreBPort, 7688, 7689]
    .map(Number)
    .filter((value, index, values) => Number.isInteger(value) && values.indexOf(value) === index);
  for (const port of configured) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/__devspace/memory/status`, { cache: "no-store" });
      const body = await response.json();
      if (response.ok && body?.ok === true) return port;
    } catch {}
  }
  throw new Error("No active Stable Gateway Core was found on the configured loopback ports.");
}

const port = await resolveCorePort();
const coreBase = `http://127.0.0.1:${port}`;
const base = process.env.DEVSPACE_PROBE_BASE_URL || coreBase;
const resource = new URL(process.env.DEVSPACE_PROBE_RESOURCE_URL || `${base}/mcp`);

async function issueLocalAccessToken() {
  const loaded = loadConfig();
  const provider = new SingleUserOAuthProvider({ ...loaded.oauth, ownerToken }, resource, loaded.stateDir);
  try {
    const redirectUri = "http://127.0.0.1/callback";
    const client = provider.clientsStore.registerClient({
      client_name: "DevSpace V0.5 local live gate",
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
      redirect(code, location) {
        this.statusCode = code;
        this.redirectLocation = location;
        return this;
      },
    };
    await provider.authorize(client, {
      resource,
      scopes: loaded.oauth.scopes,
      redirectUri,
      codeChallenge: "devspace-v05-loopback-live-gate",
      state: "local-live-gate",
    }, response);
    assert.equal(response.statusCode, 302, "Local OAuth authorization did not redirect with a code.");
    const code = new URL(response.redirectLocation).searchParams.get("code");
    assert.ok(code, "Local OAuth authorization code was not issued.");
    const tokenPair = await provider.exchangeAuthorizationCode(client, code, undefined, redirectUri, resource);
    assert.ok(tokenPair.access_token, "Local OAuth access token was not issued.");
    return tokenPair.access_token;
  } finally {
    provider.close();
  }
}

const token = await issueLocalAccessToken();

function payload(text) {
  const raw = String(text || "").trim();
  try { return JSON.parse(raw); } catch {}
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try { return JSON.parse(line.slice(5).trim()); } catch {}
  }
  return null;
}

async function post(body, sessionId = null, protocolVersion = null) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: payload(text) };
}

const initialized = await post({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "devspace-v05-live-gate", version: "0.5.0" },
  },
});
assert.equal(initialized.response.ok, true, `initialize failed: HTTP ${initialized.response.status} ${JSON.stringify(initialized.body)}`);
const sessionId = initialized.response.headers.get("mcp-session-id");
assert.ok(sessionId);
const protocolVersion = initialized.body?.result?.protocolVersion || "2025-11-25";

await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, sessionId, protocolVersion);
const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionId, protocolVersion);
assert.equal(listed.response.ok, true, `tools/list failed: HTTP ${listed.response.status} ${JSON.stringify(listed.body)}`);
const names = new Set((listed.body?.result?.tools || []).map((tool) => tool.name));
for (const required of [
  "capability_connection",
  "capability_instance",
  "blender_runtime",
  "blender_mcp",
  "capability_route",
  "tool_search",
  "devspace_progress_report",
]) {
  assert.ok(names.has(required), `missing live V0.5 tool: ${required}`);
}
const blenderRuntime = (listed.body?.result?.tools || []).find((tool) => tool.name === "blender_runtime");
const blenderMcp = (listed.body?.result?.tools || []).find((tool) => tool.name === "blender_mcp");
assert.ok(blenderRuntime?.inputSchema?.properties?.runtimeId, "blender_runtime must expose runtimeId ownership routing.");
assert.ok(blenderMcp?.inputSchema?.properties?.runtimeId, "blender_mcp must expose runtimeId so one Agent cannot fall back to another Agent's Blender.");

await fetch(`${base}/mcp`, {
  method: "DELETE",
  headers: {
    authorization: `Bearer ${token}`,
    "mcp-session-id": sessionId,
    "mcp-protocol-version": protocolVersion,
  },
}).catch(() => null);

console.log(JSON.stringify({
  ok: true,
  gate: "v05-core-tool-surface-live",
  toolCount: names.size,
  requiredToolsPresent: true,
  isolatedBlenderRuntimeSchema: true,
  corePort: port,
  requestBase: base,
  throughGateway: base !== coreBase,
  secretsLogged: false,
}));
