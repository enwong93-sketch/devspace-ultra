import { ClassicCdpClient } from "./classic-cdp-client.js";

const DEFAULT_PRIMARY_DEBUG_PORT = 9721;
const DEFAULT_INTERACTIVE_DEBUG_BASE_PORT = 9730;
const MIN_INTERACTIVE_MAIN = 2;
const MAX_INTERACTIVE_MAIN = 32;
const DEFAULT_PROBE_TIMEOUT_MS = 500;
const DEFAULT_CONTEXT_SETTLE_MS = 80;
const DEFAULT_VISIBLE_REPORT_TIMEOUT_MS = 30_000;
const DEFAULT_VISIBLE_REPORT_POLL_MS = 150;
const DEFAULT_VISIBLE_REPORT_SETTLE_MS = 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function runtimeLabelForPort(port) {
  if (port === DEFAULT_PRIMARY_DEBUG_PORT) return "Main-01";
  const number = port - DEFAULT_INTERACTIVE_DEBUG_BASE_PORT;
  if (number >= MIN_INTERACTIVE_MAIN && number <= MAX_INTERACTIVE_MAIN) {
    return `Main-${String(number).padStart(2, "0")}`;
  }
  return `Main@${port}`;
}

function conversationIdFromPageUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.pathname.match(/\/c\/([^/?#]+)/)?.[1] || null;
  } catch {
    return null;
  }
}

export async function waitForVisibleReportBoundary({
  inspect,
  reportedAt,
  minimumReportSettleMs = DEFAULT_VISIBLE_REPORT_SETTLE_MS,
  timeoutMs = DEFAULT_VISIBLE_REPORT_TIMEOUT_MS,
  pollMs = DEFAULT_VISIBLE_REPORT_POLL_MS,
  now = () => Date.now(),
  sleep: sleepImpl = sleep,
} = {}) {
  if (typeof inspect !== "function") throw new Error("Visible Goal report boundary requires an inspect adapter.");
  const startedAt = now();
  const reportedAtMs = Date.parse(String(reportedAt || ""));
  let last = null;
  let lastError = null;
  while ((now() - startedAt) <= timeoutMs) {
    try {
      last = await inspect();
      lastError = null;
      if (last?.chatMode === false) {
        return {
          ok: false,
          definiteFailure: true,
          error: "Goal continuation visible-report gate requires Chat mode.",
        };
      }
      const reportSettled = !Number.isFinite(reportedAtMs)
        || (now() - reportedAtMs) >= minimumReportSettleMs;
      const nativeComplete = String(last?.streamStatus || "").toUpperCase() === "COMPLETE";
      const committed = (
        reportSettled &&
        last?.chatMode === true &&
        last?.generating === false &&
        nativeComplete &&
        typeof last?.latestAssistantText === "string" &&
        last.latestAssistantText.trim().length > 0
      );
      if (committed) {
        return {
          ok: true,
          committed: true,
          deliveryFailed: false,
          latestAssistantText: last.latestAssistantText,
          conversationId: last.conversationId || null,
        };
      }
      const deliveryFailedTerminal = (
        reportSettled
        && last?.chatMode === true
        && nativeComplete
        && last?.deliveryTimeoutVisible === true
        && last?.retryVisible === true
        && last?.safetyCheckVisible !== true
      );
      if (deliveryFailedTerminal) {
        return {
          ok: true,
          committed: false,
          deliveryFailed: true,
          latestAssistantText: typeof last?.latestAssistantText === "string" ? last.latestAssistantText : "",
          conversationId: last?.conversationId || null,
        };
      }
    } catch (error) {
      lastError = errorMessage(error);
    }
    await sleepImpl(pollMs);
  }
  return {
    ok: false,
    definiteFailure: false,
    error: lastError
      ? `Visible Goal round report was not committed before continuation dispatch: ${lastError}`
      : "Visible Goal round report was not committed before continuation dispatch.",
    last,
  };
}

export function defaultMainDebugPorts() {
  return [
    DEFAULT_PRIMARY_DEBUG_PORT,
    ...Array.from(
      { length: MAX_INTERACTIVE_MAIN - MIN_INTERACTIVE_MAIN + 1 },
      (_, index) => DEFAULT_INTERACTIVE_DEBUG_BASE_PORT + MIN_INTERACTIVE_MAIN + index,
    ),
  ];
}

class CdpClient extends ClassicCdpClient {
  constructor(url, { WebSocketImpl = globalThis.WebSocket, timeoutMs = 5_000 } = {}) {
    super(url, { WebSocketImpl, callTimeoutMs: Math.max(250, Number(timeoutMs) || 5_000), maxPendingCalls: 64 });
    this.contexts = [];
  }

  async open() {
    await super.open();
    this.on("Runtime.executionContextCreated", (params) => {
      if (params?.context) this.contexts.push(params.context);
    });
    this.on("Runtime.executionContextDestroyed", (params) => {
      this.contexts = this.contexts.filter((context) => context.id !== params?.executionContextId);
    });
    this.on("Runtime.executionContextsCleared", () => {
      this.contexts = [];
    });
  }
}

async function fetchJson(url, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable for ChatGPT Classic Goal host bridge.");
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

function chooseInnerContext(client, targetId) {
  return [...client.contexts].reverse().find((context) => (
    context.auxData?.isDefault &&
    context.auxData?.frameId &&
    context.auxData.frameId !== targetId
  )) || [...client.contexts].reverse().find((context) => context.auxData?.isDefault) || null;
}

function widgetGoalExpression() {
  return `(() => {
    const value = window.openai?.toolOutput;
    const goal = value?.structuredContent?.goal ?? value?.structured_content?.goal ?? value?.toolResult?.structuredContent?.goal ?? value?.goal ?? null;
    return {
      title: document.title || "",
      goalId: typeof goal?.id === "string" ? goal.id : null,
    };
  })()`;
}

async function inspectWidgetTarget(target, runtimePort, options) {
  const client = new CdpClient(target.webSocketDebuggerUrl, options);
  await client.open();
  try {
    await client.call("Runtime.enable");
    await sleep(options.contextSettleMs ?? DEFAULT_CONTEXT_SETTLE_MS);
    const context = chooseInnerContext(client, target.id);
    if (!context) return null;
    const result = await client.call("Runtime.evaluate", {
      contextId: context.id,
      expression: widgetGoalExpression(),
      returnByValue: true,
    });
    const value = result.result?.value;
    if (!value?.goalId) return null;
    return {
      runtimePort,
      runtimeLabel: runtimeLabelForPort(runtimePort),
      targetId: target.id,
      webSocketDebuggerUrl: target.webSocketDebuggerUrl,
      pageTargetId: options.pageTargetId || null,
      pageWebSocketDebuggerUrl: options.pageWebSocketDebuggerUrl || null,
      pageUrl: options.pageUrl || null,
      conversationId: conversationIdFromPageUrl(options.pageUrl),
      title: value.title || target.title || "",
      goalId: value.goalId,
      chatMode: true,
      relayOnly: false,
    };
  } finally {
    client.close();
  }
}

async function inspectRelayTarget(target, runtimePort, options) {
  const client = new CdpClient(target.webSocketDebuggerUrl, options);
  await client.open();
  try {
    await client.call("Runtime.enable");
    await sleep(options.contextSettleMs ?? DEFAULT_CONTEXT_SETTLE_MS);
    const context = chooseInnerContext(client, target.id);
    if (!context) return null;
    const result = await client.call("Runtime.evaluate", {
      contextId: context.id,
      expression: `(() => ({
        canFollowUp: typeof window.openai?.sendFollowUpMessage === 'function',
        title: document.title || ''
      }))()`,
      returnByValue: true,
    });
    const value = result.result?.value;
    if (value?.canFollowUp !== true) return null;
    return {
      runtimePort,
      runtimeLabel: runtimeLabelForPort(runtimePort),
      targetId: target.id,
      webSocketDebuggerUrl: target.webSocketDebuggerUrl,
      pageTargetId: options.pageTargetId || null,
      pageWebSocketDebuggerUrl: options.pageWebSocketDebuggerUrl || null,
      pageUrl: options.pageUrl || null,
      conversationId: conversationIdFromPageUrl(options.pageUrl),
      title: value.title || target.title || "",
      goalId: null,
      chatMode: true,
      relayOnly: true,
    };
  } finally {
    client.close();
  }
}

export async function inspectVisibleReportCommit(candidate, options = {}) {
  if (!candidate?.pageWebSocketDebuggerUrl) {
    throw new Error("Goal visible-report inspection requires a ChatGPT page CDP target.");
  }
  const client = new CdpClient(candidate.pageWebSocketDebuggerUrl, options);
  await client.open();
  try {
    await client.call("Runtime.enable");
    const result = await client.call("Runtime.evaluate", {
      expression: `(async () => {
        const href = location.href;
        const radios = [...document.querySelectorAll('[role="radio"]')];
        const workRadio = radios.find((el) => /^(工作|Work)$/i.test((el.innerText || el.textContent || '').trim()));
        const chatMode = !/[?&]surface=work(?:&|$)/i.test(href) && workRadio?.getAttribute('aria-checked') !== 'true';
        const generating = Boolean(document.querySelector('button[data-testid="stop-button"]'));
        const retryButtons = [...document.querySelectorAll('button')].filter((button) => /^(重試|Retry|再試一次|Try again)$/i.test((button.innerText || button.textContent || '').trim()));
        const deliveryTimeoutVisible = retryButtons.some((button) => {
          let node = button;
          for (let depth = 0; depth < 5 && node; depth += 1, node = node.parentElement) {
            const text = (node.innerText || node.textContent || '').trim();
            if (/(訊息|消息).{0,12}(遞送|傳送|发送|delivery).{0,12}(逾時|超時|timeout|timed out)|message delivery timed out/i.test(text)) return true;
          }
          return false;
        });
        const safetyCheckVisible = [...document.querySelectorAll('body *')].some((el) => {
          const text = (el.innerText || el.textContent || '').trim();
          if (!text || text.length > 260) return false;
          return /^(?:This request requires additional safety checks|Additional safety checks|此請求需要額外安全檢查|此请求需要额外安全检查|需要進行額外安全檢查|需要进行额外安全检查)/i.test(text);
        });
        const assistants = [...document.querySelectorAll('[data-message-author-role="assistant"]')]
          .map((el) => (el.innerText || '').trim())
          .filter(Boolean);
        const latestAssistantText = assistants.at(-1) || '';
        const match = location.pathname.match(/\\/c\\/([^/?#]+)/);
        const conversationId = match?.[1] || null;
        const lifecycleNow = Date.now();
        const documentLifecycleKey = '__devspaceClassicDocumentLifecycleV1';
        const routeLifecycleKey = '__devspaceClassicConversationLifecycleV1';
        const documentLifecycle = globalThis[documentLifecycleKey] || (globalThis[documentLifecycleKey] = {
          id: globalThis.crypto?.randomUUID?.() || ('document-' + lifecycleNow + '-' + Math.random().toString(36).slice(2)),
          createdAtMs: lifecycleNow,
        });
        const priorRoute = globalThis[routeLifecycleKey];
        let routeLifecycle = priorRoute;
        if (!routeLifecycle || routeLifecycle.documentId !== documentLifecycle.id || routeLifecycle.conversationId !== conversationId) {
          routeLifecycle = globalThis[routeLifecycleKey] = {
            documentId: documentLifecycle.id,
            conversationId,
            routeEpoch: Math.max(1, Number(priorRoute?.routeEpoch || 0) + 1),
            enteredAtMs: lifecycleNow,
            hydratedSinceMs: null,
            lastSeenAtMs: lifecycleNow,
          };
        }
        const composerReady = Boolean(document.querySelector('#prompt-textarea'));
        const visibleMessageCount = document.querySelectorAll('[data-message-author-role="user"],[data-message-author-role="assistant"]').length;
        const routeHydrated = Boolean(conversationId && document.readyState === 'complete' && composerReady && visibleMessageCount > 0);
        routeLifecycle.hydratedSinceMs = routeHydrated ? (routeLifecycle.hydratedSinceMs || lifecycleNow) : null;
        routeLifecycle.lastSeenAtMs = lifecycleNow;
        let streamStatus = null;
        if (conversationId) {
          try {
            const response = await fetch('/backend-api/conversation/' + conversationId + '/stream_status', {
              credentials: 'include',
              cache: 'no-store',
            });
            if (response.ok) {
              const data = await response.json();
              streamStatus = data?.status || null;
            }
          } catch {}
        }
        return {
          href,
          chatMode,
          generating,
          deliveryTimeoutVisible,
          retryVisible: retryButtons.length > 0,
          safetyCheckVisible,
          latestAssistantText,
          assistantCount: assistants.length,
          visibleMessageCount,
          conversationId,
          streamStatus,
          pageVisibilityState: document.visibilityState || null,
          documentReadyState: document.readyState || null,
          composerReady,
          documentId: documentLifecycle.id,
          routeEpoch: routeLifecycle.routeEpoch,
          routeEnteredAt: new Date(routeLifecycle.enteredAtMs).toISOString(),
          routeHydratedAt: routeLifecycle.hydratedSinceMs ? new Date(routeLifecycle.hydratedSinceMs).toISOString() : null,
          routeStableForMs: routeLifecycle.hydratedSinceMs ? Math.max(0, lifecycleNow - routeLifecycle.hydratedSinceMs) : 0,
          routeHydrated,
        };
      })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Goal visible-report inspection failed.");
    }
    const value = result.result?.value || null;
    return value ? {
      ...value,
      pageTargetId: candidate.pageTargetId || null,
      relayTargetId: candidate.targetId || null,
    } : null;
  } finally {
    client.close();
  }
}

export async function probeClassicMainPort(port, options = {}) {
  let targets;
  try {
    targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, options);
  } catch {
    return [];
  }
  if (!Array.isArray(targets)) return [];

  const page = targets.find((target) => target?.type === "page" && /chatgpt\.com/i.test(target.url || ""));
  if (!page) return [];
  if (/[?&]surface=work(?:&|$)/i.test(page.url || "")) return [];

  const widgets = targets.filter((target) => (
    target?.type === "iframe" &&
    /web-sandbox\.oaiusercontent\.com/i.test(target.url || "") &&
    typeof target.webSocketDebuggerUrl === "string"
  ));
  const found = [];
  for (const target of widgets) {
    try {
      const candidate = await inspectWidgetTarget(target, port, {
        ...options,
        pageTargetId: page.id,
        pageWebSocketDebuggerUrl: page.webSocketDebuggerUrl,
        pageUrl: page.url,
      });
      if (candidate) found.push(candidate);
    } catch {
      // One stale/tombstoned OOPIF must not block other widget candidates.
    }
  }
  return found;
}

export async function probeClassicRelayPort(port, conversationId, options = {}) {
  const expectedConversationId = String(conversationId || "").trim();
  if (!expectedConversationId) return [];
  let targets;
  try {
    targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, options);
  } catch {
    return [];
  }
  if (!Array.isArray(targets)) return [];
  const page = targets.find((target) => target?.type === "page" && /chatgpt\.com/i.test(target.url || ""));
  if (!page) return [];
  if (/[?&]surface=work(?:&|$)/i.test(page.url || "")) return [];
  if (conversationIdFromPageUrl(page.url) !== expectedConversationId) return [];

  const widgets = targets.filter((target) => (
    target?.type === "iframe" &&
    /web-sandbox\.oaiusercontent\.com/i.test(target.url || "") &&
    typeof target.webSocketDebuggerUrl === "string"
  ));
  const found = [];
  for (const target of widgets) {
    try {
      const candidate = await inspectRelayTarget(target, port, {
        ...options,
        pageTargetId: page.id,
        pageWebSocketDebuggerUrl: page.webSocketDebuggerUrl,
        pageUrl: page.url,
      });
      if (candidate?.conversationId === expectedConversationId) found.push(candidate);
    } catch {
      // A stale app iframe cannot invalidate another relay candidate.
    }
  }
  return found;
}

async function findRawHostObject(client, contextId) {
  const fn = (await client.call("Runtime.evaluate", {
    contextId,
    expression: "window.openai?.sendFollowUpMessage",
    returnByValue: false,
  })).result;
  if (!fn?.objectId) throw new Error("Goal widget public follow-up function is unavailable.");

  const fnProps = await client.call("Runtime.getProperties", {
    objectId: fn.objectId,
    ownProperties: false,
    accessorPropertiesOnly: false,
    generatePreview: false,
  });
  const scopesObjectId = fnProps.internalProperties?.find((property) => property.name === "[[Scopes]]")?.value?.objectId;
  if (!scopesObjectId) throw new Error("Goal widget follow-up closure scopes are unavailable.");

  const scopeList = await client.call("Runtime.getProperties", { objectId: scopesObjectId, ownProperties: true });
  for (const scopeEntry of (scopeList.result || []).filter((property) => /^\d+$/.test(property.name))) {
    const scopeObjectId = scopeEntry.value?.objectId;
    if (!scopeObjectId) continue;
    const scope = await client.call("Runtime.getProperties", { objectId: scopeObjectId, ownProperties: true });
    for (const property of scope.result || []) {
      const objectId = property.value?.objectId;
      if (!objectId) continue;
      const candidate = await client.call("Runtime.getProperties", { objectId, ownProperties: true });
      const send = (candidate.result || []).find((item) => item.name === "sendFollowUpMessage" && item.value?.type === "function");
      const callTool = (candidate.result || []).find((item) => item.name === "callTool" && item.value?.type === "function");
      if (send && callTool) return { objectId };
    }
  }
  throw new Error("Raw ChatGPT Classic Goal host API was not found in widget bridge closure.");
}

export async function sendRawHostFollowUp(candidate, payload, options = {}) {
  const client = new CdpClient(candidate.webSocketDebuggerUrl, options);
  await client.open();
  try {
    await client.call("Runtime.enable");
    await client.call("Debugger.enable");
    await sleep(options.contextSettleMs ?? DEFAULT_CONTEXT_SETTLE_MS);
    const context = chooseInnerContext(client, candidate.targetId);
    if (!context) throw new Error("Goal widget execution context is unavailable.");
    const rawHost = await findRawHostObject(client, context.id);
    const result = await client.call("Runtime.callFunctionOn", {
      objectId: rawHost.objectId,
      functionDeclaration: "function(message){ return this.sendFollowUpMessage(message); }",
      arguments: [{ value: { prompt: payload.prompt, scrollToBottom: false } }],
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Raw ChatGPT Classic follow-up RPC failed.");
    }
    return { ok: true };
  } finally {
    client.close();
  }
}

export class ClassicGoalHostBridge {
  constructor({
    ports = defaultMainDebugPorts(),
    probePort,
    probeRelayPort,
    sendRaw,
    beforeDispatch,
    beforeRawDispatch,
    waitForVisibleReport,
    inspectVisibleReport,
    visibleReportTimeoutMs = DEFAULT_VISIBLE_REPORT_TIMEOUT_MS,
    visibleReportPollMs = DEFAULT_VISIBLE_REPORT_POLL_MS,
    sleep: sleepImpl = sleep,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    contextSettleMs = DEFAULT_CONTEXT_SETTLE_MS,
  } = {}) {
    this.ports = [...ports];
    this.options = { fetchImpl, WebSocketImpl, timeoutMs: probeTimeoutMs, contextSettleMs };
    this.probePort = probePort || ((port) => probeClassicMainPort(port, this.options));
    this.probeRelayPort = probeRelayPort || ((port, conversationId) => probeClassicRelayPort(port, conversationId, this.options));
    this.sendRaw = sendRaw || ((candidate, payload) => sendRawHostFollowUp(candidate, payload, this.options));
    this.beforeDispatch = beforeDispatch;
    this.beforeRawDispatch = beforeRawDispatch;
    this.inspectVisibleReport = inspectVisibleReport || ((candidate, payload) => inspectVisibleReportCommit(candidate, { ...this.options, payload }));
    this.waitForVisibleReport = waitForVisibleReport || ((candidate, payload) => waitForVisibleReportBoundary({
      inspect: () => this.inspectVisibleReport(candidate, payload),
      reportedAt: payload?.reportedAt,
      minimumReportSettleMs: DEFAULT_VISIBLE_REPORT_SETTLE_MS,
      timeoutMs: visibleReportTimeoutMs,
      pollMs: visibleReportPollMs,
      sleep: sleepImpl,
    }));
  }

  async findMatchingCandidate(goalId, { conversationId = null, runtimePort = null } = {}) {
    const expectedConversationId = String(conversationId || "").trim() || null;
    const orderedPorts = Number.isInteger(runtimePort)
      ? [runtimePort, ...this.ports.filter((port) => port !== runtimePort)]
      : this.ports;
    for (const port of orderedPorts) {
      let candidates = [];
      try {
        candidates = await this.probePort(port);
      } catch {
        continue;
      }
      const matching = (candidates || []).find((candidate) => (
        candidate?.chatMode === true
        && candidate?.goalId === goalId
        && (!expectedConversationId || candidate?.conversationId === expectedConversationId)
      )) || null;
      if (matching) return matching;
    }
    return null;
  }

  async findConversationRelay(conversationId, { runtimePort = null } = {}) {
    const expectedConversationId = String(conversationId || "").trim();
    if (!expectedConversationId) return null;
    const orderedPorts = Number.isInteger(runtimePort)
      ? [runtimePort, ...this.ports.filter((port) => port !== runtimePort)]
      : this.ports;
    for (const port of orderedPorts) {
      let candidates = [];
      try {
        candidates = await this.probeRelayPort(port, expectedConversationId);
      } catch {
        continue;
      }
      const matching = (candidates || []).find((candidate) => (
        candidate?.chatMode === true
        && candidate?.conversationId === expectedConversationId
      )) || null;
      if (matching) return matching;
    }
    return null;
  }

  async resolveRecoveryCandidate({ goalId, conversationId = null, runtimePort = null } = {}) {
    const conversation = String(conversationId || "").trim() || null;
    const exactGoal = await this.findMatchingCandidate(goalId, {
      conversationId: conversation,
      runtimePort,
    });
    if (exactGoal) return { candidate: exactGoal, relayFallback: false };
    if (!conversation) return { candidate: null, relayFallback: false };
    const relay = await this.findConversationRelay(conversation, { runtimePort });
    return { candidate: relay, relayFallback: Boolean(relay) };
  }

  async inspectWorkingRound(goalOrGoalId) {
    const goal = goalOrGoalId && typeof goalOrGoalId === "object" ? goalOrGoalId : null;
    const goalId = String(goal?.id ?? goalOrGoalId ?? "").trim();
    if (!goalId) throw new Error("Goal working-round inspection requires goalId.");
    const conversationId = String(goal?.conversationId || "").trim() || null;
    const runtimePort = Number.isInteger(goal?.runtimePort) ? goal.runtimePort : null;
    const resolved = await this.resolveRecoveryCandidate({ goalId, conversationId, runtimePort });
    const matching = resolved.candidate;
    if (!matching) {
      return {
        chatMode: false,
        generating: null,
        streamStatus: null,
        conversationId,
        definiteFailure: true,
        relayFallback: false,
        error: conversationId
          ? `No matching Chat-mode DevSpace relay was found for Goal ${goalId} in conversation ${conversationId}.`
          : `No matching Chat-mode Goal widget was found for ${goalId}, and no authoritative conversation fallback is available.`,
      };
    }
    const snapshot = await this.inspectVisibleReport(matching, { goalId, recovery: true });
    return {
      ...snapshot,
      runtimePort: matching.runtimePort,
      runtimeLabel: matching.runtimeLabel,
      relayFallback: resolved.relayFallback,
    };
  }

  async dispatchRoundRecovery({ goalId, prompt, round, recoveryId, conversationId = null, runtimePort = null } = {}) {
    if (typeof goalId !== "string" || !goalId.trim()) throw new Error("Goal round recovery dispatch requires goalId.");
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Goal round recovery dispatch requires prompt.");
    if (typeof this.beforeDispatch === "function") {
      try {
        await this.beforeDispatch({ goalId, round, recoveryId, recovery: true });
      } catch {
        // Best-effort Primary debug maintenance; target discovery remains authoritative.
      }
    }
    const resolved = await this.resolveRecoveryCandidate({ goalId, conversationId, runtimePort });
    const matching = resolved.candidate;
    if (!matching) {
      return {
        ok: false,
        definiteFailure: true,
        relayFallback: false,
        error: conversationId
          ? `No matching Chat-mode DevSpace relay was found for Goal ${goalId} in conversation ${conversationId}.`
          : `No matching Chat-mode Goal widget was found for ${goalId}, and no authoritative conversation fallback is available.`,
      };
    }
    try {
      const sent = await this.sendRaw(matching, {
        prompt,
        scrollToBottom: false,
        goalId,
        round,
        recoveryId,
      });
      if (sent?.ok !== true) {
        return {
          ok: false,
          definiteFailure: sent?.definiteFailure === true,
          error: sent?.error || "Raw ChatGPT Classic round-recovery RPC did not confirm dispatch.",
        };
      }
      return {
        ok: true,
        transport: "classic-raw-host-rpc",
        runtimeLabel: matching.runtimeLabel,
        runtimePort: matching.runtimePort,
        targetId: matching.targetId,
        relayFallback: resolved.relayFallback,
      };
    } catch (error) {
      return { ok: false, definiteFailure: false, error: errorMessage(error) };
    }
  }

  setBeforeRawDispatch(handler) {
    this.beforeRawDispatch = typeof handler === "function" ? handler : null;
  }

  async dispatch({ goalId, prompt, continuationId, leaseId, round, reportedAt, conversationId = null, runtimePort = null } = {}) {
    if (typeof goalId !== "string" || !goalId.trim()) throw new Error("Goal host dispatch requires goalId.");
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Goal host dispatch requires prompt.");

    if (typeof this.beforeDispatch === "function") {
      try {
        await this.beforeDispatch({ goalId, continuationId, leaseId, round });
      } catch {
        // Guard maintenance is best-effort here. Target discovery below remains
        // authoritative and fails closed when no Chat-mode Goal widget exists.
      }
    }

    const resolved = await this.resolveRecoveryCandidate({ goalId, conversationId, runtimePort });
    const matching = resolved.candidate;
    if (!matching) {
      return {
        ok: false,
        definiteFailure: true,
        relayFallback: false,
        error: conversationId
          ? `No matching Chat-mode DevSpace relay was found for Goal ${goalId} in conversation ${conversationId}.`
          : `No matching Chat-mode Goal widget was found for ${goalId}, and no authoritative conversation fallback is available.`,
      };
    }

    try {
      const payload = {
        prompt,
        scrollToBottom: false,
        goalId,
        continuationId,
        leaseId,
        round,
        reportedAt: reportedAt || null,
      };
      const boundary = await this.waitForVisibleReport(matching, payload);
      if (boundary?.ok !== true) {
        return {
          ok: false,
          definiteFailure: boundary?.definiteFailure === true,
          error: boundary?.error || "Visible Goal round report was not committed before continuation dispatch.",
        };
      }
      if (typeof this.beforeRawDispatch === "function") {
        const guarded = await this.beforeRawDispatch(matching, payload);
        if (guarded?.blocked === true) {
          return {
            ok: false,
            definiteFailure: true,
            error: guarded.error || guarded.reason || "Context Guardian blocked Goal continuation dispatch.",
          };
        }
        if (guarded?.handled === true) {
          return {
            ok: true,
            transport: guarded.transport || "classic-hidden-rollover",
            runtimeLabel: matching.runtimeLabel,
            runtimePort: matching.runtimePort,
            targetId: matching.targetId,
            rollover: guarded.rollover || guarded.result || null,
          };
        }
      }
      const sent = await this.sendRaw(matching, {
        prompt,
        scrollToBottom: false,
        goalId,
        continuationId,
        leaseId,
        round,
      });
      if (sent?.ok !== true) {
        return {
          ok: false,
          definiteFailure: sent?.definiteFailure === true,
          error: sent?.error || "Raw ChatGPT Classic follow-up RPC did not confirm dispatch.",
        };
      }
      return {
        ok: true,
        transport: "classic-raw-host-rpc",
        runtimeLabel: matching.runtimeLabel,
        runtimePort: matching.runtimePort,
        targetId: matching.targetId,
        relayFallback: resolved.relayFallback,
      };
    } catch (error) {
      return {
        ok: false,
        definiteFailure: false,
        error: errorMessage(error),
      };
    }
  }
}
