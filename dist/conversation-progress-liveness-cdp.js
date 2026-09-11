import { createHash } from "node:crypto";

function cleanConversationId(value) {
  const text = String(value ?? "").trim();
  return text && /^[A-Za-z0-9_-]{8,200}$/.test(text) ? text : null;
}

function cleanRuntimeKey(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^main-\d{2}$/.test(text) ? text : null;
}

function runtimePort(runtimeKey) {
  const key = cleanRuntimeKey(runtimeKey);
  if (!key) return null;
  const number = Number(key.slice(-2));
  if (number === 1) return 9721;
  if (number >= 2 && number <= 32) return 9730 + number;
  return null;
}

function markerFor(conversationId, attempt) {
  return createHash("sha256")
    .update(`${conversationId}:${attempt}`)
    .digest("hex")
    .slice(0, 12);
}

function localMinute(value = Date.now()) {
  const date = new Date(value);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date).replace(",", "");
}

function conversationIdFromUrl(url) {
  try {
    return new URL(String(url || "")).pathname.match(/\/c\/([^/?#]+)/)?.[1] || null;
  } catch {
    return null;
  }
}

async function targetsForPort(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { cache: "no-store" });
  if (!response.ok) throw new Error(`CDP target list ${port} returned HTTP ${response.status}.`);
  return await response.json();
}

async function connectTarget(target) {
  if (!target?.webSocketDebuggerUrl) throw new Error("CDP target has no debugger WebSocket.");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP connection timed out.")), 5_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("CDP connection failed."));
    }, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    let payload;
    try { payload = JSON.parse(String(event.data)); } catch { return; }
    const waiter = pending.get(payload?.id);
    if (!waiter) return;
    pending.delete(payload.id);
    clearTimeout(waiter.timer);
    if (payload.error) waiter.reject(new Error(payload.error.message || JSON.stringify(payload.error)));
    else waiter.resolve(payload.result);
  });
  const call = (method, params = {}, timeoutMs = 10_000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out.`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result?.exceptionDetails) throw new Error("CDP page evaluation failed.");
    return result?.result?.value;
  };
  await call("Runtime.enable");
  return {
    socket,
    call,
    evaluate,
    close: () => socket.close(),
  };
}

function exactConversationExpression(conversationId) {
  return `(() => {
    const expected = ${JSON.stringify(conversationId)};
    const match = location.pathname.match(/\\/c\\/([^/?#]+)/);
    const actual = match ? match[1] : null;
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 5 && rect.height > 5 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const buttons = [...document.querySelectorAll('button')].filter(visible);
    const generating = buttons.some((button) => (
      button.matches('[data-testid="stop-button"]')
      || /stop|停止|中止/i.test(String(button.getAttribute('aria-label') || ''))
    ));
    const editors = [...document.querySelectorAll([
      '#prompt-textarea',
      'textarea',
      'div.ProseMirror[contenteditable="true"]',
      '[data-lexical-editor="true"][contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]'
    ].join(','))].filter(visible);
    const editor = editors.find((node) => node.closest('form')) || editors.at(-1) || null;
    const composerText = editor
      ? String(editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText || editor.textContent || '').replace(/\\u2060/g, '').trim()
      : null;
    const root = document.getElementById('devspace-progress-narration-root');
    return {
      exact: actual === expected,
      conversationId: actual,
      hydrated: document.readyState === 'complete' && Boolean(editor),
      generating,
      composerFound: Boolean(editor),
      composerEmpty: composerText === '',
      composerLength: composerText == null ? null : composerText.length,
      progressCardMounted: Boolean(root),
      progressConversationId: root?.dataset?.conversationId || actual,
      url: location.href,
    };
  })()`;
}

export class ConversationProgressLivenessCdpAdapter {
  constructor({
    runtimeKeys = null,
    hostBridge = null,
    listTargets = targetsForPort,
    connect = connectTarget,
  } = {}) {
    this.runtimeKeys = Array.isArray(runtimeKeys) && runtimeKeys.length
      ? [...new Set(runtimeKeys.map(cleanRuntimeKey).filter(Boolean))]
      : Array.from({ length: 32 }, (_, index) => `main-${String(index + 1).padStart(2, "0")}`);
    this.hostBridge = hostBridge;
    this.listTargets = listTargets;
    this.connect = connect;
  }

  async find({ conversationId } = {}) {
    const id = cleanConversationId(conversationId);
    if (!id) return { exact: false, state: "invalid-conversation" };
    const matches = [];
    for (const runtimeKey of this.runtimeKeys) {
      const port = runtimePort(runtimeKey);
      try {
        const targets = await this.listTargets(port);
        for (const target of targets) {
          if (target?.type !== "page" || !target?.webSocketDebuggerUrl) continue;
          if (conversationIdFromUrl(target.url) !== id) continue;
          matches.push({ runtimeKey, port, target });
        }
      } catch {
        // One offline Runtime cannot invalidate a conversation found elsewhere.
      }
    }
    if (matches.length !== 1) {
      return {
        exact: false,
        ambiguous: matches.length > 1,
        state: matches.length > 1 ? "duplicate-conversation-pages" : "conversation-page-not-open",
        conversationId: id,
        matchCount: matches.length,
      };
    }
    return await this.#inspectMatch(matches[0], id);
  }

  // Compatibility alias. runtimeKey is deliberately ignored: Runtime is a
  // locator, never the durable progress identity or authorization key.
  async inspect({ conversationId } = {}) {
    return await this.find({ conversationId });
  }

  async projectReminder({ conversationId, target = null, reminderAt, silenceMs } = {}) {
    const resolved = await this.#resolveExactTarget(conversationId, target);
    if (!resolved.ok) return resolved;
    const page = await this.connect(resolved.target);
    try {
      const result = await page.evaluate(`(() => {
        const expected = ${JSON.stringify(resolved.conversationId)};
        const actual = location.pathname.match(/\\/c\\/([^/?#]+)/)?.[1] || null;
        if (actual !== expected) return { ok:false, state:'route-changed' };
        const root = document.getElementById('devspace-progress-narration-root');
        if (!root) return { ok:false, state:'progress-card-not-mounted' };
        const cardConversation = root.dataset?.conversationId || actual;
        if (cardConversation !== expected) return { ok:false, state:'progress-card-conversation-mismatch' };
        let node = root.querySelector('.devspace-progress-liveness-reminder');
        if (!node) {
          node = document.createElement('div');
          node.className = 'devspace-progress-liveness-reminder';
          node.style.cssText = 'margin:6px 8px 2px;padding:5px 7px;border-radius:7px;background:rgba(180,120,0,.10);font-size:11px;line-height:1.35;white-space:normal;';
          const body = root.querySelector('.devspace-progress-body') || root;
          body.prepend(node);
        }
        node.dataset.conversationId = expected;
        node.dataset.reminderAt = ${JSON.stringify(String(reminderAt || ""))};
        node.textContent = ${JSON.stringify(`[${localMinute(Date.parse(reminderAt || new Date().toISOString()))}] 生存檢查：已提醒目前呢個 conversation 嘅 Agent 更新進度；其他 conversation 同工具唔受影響。`)};
        return { ok:true, conversationId:actual };
      })()`);
      return result?.ok
        ? { ok: true, conversationId: resolved.conversationId, locatedRuntimeKey: resolved.runtimeKey, locatedPort: resolved.port, silenceMs }
        : result;
    } finally {
      page.close();
    }
  }

  async clearReminder({ conversationId, target = null } = {}) {
    const resolved = await this.#resolveExactTarget(conversationId, target);
    if (!resolved.ok) return resolved;
    const page = await this.connect(resolved.target);
    try {
      return await page.evaluate(`(() => {
        const expected = ${JSON.stringify(resolved.conversationId)};
        const actual = location.pathname.match(/\\/c\\/([^/?#]+)/)?.[1] || null;
        if (actual !== expected) return { ok:false, state:'route-changed' };
        const node = document.querySelector('#devspace-progress-narration-root .devspace-progress-liveness-reminder');
        if (node?.dataset?.conversationId === expected) node.remove();
        return { ok:true, conversationId:actual };
      })()`);
    } finally {
      page.close();
    }
  }

  async sendReminder({ conversationId, target = null, reminderAt, silenceMs = 0 } = {}) {
    const resolved = await this.#resolveExactTarget(conversationId, target);
    if (!resolved.ok) return resolved;
    const minutes = Math.max(10, Math.floor(Number(silenceMs || 0) / 60_000));
    const text = `進度旁白提醒：呢個 conversation 已經約 ${minutes} 分鐘未有新匯報。請完成目前不可分割嘅安全原子步驟後，立即用 devspace_progress_report，以你自己嘅自然語言講清楚而家做緊乜、已核實到乜同下一步，然後繼續原任務。唔好重啟、接管或改動其他 conversation 嘅工具或 Runtime。`;

    if (this.hostBridge && typeof this.hostBridge.dispatchConversationFollowUp === "function") {
      const hostResult = await this.hostBridge.dispatchConversationFollowUp({
        conversationId: resolved.conversationId,
        prompt: text,
        purpose: "progress-reminder",
      }).catch((error) => ({
        ok: false,
        definiteFailure: false,
        error: error instanceof Error ? error.message : String(error),
      }));
      if (hostResult?.ok) {
        return {
          ok: true,
          conversationId: resolved.conversationId,
          locatedRuntimeKey: resolved.runtimeKey,
          locatedPort: resolved.port,
          reminderAt: reminderAt || null,
          silenceMs,
          runtimeBinding: false,
          transport: hostResult.transport || "classic-raw-host-rpc",
        };
      }
      if (hostResult?.ambiguous) return hostResult;
    }

    return await this.#sendConversationMessage({
      resolved,
      text,
      expectedPrefix: "進度旁白提醒：",
      purpose: "progress-reminder",
      attempt: 1,
    });
  }

  async sendContinue({ conversationId, target = null, attempt = 1 } = {}) {
    const resolved = await this.#resolveExactTarget(conversationId, target);
    if (!resolved.ok) return resolved;
    const text = "繼續。你已經超過二十分鐘未更新進度；請先用進度旁白卡，以你自己嘅自然語言講清楚目前做緊乜、已完成乜同下一步，再由原工作斷點繼續。唔好接管、重啟或改動其他 conversation 嘅工具或 Runtime。";
    return await this.#sendConversationMessage({
      resolved,
      text,
      expectedPrefix: "繼續。你已經超過二十分鐘未更新進度",
      purpose: "progress-continue",
      attempt,
    });
  }

  async #sendConversationMessage({ resolved, text, expectedPrefix, purpose, attempt }) {
    const page = await this.connect(resolved.target);
    const marker = markerFor(resolved.conversationId, `${purpose}:${attempt}`);
    try {
      const preflight = await page.evaluate(`(() => {
        const expected = ${JSON.stringify(resolved.conversationId)};
        const actual = location.pathname.match(/\\/c\\/([^/?#]+)/)?.[1] || null;
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 5 && rect.height > 5 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        if (actual !== expected) return { ok:false, state:'route-changed' };
        const buttons = [...document.querySelectorAll('button')].filter(visible);
        if (buttons.some((button) => button.matches('[data-testid="stop-button"]') || /stop|停止|中止/i.test(String(button.getAttribute('aria-label') || '')))) {
          return { ok:false, state:'still-generating' };
        }
        const editors = [...document.querySelectorAll('#prompt-textarea,textarea,div.ProseMirror[contenteditable="true"],[data-lexical-editor="true"][contenteditable="true"],[contenteditable="true"][role="textbox"]')].filter(visible);
        const editor = editors.find((node) => node.closest('form')) || editors.at(-1);
        if (!editor) return { ok:false, state:'composer-missing' };
        const existing = String(editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText || editor.textContent || '').replace(/\\u2060/g, '').trim();
        if (existing) return { ok:false, state:'composer-not-empty' };
        editor.setAttribute('data-devspace-liveness-send', ${JSON.stringify(marker)});
        editor.focus();
        return { ok:true };
      })()`);
      if (!preflight?.ok) return preflight;
      await page.call("Input.insertText", { text });
      await new Promise((resolve) => setTimeout(resolve, 350));
      const submitted = await page.evaluate(`(() => {
        const marker = ${JSON.stringify(marker)};
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 5 && rect.height > 5 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const editor = document.querySelector('[data-devspace-liveness-send="' + marker + '"]');
        if (!editor) return { ok:false, state:'composer-lost' };
        const inserted = String(editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText || editor.textContent || '').trim();
        if (!inserted) return { ok:false, state:'text-not-inserted' };
        const buttons = [...document.querySelectorAll('button')].filter(visible);
        const send = buttons.find((button) => button.matches('[data-testid="send-button"]'))
          || buttons.find((button) => /send|傳送|发送|送出/i.test(String(button.getAttribute('aria-label') || button.title || '')));
        if (!send || send.disabled || send.getAttribute('aria-disabled') === 'true') return { ok:false, state:'send-unavailable' };
        editor.removeAttribute('data-devspace-liveness-send');
        send.click();
        return { ok:true };
      })()`);
      if (!submitted?.ok) return submitted;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const verified = await page.evaluate(`(() => {
        const expected = ${JSON.stringify(resolved.conversationId)};
        const expectedPrefix = ${JSON.stringify(expectedPrefix)};
        const actual = location.pathname.match(/\\/c\\/([^/?#]+)/)?.[1] || null;
        if (actual !== expected) return { ok:false, state:'route-changed-after-send' };
        const users = [...document.querySelectorAll('[data-message-author-role="user"]')];
        const latest = String(users.at(-1)?.innerText || users.at(-1)?.textContent || '').trim();
        return { ok: latest.startsWith(expectedPrefix), state: latest ? 'visible' : 'missing' };
      })()`);
      return verified?.ok
        ? {
            ok: true,
            conversationId: resolved.conversationId,
            locatedRuntimeKey: resolved.runtimeKey,
            locatedPort: resolved.port,
            attempt,
            purpose,
            runtimeBinding: false,
            markerPersisted: false,
            rawMessagePersisted: false,
          }
        : verified;
    } finally {
      page.close();
    }
  }

  async close() {}

  async #inspectMatch(match, conversationId) {
    const page = await this.connect(match.target);
    try {
      const result = await page.evaluate(exactConversationExpression(conversationId));
      return {
        ...result,
        // Runtime identifies only the physical window where this exact
        // conversation is currently open.  It is never persisted or used as
        // narration ownership.  Keep the legacy aliases for callers that
        // still display the locator, but expose the semantic names explicitly.
        runtimeKey: match.runtimeKey,
        port: match.port,
        locatedRuntimeKey: match.runtimeKey,
        locatedPort: match.port,
        exact: result?.exact === true,
        runtimeBinding: false,
        locatorOnly: true,
        target: {
          runtimeKey: match.runtimeKey,
          port: match.port,
          targetId: match.target.id,
          url: match.target.url,
          webSocketDebuggerUrl: match.target.webSocketDebuggerUrl,
        },
      };
    } finally {
      page.close();
    }
  }

  async #resolveExactTarget(conversationId, supplied = null) {
    const id = cleanConversationId(conversationId);
    if (!id) return { ok: false, state: "invalid-conversation" };

    if (supplied?.exact === true && supplied?.conversationId === id && supplied?.target?.webSocketDebuggerUrl) {
      const runtimeKey = cleanRuntimeKey(supplied.target.runtimeKey || supplied.runtimeKey);
      const port = Number(supplied.target.port || supplied.port);
      if (runtimeKey && runtimePort(runtimeKey) === port && conversationIdFromUrl(supplied.target.url) === id) {
        try {
          const targets = await this.listTargets(port);
          const exact = targets.filter((target) => (
            target?.type === "page"
            && target?.webSocketDebuggerUrl
            && target.id === supplied.target.targetId
            && conversationIdFromUrl(target.url) === id
          ));
          if (exact.length === 1) {
            return { ok: true, conversationId: id, runtimeKey, port, target: exact[0] };
          }
        } catch {}
      }
    }

    const found = await this.find({ conversationId: id });
    if (!found?.exact || !found?.target?.webSocketDebuggerUrl) {
      return {
        ok: false,
        state: found?.state || "conversation-page-not-open",
        ambiguous: found?.ambiguous === true,
        conversationId: id,
      };
    }
    return {
      ok: true,
      conversationId: id,
      runtimeKey: found.runtimeKey,
      port: found.port,
      target: {
        id: found.target.targetId,
        type: "page",
        url: found.target.url,
        webSocketDebuggerUrl: found.target.webSocketDebuggerUrl,
      },
    };
  }
}

export const _test = {
  runtimePort,
  markerFor,
  localMinute,
  conversationIdFromUrl,
};
