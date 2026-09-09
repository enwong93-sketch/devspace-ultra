import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import * as z from "zod/v4";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const MAX_SERVERS = 128;
const MAX_TOOLS = 500;
const INTERNAL_CODEX_OWNER = "__devspace_internal_codex_catalog__";
const HIGH_RISK_SERVER_PATTERN = /(?:^|[-_.])(elevated|administrator|admin|root)(?:$|[-_.])/i;
const RECURSIVE_OR_DUPLICATE_IDS = new Set(["devspace", "powermem", "powermem-shared"]);
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
const CALLING = {
  readOnlyHint: false,
  destructiveHint: false,
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

function normalizeOwner(value) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("A ChatGPT conversation identity is required for a Codex MCP connection.");
  return text.slice(0, 300);
}

function connectionKey(serverId, ownerConversationId) {
  return `${String(serverId)}::conversation:${sha256(normalizeOwner(ownerConversationId)).slice(0, 32)}`;
}

function boundedText(value, max = 2000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function boundedArray(value, max = MAX_TOOLS) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max).map((entry) => String(entry)).filter(Boolean);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function expandHome(value) {
  const text = String(value ?? "").trim();
  if (text === "~") return homedir();
  if (text.startsWith("~/") || text.startsWith("~\\")) return resolve(homedir(), text.slice(2));
  return text;
}

function commandForPlatform(command) {
  const value = String(command ?? "").trim();
  if (process.platform !== "win32" || /\.[a-z0-9]+$/i.test(basename(value))) return value;
  const lower = basename(value).toLowerCase();
  if (["npm", "npx", "pnpm", "yarn", "bunx"].includes(lower)) return `${value}.cmd`;
  return value;
}

function publicUrl(value) {
  try {
    const parsed = new URL(String(value ?? ""));
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeApprovalMode(value) {
  const mode = String(value ?? "auto").trim().toLowerCase();
  return ["auto", "prompt", "writes", "approve"].includes(mode) ? mode : "prompt";
}

function normalizeToolPolicy(raw) {
  const result = new Map();
  for (const [name, config] of Object.entries(safeObject(raw))) {
    result.set(name, normalizeApprovalMode(safeObject(config).approval_mode));
  }
  return result;
}

function sanitizeAnnotations(value) {
  const source = safeObject(value);
  const result = {};
  for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
    if (typeof source[key] === "boolean") result[key] = source[key];
  }
  return Object.keys(result).length ? result : undefined;
}

function sanitizeTool(tool, serverId) {
  return {
    name: boundedText(tool?.name, 220),
    canonicalName: `mcp__${serverId.replace(/[^A-Za-z0-9_-]+/g, "_")}__${String(tool?.name ?? "").replace(/[^A-Za-z0-9_-]+/g, "_")}`,
    title: tool?.title == null ? undefined : boundedText(tool.title, 500),
    description: tool?.description == null ? undefined : boundedText(tool.description, 4000),
    inputSchema: tool?.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} },
    outputSchema: tool?.outputSchema && typeof tool.outputSchema === "object" ? tool.outputSchema : undefined,
    annotations: sanitizeAnnotations(tool?.annotations),
  };
}

function sanitizeResource(resource) {
  return {
    uri: boundedText(resource?.uri, 16_384),
    name: boundedText(resource?.name, 500),
    description: resource?.description == null ? undefined : boundedText(resource.description, 2000),
    mimeType: resource?.mimeType == null ? undefined : boundedText(resource.mimeType, 240),
    size: Number.isFinite(Number(resource?.size)) ? Number(resource.size) : undefined,
  };
}

function sanitizeResourceTemplate(resource) {
  return {
    uriTemplate: boundedText(resource?.uriTemplate, 16_384),
    name: boundedText(resource?.name, 500),
    description: resource?.description == null ? undefined : boundedText(resource.description, 2000),
    mimeType: resource?.mimeType == null ? undefined : boundedText(resource.mimeType, 240),
  };
}

function shouldInvalidateClient(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /connection closed|transport|socket|econn(?:reset|refused)|broken pipe|websocket.*closed/i.test(message);
}

function configPathFromOptions(options = {}) {
  if (options.configPath) return resolve(expandHome(options.configPath));
  const codexHome = options.codexHome || options.env?.CODEX_HOME || process.env.CODEX_HOME || resolve(homedir(), ".codex");
  return resolve(expandHome(codexHome), "config.toml");
}

function normalizeServer(id, raw, configPath) {
  const source = safeObject(raw);
  const command = String(source.command ?? "").trim();
  const url = String(source.url ?? "").trim();
  const type = command ? "stdio" : url ? (String(source.type ?? "").toLowerCase() === "sse" ? "sse" : "streamable-http") : "invalid";
  const enabledTools = boundedArray(source.enabled_tools);
  const disabledTools = new Set(boundedArray(source.disabled_tools));
  const env = safeObject(source.env);
  const envVars = boundedArray(source.env_vars, 128);
  const httpHeaders = safeObject(source.http_headers);
  const envHttpHeaders = safeObject(source.env_http_headers);
  const bearerTokenEnvVar = String(source.bearer_token_env_var ?? "").trim();
  const skipReason = RECURSIVE_OR_DUPLICATE_IDS.has(String(id).toLowerCase())
    ? "Skipped to avoid DevSpace recursion or duplicate shared PowerMem service."
    : type === "invalid"
      ? "Codex MCP entry has neither command nor URL."
      : null;
  return {
    id: String(id),
    enabled: source.enabled !== false,
    required: source.required === true,
    type,
    command,
    args: boundedArray(source.args, 256),
    cwd: String(source.cwd ?? "").trim(),
    env,
    envVars,
    url,
    httpHeaders,
    envHttpHeaders,
    bearerTokenEnvVar,
    inlineBearerTokenPresent: source.bearer_token != null,
    enabledTools,
    disabledTools,
    defaultApprovalMode: normalizeApprovalMode(source.default_tools_approval_mode),
    toolPolicies: normalizeToolPolicy(source.tools),
    highRisk: HIGH_RISK_SERVER_PATTERN.test(String(id)),
    supportsParallelToolCalls: source.supports_parallel_tool_calls !== false,
    configPath,
    skipReason,
  };
}

function publicServer(server, probe) {
  const environmentNames = new Set([
    ...Object.keys(server.env),
    ...server.envVars,
    ...Object.values(server.envHttpHeaders).map(String),
    ...(server.bearerTokenEnvVar ? [server.bearerTokenEnvVar] : []),
  ]);
  return {
    id: server.id,
    enabled: server.enabled,
    runnable: server.enabled && !server.skipReason && !server.inlineBearerTokenPresent,
    type: server.type,
    commandName: server.type === "stdio" ? basename(server.command) : null,
    argumentCount: server.args.length,
    cwdConfigured: Boolean(server.cwd),
    url: server.type === "stdio" ? null : publicUrl(server.url),
    environmentNames: [...environmentNames].sort(),
    literalEnvironmentCount: Object.keys(server.env).length,
    literalHeaderNames: Object.keys(server.httpHeaders).sort(),
    enabledTools: server.enabledTools,
    disabledTools: [...server.disabledTools].sort(),
    defaultApprovalMode: server.defaultApprovalMode,
    perToolApprovalCount: server.toolPolicies.size,
    highRisk: server.highRisk,
    supportsParallelToolCalls: server.supportsParallelToolCalls,
    required: server.required,
    skipReason: server.skipReason,
    inlineBearerTokenRejected: server.inlineBearerTokenPresent,
    status: probe?.status ?? "not-probed",
    serverInfo: probe?.serverInfo,
    capabilities: probe?.capabilities,
    tools: probe?.tools ?? [],
    prompts: probe?.prompts ?? [],
    resources: probe?.resources ?? [],
    resourceTemplates: probe?.resourceTemplates ?? [],
    probeErrors: probe?.probeErrors,
    error: probe?.error,
  };
}

function toolAllowed(server, toolName) {
  if (server.enabledTools.length && !server.enabledTools.includes(toolName)) return false;
  return !server.disabledTools.has(toolName);
}

function normalizeExecutionPolicy(value) {
  const policy = String(value ?? "full-access").trim().toLowerCase();
  if (policy !== "full-access") {
    throw new Error(`Unsupported Codex MCP execution policy: ${policy}. DevSpace supports full-access only.`);
  }
  return policy;
}

function approvalDecision(server, tool, executionPolicy) {
  const configuredMode = server.toolPolicies.get(tool.name) || server.defaultApprovalMode;
  const readOnly = tool.annotations?.readOnlyHint === true;
  return {
    mode: executionPolicy,
    configuredMode,
    readOnly,
    required: false,
    reason: null,
  };
}

export class CodexMcpBridge {
  constructor(options = {}) {
    this.configPath = configPathFromOptions(options);
    this.env = options.env || process.env;
    this.executionPolicy = normalizeExecutionPolicy(options.executionPolicy);
    this.servers = new Map();
    this.clients = new Map();
    this.connecting = new Map();
    this.probes = new Map();
    this.loadedAt = null;
    this.lastError = null;
    this.ready = this.refresh({ failOpen: true });
  }

  async refresh({ failOpen = false, ownerConversationId = null } = {}) {
    await this.closeClients(ownerConversationId);
    this.servers.clear();
    this.probes.clear();
    try {
      if (!existsSync(this.configPath)) {
        this.loadedAt = new Date().toISOString();
        this.lastError = null;
        return { ok: true, configPath: this.configPath, serverCount: 0, missing: true };
      }
      const text = await readFile(this.configPath, "utf8");
      const parsed = parseToml(text.replace(/^\uFEFF/, ""));
      const rawServers = safeObject(parsed?.mcp_servers);
      const entries = Object.entries(rawServers).slice(0, MAX_SERVERS);
      for (const [id, raw] of entries) this.servers.set(String(id), normalizeServer(id, raw, this.configPath));
      this.loadedAt = new Date().toISOString();
      this.lastError = null;
      return { ok: true, configPath: this.configPath, serverCount: this.servers.size, missing: false };
    } catch (error) {
      this.loadedAt = new Date().toISOString();
      this.lastError = error instanceof Error ? error.message : String(error);
      if (!failOpen) throw new Error(`Unable to load Codex MCP config: ${this.lastError}`);
      return { ok: false, configPath: this.configPath, serverCount: 0, error: this.lastError };
    }
  }

  async ensureReady() {
    await this.ready;
  }

  requireServer(id, { runnable = true } = {}) {
    const server = this.servers.get(String(id));
    if (!server) throw new Error(`Unknown Codex MCP server: ${id}`);
    if (runnable) {
      if (!server.enabled) throw new Error(`Codex MCP server ${id} is disabled in config.toml.`);
      if (server.skipReason) throw new Error(`Codex MCP server ${id} is unavailable: ${server.skipReason}`);
      if (server.inlineBearerTokenPresent) throw new Error(`Codex MCP server ${id} uses unsupported inline bearer_token. Use bearer_token_env_var instead.`);
    }
    return server;
  }

  async catalog({ includeDisabled = true } = {}) {
    await this.ensureReady();
    return {
      ok: true,
      configPath: this.configPath,
      loadedAt: this.loadedAt,
      configError: this.lastError,
      executionPolicy: this.executionPolicy,
      servers: [...this.servers.values()]
        .filter((server) => includeDisabled || server.enabled)
        .map((server) => publicServer(server, this.probes.get(server.id)))
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  async search(query, { limit = 20 } = {}) {
    await this.ensureReady();
    const terms = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 16);
    const max = Math.max(1, Math.min(100, Number(limit) || 20));
    const rows = [];
    for (const server of this.servers.values()) {
      const probe = this.probes.get(server.id);
      const publicEntry = publicServer(server, probe);
      const toolText = (probe?.tools || []).map((tool) => `${tool.name} ${tool.description || ""}`).join(" ").toLowerCase();
      const haystack = `${server.id} ${server.type} ${publicEntry.commandName || ""} ${publicEntry.url || ""} ${toolText}`.toLowerCase();
      const score = terms.length ? terms.reduce((sum, term) => sum + (haystack.includes(term) ? (server.id.toLowerCase().includes(term) ? 10 : 2) : 0), 0) : 1;
      if (score > 0) rows.push({ score, server: publicEntry });
    }
    return rows.sort((a, b) => b.score - a.score || a.server.id.localeCompare(b.server.id)).slice(0, max).map((row) => row.server);
  }

  async createClient(server) {
    const client = new Client({ name: `devspace-codex-mcp-${server.id}`, version: "0.5.0" });
    let transport;
    if (server.type === "stdio") {
      const environment = { ...getDefaultEnvironment() };
      for (const name of server.envVars) {
        if (this.env[name] !== undefined) environment[name] = String(this.env[name]);
      }
      for (const [name, value] of Object.entries(server.env)) environment[name] = String(value);
      const cwdText = expandHome(server.cwd);
      const cwd = cwdText ? (isAbsolute(cwdText) ? resolve(cwdText) : resolve(dirname(this.configPath), cwdText)) : homedir();
      transport = new StdioClientTransport({
        command: commandForPlatform(server.command),
        args: server.args,
        cwd,
        env: environment,
        stderr: "pipe",
      });
    } else {
      const parsed = new URL(server.url);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`Codex MCP server ${server.id} URL must use HTTP or HTTPS.`);
      const headers = {};
      for (const [name, value] of Object.entries(server.httpHeaders)) headers[name] = String(value);
      for (const [name, envName] of Object.entries(server.envHttpHeaders)) {
        const value = this.env[String(envName)];
        if (value !== undefined) headers[name] = String(value);
      }
      if (server.bearerTokenEnvVar) {
        const token = this.env[server.bearerTokenEnvVar];
        if (!token) throw new Error(`Missing environment variable ${server.bearerTokenEnvVar} for Codex MCP server ${server.id}.`);
        headers.Authorization = `Bearer ${String(token)}`;
      }
      if (server.type === "sse") {
        transport = new SSEClientTransport(parsed, {
          eventSourceInit: {
            fetch: (url, init) => fetch(url, {
              ...init,
              headers: { ...Object.fromEntries(new Headers(init?.headers || {}).entries()), ...headers },
            }),
          },
          requestInit: { headers },
        });
      } else {
        transport = new StreamableHTTPClientTransport(parsed, { requestInit: { headers } });
      }
    }
    try {
      await client.connect(transport);
    } catch (error) {
      try { await transport.close(); } catch {}
      throw new Error(`Codex MCP server ${server.id} failed to connect: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { client, transport };
  }

  async getClient(serverId, ownerConversationId = INTERNAL_CODEX_OWNER) {
    await this.ensureReady();
    const server = this.requireServer(serverId);
    const owner = normalizeOwner(ownerConversationId);
    const key = connectionKey(server.id, owner);
    const existing = this.clients.get(key);
    if (existing) return { server, holder: existing };
    let pending = this.connecting.get(key);
    if (!pending) {
      pending = this.createClient(server)
        .then((holder) => {
          const scoped = { ...holder, server, serverId: server.id, ownerConversationId: owner, connectionKey: key };
          this.clients.set(key, scoped);
          return scoped;
        })
        .finally(() => this.connecting.delete(key));
      this.connecting.set(key, pending);
    }
    return { server, holder: await pending };
  }

  async closeClient(serverId, ownerConversationId = null) {
    const requested = String(serverId || "").trim();
    const owner = ownerConversationId == null ? null : normalizeOwner(ownerConversationId);
    const keys = new Set([
      ...[...this.clients.entries()]
        .filter(([, holder]) => holder?.serverId === requested && (!owner || holder?.ownerConversationId === owner))
        .map(([key]) => key),
      ...[...this.connecting.keys()]
        .filter((key) => String(key).startsWith(`${requested}::conversation:`)
          && (!owner || key === connectionKey(requested, owner))),
    ]);
    for (const key of keys) {
      const pending = this.connecting.get(key);
      if (pending) {
        try {
          const holder = await pending;
          try { await holder.client.close(); } catch {}
          try { await holder.transport.close(); } catch {}
        } catch {}
        this.connecting.delete(key);
      }
      const holder = this.clients.get(key);
      if (holder) {
        this.clients.delete(key);
        try { await holder.client.close(); } catch {}
        try { await holder.transport.close(); } catch {}
      }
    }
  }

  async closeClients(ownerConversationId = null) {
    const serverIds = new Set([
      ...[...this.clients.values()].map((holder) => holder?.serverId).filter(Boolean),
      ...[...this.connecting.keys()].map((key) => String(key).split("::conversation:")[0]).filter(Boolean),
    ]);
    for (const id of serverIds) await this.closeClient(id, ownerConversationId);
  }

  async execute(serverId, operation, ownerConversationId = INTERNAL_CODEX_OWNER) {
    const { server, holder } = await this.getClient(serverId, ownerConversationId);
    try {
      return { server, holder, result: await operation(holder.client) };
    } catch (error) {
      if (shouldInvalidateClient(error)) await this.closeClient(server.id, ownerConversationId).catch(() => {});
      throw error;
    }
  }

  async probe(serverId, ownerConversationId = INTERNAL_CODEX_OWNER) {
    await this.ensureReady();
    const server = this.requireServer(serverId);
    const probe = {
      status: "online",
      capabilities: {},
      tools: [],
      prompts: [],
      resources: [],
      resourceTemplates: [],
      probeErrors: {},
    };
    try {
      const { holder } = await this.getClient(server.id, ownerConversationId);
      const capabilities = holder.client.getServerCapabilities() || {};
      probe.serverInfo = holder.client.getServerVersion?.() || undefined;
      probe.capabilities = {
        tools: Boolean(capabilities.tools),
        prompts: Boolean(capabilities.prompts),
        resources: Boolean(capabilities.resources),
      };
      if (capabilities.tools) {
        try {
          const { result } = await this.execute(server.id, (client, options) => client.listTools(undefined, options), ownerConversationId);
          probe.tools = (result?.tools || []).filter((tool) => toolAllowed(server, tool.name)).slice(0, MAX_TOOLS).map((tool) => sanitizeTool(tool, server.id));
        } catch (error) { probe.probeErrors.tools = error instanceof Error ? error.message : String(error); }
      }
      if (capabilities.prompts) {
        try {
          const { result } = await this.execute(server.id, (client, options) => client.listPrompts(undefined, options), ownerConversationId);
          probe.prompts = (result?.prompts || []).slice(0, MAX_TOOLS).map((prompt) => ({
            name: boundedText(prompt?.name, 220),
            description: prompt?.description == null ? undefined : boundedText(prompt.description, 2000),
            arguments: Array.isArray(prompt?.arguments) ? prompt.arguments.slice(0, 100) : [],
          }));
        } catch (error) { probe.probeErrors.prompts = error instanceof Error ? error.message : String(error); }
      }
      if (capabilities.resources) {
        try {
          const { result } = await this.execute(server.id, (client, options) => client.listResources(undefined, options), ownerConversationId);
          probe.resources = (result?.resources || []).slice(0, MAX_TOOLS).map(sanitizeResource);
        } catch (error) { probe.probeErrors.resources = error instanceof Error ? error.message : String(error); }
        try {
          const { result } = await this.execute(server.id, (client, options) => client.listResourceTemplates(undefined, options), ownerConversationId);
          probe.resourceTemplates = (result?.resourceTemplates || []).slice(0, MAX_TOOLS).map(sanitizeResourceTemplate);
        } catch (error) { probe.probeErrors.resourceTemplates = error instanceof Error ? error.message : String(error); }
      }
    } catch (error) {
      probe.status = "error";
      probe.error = error instanceof Error ? error.message : String(error);
    }
    this.probes.set(server.id, probe);
    return publicServer(server, probe);
  }

  async listResources(serverId, cursor, ownerConversationId = INTERNAL_CODEX_OWNER) {
    const server = this.requireServer(serverId);
    const { result } = await this.execute(server.id, (client, options) => client.listResources(cursor ? { cursor } : undefined, options), ownerConversationId);
    return {
      ok: true,
      server: server.id,
      resources: (result?.resources || []).slice(0, MAX_TOOLS).map(sanitizeResource),
      nextCursor: result?.nextCursor || null,
    };
  }

  async listResourceTemplates(serverId, cursor, ownerConversationId = INTERNAL_CODEX_OWNER) {
    const server = this.requireServer(serverId);
    const { result } = await this.execute(server.id, (client, options) => client.listResourceTemplates(cursor ? { cursor } : undefined, options), ownerConversationId);
    return {
      ok: true,
      server: server.id,
      resourceTemplates: (result?.resourceTemplates || []).slice(0, MAX_TOOLS).map(sanitizeResourceTemplate),
      nextCursor: result?.nextCursor || null,
    };
  }

  async readResource(serverId, uri, ownerConversationId = INTERNAL_CODEX_OWNER) {
    const server = this.requireServer(serverId);
    const resourceUri = String(uri ?? "").trim();
    if (!resourceUri) throw new Error("Resource URI is required.");
    const { result } = await this.execute(server.id, (client, options) => client.readResource({ uri: resourceUri }, options), ownerConversationId);
    return { ok: true, server: server.id, uri: resourceUri, result };
  }

  async callTool({ serverId, toolName, arguments: args = {} } = {}, ownerConversationId = INTERNAL_CODEX_OWNER) {
    const server = this.requireServer(serverId);
    const selected = String(toolName ?? "").trim();
    if (!selected) throw new Error("toolName is required.");
    if (!toolAllowed(server, selected)) throw new Error(`Codex MCP tool ${server.id}/${selected} is disabled by enabled_tools or disabled_tools.`);
    let probe = this.probes.get(server.id);
    if (!probe?.tools?.length) {
      await this.probe(server.id, ownerConversationId);
      probe = this.probes.get(server.id);
    }
    const tool = probe?.tools?.find((candidate) => candidate.name === selected);
    if (!tool) throw new Error(`Unknown or unavailable Codex MCP tool ${server.id}/${selected}. Inspect the server first.`);
    const approval = approvalDecision(server, tool, this.executionPolicy);
    const requestKey = sha256(JSON.stringify({ serverId: server.id, toolName: selected, arguments: args || {} })).slice(0, 24);
    const { result } = await this.execute(server.id, (client, options) => client.callTool({ name: selected, arguments: args || {} }, undefined, options), ownerConversationId);
    return {
      ok: true,
      approvalRequired: false,
      requestKey,
      server: server.id,
      toolName: selected,
      approvalMode: approval.mode,
      configuredApprovalMode: approval.configuredMode,
      result,
    };
  }

  diagnostics() {
    return {
      configPresent: existsSync(this.configPath),
      serverCount: this.servers.size,
      clients: this.clients.size,
      connecting: this.connecting.size,
      probes: this.probes.size,
      loadedAt: this.loadedAt,
      configError: this.lastError,
      executionPolicy: this.executionPolicy,
    };
  }

  listConnections({ serverId = null, ownerConversationId = null } = {}) {
    const requested = String(serverId || "").trim() || null;
    const owner = ownerConversationId == null ? null : normalizeOwner(ownerConversationId);
    const rows = [];
    for (const [key, holder] of this.clients.entries()) {
      const id = String(holder?.serverId || holder?.server?.id || "");
      if (requested && id !== requested) continue;
      if (owner && holder?.ownerConversationId !== owner) continue;
      rows.push({
        source: "codex",
        mode: "conversation-isolated",
        key: String(key),
        serverId: id,
        ownerConversationId: holder?.ownerConversationId || null,
        connectionState: "online",
        connected: true,
        connecting: false,
        transport: holder?.server?.transport || holder?.definition?.transport || null,
      });
    }
    for (const [key] of this.connecting.entries()) {
      if (rows.some((row) => row.key === String(key))) continue;
      const [id] = String(key).split("::conversation:");
      if (requested && id !== requested) continue;
      if (owner && String(key) !== connectionKey(id, owner)) continue;
      rows.push({
        source: "codex",
        mode: "conversation-isolated",
        key: String(key),
        serverId: id,
        ownerConversationId: owner,
        connectionState: "connecting",
        connected: false,
        connecting: true,
        transport: null,
      });
    }
    return rows.sort((a, b) => a.serverId.localeCompare(b.serverId) || a.key.localeCompare(b.key));
  }

  async resetConnection(serverId, ownerConversationId) {
    const requested = String(serverId || "").trim();
    if (!requested) throw new Error("serverId is required.");
    const owner = normalizeOwner(ownerConversationId);
    const key = connectionKey(requested, owner);
    const existed = this.clients.has(key) || this.connecting.has(key);
    await this.closeClient(requested, owner);
    return {
      ok: true,
      source: "codex",
      serverId: requested,
      ownerConversationId: owner,
      closedConnections: existed ? 1 : 0,
      connectionState: "disconnected",
      reconnectOnNextUse: true,
    };
  }

  async close() {
    await this.closeClients();
  }
}

export function registerCodexMcpBridgeTools(server, bridge, { resolveConversation = null } = {}) {
  const currentConversation = async (extra) => {
    if (typeof resolveConversation !== "function") {
      throw new Error("Codex MCP tools require a conversation authority resolver.");
    }
    const resolved = await resolveConversation(extra);
    const conversationId = String(resolved?.conversationId || "").trim();
    if (!conversationId) throw new Error("Codex MCP tools require the current ChatGPT conversation identity.");
    return conversationId;
  };
  server.registerTool("codex_mcp_catalog", {
    title: "List linked Codex MCP servers",
    description: "List the user's existing Codex MCP server configuration through a secret-free linked view. Values of environment variables, literal headers, command arguments, and URL query strings are never returned. This does not copy or rewrite config.toml.",
    inputSchema: {
      includeDisabled: z.boolean().default(true),
    },
    annotations: READ_ONLY,
  }, async (input) => {
    try { return textResult(await bridge.catalog(input)); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("codex_mcp_refresh", {
    title: "Refresh linked Codex MCP servers",
    description: "Re-read the existing Codex config.toml and close stale linked MCP connections. The config file is never rewritten and secret values are never persisted by DevSpace.",
    inputSchema: {},
    annotations: MUTATING,
  }, async (_, extra) => {
    try { return textResult(await bridge.refresh({ ownerConversationId: await currentConversation(extra) })); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("codex_mcp_inspect", {
    title: "Inspect linked Codex MCP server",
    description: "Connect to one selected Codex MCP server and return its filtered tool, prompt, resource, and resource-template schemas without exposing configured secret values.",
    inputSchema: {
      serverId: z.string().min(1).max(220),
    },
    annotations: READ_ONLY,
  }, async ({ serverId }, extra) => {
    try { return textResult({ ok: true, server: await bridge.probe(serverId, await currentConversation(extra)) }); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("codex_mcp_call", {
    title: "Call linked Codex MCP tool",
    description: "Call one tool from the user's existing Codex MCP config under DevSpace's single full-access execution policy. Tool allow/deny lists remain enforced, but local Codex approval modes do not add a second authorization barrier. Higher-priority host safety and action-time confirmation requirements still apply to the assistant's intended action.",
    inputSchema: {
      serverId: z.string().min(1).max(220),
      toolName: z.string().min(1).max(220),
      arguments: z.record(z.string(), z.unknown()).default({}),
      userApproved: z.boolean().optional().describe("Deprecated compatibility field; full-access is the only local execution policy."),
    },
    annotations: CALLING,
  }, async (input, extra) => {
    try { return textResult(await bridge.callTool(input, await currentConversation(extra))); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("codex_mcp_list_resources", {
    title: "List linked Codex MCP resources",
    description: "List resources from one selected linked Codex MCP server. An empty list does not mean the server has no tools.",
    inputSchema: {
      serverId: z.string().min(1).max(220),
      cursor: z.string().min(1).max(4096).optional(),
    },
    annotations: READ_ONLY,
  }, async ({ serverId, cursor }, extra) => {
    try { return textResult(await bridge.listResources(serverId, cursor, await currentConversation(extra))); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("codex_mcp_list_resource_templates", {
    title: "List linked Codex MCP resource templates",
    description: "List parameterized resource templates from one selected linked Codex MCP server.",
    inputSchema: {
      serverId: z.string().min(1).max(220),
      cursor: z.string().min(1).max(4096).optional(),
    },
    annotations: READ_ONLY,
  }, async ({ serverId, cursor }, extra) => {
    try { return textResult(await bridge.listResourceTemplates(serverId, cursor, await currentConversation(extra))); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("codex_mcp_read_resource", {
    title: "Read linked Codex MCP resource",
    description: "Read one listed resource URI from a selected linked Codex MCP server and return it as MCP embedded-resource content.",
    inputSchema: {
      serverId: z.string().min(1).max(220),
      uri: z.string().min(1).max(16_384),
    },
    annotations: READ_ONLY,
  }, async ({ serverId, uri }, extra) => {
    try {
      const read = await bridge.readResource(serverId, uri, await currentConversation(extra));
      const contents = Array.isArray(read?.result?.contents) ? read.result.contents : [];
      const content = contents.map((resource) => ({
        type: "resource",
        resource: {
          uri: String(resource?.uri || uri),
          ...(resource?.mimeType ? { mimeType: String(resource.mimeType) } : {}),
          ...(typeof resource?.text === "string" ? { text: resource.text } : { blob: String(resource?.blob || "") }),
        },
      }));
      if (!content.length) content.push({ type: "text", text: `Codex MCP resource ${uri} returned no contents.` });
      return {
        content,
        structuredContent: {
          ok: true,
          serverId,
          uri,
          contentCount: contents.length,
          contentTypes: contents.map((item) => typeof item?.text === "string" ? "text" : "blob"),
        },
      };
    } catch (error) { return errorResult(error); }
  });
}
