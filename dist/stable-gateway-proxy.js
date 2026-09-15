import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { schemaFingerprint } from "./stable-gateway-candidate.js";

const MAX_TOOL_LIST_CAPTURE_BYTES = 4 * 1024 * 1024;
function clientSessionFingerprint(headers = {}) {
  for (const name of ["x-openai-session", "oai-session-id", "openai-session-id"]) {
    const raw = Array.isArray(headers?.[name]) ? headers[name][0] : headers?.[name];
    const value = String(raw ?? "").trim();
    if (value) return createHash("sha256").update(value).digest("hex");
  }
  return null;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function requireCore(core) {
  const id = String(core?.id ?? "").trim();
  const baseUrl = String(core?.baseUrl ?? "").trim();
  if (!id) throw new Error("Stable Gateway Core id is required.");
  if (!baseUrl) throw new Error("Stable Gateway Core baseUrl is required.");
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported Core protocol: ${parsed.protocol}`);
  }
  return { id, baseUrl: parsed.toString().replace(/\/$/, "") };
}

function copyHeaders(headers, { omitSession = false } = {}) {
  const result = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === "host") continue;
    if (omitSession && lower === "mcp-session-id") continue;
    if (value !== undefined) result[name] = value;
  }
  return result;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function parseJsonBody(buffer) {
  if (!buffer?.length) return undefined;
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return undefined;
  }
}

function parseMcpPayload(value) {
  const raw = Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
  const text = raw.trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try { return JSON.parse(data); } catch {}
  }
  return null;
}

class StaleSessionSchemaError extends Error {
  constructor(message = "MCP tool schema changed; reinitialize the session.") {
    super(message);
    this.name = "StaleSessionSchemaError";
    this.code = "MCP_SCHEMA_STALE";
  }
}

function isInitialize(body) {
  return body?.method === "initialize";
}

function isInitializedNotification(body) {
  return body?.method === "notifications/initialized";
}

function sendGatewayError(res, statusCode, message) {
  if (res.headersSent) {
    res.destroy(new Error(message));
    return;
  }
  const payload = Buffer.from(JSON.stringify({ error: message }));
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(payload.length));
  res.end(payload);
}

function setResponseHeaders(res, headers, publicSessionId) {
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === "mcp-session-id") continue;
    if (value !== undefined) res.setHeader(name, value);
  }
  if (publicSessionId) res.setHeader("mcp-session-id", publicSessionId);
}

function requestCoreJson(core, body, { authorization, backendSessionId } = {}) {
  const target = new URL("/mcp", `${core.baseUrl}/`);
  const payload = Buffer.from(JSON.stringify(body));
  const requestFn = target.protocol === "https:" ? httpsRequest : httpRequest;
  const protocolVersion = body?.params?.protocolVersion;
  return new Promise((resolve, reject) => {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "content-length": String(payload.length),
      ...(authorization ? { authorization } : {}),
      ...(backendSessionId ? { "mcp-session-id": backendSessionId } : {}),
      ...(backendSessionId && protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
    };
    const req = requestFn({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: "POST",
      path: target.pathname,
      headers,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.once("end", () => resolve({
        status: res.statusCode ?? 502,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
      res.once("error", reject);
    });
    req.once("error", reject);
    req.end(payload);
  });
}

export function createStableGatewayProxy({
  activeCore,
  publicBaseUrl,
  registry,
  activityJournal = null,
} = {}) {
  if (!registry || typeof registry.registerInitialize !== "function" || typeof registry.acquire !== "function") {
    throw new Error("Stable Gateway registry is required.");
  }
  // Raw proxy/tool telemetry is never a source of user-visible narration. The
  // floating progress card accepts only explicit agent-authored updates through
  // devspace_progress_report. Keep the structured activity journal for diagnostics
  // and liveness evidence, but never project those records as card prose.
  const externalBaseUrl = new URL(String(publicBaseUrl ?? ""));
  let currentCore = requireCore(activeCore);
  const resurrectionLocks = new Map();

  const readBackendToolSchema = async (core, { authorization, backendSessionId } = {}) => {
    const listed = await requestCoreJson(core, {
      jsonrpc: "2.0",
      id: "devspace-schema-fingerprint",
      method: "tools/list",
      params: {},
    }, {
      authorization,
      backendSessionId,
    });
    const payload = parseMcpPayload(listed.body);
    const tools = payload?.result?.tools;
    if (listed.status < 200 || listed.status >= 300 || !Array.isArray(tools)) {
      throw new Error(`Core tools/list schema probe failed with HTTP ${listed.status}.`);
    }
    return {
      schemaFingerprint: schemaFingerprint(tools),
      toolCount: tools.length,
    };
  };

  const assertSessionSchemaCompatible = (descriptor, current, { allowSchemaChange = false } = {}) => {
    if (!descriptor?.initialized) return false;
    if (!descriptor.schemaFingerprint || descriptor.schemaFingerprint !== current.schemaFingerprint) {
      if (allowSchemaChange) return true;
      throw new StaleSessionSchemaError();
    }
    return false;
  };

  const stampInitializedSessionSchema = async (core, publicSessionId, authorization) => {
    const before = registry.lookup(publicSessionId);
    if (!before?.backendSessionId || before.coreId !== core.id) return false;
    const currentSchema = await readBackendToolSchema(core, {
      authorization,
      backendSessionId: before.backendSessionId,
    });
    const after = registry.lookup(publicSessionId);
    if (!after || after.coreId !== core.id || after.backendSessionId !== before.backendSessionId) return false;
    return registry.updateSchema?.(publicSessionId, currentSchema) === true;
  };

  const setActiveCore = (core) => {
    currentCore = requireCore(core);
    return { ...currentCore };
  };

  const getActiveCore = () => ({ ...currentCore });

  const replaySessionsToCore = async (coreInput) => {
    const nextCore = requireCore(coreInput);
    const mappings = [];
    const droppedPublicSessionIds = [];
    for (const session of registry.entriesForReplay()) {
      try {
        const initialized = await requestCoreJson(nextCore, session.initializeBody, {
          authorization: session.authorization,
        });
        const backendSessionId = String(initialized.headers["mcp-session-id"] ?? "").trim();
        if (initialized.status < 200 || initialized.status >= 300 || !backendSessionId) {
          throw new Error("initialize-replay-failed");
        }
        if (session.initialized) {
          const initializedNotification = {
            jsonrpc: "2.0",
            method: "notifications/initialized",
            params: {},
          };
          const notificationResult = await requestCoreJson(nextCore, initializedNotification, {
            authorization: session.authorization,
            backendSessionId,
          });
          if (notificationResult.status < 200 || notificationResult.status >= 300) {
            throw new Error("initialized-notification-replay-failed");
          }
        }
        const currentSchema = await readBackendToolSchema(nextCore, {
          authorization: session.authorization,
          backendSessionId,
        });
        assertSessionSchemaCompatible(session, currentSchema);
        registry.updateSchema?.(session.publicSessionId, currentSchema);
        mappings.push({
          publicSessionId: session.publicSessionId,
          coreId: nextCore.id,
          backendSessionId,
        });
      } catch (error) {
        if (error?.code === "MCP_SCHEMA_STALE") registry.remove?.(session.publicSessionId);
        else registry.invalidateMapping?.(session.publicSessionId);
        droppedPublicSessionIds.push(session.publicSessionId);
        try {
          activityJournal?.noteSystem?.({
            title: "Stale MCP session dropped",
            detail: `${nextCore.id}: ${error instanceof Error ? error.message : "session replay failed"}`,
            state: "failed",
          });
        } catch {}
      }
    }
    return { mappings, droppedPublicSessionIds };
  };

  const resurrectSession = async (publicSessionId, authorization) => {
    const id = String(publicSessionId || "").trim();
    if (!id) throw new Error("MCP session resurrection requires a public session id.");
    const requestAuthorization = String(authorization || "").trim();
    if (resurrectionLocks.has(id)) return await resurrectionLocks.get(id);
    const promise = (async () => {
      const descriptor = registry.lookup(id);
      if (!descriptor?.initializeBody) throw new Error("MCP session descriptor is unavailable for resurrection.");
      const currentAuthorization = requestAuthorization || String(descriptor.authorization || "").trim();
      if (!currentAuthorization) throw new Error("MCP session resurrection requires request or retained authorization.");
      const initialized = await requestCoreJson(currentCore, descriptor.initializeBody, {
        authorization: currentAuthorization,
      });
      const backendSessionId = String(initialized.headers["mcp-session-id"] ?? "").trim();
      if (initialized.status < 200 || initialized.status >= 300 || !backendSessionId) {
        throw new Error(`Core session resurrection initialize failed with HTTP ${initialized.status}.`);
      }
      if (descriptor.initialized) {
        const ready = await requestCoreJson(currentCore, {
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        }, {
          authorization: currentAuthorization,
          backendSessionId,
        });
        if (ready.status < 200 || ready.status >= 300) {
          throw new Error(`Core session resurrection initialized notification failed with HTTP ${ready.status}.`);
        }
      }
      const currentSchema = await readBackendToolSchema(currentCore, {
        authorization: currentAuthorization,
        backendSessionId,
      });
      // A restored public session may legitimately carry a descriptor from an
      // older Core build. Returning 404 here made ChatGPT disable the entire
      // MCP namespace instead of issuing a fresh tools/list. Keep the stable
      // public session, adopt the current Core schema, and let the initialized
      // notification/tool-list refresh bring the host catalog forward. Strict
      // schema rejection remains in replaySessionsToCore, where a handover is
      // explicitly validating a candidate build before promotion.
      const schemaChanged = assertSessionSchemaCompatible(descriptor, currentSchema, { allowSchemaChange: true });
      registry.commitMappings([{ publicSessionId: id, coreId: currentCore.id, backendSessionId }]);
      registry.updateAuthorization(id, currentAuthorization);
      registry.updateSchema?.(id, currentSchema);
      return { ...registry.lookup(id), schemaChanged };
    })().finally(() => resurrectionLocks.delete(id));
    resurrectionLocks.set(id, promise);
    return await promise;
  };

  const promoteCore = async (coreInput) => {
    const nextCore = requireCore(coreInput);
    registry.beginBarrier();
    try {
      await registry.waitForDrain();
      const replayed = await replaySessionsToCore(nextCore);
      registry.commitMappings(replayed.mappings);
      currentCore = nextCore;
      return {
        activeCore: { ...currentCore },
        replayedSessions: replayed.mappings.length,
        droppedSessions: replayed.droppedPublicSessionIds.length,
      };
    } finally {
      registry.abortBarrier();
    }
  };

  const handle = async (req, res) => {
    const core = currentCore;
    const bodyBuffer = await readBody(req);
    const parsedBody = parseJsonBody(bodyBuffer);
    let activity = null;
    if (parsedBody?.method === "tools/call" && typeof activityJournal?.startToolCall === "function") {
      try {
        activity = activityJournal.startToolCall({
          toolName: parsedBody?.params?.name,
          arguments: parsedBody?.params?.arguments,
        });
      } catch {}
    }
    let activityFinished = false;
    const finishActivity = ({ ok, statusCode, error } = {}) => {
      if (activityFinished || !activity?.id || typeof activityJournal?.finishToolCall !== "function") return;
      activityFinished = true;
      try { activityJournal.finishToolCall(activity.id, { ok, statusCode, error }); } catch {}
    };
    let publicSessionId = String(req.headers["mcp-session-id"] ?? "").trim() || undefined;
    const requestClientSessionFingerprint = clientSessionFingerprint(req.headers);
    const requestAuthorization = String(req.headers.authorization ?? "").trim();
    const requestPath = new URL(req.url || "/", `${externalBaseUrl}/`).pathname;
    const initializeRequest = req.method === "POST" && isInitialize(parsedBody);
    const replayableMcpStream = req.method === "GET" && requestPath === "/mcp";
    let trackedSessionId;
    let publicEventStreamOpened = false;
    let mapping;

    if (!publicSessionId && requestPath === "/mcp") {
      await registry.waitForAdmission();
    }

    if (publicSessionId) {
      await registry.waitForAdmission();
      const resolvedPublicSessionId = registry.resolvePublicSessionId?.(publicSessionId, requestClientSessionFingerprint) || publicSessionId;
      publicSessionId = resolvedPublicSessionId;
      let descriptor = registry.lookup(publicSessionId);
      if (!descriptor) {
        finishActivity({ ok: false, statusCode: 404, error: "Unknown public MCP session" });
        sendGatewayError(res, 404, "Unknown public MCP session");
        return;
      }
      const currentAuthorization = requestAuthorization;
      // Never replace a healthy backend mapping merely because a public MCP
      // session has been quiet. ChatGPT keeps GET /mcp event streams open for
      // long periods and the Gateway deliberately excludes those streams from
      // handover drain accounting. The former wall-clock idle heuristic therefore
      // created a second backend session while the original SSE transport was
      // still alive, then repeated until Core hit its session and heap limits.
      // Exact downstream 404 handling below already performs one safe,
      // single-flight resurrection when the Core has genuinely forgotten the
      // backend session.
      const mappingNeedsResurrection = descriptor.coreId !== core.id;
      if (mappingNeedsResurrection) {
        try {
          descriptor = await resurrectSession(publicSessionId, currentAuthorization);
        } catch (error) {
          const staleSchema = error?.code === "MCP_SCHEMA_STALE";
          const statusCode = staleSchema ? 404 : 502;
          const message = error instanceof Error ? error.message : "MCP session resurrection failed";
          finishActivity({ ok: false, statusCode, error: message });
          sendGatewayError(res, statusCode, message);
          return;
        }
      }
      if (replayableMcpStream) {
        mapping = registry.lookup(publicSessionId);
      } else {
        mapping = await registry.acquire(publicSessionId);
        trackedSessionId = mapping ? publicSessionId : undefined;
      }
      if (!mapping) {
        finishActivity({ ok: false, statusCode: 404, error: "Unknown public MCP session" });
        sendGatewayError(res, 404, "Unknown public MCP session");
        return;
      }
      if (currentAuthorization && currentAuthorization !== mapping.authorization) {
        registry.updateAuthorization(publicSessionId, currentAuthorization);
        mapping.authorization = currentAuthorization;
      }
      if (replayableMcpStream) {
        publicEventStreamOpened = registry.markEventStreamOpen?.(publicSessionId) === true;
      }
    }

    const target = new URL(req.url || "/", `${core.baseUrl}/`);
    const requestFn = target.protocol === "https:" ? httpsRequest : httpRequest;
    let released = false;
    const releaseTracked = () => {
      if (released || !trackedSessionId) return;
      released = true;
      registry.release(trackedSessionId);
    };
    const buildUpstreamHeaders = () => {
      const headers = copyHeaders(req.headers, { omitSession: initializeRequest });
      headers.host = target.host;
      // Carry only the Gateway-derived hash into the loopback Core so repeated
      // ChatGPT initialize requests can retire the prior transport even when the
      // host does not forward the original OpenAI session header consistently.
      // Always overwrite/remove a caller-supplied value; this is internal
      // lifecycle metadata, never an external authority credential.
      const boundClientSessionFingerprint = requestClientSessionFingerprint
        || mapping?.clientSessionFingerprint
        || null;
      if (boundClientSessionFingerprint) {
        headers["x-devspace-client-session-fingerprint"] = boundClientSessionFingerprint;
      } else {
        delete headers["x-devspace-client-session-fingerprint"];
      }
      if (publicSessionId && mapping) headers["mcp-session-id"] = mapping.backendSessionId;
      else if (initializeRequest) delete headers["mcp-session-id"];
      return headers;
    };

    await new Promise((resolve) => {
      let activeUpstream = null;
      let completed = false;
      const complete = ({ downstreamDisconnected = false } = {}) => {
        if (completed) return;
        completed = true;
        try { req.removeListener?.("aborted", onAborted); } catch {}
        try { res.removeListener?.("close", onResponseClosed); } catch {}
        if (publicEventStreamOpened && publicSessionId) {
          publicEventStreamOpened = false;
          registry.markEventStreamClosed?.(publicSessionId, { disconnected: downstreamDisconnected });
        }
        resolve();
      };
      const failFinal = (statusCode, message, error) => {
        if (completed) return;
        finishActivity({ ok: false, statusCode, error: message });
        releaseTracked();
        complete();
        if (!res.headersSent) sendGatewayError(res, statusCode, message);
        else if (!res.writableEnded && !res.destroyed) res.destroy(error instanceof Error ? error : new Error(message));
      };
      const cancelUpstream = (message) => {
        if (completed) return;
        const error = new Error(message);
        finishActivity({ ok: false, statusCode: 499, error: message });
        releaseTracked();
        complete({ downstreamDisconnected: true });
        try { activeUpstream?.destroy(error); } catch {}
      };
      const onAborted = () => cancelUpstream("Client request aborted.");
      const onResponseClosed = () => {
        if (res.writableEnded) return;
        cancelUpstream("Client response closed.");
      };
      req.once("aborted", onAborted);
      res.once("close", onResponseClosed);

      const pipeFinalResponse = (upstreamRes, responsePublicSessionId) => {
        res.statusCode = upstreamRes.statusCode ?? 502;
        setResponseHeaders(res, upstreamRes.headers, responsePublicSessionId);
        const captureToolList = Boolean(publicSessionId && parsedBody?.method === "tools/list");
        const schemaChunks = [];
        let schemaBytes = 0;
        let schemaOverflow = false;
        upstreamRes.on("data", (chunk) => {
          if (captureToolList && !schemaOverflow) {
            const data = Buffer.from(chunk);
            if (schemaBytes + data.length <= MAX_TOOL_LIST_CAPTURE_BYTES) {
              schemaChunks.push(data);
              schemaBytes += data.length;
            } else {
              schemaOverflow = true;
              schemaChunks.length = 0;
            }
          }
          if (!res.writableEnded) res.write(chunk);
        });
        upstreamRes.once("end", () => {
          if (captureToolList && !schemaOverflow && res.statusCode < 400) {
            const payload = parseMcpPayload(Buffer.concat(schemaChunks, schemaBytes));
            const tools = payload?.result?.tools;
            if (Array.isArray(tools)) {
              registry.updateSchema?.(publicSessionId, {
                schemaFingerprint: schemaFingerprint(tools),
                toolCount: tools.length,
              });
            }
          }
          if (publicSessionId && isInitializedNotification(parsedBody) && res.statusCode < 400) {
            registry.markInitialized(publicSessionId);
          }
          if (initializeRequest && responsePublicSessionId && res.statusCode < 400) {
            void stampInitializedSessionSchema(core, responsePublicSessionId, requestAuthorization).catch(() => {});
          }
          if (publicSessionId && req.method === "DELETE" && res.statusCode < 400) {
            registry.remove?.(publicSessionId);
          }
          finishActivity({ ok: res.statusCode < 400, statusCode: res.statusCode, error: res.statusCode >= 400 ? `Core HTTP ${res.statusCode}` : null });
          releaseTracked();
          if (!res.writableEnded) res.end();
          complete();
        });
        upstreamRes.once("error", (error) => {
          failFinal(502, "Core response failed", error);
        });
      };

      const sendAttempt = ({ allowUnknownSessionRecovery }) => {
        if (completed) return;
        const upstreamHeaders = buildUpstreamHeaders();
        const upstream = requestFn({
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port,
          method: req.method,
          path: `${target.pathname}${target.search}`,
          headers: upstreamHeaders,
        }, (upstreamRes) => {
          const exactUnknownSession = Boolean(
            allowUnknownSessionRecovery
            && publicSessionId
            && !initializeRequest
            && requestPath === "/mcp"
            && upstreamRes.statusCode === 404
          );
          if (exactUnknownSession) {
            upstreamRes.resume();
            upstreamRes.once("end", () => {
              void resurrectSession(publicSessionId, requestAuthorization)
                .then((nextMapping) => {
                  if (completed) return;
                  mapping = nextMapping;
                  sendAttempt({ allowUnknownSessionRecovery: false });
                })
                .catch((error) => {
                  failFinal(502, error instanceof Error ? error.message : "MCP session resurrection failed", error);
                });
            });
            return;
          }

          let responsePublicSessionId = publicSessionId;
          if (initializeRequest) {
            const backendSessionId = String(upstreamRes.headers["mcp-session-id"] ?? "").trim();
            if (!backendSessionId) {
              upstreamRes.resume();
              failFinal(502, "Core initialize response did not provide an MCP session id");
              return;
            }
            try {
              responsePublicSessionId = registry.registerInitialize({
                coreId: core.id,
                backendSessionId,
                initializeBody: parsedBody,
                authorization: requestAuthorization,
                clientSessionFingerprint: requestClientSessionFingerprint,
              });
            } catch (error) {
              upstreamRes.resume();
              failFinal(502, error instanceof Error ? error.message : String(error), error);
              return;
            }
          }
          pipeFinalResponse(upstreamRes, responsePublicSessionId);
        });
        activeUpstream = upstream;
        upstream.once("error", (error) => {
          if (completed) return;
          failFinal(502, error instanceof Error ? error.message : "Core request failed", error);
        });
        if (bodyBuffer.length) upstream.write(bodyBuffer);
        upstream.end();
      };

      sendAttempt({ allowUnknownSessionRecovery: true });
    });
  };

  const handler = (req, res) => {
    void handle(req, res).catch((error) => {
      sendGatewayError(res, 500, error instanceof Error ? error.message : String(error));
    });
  };

  return {
    handler,
    setActiveCore,
    getActiveCore,
    replaySessionsToCore,
    promoteCore,
    publicBaseUrl: externalBaseUrl.toString().replace(/\/$/, ""),
  };
}
