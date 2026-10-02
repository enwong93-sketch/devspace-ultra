// Small transport-only implementation of the MCP Apps postMessage contract.
// Keep initialization separate from Goal state: a late host never denies tools
// or marks a Goal complete. Public messages need a backend native-final claim.
export function installGoalRelayAppBridge(win) {
  const parent = win.parent;
  const requests = new Map();
  let nextId = 0;
  let connected = false;
  let disposed = false;
  let connecting = null;
  let retryTimer = null;
  let retryDelay = 2_000;
  const canPost = typeof parent?.postMessage === "function";
  const notify = (method, params) => parent.postMessage({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }, "*");
  const request = (method, params, timeoutMs) => new Promise((resolve, reject) => {
    if (disposed) return reject(new Error("relay transport retired"));
    const id = `devspace-relay-${++nextId}`;
    const timeout = setTimeout(() => {
      requests.delete(id);
      reject(new Error(`${method} response unavailable`));
    }, timeoutMs);
    // Register first: an eager host can reply as soon as postMessage runs.
    requests.set(id, { resolve, reject, timeout });
    try { parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*"); }
    catch (error) { clearTimeout(timeout); requests.delete(id); reject(error); }
  });
  const onMessage = (event) => {
    if (event.source !== parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0" || message.id === undefined || message.method) return;
    const pending = requests.get(message.id);
    if (!pending) return;
    requests.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) pending.reject(new Error(String(message.error.message || "host RPC failed")));
    else pending.resolve(message.result);
  };
  const connect = () => {
    if (connected || disposed || !canPost) return Promise.resolve(connected);
    if (connecting) return connecting;
    connecting = (async () => {
      try {
        const result = await request("ui/initialize", {
          appInfo: { name: "DevSpace Goal Relay", version: "2.0.0" },
          appCapabilities: {}, protocolVersion: "2026-01-26",
        }, 5_000);
        if (disposed) return false;
        if (!result?.protocolVersion || !result?.hostCapabilities) throw new Error("invalid Apps initialize result");
        notify("ui/notifications/initialized");
        connected = true;
        retryDelay = 2_000;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = null;
        return true;
      } catch {
        if (!disposed && !retryTimer) {
          retryTimer = setTimeout(() => { retryTimer = null; void connect(); }, retryDelay);
          retryDelay = Math.min(30_000, retryDelay * 2);
        }
        return false;
      } finally { connecting = null; }
    })();
    return connecting;
  };
  const bridge = {
    async dispatchPublicMessage(goalId, conversationId) {
      // ChatGPT's documented extension supplies scrollToBottom:false. Do not
      // fall back to a transport that may move the user's viewport or input.
      const send = win.openai?.sendFollowUpMessage;
      if (disposed || typeof send !== 'function') return false;
      const result = await bridge.callTool('devspace_goal_continuation', { goalId, action: 'public_message' });
      if (result?.isError) throw new Error('Public continuation authorization unavailable');
      const message = (result?.structuredContent ?? result?.structured_content)?.publicMessage;
      if (!message) return false;
      if (disposed || message.goalId !== goalId || message.conversationId !== conversationId
        || !message.continuationId || !message.leaseId || !message.prompt) {
        throw new Error('Public continuation ownership changed');
      }
      // The backend persisted the one-shot claim before exposing this prompt.
      // Never retry/fallback after invocation, even when its reply is lost.
      let timer;
      try {
        await Promise.race([
          Promise.resolve().then(() => send.call(win.openai, { prompt: message.prompt, scrollToBottom: false })),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Public message reply unavailable; awaiting native receipt')), 30_000); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
      return true; // Submission attempt only, never round-completion evidence.
    },
    async callTool(name, args) {
      if (disposed) throw new Error("relay transport retired");
      if (connected) return request("tools/call", { name, arguments: args }, 30_000);
      // Existing Classic versions continue working while the standard bridge
      // is negotiating; never make the handshake another tool prerequisite.
      if (typeof win.openai?.callTool === "function") return win.openai.callTool(name, args);
      if (await connect()) return request("tools/call", { name, arguments: args }, 30_000);
      if (typeof win.openai?.callTool === "function") return win.openai.callTool(name, args);
      throw new Error("tool bridge not ready yet");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      if (canPost) win.removeEventListener("message", onMessage);
      for (const pending of requests.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("relay transport retired"));
      }
      requests.clear();
    },
  };
  if (canPost) {
    win.addEventListener("message", onMessage, { passive: true });
    // Defer until hydration listeners in the containing relay are registered.
    Promise.resolve().then(() => { void connect(); });
  }
  return bridge;
}
