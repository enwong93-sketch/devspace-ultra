import { ClassicCdpClient } from "./classic-cdp-client.js";
import { StringDecoder } from "node:string_decoder";
import { ClassicTurnIdentityCorrelator, parseClassicTurnRequest } from "./context-guardian-cdp.js";
import { sessionFingerprintFromClassicRequest } from "./classic-conversation-authority.js";
import { defaultMainDebugPorts } from "./goal-host-bridge.js";
import { runtimeKeyForPort } from "./classic-stream-recovery-cdp.js";
import { isNativeCallMcpRequest, parseNativeCallMcpRequest } from "./classic-mcp-call-correlation.js";
import { ClassicToolInvocationStreamTracker } from "./classic-tool-invocation-stream.js";
import { mergeTraceCorrelationFingerprints, requestTraceCorrelationFingerprints } from "./request-trace-correlation.js";
import { mergeSessionCorrelationFingerprints, sessionCorrelationFingerprintsFromHeaders } from "./session-correlation.js";

const DEFAULT_CONNECTION_POLL_MS = 15_000;
const DEFAULT_PROBE_TIMEOUT_MS = 700;
const DEFAULT_PENDING_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_PENDING = 128;
const MAX_STREAM_BUFFER_CHARS = 512 * 1024;
const MAX_STREAM_BUFFERS = 16;

function observedAt(ms = Date.now()) { return new Date(ms).toISOString(); }

function isTurnUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.hostname === "chatgpt.com" && parsed.pathname === "/backend-api/f/conversation";
  } catch { return false; }
}

function conversationIdFromUrl(url) {
  try {
    return new URL(String(url || "")).pathname.match(/\/c\/([^/?#]+)/)?.[1] || null;
  } catch { return null; }
}

function decodedNetworkData(value, { base64Encoded = false, decoder = null } = {}) {
  const raw = String(value ?? "");
  if (!raw) return "";
  if (base64Encoded) {
    try {
      const bytes = Buffer.from(raw, "base64");
      return decoder instanceof StringDecoder ? decoder.write(bytes) : bytes.toString("utf8");
    } catch { return ""; }
  }
  if (/^(?:data:|event:|\s*[\[{])/.test(raw)) return raw;
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    if (/^(?:data:|event:|\s*[\[{])/.test(decoded) || /\n(?:data:|event:)/.test(decoded)) return decoded;
  } catch {}
  return raw;
}

async function fetchJson(url, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable for Classic turn transport observer.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export class ClassicTurnTransportTracker {
  constructor({
    now = () => Date.now(),
    pendingTtlMs = DEFAULT_PENDING_TTL_MS,
    maxPending = DEFAULT_MAX_PENDING,
    onConversationIdentity,
    onTurnTransportEvent,
    onNativeMcpCall,
    onToolInvocation,
    onActiveTurn,
  } = {}) {
    this.now = now;
    this.pendingTtlMs = Math.max(1_000, Number(pendingTtlMs) || DEFAULT_PENDING_TTL_MS);
    this.maxPending = Math.max(1, Number(maxPending) || DEFAULT_MAX_PENDING);
    this.pending = new Map();
    this.identity = new ClassicTurnIdentityCorrelator({ now, pendingTtlMs: this.pendingTtlMs, maxPending: this.maxPending });
    this.onConversationIdentity = typeof onConversationIdentity === "function" ? onConversationIdentity : null;
    this.onTurnTransportEvent = typeof onTurnTransportEvent === "function" ? onTurnTransportEvent : null;
    this.onNativeMcpCall = typeof onNativeMcpCall === "function" ? onNativeMcpCall : null;
    this.onToolInvocation = typeof onToolInvocation === "function" ? onToolInvocation : null;
    this.onActiveTurn = typeof onActiveTurn === "function" ? onActiveTurn : null;
    this.toolInvocationStream = new ClassicToolInvocationStreamTracker({ now });
    this.responseBuffers = new Map();
    this.responseDecoders = new Map();
  }

  get pendingSize() { return this.pending.size; }

  noteRequest(params = {}) {
    const nativeMcpCall = parseNativeCallMcpRequest(params?.request);
    if (nativeMcpCall) {
      this.#emitNativeMcpCall({ ...nativeMcpCall, observedAt: observedAt(this.now()), observedAtMs: this.now() });
      return nativeMcpCall;
    }
    const metadata = parseClassicTurnRequest(params?.request);
    if (!metadata?.conversationId) return null;
    const requestId = String(params?.requestId || "").trim();
    if (!requestId) return null;
    this.prune();
    const firstSeenAt = this.now();
    this.pending.set(requestId, {
      conversationId: metadata.conversationId,
      firstSeenAt,
      localFunctionNames: metadata.localFunctionNames || [],
      turnTraceFingerprint: metadata.turnTraceFingerprint || null,
      sessionFingerprint: metadata.sessionFingerprint || null,
      sessionCorrelationFingerprints: mergeSessionCorrelationFingerprints(metadata.sessionCorrelationFingerprints),
      traceCorrelationFingerprints: mergeTraceCorrelationFingerprints(metadata.traceCorrelationFingerprints),
    });
    this.#enforceCap();
    this.#emitActiveTurn({
      kind: "started",
      requestId,
      conversationId: metadata.conversationId,
      localFunctionNames: metadata.localFunctionNames || [],
      turnTraceFingerprint: metadata.turnTraceFingerprint || null,
      sessionFingerprint: metadata.sessionFingerprint || null,
      sessionCorrelationFingerprints: mergeSessionCorrelationFingerprints(metadata.sessionCorrelationFingerprints),
      traceCorrelationFingerprints: mergeTraceCorrelationFingerprints(metadata.traceCorrelationFingerprints),
      observedAt: observedAt(firstSeenAt),
      observedAtMs: firstSeenAt,
    });
    this.#emitTransport({ conversationId: metadata.conversationId, kind: "request", observedAt: observedAt(firstSeenAt) });
    this.#emitIdentity(this.identity.noteRequest(params));
    return metadata;
  }

  noteExtraInfo(params = {}) {
    const requestId = String(params?.requestId || "").trim();
    const entry = requestId ? this.pending.get(requestId) : null;
    if (entry) {
      const atMs = this.now();
      const traceCorrelationFingerprints = mergeTraceCorrelationFingerprints(
        entry.traceCorrelationFingerprints,
        requestTraceCorrelationFingerprints(params?.headers || {}),
      );
      const sessionCorrelationFingerprints = mergeSessionCorrelationFingerprints(
        entry.sessionCorrelationFingerprints,
        sessionCorrelationFingerprintsFromHeaders(params?.headers || {}),
      );
      const metadataSession = sessionFingerprintFromClassicRequest({ headers: params?.headers || {} });
      entry.traceCorrelationFingerprints = traceCorrelationFingerprints;
      entry.sessionCorrelationFingerprints = sessionCorrelationFingerprints;
      if (metadataSession) entry.sessionFingerprint = metadataSession;
      this.pending.set(requestId, entry);
      this.#emitActiveTurn({
        kind: "metadata",
        requestId,
        conversationId: entry.conversationId,
        sessionFingerprint: entry.sessionFingerprint || null,
        sessionCorrelationFingerprints,
        traceCorrelationFingerprints,
        observedAt: observedAt(atMs),
        observedAtMs: atMs,
      });
    }
    this.#emitIdentity(this.identity.noteExtraInfo(params));
  }

  noteResponse(params = {}) {
    const requestId = String(params?.requestId || "").trim();
    const entry = requestId ? this.pending.get(requestId) : null;
    if (!entry || !isTurnUrl(params?.response?.url)) return null;
    this.#emitTransport({
      conversationId: entry.conversationId,
      kind: "response",
      status: Number(params?.response?.status || 0) || null,
      observedAt: observedAt(this.now()),
    });
    return { requestId, conversationId: entry.conversationId };
  }

  noteResponseData({ requestId, data, base64Encoded = false, observedAtMs = this.now() } = {}) {
    const id = String(requestId || "").trim();
    const entry = id ? this.pending.get(id) : null;
    if (!entry?.conversationId) return [];
    let decoder = null;
    if (base64Encoded) {
      decoder = this.responseDecoders.get(id);
      if (!decoder) {
        decoder = new StringDecoder("utf8");
        this.responseDecoders.set(id, decoder);
      }
    }
    const chunk = decodedNetworkData(data, { base64Encoded, decoder });
    if (!chunk) return [];
    const previous = this.responseBuffers.get(id) || "";
    let combined = `${previous}${chunk}`;
    if (combined.length > MAX_STREAM_BUFFER_CHARS) combined = combined.slice(-MAX_STREAM_BUFFER_CHARS);

    const blocks = combined.split(/\r?\n\r?\n/);
    const remainder = blocks.pop() || "";
    const accepted = [];
    for (const block of blocks) {
      accepted.push(...this.toolInvocationStream.notePayload({
        payloadData: block,
        conversationId: entry.conversationId,
        observedAtMs,
      }));
    }
    // Some ChatGPT stream variants deliver one complete JSON envelope without
    // an SSE blank-line delimiter. Parse the bounded remainder as well; the
    // invocation tracker deduplicates it if later chunks repeat the envelope.
    accepted.push(...this.toolInvocationStream.notePayload({
      payloadData: remainder,
      conversationId: entry.conversationId,
      observedAtMs,
    }));
    this.responseBuffers.set(id, remainder.slice(-MAX_STREAM_BUFFER_CHARS));
    while (this.responseBuffers.size > MAX_STREAM_BUFFERS) {
      const oldest = this.responseBuffers.keys().next().value;
      if (!oldest) break;
      this.responseBuffers.delete(oldest);
      this.responseDecoders.delete(oldest);
    }
    for (const event of accepted) this.#emitToolInvocation(event);
    return accepted;
  }

  noteFailure(params = {}) {
    const requestId = String(params?.requestId || "").trim();
    const entry = requestId ? this.pending.get(requestId) : null;
    if (entry) {
      const atMs = this.now();
      this.#emitTransport({
        conversationId: entry.conversationId,
        kind: "failed",
        errorText: String(params?.errorText || "").slice(0, 180),
        canceled: params?.canceled === true,
        blockedReason: params?.blockedReason ? String(params.blockedReason).slice(0, 120) : null,
        observedAt: observedAt(atMs),
      });
      this.#emitActiveTurn({
        kind: "failed",
        requestId,
        conversationId: entry.conversationId,
        errorText: String(params?.errorText || "").slice(0, 180),
        canceled: params?.canceled === true,
        blockedReason: params?.blockedReason ? String(params.blockedReason).slice(0, 120) : null,
        observedAt: observedAt(atMs),
        observedAtMs: atMs,
      });
      this.responseBuffers.delete(requestId);
      this.responseDecoders.delete(requestId);
      this.pending.delete(requestId);
    }
    if (requestId) this.identity.forget(requestId);
  }

  noteFinished(params = {}) {
    const requestId = String(params?.requestId || "").trim();
    const entry = requestId ? this.pending.get(requestId) : null;
    if (entry) {
      const atMs = this.now();
      this.#emitTransport({ conversationId: entry.conversationId, kind: "finished", observedAt: observedAt(atMs) });
      this.#emitActiveTurn({
        kind: "finished",
        transportOnly: true,
        requestId,
        conversationId: entry.conversationId,
        sessionCorrelationFingerprints: entry.sessionCorrelationFingerprints || [],
        traceCorrelationFingerprints: entry.traceCorrelationFingerprints || [],
        observedAt: observedAt(atMs),
        observedAtMs: atMs,
      });
      this.responseBuffers.delete(requestId);
      this.responseDecoders.delete(requestId);
      this.pending.delete(requestId);
    }
    if (requestId) this.identity.forget(requestId);
  }

  noteWebSocketFrame({ payloadData, conversationId, observedAtMs = this.now() } = {}) {
    const events = this.toolInvocationStream.notePayload({
      payloadData,
      conversationId,
      observedAtMs,
    });
    for (const event of events) this.#emitToolInvocation(event);
    return events;
  }

  diagnostics() {
    const invocation = this.toolInvocationStream.diagnostics();
    return {
      ...invocation,
      responseBuffers: this.responseBuffers.size,
      responseBufferChars: [...this.responseBuffers.values()]
        .reduce((sum, value) => sum + String(value || "").length, 0),
      maxResponseBuffers: MAX_STREAM_BUFFERS,
      maxResponseBufferChars: MAX_STREAM_BUFFER_CHARS,
    };
  }

  prune() {
    const cutoff = this.now() - this.pendingTtlMs;
    for (const [requestId, entry] of this.pending) {
      if (Number(entry?.firstSeenAt || 0) < cutoff) {
        const atMs = this.now();
        this.#emitActiveTurn({
          kind: "expired",
          requestId,
          conversationId: entry.conversationId,
          observedAt: observedAt(atMs),
          observedAtMs: atMs,
        });
        this.pending.delete(requestId);
        this.responseBuffers.delete(requestId);
        this.responseDecoders.delete(requestId);
        this.identity.forget(requestId);
      }
    }
    this.#enforceCap();
  }

  #enforceCap() {
    if (this.pending.size <= this.maxPending) return;
    const oldest = [...this.pending.entries()].sort((a, b) => Number(a[1]?.firstSeenAt || 0) - Number(b[1]?.firstSeenAt || 0));
    for (const [requestId, entry] of oldest) {
      if (this.pending.size <= this.maxPending) break;
      const atMs = this.now();
      this.#emitActiveTurn({
        kind: "evicted",
        requestId,
        conversationId: entry?.conversationId || null,
        observedAt: observedAt(atMs),
        observedAtMs: atMs,
      });
      this.pending.delete(requestId);
      this.responseBuffers.delete(requestId);
      this.responseDecoders.delete(requestId);
      this.identity.forget(requestId);
    }
  }

  #emitIdentity(identity) {
    if (!identity || !this.onConversationIdentity) return;
    try { this.onConversationIdentity(identity); } catch {}
  }

  #emitTransport(event) {
    if (!this.onTurnTransportEvent) return;
    try { this.onTurnTransportEvent(event); } catch {}
  }

  #emitNativeMcpCall(event) {
    if (!this.onNativeMcpCall) return;
    try { this.onNativeMcpCall(event); } catch {}
  }

  #emitToolInvocation(event) {
    if (!this.onToolInvocation) return;
    try { this.onToolInvocation(event); } catch {}
  }

  #emitActiveTurn(event) {
    if (!this.onActiveTurn) return;
    try { this.onActiveTurn(event); } catch {}
  }
}

export async function connectClassicTurnTransportPort(port, {
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  onConversationIdentity,
  onTurnTransportEvent,
  onNativeMcpCall,
  onToolInvocation,
  onActiveTurn,
  onDisconnected,
} = {}) {
  let targets;
  try {
    targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, { fetchImpl, timeoutMs: probeTimeoutMs });
  } catch { return null; }
  if (!Array.isArray(targets)) return null;
  const page = targets.find((target) => target?.type === "page" && /chatgpt\.com/i.test(target.url || "") && typeof target.webSocketDebuggerUrl === "string");
  if (!page) return null;

  const runtimeKey = runtimeKeyForPort(port);
  let currentConversationId = conversationIdFromUrl(page.url);
  const client = new ClassicCdpClient(page.webSocketDebuggerUrl, { WebSocketImpl, callTimeoutMs: 3_000, maxPendingCalls: 32 });
  await client.open();
  await client.call("Network.enable", { maxTotalBufferSize: 1_000_000, maxResourceBufferSize: 512_000, enableDurableMessages: false });
  await client.call("Page.enable");
  const tracker = new ClassicTurnTransportTracker({
    onConversationIdentity: (identity) => onConversationIdentity?.({ runtimeKey, port, ...identity, observedAt: observedAt() }),
    onTurnTransportEvent: (event) => onTurnTransportEvent?.({ runtimeKey, port, ...event }),
    onNativeMcpCall: (event) => onNativeMcpCall?.({ runtimeKey, port, ...event }),
    onToolInvocation: (event) => onToolInvocation?.({ runtimeKey, port, ...event }),
    onActiveTurn: (event) => onActiveTurn?.({ runtimeKey, port, ...event }),
  });
  const disposers = [
    client.on("Page.frameNavigated", (params) => {
      if (params?.frame?.parentId) return;
      currentConversationId = conversationIdFromUrl(params?.frame?.url) || null;
    }),
    client.on("Page.navigatedWithinDocument", (params) => {
      currentConversationId = conversationIdFromUrl(params?.url) || null;
    }),
    client.on("Network.requestWillBeSent", (params) => {
      const request = params?.request;
      if (isNativeCallMcpRequest(request) && !request?.postData && params?.requestId) {
        void client.call("Network.getRequestPostData", { requestId: params.requestId })
          .then((result) => tracker.noteRequest({
            ...params,
            request: { ...request, postData: result?.postData || "" },
          }))
          .catch(() => {});
        return;
      }
      tracker.noteRequest(params);
    }),
    client.on("Network.requestWillBeSentExtraInfo", (params) => tracker.noteExtraInfo(params)),
    client.on("Network.responseReceived", (params) => {
      const turn = tracker.noteResponse(params);
      if (!turn?.requestId) return;
      void client.call("Network.streamResourceContent", { requestId: turn.requestId })
        .then((result) => tracker.noteResponseData({
          requestId: turn.requestId,
          data: result?.bufferedData || "",
          base64Encoded: true,
          observedAtMs: Date.now(),
        }))
        .catch(() => {});
    }),
    client.on("Network.dataReceived", (params) => {
      if (!params?.data) return;
      tracker.noteResponseData({
        requestId: params.requestId,
        data: params.data,
        base64Encoded: true,
        observedAtMs: Date.now(),
      });
    }),
    client.on("Network.loadingFailed", (params) => tracker.noteFailure(params)),
    client.on("Network.loadingFinished", (params) => tracker.noteFinished(params)),
    client.on("Network.webSocketFrameReceived", (params) => {
      if (!currentConversationId) return;
      tracker.noteWebSocketFrame({
        payloadData: params?.response?.payloadData,
        conversationId: currentConversationId,
        observedAtMs: Date.now(),
      });
    }),
  ];
  const closeListener = () => { try { onDisconnected?.({ runtimeKey, port }); } catch {} };
  client.ws.addEventListener?.("close", closeListener, { once: true });
  return {
    runtimeKey,
    port,
    connectedAt: observedAt(),
    get pendingSize() { return tracker.pendingSize; },
    get toolInvocationDiagnostics() { return tracker.diagnostics(); },
    async close() {
      for (const dispose of disposers) dispose();
      client.close();
    },
  };
}

export class ClassicTurnTransportObserver {
  constructor({
    ports = defaultMainDebugPorts(),
    connectPort,
    connectionPollMs = DEFAULT_CONNECTION_POLL_MS,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  } = {}) {
    this.ports = [...ports];
    this.connectionPollMs = Math.max(0, Number(connectionPollMs) || 0);
    this.options = { fetchImpl, WebSocketImpl, probeTimeoutMs };
    this.connectPort = connectPort || ((port, handlers) => connectClassicTurnTransportPort(port, { ...this.options, ...handlers }));
    this.sessions = new Map();
    this.handlers = {};
    this.timer = null;
    this.polling = null;
    this.closed = false;
  }

  setHandlers({ onConversationIdentity, onTurnTransportEvent, onNativeMcpCall, onToolInvocation, onActiveTurn } = {}) {
    this.handlers = { onConversationIdentity, onTurnTransportEvent, onNativeMcpCall, onToolInvocation, onActiveTurn };
  }

  async start({ schedule = true } = {}) {
    await this.pollConnections();
    if (schedule && !this.closed && this.connectionPollMs > 0 && !this.timer) {
      this.timer = setInterval(() => { void this.pollConnections(); }, this.connectionPollMs);
      this.timer.unref?.();
    }
    return this.status();
  }

  async pollConnections() {
    if (this.closed) return this.status();
    if (this.polling) return this.polling;
    this.polling = (async () => {
      for (const port of this.ports) {
        const runtimeKey = runtimeKeyForPort(port);
        if (this.sessions.has(runtimeKey)) continue;
        let session = null;
        try {
          session = await this.connectPort(port, {
            ...this.handlers,
            onDisconnected: ({ runtimeKey: disconnectedKey }) => {
              const current = this.sessions.get(disconnectedKey);
              if (current === session) this.sessions.delete(disconnectedKey);
            },
          });
        } catch { session = null; }
        if (session?.runtimeKey) this.sessions.set(session.runtimeKey, session);
      }
      return this.status();
    })().finally(() => { this.polling = null; });
    return this.polling;
  }

  status() {
    const invocation = [...this.sessions.values()]
      .map((session) => session.toolInvocationDiagnostics || {})
      .reduce((total, row) => ({
        seen: total.seen + Number(row?.seen || 0),
        observed: total.observed + Number(row?.observed || 0),
        duplicates: total.duplicates + Number(row?.duplicates || 0),
        responseBuffers: total.responseBuffers + Number(row?.responseBuffers || 0),
        responseBufferChars: total.responseBufferChars + Number(row?.responseBufferChars || 0),
      }), { seen: 0, observed: 0, duplicates: 0, responseBuffers: 0, responseBufferChars: 0 });
    return {
      connected: this.sessions.size,
      pending: [...this.sessions.values()].reduce((sum, session) => sum + Number(session.pendingSize || 0), 0),
      toolInvocations: invocation,
      runtimes: [...this.sessions.values()].map((session) => ({ runtimeKey: session.runtimeKey, port: session.port, connectedAt: session.connectedAt || null, pendingSize: Number(session.pendingSize || 0) })),
    };
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.polling) await this.polling.catch(() => {});
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.close?.()));
  }
}
