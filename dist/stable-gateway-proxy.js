import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_BACKEND_SESSION_REINIT_IDLE_MS = 25_000;
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

function requestCoreJson(core, body, { authorization, backendSessionId, timeoutMs }) {
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
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Core replay timed out after ${timeoutMs}ms.`)));
    req.once("error", reject);
    req.end(payload);
  });
}

export function createStableGatewayProxy({
  activeCore,
  publicBaseUrl,
  registry,
  activityJournal = null,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  backendSessionReinitIdleMs = DEFAULT_BACKEND_SESSION_REINIT_IDLE_MS,
} = {}) {
  if (!registry || typeof registry.registerInitialize !== "function" || typeof registry.acquire !== "function") {
    throw new Error("Stable Gateway registry is required.");
  }
  const externalBaseUrl = new URL(String(publicBaseUrl ?? ""));
  let currentCore = requireCore(activeCore);
  const timeoutMs = Number(requestTimeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("requestTimeoutMs must be positive.");
  const reinitIdleMs = Math.max(1_000, Number(backendSessionReinitIdleMs) || DEFAULT_BACKEND_SESSION_REINIT_IDLE_MS);
  const resurrectionLocks = new Map();

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
          timeoutMs,
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
            timeoutMs,
          });
          if (notificationResult.status < 200 || notificationResult.status >= 300) {
            throw new Error("initialized-notification-replay-failed");
          }
        }
        mappings.push({
          publicSessionId: session.publicSessionId,
          coreId: nextCore.id,
          backendSessionId,
        });
      } catch (error) {
        registry.invalidateMapping?.(session.publicSessionId);
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
    const currentAuthorization = String(authorization || "").trim();
    if (!currentAuthorization) throw new Error("MCP session resurrection requires the current request authorization.");
    if (resurrectionLocks.has(id)) return await resurrectionLocks.get(id);
    const promise = (async () => {
      const descriptor = registry.lookup(id);
      if (!descriptor?.initializeBody) throw new Error("MCP session descriptor is unavailable for resurrection.");
      const initialized = await requestCoreJson(currentCore, descriptor.initializeBody, {
        authorization: currentAuthorization,
        timeoutMs,
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
          timeoutMs,
        });
        if (ready.status < 200 || ready.status >= 300) {
          throw new Error(`Core session resurrection initialized notification failed with HTTP ${ready.status}.`);
        }
      }
      registry.commitMappings([{ publicSessionId: id, coreId: currentCore.id, backendSessionId }]);
      registry.updateAuthorization(id, currentAuthorization);
      return registry.lookup(id);
    })().finally(() => resurrectionLocks.delete(id));
    resurrectionLocks.set(id, promise);
    return await promise;
  };

  const promoteCore = async (coreInput, { drainTimeoutMs = timeoutMs } = {}) => {
    const nextCore = requireCore(coreInput);
    registry.beginBarrier();
    try {
      await registry.waitForDrain(drainTimeoutMs);
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
    const publicSessionId = String(req.headers["mcp-session-id"] ?? "").trim() || undefined;
    const requestAuthorization = String(req.headers.authorization ?? "").trim();
    const requestPath = new URL(req.url || "/", `${externalBaseUrl}/`).pathname;
    const initializeRequest = req.method === "POST" && isInitialize(parsedBody);
    const replayableMcpStream = req.method === "GET" && requestPath === "/mcp";
    let trackedSessionId;
    let mapping;

    if (!publicSessionId && requestPath === "/mcp") {
      await registry.waitForAdmission(timeoutMs);
    }

    if (publicSessionId) {
      await registry.waitForAdmission(timeoutMs);
      let descriptor = registry.lookup(publicSessionId);
      if (!descriptor) {
        finishActivity({ ok: false, statusCode: 404, error: "Unknown public MCP session" });
        sendGatewayError(res, 404, "Unknown public MCP session");
        return;
      }
      const currentAuthorization = requestAuthorization;
      const mappingIdleAge = Math.max(0, Date.now() - Number(descriptor.lastActivityAt || Date.now()));
      const mappingNeedsResurrection = descriptor.coreId !== core.id || mappingIdleAge >= reinitIdleMs;
      if (mappingNeedsResurrection) {
        try {
          descriptor = await resurrectSession(publicSessionId, currentAuthorization);
        } catch (error) {
          finishActivity({ ok: false, statusCode: 502, error: error instanceof Error ? error.message : "MCP session resurrection failed" });
          sendGatewayError(res, 502, error instanceof Error ? error.message : "MCP session resurrection failed");
          return;
        }
      }
      if (replayableMcpStream) {
        mapping = registry.lookup(publicSessionId);
      } else {
        mapping = await registry.acquire(publicSessionId, { timeoutMs });
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
      if (publicSessionId && mapping) headers["mcp-session-id"] = mapping.backendSessionId;
      else if (initializeRequest) delete headers["mcp-session-id"];
      return headers;
    };

    await new Promise((resolve) => {
      let activeUpstream = null;
      let completed = false;
      const complete = () => {
        if (completed) return;
        completed = true;
        try { req.removeListener?.("aborted", onAborted); } catch {}
        resolve();
      };
      const failFinal = (statusCode, message, error) => {
        finishActivity({ ok: false, statusCode, error: message });
        releaseTracked();
        if (!res.headersSent) sendGatewayError(res, statusCode, message);
        else if (!res.writableEnded) res.destroy(error instanceof Error ? error : new Error(message));
        complete();
      };
      const onAborted = () => {
        try { activeUpstream?.destroy(new Error("Client request aborted.")); } catch {}
        failFinal(499, "Client request aborted");
      };
      req.once("aborted", onAborted);

      const pipeFinalResponse = (upstreamRes, responsePublicSessionId) => {
        res.statusCode = upstreamRes.statusCode ?? 502;
        setResponseHeaders(res, upstreamRes.headers, responsePublicSessionId);
        upstreamRes.on("data", (chunk) => {
          if (!res.writableEnded) res.write(chunk);
        });
        upstreamRes.once("end", () => {
          if (publicSessionId && isInitializedNotification(parsedBody) && res.statusCode < 400) {
            registry.markInitialized(publicSessionId);
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
        upstream.setTimeout(timeoutMs, () => {
          upstream.destroy(new Error(`Core request timed out after ${timeoutMs}ms.`));
        });
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
