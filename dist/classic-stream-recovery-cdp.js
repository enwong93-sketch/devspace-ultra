import { ClassicCdpClient } from "./classic-cdp-client.js";
import { defaultMainDebugPorts } from "./goal-host-bridge.js";
import { runtimeKeyForClassicPort } from './classic-main-debug-ports.js';

const DEFAULT_CONNECTION_POLL_MS = 15_000;
const DEFAULT_PROBE_TIMEOUT_MS = 700;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runtimeKeyForPort(port) {
  return runtimeKeyForClassicPort(port);
}

function streamStatusConversationId(url) {
  const match = String(url || "").match(/\/backend-api\/conversation\/([^/?#]+)\/stream_status(?:[?#]|$)/i);
  return match?.[1] || null;
}

async function fetchJson(url, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable for Classic stream recovery.");
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

function inspectExpression() {
  return `(() => {
    const match = location.pathname.match(/\\/c\\/([^/?#]+)/);
    const radios = [...document.querySelectorAll('[role="radio"]')];
    const work = radios.find((el) => /^(工作|Work)$/i.test((el.innerText || el.textContent || '').trim()));
    const chat = radios.find((el) => /^(對話|Chat)$/i.test((el.innerText || el.textContent || '').trim()));
    const mode = work?.getAttribute('aria-checked') === 'true' || /[?&]surface=work(?:&|$)/i.test(location.search)
      ? 'work'
      : chat?.getAttribute('aria-checked') === 'true'
        ? 'chat'
        : 'chat';
    const assistants = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
    const last = assistants.at(-1);
    const text = (last?.innerText || last?.textContent || '').trim();
    const tail = text.slice(-240);
    const composer=document.querySelector('#prompt-textarea');
    const composerText=(composer?.innerText||composer?.textContent||'').replace(/\\u2060/g,'').trim();
    return {
      ok: true,
      mode,
      conversationId: match?.[1] || null,
      href: location.href,
      generating: Boolean(document.querySelector('button[data-testid="stop-button"]')),
      composerTextChars: composerText.length,
      progressSignature: assistants.length + ':' + text.length + ':' + tail,
    };
  })()`;
}

async function evaluate(client, expression) {
  const result = await client.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Classic CDP evaluate failed.");
  return result.result?.value;
}

async function waitForCdpEvent(client, method, timeoutMs = 10_000) {
  let dispose = null;
  let timer = null;
  return await new Promise((resolve) => {
    const finish = (value) => {
      if (timer) clearTimeout(timer);
      try { dispose?.(); } catch {}
      resolve(value);
    };
    dispose = client.on(method, () => finish(true));
    timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
  });
}

export async function connectClassicStreamRecoveryPort(port, {
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  onTransportFailure,
  onDisconnected,
} = {}) {
  let targets;
  try {
    targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, { fetchImpl, timeoutMs: probeTimeoutMs });
  } catch {
    return null;
  }
  if (!Array.isArray(targets)) return null;
  const page = targets.find((target) => target?.type === "page" && /chatgpt\.com/i.test(target.url || "") && typeof target.webSocketDebuggerUrl === "string");
  if (!page) return null;

  const runtimeKey = runtimeKeyForPort(port);
  const client = new ClassicCdpClient(page.webSocketDebuggerUrl, { WebSocketImpl });
  await client.open();
  await client.call("Runtime.enable");
  await client.call("Page.enable");
  await client.call("Network.enable");

  const requestUrls = new Map();
  const REQUEST_URL_TTL_MS = 2 * 60_000;
  const REQUEST_URL_MAX_PENDING = 512;
  const pruneRequestUrls = () => {
    const cutoff = Date.now() - REQUEST_URL_TTL_MS;
    for (const [requestId, entry] of requestUrls) {
      if (Number(entry?.firstSeenAt || 0) < cutoff) requestUrls.delete(requestId);
    }
    if (requestUrls.size <= REQUEST_URL_MAX_PENDING) return;
    const oldest = [...requestUrls.entries()].sort((a, b) => Number(a[1]?.firstSeenAt || 0) - Number(b[1]?.firstSeenAt || 0));
    for (const [requestId] of oldest) {
      if (requestUrls.size <= REQUEST_URL_MAX_PENDING) break;
      requestUrls.delete(requestId);
    }
  };
  const disposers = [];
  disposers.push(client.on("Network.requestWillBeSent", (params) => {
    const url = params?.request?.url;
    if (params?.requestId && typeof url === "string") {
      requestUrls.set(params.requestId, { url, firstSeenAt: Date.now() });
      pruneRequestUrls();
    }
  }));
  disposers.push(client.on("Network.loadingFinished", (params) => {
    if (params?.requestId) requestUrls.delete(params.requestId);
  }));
  disposers.push(client.on("Network.loadingFailed", (params) => {
    const url = requestUrls.get(params?.requestId)?.url || "";
    requestUrls.delete(params?.requestId);
    const conversationId = streamStatusConversationId(url);
    if (!conversationId || typeof onTransportFailure !== "function") return;
    void (async () => {
      let current = null;
      try { current = await evaluate(client, inspectExpression()); } catch {}
      await onTransportFailure({
        runtimeKey,
        port,
        conversationId,
        url,
        errorText: String(params?.errorText || ""),
        progressSignature: current?.conversationId === conversationId ? current.progressSignature : null,
        at: Date.now(),
      });
    })().catch(() => {});
  }));

  const closeListener = () => { try { onDisconnected?.({ runtimeKey, port }); } catch {} };
  client.ws.addEventListener?.("close", closeListener, { once: true });

  return {
    runtimeKey,
    port,
    async inspect() {
      return await evaluate(client, inspectExpression());
    },
    get pendingCdpCalls() { return client.pendingSize; },
    get trackedRequestUrls() { return requestUrls.size; },
    async checkStreamStatus(conversationId) {
      const value = await evaluate(client, `(async () => {
        try {
          const response = await fetch('/backend-api/conversation/' + ${JSON.stringify(String(conversationId))} + '/stream_status', { credentials:'include', cache:'no-store' });
          const text = await response.text();
          let body = null; try { body = JSON.parse(text); } catch {}
          return { ok: response.ok, httpStatus: response.status, status: body?.status || null };
        } catch (error) {
          return { ok:false, error:String(error), status:null };
        }
      })()`);
      return value;
    },
    async close() {
      for (const dispose of disposers) dispose();
      client.close();
      await sleep(0);
    },
  };
}

export class ClassicStreamRecoveryCdpAdapter {
  constructor({
    ports = defaultMainDebugPorts(),
    connectPort,
    connectionPollMs = DEFAULT_CONNECTION_POLL_MS,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  } = {}) {
    this.ports = [...ports];
    this.connectionPollMs = connectionPollMs;
    this.options = { fetchImpl, WebSocketImpl, probeTimeoutMs };
    this.connectPort = connectPort || ((port, options) => connectClassicStreamRecoveryPort(port, { ...this.options, ...options }));
    this.sessions = new Map();
    this.failureHandler = null;
    this.timer = null;
    this.polling = null;
    this.closed = false;
  }

  setFailureHandler(handler) {
    this.failureHandler = typeof handler === "function" ? handler : null;
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
    this.polling = this.#pollConnectionsImpl().finally(() => { this.polling = null; });
    return this.polling;
  }

  async #pollConnectionsImpl() {
    for (const port of this.ports) {
      const runtimeKey = runtimeKeyForPort(port);
      if (this.sessions.has(runtimeKey)) continue;
      let session = null;
      try {
        session = await this.connectPort(port, {
          onTransportFailure: async (event) => { await this.failureHandler?.(event); },
          onDisconnected: ({ runtimeKey: disconnectedKey }) => {
            const current = this.sessions.get(disconnectedKey);
            if (current === session) this.sessions.delete(disconnectedKey);
          },
        });
      } catch {
        session = null;
      }
      if (session?.runtimeKey) this.sessions.set(session.runtimeKey, session);
    }
    return this.status();
  }

  #session(runtimeKey) {
    const session = this.sessions.get(runtimeKey);
    if (!session) throw new Error(`Classic stream recovery runtime ${runtimeKey} is not connected.`);
    return session;
  }

  async inspect(runtimeKey) {
    return await this.#session(runtimeKey).inspect();
  }

  async checkStreamStatus(runtimeKey, conversationId) {
    return await this.#session(runtimeKey).checkStreamStatus(conversationId);
  }

  status() {
    return {
      connected: this.sessions.size,
      runtimes: [...this.sessions.values()].map((session) => ({
        runtimeKey: session.runtimeKey,
        port: session.port,
        pendingCdpCalls: Number(session.pendingCdpCalls || 0),
        trackedRequestUrls: Number(session.trackedRequestUrls || 0),
      })),
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

export { runtimeKeyForPort, streamStatusConversationId };
