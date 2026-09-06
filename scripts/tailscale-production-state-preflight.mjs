#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { loadConfig } from "../dist/config.js";
import { GoalRuntime } from "../dist/goal-runtime.js";
import { PlanRuntime } from "../dist/plan-runtime.js";
import { SingleUserOAuthProvider } from "../dist/oauth-provider.js";
import { loadDevspaceFiles, writeDevspaceAuth, writeDevspaceConfig } from "../dist/user-config.js";
import { createCandidateSnapshot, startCoreSlot, stopCoreSlot } from "./devspace-core-slot.mjs";

const GOAL_ID = "goal_deac9fadb6bc67dd";
const PLAN_ID = "plan_dfc1ea0e2b285119";
const PUBLIC_BASE = "https://devspace-gateway.tail18e977.ts.net";
const BOOTSTRAP_STATE = process.env.DEVSPACE_TAILSCALE_STATE_DIR || join(homedir(), ".local", "share", "devspace-tailscale-bootstrap");
const LEGACY_STATE = process.env.DEVSPACE_LEGACY_STATE_DIR || join(homedir(), ".local", "share", "devspace-fixed-candidate");
const SOURCE_CONFIG_DIR = process.env.DEVSPACE_CANARY_SOURCE_CONFIG_DIR || join(homedir(), ".devspace");
const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

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

function oauthCounts(stateDir) {
  const db = new Database(join(stateDir, "devspace.sqlite"), { readonly: true, fileMustExist: true });
  try {
    const count = (table) => db.prepare(`select count(*) as n from ${table}`).get().n;
    return {
      clients: count("oauth_clients"),
      accessTokens: count("oauth_access_tokens"),
      refreshTokens: count("oauth_refresh_tokens"),
      workspaceSessions: count("workspace_sessions"),
    };
  } finally {
    db.close();
  }
}

function fakeAuthorizeResponse(ownerToken) {
  return {
    req: { method: "POST", body: { owner_token: ownerToken } },
    statusCode: 200,
    redirectLocation: null,
    status(code) { this.statusCode = code; return this; },
    setHeader() { return this; },
    send() { return this; },
    redirect(code, location) { this.statusCode = code; this.redirectLocation = location; return this; },
  };
}

async function mintStagingToken({ configEnv, stateDir, ownerToken }) {
  const loaded = loadConfig(configEnv);
  const resource = new URL(`${PUBLIC_BASE}/mcp`);
  const provider = new SingleUserOAuthProvider(loaded.oauth, resource, stateDir);
  try {
    const client = provider.clientsStore.registerClient({
      client_name: "Tailscale production state preflight",
      redirect_uris: ["http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    const response = fakeAuthorizeResponse(ownerToken);
    await provider.authorize(client, {
      resource,
      scopes: ["devspace", "offline_access"],
      redirectUri: "http://127.0.0.1/callback",
      codeChallenge: "tailscale-production-state-preflight",
      state: "preflight",
    }, response);
    assert.equal(response.statusCode, 302);
    const code = new URL(response.redirectLocation).searchParams.get("code");
    const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, "http://127.0.0.1/callback", resource);
    return tokens.access_token;
  } finally {
    provider.close();
  }
}

function requestJson(baseUrl, body, { accessToken, sessionId, protocolVersion } = {}) {
  const target = new URL("/mcp", baseUrl);
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "content-length": String(payload.length),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.once("end", () => resolvePromise({
        status: res.statusCode ?? 0,
        headers: res.headers,
        text: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.once("error", rejectPromise);
    req.end(payload);
  });
}

function parseMcp(text) {
  const raw = String(text || "").trim();
  try { return JSON.parse(raw); } catch {}
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try { return JSON.parse(data); } catch {}
  }
  return null;
}

async function copyStateJson(name, stagingDir) {
  const source = join(LEGACY_STATE, name);
  if (!existsSync(source)) return false;
  await copyFile(source, join(stagingDir, name));
  return true;
}

if (!existsSync(join(BOOTSTRAP_STATE, "devspace.sqlite"))) throw new Error("Tailscale bootstrap SQLite state is missing.");
if (!existsSync(join(LEGACY_STATE, "goal-state.json")) || !existsSync(join(LEGACY_STATE, "plan-state.json"))) {
  throw new Error("Legacy Goal/Plan state is missing.");
}
const sourceFiles = loadDevspaceFiles({ ...process.env, DEVSPACE_CONFIG_DIR: SOURCE_CONFIG_DIR });
if (!sourceFiles.auth?.ownerToken) throw new Error("Canonical DevSpace owner auth is unavailable.");

const bootstrapCounts = oauthCounts(BOOTSTRAP_STATE);
const snapshot = await createCandidateSnapshot({ sourceStateDir: BOOTSTRAP_STATE });
let coreHandle = null;
const tempConfigRoot = await mkdtemp(join(tmpdir(), "devspace-tailscale-preflight-config-"));
try {
  await copyStateJson("goal-state.json", snapshot.stateDir);
  await copyStateJson("plan-state.json", snapshot.stateDir);
  const overlayOwnerCopied = await copyStateJson("classic-host-overlay-owner.json", snapshot.stateDir);
  const stagingCountsBeforeTestClient = oauthCounts(snapshot.stateDir);
  assert.deepEqual(stagingCountsBeforeTestClient, bootstrapCounts, "bootstrap SQLite must be preserved exactly in the staging snapshot before test-only OAuth mutation");

  const goalRuntime = new GoalRuntime({ stateDir: snapshot.stateDir });
  const planRuntime = new PlanRuntime({ stateDir: snapshot.stateDir });
  const goal = await goalRuntime.status(GOAL_ID);
  const plan = await planRuntime.status(PLAN_ID);
  await Promise.all([goalRuntime.close(), planRuntime.close()]);

  assert.equal(goal.status, "paused");
  assert.equal(goal.round, 3);
  assert.equal(goal.roundState, "working");
  assert.equal(goal.revision, 31);
  assert.equal(goal.continuation?.state, "idle");
  assert.equal(plan.revision, 12);
  assert.equal(plan.steps.length, 10);
  assert.equal(plan.steps[9].status, "in_progress");
  assert.equal(plan.steps.slice(0, 9).every((step) => step.status === "completed"), true);

  const configDir = join(tempConfigRoot, "config");
  await mkdir(configDir, { recursive: true });
  const canaryEnv = {
    ...process.env,
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_STATE_DIR: snapshot.stateDir,
    DEVSPACE_PUBLIC_BASE_URL: PUBLIC_BASE,
    DEVSPACE_ALLOWED_ROOTS: packageRoot,
    DEVSPACE_OAUTH_SCOPES: "devspace,offline_access",
    DEVSPACE_PASSIVE_CORE: "true",
    DEVSPACE_CONTEXT_GUARDIAN: "false",
    DEVSPACE_CLASSIC_HOST_OVERLAY: "false",
    DEVSPACE_CLASSIC_STREAM_RECOVERY: "false",
    DEVSPACE_AUTO_COMPACT: "false",
    DEVSPACE_PLUGINS: "false",
    DEVSPACE_SKILLS: "false",
    DEVSPACE_SUBAGENTS: "false",
    DEVSPACE_ARTIFACTS: "false",
    DEVSPACE_LOG_REQUESTS: "false",
    DEVSPACE_LOG_TOOL_CALLS: "false",
  };
  writeDevspaceConfig({ stateDir: snapshot.stateDir, publicBaseUrl: PUBLIC_BASE, allowedRoots: [packageRoot], pluginsEnabled: false }, canaryEnv);
  writeDevspaceAuth({ ownerToken: sourceFiles.auth.ownerToken }, canaryEnv);
  const accessToken = await mintStagingToken({ configEnv: canaryEnv, stateDir: snapshot.stateDir, ownerToken: sourceFiles.auth.ownerToken });
  const corePort = await freePort();
  coreHandle = await startCoreSlot({
    id: "tailscale-production-state-preflight",
    port: corePort,
    configDir,
    stateDir: snapshot.stateDir,
    publicBaseUrl: PUBLIC_BASE,
    candidate: true,
    baseEnv: canaryEnv,
    runtimeEnvOverrides: {
      DEVSPACE_PASSIVE_CORE: canaryEnv.DEVSPACE_PASSIVE_CORE,
      DEVSPACE_CONTEXT_GUARDIAN: canaryEnv.DEVSPACE_CONTEXT_GUARDIAN,
      DEVSPACE_CLASSIC_HOST_OVERLAY: canaryEnv.DEVSPACE_CLASSIC_HOST_OVERLAY,
      DEVSPACE_CLASSIC_STREAM_RECOVERY: canaryEnv.DEVSPACE_CLASSIC_STREAM_RECOVERY,
      DEVSPACE_AUTO_COMPACT: canaryEnv.DEVSPACE_AUTO_COMPACT,
      DEVSPACE_PLUGINS: canaryEnv.DEVSPACE_PLUGINS,
      DEVSPACE_SKILLS: canaryEnv.DEVSPACE_SKILLS,
      DEVSPACE_SUBAGENTS: canaryEnv.DEVSPACE_SUBAGENTS,
      DEVSPACE_ARTIFACTS: canaryEnv.DEVSPACE_ARTIFACTS,
    },
  });

  const initialize = await requestJson(coreHandle.baseUrl, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "tailscale-state-preflight", version: "0.5.0" } },
  }, { accessToken });
  assert.equal(initialize.status, 200);
  const initializedPayload = parseMcp(initialize.text);
  const protocolVersion = initializedPayload?.result?.protocolVersion;
  const backendSessionId = String(initialize.headers["mcp-session-id"] || "");
  assert.equal(typeof protocolVersion, "string");
  assert.ok(backendSessionId);

  const initialized = await requestJson(coreHandle.baseUrl, {
    jsonrpc: "2.0", method: "notifications/initialized", params: {},
  }, { accessToken, sessionId: backendSessionId, protocolVersion });
  assert.equal(initialized.status >= 200 && initialized.status < 300, true);

  const goalResponse = await requestJson(coreHandle.baseUrl, {
    jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "devspace_goal_status", arguments: { goalId: GOAL_ID } },
  }, { accessToken, sessionId: backendSessionId, protocolVersion });
  const planResponse = await requestJson(coreHandle.baseUrl, {
    jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "devspace_plan_status", arguments: { planId: PLAN_ID } },
  }, { accessToken, sessionId: backendSessionId, protocolVersion });
  assert.equal(goalResponse.status, 200);
  assert.equal(planResponse.status, 200);
  const goalTool = parseMcp(goalResponse.text)?.result?.structuredContent?.goal;
  const planTool = parseMcp(planResponse.text)?.result?.structuredContent?.plan;
  assert.equal(goalTool?.id, GOAL_ID);
  assert.equal(goalTool?.status, "paused");
  assert.equal(goalTool?.round, 3);
  assert.equal(goalTool?.revision, 31);
  assert.equal(planTool?.id, PLAN_ID);
  assert.equal(planTool?.revision, 12);
  assert.equal(planTool?.steps?.[9]?.status, "in_progress");

  console.log(JSON.stringify({
    ok: true,
    gate: "tailscale-production-state-preflight",
    bootstrapOauthPreservedInSnapshot: true,
    bootstrapOauthClients: bootstrapCounts.clients,
    bootstrapRefreshTokens: bootstrapCounts.refreshTokens,
    bootstrapWorkspaceSessions: bootstrapCounts.workspaceSessions,
    goalFound: true,
    goalStatus: goalTool.status,
    goalRound: goalTool.round,
    goalRevision: goalTool.revision,
    goalContinuationState: goal.continuation.state,
    planFound: true,
    planRevision: planTool.revision,
    planStep10: planTool.steps[9].status,
    overlayOwnerCopied,
    realPassiveCoreToolRead: true,
    productionStateModified: false,
    secretValuesLogged: false,
  }));
} finally {
  if (coreHandle) await stopCoreSlot(coreHandle).catch(() => {});
  await snapshot.cleanup().catch(() => {});
  await rm(tempConfigRoot, { recursive: true, force: true }).catch(() => {});
}
