const DEFAULT_CALL_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_PENDING_CALLS = 128;

function positiveInteger(value, fallback, label) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer.`);
  return number;
}

export class ClassicCdpClient {
  constructor(url, {
    WebSocketImpl = globalThis.WebSocket,
    callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
    maxPendingCalls = DEFAULT_MAX_PENDING_CALLS,
  } = {}) {
    if (typeof WebSocketImpl !== "function") throw new Error("WebSocket is unavailable for Classic CDP.");
    this.ws = new WebSocketImpl(url);
    this.callTimeoutMs = positiveInteger(callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS, "callTimeoutMs");
    this.maxPendingCalls = positiveInteger(maxPendingCalls, DEFAULT_MAX_PENDING_CALLS, "maxPendingCalls");
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.opened = false;
    this.closed = false;
    this.boundMessage = (event) => this.#handleMessage(event);
    this.boundClose = () => this.#disconnect(new Error("Classic CDP websocket closed."));
    this.boundError = (event) => this.#disconnect(event?.error || new Error("Classic CDP websocket failed."));
  }

  get pendingSize() {
    return this.pending.size;
  }

  async open() {
    if (this.closed) throw new Error("Classic CDP client is closed.");
    if (this.opened) return;
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        this.ws.removeEventListener?.("error", onInitialError);
        resolve();
      };
      const onInitialError = (event) => {
        this.ws.removeEventListener?.("open", onOpen);
        reject(event?.error || new Error("Classic CDP websocket failed."));
      };
      this.ws.addEventListener("open", onOpen, { once: true });
      this.ws.addEventListener("error", onInitialError, { once: true });
    });
    if (this.closed) throw new Error("Classic CDP client closed during open.");
    this.opened = true;
    this.ws.addEventListener("message", this.boundMessage);
    this.ws.addEventListener("close", this.boundClose, { once: true });
    this.ws.addEventListener("error", this.boundError);
  }

  on(method, handler) {
    if (this.closed) return () => {};
    const list = this.handlers.get(method) || [];
    list.push(handler);
    this.handlers.set(method, list);
    return () => {
      const current = this.handlers.get(method) || [];
      const next = current.filter((item) => item !== handler);
      if (next.length) this.handlers.set(method, next);
      else this.handlers.delete(method);
    };
  }

  call(method, params = {}, { timeoutMs = this.callTimeoutMs } = {}) {
    if (!this.opened || this.closed) return Promise.reject(new Error("Classic CDP client is not connected."));
    if (this.pending.size >= this.maxPendingCalls) {
      return Promise.reject(new Error(`Classic CDP pending-call cap reached (${this.maxPendingCalls}).`));
    }
    const id = this.nextId++;
    const boundedTimeout = positiveInteger(timeoutMs, this.callTimeoutMs, "timeoutMs");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.reject(new Error(`Classic CDP ${method} timed out after ${boundedTimeout}ms.`));
      }, boundedTimeout);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.#rejectAll(new Error("Classic CDP client closed."));
    this.handlers.clear();
    try { this.ws.removeEventListener?.("message", this.boundMessage); } catch {}
    try { this.ws.removeEventListener?.("error", this.boundError); } catch {}
    try { this.ws.close(); } catch {}
  }

  #handleMessage(event) {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (!message.id) {
      for (const handler of this.handlers.get(message.method) || []) {
        try { handler(message.params); } catch {}
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else pending.resolve(message.result);
  }

  #disconnect(error) {
    if (this.closed) return;
    this.opened = false;
    this.#rejectAll(error instanceof Error ? error : new Error(String(error)));
  }

  #rejectAll(error) {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      try { entry.reject(error); } catch {}
    }
  }
}

export const classicCdpClientDefaults = Object.freeze({
  callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS,
  maxPendingCalls: DEFAULT_MAX_PENDING_CALLS,
});
