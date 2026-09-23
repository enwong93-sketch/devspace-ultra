import { createHash } from "node:crypto";

const CANDIDATE_PROTOCOL_VERSION = "2025-11-25";
export const MODEL_SURFACE_FINGERPRINT_VERSION = 2;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
  return result;
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) throw new Error("tools must be an array.");
  return tools
    .map((tool) => ({
      name: String(tool?.name ?? ""),
      title: String(tool?.title ?? ""),
      description: String(tool?.description ?? ""),
      inputSchema: tool?.inputSchema ?? null,
      outputSchema: tool?.outputSchema ?? null,
      annotations: tool?.annotations ?? null,
      _meta: tool?._meta ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function schemaFingerprint(tools) {
  const canonical = canonicalize({
    version: MODEL_SURFACE_FINGERPRINT_VERSION,
    tools: normalizeTools(tools),
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function normalizeBaseUrl(value, label) {
  const parsed = new URL(String(value ?? "").trim());
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = "/";
  const normalized = parsed.toString().replace(/\/$/, "");
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function requireLoopbackBase(value) {
  const base = normalizeBaseUrl(value, "coreBaseUrl");
  const host = new URL(base).hostname.toLowerCase();
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    throw new Error("Stable Gateway candidate Core must use a loopback address.");
  }
  return base;
}

function authorizationHeader(value) {
  const token = String(value ?? "").trim();
  if (!token) throw new Error("bearerToken is required for candidate MCP probes.");
  return /^bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

function safeError(error) {
  const name = error instanceof Error ? error.name : "Error";
  return { error: name };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    redirect: "manual",
    cache: "no-store",
    ...options,
  });
  let body = null;
  try { body = await response.json(); } catch {}
  return { response, body };
}

export async function readCoreRuntimeIdentity({ coreBaseUrl, timeoutMs = 3_000 } = {}) {
  const coreBase = requireLoopbackBase(coreBaseUrl);
  const timeout = Math.max(500, Math.min(30_000, Number(timeoutMs) || 3_000));
  const options = { signal: AbortSignal.timeout(timeout) };
  const health = await fetchJson(`${coreBase}/healthz`, options);
  if (!health.response.ok || health.body?.ok !== true) {
    return { ok: false, baseUrl: coreBase, pid: null, stage: "health", status: health.response.status };
  }
  const memory = await fetchJson(`${coreBase}/__devspace/memory/status`, options);
  const pid = Number(memory.body?.pid);
  if (!memory.response.ok || !Number.isInteger(pid) || pid < 1) {
    return { ok: false, baseUrl: coreBase, pid: null, stage: "identity", status: memory.response.status };
  }
  return {
    ok: true,
    baseUrl: coreBase,
    pid,
    passiveCore: memory.body?.features?.passiveCore === true,
    autoCompactEnabled: memory.body?.features?.autoCompactEnabled === true,
  };
}

function parseMcpPayload(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try { return JSON.parse(data); } catch {}
  }
  return null;
}

async function mcpPost(coreBase, authorization, body, { backendSessionId, protocolVersion } = {}) {
  const response = await fetch(`${coreBase}/mcp`, {
    method: "POST",
    redirect: "manual",
    cache: "no-store",
    headers: {
      authorization,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(backendSessionId ? { "mcp-session-id": backendSessionId } : {}),
      ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    payload: parseMcpPayload(text),
  };
}

export async function readCoreSchemaFingerprint({
  coreBaseUrl,
  bearerToken,
} = {}) {
  const coreBase = requireLoopbackBase(coreBaseUrl);
  const authorization = authorizationHeader(bearerToken);

  const initializeBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: CANDIDATE_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "devspace-stable-gateway-baseline", version: "0.5.0" },
    },
  };
  const initialized = await mcpPost(coreBase, authorization, initializeBody);
  const backendSessionId = String(initialized.headers.get("mcp-session-id") ?? "").trim();
  const protocolVersion = String(initialized.payload?.result?.protocolVersion ?? CANDIDATE_PROTOCOL_VERSION);
  if (!initialized.ok || !backendSessionId || !initialized.payload?.result) {
    throw new Error(`Unable to initialize fresh active Core schema probe (status ${initialized.status}).`);
  }

  const notification = await mcpPost(coreBase, authorization, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  }, {
    backendSessionId,
    protocolVersion,
  });
  if (!notification.ok) {
    throw new Error(`Unable to initialize fresh active Core schema session (status ${notification.status}).`);
  }

  const listed = await mcpPost(coreBase, authorization, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  }, {
    backendSessionId,
    protocolVersion,
  });
  const tools = listed.payload?.result?.tools;
  if (!listed.ok || !Array.isArray(tools)) {
    throw new Error(`Unable to read fresh active Core tool schema (status ${listed.status}).`);
  }
  return {
    schemaFingerprint: schemaFingerprint(tools),
    toolCount: tools.length,
    protocolVersion,
  };
}

export async function readSessionSchemaFingerprint({
  coreBaseUrl,
  bearerToken,
  backendSessionId,
  protocolVersion = CANDIDATE_PROTOCOL_VERSION,
} = {}) {
  const coreBase = requireLoopbackBase(coreBaseUrl);
  const authorization = authorizationHeader(bearerToken);
  const sessionId = String(backendSessionId ?? "").trim();
  if (!sessionId) throw new Error("backendSessionId is required.");
  const listed = await mcpPost(coreBase, authorization, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  }, {
    backendSessionId: sessionId,
    protocolVersion,
  });
  const tools = listed.payload?.result?.tools;
  if (!listed.ok || !Array.isArray(tools)) {
    throw new Error(`Unable to read active Core tool schema (status ${listed.status}).`);
  }
  return {
    schemaFingerprint: schemaFingerprint(tools),
    toolCount: tools.length,
  };
}

function authorizationServerMatches(metadata, publicBase) {
  const expectedIssuer = `${publicBase}/`;
  const expected = {
    issuer: expectedIssuer,
    authorization_endpoint: `${publicBase}/authorize`,
    token_endpoint: `${publicBase}/token`,
    registration_endpoint: `${publicBase}/register`,
    revocation_endpoint: `${publicBase}/revoke`,
  };
  return Object.entries(expected).every(([key, value]) => metadata?.[key] === value)
    && Array.isArray(metadata?.scopes_supported)
    && metadata.scopes_supported.includes("devspace")
    && metadata.scopes_supported.includes("offline_access");
}

export async function probeCandidate({
  coreBaseUrl,
  publicBaseUrl,
  bearerToken,
  expectedSchemaFingerprint,
  allowSchemaChange = false,
} = {}) {
  const coreBase = requireLoopbackBase(coreBaseUrl);
  const publicBase = normalizeBaseUrl(publicBaseUrl, "publicBaseUrl");
  const authorization = authorizationHeader(bearerToken);
  const expectedFingerprint = String(expectedSchemaFingerprint ?? "").trim();
  if (!/^[a-f0-9]{64}$/i.test(expectedFingerprint)) throw new Error("expectedSchemaFingerprint must be a SHA-256 hex digest.");

  try {
    const health = await fetchJson(`${coreBase}/healthz`);
    if (!health.response.ok || health.body?.ok !== true) {
      return { ok: false, stage: "health", status: health.response.status };
    }
  } catch (error) {
    return { ok: false, stage: "health", status: null, ...safeError(error) };
  }

  const expectedResource = `${publicBase}/mcp`;
  const expectedIssuer = `${publicBase}/`;
  let protectedResource;
  try {
    const probe = await fetchJson(`${coreBase}/.well-known/oauth-protected-resource/mcp`);
    protectedResource = probe.body;
    const authorizationServers = Array.isArray(protectedResource?.authorization_servers) ? protectedResource.authorization_servers : [];
    if (!probe.response.ok || protectedResource?.resource !== expectedResource || !authorizationServers.includes(expectedIssuer)) {
      return {
        ok: false,
        stage: "protected-resource",
        status: probe.response.status,
        resource: protectedResource?.resource ?? null,
      };
    }
  } catch (error) {
    return { ok: false, stage: "protected-resource", status: null, ...safeError(error) };
  }

  let authorizationServer;
  try {
    const probe = await fetchJson(`${coreBase}/.well-known/oauth-authorization-server`);
    authorizationServer = probe.body;
    if (!probe.response.ok || !authorizationServerMatches(authorizationServer, publicBase)) {
      return {
        ok: false,
        stage: "authorization-server",
        status: probe.response.status,
        issuer: authorizationServer?.issuer ?? null,
        scopes: Array.isArray(authorizationServer?.scopes_supported) ? [...authorizationServer.scopes_supported] : [],
      };
    }
  } catch (error) {
    return { ok: false, stage: "authorization-server", status: null, ...safeError(error) };
  }

  const initializeBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: CANDIDATE_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "devspace-stable-gateway-candidate", version: "0.5.0" },
    },
  };

  let backendSessionId;
  let negotiatedProtocol = CANDIDATE_PROTOCOL_VERSION;
  try {
    const initialized = await mcpPost(coreBase, authorization, initializeBody);
    backendSessionId = String(initialized.headers.get("mcp-session-id") ?? "").trim();
    negotiatedProtocol = String(initialized.payload?.result?.protocolVersion ?? CANDIDATE_PROTOCOL_VERSION);
    if (!initialized.ok || !backendSessionId || !initialized.payload?.result) {
      return { ok: false, stage: "mcp-initialize", status: initialized.status };
    }
    const notification = await mcpPost(coreBase, authorization, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }, {
      backendSessionId,
      protocolVersion: negotiatedProtocol,
    });
    if (!notification.ok) return { ok: false, stage: "mcp-initialized", status: notification.status };
  } catch (error) {
    return { ok: false, stage: "mcp-initialize", status: null, ...safeError(error) };
  }

  let tools;
  try {
    const listed = await mcpPost(coreBase, authorization, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }, {
      backendSessionId,
      protocolVersion: negotiatedProtocol,
    });
    tools = listed.payload?.result?.tools;
    if (!listed.ok || !Array.isArray(tools)) {
      return { ok: false, stage: "tools-list", status: listed.status };
    }
    if (tools.length === 0) {
      return { ok: false, stage: "tools-list", status: listed.status, emptyToolSurface: true };
    }
  } catch (error) {
    return { ok: false, stage: "tools-list", status: null, ...safeError(error) };
  }

  const fingerprint = schemaFingerprint(tools);
  if (fingerprint !== expectedFingerprint) {
    if (allowSchemaChange === true) {
      return {
        ok: true,
        stage: "schema-change-compatible",
        schemaChanged: true,
        resource: expectedResource,
        issuer: expectedIssuer,
        scopes: [...authorizationServer.scopes_supported],
        schemaFingerprint: fingerprint,
        previousSchemaFingerprint: expectedFingerprint,
        toolCount: tools.length,
        protocolVersion: negotiatedProtocol,
        requiresFreshInitialize: true,
      };
    }
    return {
      ok: false,
      stage: "schema",
      schemaFingerprint: fingerprint,
      expectedSchemaFingerprint: expectedFingerprint,
      toolCount: tools.length,
    };
  }

  return {
    ok: true,
    stage: "compatible",
    resource: expectedResource,
    issuer: expectedIssuer,
    scopes: [...authorizationServer.scopes_supported],
    schemaFingerprint: fingerprint,
    toolCount: tools.length,
    protocolVersion: negotiatedProtocol,
    schemaChanged: false,
    requiresFreshInitialize: false,
  };
}
