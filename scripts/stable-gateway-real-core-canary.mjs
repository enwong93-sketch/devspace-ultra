#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { loadConfig } from "../dist/config.js";
import { SingleUserOAuthProvider } from "../dist/oauth-provider.js";
import { loadDevspaceFiles, writeDevspaceAuth, writeDevspaceConfig } from "../dist/user-config.js";
import { createStableGatewayController } from "../dist/stable-gateway-controller.js";
import { probeCandidate, readCoreSchemaFingerprint } from "../dist/stable-gateway-candidate.js";
import { createCandidateSnapshot, startCoreSlot, stopCoreSlot } from "./devspace-core-slot.mjs";
import { startStableGatewayRuntime } from "./devspace-stable-gateway.mjs";

const execFileAsync = promisify(execFile);
const PUBLIC_BASE = "https://stable-gateway-real-canary.invalid";
const REDIRECT_URI = "http://127.0.0.1/callback";
const soakMode = process.argv.includes("--soak");
const sseChurnMode = process.argv.includes("--sse-churn");
const workspaceChurnMode = process.argv.includes("--workspace-churn");
const toolChurnMode = process.argv.includes("--tool-churn") || workspaceChurnMode || sseChurnMode;
const defaultChurnCount = sseChurnMode ? 96 : workspaceChurnMode ? 64 : toolChurnMode ? 96 : soakMode ? 64 : 0;
const sessionChurnCount = Math.max(0, Math.min(200, Math.floor(Number(process.env.DEVSPACE_CANARY_SESSION_CHURN || defaultChurnCount))));
const toolChurnWaves = toolChurnMode ? Math.max(1, Math.min(8, Math.floor(Number(process.env.DEVSPACE_CANARY_TOOL_CHURN_WAVES || 1)))) : 1;
const toolChurnIdleMs = toolChurnMode ? Math.max(5_000, Math.min(180_000, Math.floor(Number(process.env.DEVSPACE_CANARY_TOOL_CHURN_IDLE_MS || 35_000)))) : 0;
const backgroundProfile = new Set(String(process.env.DEVSPACE_CANARY_BACKGROUND_PROFILE || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
const backgroundContext = backgroundProfile.has("context") || backgroundProfile.has("full");
const backgroundOverlay = backgroundProfile.has("overlay") || backgroundProfile.has("full");
const backgroundStream = backgroundProfile.has("stream") || backgroundProfile.has("full");
const backgroundPlugins = backgroundProfile.has("plugins") || backgroundProfile.has("full-product");
const backgroundSkills = backgroundProfile.has("skills") || backgroundPlugins || backgroundProfile.has("full-product");
const canaryNodeArgs = String(process.env.DEVSPACE_CANARY_NODE_OPTIONS || (soakMode ? "--max-old-space-size=1024" : ""))
  .trim()
  .split(/\s+/)
  .filter(Boolean);
const passiveDiagnosticGcRequested = canaryNodeArgs.includes("--expose-gc");
const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function productionPortSnapshot() {
  if (process.platform !== "win32") return [];
  const { stdout } = await execFileAsync("netstat", ["-ano"], { windowsHide: true });
  return String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /LISTENING/i.test(line) && /:(?:7676|7677|7678)\s/i.test(line))
    .sort();
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const port = Number(server.address().port);
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

function fakeAuthorizeResponse(ownerToken) {
  return {
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
}

function httpRequestBuffer(baseUrl, path, { method = "GET", headers = {}, body } = {}) {
  const target = new URL(path, baseUrl);
  const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers: {
        ...headers,
        ...(payload ? { "content-length": String(payload.length) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.once("end", () => resolvePromise({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.once("error", rejectPromise);
    req.end(payload ?? undefined);
  });
}

function jsonBody(response) {
  try { return response.body ? JSON.parse(response.body) : null; }
  catch { return null; }
}

function parseMcpBody(response) {
  const direct = jsonBody(response);
  if (direct) return direct;
  for (const line of String(response.body || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try { return JSON.parse(payload); } catch {}
  }
  return null;
}

async function exactConversationAtPort(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { cache: "no-store" });
    if (!response.ok) return null;
    const targets = await response.json();
    const matches = (Array.isArray(targets) ? targets : [])
      .filter((target) => target?.type === "page" && /chatgpt\.com/i.test(String(target?.url || "")))
      .map((target) => {
        try { return new URL(String(target.url)).pathname.match(/\/c\/([^/?#]+)/)?.[1] || null; }
        catch { return null; }
      })
      .filter(Boolean);
    return matches.length === 1 ? matches[0] : null;
  } catch {
    return null;
  }
}

async function postMcp(baseUrl, body, { accessToken, sessionId, protocolVersion, openAiSessionId } = {}) {
  return await httpRequestBuffer(baseUrl, "/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
      ...(openAiSessionId ? { "oai-session-id": openAiSessionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

function openMcpEventStream(baseUrl, { accessToken, sessionId, protocolVersion } = {}) {
  const target = new URL("/mcp", baseUrl);
  let responseRef = null;
  let openedResolve;
  let openedReject;
  const opened = new Promise((resolvePromise, rejectPromise) => {
    openedResolve = resolvePromise;
    openedReject = rejectPromise;
  });
  const completed = new Promise((resolvePromise) => {
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "GET",
      headers: {
        accept: "text/event-stream",
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
      },
    }, (res) => {
      responseRef = res;
      if ((res.statusCode || 0) >= 400) openedReject(new Error(`MCP event stream HTTP ${res.statusCode}`));
      else openedResolve({ status: res.statusCode });
      res.once("end", resolvePromise);
      res.once("close", resolvePromise);
      res.once("error", resolvePromise);
    });
    req.once("error", (error) => {
      openedReject(error);
      resolvePromise();
    });
    req.end();
    opened.req = req;
  });
  return {
    opened,
    completed,
    close() {
      try { responseRef?.destroy(); } catch {}
      try { opened.req?.destroy(); } catch {}
    },
  };
}

async function refreshThroughGateway(baseUrl, { clientId, refreshToken }) {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
    scope: "devspace offline_access",
    resource: `${PUBLIC_BASE}/mcp`,
  });
  const response = await httpRequestBuffer(baseUrl, "/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const payload = jsonBody(response);
  assert.equal(response.status, 200, `refresh grant failed with HTTP ${response.status}`);
  assert.equal(typeof payload?.access_token, "string");
  assert.equal(typeof payload?.refresh_token, "string");
  assert.notEqual(payload.refresh_token, refreshToken, "refresh token must rotate");
  return payload;
}

async function mintInitialOAuthState({ configEnv, stateDir, ownerToken }) {
  const loaded = loadConfig(configEnv);
  const resource = new URL(`${PUBLIC_BASE}/mcp`);
  const provider = new SingleUserOAuthProvider(loaded.oauth, resource, stateDir);
  try {
    const client = provider.clientsStore.registerClient({
      client_name: "Stable Gateway real Core canary",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    const response = fakeAuthorizeResponse(ownerToken);
    await provider.authorize(client, {
      resource,
      scopes: ["devspace", "offline_access"],
      redirectUri: REDIRECT_URI,
      codeChallenge: "stable-gateway-real-canary-pkce",
      state: "stable-gateway-real-canary",
    }, response);
    assert.equal(response.statusCode, 302);
    const code = new URL(response.redirectLocation).searchParams.get("code");
    assert.ok(code?.startsWith("code-"));
    const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT_URI, resource);
    assert.equal(typeof tokens.access_token, "string");
    assert.equal(typeof tokens.refresh_token, "string");
    return { clientId: client.client_id, tokens };
  } finally {
    provider.close();
  }
}

const productionBefore = await productionPortSnapshot();
const tempRoot = await mkdtemp(join(tmpdir(), "devspace-stable-gateway-real-core-"));
const configDir = join(tempRoot, "config");
const stateDir = join(tempRoot, "state");
await mkdir(configDir, { recursive: true });
await mkdir(stateDir, { recursive: true });

const sourceConfigDir = process.env.DEVSPACE_CANARY_SOURCE_CONFIG_DIR || join(homedir(), ".devspace");
const sourceFiles = loadDevspaceFiles({ ...process.env, DEVSPACE_CONFIG_DIR: sourceConfigDir });
if (!sourceFiles.auth?.ownerToken) throw new Error("Canonical DevSpace owner auth is unavailable for the real Core canary.");

const canaryEnv = {
  ...process.env,
  DEVSPACE_CONFIG_DIR: configDir,
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_PUBLIC_BASE_URL: PUBLIC_BASE,
  DEVSPACE_ALLOWED_ROOTS: packageRoot,
  DEVSPACE_OAUTH_SCOPES: "devspace,offline_access",
  DEVSPACE_PASSIVE_CORE: "true",
  DEVSPACE_CONTEXT_GUARDIAN: backgroundContext ? "true" : "false",
  DEVSPACE_CLASSIC_HOST_OVERLAY: backgroundOverlay ? "true" : "false",
  DEVSPACE_CLASSIC_STREAM_RECOVERY: backgroundStream ? "true" : "false",
  DEVSPACE_AUTO_COMPACT: "false",
  DEVSPACE_PLUGINS: backgroundPlugins ? "true" : "false",
  DEVSPACE_SKILLS: backgroundSkills ? "true" : "false",
  DEVSPACE_SUBAGENTS: "false",
  DEVSPACE_ARTIFACTS: "false",
  DEVSPACE_LOG_REQUESTS: "false",
  DEVSPACE_LOG_TOOL_CALLS: "false",
};

writeDevspaceConfig({
  stateDir,
  publicBaseUrl: PUBLIC_BASE,
  allowedRoots: [packageRoot],
  toolMode: "ultra",
  pluginPaths: Array.isArray(sourceFiles.config?.pluginPaths) ? sourceFiles.config.pluginPaths : [],
  pluginsEnabled: backgroundPlugins,
  skillsEnabled: backgroundSkills,
  artifactsEnabled: true,
  classicStreamRecoveryEnabled: backgroundStream,
  contextGuardianEnabled: backgroundContext,
  classicHostOverlayEnabled: backgroundOverlay,
  autoCompactEnabled: false,
}, canaryEnv);
writeDevspaceAuth({ ownerToken: sourceFiles.auth.ownerToken }, canaryEnv);

let runtime = null;
let oauth = null;
try {
  oauth = await mintInitialOAuthState({ configEnv: canaryEnv, stateDir, ownerToken: sourceFiles.auth.ownerToken });
  const usedPorts = new Set();
  const nextDistinctPort = async () => {
    while (true) {
      const port = await freePort();
      if (usedPorts.has(port)) continue;
      usedPorts.add(port);
      return port;
    }
  };
  const offlineBlenderPort = await nextDistinctPort();
  const coreAPort = await nextDistinctPort();
  const coreBPort = await nextDistinctPort();
  // Replayed direct-session authority is intentionally page-verified. Use the
  // currently open Main-01 conversation when this live canary is run beside a
  // production desktop; otherwise verify the fail-closed path rather than
  // inventing a browser page that does not exist.
  const liveReplayConversationId = await exactConversationAtPort(9721);
  const replayConversationId = liveReplayConversationId || "canary-main-01-conversation";
  const replayPageAvailable = Boolean(liveReplayConversationId);
  const replayRuntimeId = "rosa-main-01-existing";
  const replayOpenAiSessionId = "stable-gateway-replayed-main01-session";
  const replaySessionFingerprint = createHash("sha256").update(replayOpenAiSessionId).digest("hex");
  await writeFile(join(stateDir, "classic-conversation-authority.json"), `${JSON.stringify({
    version: 1,
    sessions: [{
      fingerprint: replaySessionFingerprint,
      conversationIds: [replayConversationId],
      runtimeKeys: ["main-01"],
      ambiguous: false,
      updatedAt: new Date().toISOString(),
      verifiedDirectSession: true,
      verifiedDirectSessionAt: new Date().toISOString(),
    }],
  }, null, 2)}\n`, "utf8");
  await writeFile(join(stateDir, "blender-runtimes.json"), `${JSON.stringify({
    version: 2,
    updatedAt: new Date().toISOString(),
    runtimes: [{
      runtimeId: replayRuntimeId,
      ownerConversationId: replayConversationId,
      ownerLabel: "replayed Main-01 canary",
      port: offlineBlenderPort,
      processId: null,
      managedProcess: false,
      defaultForOwner: true,
      blendFile: null,
      executable: null,
      createdAt: new Date().toISOString(),
      connectedAt: null,
    }],
  }, null, 2)}\n`, "utf8");

  const canaryRuntimeEnvOverrides = {
    DEVSPACE_PASSIVE_CORE: canaryEnv.DEVSPACE_PASSIVE_CORE,
    DEVSPACE_CONTEXT_GUARDIAN: canaryEnv.DEVSPACE_CONTEXT_GUARDIAN,
    DEVSPACE_CLASSIC_HOST_OVERLAY: canaryEnv.DEVSPACE_CLASSIC_HOST_OVERLAY,
    DEVSPACE_CLASSIC_STREAM_RECOVERY: canaryEnv.DEVSPACE_CLASSIC_STREAM_RECOVERY,
    DEVSPACE_AUTO_COMPACT: canaryEnv.DEVSPACE_AUTO_COMPACT,
    DEVSPACE_PLUGINS: canaryEnv.DEVSPACE_PLUGINS,
    DEVSPACE_SKILLS: canaryEnv.DEVSPACE_SKILLS,
    DEVSPACE_SUBAGENTS: canaryEnv.DEVSPACE_SUBAGENTS,
    DEVSPACE_ARTIFACTS: canaryEnv.DEVSPACE_ARTIFACTS,
  };
  const dependencies = {
    createCandidateSnapshot,
    startCoreSlot: (options) => startCoreSlot({
      ...options,
      baseEnv: canaryEnv,
      runtimeEnvOverrides: canaryRuntimeEnvOverrides,
      nodeArgs: canaryNodeArgs,
      allowDiagnosticGc: true,
    }),
    stopCoreSlot,
    probeCandidate,
    readCoreSchemaFingerprint,
  };
  const controller = createStableGatewayController({
    publicBaseUrl: PUBLIC_BASE,
    configDir,
    stateDir,
    corePorts: { a: coreAPort, b: coreBPort },
    initialSlot: "a",
    dependencies,
    drainTimeoutMs: 10_000,
    requestTimeoutMs: 10_000,
  });
  const controlToken = "real-core-canary-control-token-" + Date.now().toString(36) + "-local";
  runtime = await startStableGatewayRuntime({
    gatewayPort: 0,
    configDir,
    controller,
    controlToken,
  });
  const gatewayBaseUrl = `http://127.0.0.1:${runtime.gatewayPort}`;
  const gatewayPortBefore = runtime.gatewayPort;

  const health = await httpRequestBuffer(gatewayBaseUrl, "/healthz");
  assert.equal(health.status, 200);
  assert.equal(jsonBody(health)?.ok, true);
  const protectedResource = await httpRequestBuffer(gatewayBaseUrl, "/.well-known/oauth-protected-resource/mcp");
  assert.equal(protectedResource.status, 200);
  assert.equal(jsonBody(protectedResource)?.resource, `${PUBLIC_BASE}/mcp`);
  const authorizationServer = await httpRequestBuffer(gatewayBaseUrl, "/.well-known/oauth-authorization-server");
  assert.equal(authorizationServer.status, 200);
  const authMetadata = jsonBody(authorizationServer);
  assert.equal(authMetadata?.issuer, `${PUBLIC_BASE}/`);
  assert.equal(authMetadata?.scopes_supported?.includes("offline_access"), true);

  const refreshA = await refreshThroughGateway(gatewayBaseUrl, {
    clientId: oauth.clientId,
    refreshToken: oauth.tokens.refresh_token,
  });

  const initialize = await postMcp(gatewayBaseUrl, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "stable-gateway-real-core-canary", version: "0.5.0" },
    },
  }, { accessToken: refreshA.access_token, openAiSessionId: replayOpenAiSessionId });
  assert.equal(initialize.status, 200);
  const initializePayload = parseMcpBody(initialize);
  const protocolVersion = initializePayload?.result?.protocolVersion;
  assert.equal(typeof protocolVersion, "string");
  const publicSessionId = String(initialize.headers["mcp-session-id"] || "");
  assert.match(publicSessionId, /^[0-9a-f-]{36}$/i);

  const initialized = await postMcp(gatewayBaseUrl, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  }, { accessToken: refreshA.access_token, sessionId: publicSessionId, protocolVersion });
  assert.equal(initialized.status >= 200 && initialized.status < 300, true);

  const toolsBefore = await postMcp(gatewayBaseUrl, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  }, { accessToken: refreshA.access_token, sessionId: publicSessionId, protocolVersion });
  assert.equal(toolsBefore.status, 200);
  const toolsBeforePayload = parseMcpBody(toolsBefore);
  const toolsBeforeRows = Array.isArray(toolsBeforePayload?.result?.tools) ? toolsBeforePayload.result.tools : [];
  const toolNamesBefore = new Set(toolsBeforeRows.map((tool) => tool.name));
  const toolCountBefore = toolsBeforeRows.length;
  assert.equal(Number.isInteger(toolCountBefore) && toolCountBefore > 0, true);
  for (const requiredTool of [
    "open_workspace",
    "read",
    "write",
    "edit",
    "bash",
    "grep",
    "glob",
    "ls",
    "apply_patch",
    "exec_command",
    "write_stdin",
    "view_image",
    "request_user_input",
    "current_time",
    "sleep",
    "get_context_remaining",
    "tool_search",
    "list_mcp_resources",
    "list_mcp_resource_templates",
    "read_mcp_resource",
    "codex_mcp_catalog",
    "codex_mcp_refresh",
    "codex_mcp_inspect",
    "codex_mcp_call",
    "codex_mcp_list_resources",
    "codex_mcp_list_resource_templates",
    "codex_mcp_read_resource",
    "js_repl",
    "toolchain_status",
    "toolchain_install",
    "capability_import_codex",
    "codex_computer_use_status",
    "codex_computer_use",
  ]) {
    assert.equal(toolNamesBefore.has(requiredTool), true, `Ultra canary is missing ${requiredTool}.`);
  }
  const codexCatalog = await postMcp(gatewayBaseUrl, {
    jsonrpc: "2.0",
    id: 20,
    method: "tools/call",
    params: {
      name: "codex_mcp_catalog",
      arguments: { includeDisabled: true },
    },
  }, { accessToken: refreshA.access_token, sessionId: publicSessionId, protocolVersion });
  assert.equal(codexCatalog.status, 200);
  const codexCatalogPayload = parseMcpBody(codexCatalog);
  const codexCatalogResult = codexCatalogPayload?.result?.structuredContent;
  assert.equal(codexCatalogResult?.ok, true, "Real Core must expose the linked Codex MCP catalogue even when the local config has no entries.");
  assert.equal(codexCatalogResult?.executionPolicy, "full-access");
  assert.equal(Array.isArray(codexCatalogResult?.servers), true);
  for (const removedTool of ["codex_sandbox_status", "request_permissions", "exec_sandboxed"]) {
    assert.equal(toolNamesBefore.has(removedTool), false, `Full-access-only Core must not expose legacy sandbox tool ${removedTool}.`);
  }
  for (const server of codexCatalogResult.servers) {
    for (const forbidden of ["command", "args", "env", "httpHeaders", "bearerToken", "bearer_token"]) {
      assert.equal(Object.hasOwn(server, forbidden), false, `Linked Codex MCP catalogue leaked forbidden field ${forbidden}.`);
    }
  }

  if (backgroundPlugins) {
    for (const requiredTool of ["capability_list", "capability_inspect", "capability_call"]) {
      assert.equal(toolNamesBefore.has(requiredTool), true, `Capability canary is missing ${requiredTool}.`);
    }
    const capabilityList = await postMcp(gatewayBaseUrl, {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: {
        name: "capability_list",
        arguments: { includeDisabled: true, probeMcp: true },
      },
    }, { accessToken: refreshA.access_token, sessionId: publicSessionId, protocolVersion });
    assert.equal(capabilityList.status, 200);
    const capabilityPayload = parseMcpBody(capabilityList);
    const capabilityResult = capabilityPayload?.result?.structuredContent;
    const powerMem = capabilityResult?.plugins?.find?.((plugin) => plugin.id === "powermem-shared");
    assert.equal(powerMem?.enabled, true, "PowerMem shared capability must be enabled in the real Core canary.");
    assert.equal(powerMem?.trusted, true, "PowerMem shared capability must remain trusted in the real Core canary.");
  }

  const handover = await httpRequestBuffer(gatewayBaseUrl, "/__devspace/gateway/handover", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-devspace-gateway-control": controlToken,
    },
    body: "{}",
  });
  const handoverPayload = jsonBody(handover);
  assert.equal(handover.status, 200, `real Core handover failed: ${handoverPayload?.state || handover.status}`);
  assert.equal(handoverPayload?.ok, true);
  assert.equal(handoverPayload?.activeSlot, "b");
  assert.equal(handoverPayload?.rollback, false);
  assert.equal(runtime.gatewayPort, gatewayPortBefore);

  const toolsAfter = await postMcp(gatewayBaseUrl, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/list",
    params: {},
  }, { accessToken: refreshA.access_token, sessionId: publicSessionId, protocolVersion });
  assert.equal(toolsAfter.status, 200);
  assert.equal(toolsAfter.headers["mcp-session-id"], publicSessionId);
  const toolsAfterPayload = parseMcpBody(toolsAfter);
  const toolCountAfter = toolsAfterPayload?.result?.tools?.length;
  assert.equal(toolCountAfter, toolCountBefore);

  const replayedDirectStatus = await postMcp(gatewayBaseUrl, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "blender_runtime",
      arguments: { action: "status", runtimeId: replayRuntimeId },
    },
  }, { accessToken: refreshA.access_token, sessionId: publicSessionId, protocolVersion });
  assert.equal(
    replayedDirectStatus.status,
    200,
    "replayed Main-01 direct blender_runtime call must return without waiting for a fresh native-call correlation",
  );
  const replayedDirectPayload = parseMcpBody(replayedDirectStatus);
  const replayedDirectResult = replayedDirectPayload?.result?.structuredContent;
  if (replayPageAvailable) {
    assert.equal(
      replayedDirectPayload?.result?.isError === true,
      false,
      "page-verified replayed Main-01 direct blender_runtime call must not return a tool error",
    );
    assert.equal(replayedDirectResult?.ok, true);
    assert.equal(replayedDirectResult?.runtime?.runtimeId, replayRuntimeId);
    assert.equal(replayedDirectResult?.runtime?.ownerConversationId, replayConversationId);
    assert.equal(
      replayedDirectResult?.runtime?.state,
      "offline",
      "the canary Blender runtime is deliberately offline; success proves replayed authority/ownership resolution without touching a live Blender process",
    );
  } else {
    assert.equal(replayedDirectPayload?.result?.isError, true,
      "a replayed direct session without one exact live conversation page must fail closed");
    assert.match(
      String(replayedDirectPayload?.result?.content?.[0]?.text || ""),
      /conversation identity is unavailable|conversation authority/i,
      "the no-page replay failure must be an explicit identity error, not a timeout or unrelated tool failure",
    );
  }

  const refreshB = await refreshThroughGateway(gatewayBaseUrl, {
    clientId: oauth.clientId,
    refreshToken: refreshA.refresh_token,
  });
  assert.notEqual(refreshB.access_token, refreshA.access_token);

  let peakGatewaySessions = controller.status().sessions.sessions.length;
  let soakHandover = null;
  let toolChurnMemoryBefore = null;
  let toolChurnMemoryImmediate = null;
  let toolChurnMemoryAfterIdle = null;
  const toolChurnWaveMemory = [];
  const sseStreams = [];
  if (sessionChurnCount > 0) {
    if (toolChurnMode) {
      const beforeResponse = await httpRequestBuffer(gatewayBaseUrl, "/__devspace/memory/status");
      assert.equal(beforeResponse.status, 200, `memory status before tool churn failed with HTTP ${beforeResponse.status}`);
      toolChurnMemoryBefore = jsonBody(beforeResponse);
    }
    const totalChurnCount = sessionChurnCount * toolChurnWaves;
    for (let index = 0; index < totalChurnCount; index += 1) {
      const churn = await postMcp(gatewayBaseUrl, {
        jsonrpc: "2.0",
        id: 10_000 + index,
        method: "initialize",
        params: {
          protocolVersion: protocolVersion || "2025-11-25",
          capabilities: {},
          clientInfo: { name: `stable-gateway-session-churn-${index}`, version: "0.5.0" },
        },
      }, { accessToken: refreshB.access_token });
      assert.equal(churn.status, 200, `session churn initialize ${index} failed with HTTP ${churn.status}`);
      const churnSessionId = String(churn.headers["mcp-session-id"] || "");
      assert.match(churnSessionId, /^[0-9a-f-]{36}$/i, `session churn ${index} did not return a public session id`);
      const churnPayload = parseMcpBody(churn);
      const churnProtocolVersion = churnPayload?.result?.protocolVersion || protocolVersion || "2025-11-25";
      if (toolChurnMode) {
        const ready = await postMcp(gatewayBaseUrl, {
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        }, {
          accessToken: refreshB.access_token,
          sessionId: churnSessionId,
          protocolVersion: churnProtocolVersion,
        });
        assert.equal(ready.status >= 200 && ready.status < 300, true, `session churn initialized ${index} failed with HTTP ${ready.status}`);
        const toolCall = await postMcp(gatewayBaseUrl, {
          jsonrpc: "2.0",
          id: 20_000 + index,
          method: "tools/call",
          params: workspaceChurnMode
            ? {
                name: "open_workspace",
                arguments: { path: packageRoot, mode: "checkout" },
              }
            : {
                name: "conversation_compact_status",
                arguments: {},
              },
        }, {
          accessToken: refreshB.access_token,
          sessionId: churnSessionId,
          protocolVersion: churnProtocolVersion,
        });
        assert.equal(toolCall.status, 200, `session churn tools/call ${index} failed with HTTP ${toolCall.status}`);
        const toolPayload = parseMcpBody(toolCall);
        assert.equal(toolPayload?.result?.isError === true, false, `session churn tools/call ${index} returned tool error`);
        if (workspaceChurnMode) {
          const workspaceId = String(toolPayload?.result?.structuredContent?.workspaceId || "");
          assert.match(workspaceId, /^ws_/, `workspace churn ${index} did not return workspaceId`);
          const readCall = await postMcp(gatewayBaseUrl, {
            jsonrpc: "2.0",
            id: 30_000 + index,
            method: "tools/call",
            params: {
              name: "read",
              arguments: { workspaceId, path: "dist/server.js", offset: 1, limit: 1200 },
            },
          }, {
            accessToken: refreshB.access_token,
            sessionId: churnSessionId,
            protocolVersion: churnProtocolVersion,
          });
          assert.equal(readCall.status, 200, `workspace churn read ${index} failed with HTTP ${readCall.status}`);
          const readPayload = parseMcpBody(readCall);
          assert.equal(readPayload?.result?.isError === true, false, `workspace churn read ${index} returned tool error`);
        }
        if (sseChurnMode) {
          const stream = openMcpEventStream(gatewayBaseUrl, {
            accessToken: refreshB.access_token,
            sessionId: churnSessionId,
            protocolVersion: churnProtocolVersion,
          });
          void stream.opened.catch(() => {});
          sseStreams.push(stream);
          const activeDeadline = Date.now() + 5_000;
          let activeObserved = 0;
          let maxEventStreams = 64;
          while (Date.now() < activeDeadline) {
            const activeResponse = await httpRequestBuffer(gatewayBaseUrl, "/__devspace/memory/status");
            if (activeResponse.status === 200) {
              const activePayload = jsonBody(activeResponse);
              activeObserved = Number(activePayload?.registries?.mcpActiveRequests || 0);
              maxEventStreams = Number(activePayload?.registries?.mcpMaxEventStreams || maxEventStreams);
              const expectedActive = Math.min(sseStreams.length, maxEventStreams);
              if (activeObserved >= expectedActive && activeObserved <= maxEventStreams) break;
            }
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
          }
          const expectedActive = Math.min(sseStreams.length, maxEventStreams);
          assert.equal(activeObserved >= expectedActive, true, `SSE churn ${index} did not retain the bounded active stream set; observed ${activeObserved}, expected ${expectedActive}`);
          assert.equal(activeObserved <= maxEventStreams, true, `SSE churn ${index} exceeded the Core event-stream hard cap: ${activeObserved} > ${maxEventStreams}`);
        }
      }
      peakGatewaySessions = Math.max(peakGatewaySessions, controller.status().sessions.sessions.length);
      if ((index + 1) % 8 === 0) {
        const checkpointHealth = await httpRequestBuffer(gatewayBaseUrl, "/healthz");
        assert.equal(checkpointHealth.status, 200, `Core health failed during session churn at ${index + 1}`);
        assert.equal(jsonBody(checkpointHealth)?.ok, true);
      }
      if (toolChurnMode && (index + 1) % sessionChurnCount === 0) {
        const wave = Math.floor(index / sessionChurnCount) + 1;
        const immediateResponse = await httpRequestBuffer(gatewayBaseUrl, "/__devspace/memory/status");
        assert.equal(immediateResponse.status, 200);
        toolChurnMemoryImmediate = jsonBody(immediateResponse);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, toolChurnIdleMs));
        const afterIdleResponse = await httpRequestBuffer(gatewayBaseUrl, passiveDiagnosticGcRequested
          ? "/__devspace/memory/status?gc=1"
          : "/__devspace/memory/status");
        assert.equal(afterIdleResponse.status, 200);
        toolChurnMemoryAfterIdle = jsonBody(afterIdleResponse);
        if (passiveDiagnosticGcRequested) {
          assert.equal(toolChurnMemoryAfterIdle?.diagnosticGc?.performed, true, "passive canary did not perform the requested retained-heap GC sample");
        }
        toolChurnWaveMemory.push({
          wave,
          immediateHeapUsed: Number(toolChurnMemoryImmediate?.memory?.heapUsed || 0),
          afterIdleHeapUsed: Number(toolChurnMemoryAfterIdle?.memory?.heapUsed || 0),
          afterIdleMcpSessions: Number(toolChurnMemoryAfterIdle?.registries?.mcpSessions || 0),
          afterIdleMcpActiveRequests: Number(toolChurnMemoryAfterIdle?.registries?.mcpActiveRequests || 0),
          afterIdleMcpEventStreams: Number(toolChurnMemoryAfterIdle?.registries?.mcpEventStreams || 0),
          afterIdleOldestActivityAgeMs: Number(toolChurnMemoryAfterIdle?.registries?.mcpOldestActivityAgeMs || 0),
          afterIdleNewestActivityAgeMs: Number(toolChurnMemoryAfterIdle?.registries?.mcpNewestActivityAgeMs || 0),
          afterIdleWorkspaceContexts: Number(toolChurnMemoryAfterIdle?.registries?.workspaceContexts || 0),
          passiveDiagnosticGcPerformed: toolChurnMemoryAfterIdle?.diagnosticGc?.performed === true,
        });
        if (!sseChurnMode) {
          assert.equal(Number(toolChurnMemoryAfterIdle?.registries?.mcpSessions || 0) <= 1, true, `Core MCP sessions did not drain after idle cleanup: ${toolChurnMemoryAfterIdle?.registries?.mcpSessions}`);
        }
        if (workspaceChurnMode) {
          assert.equal(Number(toolChurnMemoryAfterIdle?.registries?.workspaceContexts || 0) <= 32, true, `Workspace context LRU exceeded hard bound: ${toolChurnMemoryAfterIdle?.registries?.workspaceContexts}`);
        }
        assert.equal(Number(toolChurnMemoryAfterIdle?.memory?.heapUsed || 0) < 480 * 1024 * 1024, true, `Core heap remained unexpectedly high after tool churn cleanup: ${toolChurnMemoryAfterIdle?.memory?.heapUsed}`);
      }
    }
    assert.equal(peakGatewaySessions <= 256, true, `Gateway lightweight public descriptor retention exceeded hard bound: ${peakGatewaySessions}`);
    const soakHandoverResponse = await httpRequestBuffer(gatewayBaseUrl, "/__devspace/gateway/handover", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-devspace-gateway-control": controlToken,
      },
      body: "{}",
    });
    soakHandover = jsonBody(soakHandoverResponse);
    assert.equal(soakHandoverResponse.status, 200, `post-churn handover failed: ${soakHandover?.state || soakHandoverResponse.status}`);
    assert.equal(soakHandover?.ok, true);
    assert.equal(Number(soakHandover?.replayedSessions || 0) <= 16, true, `replayed session count exceeded hard bound: ${soakHandover?.replayedSessions}`);
    const finalHealth = await httpRequestBuffer(gatewayBaseUrl, "/healthz");
    assert.equal(finalHealth.status, 200);
    assert.equal(jsonBody(finalHealth)?.ok, true);
  }

  const productionAfter = await productionPortSnapshot();
  const productionPortsUnchanged = JSON.stringify(productionAfter) === JSON.stringify(productionBefore);
  assert.equal(productionPortsUnchanged, true);

  console.log(JSON.stringify({
    ok: true,
    gate: "stable-gateway-real-core-canary",
    realCore: true,
    passiveCore: true,
    pluginsDisabled: true,
    backgroundProfile: [...backgroundProfile].sort(),
    gatewayPortStable: runtime.gatewayPort === gatewayPortBefore,
    publicSessionStable: toolsAfter.headers["mcp-session-id"] === publicSessionId,
    replayedMain01DirectTool: replayPageAvailable,
    replayedDirectSessionFailClosedWithoutPage: !replayPageAvailable,
    oauthRefreshBeforeHandover: true,
    oauthRefreshAfterHandover: true,
    refreshTokenRotatedTwice: true,
    toolCountBefore,
    toolCountAfter,
    ultraToolSurface: true,
    powermemCapabilityOnline: backgroundPlugins,
    activeSlot: soakHandover?.activeSlot || handoverPayload.activeSlot,
    soakMode,
    toolChurnMode,
    workspaceChurnMode,
    sseChurnMode,
    childHeapLimitMb: soakMode ? 1024 : null,
    sessionChurnCount,
    peakGatewaySessions,
    toolChurnWaves,
    toolChurnIdleMs,
    toolChurnMemory: toolChurnMode ? {
      beforeHeapUsed: Number(toolChurnMemoryBefore?.memory?.heapUsed || 0),
      immediateHeapUsed: Number(toolChurnMemoryImmediate?.memory?.heapUsed || 0),
      afterIdleHeapUsed: Number(toolChurnMemoryAfterIdle?.memory?.heapUsed || 0),
      afterIdleMcpSessions: Number(toolChurnMemoryAfterIdle?.registries?.mcpSessions || 0),
      afterIdleMcpActiveRequests: Number(toolChurnMemoryAfterIdle?.registries?.mcpActiveRequests || 0),
      afterIdleMcpEventStreams: Number(toolChurnMemoryAfterIdle?.registries?.mcpEventStreams || 0),
      afterIdleOldestActivityAgeMs: Number(toolChurnMemoryAfterIdle?.registries?.mcpOldestActivityAgeMs || 0),
      afterIdleNewestActivityAgeMs: Number(toolChurnMemoryAfterIdle?.registries?.mcpNewestActivityAgeMs || 0),
      afterIdleWorkspaceContexts: Number(toolChurnMemoryAfterIdle?.registries?.workspaceContexts || 0),
      waves: toolChurnWaveMemory,
      passiveDiagnosticGcRequested,
    } : null,
    sseStreamsOpened: sseStreams.length,
    soakReplayBounded: sessionChurnCount > 0 ? Number(soakHandover?.replayedSessions || 0) <= 16 : null,
    productionPortsUnchanged,
    secretValuesLogged: false,
  }));
} finally {
  if (runtime) await runtime.close().catch(() => {});
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}
