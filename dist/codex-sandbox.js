import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { stringify as stringifyToml } from "smol-toml";
import * as z from "zod/v4";
import { isPathInsideRoot } from "./roots.js";
import { resolveShellCommand } from "./process-platform.js";

const require = createRequire(import.meta.url);
const PROFILE_NAME = "devspace";
const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_PENDING = 64;
const MAX_GRANTS = 64;
const MAX_PERMISSION_PATHS = 32;
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const MUTATING = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
const EXECUTING = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

function textResult(structuredContent, text = JSON.stringify(structuredContent, null, 2)) {
  return { content: [{ type: "text", text }], structuredContent };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { ok: false, error: message },
  };
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function cleanText(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function publicPath(path) {
  return String(path).replace(/\\/g, "/");
}

function sessionKey(extra) {
  const id = String(extra?.sessionId ?? "").trim();
  if (!id) throw new Error("Permission grants require an initialized MCP session.");
  return id;
}

function resolveCodexLauncher(explicitPath) {
  if (explicitPath) return resolve(String(explicitPath));
  try {
    return require.resolve("@openai/codex/bin/codex.js");
  } catch {
    return null;
  }
}

async function existingRealPathOrLexical(path) {
  try {
    return await realpath(path);
  } catch {
    let current = resolve(path);
    const suffix = [];
    while (true) {
      try {
        const base = await realpath(current);
        return resolve(base, ...suffix.reverse());
      } catch {
        const parent = dirname(current);
        if (parent === current) return resolve(path);
        suffix.push(basename(current));
        current = parent;
      }
    }
  }
}

async function normalizePermissionPath(value, workspaceRoot, allowedRoots) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("Permission paths cannot be empty.");
  const lexical = resolve(isAbsolute(text) ? text : join(workspaceRoot, text));
  const candidate = await existingRealPathOrLexical(lexical);
  const allowed = allowedRoots.some((root) => candidate === root || isPathInsideRoot(candidate, root));
  if (!allowed) throw new Error(`Permission path is outside DevSpace allowed roots: ${text}`);
  return candidate;
}

function compactMap(map, limit) {
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (!oldest) break;
    map.delete(oldest);
  }
}

function permissionSummary(request) {
  return {
    network: request.network,
    fileSystem: {
      read: request.readPaths.map(publicPath),
      write: request.writePaths.map(publicPath),
    },
  };
}

function requestFingerprint(request) {
  return sha256(JSON.stringify({
    sessionKey: request.sessionKey,
    workspaceId: request.workspaceId,
    command: request.command,
    network: request.network,
    readPaths: request.readPaths,
    writePaths: request.writePaths,
    reason: request.reason,
  })).slice(0, 32);
}

function runFingerprint(request) {
  return sha256(JSON.stringify({
    workspaceId: request.workspaceId,
    command: request.command,
    network: request.network,
    readPaths: request.readPaths,
    writePaths: request.writePaths,
  })).slice(0, 24);
}

export function buildCodexSandboxConfig({ workspaceRoot, network = false, readPaths = [], writePaths = [] } = {}) {
  const filesystem = {
    ":workspace_roots": {
      ".": "write",
      ".git": "write",
    },
  };
  for (const path of readPaths) filesystem[String(path)] = "read";
  for (const path of writePaths) filesystem[String(path)] = "write";
  return stringifyToml({
    approval_policy: "never",
    default_permissions: PROFILE_NAME,
    permissions: {
      [PROFILE_NAME]: {
        description: `DevSpace one-command sandbox for ${publicPath(workspaceRoot)}`,
        extends: ":workspace",
        filesystem,
        network: network
          ? { enabled: true, mode: "full", allow_local_binding: false }
          : { enabled: false, allow_local_binding: false },
      },
    },
    ...(process.platform === "win32" ? { windows: { sandbox: "unelevated" } } : {}),
  });
}

export class CodexSandboxRuntime {
  constructor({ stateDir, allowedRoots = [], codexLauncher, now = Date.now, ttlMs = DEFAULT_TTL_MS } = {}) {
    this.root = resolve(String(stateDir || "."), "codex-sandbox");
    this.runsRoot = join(this.root, "runs");
    this.allowedRoots = allowedRoots.map((root) => resolve(String(root)));
    this.codexLauncher = resolveCodexLauncher(codexLauncher);
    this.now = now;
    this.ttlMs = Math.max(30_000, Number(ttlMs) || DEFAULT_TTL_MS);
    this.pending = new Map();
    this.grants = new Map();
  }

  available() {
    return Boolean(this.codexLauncher && existsSync(this.codexLauncher));
  }

  cleanupExpired() {
    const now = this.now();
    for (const [key, request] of this.pending) if (request.expiresAt <= now) this.pending.delete(key);
    for (const [token, grant] of this.grants) if (grant.expiresAt <= now || grant.used) this.grants.delete(token);
  }

  async normalizeRequest({ workspace, workspaceId, command, reason, network = false, fileSystem = {}, sessionKey: owner }) {
    if (!workspace?.root) throw new Error("Workspace is required for a permission request.");
    const cmd = String(command ?? "");
    if (!cmd.trim()) throw new Error("Permission request command cannot be empty.");
    if (cmd.length > 100_000) throw new Error("Permission request command exceeds 100000 characters.");
    const readValues = Array.isArray(fileSystem?.read) ? fileSystem.read : [];
    const writeValues = Array.isArray(fileSystem?.write) ? fileSystem.write : [];
    if (readValues.length > MAX_PERMISSION_PATHS || writeValues.length > MAX_PERMISSION_PATHS) {
      throw new Error(`At most ${MAX_PERMISSION_PATHS} read and ${MAX_PERMISSION_PATHS} write paths may be requested.`);
    }
    const roots = this.allowedRoots.length ? this.allowedRoots : [resolve(workspace.root)];
    const readPaths = [];
    const writePaths = [];
    for (const value of readValues) readPaths.push(await normalizePermissionPath(value, workspace.root, roots));
    for (const value of writeValues) writePaths.push(await normalizePermissionPath(value, workspace.root, roots));
    const uniqueWrites = [...new Set(writePaths)].sort();
    const uniqueReads = [...new Set(readPaths)].filter((path) => !uniqueWrites.includes(path)).sort();
    return {
      sessionKey: owner,
      workspaceId,
      workspaceRoot: resolve(workspace.root),
      command: cmd,
      reason: cleanText(reason, 1000) || "This command needs additional sandbox permissions.",
      network: network === true,
      readPaths: uniqueReads,
      writePaths: uniqueWrites,
    };
  }

  savePending(request) {
    this.cleanupExpired();
    const requestKey = requestFingerprint(request);
    const record = {
      ...request,
      requestKey,
      createdAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
    };
    this.pending.delete(requestKey);
    this.pending.set(requestKey, record);
    compactMap(this.pending, MAX_PENDING);
    return record;
  }

  approvePending({ requestKey, sessionKey: owner, expectedRequest }) {
    this.cleanupExpired();
    const pending = this.pending.get(String(requestKey ?? ""));
    if (!pending) throw new Error("Permission request is missing, expired, or already resolved.");
    if (pending.sessionKey !== owner) throw new Error("Permission request belongs to another MCP session.");
    if (expectedRequest && requestFingerprint(expectedRequest) !== pending.requestKey) {
      throw new Error("Permission request changed after approval was requested.");
    }
    this.pending.delete(pending.requestKey);
    const token = `grant_${randomBytes(32).toString("base64url")}`;
    this.grants.set(token, {
      ...pending,
      token,
      used: false,
      grantedAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
    });
    compactMap(this.grants, MAX_GRANTS);
    return {
      grantToken: token,
      requestKey: pending.requestKey,
      expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
      permissions: permissionSummary(pending),
      commandFingerprint: runFingerprint(pending),
    };
  }

  declinePending(requestKey) {
    return this.pending.delete(String(requestKey ?? ""));
  }

  consumeGrant({ token, sessionKey: owner, workspaceId, command }) {
    this.cleanupExpired();
    const grant = this.grants.get(String(token ?? ""));
    if (!grant) throw new Error("Sandbox permission grant is missing, expired, invalid, or already used.");
    if (grant.sessionKey !== owner) throw new Error("Sandbox permission grant belongs to another MCP session.");
    if (grant.workspaceId !== workspaceId || grant.command !== command) {
      throw new Error("Sandbox permission grant is bound to a different workspace or command.");
    }
    grant.used = true;
    this.grants.delete(grant.token);
    return grant;
  }

  async prepareExecution({ workspace, workspaceId, command, grantToken, sessionKey: owner }) {
    if (!this.available()) throw new Error("Official OpenAI Codex sandbox launcher is not installed with DevSpace.");
    const grant = grantToken
      ? this.consumeGrant({ token: grantToken, sessionKey: owner, workspaceId, command })
      : {
        workspaceId,
        workspaceRoot: resolve(workspace.root),
        command,
        network: false,
        readPaths: [],
        writePaths: [],
      };
    await mkdir(this.runsRoot, { recursive: true });
    const runDir = await mkdtemp(join(this.runsRoot, "run-"));
    const configText = buildCodexSandboxConfig({
      workspaceRoot: workspace.root,
      network: grant.network,
      readPaths: grant.readPaths,
      writePaths: grant.writePaths,
    });
    await writeFile(join(runDir, "config.toml"), configText, { encoding: "utf8", mode: 0o600 });
    const shell = resolveShellCommand(command);
    const args = [
      this.codexLauncher,
      "sandbox",
      "-P",
      PROFILE_NAME,
      "-C",
      resolve(workspace.root),
      shell.executable,
      ...shell.args,
    ];
    return {
      executable: process.execPath,
      args,
      environment: {
        CODEX_HOME: runDir,
        DEVSPACE_SANDBOXED: "1",
        DEVSPACE_SANDBOX_NETWORK: grant.network ? "1" : "0",
      },
      onDispose: () => rm(runDir, { recursive: true, force: true }),
      summary: {
        sandboxed: true,
        backend: "openai-codex-sandbox",
        platform: process.platform,
        workspaceId,
        commandFingerprint: runFingerprint(grant),
        permissions: permissionSummary(grant),
        readIsolationClaimed: process.platform !== "win32",
        localLoopbackMayRemainAvailable: true,
      },
    };
  }

  status() {
    this.cleanupExpired();
    return {
      ok: true,
      available: this.available(),
      backend: "openai-codex-sandbox",
      launcher: this.codexLauncher ? basename(this.codexLauncher) : null,
      platform: process.platform,
      pendingRequests: this.pending.size,
      activeGrants: this.grants.size,
      grantTtlSeconds: Math.round(this.ttlMs / 1000),
      defaultProfile: ":workspace plus explicit .git write",
      defaultExternalNetwork: false,
      localLoopbackMayRemainAvailable: true,
      additionalWriteRootsSupported: true,
      additionalReadRootsSupported: true,
      readIsolationClaimed: process.platform !== "win32",
      note: process.platform === "win32"
        ? "Windows execution uses the official Codex restricted-token sandbox. DevSpace enforces workspace/additional write boundaries and external-network grants, but does not claim global read-deny isolation on Windows."
        : "Execution uses the official Codex platform sandbox with one-command permission profiles.",
    };
  }

  async close() {
    this.pending.clear();
    this.grants.clear();
  }
}

function permissionRequestSchema() {
  return {
    workspaceId: z.string().min(1),
    cmd: z.string().min(1).max(100_000),
    reason: z.string().min(1).max(1000),
    network: z.boolean().default(false),
    fileSystem: z.object({
      read: z.array(z.string().min(1).max(4096)).max(MAX_PERMISSION_PATHS).default([]),
      write: z.array(z.string().min(1).max(4096)).max(MAX_PERMISSION_PATHS).default([]),
    }).default({ read: [], write: [] }),
    requestKey: z.string().min(16).max(128).optional(),
    userApproved: z.boolean().default(false),
  };
}

function elicitationRequest(pending) {
  const permissions = permissionSummary(pending);
  const lines = [
    pending.reason,
    `Command fingerprint: ${runFingerprint(pending)}`,
    `External network: ${permissions.network ? "allow once" : "not requested"}`,
    `Additional read paths: ${permissions.fileSystem.read.join(", ") || "none"}`,
    `Additional write paths: ${permissions.fileSystem.write.join(", ") || "none"}`,
  ];
  return {
    mode: "form",
    message: "Approve these additional sandbox permissions for exactly one command?",
    requestedSchema: {
      type: "object",
      properties: {
        decision: {
          type: "string",
          title: "Sandbox permission",
          description: lines.join("\n"),
          enum: ["Approve once", "Decline"],
        },
      },
      required: ["decision"],
    },
  };
}

export function registerCodexSandboxTools(server, {
  runtime,
  workspaces,
  processSessions,
} = {}) {
  server.registerTool("codex_sandbox_status", {
    title: "Codex sandbox status",
    description: "Show whether the official local Codex sandbox backend is available and the exact boundaries DevSpace claims. No permission tokens or secret values are returned.",
    inputSchema: {},
    annotations: READ_ONLY,
  }, async () => textResult(runtime.status()));

  server.registerTool("request_permissions", {
    title: "Request sandbox permissions",
    description: "Request additional network or filesystem permissions for exactly one exec_sandboxed command. Grants are MCP-session-bound, command-bound, single-use, memory-only, and expire after ten minutes. Prefer the smallest requested paths. If form elicitation is unsupported, ask the user in normal chat and retry the unchanged request with its requestKey and userApproved=true only after explicit approval.",
    inputSchema: permissionRequestSchema(),
    annotations: MUTATING,
  }, async (input, extra) => {
    try {
      const owner = sessionKey(extra);
      const workspace = workspaces.getWorkspace(input.workspaceId);
      const normalized = await runtime.normalizeRequest({
        workspace,
        workspaceId: input.workspaceId,
        command: input.cmd,
        reason: input.reason,
        network: input.network,
        fileSystem: input.fileSystem,
        sessionKey: owner,
      });
      if (!normalized.network && normalized.readPaths.length === 0 && normalized.writePaths.length === 0) {
        return textResult({
          ok: true,
          approvalRequired: false,
          grantRequired: false,
          instruction: "The command needs only the default workspace sandbox. Call exec_sandboxed without grantToken.",
        });
      }
      if (input.userApproved) {
        if (!input.requestKey) throw new Error("userApproved=true requires the unchanged pending requestKey.");
        const approved = runtime.approvePending({ requestKey: input.requestKey, sessionKey: owner, expectedRequest: normalized });
        return textResult({ ok: true, approvalRequired: false, grantRequired: true, ...approved }, "Additional sandbox permissions approved for one command.");
      }
      const pending = runtime.savePending(normalized);
      try {
        const response = await server.server.elicitInput(elicitationRequest(pending), {
          timeout: 10 * 60_000,
          maxTotalTimeout: 10 * 60_000,
        });
        if (response?.action === "accept" && response?.content?.decision === "Approve once") {
          const approved = runtime.approvePending({ requestKey: pending.requestKey, sessionKey: owner, expectedRequest: normalized });
          return textResult({ ok: true, supported: true, approvalRequired: false, grantRequired: true, ...approved }, "Additional sandbox permissions approved for one command.");
        }
        runtime.declinePending(pending.requestKey);
        return textResult({ ok: false, supported: true, approvalRequired: false, declined: true, requestKey: pending.requestKey }, "Sandbox permission request was declined.");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/does not support.*elicitation|elicitation.*not supported|client does not support/i.test(message)) {
          return textResult({
            ok: false,
            supported: false,
            approvalRequired: true,
            grantRequired: true,
            requestKey: pending.requestKey,
            commandFingerprint: runFingerprint(pending),
            permissions: permissionSummary(pending),
            reason: pending.reason,
            instruction: "Ask the user to approve this exact request in normal chat. After explicit approval, retry request_permissions with the same fields, requestKey, and userApproved=true.",
          }, "The connected host cannot show an MCP permission form. Ask the user for explicit approval in normal chat.");
        }
        runtime.declinePending(pending.requestKey);
        throw error;
      }
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("exec_sandboxed", {
    title: "Execute sandboxed command",
    description: "Run a command through the official local OpenAI Codex sandbox. By default it can write only inside the opened workspace (including .git), has no external-network grant, and may retain loopback control-plane access. Additional network or filesystem write roots require a single-use grantToken from request_permissions. Long-running commands return a sessionId compatible with write_stdin.",
    inputSchema: {
      workspaceId: z.string().min(1),
      cmd: z.string().min(1).max(100_000),
      grantToken: z.string().min(32).max(256).optional(),
      yieldTimeMs: z.number().int().min(0).max(30_000).optional(),
      maxOutputTokens: z.number().int().min(1).max(100_000).optional(),
      tty: z.boolean().default(false),
      columns: z.number().int().min(1).max(1000).optional(),
      rows: z.number().int().min(1).max(1000).optional(),
    },
    annotations: EXECUTING,
  }, async (input, extra) => {
    try {
      const owner = sessionKey(extra);
      const workspace = workspaces.getWorkspace(input.workspaceId);
      const prepared = await runtime.prepareExecution({
        workspace,
        workspaceId: input.workspaceId,
        command: input.cmd,
        grantToken: input.grantToken,
        sessionKey: owner,
      });
      let processResult;
      try {
        processResult = await processSessions.start({
          workspaceId: input.workspaceId,
          workspaceRoot: workspace.root,
          cwd: workspace.root,
          executable: prepared.executable,
          args: prepared.args,
          environment: prepared.environment,
          onDispose: prepared.onDispose,
          yieldTimeMs: input.yieldTimeMs,
          maxOutputTokens: input.maxOutputTokens,
          tty: input.tty,
          columns: input.columns,
          rows: input.rows,
        });
      } catch (error) {
        await prepared.onDispose();
        throw error;
      }
      const result = {
        ok: processResult.running || processResult.exitCode === 0,
        ...prepared.summary,
        sessionId: processResult.sessionId,
        output: processResult.output,
        outputTruncated: processResult.outputTruncated,
        running: processResult.running,
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        wallTimeMs: processResult.wallTimeMs,
      };
      return textResult(result, processResult.output || (processResult.running
        ? `Sandboxed command is running in process session ${processResult.sessionId}.`
        : `Sandboxed command exited with code ${processResult.exitCode}.`));
    } catch (error) {
      return errorResult(error);
    }
  });
}
