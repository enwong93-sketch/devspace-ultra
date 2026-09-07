import { ClassicCdpClient } from "./classic-cdp-client.js";
import { ClassicTurnIdentityCorrelator, parseClassicTurnRequest } from "./context-guardian-cdp.js";
import { defaultMainDebugPorts } from "./goal-host-bridge.js";
import { runtimeKeyForPort } from "./classic-stream-recovery-cdp.js";
import { parseNativeCallMcpRequest } from "./classic-mcp-call-correlation.js";

const DEFAULT_CONNECTION_POLL_MS = 15_000;
const DEFAULT_PROBE_TIMEOUT_MS = 700;
const DEFAULT_PENDING_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_PENDING = 128;

function observedAt(ms = Date.now()) { return new Date(ms).toISOString(); }

function isTurnUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.hostname === "chatgpt.com" && parsed.pathname === "/backend-api/f/conversation";
  } catch { return false; }
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
  } = {}) {
    this.now = now;
    this.pendingTtlMs = Math.max(1_000, Number(pendingTtlMs) || DEFAULT_PENDING_TTL_MS);
    this.maxPending = Math.max(1, Number(maxPending) || DEFAULT_MAX_PENDING);
    this.pending = new Map();
    this.identity = new ClassicTurnIdentityCorrelator({ now, pendingTtlMs: this.pendingTtlMs, maxPending: this.maxPending });
    this.onConversationIdentity = typeof onConversationIdentity === "function" ? onConversationIdentity : null;
    this.onTurnTransportEvent = typeof onTurnTransportEvent === "function" ? onTurnTransportEvent : null;
    this.onNativeMcpCall = typeof onNativeMcpCall === "function" ? onNativeMcpCall : null;
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
    this.pending.set(requestId, { conversationId: metadata.conversationId, firstSeenAt });
    this.#enforceCap();
    this.#emitTransport({ conversationId: metadata.conversationId, kind: "request", observedAt: observedAt(firstSeenAt) });
    this.#emitIdentity(this.identity.noteRequest(params));
    return metadata;
  }

  noteExtraInfo(params = {}) {
    this.#emitIdentity(this.identity.noteExtraInfo(params));
  }

  noteResponse(params = {}) {
    const requestId = String(params?.requestId || "").trim();
    const entry = requestId ? this.pending.get(requestId) : null;
    if (!entry || !isTurnUrl(params?.response?.url)) return;
    this.#emitTransport({
      conversationId: entry.conversationId,
      kind: "response",
      status: Number(params?.response?.status || 0) || null,
      observedAt: observedAt(this.now()),
    });
  }

  noteFailure(params = {}) {
    const requestId = String(params?.requestId || "").trim();
    const entry = requestId ? this.pending.get(requestId) : null;
    if (entry) {
      this.#emitTransport({
        conversationId: entry.conversationId,
        kind: "failed",
        errorText: String(params?.errorText || "").slice(0, 180),
        canceled: params?.canceled === true,
        blockedReason: params?.blockedReason ? String(params.blockedReason).slice(0, 120) : null,
        observedAt: observedAt(this.now()),
      });
      this.pending.delete(requestId);
    }
    if (requestId) this.identity.forget(requestId);
  }

  noteFinished(params = {}) {
    const requestId = String(params?.requestId || "").trim();
    const entry = requestId ? this.pending.get(requestId) : null;
    if (entry) {
      this.#emitTransport({ conversationId: entry.conversationId, kind: "finished", observedAt: observedAt(this.now()) });
      this.pending.delete(requestId);
    }
    if (requestId) this.identity.forget(requestId);
  }

  prune() {
    const cutoff = this.now() - this.pendingTtlMs;
    for (const [requestId, entry] of this.pending) {
      if (Number(entry?.firstSeenAt || 0) < cutoff) {
        this.pending.delete(requestId);
        this.identity.forget(requestId);
      }
    }
    this.#enforceCap();
  }

  #enforceCap() {
    if (this.pending.size <= this.maxPending) return;
    const oldest = [...this.pending.entries()].sort((a, b) => Number(a[1]?.firstSeenAt || 0) - Number(b[1]?.firstSeenAt || 0));
    for (const [requestId] of oldest) {
      if (this.pending.size <= this.maxPending) break;
      this.pending.delete(requestId);
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
}

export async function connectClassicTurnTransportPort(port, {
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  onConversationIdentity,
  onTurnTransportEvent,
  onNativeMcpCall,
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
  const client = new ClassicCdpClient(page.webSocketDebuggerUrl, { WebSocketImpl, callTimeoutMs: 3_000, maxPendingCalls: 32 });
  await client.open();
  await client.call("Network.enable", { maxTotalBufferSize: 1_000_000, maxResourceBufferSize: 512_000, enableDurableMessages: false });
  const tracker = new ClassicTurnTransportTracker({
    onConversationIdentity: (identity) => onConversationIdentity?.({ runtimeKey, port, ...identity, observedAt: observedAt() }),
    onTurnTransportEvent: (event) => onTurnTransportEvent?.({ runtimeKey, port, ...event }),
    onNativeMcpCall: (event) => onNativeMcpCall?.({ runtimeKey, port, ...event }),
  });
  const disposers = [
    client.on("Network.requestWillBeSent", (params) => tracker.noteRequest(params)),
    client.on("Network.requestWillBeSentExtraInfo", (params) => tracker.noteExtraInfo(params)),
    client.on("Network.responseReceived", (params) => tracker.noteResponse(params)),
    client.on("Network.loadingFailed", (params) => tracker.noteFailure(params)),
    client.on("Network.loadingFinished", (params) => tracker.noteFinished(params)),
  ];
  const closeListener = () => { try { onDisconnected?.({ runtimeKey, port }); } catch {} };
  client.ws.addEventListener?.("close", closeListener, { once: true });
  return {
    runtimeKey,
    port,
    connectedAt: observedAt(),
    get pendingSize() { return tracker.pendingSize; },
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

  setHandlers({ onConversationIdentity, onTurnTransportEvent, onNativeMcpCall } = {}) {
    this.handlers = { onConversationIdentity, onTurnTransportEvent, onNativeMcpCall };
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
    return {
      connected: this.sessions.size,
      pending: [...this.sessions.values()].reduce((sum, session) => sum + Number(session.pendingSize || 0), 0),
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
