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

function conversationIdFromUrl(url) {
  try {
    return new URL(String(url || "")).pathname.match(/\/c\/([^/?#]+)/)?.[1] || null;
  } catch {
    return null;
  }
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
  constructor({ runtimeKeys = null, hostBridge = null, listTargets = targetsForPort, connect = connectTarget } = {}) {
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
    const matches = await this.#conversationTargets(id);
    if (matches.length !== 1) {
      return {
        exact: false,
        ambiguous: matches.length > 1,
        state: matches.length > 1 ? "multiple-runtime-pages" : "page-not-open",
        conversationId: id,
        matchCount: matches.length,
      };
    }
    return await this.#inspectMatch(matches[0], id);
  }

  async inspect({ conversationId } = {}) {
    return await this.find({ conversationId });
  }

  async projectReminder({ conversationId, reminderAt, silenceMs } = {}) {
    const target = await this.#exactTarget(conversationId);
    if (!target.ok) return target;
    const page = await this.connect(target.target);
    try {
      const result = await page.evaluate(`(() => {
        const expected = ${JSON.stringify(conversationId)};
        const actual = location.pathname.match(/\\/c\\/([^/?#]+)/)?.[1] || null;
        if (actual !== expected) return { ok:false, state:'route-changed' };
        const root = document.getElementById('devspace-progress-narration-root');
        if (!root) return { ok:false, state:'progress-card-not-mounted' };
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
        node.textContent = ${JSON.stringify(`[${localMinute(Date.parse(reminderAt || new Date().toISOString()))}] 生存檢查：已提醒 Agent 更新進度；下一個工具回合必須由 Agent 自行匯報。`)};
        return { ok:true, conversationId:actual };
      })()`);
      return result?.ok ? { ok: true, locatedRuntimeKey: target.runtimeKey, silenceMs } : result;
    } finally {
      page.close();
    }
  }

  async clearReminder({ conversationId } = {}) {
    const target = await this.#exactTarget(conversationId);
    if (!target.ok) return target;
    const page = await this.connect(target.target);
    try {
      return await page.evaluate(`(() => {
        const expected = ${JSON.stringify(conversationId)};
        const actual = location.pathname.match(/\\/c\\/([^/?#]+)/)?.[1] || null;
        if (actual !== expected) return { ok:false, state:'route-changed' };
        const node = document.querySelector('#devspace-progress-narration-root .devspace-progress-liveness-reminder');
        if (node?.dataset?.conversationId === expected) node.remove();
        return { ok:true };
      })()`);
    } finally {
      page.close();
    }
  }

  async sendReminder({ conversationId, silenceMs = 0 } = {}) {
    const prompt = "進度旁白提醒：呢個 conversation 已經接近十分鐘未有新匯報。請完成目前不可分割嘅安全原子步驟後，立即用 devspace_progress_report，以你自己嘅自然語言講清楚而家做緊乜、已核實到乜同下一步，然後繼續原任務。唔好重啟、接管或改動其他 conversation 嘅工具或 Runtime。";
    const hostResult = await this.#sendHostFollowUp({
      conversationId,
      prompt,
      purpose: "progress-reminder",
    });
    if (hostResult?.ok) return { ...hostResult, silenceMs };
    if (hostResult?.ambiguous) return hostResult;
    return await this.#sendComposerMessage({
      conversationId,
      text: prompt,
      expectedPrefix: "進度旁白提醒：",
      purpose: "progress-reminder",
      attempt: 1,
    });
  }

  async sendContinue({ conversationId, attempt = 1 } = {}) {
    const text = "繼續。你已經超過二十分鐘未更新進度；請先用進度旁白卡，以你自己嘅自然語言講清楚目前做緊乜、已完成乜同下一步，再由原工作斷點繼續。唔好重啟、接管或改動其他 conversation 嘅工具或 Runtime。";
    const hostResult = await this.#sendHostFollowUp({
      conversationId,
      prompt: text,
      purpose: "progress-continue",
    });
    if (hostResult?.ok) return { ...hostResult, attempt };
    if (hostResult?.ambiguous) return hostResult;
    return await this.#sendComposerMessage({
      conversationId,
      text,
      expectedPrefix: "繼續。你已經超過二十分鐘未更新進度",
      purpose: "progress-continue",
      attempt,
    });
  }

  async #sendHostFollowUp({ conversationId, prompt, purpose }) {
    if (!this.hostBridge || typeof this.hostBridge.dispatchConversationFollowUp !== "function") {
      return { ok: false, definiteFailure: true, state: "host-relay-unavailable" };
    }
    return await this.hostBridge.dispatchConversationFollowUp({
      conversationId,
      prompt,
      purpose,
    });
  }

  async #sendComposerMessage({ conversationId, text, expectedPrefix, purpose, attempt = 1 } = {}) {
    const target = await this.#exactTarget(conversationId);
    if (!target.ok) return target;
    const page = await this.connect(target.target);
    const marker = markerFor(conversationId, `${purpose || "message"}:${attempt}`);
    try {
      const preflight = await page.evaluate(`(() => {
        const expected = ${JSON.stringify(conversationId)};
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
        const text = String(editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText || editor.textContent || '').trim();
        if (!text) return { ok:false, state:'text-not-inserted' };
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
        const expected = ${JSON.stringify(conversationId)};
        const expectedPrefix = ${JSON.stringify(String(expectedPrefix || ""))};
        const actual = location.pathname.match(/\\/c\\/([^/?#]+)/)?.[1] || null;
        if (actual !== expected) return { ok:false, state:'route-changed-after-send' };
        const users = [...document.querySelectorAll('[data-message-author-role="user"]')];
        const latest = String(users.at(-1)?.innerText || users.at(-1)?.textContent || '').trim();
        return { ok: latest.startsWith(expectedPrefix), state: latest ? 'visible' : 'missing' };
      })()`);
      return verified?.ok
        ? { ok: true, locatedRuntimeKey: target.runtimeKey, conversationId, purpose, attempt, transport: "classic-exact-composer", markerPersisted: false, rawMessagePersisted: false }
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
        locatedRuntimeKey: match.runtimeKey,
        port: match.port,
        exact: result?.exact === true,
      };
    } finally {
      page.close();
    }
  }

  async #conversationTargets(conversationId) {
    const id = cleanConversationId(conversationId);
    if (!id) return [];
    const matches = [];
    for (const runtimeKey of this.runtimeKeys) {
      const port = runtimePort(runtimeKey);
      if (!port) continue;
      let targets;
      try { targets = await this.listTargets(port); }
      catch { continue; }
      for (const target of targets || []) {
        if (target?.type !== "page" || !target?.webSocketDebuggerUrl) continue;
        if (conversationIdFromUrl(target.url) !== id) continue;
        matches.push({ runtimeKey, port, target });
      }
    }
    return matches;
  }

  async #exactTarget(conversationId) {
    const id = cleanConversationId(conversationId);
    if (!id) return { ok: false, state: "invalid-conversation" };
    const matches = await this.#conversationTargets(id);
    if (matches.length !== 1) {
      return {
        ok: false,
        ambiguous: matches.length > 1,
        matchCount: matches.length,
        state: matches.length > 1 ? "conversation-open-in-multiple-runtimes" : "conversation-not-open",
      };
    }
    return { ok: true, ...matches[0] };
  }
}

export const _test = {
  runtimePort,
  conversationIdFromUrl,
  markerFor,
  localMinute,
};
