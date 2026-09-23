import { createHash } from "node:crypto";
import { readComposerDraft } from './classic-composer-draft.js';
import { runtimePortsForClassicKey } from './classic-main-debug-ports.js';

export const INTERRUPTED_TURN_RESCUE_TEXT = "- 繼續";
const TURN_ERROR_PATTERN_SOURCE = "something went wrong|error generating|network error|thinking failed|thought failed|thinking interrupted|thought interrupted|發生錯誤|出現問題|網絡錯誤|思考失敗|思考失败|已中斷思考|已中断思考|再試一次";

export function isClassicTurnErrorText(value) {
  return new RegExp(TURN_ERROR_PATTERN_SOURCE, "i").test(String(value || ""));
}

function cleanConversationId(value) {
  const text = String(value ?? "").trim();
  return text && /^[A-Za-z0-9_-]{8,200}$/.test(text) ? text : null;
}

function cleanMessageId(value) {
  const text = String(value ?? "").trim();
  return text && /^[A-Za-z0-9_-]{8,200}$/.test(text) ? text : null;
}

function cleanRuntimeKey(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^main-\d{2}$/.test(text) ? text : null;
}

function runtimePort(runtimeKey) {
  return runtimePortsForClassicKey(runtimeKey)[0] ?? null;
}

function runtimePorts(runtimeKey) {
  return runtimePortsForClassicKey(runtimeKey);
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
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'chatgpt.com') return null;
    return parsed.pathname.match(/\/c\/([^/?#]+)/)?.[1] || null;
  } catch {
    return null;
  }
}

async function targetsForPort(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { cache: "no-store", signal: AbortSignal.timeout(1500) });
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
    const turnSections = [...document.querySelectorAll('section[data-testid^="conversation-turn-"]')].filter(visible);
    // Failed assistant turns often contain no data-message-author-role node at
    // all. The last visible turn section is therefore the authoritative UI
    // boundary; fall back to the latest role-bearing message only for older UI.
    const latestTurnContainer = turnSections.at(-1)
      || messageNodes.at(-1)?.closest('article')
      || messageNodes.at(-1)
      || null;
    const latestTurnMessages = latestTurnContainer
      ? [...latestTurnContainer.querySelectorAll('[data-message-author-role]')].filter(visible)
      : [];
    const latestMessage = latestTurnMessages.at(-1) || messageNodes.at(-1) || null;
    const latestMessageRole = latestMessage?.getAttribute('data-message-author-role') || null;
    const latestMessageText = String(latestMessage?.innerText || latestMessage?.textContent || '').trim();
    const userMessages = messageNodes.filter((node) => node.getAttribute('data-message-author-role') === 'user');
    const latestUserMessageId = userMessages.at(-1)?.getAttribute('data-message-id') || null;
    const previousUserMessageId = userMessages.at(-2)?.getAttribute('data-message-id') || null;
    // Current ChatGPT failure UI (for example the Cantonese Thinking-failed
    // button) is a role-less sibling inside the turn SECTION. Scope to only
    // that last turn rather than scanning older errors elsewhere on the page.
    const errorNodes = latestTurnContainer
      ? [...latestTurnContainer.querySelectorAll('button,[role="alert"],[data-testid*="error" i],[data-testid*="retry" i]')].filter(visible)
      : [];
    const turnErrorPattern = new RegExp(${JSON.stringify(TURN_ERROR_PATTERN_SOURCE)}, 'i');
    const rolelessTurnError = latestTurnMessages.length === 0
      && latestTurnContainer
      && turnErrorPattern.test(String(latestTurnContainer.innerText || latestTurnContainer.textContent || ''));
    const hasTurnError = rolelessTurnError
      || errorNodes.some((node) => turnErrorPattern.test(String(node.innerText || node.textContent || '')))
      || buttons.some((button) => (
        /retry|try again|重試|再試/i.test(String(button.getAttribute('aria-label') || button.title || button.textContent || ''))
        && latestTurnContainer
        && latestTurnContainer.contains(button)
      ));
    const root = document.getElementById('devspace-progress-narration-root');
    return {
      exact: actual === expected,
      conversationId: actual,
      hydrated: document.readyState === 'complete' && Boolean(editor),
      generating,
      latestMessageRole,
      latestMessageTextLength: latestMessageText.length,
      latestUserMessageId,
      previousUserMessageId,
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

// Bounded fallback for very large/partially failed ChatGPT pages. It reads
// only the current route, composer, stop control and final turn section. This
// is sufficient to preserve interrupted-turn evidence without walking every
// visible message node. The fallback is never used to select another page or
// another conversation and is clearly marked in the returned diagnostics.
function lightweightExactConversationExpression(conversationId) {
  return `(() => {
    const expected=${JSON.stringify(conversationId)};
    const actual=location.pathname.match(/\\/c\\/([^/?#]+)/)?.[1]||null;
    const editor=document.querySelector('#prompt-textarea, textarea, div.ProseMirror[contenteditable="true"], [data-lexical-editor="true"][contenteditable="true"], [contenteditable="true"][role="textbox"]');
    const composerText=editor?String(editor instanceof HTMLTextAreaElement?editor.value:editor.innerText||editor.textContent||'').replace(/\\u2060/g,'').trim():null;
    const generating=Boolean(document.querySelector('[data-testid="stop-button"]'));
    const turns=[...document.querySelectorAll('section[data-testid^="conversation-turn-"]')];
    const lastTurn=turns.at(-1)||null;
    const roleNodes=lastTurn?[...lastTurn.querySelectorAll('[data-message-author-role]')]:[];
    const fallbackRoles=[...document.querySelectorAll('[data-message-author-role]')];
    const latestMessage=roleNodes.at(-1)||fallbackRoles.at(-1)||null;
    const latestMessageRole=latestMessage?.getAttribute('data-message-author-role')||null;
    const latestMessageText=String(latestMessage?.innerText||latestMessage?.textContent||'').trim();
    const users=fallbackRoles.filter(node=>node.getAttribute('data-message-author-role')==='user');
    const lastTurnText=String(lastTurn?.innerText||lastTurn?.textContent||'');
    const errorPattern=new RegExp(${JSON.stringify(TURN_ERROR_PATTERN_SOURCE)},'i');
    const hasTurnError=Boolean(lastTurn&&errorPattern.test(lastTurnText));
    const root=document.getElementById('devspace-progress-narration-root');
    return {
      exact:actual===expected,conversationId:actual,hydrated:document.readyState==='complete'&&Boolean(editor),
      generating,latestMessageRole,latestMessageTextLength:latestMessageText.length,
      latestUserMessageId:users.at(-1)?.getAttribute('data-message-id')||null,
      previousUserMessageId:users.at(-2)?.getAttribute('data-message-id')||null,
      hasTurnError,normalCompletion:!generating&&latestMessageRole==='assistant'&&latestMessageText.length>0&&!hasTurnError,
      incompleteUserTurn:!generating&&latestMessageRole==='user',composerFound:Boolean(editor),composerEmpty:composerText==='',
      composerLength:composerText==null?null:composerText.length,progressCardMounted:Boolean(root),
      progressConversationId:root?.dataset?.conversationId||actual,url:location.href,
      inspectionFallback:'latest-turn-bounded'
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
      for (const port of runtimePorts(runtimeKey)) {
        try {
          const targets = await this.listTargets(port);
          for (const target of Array.isArray(targets) ? targets : []) {
            if (target?.type !== "page" || !target?.webSocketDebuggerUrl) continue;
            if (conversationIdFromUrl(target.url) !== id) continue;
            matches.push({ runtimeKey, port, target });
          }
        } catch {
          // An offline canonical/fallback port cannot invalidate the same
          // runtime discovered on its observed launch port or another Main.
        }
      }
    }
    if (matches.length > 1) {
      // The same exact conversation may be open in more than one Classic
      // window. Runtime is only a locator, so resolve the duplicate safely
      // when exactly one copy proves it is the active/interrupted turn and all
      // other copies can be inspected as inactive. Two active/unknown copies
      // remain ambiguous and fail closed.
      const inspected = [];
      for (const match of matches) {
        try { inspected.push(await this.#inspectMatch(match, id)); } catch {}
      }
      const active = inspected.filter((page) => page?.exact
        && page?.hydrated
        && page?.composerFound
        && page?.composerEmpty
        && (page?.generating === true || page?.hasTurnError === true || page?.incompleteUserTurn === true));
      if (inspected.length === matches.length && active.length === 1) {
        return {
          ...active[0],
          duplicatePageObserved: true,
          duplicateMatchCount: matches.length,
          duplicateResolvedByUniqueActivePage: true,
        };
      }
      return {
        exact: false,
        ambiguous: true,
        state: inspected.length !== matches.length
          ? "duplicate-conversation-page-inspection-incomplete"
          : "duplicate-conversation-pages",
        conversationId: id,
        matchCount: matches.length,
        activeMatchCount: active.length,
      };
    }
    if (matches.length === 0) {
      return {
        exact: false,
        ambiguous: false,
        state: "conversation-page-not-open",
        conversationId: id,
        matchCount: 0,
      };
    }
    return await this.#inspectMatch(matches[0], id);
  }

  async findAtRuntime({ conversationId, runtimeKey } = {}) {
    const id = cleanConversationId(conversationId);
    const key = cleanRuntimeKey(runtimeKey);
    if (!id || !key) return { exact: false, state: "invalid-conversation-or-runtime" };
    const matches = [];
    const attemptedPorts = runtimePorts(key);
    const onlinePorts = [];
    for (const port of attemptedPorts) {
      try {
        const targets = await this.listTargets(port);
        onlinePorts.push(port);
        for (const target of Array.isArray(targets) ? targets : []) {
          if (target?.type !== "page" || !target?.webSocketDebuggerUrl) continue;
          if (conversationIdFromUrl(target.url) !== id) continue;
          matches.push({ runtimeKey: key, port, target });
        }
      } catch {}
    }
    if (matches.length !== 1) {
      return {
        exact: false,
        ambiguous: matches.length > 1,
        state: matches.length > 1
          ? "duplicate-conversation-pages-in-runtime"
          : onlinePorts.length
            ? "conversation-not-in-runtime"
            : "runtime-unavailable",
        conversationId: id,
        runtimeKey: key,
        port: attemptedPorts[0] ?? null,
        attemptedPorts,
        onlinePorts,
        matchCount: matches.length,
        locatorOnly: true,
        runtimeBinding: false,
      };
    }
    try {
      return await this.#inspectMatch(matches[0], id);
    } catch (error) {
      return {
        exact: false,
        state: "runtime-page-inspection-failed",
        errorName: error instanceof Error ? error.name : "Error",
        conversationId: id,
        runtimeKey: key,
        port: matches[0].port,
        attemptedPorts,
        locatorOnly: true,
        runtimeBinding: false,
      };
    }
  }

  async findUniqueActiveConversation({
    requireGenerating = true,
    allowIncompleteUserTurn = false,
    requireProgressCard = true,
  } = {}) {
    const candidates = [];
    for (const runtimeKey of this.runtimeKeys) {
      for (const port of runtimePorts(runtimeKey)) {
        try {
          const targets = await this.listTargets(port);
          for (const target of Array.isArray(targets) ? targets : []) {
            if (target?.type !== "page" || !target?.webSocketDebuggerUrl) continue;
            const conversationId = cleanConversationId(conversationIdFromUrl(target.url));
            if (!conversationId) continue;
            const inspected = await this.#inspectMatch({ runtimeKey, port, target }, conversationId);
            if (!inspected?.exact || !inspected?.hydrated || !inspected?.composerFound || !inspected?.composerEmpty) continue;
            if (requireProgressCard && (
              inspected.progressCardMounted !== true
              || inspected.progressConversationId !== conversationId
            )) continue;
            const active = inspected.generating === true
              || (allowIncompleteUserTurn && inspected.incompleteUserTurn === true);
            if (requireGenerating && !active) continue;
            candidates.push(inspected);
          }
        } catch {
          // Offline runtimes and transient CDP failures are ignored. A fallback
          // is valid only when exactly one remaining page proves itself active.
        }
      }
    }
    if (candidates.length !== 1) {
      return {
        exact: false,
        ambiguous: candidates.length > 1,
        state: candidates.length > 1
          ? "multiple-active-conversation-pages"
          : "no-active-conversation-page",
        matchCount: candidates.length,
        pageVerified: false,
        runtimeBinding: false,
      };
    }
    return {
      ...candidates[0],
      exact: true,
      uniqueActiveConversation: true,
      pageVerified: true,
      runtimeBinding: false,
      locatorOnly: true,
    };
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

  async sendContinue({ conversationId, target = null, attempt = 1, sourceUserMessageId = null } = {}) {
    const resolved = await this.#resolveExactTarget(conversationId, target);
    if (!resolved.ok) return resolved;
    const sourceId = cleanMessageId(sourceUserMessageId);
    if (!sourceId) return { ok: false, definiteFailure: true, dispatchCommitted: false, state: 'rescue-source-user-required' };
    const text = INTERRUPTED_TURN_RESCUE_TEXT;
    return await this.#sendConversationMessage({
      resolved,
      text,
      expectedPrefix: INTERRUPTED_TURN_RESCUE_TEXT,
      purpose: "interrupted-turn-rescue",
      attempt,
      allowNormalCompletion: false,
      requireInterruptionEvidence: true,
      rescueBoundary: { sourceUserMessageId: sourceId },
    });
  }

  async sendGoalRecovery({ conversationId, target = null, prompt, attempt = 1 } = {}) {
    void conversationId; void target; void prompt; void attempt;
    // Goal continuation and same-round Goal recovery are host-owned hidden
    // assistant continuations. They must never type policy/control text into
    // the user's composer or create a visible synthetic user message. Keep a
    // hard fail-closed compatibility method so a stale caller cannot silently
    // revive the retired page-composer transport.
    return {
      ok: false,
      definiteFailure: true,
      dispatchCommitted: false,
      visibilityVerified: false,
      state: "visible-goal-recovery-transport-retired",
    };
  }

  async sendGoalContinuation({ conversationId, target, sourceUserId, assistantMessageId } = {}) {
    void conversationId; void target; void sourceUserId; void assistantMessageId;
    return {
      ok: false,
      definiteFailure: true,
      dispatchCommitted: false,
      visibilityVerified: false,
      state: "visible-goal-continuation-transport-retired",
    };
  }

  async #sendConversationMessage({
    resolved,
    text,
    expectedPrefix,
    purpose,
    attempt,
    allowNormalCompletion = false,
    requireInterruptionEvidence = true,
    goalBoundary = null,
    rescueBoundary = null,
  }) {
    const page = await this.connect(resolved.target);
    const marker = markerFor(resolved.conversationId, `${purpose}:${attempt}`);
    let submissionAttempted = false;
    try {
      const preflight = await page.evaluate(`(() => {
        const expected = ${JSON.stringify(resolved.conversationId)};
        const expectedText = ${JSON.stringify(text)};
        const allowNormalCompletion = ${allowNormalCompletion === true};
        const requireInterruptionEvidence = ${requireInterruptionEvidence !== false};
        const goalBoundary = ${JSON.stringify(goalBoundary)};
        const rescueBoundary = ${JSON.stringify(rescueBoundary)};
        const actual = location.pathname.match(/\\/c\\/([^/?#]+)/)?.[1] || null;
        const draftText = ${readComposerDraft.toString()};
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
        const turnSections = [...document.querySelectorAll('section[data-testid^="conversation-turn-"]')].filter(visible);
        const latestTurnContainer = turnSections.at(-1)
          || messageNodes.at(-1)?.closest('article')
          || messageNodes.at(-1)
          || null;
        const latestTurnMessages = latestTurnContainer
          ? [...latestTurnContainer.querySelectorAll('[data-message-author-role]')].filter(visible)
          : [];
        const latestMessage = latestTurnMessages.at(-1) || messageNodes.at(-1) || null;
        const latestMessageRole = latestMessage?.getAttribute('data-message-author-role') || null;
        const latestMessageText = String(latestMessage?.innerText || latestMessage?.textContent || '').trim();
        const latestUser = [...messageNodes].reverse().find((node) => node.getAttribute('data-message-author-role') === 'user') || null;
        const latestUserText = String(latestUser?.innerText || latestUser?.textContent || '').trim();
        const userMessages = messageNodes.filter((node) => node.getAttribute('data-message-author-role') === 'user');
        const latestUserId = userMessages.at(-1)?.getAttribute('data-message-id') || null;
        const previousUserId = userMessages.at(-2)?.getAttribute('data-message-id') || null;
        if (goalBoundary && (latestUser?.getAttribute('data-message-id') !== goalBoundary.sourceUserId
          || latestMessageRole !== 'assistant'
          || latestMessage?.getAttribute('data-message-id') !== goalBoundary.assistantMessageId)) {
          return { ok:false, state:'goal-source-turn-changed' };
        }
        if (rescueBoundary && latestUserId !== rescueBoundary.sourceUserMessageId) {
          if (latestUserText === expectedText && previousUserId === rescueBoundary.sourceUserMessageId) {
            return { ok:true, state:'already-visible', alreadyVisible:true };
          }
          return { ok:false, state:'rescue-source-turn-changed' };
        }
        if (!goalBoundary && !rescueBoundary && latestUserText === expectedText) {
          return { ok:true, state:'already-visible', alreadyVisible:true };
        }
        const errorNodes = latestTurnContainer
          ? [...latestTurnContainer.querySelectorAll('button,[role="alert"],[data-testid*="error" i],[data-testid*="retry" i]')].filter(visible)
          : [];
        const turnErrorPattern = new RegExp(${JSON.stringify(TURN_ERROR_PATTERN_SOURCE)}, 'i');
        const rolelessTurnError = latestTurnMessages.length === 0
          && latestTurnContainer
          && turnErrorPattern.test(String(latestTurnContainer.innerText || latestTurnContainer.textContent || ''));
        const hasTurnError = rolelessTurnError
          || errorNodes.some((node) => turnErrorPattern.test(String(node.innerText || node.textContent || '')))
          || buttons.some((button) => (
            /retry|try again|重試|再試/i.test(String(button.getAttribute('aria-label') || button.title || button.textContent || ''))
            && latestTurnContainer
            && latestTurnContainer.contains(button)
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
        const existing = draftText(editor);
        if (existing !== '') return { ok:false, state:'composer-not-empty' };
        editor.setAttribute('data-devspace-liveness-send', ${JSON.stringify(marker)});
        editor.focus();
        if (!(editor instanceof HTMLTextAreaElement)) {
          const selection = getSelection(); const range = document.createRange();
          range.selectNodeContents(editor); range.collapse(false);
          selection.removeAllRanges(); selection.addRange(range);
        }
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
      submissionAttempted = true; // a lost CDP acknowledgement may follow a successful click
      const cleanupUnsentDraft = async () => {
        try {
          return await page.evaluate(`(() => {
            const marker = ${JSON.stringify(marker)};
            const expectedText = ${JSON.stringify(text)};
            const draftText = ${readComposerDraft.toString()};
            const editor = document.querySelector('[data-devspace-liveness-send="' + marker + '"]');
            if (!editor || draftText(editor) !== expectedText) return { cleaned:false, state:'ownership-lost' };
            if (editor instanceof HTMLTextAreaElement) editor.value = '';
            else editor.textContent = '';
            editor.removeAttribute('data-devspace-liveness-send');
            editor.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'deleteContentBackward', data:null }));
            return { cleaned:draftText(editor) === '', state:'unsent-draft-cleaned' };
          })()`);
        } catch { return { cleaned:false, state:'cleanup-unavailable' }; }
      };
      const submitted = await page.evaluate(`(() => {
        const marker = ${JSON.stringify(marker)};
        const expectedConversation = ${JSON.stringify(resolved.conversationId)};
        const expectedText = ${JSON.stringify(text)};
        const draftText = ${readComposerDraft.toString()};
        const goalBoundary = ${JSON.stringify(goalBoundary)};
        const rescueBoundary = ${JSON.stringify(rescueBoundary)};
        if (location.pathname.match(/\\/c\\/([^/?#]+)/)?.[1] !== expectedConversation) return {ok:false,state:'route-changed-before-send'};
        if (document.querySelector('button[data-testid="stop-button"]')) return {ok:false,state:'turn-started-before-send'};
        const nodes = [...document.querySelectorAll('[data-message-author-role]')];
        if (goalBoundary) {
          const user = [...nodes].reverse().find(n => n.getAttribute('data-message-author-role') === 'user');
          const last = nodes.at(-1);
          if (user?.getAttribute('data-message-id') !== goalBoundary.sourceUserId || last?.getAttribute('data-message-id') !== goalBoundary.assistantMessageId) return {ok:false,state:'goal-source-turn-changed'};
        }
        if (rescueBoundary) {
          const users = nodes.filter(n => n.getAttribute('data-message-author-role') === 'user');
          if (users.at(-1)?.getAttribute('data-message-id') !== rescueBoundary.sourceUserMessageId) return {ok:false,state:'rescue-source-turn-changed'};
        }
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 5 && rect.height > 5 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const editor = document.querySelector('[data-devspace-liveness-send="' + marker + '"]');
        if (!editor) return { ok:false, state:'composer-lost' };
        const inserted = draftText(editor);
        if (inserted !== expectedText) return { ok:false, state:'composer-text-changed' };
        const buttons = [...document.querySelectorAll('button')].filter(visible);
        const send = buttons.find((button) => button.matches('[data-testid="send-button"]'))
          || buttons.find((button) => /send|傳送|发送|送出/i.test(String(button.getAttribute('aria-label') || button.title || '')));
        if (!send || send.disabled || send.getAttribute('aria-disabled') === 'true') return { ok:false, state:'send-unavailable' };
        editor.removeAttribute('data-devspace-liveness-send');
        send.click();
        return { ok:true };
      })()`);
      if (!submitted?.ok) {
        const cleanup = await cleanupUnsentDraft();
        if (cleanup?.cleaned === true) submissionAttempted = false;
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
            const strictGoalBoundary = ${Boolean(goalBoundary)};
            const rescueBoundary = ${JSON.stringify(rescueBoundary)};
            const actual = location.pathname.match(/\\/c\\/([^/?#]+)/)?.[1] || null;
            if (actual !== expected) return { ok:false, state:'route-changed-after-send' };
            const users = [...document.querySelectorAll('[data-message-author-role="user"]')];
            const latestUser = users.at(-1) || null;
            const previousUser = users.at(-2) || null;
            const latest = String(latestUser?.innerText || latestUser?.textContent || '').trim();
            const normalized = latest.replace(/^DevSpace Local Gateway\\s*/, '').trim();
            const rescueSequence = !rescueBoundary || (
              latestUser?.getAttribute('data-message-id') !== rescueBoundary.sourceUserMessageId
              && previousUser?.getAttribute('data-message-id') === rescueBoundary.sourceUserMessageId
            );
            return {
              ok: rescueSequence && (normalized === expectedText || (!strictGoalBoundary && !rescueBoundary && normalized.startsWith(expectedPrefix))),
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
    } catch (error) {
      if (submissionAttempted) {
        try {
          const cleanup = await page.evaluate(`(() => {
            const marker = ${JSON.stringify(marker)};
            const expectedText = ${JSON.stringify(text)};
            const draftText = ${readComposerDraft.toString()};
            const editor = document.querySelector('[data-devspace-liveness-send="' + marker + '"]');
            if (!editor || draftText(editor) !== expectedText) return { cleaned:false };
            if (editor instanceof HTMLTextAreaElement) editor.value = '';
            else editor.textContent = '';
            editor.removeAttribute('data-devspace-liveness-send');
            editor.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'deleteContentBackward', data:null }));
            return { cleaned:draftText(editor) === '' };
          })()`);
          if (cleanup?.cleaned === true) submissionAttempted = false;
        } catch {}
      }
      return { ok: false, state: 'transport-acknowledgement-uncertain',
        error: error instanceof Error ? error.message : String(error),
        dispatchCommitted: submissionAttempted, definiteFailure: !submissionAttempted,
        visibilityVerified: false };
    } finally {
      page.close();
    }
  }

  async close() {}

  async #inspectMatch(match, conversationId) {
    let page = null;
    let result;
    let fallbackError = null;
    try {
      try {
        page = await this.connect(match.target);
        result = await page.evaluate(exactConversationExpression(conversationId));
      } catch (error) {
        fallbackError = error instanceof Error ? error.name : 'Error';
        page?.close?.();
        page = null;
        await this.sleep(50);
        page = await this.connect(match.target);
        result = await page.evaluate(lightweightExactConversationExpression(conversationId));
      }
      return {
        ...result,
        ...(fallbackError ? { primaryInspectionErrorName: fallbackError, boundedInspectionFallback: true } : {}),
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
      page?.close?.();
    }
  }

  async #resolveExactTarget(conversationId, supplied = null) {
    const id = cleanConversationId(conversationId);
    if (!id) return { ok: false, state: "invalid-conversation" };

    if (supplied?.exact === true && supplied?.conversationId === id && supplied?.target?.webSocketDebuggerUrl) {
      const runtimeKey = cleanRuntimeKey(supplied.target.runtimeKey || supplied.runtimeKey);
      const port = Number(supplied.target.port || supplied.port);
      if (runtimeKey && runtimePorts(runtimeKey).includes(port) && conversationIdFromUrl(supplied.target.url) === id) {
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
  runtimePorts,
  markerFor,
  localMinute,
  conversationIdFromUrl,
  exactConversationExpression,
  lightweightExactConversationExpression,
  TURN_ERROR_PATTERN_SOURCE,
};
