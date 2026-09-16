import { createHash } from "node:crypto";

export const INTERRUPTED_TURN_RESCUE_TEXT = "- 繼續";

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
    const messageNodes = [...document.querySelectorAll('[data-message-author-role]')].filter(visible);
    const latestMessage = messageNodes.at(-1) || null;
    const latestMessageRole = latestMessage?.getAttribute('data-message-author-role') || null;
    const latestMessageText = String(latestMessage?.innerText || latestMessage?.textContent || '').trim();
    const latestTurnContainer = latestMessage?.closest('article') || latestMessage;
    const errorNodes = latestTurnContainer
      ? [...latestTurnContainer.querySelectorAll('[role="alert"],[data-testid*="error" i],[data-testid*="retry" i]')].filter(visible)
      : [];
    const hasTurnError = errorNodes.some((node) => /something went wrong|error generating|network error|發生錯誤|出現問題|網絡錯誤|再試一次/i.test(String(node.innerText || node.textContent || '')))
      || buttons.some((button) => (
        /retry|try again|重試|再試/i.test(String(button.getAttribute('aria-label') || button.title || button.textContent || ''))
        && latestTurnContainer
        && (button.closest('article') || button.parentElement)?.contains(latestTurnContainer)
      ));
    const root = document.getElementById('devspace-progress-narration-root');
    return {
      exact: actual === expected,
      conversationId: actual,
      hydrated: document.readyState === 'complete' && Boolean(editor),
      generating,
      latestMessageRole,
      latestMessageTextLength: latestMessageText.length,
      hasTurnError,
      normalCompletion: !generating && latestMessageRole === 'assistant' && latestMessageText.length > 0 && !hasTurnError,
      incompleteUserTurn: !generating && latestMessageRole === 'user',
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
    listTargets = targetsForPort,
    connect = connectTarget,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    this.runtimeKeys = Array.isArray(runtimeKeys) && runtimeKeys.length
      ? [...new Set(runtimeKeys.map(cleanRuntimeKey).filter(Boolean))]
      : Array.from({ length: 32 }, (_, index) => `main-${String(index + 1).padStart(2, "0")}`);
    this.listTargets = listTargets;
    this.connect = connect;
    this.sleep = sleep;
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

  async findAtRuntime({ conversationId, runtimeKey } = {}) {
    const id = cleanConversationId(conversationId);
    const key = cleanRuntimeKey(runtimeKey);
    if (!id || !key) return { exact: false, state: "invalid-conversation-or-runtime" };
    const port = runtimePort(key);
    try {
      const targets = await this.listTargets(port);
      const matches = (Array.isArray(targets) ? targets : []).filter((target) => (
        target?.type === "page"
        && target?.webSocketDebuggerUrl
        && conversationIdFromUrl(target.url) === id
      ));
      if (matches.length !== 1) {
        return {
          exact: false,
          ambiguous: matches.length > 1,
          state: matches.length > 1 ? "duplicate-conversation-pages-in-runtime" : "conversation-not-in-runtime",
          conversationId: id,
          runtimeKey: key,
          port,
          matchCount: matches.length,
          locatorOnly: true,
          runtimeBinding: false,
        };
      }
      return await this.#inspectMatch({ runtimeKey: key, port, target: matches[0] }, id);
    } catch {
      return {
        exact: false,
        state: "runtime-unavailable",
        conversationId: id,
        runtimeKey: key,
        port,
        locatorOnly: true,
        runtimeBinding: false,
      };
    }
  }

  // Compatibility alias. runtimeKey is deliberately ignored: Runtime is a
  // locator, never the durable progress identity or authorization key.
  async inspect({ conversationId } = {}) {
    return await this.find({ conversationId });
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

  async resetInterruptedGeneration({ conversationId, target = null } = {}) {
    const resolved = await this.#resolveExactTarget(conversationId, target);
    if (!resolved.ok) return resolved;
    const page = await this.connect(resolved.target);
    try {
      const result = await page.evaluate(`(() => {
        const expected = ${JSON.stringify(resolved.conversationId)};
        const actual = location.pathname.match(/\\/c\\/([^/?#]+)/)?.[1] || null;
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 5 && rect.height > 5 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        if (actual !== expected) return { ok:false, state:'route-changed' };
        const stop = [...document.querySelectorAll('button')]
          .filter(visible)
          .find((button) => button.matches('[data-testid="stop-button"]') || /stop|停止|中止/i.test(String(button.getAttribute('aria-label') || '')));
        if (!stop) return { ok:true, state:'already-idle', resetCommitted:false };
        stop.click();
        return { ok:true, state:'stale-generating-stop-clicked', resetCommitted:true };
      })()`);
      return {
        ...result,
        conversationId: resolved.conversationId,
        locatedRuntimeKey: resolved.runtimeKey,
        locatedPort: resolved.port,
        runtimeBinding: false,
        foregroundActivation: false,
        pageNavigation: false,
      };
    } finally {
      page.close();
    }
  }

  async sendContinue({ conversationId, target = null, attempt = 1 } = {}) {
    const resolved = await this.#resolveExactTarget(conversationId, target);
    if (!resolved.ok) return resolved;
    const text = INTERRUPTED_TURN_RESCUE_TEXT;
    return await this.#sendConversationMessage({
      resolved,
      text,
      expectedPrefix: INTERRUPTED_TURN_RESCUE_TEXT,
      purpose: "interrupted-turn-rescue",
      attempt,
      allowNormalCompletion: false,
      requireInterruptionEvidence: true,
    });
  }

  async sendGoalRecovery({ conversationId, target = null, prompt, attempt = 1 } = {}) {
    const text = String(prompt || "").trim();
    if (!text.startsWith("[DEVSPACE_GOAL_ROUND_RECOVERY]")) {
      return { ok: false, state: "invalid-goal-recovery-prompt" };
    }
    const resolved = await this.#resolveExactTarget(conversationId, target);
    if (!resolved.ok) return resolved;
    return await this.#sendConversationMessage({
      resolved,
      text,
      expectedPrefix: "[DEVSPACE_GOAL_ROUND_RECOVERY]",
      purpose: "goal-round-recovery",
      attempt,
      // The Goal guard independently proves that a working round terminated
      // without devspace_goal_turn_report. A visible assistant message is
      // therefore expected and must not block the exact recovery turn.
      allowNormalCompletion: true,
      requireInterruptionEvidence: false,
    });
  }

  async #sendConversationMessage({
    resolved,
    text,
    expectedPrefix,
    purpose,
    attempt,
    allowNormalCompletion = false,
    requireInterruptionEvidence = true,
  }) {
    const page = await this.connect(resolved.target);
    const marker = markerFor(resolved.conversationId, `${purpose}:${attempt}`);
    try {
      const preflight = await page.evaluate(`(() => {
        const expected = ${JSON.stringify(resolved.conversationId)};
        const expectedText = ${JSON.stringify(text)};
        const allowNormalCompletion = ${allowNormalCompletion === true};
        const requireInterruptionEvidence = ${requireInterruptionEvidence !== false};
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
        const messageNodes = [...document.querySelectorAll('[data-message-author-role]')].filter(visible);
        const latestMessage = messageNodes.at(-1) || null;
        const latestMessageRole = latestMessage?.getAttribute('data-message-author-role') || null;
        const latestMessageText = String(latestMessage?.innerText || latestMessage?.textContent || '').trim();
        const latestUser = [...messageNodes].reverse().find((node) => node.getAttribute('data-message-author-role') === 'user') || null;
        const latestUserText = String(latestUser?.innerText || latestUser?.textContent || '').trim();
        if (latestUserText === expectedText) {
          return { ok:true, state:'already-visible', alreadyVisible:true };
        }
        const latestTurnContainer = latestMessage?.closest('article') || latestMessage;
        const errorNodes = latestTurnContainer
          ? [...latestTurnContainer.querySelectorAll('[role="alert"],[data-testid*="error" i],[data-testid*="retry" i]')].filter(visible)
          : [];
        const hasTurnError = errorNodes.some((node) => /something went wrong|error generating|network error|發生錯誤|出現問題|網絡錯誤|再試一次/i.test(String(node.innerText || node.textContent || '')))
          || buttons.some((button) => (
            /retry|try again|重試|再試/i.test(String(button.getAttribute('aria-label') || button.title || button.textContent || ''))
            && latestTurnContainer
            && (button.closest('article') || button.parentElement)?.contains(latestTurnContainer)
          ));
        if (!allowNormalCompletion && latestMessageRole === 'assistant' && latestMessageText.length > 0 && !hasTurnError) {
          return { ok:false, state:'normal-completion-observed' };
        }
        if (requireInterruptionEvidence && latestMessageRole !== 'user' && !hasTurnError) {
          return { ok:false, state:'no-interruption-evidence' };
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
      const committedResult = (extra = {}) => ({
        ok: true,
        conversationId: resolved.conversationId,
        locatedRuntimeKey: resolved.runtimeKey,
        locatedPort: resolved.port,
        attempt,
        purpose,
        runtimeBinding: false,
        foregroundActivation: false,
        pageNavigation: false,
        markerPersisted: false,
        rawMessagePersisted: false,
        dispatchCommitted: true,
        visibilityVerified: true,
        ...extra,
      });
      if (preflight?.alreadyVisible === true) {
        return committedResult({ state: "already-visible", alreadyVisible: true });
      }
      if (!preflight?.ok) {
        return { ...preflight, definiteFailure: true, dispatchCommitted: false };
      }
      await page.call("Input.insertText", { text });
      await this.sleep(350);
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
      if (!submitted?.ok) {
        return { ...submitted, definiteFailure: true, dispatchCommitted: false };
      }

      let verified = null;
      try {
        for (let poll = 0; poll < 20; poll += 1) {
          await this.sleep(poll === 0 ? 500 : 250);
          verified = await page.evaluate(`(() => {
            const expected = ${JSON.stringify(resolved.conversationId)};
            const expectedPrefix = ${JSON.stringify(expectedPrefix)};
            const expectedText = ${JSON.stringify(text)};
            const actual = location.pathname.match(/\\/c\\/([^/?#]+)/)?.[1] || null;
            if (actual !== expected) return { ok:false, state:'route-changed-after-send' };
            const users = [...document.querySelectorAll('[data-message-author-role="user"]')];
            const latest = String(users.at(-1)?.innerText || users.at(-1)?.textContent || '').trim();
            return {
              ok: latest === expectedText || latest.startsWith(expectedPrefix),
              state: latest ? 'visible' : 'missing',
            };
          })()`);
          if (verified?.ok || verified?.state === "route-changed-after-send") break;
        }
      } catch (error) {
        return {
          ok: false,
          state: "submitted-verification-error",
          error: error instanceof Error ? error.message : String(error),
          dispatchCommitted: true,
          visibilityVerified: false,
          definiteFailure: false,
          conversationId: resolved.conversationId,
          purpose,
          attempt,
        };
      }
      return verified?.ok
        ? committedResult({ state: verified.state || "visible" })
        : {
            ...(verified || { state: "submitted-unverified" }),
            ok: false,
            dispatchCommitted: true,
            visibilityVerified: false,
            definiteFailure: false,
            conversationId: resolved.conversationId,
            purpose,
            attempt,
          };
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
