import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
const holdSeconds = Math.max(0, Math.min(300, Math.floor(Number(process.env.DEVSPACE_PROBE_HOLD_SECONDS || 0))));

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
      "user-agent": "openai-mcp/devspace-live-gate",
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
  "devspace_progress_bind",
]) {
  assert.ok(names.has(required), `missing live V0.5 tool: ${required}`);
}
const blenderRuntime = (listed.body?.result?.tools || []).find((tool) => tool.name === "blender_runtime");
const blenderMcp = (listed.body?.result?.tools || []).find((tool) => tool.name === "blender_mcp");
const progressReport = (listed.body?.result?.tools || []).find((tool) => tool.name === "devspace_progress_report");
const progressBind = (listed.body?.result?.tools || []).find((tool) => tool.name === "devspace_progress_bind");
assert.ok(blenderRuntime?.inputSchema?.properties?.runtimeId, "blender_runtime must expose runtimeId ownership routing.");
assert.ok(blenderMcp?.inputSchema?.properties?.runtimeId, "blender_mcp must expose runtimeId so one Agent cannot fall back to another Agent's Blender.");
assert.equal(progressReport?._meta?.ui?.resourceUri, "ui://devspace/progress-claim-relay.html", "the existing report tool must bootstrap without a separate host snapshot refresh");
assert.equal(progressBind?._meta?.ui?.resourceUri, "ui://devspace/progress-claim-relay.html", "the legacy bind tool remains compatible");

let unboundWorkspaceAvailable = null;
let unboundBlenderAvailable = null;
let unboundConversationStateDenied = null;
let disposableWriteReadEditCommandPassed = null;
if (process.env.DEVSPACE_PROBE_WORKSPACE_PATH) {
  const workspace = await post({ jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "open_workspace", arguments: { path: process.env.DEVSPACE_PROBE_WORKSPACE_PATH } } }, sessionId, protocolVersion);
  unboundWorkspaceAvailable = Boolean(workspace.body?.result?.structuredContent?.workspaceId);
  assert.equal(unboundWorkspaceAvailable, true, "an authenticated unbound Classic request must open the local workspace");
  const blender = await post({ jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "blender_runtime", arguments: { action: "list" } } }, sessionId, protocolVersion);
  unboundBlenderAvailable = blender.body?.error?.code !== -32031;
  assert.equal(unboundBlenderAvailable, true, "Blender runtime discovery must not depend on progress binding");
  const goal = await post({ jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "devspace_goal_status", arguments: {} } }, sessionId, protocolVersion);
  unboundConversationStateDenied = goal.body?.error?.data?.type === "devspace_instance_binding_required";
  assert.equal(unboundConversationStateDenied, true, "unbound clients must not read another conversation's Goal state");
  if (process.env.DEVSPACE_PROBE_DISPOSABLE_WRITE === "1") {
    const workspaceId = workspace.body.result.structuredContent.workspaceId;
    const filename = `.devspace-v0519-live-${randomUUID()}.txt`;
    const path = join(process.env.DEVSPACE_PROBE_WORKSPACE_PATH, filename);
    try {
      const written = await post({ jsonrpc: "2.0", id: 6, method: "tools/call",
        params: { name: "write", arguments: { workspaceId, path: filename, content: "DEVSPACE_V0519_A\n" } } }, sessionId, protocolVersion);
      assert.equal(written.body?.result?.isError, undefined, "disposable write failed");
      const firstRead = await post({ jsonrpc: "2.0", id: 7, method: "tools/call",
        params: { name: "read", arguments: { workspaceId, path: filename } } }, sessionId, protocolVersion);
      assert.match(JSON.stringify(firstRead.body?.result || {}), /DEVSPACE_V0519_A/, "first readback failed");
      const edited = await post({ jsonrpc: "2.0", id: 8, method: "tools/call",
        params: { name: "edit", arguments: { workspaceId, path: filename,
          edits: [{ oldText: "DEVSPACE_V0519_A", newText: "DEVSPACE_V0519_B" }] } } }, sessionId, protocolVersion);
      assert.equal(edited.body?.result?.isError, undefined, "disposable edit failed");
      const secondRead = await post({ jsonrpc: "2.0", id: 9, method: "tools/call",
        params: { name: "read", arguments: { workspaceId, path: filename } } }, sessionId, protocolVersion);
      assert.match(JSON.stringify(secondRead.body?.result || {}), /DEVSPACE_V0519_B/, "second readback failed");
      const executed = await post({ jsonrpc: "2.0", id: 12, method: "tools/call",
        params: { name: "exec_command", arguments: { workspaceId,
          cmd: `type ${filename}`, yieldTimeMs: 10000 } } }, sessionId, protocolVersion);
      assert.match(JSON.stringify(executed.body?.result || {}), /DEVSPACE_V0519_B/, "command readback failed");
      disposableWriteReadEditCommandPassed = true;
    } finally {
      await unlink(path).catch(() => null);
    }
  }
}

if (holdSeconds > 0) {
  console.log(JSON.stringify({
    ok: true,
    gate: "v05-core-tool-surface-live",
    state: "authorized-session-held-for-safe-handover",
    toolCount: names.size,
    corePort: port,
    requestBase: base,
    throughGateway: base !== coreBase,
    holdSeconds,
    secretsLogged: false,
  }));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, holdSeconds * 1_000));
}

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
  unboundWorkspaceAvailable,
  unboundBlenderAvailable,
  unboundConversationStateDenied,
  disposableWriteReadEditCommandPassed,
  isolatedBlenderRuntimeSchema: true,
  corePort: port,
  requestBase: base,
  throughGateway: base !== coreBase,
  heldSeconds: holdSeconds,
  secretsLogged: false,
}));
