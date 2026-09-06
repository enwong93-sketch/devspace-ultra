#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/config.js";
import { SingleUserOAuthProvider } from "../dist/oauth-provider.js";
import { loadDevspaceFiles, writeDevspaceAuth, writeDevspaceConfig } from "../dist/user-config.js";
import {
  MEMORY_MODE_NAMES,
  TOTAL_HEAP_LIMIT_MB,
  assertMemorySnapshot,
  memoryModeProfile,
  nodeArgsForTotalHeapLimit,
  parseMcpResponseText,
} from "./core-memory-isolation-lib.mjs";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const mode = String(process.argv[2] || "baseline").toLowerCase();
const durationSeconds = Math.max(20, Math.min(180, Number(process.argv[3] || 30)));
const sessionCount = Math.max(8, Math.min(40, Number(process.env.DEVSPACE_MEMORY_SESSION_COUNT || 32)));
const extraInactiveSessionCount = Math.max(0, Math.min(32, Number(process.env.DEVSPACE_MEMORY_EXTRA_SESSIONS || 16)));
const waveCount = Math.max(1, Math.min(4, Number(process.env.DEVSPACE_MEMORY_WAVES || 2)));
const sampleIntervalMs = 2_000;
const idleSettleMs = Math.max(2_000, Math.min(15_000, Number(process.env.DEVSPACE_MEMORY_IDLE_MS || 5_000)));
const PUBLIC_BASE = "https://memory-isolation.invalid";
const REDIRECT_URI = "http://127.0.0.1/callback";
const profile = memoryModeProfile(mode);

function sleep(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
function appendTail(current, chunk, max = 96_000) {
  const next = current + String(chunk || "");
  return next.length > max ? next.slice(-max) : next;
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

function httpRequestBuffer(baseUrl, path, { method = "GET", headers = {}, body } = {}) {
  const target = new URL(path, baseUrl);
  const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return new Promise((resolvePromise, rejectPromise) => {
    const rejectWithContext = (error) => rejectPromise(new Error(`${method} ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
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
        status: res.statusCode || 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
      res.once("error", rejectWithContext);
    });
    req.once("error", rejectWithContext);
    req.end(payload ?? undefined);
  });
}

function jsonBody(response) {
  try { return response.body ? JSON.parse(response.body) : null; }
  catch { return null; }
}

function parseMcpBody(response, expectedId) {
  return parseMcpResponseText(response.body, {
    contentType: response.headers["content-type"] || "",
    expectedId,
  });
}

async function postMcp(baseUrl, body, { accessToken, sessionId, protocolVersion } = {}) {
  return await httpRequestBuffer(baseUrl, "/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
    },
    body: JSON.stringify(body),
  });
}

function openMcpEventStream(baseUrl, { accessToken, sessionId, protocolVersion }) {
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
        authorization: `Bearer ${accessToken}`,
        "mcp-session-id": sessionId,
        "mcp-protocol-version": protocolVersion,
      },
    }, (res) => {
      responseRef = res;
      if ((res.statusCode || 0) >= 400) openedReject(new Error(`MCP event stream HTTP ${res.statusCode}`));
      else openedResolve({ status: res.statusCode || 0 });
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

async function mintOAuth({ env, stateDir, ownerToken }) {
  const loaded = loadConfig(env);
  const resource = new URL(`${PUBLIC_BASE}/mcp`);
  const provider = new SingleUserOAuthProvider(loaded.oauth, resource, stateDir);
  try {
    const client = provider.clientsStore.registerClient({
      client_name: `Core memory isolation ${mode}`,
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
      codeChallenge: "core-memory-isolation-pkce",
      state: "core-memory-isolation",
    }, response);
    assert.equal(response.statusCode, 302);
    const code = new URL(response.redirectLocation).searchParams.get("code");
    assert.ok(code?.startsWith("code-"));
    const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT_URI, resource);
    return { accessToken: tokens.access_token };
  } finally {
    provider.close();
  }
}

async function waitForHealth(baseUrl, child, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "not-ready";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Isolation Core exited before readiness (code ${child.exitCode}).`);
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1_000), cache: "no-store" });
      if (response.ok && (await response.json())?.ok === true) return;
      last = `health-${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.name : String(error);
    }
    await sleep(150);
  }
  throw new Error(`Isolation Core readiness timed out (${last}).`);
}

async function readMemory(baseUrl) {
  const response = await httpRequestBuffer(baseUrl, "/__devspace/memory/status");
  assert.equal(response.status, 200, `memory status HTTP ${response.status}`);
  const snapshot = jsonBody(response);
  assert.equal(snapshot?.ok, true);
  return { snapshot, normalized: assertMemorySnapshot(snapshot, { targetTotalHeapMb: TOTAL_HEAP_LIMIT_MB }) };
}

async function initializeSession(baseUrl, accessToken, index) {
  const response = await postMcp(baseUrl, {
    jsonrpc: "2.0",
    id: 1_000 + index,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: `core-memory-${mode}-${index}`, version: "0.5.0" },
    },
  }, { accessToken });
  assert.equal(response.status, 200, `initialize ${index} HTTP ${response.status}`);
  const payload = parseMcpBody(response, 1_000 + index);
  const sessionId = String(response.headers["mcp-session-id"] || "");
  const protocolVersion = String(payload?.result?.protocolVersion || "");
  assert.match(sessionId, /^[0-9a-f-]{36}$/i);
  assert.ok(protocolVersion);
  const ready = await postMcp(baseUrl, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  }, { accessToken, sessionId, protocolVersion });
  assert.equal(ready.status >= 200 && ready.status < 300, true);
  return { sessionId, protocolVersion };
}

async function callTool(baseUrl, accessToken, session, id, name, args = {}) {
  const response = await postMcp(baseUrl, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  }, { accessToken, ...session });
  assert.equal(response.status, 200, `${name} HTTP ${response.status}`);
  const payload = parseMcpBody(response, id);
  assert.equal(payload?.result?.isError === true, false, `${name} returned isError`);
  return payload?.result;
}

function assertBoundedIdle(snapshot, { capabilityExpected }) {
  assert.equal(snapshot?.registries?.mcpActiveRequests, 0, "MCP active requests must return to idle");
  assert.equal(snapshot?.registries?.mcpEventStreams, 0, "MCP event streams must return to idle");
  assert.equal(snapshot?.registries?.mcpEventStreamsClosing, 0, "MCP event-stream close queue must drain");
  assert.equal(snapshot?.registries?.mcpSessions <= 32, true, `MCP session tail exceeded 32: ${snapshot?.registries?.mcpSessions}`);
  assert.equal(snapshot?.registries?.processSessions, 0, "completed process sessions must not remain live");
  assert.equal(snapshot?.registries?.workspaceContexts <= 6, true, `workspace cache exceeded its bound: ${snapshot?.registries?.workspaceContexts}`);
  assert.equal(snapshot?.turnTransportCdp?.pending, 0, "turn transport correlation must be idle");
  assert.equal(snapshot?.contextCdp?.pendingCalls, 0, "Context CDP calls must be idle");
  assert.equal(snapshot?.contextCdp?.pendingUsageRequests, 0, "usage evidence requests must be idle");
  assert.equal(snapshot?.contextCdp?.pendingIdentityCorrelations, 0, "identity correlations must be idle");
  assert.equal(snapshot?.streamRecoveryCdp?.pendingCalls, 0, "Stream Recovery CDP calls must be idle");
  assert.equal(snapshot?.streamRecoveryCdp?.trackedRequestUrls, 0, "Stream Recovery URL tracking must be idle");
  assert.equal(snapshot?.capabilities?.mcpConnecting, 0, "capability MCP connection attempts must settle");
  assert.equal(snapshot?.capabilities?.mcpStartupTails, 0, "capability startup tails must settle");
  assert.equal(snapshot?.capabilities?.mcpInstances, 0, "no exclusive capability instance may remain claimed");
  assert.equal(snapshot?.capabilities?.mcpClients <= (capabilityExpected ? 2 : 0), true, `unexpected capability MCP client count: ${snapshot?.capabilities?.mcpClients}`);
}

const tempRoot = await mkdtemp(join(tmpdir(), `devspace-core-memory-${mode}-`));
const configDir = join(tempRoot, "config");
const stateDir = join(tempRoot, "state");
await mkdir(configDir, { recursive: true });
await mkdir(stateDir, { recursive: true });
const port = await freePort();
const isolatedDebugPort = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const ownerToken = randomBytes(32).toString("base64url");
const sourceConfigDir = process.env.DEVSPACE_CANARY_SOURCE_CONFIG_DIR || join(homedir(), ".devspace-tailscale-bootstrap");
const sourceFiles = loadDevspaceFiles({ ...process.env, DEVSPACE_CONFIG_DIR: sourceConfigDir });
const configEnv = {
  ...process.env,
  DEVSPACE_CONFIG_DIR: configDir,
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_PUBLIC_BASE_URL: PUBLIC_BASE,
  DEVSPACE_OAUTH_OWNER_TOKEN: ownerToken,
};
writeDevspaceAuth({ ownerToken }, configEnv);
writeDevspaceConfig({
  stateDir,
  publicBaseUrl: PUBLIC_BASE,
  allowedRoots: [packageRoot],
  allowedHosts: ["localhost", "127.0.0.1", "::1", "memory-isolation.invalid"],
  toolMode: "ultra",
  pluginPaths: Array.isArray(sourceFiles.config?.pluginPaths) ? sourceFiles.config.pluginPaths : [],
  pluginsEnabled: profile.plugins,
  skillsEnabled: profile.skills,
  artifactsEnabled: profile.artifacts,
  subagents: false,
  classicMainDebugPorts: [isolatedDebugPort],
  contextGuardianEnabled: profile.context,
  classicStreamRecoveryEnabled: profile.stream,
  classicHostOverlayEnabled: profile.overlay,
  autoCompactEnabled: false,
}, configEnv);
const oauth = await mintOAuth({ env: configEnv, stateDir, ownerToken });

const env = {
  ...process.env,
  PORT: String(port),
  DEVSPACE_CONFIG_DIR: configDir,
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_PUBLIC_BASE_URL: PUBLIC_BASE,
  DEVSPACE_ALLOWED_HOSTS: "localhost,127.0.0.1,::1,memory-isolation.invalid",
  DEVSPACE_OAUTH_SCOPES: "devspace,offline_access",
  DEVSPACE_PASSIVE_CORE: "true",
  DEVSPACE_CLASSIC_MAIN_DEBUG_PORTS: String(isolatedDebugPort),
  DEVSPACE_CONTEXT_GUARDIAN: profile.context ? "true" : "false",
  DEVSPACE_CLASSIC_STREAM_RECOVERY: profile.stream ? "true" : "false",
  DEVSPACE_CLASSIC_HOST_OVERLAY: profile.overlay ? "true" : "false",
  DEVSPACE_AUTO_COMPACT: "false",
  DEVSPACE_PLUGINS: profile.plugins ? "true" : "false",
  DEVSPACE_SUBAGENTS: "false",
  DEVSPACE_SKILLS: profile.skills ? "true" : "false",
  DEVSPACE_ARTIFACTS: profile.artifacts ? "true" : "false",
  DEVSPACE_TOOL_MODE: "ultra",
  DEVSPACE_LOG_REQUESTS: "false",
  DEVSPACE_LOG_TOOL_CALLS: "false",
};

let stdoutTail = "";
let stderrTail = "";
const child = spawn(process.execPath, [...nodeArgsForTotalHeapLimit(TOTAL_HEAP_LIMIT_MB), "dist/cli.js", "serve"], {
  cwd: packageRoot,
  env,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => { stdoutTail = appendTail(stdoutTail, chunk); });
child.stderr.on("data", (chunk) => { stderrTail = appendTail(stderrTail, chunk); });

const samples = [];
const waves = [];
const allStreams = [];
let currentStage = "spawn";
try {
  currentStage = "wait-for-health";
  await waitForHealth(baseUrl, child);
  const startedAt = Date.now();
  currentStage = "baseline-memory";
  const baseline = await readMemory(baseUrl);
  samples.push({ stage: "baseline", t: 0, ...baseline.normalized, snapshot: baseline.snapshot });
  assert.equal(baseline.snapshot?.features?.passiveCore, true);
  assert.deepEqual(baseline.snapshot?.features?.classicMainDebugPorts, [isolatedDebugPort]);
  assert.equal(baseline.snapshot?.features?.autoCompactEnabled, false);

  let toolSession = null;
  for (let wave = 1; wave <= waveCount; wave += 1) {
    const streams = [];
    currentStage = `wave-${wave}-initialize-streams`;
    let latestSession = null;
    for (let index = 0; index < sessionCount; index += 1) {
      const session = await initializeSession(baseUrl, oauth.accessToken, (wave * 1_000) + index);
      latestSession = session;
      const stream = openMcpEventStream(baseUrl, { accessToken: oauth.accessToken, ...session });
      streams.push(stream);
      allStreams.push(stream);
      await stream.opened.catch((error) => {
        throw new Error(`wave ${wave} SSE open ${index} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      });
    }
    toolSession = latestSession;

    currentStage = `wave-${wave}-active-memory`;
    const active = await readMemory(baseUrl);
    samples.push({ stage: `wave-${wave}-active`, t: Math.round((Date.now() - startedAt) / 1000), ...active.normalized, snapshot: active.snapshot });
    assert.equal(active.snapshot?.registries?.mcpEventStreams <= 40, true, `event-stream cap exceeded: ${active.snapshot?.registries?.mcpEventStreams}`);
    assert.equal(active.snapshot?.registries?.mcpActiveRequests <= 40, true, `active-request cap exceeded: ${active.snapshot?.registries?.mcpActiveRequests}`);

    currentStage = `wave-${wave}-tool-calls`;
    const compactStatus = await callTool(baseUrl, oauth.accessToken, toolSession, 20_000 + wave, "conversation_compact_status", {});
    assert.equal(compactStatus?.structuredContent?.ok, true);
    const openedWorkspace = await callTool(baseUrl, oauth.accessToken, toolSession, 21_000 + wave, "open_workspace", { path: packageRoot, mode: "checkout" });
    const workspaceId = String(openedWorkspace?.structuredContent?.workspaceId || "");
    assert.match(workspaceId, /^ws_/);
    await callTool(baseUrl, oauth.accessToken, toolSession, 22_000 + wave, "read", { workspaceId, path: "package.json", offset: 1, limit: 80 });
    const processResult = await callTool(baseUrl, oauth.accessToken, toolSession, 23_000 + wave, "exec_command", {
      workspaceId,
      cmd: `${JSON.stringify(process.execPath)} -e "process.stdout.write('memory-gate-ok')"`,
      yieldTimeMs: 10_000,
      maxOutputTokens: 100,
    });
    assert.equal(processResult?.structuredContent?.running, false);
    assert.equal(processResult?.structuredContent?.exitCode, 0);

    if (profile.plugins) {
      const capabilityList = await callTool(baseUrl, oauth.accessToken, toolSession, 24_000 + wave, "capability_list", {
        includeDisabled: true,
        probeMcp: false,
      });
      const powerMem = capabilityList?.structuredContent?.plugins?.find?.((plugin) => plugin.id === "powermem-shared");
      assert.equal(powerMem?.enabled, true);
      assert.equal(powerMem?.trusted, true);
      assert.equal(powerMem?.mcpServerIds?.includes?.("powermem"), true);
      const inspected = await callTool(baseUrl, oauth.accessToken, toolSession, 25_000 + wave, "capability_inspect", {
        pluginId: "powermem-shared",
        probeMcp: true,
      });
      assert.equal(inspected?.structuredContent?.plugin?.mcpServers?.some?.((server) => server.id === "powermem" && server.status === "online"), true);
    }

    currentStage = `wave-${wave}-close-streams`;
    for (const stream of streams) stream.close();
    await Promise.race([
      Promise.allSettled(streams.map((stream) => stream.completed)),
      sleep(2_000),
    ]);
    currentStage = `wave-${wave}-inactive-session-cap`;
    for (let extra = 0; extra < extraInactiveSessionCount; extra += 1) {
      await initializeSession(baseUrl, oauth.accessToken, (wave * 100_000) + extra);
    }
    await sleep(idleSettleMs);
    currentStage = `wave-${wave}-idle-memory`;
    const idle = await readMemory(baseUrl);
    samples.push({ stage: `wave-${wave}-idle`, t: Math.round((Date.now() - startedAt) / 1000), ...idle.normalized, snapshot: idle.snapshot });
    assertBoundedIdle(idle.snapshot, { capabilityExpected: profile.plugins });
    waves.push({
      wave,
      active: {
        heapUsedMb: active.normalized.heapUsedMb,
        rssMb: active.normalized.rssMb,
        mcpSessions: active.snapshot.registries.mcpSessions,
        mcpActiveRequests: active.snapshot.registries.mcpActiveRequests,
        mcpEventStreams: active.snapshot.registries.mcpEventStreams,
      },
      idle: {
        heapUsedMb: idle.normalized.heapUsedMb,
        rssMb: idle.normalized.rssMb,
        mcpSessions: idle.snapshot.registries.mcpSessions,
        workspaceContexts: idle.snapshot.registries.workspaceContexts,
        capabilityMcpClients: idle.snapshot.capabilities.mcpClients,
      },
    });
  }

  const minimumEnd = startedAt + (durationSeconds * 1_000);
  while (Date.now() < minimumEnd) {
    await sleep(Math.min(sampleIntervalMs, minimumEnd - Date.now()));
    if (child.exitCode !== null) throw new Error(`Isolation Core exited during soak (code ${child.exitCode}).\n${stderrTail}`);
    const sample = await readMemory(baseUrl);
    samples.push({ stage: "soak", t: Math.round((Date.now() - startedAt) / 1000), ...sample.normalized, snapshot: sample.snapshot });
  }

  currentStage = "final-memory";
  const final = await readMemory(baseUrl);
  assertBoundedIdle(final.snapshot, { capabilityExpected: profile.plugins });
  const idleSamples = samples.filter((sample) => /idle$/.test(sample.stage));
  const firstIdle = idleSamples[0];
  const lastIdle = idleSamples.at(-1);
  const retainedHeapGrowthMb = firstIdle && lastIdle ? Math.round((lastIdle.heapUsedMb - firstIdle.heapUsedMb) * 10) / 10 : 0;
  const retainedRssGrowthMb = firstIdle && lastIdle ? Math.round((lastIdle.rssMb - firstIdle.rssMb) * 10) / 10 : 0;
  assert.equal(final.normalized.heapUsedMb < 460, true, `final heap remains too close to the 512 MiB limit: ${final.normalized.heapUsedMb} MiB`);
  assert.equal(retainedHeapGrowthMb <= 96, true, `retained heap grew by ${retainedHeapGrowthMb} MiB across waves`);

  currentStage = "report";
  console.log(JSON.stringify({
    ok: child.exitCode === null,
    gate: "core-memory-isolation",
    mode,
    profile,
    durationSeconds,
    targetTotalHeapMb: TOTAL_HEAP_LIMIT_MB,
    actualHeapSizeLimitMb: final.normalized.heapSizeLimitMb,
    nodeArgs: nodeArgsForTotalHeapLimit(TOTAL_HEAP_LIMIT_MB),
    isolatedClassicDebugPorts: [isolatedDebugPort],
    productionClassicPortsTouched: false,
    autoCompactEnabled: false,
    sessionCount,
    extraInactiveSessionCount,
    waveCount,
    waves,
    final: {
      heapUsedMb: final.normalized.heapUsedMb,
      heapTotalMb: final.normalized.heapTotalMb,
      rssMb: final.normalized.rssMb,
      mcpSessions: final.snapshot.registries.mcpSessions,
      mcpActiveRequests: final.snapshot.registries.mcpActiveRequests,
      mcpEventStreams: final.snapshot.registries.mcpEventStreams,
      processSessions: final.snapshot.registries.processSessions,
      workspaceContexts: final.snapshot.registries.workspaceContexts,
      capabilityMcpClients: final.snapshot.capabilities.mcpClients,
      turnTransportConnected: final.snapshot.turnTransportCdp.connected,
      contextConnected: final.snapshot.contextCdp.connected,
      streamConnected: final.snapshot.streamRecoveryCdp.connected,
    },
    retained: {
      heapGrowthMb: retainedHeapGrowthMb,
      rssGrowthMb: retainedRssGrowthMb,
    },
    maxObserved: {
      heapUsedMb: Math.max(...samples.map((sample) => sample.heapUsedMb)),
      rssMb: Math.max(...samples.map((sample) => sample.rssMb)),
      mcpSessions: Math.max(...samples.map((sample) => Number(sample.snapshot?.registries?.mcpSessions || 0))),
      mcpActiveRequests: Math.max(...samples.map((sample) => Number(sample.snapshot?.registries?.mcpActiveRequests || 0))),
      mcpEventStreams: Math.max(...samples.map((sample) => Number(sample.snapshot?.registries?.mcpEventStreams || 0))),
      capabilityMcpClients: Math.max(...samples.map((sample) => Number(sample.snapshot?.capabilities?.mcpClients || 0))),
    },
  }));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    gate: "core-memory-isolation",
    mode,
    stage: currentStage,
    childExitCode: child.exitCode,
    error: error instanceof Error ? error.message : String(error),
    stdoutTail: stdoutTail.slice(-12_000),
    stderrTail: stderrTail.slice(-24_000),
  }));
  throw error;
} finally {
  for (const stream of allStreams) stream.close();
  try { child.kill("SIGTERM"); } catch {}
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    sleep(3_000),
  ]).catch(() => {});
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}
