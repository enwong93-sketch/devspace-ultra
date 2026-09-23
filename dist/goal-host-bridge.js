import { ClassicCdpClient } from "./classic-cdp-client.js";
import { readComposerDraft } from "./classic-composer-draft.js";
import { classicMainDebugPorts, runtimeLabelForClassicPort } from './classic-main-debug-ports.js';

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_PAGE_INSPECTION_TIMEOUT_MS = 12_000;
const DEFAULT_RAW_DISPATCH_TIMEOUT_MS = 12_000;
const DEFAULT_COMPOSER_TIMEOUT_MS = 5_000;
const DEFAULT_CONTEXT_SETTLE_MS = 80;
const DEFAULT_VISIBLE_REPORT_TIMEOUT_MS = 30_000;
const DEFAULT_VISIBLE_REPORT_POLL_MS = 150;
const DEFAULT_VISIBLE_REPORT_SETTLE_MS = 400;
const DEFAULT_HIDDEN_CONFIRM_TIMEOUT_MS = 15_000;
const DEFAULT_HIDDEN_CONFIRM_POLL_MS = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function runtimeLabelForPort(port) {
  return runtimeLabelForClassicPort(port);
}

function conversationIdFromPageUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'chatgpt.com') return null;
    return parsed.pathname.match(/\/c\/([^/?#]+)/)?.[1] || null;
  } catch {
    return null;
  }
}

async function inspectExactPageComposer(candidate, expectedText = null, options = {}) {
  if (!candidate?.pageWebSocketDebuggerUrl || !candidate?.conversationId) {
    return { ok: false, state: "page-composer-unavailable" };
  }
  const client = new ClassicCdpClient(candidate.pageWebSocketDebuggerUrl, options);
  await client.open();
  try {
    const result = await client.call("Runtime.evaluate", {
      expression: `(() => {
        const expectedConversation=${JSON.stringify(candidate.conversationId)};
        const expectedText=${JSON.stringify(String(expectedText || ""))};
        const actual=location.pathname.match(/\\/c\\/([^/?#]+)/)?.[1]||null;
        if(actual!==expectedConversation)return {ok:false,state:'route-changed'};
        const editor=document.querySelector('#prompt-textarea,textarea,div.ProseMirror[contenteditable="true"],[data-lexical-editor="true"][contenteditable="true"],[contenteditable="true"][role="textbox"]');
        if(!editor)return {ok:false,state:'composer-missing'};
        const read=${readComposerDraft.toString()};
        const draft=read(editor);
        return {ok:true,state:draft===null?'protected-content':draft===''?'empty':'non-empty',
          exactOwnedPayload:typeof draft==='string'&&expectedText.length>0&&draft===expectedText};
      })()`,
      returnByValue: true,
    });
    return result?.result?.value || { ok: false, state: "composer-inspection-empty" };
  } finally {
    client.close();
  }
}

async function clearExactOwnedComposerPayload(candidate, expectedText, options = {}) {
  if (!candidate?.pageWebSocketDebuggerUrl || !candidate?.conversationId || !expectedText) {
    return { ok: false, state: "composer-cleanup-unavailable" };
  }
  const client = new ClassicCdpClient(candidate.pageWebSocketDebuggerUrl, options);
  await client.open();
  try {
    const result = await client.call("Runtime.evaluate", {
      expression: `(() => {
        const expectedConversation=${JSON.stringify(candidate.conversationId)};
        const expectedText=${JSON.stringify(String(expectedText))};
        const actual=location.pathname.match(/\\/c\\/([^/?#]+)/)?.[1]||null;
        if(actual!==expectedConversation)return {ok:false,state:'route-changed'};
        const editor=document.querySelector('#prompt-textarea,textarea,div.ProseMirror[contenteditable="true"],[data-lexical-editor="true"][contenteditable="true"],[contenteditable="true"][role="textbox"]');
        if(!editor)return {ok:false,state:'composer-missing'};
        const read=${readComposerDraft.toString()};
        if(read(editor)!==expectedText)return {ok:false,state:'composer-ownership-lost'};
        if(editor instanceof HTMLTextAreaElement)editor.value='';else editor.textContent='';
        editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward',data:null}));
        return {ok:read(editor)==='',state:'owned-goal-control-draft-cleared'};
      })()`,
      returnByValue: true,
    });
    return result?.result?.value || { ok: false, state: "composer-cleanup-empty" };
  } finally {
    client.close();
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
        last?.latestMessageRole === 'assistant' &&
        last?.safetyCheckVisible !== true && last?.deliveryTimeoutVisible !== true &&
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

export function defaultMainDebugPorts(options = {}) {
  return classicMainDebugPorts(options);
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
        const messageNodes = [...document.querySelectorAll('[data-message-author-role]')];
        const latestMessageNode = messageNodes.at(-1) || null;
        const latestUserNode = [...messageNodes].reverse().find((node) => node.getAttribute('data-message-author-role') === 'user') || null;
        const userNodes = messageNodes.filter(node => node.getAttribute('data-message-author-role') === 'user');
        const beforeLatestUser = messageNodes.slice(0, messageNodes.indexOf(latestUserNode));
        const assistantBeforeLatestUser = [...beforeLatestUser].reverse().find(node => node.getAttribute('data-message-author-role') === 'assistant') || null;
        const assistantNodes = messageNodes.filter((el) => el.getAttribute('data-message-author-role') === 'assistant');
        const assistants = assistantNodes
          .map((el) => (el.innerText || '').trim())
          .filter(Boolean);
        const latestAssistantNode = assistantNodes.at(-1) || null;
        const latestAssistantText = String(latestAssistantNode?.innerText || '').trim();
        const match = location.pathname.match(/\\/c\\/([^/?#]+)/);
        const conversationId = match?.[1] || null;
        let nativeContinuation = null;
        if (conversationId && ${options.includeNativeBranch === true}) {
          const expectedSourceUserId = ${JSON.stringify(String(options.sourceUserMessageId || "").trim())};
          const baselineAssistantMessageId = ${JSON.stringify(String(options.baselineAssistantMessageId || "").trim())};
          try {
            const sessionResponse = await fetch('/api/auth/session', {
              credentials: 'include',
              cache: 'no-store',
              signal: AbortSignal.timeout(${Math.max(1_000, Number(options.nativeSessionTimeoutMs) || 5_000)}),
            });
            const session = sessionResponse.ok ? await sessionResponse.json() : null;
            const accessToken = session?.accessToken || session?.access_token || null;
            const conversationResponse = await fetch('/backend-api/conversation/' + encodeURIComponent(conversationId), {
              credentials: 'include',
              cache: 'no-store',
              signal: AbortSignal.timeout(${Math.max(5_000, Number(options.nativeConversationTimeoutMs) || 30_000)}),
              headers: accessToken ? { authorization: 'Bearer ' + accessToken } : undefined,
            });
            if (conversationResponse.ok) {
              const payload = await conversationResponse.json();
              const reversed = [];
              const seen = new Set();
              let currentNodeId = payload?.current_node || null;
              let nodeId = currentNodeId;
              while (nodeId && payload?.mapping?.[nodeId] && !seen.has(nodeId) && reversed.length < 4096) {
                seen.add(nodeId);
                const node = payload.mapping[nodeId];
                if (node?.message) {
                  reversed.push({
                    id: String(node.message.id || '').trim() || null,
                    role: String(node.message.author?.role || '').trim().toLowerCase() || null,
                    status: String(node.message.status || '').trim() || null,
                    endTurn: node.message.end_turn === true,
                    createTime: Number.isFinite(Number(node.message.create_time))
                      ? Number(node.message.create_time)
                      : null,
                  });
                }
                nodeId = node.parent;
              }
              const branch = reversed.reverse();
              const sourceIndex = expectedSourceUserId
                ? branch.findIndex(row => row.role === 'user' && row.id === expectedSourceUserId)
                : -1;
              const baselineIndex = baselineAssistantMessageId
                ? branch.findIndex(row => row.role === 'assistant' && row.id === baselineAssistantMessageId)
                : -1;
              const afterBaseline = baselineIndex >= 0 ? branch.slice(baselineIndex + 1) : [];
              const newUserIndex = afterBaseline.findIndex(row => row.role === 'user');
              const newAssistantIndex = afterBaseline.findIndex(row => row.role === 'assistant' && row.id);
              const newUser = newUserIndex >= 0 ? afterBaseline[newUserIndex] : null;
              const newAssistant = newAssistantIndex >= 0 ? afterBaseline[newAssistantIndex] : null;
              const latestUser = [...branch].reverse().find(row => row.role === 'user') || null;
              const latestAssistant = [...branch].reverse().find(row => row.role === 'assistant') || null;
              const current = branch.at(-1) || null;
              nativeContinuation = {
                resolved: true,
                currentNodeId,
                currentMessageId: current?.id || null,
                currentRole: current?.role || null,
                currentStatus: current?.status || null,
                currentEndTurn: current?.endTurn === true,
                currentCreatedAt: current?.createTime != null
                  ? new Date(current.createTime * 1000).toISOString()
                  : null,
                branchMessageCount: branch.length,
                sourceUserFound: sourceIndex >= 0,
                baselineAssistantFound: baselineIndex >= 0,
                latestUserMessageId: latestUser?.id || null,
                latestUserCreatedAt: latestUser?.createTime != null
                  ? new Date(latestUser.createTime * 1000).toISOString()
                  : null,
                latestAssistantMessageId: latestAssistant?.id || null,
                latestAssistantCreatedAt: latestAssistant?.createTime != null
                  ? new Date(latestAssistant.createTime * 1000).toISOString()
                  : null,
                newUserAfterBaselineMessageId: newUser?.id || null,
                newUserAfterBaselineIndex: newUserIndex,
                newUserAfterBaselineCreatedAt: newUser?.createTime
                  ? new Date(newUser.createTime * 1000).toISOString()
                  : null,
                newAssistantAfterBaselineMessageId: newAssistant?.id || null,
                newAssistantAfterBaselineIndex: newAssistantIndex,
              };
            } else {
              nativeContinuation = { resolved: false, state: 'conversation-fetch-' + conversationResponse.status };
            }
          } catch {
            nativeContinuation = { resolved: false, state: 'native-branch-unavailable' };
          }
        }
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
        if (conversationId && ${options.skipNativeStatus !== true}) {
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
          latestMessageRole: latestMessageNode?.getAttribute('data-message-author-role') || null,
          latestMessageId: latestMessageNode?.getAttribute('data-message-id') || null,
          latestUserMessageId: latestUserNode?.getAttribute('data-message-id') || null,
          latestUserText: String(latestUserNode?.innerText || '').trim(),
          previousUserMessageId: userNodes.at(-2)?.getAttribute('data-message-id') || null,
          assistantBeforeLatestUserMessageId: assistantBeforeLatestUser?.getAttribute('data-message-id') || null,
          latestAssistantMessageId: latestAssistantNode?.getAttribute('data-message-id') || null,
          assistantCount: assistants.length,
          visibleMessageCount,
          conversationId,
          nativeContinuation,
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

export async function probeClassicConversationPagePort(port, conversationId, options = {}) {
  const expectedConversationId = String(conversationId || "").trim();
  if (!expectedConversationId) return [];
  let targets;
  try {
    targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, options);
  } catch {
    return [];
  }
  if (!Array.isArray(targets)) return [];
  return targets
    .filter((target) => (
      target?.type === "page"
      && typeof target.webSocketDebuggerUrl === "string"
      && /chatgpt\.com/i.test(target.url || "")
      && !/[?&]surface=work(?:&|$)/i.test(target.url || "")
      && conversationIdFromPageUrl(target.url) === expectedConversationId
    ))
    .map((target) => ({
      runtimePort: port,
      runtimeLabel: runtimeLabelForPort(port),
      targetId: null,
      webSocketDebuggerUrl: null,
      pageTargetId: target.id,
      pageWebSocketDebuggerUrl: target.webSocketDebuggerUrl,
      pageUrl: target.url,
      conversationId: expectedConversationId,
      title: target.title || "",
      goalId: null,
      chatMode: true,
      relayOnly: false,
      directPage: true,
    }));
}

// Inspect only the already-bound exact Goal conversation. Duplicate displays
// are returned for consensus, never treated as different task owners.
export async function inspectGoalContinuationPages(goal, {
  ports = defaultMainDebugPorts(),
  skipNativeStatus = false,
  runtimeKey = null,
  pageTargetId = null,
  includeNativeBranch = false,
  sourceUserMessageId = null,
  baselineAssistantMessageId = null,
} = {}) {
  if (runtimeKey) {
    if (!/^main-(0[1-9]|[12][0-9]|3[0-2])$/.test(runtimeKey)) return [];
    const number=Number(runtimeKey.slice(-2)); const port=number===1?9721:9730+number;
    ports=ports.filter(value=>value===port);
  }
  const groups = await Promise.all(ports.map(port => probeClassicConversationPagePort(port, goal.conversationId).catch(() => [])));
  let candidates = groups.flat();
  if (pageTargetId) candidates = candidates.filter(candidate => candidate.pageTargetId === pageTargetId);
  if (!candidates.length || candidates.length > 4) return [];
  const snapshots = await Promise.all(candidates.map(async candidate => {
    const page = await inspectVisibleReportCommit(candidate, {
      timeoutMs: includeNativeBranch ? 45_000 : 3_000,
      nativeSessionTimeoutMs: includeNativeBranch ? 5_000 : undefined,
      nativeConversationTimeoutMs: includeNativeBranch ? 30_000 : undefined,
      skipNativeStatus,
      includeNativeBranch,
      sourceUserMessageId,
      baselineAssistantMessageId,
    });
    return { ...page, candidate, runtimeKey: candidate.runtimePort===9721?'main-01':`main-${String(candidate.runtimePort-9730).padStart(2,'0')}` };
  }));
  return snapshots;
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
  let dispatchCommitted = false;
  let dispatchAttempted = false;
  await client.open();
  try {
    await client.call("Runtime.enable");
    await client.call("Debugger.enable");
    await sleep(options.contextSettleMs ?? DEFAULT_CONTEXT_SETTLE_MS);
    const context = chooseInnerContext(client, candidate.targetId);
    if (!context) throw new Error("Goal widget execution context is unavailable.");
    const rawHost = await findRawHostObject(client, context.id);
    dispatchAttempted = true;
    let result;
    try {
      result = await client.call("Runtime.callFunctionOn", {
        objectId: rawHost.objectId,
        // Do not await the host promise. In current ChatGPT builds that promise
        // can remain pending for the entire assistant turn, which is much
        // longer than a safe CDP acknowledgement window. Successful return
        // proves the host function was synchronously invoked; native branch
        // confirmation remains the downstream authority for Goal advancement.
        functionDeclaration: `function(message){
          const pending=this.sendFollowUpMessage(message);
          if(pending&&typeof pending.catch==='function')pending.catch(()=>{});
          return {invoked:true,thenable:Boolean(pending&&typeof pending.then==='function')};
        }`,
        arguments: [{ value: { prompt: payload.prompt, scrollToBottom: false } }],
        awaitPromise: false,
        returnByValue: true,
        userGesture: false,
      });
    } catch (error) {
      // Once Runtime.callFunctionOn has been issued, losing the acknowledgement
      // is not proof that the host rejected the hidden continuation. Return an
      // uncertain committed result so no caller can retry and create a second
      // hidden assistant turn.
      return {
        ok: false,
        definiteFailure: false,
        dispatchCommitted: true,
        backgroundAccepted: false,
        state: "raw-host-acknowledgement-lost",
        error: errorMessage(error),
      };
    }
    if (result.exceptionDetails) {
      return {
        ok: false,
        definiteFailure: false,
        dispatchCommitted: true,
        backgroundAccepted: false,
        state: "raw-host-exception-after-dispatch",
        error: result.exceptionDetails.text || "Raw ChatGPT Classic follow-up RPC failed.",
      };
    }
    if (result?.result?.value?.invoked !== true) {
      return {
        ok: false,
        definiteFailure: false,
        dispatchCommitted: true,
        backgroundAccepted: false,
        state: "raw-host-invocation-unconfirmed",
      };
    }
    dispatchCommitted = true;
    return { ok: true, dispatchCommitted: true, backgroundAccepted: true };
  } catch (error) {
    return {
      ok: false,
      definiteFailure: dispatchAttempted !== true,
      dispatchCommitted: dispatchAttempted,
      backgroundAccepted: false,
      state: dispatchAttempted ? "raw-host-acknowledgement-lost" : "raw-host-preflight-failed",
      error: errorMessage(error),
    };
  } finally {
    client.close();
  }
}

export class ClassicGoalHostBridge {
  constructor({
    ports = defaultMainDebugPorts(),
    probePort,
    probeRelayPort,
    probeConversationPage,
    sendRaw,
    beforeDispatch,
    beforeRawDispatch,
    waitForVisibleReport,
    inspectVisibleReport,
    inspectComposer,
    clearOwnedComposer,
    visibleReportTimeoutMs = DEFAULT_VISIBLE_REPORT_TIMEOUT_MS,
    visibleReportPollMs = DEFAULT_VISIBLE_REPORT_POLL_MS,
    hiddenConfirmTimeoutMs = DEFAULT_HIDDEN_CONFIRM_TIMEOUT_MS,
    hiddenConfirmPollMs = DEFAULT_HIDDEN_CONFIRM_POLL_MS,
    sleep: sleepImpl = sleep,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    pageInspectionTimeoutMs = DEFAULT_PAGE_INSPECTION_TIMEOUT_MS,
    rawDispatchTimeoutMs = DEFAULT_RAW_DISPATCH_TIMEOUT_MS,
    composerTimeoutMs = DEFAULT_COMPOSER_TIMEOUT_MS,
    contextSettleMs = DEFAULT_CONTEXT_SETTLE_MS,
  } = {}) {
    this.ports = [...ports];
    this.options = { fetchImpl, WebSocketImpl, timeoutMs: probeTimeoutMs, contextSettleMs };
    this.pageInspectionOptions = {
      fetchImpl, WebSocketImpl,
      timeoutMs: Math.max(DEFAULT_PROBE_TIMEOUT_MS, Number(pageInspectionTimeoutMs) || DEFAULT_PAGE_INSPECTION_TIMEOUT_MS),
      contextSettleMs,
    };
    this.rawDispatchOptions = {
      fetchImpl, WebSocketImpl,
      timeoutMs: Math.max(DEFAULT_PROBE_TIMEOUT_MS, Number(rawDispatchTimeoutMs) || DEFAULT_RAW_DISPATCH_TIMEOUT_MS),
      contextSettleMs,
    };
    this.composerOptions = {
      fetchImpl, WebSocketImpl,
      timeoutMs: Math.max(DEFAULT_PROBE_TIMEOUT_MS, Number(composerTimeoutMs) || DEFAULT_COMPOSER_TIMEOUT_MS),
      contextSettleMs,
    };
    this.probePort = probePort || ((port) => probeClassicMainPort(port, this.options));
    this.probeRelayPort = probeRelayPort || ((port, conversationId) => probeClassicRelayPort(port, conversationId, this.options));
    this.probeConversationPage = probeConversationPage || ((port, conversationId) => probeClassicConversationPagePort(port, conversationId, this.options));
    this.sendRaw = sendRaw || ((candidate, payload) => sendRawHostFollowUp(candidate, payload, this.rawDispatchOptions));
    this.beforeDispatch = beforeDispatch;
    this.beforeRawDispatch = beforeRawDispatch;
    this.inspectVisibleReport = inspectVisibleReport || ((candidate, payload = {}) => inspectVisibleReportCommit(candidate, { ...this.pageInspectionOptions, ...payload }));
    this.inspectComposer = inspectComposer || ((candidate, expectedText) => inspectExactPageComposer(candidate, expectedText, this.composerOptions));
    this.clearOwnedComposer = clearOwnedComposer || ((candidate, expectedText) => clearExactOwnedComposerPayload(candidate, expectedText, this.composerOptions));
    this.waitForVisibleReport = waitForVisibleReport || ((candidate, payload) => waitForVisibleReportBoundary({
      inspect: () => this.inspectVisibleReport(candidate, payload),
      reportedAt: payload?.reportedAt,
      minimumReportSettleMs: DEFAULT_VISIBLE_REPORT_SETTLE_MS,
      timeoutMs: visibleReportTimeoutMs,
      pollMs: visibleReportPollMs,
      sleep: sleepImpl,
    }));
    this.hiddenConfirmTimeoutMs = Math.max(1_000, Number(hiddenConfirmTimeoutMs || DEFAULT_HIDDEN_CONFIRM_TIMEOUT_MS));
    this.hiddenConfirmPollMs = Math.max(50, Number(hiddenConfirmPollMs || DEFAULT_HIDDEN_CONFIRM_POLL_MS));
    this.sleep = sleepImpl;
  }

  async waitForHiddenAssistant(candidate, {
    sourceUserMessageId,
    baselineAssistantMessageId,
    expectedControlText = null,
  } = {}) {
    const sourceUser = String(sourceUserMessageId || "").trim();
    const baselineAssistant = String(baselineAssistantMessageId || "").trim();
    if (!sourceUser || !baselineAssistant) {
      return { ok: false, state: "hidden-boundary-unavailable", definiteFailure: false };
    }
    const startedAt = Date.now();
    let lastState = "native-branch-unavailable";
    while (Date.now() - startedAt <= this.hiddenConfirmTimeoutMs) {
      try {
        const composer = await this.inspectComposer(candidate, expectedControlText);
        if (composer?.exactOwnedPayload === true) {
          const cleared = await this.clearOwnedComposer(candidate, expectedControlText).catch(() => null);
          return {
            ok: false,
            state: "hidden-control-composer-exposure-cleared",
            definiteFailure: false,
            composerMutation: true,
            composerCleanupVerified: cleared?.ok === true,
          };
        }
        if (composer?.ok !== true || composer?.state !== "empty") {
          return {
            ok: false,
            state: composer?.state || "composer-postflight-unavailable",
            definiteFailure: false,
            composerMutation: composer?.state === "non-empty",
          };
        }
        const snapshot = await this.inspectVisibleReport(candidate, {
          includeNativeBranch: true,
          sourceUserMessageId: sourceUser,
          baselineAssistantMessageId: baselineAssistant,
          timeoutMs: Math.max(8_000, this.hiddenConfirmTimeoutMs),
        });
        const native = snapshot?.nativeContinuation;
        lastState = native?.state || lastState;
        if (native?.resolved === true) {
          if (native.newUserAfterBaselineMessageId) {
            return {
              ok: false,
              state: "new-user-before-hidden-assistant",
              definiteFailure: true,
              nativeBranchResolved: true,
            };
          }
          if (native.sourceUserFound === true
            && native.baselineAssistantFound === true
            && native.latestUserMessageId === sourceUser
            && native.newAssistantAfterBaselineMessageId) {
            return {
              ok: true,
              state: "hidden-assistant-confirmed-by-native-branch",
              nativeBranchResolved: true,
              assistantMessageId: native.newAssistantAfterBaselineMessageId,
            };
          }
        }
      } catch (error) {
        lastState = errorMessage(error);
      }
      await this.sleep(this.hiddenConfirmPollMs);
    }
    return { ok: false, state: lastState || "hidden-assistant-confirmation-timeout", definiteFailure: false };
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

  async findExactConversationRelay(conversationId, { runtimePort = null } = {}) {
    const expectedConversationId = String(conversationId || "").trim();
    if (!expectedConversationId) {
      return { candidate: null, ambiguous: false, matchCount: 0, error: "conversationId is required." };
    }
    const ports = Number.isInteger(runtimePort) ? [runtimePort] : this.ports;
    const matches = [];
    for (const port of ports) {
      let candidates = [];
      try {
        candidates = await this.probeRelayPort(port, expectedConversationId);
      } catch {
        continue;
      }
      for (const candidate of candidates || []) {
        if (candidate?.chatMode !== true) continue;
        if (candidate?.conversationId !== expectedConversationId) continue;
        matches.push(candidate);
      }
    }
    const pageGroups = new Map();
    for (const candidate of matches) {
      const pageTargetId = String(candidate?.pageTargetId || "").trim();
      if (!pageTargetId || !Number.isInteger(candidate?.runtimePort)) continue;
      const key = `${candidate.runtimePort}:${pageTargetId}:${expectedConversationId}`;
      const group = pageGroups.get(key) || [];
      group.push(candidate);
      pageGroups.set(key, group);
    }
    if (pageGroups.size !== 1) {
      return {
        candidate: null,
        ambiguous: pageGroups.size > 1,
        matchCount: matches.length,
        pageMatchCount: pageGroups.size,
        error: pageGroups.size > 1
          ? `Conversation ${expectedConversationId} is open in more than one ChatGPT Main runtime.`
          : `No exact Chat-mode relay is open for conversation ${expectedConversationId}.`,
      };
    }
    const relays = [...pageGroups.values()][0];
    const score = (candidate) => /DevSpace Goal Relay/i.test(String(candidate?.title || "")) ? 2
      : /DevSpace Progress Claim Relay/i.test(String(candidate?.title || "")) ? 1 : 0;
    relays.sort((left, right) => score(right) - score(left)
      || String(left?.targetId || "").localeCompare(String(right?.targetId || "")));
    return {
      candidate: relays[0],
      ambiguous: false,
      matchCount: matches.length,
      pageMatchCount: 1,
      redundantRelayCount: Math.max(0, relays.length - 1),
      error: null,
    };
  }

  async findExactConversationPage(conversationId, { runtimePort = null } = {}) {
    const expectedConversationId = String(conversationId || "").trim();
    if (!expectedConversationId) {
      return { candidate: null, ambiguous: false, matchCount: 0, error: "conversationId is required." };
    }
    const orderedPorts = Number.isInteger(runtimePort)
      ? [runtimePort, ...this.ports.filter((port) => port !== runtimePort)]
      : this.ports;
    const matches = [];
    for (const port of orderedPorts) {
      let candidates = [];
      try {
        candidates = await this.probeConversationPage(port, expectedConversationId);
      } catch {
        continue;
      }
      for (const candidate of candidates || []) {
        if (candidate?.chatMode !== true) continue;
        if (candidate?.conversationId !== expectedConversationId) continue;
        matches.push(candidate);
      }
    }
    if (matches.length !== 1) {
      return {
        candidate: null,
        ambiguous: matches.length > 1,
        matchCount: matches.length,
        error: matches.length > 1
          ? `Conversation ${expectedConversationId} is open in more than one ChatGPT Main runtime.`
          : `No exact Chat-mode page is open for conversation ${expectedConversationId}.`,
      };
    }
    return { candidate: matches[0], ambiguous: false, matchCount: 1, error: null };
  }

  async dispatchConversationFollowUp({ conversationId, prompt, runtimePort = null, purpose = "conversation-liveness" } = {}) {
    const expectedConversationId = String(conversationId || "").trim();
    if (!expectedConversationId) throw new Error("Conversation follow-up dispatch requires conversationId.");
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Conversation follow-up dispatch requires prompt.");
    const resolved = await this.findExactConversationRelay(expectedConversationId, { runtimePort });
    if (!resolved.candidate) {
      return {
        ok: false,
        definiteFailure: true,
        ambiguous: resolved.ambiguous,
        matchCount: resolved.matchCount,
        error: resolved.error,
      };
    }
    try {
      const sent = await this.sendRaw(resolved.candidate, {
        prompt,
        scrollToBottom: false,
        purpose: String(purpose || "conversation-liveness").slice(0, 80),
      });
      if (sent?.ok !== true) {
        return {
          ok: false,
          definiteFailure: sent?.definiteFailure === true,
          dispatchCommitted: sent?.dispatchCommitted === true,
          backgroundAccepted: sent?.backgroundAccepted === true,
          state: sent?.state || null,
          error: sent?.error || "Raw ChatGPT Classic conversation follow-up RPC did not confirm dispatch.",
        };
      }
      return {
        ok: true,
        transport: "classic-raw-host-rpc",
        conversationId: expectedConversationId,
        runtimeLabel: resolved.candidate.runtimeLabel,
        runtimePort: resolved.candidate.runtimePort,
        targetId: resolved.candidate.targetId,
        pageTargetId: resolved.candidate.pageTargetId,
        purpose: String(purpose || "conversation-liveness").slice(0, 80),
        dispatchCommitted: true,
        backgroundAccepted: true,
        visibleUserMessage: false,
        composerMutation: false,
      };
    } catch (error) {
      return { ok: false, definiteFailure: false, error: errorMessage(error) };
    }
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

  async inspectWorkingRound(goalOrGoalId, { includeNativeBranch = false } = {}) {
    const goal = goalOrGoalId && typeof goalOrGoalId === "object" ? goalOrGoalId : null;
    const goalId = String(goal?.id ?? goalOrGoalId ?? "").trim();
    if (!goalId) throw new Error("Goal working-round inspection requires goalId.");
    const conversationId = String(goal?.conversationId || "").trim() || null;
    const runtimePort = Number.isInteger(goal?.runtimePort) ? goal.runtimePort : null;
    const resolved = conversationId
      ? await this.findExactConversationPage(conversationId, { runtimePort })
      : await this.resolveRecoveryCandidate({ goalId, conversationId, runtimePort });
    const matching = resolved.candidate;
    if (!matching) {
      return {
        chatMode: false,
        generating: null,
        streamStatus: null,
        conversationId,
        definiteFailure: true,
        relayFallback: false,
        directPage: Boolean(conversationId),
        ambiguous: resolved.ambiguous === true,
        matchCount: Number(resolved.matchCount || 0),
        error: conversationId
          ? resolved.error || `No exact Chat-mode page was found for Goal ${goalId} in conversation ${conversationId}.`
          : `No matching Chat-mode Goal widget was found for ${goalId}, and no authoritative conversation fallback is available.`,
      };
    }
    const snapshot = await this.inspectVisibleReport(matching, {
      goalId,
      recovery: true,
      includeNativeBranch: includeNativeBranch === true,
      ...(includeNativeBranch === true ? {
        timeoutMs: 45_000,
        nativeSessionTimeoutMs: 5_000,
        nativeConversationTimeoutMs: 30_000,
      } : {}),
    });
    return {
      ...snapshot,
      runtimePort: matching.runtimePort,
      runtimeLabel: matching.runtimeLabel,
      relayFallback: conversationId ? false : resolved.relayFallback,
      directPage: matching.directPage === true,
    };
  }

  async dispatchRoundRecovery({
    goalId,
    prompt,
    round,
    recoveryId,
    attempt = 1,
    conversationId = null,
    runtimePort = null,
    expectedPageTargetId = null,
    sourceUserMessageId = null,
    baselineAssistantMessageId = null,
  } = {}) {
    const expectedConversationId = String(conversationId || "").trim();
    const recoveryPrompt = String(prompt || "").trim();
    const sourceUser = String(sourceUserMessageId || "").trim();
    const baselineAssistant = String(baselineAssistantMessageId || "").trim();
    if (!String(goalId || "").trim() || !expectedConversationId
      || !recoveryPrompt.startsWith("[DEVSPACE_GOAL_ROUND_RECOVERY]")
      || !sourceUser || !baselineAssistant) {
      return {
        ok: false,
        definiteFailure: true,
        dispatchCommitted: false,
        state: "invalid-hidden-goal-recovery-boundary",
      };
    }
    const resolved = await this.findExactConversationRelay(expectedConversationId, { runtimePort });
    const matching = resolved.candidate;
    if (!matching) {
      return {
        ok: false,
        definiteFailure: true,
        dispatchCommitted: false,
        ambiguous: resolved.ambiguous === true,
        matchCount: Number(resolved.matchCount || 0),
        error: resolved.error || `No exact hidden relay is open for Goal ${goalId}.`,
      };
    }
    const expectedTarget = String(expectedPageTargetId || "").trim();
    if (expectedTarget && matching.pageTargetId !== expectedTarget) {
      return {
        ok: false,
        definiteFailure: true,
        dispatchCommitted: false,
        state: "goal-recovery-page-target-changed",
      };
    }
    const composerBefore = await this.inspectComposer(matching, recoveryPrompt).catch((error) => ({
      ok: false,
      state: errorMessage(error),
    }));
    if (composerBefore?.ok !== true || composerBefore?.state !== "empty") {
      return {
        ok: false,
        definiteFailure: true,
        dispatchCommitted: false,
        state: composerBefore?.state || "goal-recovery-composer-preflight-failed",
      };
    }

    const sent = await this.sendRaw(matching, {
      prompt: recoveryPrompt,
      scrollToBottom: false,
      purpose: "goal-round-recovery-hidden",
      goalId,
      round,
      recoveryId,
      attempt,
    });
    const composerAfter = await this.inspectComposer(matching, recoveryPrompt).catch((error) => ({
      ok: false,
      state: errorMessage(error),
    }));
    if (composerAfter?.exactOwnedPayload === true) {
      const cleared = await this.clearOwnedComposer(matching, recoveryPrompt).catch(() => null);
      return {
        ok: false,
        definiteFailure: false,
        dispatchCommitted: sent?.dispatchCommitted === true || sent?.ok === true,
        backgroundAccepted: false,
        visibleUserMessage: false,
        composerMutation: true,
        composerCleanupVerified: cleared?.ok === true,
        state: "hidden-goal-recovery-composer-exposure-cleared",
      };
    }
    if (composerAfter?.ok !== true || composerAfter?.state !== "empty") {
      return {
        ok: false,
        definiteFailure: sent?.dispatchCommitted !== true && sent?.ok !== true,
        dispatchCommitted: sent?.dispatchCommitted === true || sent?.ok === true,
        backgroundAccepted: false,
        visibleUserMessage: false,
        composerMutation: composerAfter?.state === "non-empty",
        state: composerAfter?.state || "goal-recovery-composer-postflight-failed",
      };
    }

    if (sent?.ok !== true) {
      if (sent?.dispatchCommitted === true) {
        const reconciled = await this.waitForHiddenAssistant(matching, {
          sourceUserMessageId: sourceUser,
          baselineAssistantMessageId: baselineAssistant,
          expectedControlText: recoveryPrompt,
        });
        if (reconciled.ok === true) {
          return {
            ok: true,
            transport: "classic-hidden-round-recovery-native-reconciled",
            conversationId: expectedConversationId,
            runtimeLabel: matching.runtimeLabel,
            runtimePort: matching.runtimePort,
            pageTargetId: matching.pageTargetId,
            dispatchCommitted: true,
            backgroundAccepted: true,
            nativeBranchReconciled: true,
            visibleUserMessage: false,
            composerMutation: false,
            foregroundActivation: false,
            pageNavigation: false,
          };
        }
      }
      return {
        ok: false,
        definiteFailure: sent?.definiteFailure === true,
        dispatchCommitted: sent?.dispatchCommitted === true,
        backgroundAccepted: false,
        visibleUserMessage: false,
        composerMutation: false,
        state: sent?.state || "hidden-goal-recovery-not-confirmed",
        error: sent?.error || null,
      };
    }
    const confirmed = await this.waitForHiddenAssistant(matching, {
      sourceUserMessageId: sourceUser,
      baselineAssistantMessageId: baselineAssistant,
      expectedControlText: recoveryPrompt,
    });
    if (confirmed.ok !== true) {
      return {
        ok: false,
        definiteFailure: confirmed.definiteFailure === true,
        dispatchCommitted: true,
        backgroundAccepted: false,
        visibleUserMessage: false,
        composerMutation: confirmed.composerMutation === true,
        composerCleanupVerified: confirmed.composerCleanupVerified === true,
        state: confirmed.state || "hidden-goal-recovery-native-confirmation-missing",
      };
    }
    return {
      ok: true,
      transport: "classic-hidden-round-recovery",
      conversationId: expectedConversationId,
      runtimeLabel: matching.runtimeLabel,
      runtimePort: matching.runtimePort,
      pageTargetId: matching.pageTargetId,
      dispatchCommitted: true,
      backgroundAccepted: true,
      nativeBranchReconciled: true,
      visibilityVerified: false,
      visibleUserMessage: false,
      composerMutation: false,
      foregroundActivation: false,
      pageNavigation: false,
    };
  }

  setBeforeRawDispatch(handler) {
    this.beforeRawDispatch = typeof handler === "function" ? handler : null;
  }

  async dispatch({ goalId, prompt, continuationId, leaseId, round, reportedAt,
    conversationId = null, runtimePort = null, expectedPageTargetId = null,
    sourceUserId = null, assistantMessageId = null } = {}) {
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

    const expectedConversationId = String(conversationId || "").trim();
    const resolved = expectedConversationId
      ? await this.findExactConversationRelay(expectedConversationId, { runtimePort })
      : { candidate: null, relayFallback: false, ambiguous: false, matchCount: 0,
          error: "Goal continuation requires an exact bound conversationId." };
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
    const expectedTarget = String(expectedPageTargetId || "").trim();
    if (expectedTarget && matching.pageTargetId !== expectedTarget) {
      return {
        ok: false,
        definiteFailure: true,
        dispatchCommitted: false,
        error: "Goal continuation page target changed after the visible final boundary.",
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
            dispatchCommitted: true,
            backgroundAccepted: true,
            visibilityVerified: false,
            visibleUserMessage: false,
            composerMutation: false,
            foregroundActivation: false,
            pageNavigation: false,
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
      const sourceUser = String(sourceUserId || "").trim();
      const baselineAssistant = String(assistantMessageId || "").trim();
      if ((sent?.ok === true || sent?.dispatchCommitted === true)
        && sourceUser && baselineAssistant) {
        const confirmed = await this.waitForHiddenAssistant(matching, {
          sourceUserMessageId: sourceUser,
          baselineAssistantMessageId: baselineAssistant,
          expectedControlText: prompt,
        });
        if (confirmed?.ok === true) {
          return {
            ok: true,
            transport: sent?.ok === true
              ? "classic-hidden-continuation-native-confirmed"
              : "classic-hidden-continuation-native-reconciled",
            runtimeLabel: matching.runtimeLabel,
            runtimePort: matching.runtimePort,
            targetId: matching.targetId,
            pageTargetId: matching.pageTargetId,
            relayFallback: true,
            dispatchCommitted: true,
            backgroundAccepted: true,
            nativeBranchReconciled: true,
            visibilityVerified: false,
            visibleUserMessage: false,
            composerMutation: false,
            foregroundActivation: false,
            pageNavigation: false,
          };
        }
        return {
          ok: false,
          definiteFailure: sent?.dispatchCommitted !== true && sent?.ok !== true
            && confirmed?.definiteFailure === true,
          dispatchCommitted: sent?.dispatchCommitted === true || sent?.ok === true,
          backgroundAccepted: false,
          state: confirmed?.state || sent?.state || "hidden-continuation-native-confirmation-missing",
          error: sent?.error || null,
          composerMutation: confirmed?.composerMutation === true,
          composerCleanupVerified: confirmed?.composerCleanupVerified === true,
        };
      }
      if (sent?.ok !== true) {
        return {
          ok: false,
          definiteFailure: sent?.definiteFailure === true,
          dispatchCommitted: sent?.dispatchCommitted === true,
          backgroundAccepted: sent?.backgroundAccepted === true,
          state: sent?.state || null,
          error: sent?.error || "Raw ChatGPT Classic follow-up RPC did not confirm dispatch.",
        };
      }
      return {
        ok: true,
        transport: "classic-raw-host-rpc",
        runtimeLabel: matching.runtimeLabel,
        runtimePort: matching.runtimePort,
        targetId: matching.targetId,
        pageTargetId: matching.pageTargetId,
        relayFallback: true,
        dispatchCommitted: true,
        backgroundAccepted: true,
        visibilityVerified: false,
        visibleUserMessage: false,
        composerMutation: false,
        foregroundActivation: false,
        pageNavigation: false,
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
