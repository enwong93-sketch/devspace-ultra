import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  CodexSandboxRuntime,
  buildCodexSandboxConfig,
  registerCodexSandboxTools,
} from "./codex-sandbox.js";

function fakeServer(elicitInput) {
  const tools = new Map();
  return {
    tools,
    server: { elicitInput },
    registerTool(name, definition, handler) {
      tools.set(name, { definition, handler });
    },
  };
}

const root = await mkdtemp(join(tmpdir(), "devspace-codex-sandbox-unit-"));
const stateDir = join(root, "state");
const workspaceRoot = join(root, "workspace");
const extraRoot = join(root, "extra");
const outsideRoot = await mkdtemp(join(tmpdir(), "devspace-codex-sandbox-outside-"));
await mkdir(stateDir, { recursive: true });
await mkdir(workspaceRoot, { recursive: true });
await mkdir(join(workspaceRoot, ".git"), { recursive: true });
await mkdir(extraRoot, { recursive: true });
const launcher = join(root, "codex-launcher.js");
await writeFile(launcher, "// fixture launcher\n", "utf8");

try {
  const config = parseToml(buildCodexSandboxConfig({
    workspaceRoot,
    network: true,
    readPaths: [join(extraRoot, "read")],
    writePaths: [join(extraRoot, "write")],
  }));
  assert.equal(config.approval_policy, "never");
  assert.equal(config.default_permissions, "devspace");
  assert.equal(config.permissions.devspace.extends, ":workspace");
  assert.equal(config.permissions.devspace.filesystem[":workspace_roots"]["."], "write");
  assert.equal(config.permissions.devspace.filesystem[":workspace_roots"][".git"], "write");
  assert.equal(config.permissions.devspace.network.enabled, true);
  assert.equal(config.permissions.devspace.network.mode, "full");

  let clock = 1_000;
  const runtime = new CodexSandboxRuntime({
    stateDir,
    allowedRoots: [root],
    codexLauncher: launcher,
    now: () => clock,
    ttlMs: 60_000,
  });
  assert.equal(runtime.status().available, true);
  assert.equal(runtime.status().readIsolationClaimed, process.platform !== "win32");
  const workspace = { id: "ws_test", root: workspaceRoot };
  const normalized = await runtime.normalizeRequest({
    workspace,
    workspaceId: "ws_test",
    command: "echo hello",
    reason: "Need one extra write root",
    network: true,
    fileSystem: { read: [extraRoot], write: [extraRoot] },
    sessionKey: "session-a",
  });
  assert.deepEqual(normalized.readPaths, [], "write access subsumes duplicate read access");
  assert.deepEqual(normalized.writePaths, [extraRoot]);
  await assert.rejects(
    () => runtime.normalizeRequest({
      workspace,
      workspaceId: "ws_test",
      command: "echo blocked",
      reason: "outside",
      fileSystem: { read: [outsideRoot], write: [] },
      sessionKey: "session-a",
    }),
    /outside DevSpace allowed roots/,
  );

  const pending = runtime.savePending(normalized);
  assert.equal(runtime.status().pendingRequests, 1);
  assert.throws(
    () => runtime.approvePending({ requestKey: pending.requestKey, sessionKey: "session-b", expectedRequest: normalized }),
    /another MCP session/,
  );
  const approved = runtime.approvePending({ requestKey: pending.requestKey, sessionKey: "session-a", expectedRequest: normalized });
  assert.match(approved.grantToken, /^grant_/);
  assert.equal(runtime.status().activeGrants, 1);
  const prepared = await runtime.prepareExecution({
    workspace,
    workspaceId: "ws_test",
    command: "echo hello",
    grantToken: approved.grantToken,
    sessionKey: "session-a",
  });
  assert.equal(prepared.executable, process.execPath);
  assert.equal(prepared.args[0], launcher);
  assert.equal(prepared.args.includes("sandbox"), true);
  assert.equal(prepared.environment.DEVSPACE_SANDBOX_NETWORK, "1");
  const generated = parseToml(await readFile(join(prepared.environment.CODEX_HOME, "config.toml"), "utf8"));
  assert.equal(generated.permissions.devspace.filesystem[extraRoot], "write");
  assert.equal(generated.permissions.devspace.network.enabled, true);
  await prepared.onDispose();
  assert.equal(existsSync(prepared.environment.CODEX_HOME), false);
  assert.throws(
    () => runtime.consumeGrant({ token: approved.grantToken, sessionKey: "session-a", workspaceId: "ws_test", command: "echo hello" }),
    /already used|missing/,
  );

  const expiring = runtime.savePending({ ...normalized, command: "echo expire" });
  clock += 61_000;
  assert.throws(
    () => runtime.approvePending({ requestKey: expiring.requestKey, sessionKey: "session-a" }),
    /expired/,
  );

  const workspaces = {
    getWorkspace(id) {
      assert.equal(id, "ws_test");
      return workspace;
    },
  };
  const processCalls = [];
  const processSessions = {
    async start(input) {
      processCalls.push({
        ...input,
        parsedConfig: parseToml(await readFile(join(input.environment.CODEX_HOME, "config.toml"), "utf8")),
      });
      await input.onDispose();
      return {
        sessionId: 41,
        output: "sandbox-ok",
        outputTruncated: false,
        running: false,
        exitCode: 0,
        signal: null,
        wallTimeMs: 12,
      };
    },
  };
  const acceptedServer = fakeServer(async () => ({ action: "accept", content: { decision: "Approve once" } }));
  registerCodexSandboxTools(acceptedServer, { runtime, workspaces, processSessions });
  for (const name of ["codex_sandbox_status", "request_permissions", "exec_sandboxed"]) {
    assert.ok(acceptedServer.tools.has(name), `missing ${name}`);
  }
  const noGrant = await acceptedServer.tools.get("request_permissions").handler({
    workspaceId: "ws_test",
    cmd: "echo base",
    reason: "base only",
    network: false,
    fileSystem: { read: [], write: [] },
    userApproved: false,
  }, { sessionId: "session-c" });
  assert.equal(noGrant.structuredContent.grantRequired, false);

  const elicited = await acceptedServer.tools.get("request_permissions").handler({
    workspaceId: "ws_test",
    cmd: "echo elevated",
    reason: "Need extra write",
    network: true,
    fileSystem: { read: [], write: [extraRoot] },
    userApproved: false,
  }, { sessionId: "session-c" });
  assert.equal(elicited.structuredContent.approvalRequired, false);
  assert.match(elicited.structuredContent.grantToken, /^grant_/);
  const executed = await acceptedServer.tools.get("exec_sandboxed").handler({
    workspaceId: "ws_test",
    cmd: "echo elevated",
    grantToken: elicited.structuredContent.grantToken,
    tty: false,
  }, { sessionId: "session-c" });
  assert.equal(executed.structuredContent.ok, true);
  assert.equal(executed.structuredContent.sandboxed, true);
  assert.equal(executed.structuredContent.output, "sandbox-ok");
  assert.equal(processCalls[0].parsedConfig.permissions.devspace.network.enabled, true);
  assert.equal(processCalls[0].parsedConfig.permissions.devspace.filesystem[extraRoot], "write");
  const reused = await acceptedServer.tools.get("exec_sandboxed").handler({
    workspaceId: "ws_test",
    cmd: "echo elevated",
    grantToken: elicited.structuredContent.grantToken,
    tty: false,
  }, { sessionId: "session-c" });
  assert.equal(reused.isError, true);

  const unsupportedServer = fakeServer(async () => { throw new Error("Client does not support form elicitation."); });
  registerCodexSandboxTools(unsupportedServer, { runtime, workspaces, processSessions });
  const pendingFallback = await unsupportedServer.tools.get("request_permissions").handler({
    workspaceId: "ws_test",
    cmd: "echo fallback",
    reason: "Need extra write",
    network: false,
    fileSystem: { read: [], write: [extraRoot] },
    userApproved: false,
  }, { sessionId: "session-d" });
  assert.equal(pendingFallback.structuredContent.supported, false);
  assert.equal(pendingFallback.structuredContent.approvalRequired, true);
  const changed = await unsupportedServer.tools.get("request_permissions").handler({
    workspaceId: "ws_test",
    cmd: "echo changed",
    reason: "Need extra write",
    network: false,
    fileSystem: { read: [], write: [extraRoot] },
    requestKey: pendingFallback.structuredContent.requestKey,
    userApproved: true,
  }, { sessionId: "session-d" });
  assert.equal(changed.isError, true);
  assert.match(changed.structuredContent.error, /changed after approval/);
  const approvedFallback = await unsupportedServer.tools.get("request_permissions").handler({
    workspaceId: "ws_test",
    cmd: "echo fallback",
    reason: "Need extra write",
    network: false,
    fileSystem: { read: [], write: [extraRoot] },
    requestKey: pendingFallback.structuredContent.requestKey,
    userApproved: true,
  }, { sessionId: "session-d" });
  assert.match(approvedFallback.structuredContent.grantToken, /^grant_/);

  await runtime.close();
  assert.equal(runtime.status().pendingRequests, 0);
  assert.equal(runtime.status().activeGrants, 0);

  console.log(JSON.stringify({
    ok: true,
    gate: "codex-sandbox",
    officialLauncherWrapped: true,
    sessionCommandSingleUseGrant: true,
    workspaceWriteProfile: true,
    exactApprovalFallback: true,
    allowedRootValidation: true,
    windowsReadIsolationNotOverclaimed: process.platform === "win32",
  }));
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
}
