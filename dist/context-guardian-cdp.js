import { randomUUID } from "node:crypto";
import { ClassicCdpClient } from "./classic-cdp-client.js";
import { sessionFingerprintFromClassicRequest } from "./classic-conversation-authority.js";
import { extractClassicNativeUsageEvidence } from "./classic-native-usage-evidence.js";
import { defaultMainDebugPorts } from "./goal-host-bridge.js";
import { runtimeKeyForPort } from "./classic-stream-recovery-cdp.js";

const DEFAULT_CONNECTION_POLL_MS = 15_000;
const DEFAULT_PROBE_TIMEOUT_MS = 700;
const DEFAULT_ROLLOVER_TIMEOUT_MS = 120_000;
const DEVSPACE_PLUGIN_NAME = "DevSpace Ultra";

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function observedAt() { return new Date().toISOString(); }

async function fetchJson(url, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable for Context Guardian CDP discovery.");
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

function isNativeModelsUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.hostname === "chatgpt.com" && parsed.pathname === "/backend-api/models";
  } catch { return false; }
}

function isTurnUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.hostname === "chatgpt.com" && parsed.pathname === "/backend-api/f/conversation";
  } catch { return false; }
}

export function estimateClassicInputTokens(value) {
  const text = String(value ?? "");
  if (!text) return 0;
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/gu) || []).length;
  const emoji = (text.match(/\p{Extended_Pictographic}/gu) || []).length;
  const asciiWords = (text.match(/[A-Za-z0-9_]+(?:[-'][A-Za-z0-9_]+)*/g) || []).length;
  const punctuation = (text.match(/[^\sA-Za-z0-9_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/gu) || []).length;
  const asciiChars = (text.match(/[\x00-\x7f]/g) || []).length;
  const asciiLengthTokens = Math.ceil(asciiChars / 4);
  return Math.max(1, cjk + (emoji * 2) + Math.max(asciiWords, asciiLengthTokens) + Math.ceil(punctuation / 2));
}

function estimateContentTokens(value, depth = 0) {
  if (depth > 10 || value === undefined || value === null) return 0;
  if (typeof value === "string") return estimateClassicInputTokens(value);
  if (typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimateContentTokens(item, depth + 1), 0);
  return Object.entries(value).reduce((sum, [key, item]) => {
    if (/^(?:metadata|author|recipient|status)$/i.test(key)) return sum;
    return sum + estimateContentTokens(item, depth + 1);
  }, 0);
}

function estimateMessageTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const message of messages) {
    total += 8;
    total += estimateContentTokens(message?.content);
  }
  return total;
}

function conversationPayloadMessages(payload = {}) {
  if (Array.isArray(payload?.messages)) return payload.messages;
  if (payload?.mapping && typeof payload.mapping === "object") {
    return Object.values(payload.mapping).map((node) => node?.message).filter(Boolean);
  }
  if (payload?.conversation?.mapping && typeof payload.conversation.mapping === "object") {
    return Object.values(payload.conversation.mapping).map((node) => node?.message).filter(Boolean);
  }
  if (Array.isArray(payload?.conversation?.messages)) return payload.conversation.messages;
  return [];
}

export function estimateClassicConversationPayloadTokens(payload = {}) {
  return estimateMessageTokens(conversationPayloadMessages(payload));
}

function visibleMessagesFromPayload(payload = {}, limit = 8) {
  const bounded = Math.max(1, Math.min(20, Number(limit) || 8));
  return conversationPayloadMessages(payload)
    .map((message) => {
      const role = message?.author?.role || message?.role || null;
      const hidden = message?.metadata?.is_visually_hidden_from_conversation === true;
      const recipient = message?.recipient ?? "all";
      const parts = Array.isArray(message?.content?.parts)
        ? message.content.parts.filter((part) => typeof part === "string")
        : [];
      return {
        role,
        hidden,
        recipient,
        text: parts.join("").trim(),
        createTime: Number(message?.create_time || 0),
      };
    })
    .filter((row) => !row.hidden && ["user", "assistant"].includes(row.role) && (!row.recipient || row.recipient === "all") && row.text)
    .sort((a, b) => a.createTime - b.createTime)
    .slice(-bounded)
    .map((row) => ({ role: row.role, text: row.text.slice(0, 2_400) }));
}

export function buildClassicHiddenRolloverBody(originalBody = {}, {
  prompt,
  attribution = "devspace-ultra",
  messageId,
  toolName = "devspace_context_guardian",
} = {}) {
  const text = String(prompt ?? "").trim();
  if (!text) throw new Error("Hidden rollover prompt is required.");
  const source = originalBody && typeof originalBody === "object" ? originalBody : {};
  const first = Array.isArray(source.messages) && source.messages[0] && typeof source.messages[0] === "object"
    ? source.messages[0]
    : {};
  const body = { ...source };
  delete body.conversation_id;
  const metadata = {
    ...(Array.isArray(first?.metadata?.system_hints) ? { system_hints: [...first.metadata.system_hints] } : {}),
    chatgpt_sdk_attribution: String(attribution || "devspace-ultra").slice(0, 160),
    chatgpt_sdk_followup_prompt: true,
    is_visually_hidden_from_conversation: true,
  };
  body.messages = [{
    ...(messageId || first.id ? { id: String(messageId || first.id) } : {}),
    ...(first.create_time !== undefined ? { create_time: first.create_time } : {}),
    author: { role: "tool", name: String(toolName || "devspace_context_guardian").replaceAll(".", "_").slice(0, 160) },
    content: { content_type: "text", parts: [text] },
    recipient: "all",
    metadata,
  }];
  return body;
}

export function buildClassicUserTurnRolloverBody(originalBody = {}, {
  capsulePrompt,
  attribution = "devspace-ultra",
  hiddenMessageId,
  parentMessageId,
  toolName = "devspace_context_guardian",
} = {}) {
  const text = String(capsulePrompt ?? "").trim();
  if (!text) throw new Error("User-turn rollover compact capsule is required.");
  const source = originalBody && typeof originalBody === "object" ? originalBody : {};
  const messages = Array.isArray(source.messages) ? source.messages : [];
  if (!messages.some((message) => message?.author?.role === "user" && message?.metadata?.is_visually_hidden_from_conversation !== true)) {
    throw new Error("User-turn rollover requires one visible user-submitted message.");
  }
  const body = {
    ...source,
    parent_message_id: String(parentMessageId || randomUUID()),
  };
  delete body.conversation_id;
  const first = messages[0] && typeof messages[0] === "object" ? messages[0] : {};
  body.messages = [{
    id: String(hiddenMessageId || randomUUID()),
    ...(first.create_time !== undefined ? { create_time: first.create_time } : {}),
    author: { role: "tool", name: String(toolName || "devspace_context_guardian").replaceAll(".", "_").slice(0, 160) },
    content: { content_type: "text", parts: [text] },
    recipient: "all",
    metadata: {
      ...(Array.isArray(first?.metadata?.system_hints) ? { system_hints: [...first.metadata.system_hints] } : {}),
      chatgpt_sdk_attribution: String(attribution || "devspace-ultra").slice(0, 160),
      chatgpt_sdk_followup_prompt: true,
      is_visually_hidden_from_conversation: true,
    },
  }, ...messages];
  return body;
}

export async function rewriteUserTurnRolloverPausedRequest(client, params, {
  capsulePrompt,
  attribution = "devspace-ultra",
  hiddenMessageId,
  parentMessageId,
  toolName = "devspace_context_guardian",
} = {}) {
  const requestId = params?.requestId;
  if (!requestId) return { handled: false, modified: false };
  let exactTurn = false;
  try {
    exactTurn = new URL(String(params?.request?.url || "")).pathname === "/backend-api/f/conversation";
  } catch {}
  if (!exactTurn || String(params?.request?.method || "").toUpperCase() !== "POST") {
    return { handled: false, modified: false };
  }
  try {
    const originalBody = JSON.parse(String(params?.request?.postData || "{}"));
    const oldConversationId = typeof originalBody?.conversation_id === "string" ? originalBody.conversation_id.trim() : "";
    if (!oldConversationId) return { handled: false, modified: false };
    const visibleUserMessages = Array.isArray(originalBody?.messages)
      ? originalBody.messages.filter((message) => message?.author?.role === "user" && message?.metadata?.is_visually_hidden_from_conversation !== true).length
      : 0;
    if (visibleUserMessages < 1) return { handled: false, modified: false };
    const rewritten = buildClassicUserTurnRolloverBody(originalBody, {
      capsulePrompt,
      attribution,
      hiddenMessageId,
      parentMessageId,
      toolName,
    });
    await client.call("Fetch.continueRequest", {
      requestId,
      postData: Buffer.from(JSON.stringify(rewritten), "utf8").toString("base64"),
    });
    return { handled: true, modified: true, oldConversationId, visibleUserMessages };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await client.call("Fetch.failRequest", {
      requestId,
      errorReason: "Aborted",
    }).catch(() => {});
    return { handled: true, modified: false, error: message };
  }
}

export async function rewriteHiddenRolloverPausedRequest(client, params, {
  prompt,
  attribution = "devspace-ultra",
  toolName = "devspace_context_guardian",
} = {}) {
  const requestId = params?.requestId;
  if (!requestId) return { handled: false, modified: false };
  let exactTurn = false;
  try {
    exactTurn = new URL(String(params?.request?.url || "")).pathname === "/backend-api/f/conversation";
  } catch {}
  if (!exactTurn || String(params?.request?.method || "").toUpperCase() !== "POST") {
    return { handled: false, modified: false };
  }
  try {
    const originalBody = JSON.parse(String(params?.request?.postData || "{}"));
    const hiddenBody = buildClassicHiddenRolloverBody(originalBody, {
      prompt,
      attribution,
      toolName,
    });
    await client.call("Fetch.continueRequest", {
      requestId,
      postData: Buffer.from(JSON.stringify(hiddenBody), "utf8").toString("base64"),
    });
    return { handled: true, modified: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await client.call("Fetch.failRequest", {
      requestId,
      errorReason: "Aborted",
    }).catch(() => {});
    return { handled: true, modified: false, error: message };
  }
}

export function parseClassicTurnRequest(request = {}) {
  if (String(request.method || "").toUpperCase() !== "POST" || !isTurnUrl(request.url)) return null;
  let body;
  try { body = JSON.parse(String(request.postData || "{}")); } catch { return null; }
  const modelSlug = typeof body?.model === "string" ? body.model.trim() : "";
  if (!modelSlug) return null;
  return {
    modelSlug,
    thinkingEffort: typeof body?.thinking_effort === "string"
      ? body.thinking_effort
      : typeof body?.thinkingEffort === "string" ? body.thinkingEffort : null,
    conversationId: typeof body?.conversation_id === "string" ? body.conversation_id : null,
    sessionFingerprint: sessionFingerprintFromClassicRequest(request),
    estimatedInputTokens: estimateMessageTokens(body?.messages),
  };
}

export class ClassicTurnIdentityCorrelator {
  constructor({ now = Date.now, pendingTtlMs = 30_000, maxPending = 256 } = {}) {
    if (typeof now !== "function") throw new Error("ClassicTurnIdentityCorrelator now must be a function.");
    this.now = now;
    this.pendingTtlMs = Math.max(1_000, Number(pendingTtlMs) || 30_000);
    this.maxPending = Math.max(1, Number(maxPending) || 256);
    this.pending = new Map();
  }

  get pendingSize() {
    this.prune();
    return this.pending.size;
  }

  noteRequest(params = {}) {
    const requestId = String(params?.requestId || "").trim();
    if (!requestId) return null;
    const metadata = parseClassicTurnRequest(params?.request);
    if (!metadata?.conversationId) return null;
    const entry = this.#entry(requestId);
    entry.conversationId = metadata.conversationId;
    if (metadata.sessionFingerprint) entry.sessionFingerprint = metadata.sessionFingerprint;
    this.pending.set(requestId, entry);
    this.#enforceBounds();
    return this.#resolve(requestId);
  }

  noteExtraInfo(params = {}) {
    const requestId = String(params?.requestId || "").trim();
    if (!requestId) return null;
    const sessionFingerprint = sessionFingerprintFromClassicRequest({ headers: params?.headers || {} });
    if (!sessionFingerprint) return null;
    const entry = this.#entry(requestId);
    entry.sessionFingerprint = sessionFingerprint;
    this.pending.set(requestId, entry);
    this.#enforceBounds();
    return this.#resolve(requestId);
  }

  forget(requestId) {
    const id = String(requestId || "").trim();
    if (!id) return false;
    return this.pending.delete(id);
  }

  prune() {
    const cutoff = Number(this.now()) - this.pendingTtlMs;
    for (const [requestId, entry] of this.pending) {
      if (Number(entry?.firstSeenAt || 0) < cutoff) this.pending.delete(requestId);
    }
    this.#enforceCap();
    return this.pending.size;
  }

  #entry(requestId) {
    this.prune();
    return this.pending.get(requestId) || { firstSeenAt: Number(this.now()) };
  }

  #enforceBounds() {
    this.prune();
  }

  #enforceCap() {
    if (this.pending.size <= this.maxPending) return;
    const oldest = [...this.pending.entries()]
      .sort((a, b) => Number(a[1]?.firstSeenAt || 0) - Number(b[1]?.firstSeenAt || 0));
    for (const [requestId] of oldest) {
      if (this.pending.size <= this.maxPending) break;
      this.pending.delete(requestId);
    }
  }

  #resolve(requestId) {
    const entry = this.pending.get(requestId);
    if (!entry?.conversationId || !entry?.sessionFingerprint) return null;
    this.pending.delete(requestId);
    return {
      requestId,
      conversationId: entry.conversationId,
      sessionFingerprint: entry.sessionFingerprint,
    };
  }
}

export function parseNativeClassicModelResponse(text) {
  let payload;
  try { payload = typeof text === "string" ? JSON.parse(text) : text; } catch { return []; }
  const models = Array.isArray(payload?.models) ? payload.models : [];
  const safe = [];
  for (const model of models) {
    const slug = typeof model?.slug === "string" ? model.slug.trim() : "";
    const maxTokens = Number(model?.max_tokens);
    if (!slug || !Number.isFinite(maxTokens) || maxTokens < 8_000) continue;
    safe.push({
      slug,
      max_tokens: Math.floor(maxTokens),
      title: typeof model?.title === "string" ? model.title.slice(0, 240) : undefined,
      reasoning_type: typeof model?.reasoning_type === "string" ? model.reasoning_type.slice(0, 80) : undefined,
      is_work_mode_model: model?.is_work_mode_model === true,
    });
  }
  return safe;
}

function inspectExpression() {
  return `(() => {
    const match = location.pathname.match(/\\/c\\/([^/?#]+)/);
    const radios = [...document.querySelectorAll('[role="radio"]')];
    const work = radios.find((el) => /^(工作|Work)$/i.test((el.innerText || el.textContent || '').trim()));
    const chat = radios.find((el) => /^(對話|Chat)$/i.test((el.innerText || el.textContent || '').trim()));
    const mode = work?.getAttribute('aria-checked') === 'true' || /[?&]surface=work(?:&|$)/i.test(location.search)
      ? 'work'
      : chat?.getAttribute('aria-checked') === 'true' ? 'chat' : 'chat';
    const modeled = [...document.querySelectorAll('[data-message-model-slug]')];
    const lastModeled = modeled.at(-1);
    const tokenText=(text)=>{text=String(text??'');if(!text)return 0;const cjk=(text.match(/[\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af]/gu)||[]).length;const emoji=(text.match(/\\p{Extended_Pictographic}/gu)||[]).length;const words=(text.match(/[A-Za-z0-9_]+(?:[-'][A-Za-z0-9_]+)*/g)||[]).length;const punct=(text.match(/[^\\sA-Za-z0-9_\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af]/gu)||[]).length;const ascii=(text.match(/[\\x00-\\x7f]/g)||[]).length;return Math.max(1,cjk+emoji*2+Math.max(words,Math.ceil(ascii/4))+Math.ceil(punct/2))};
    const visible=[...document.querySelectorAll('[data-message-author-role="user"],[data-message-author-role="assistant"]')];
    const domObservedTokens=visible.reduce((sum,el)=>sum+8+tokenText((el.innerText||el.textContent||'').trim()),0);
    const composer=document.querySelector('#prompt-textarea');
    const composerText=(composer?.innerText||composer?.textContent||'').replace(/\\u2060/g,'').trim();
    const devspacePluginPaired=[...(composer?.querySelectorAll('[data-id^="plugin:"]')||[])].some((el)=>/DevSpace/i.test((el.innerText||el.textContent||'')));
    return {
      mode,
      conversationId: match?.[1] || null,
      modelSlug: lastModeled?.getAttribute('data-message-model-slug') || null,
      generating: Boolean(document.querySelector('button[data-testid="stop-button"]')),
      composerTextChars: composerText.length,
      devspacePluginPaired,
      domObservedTokens,
      visibleMessageCount: visible.length,
      href: location.href,
    };
  })()`;
}

function recentVisibleMessagesExpression(limit = 8) {
  const bounded = Math.max(1, Math.min(20, Number(limit) || 8));
  return `(() => [...document.querySelectorAll('[data-message-author-role="user"],[data-message-author-role="assistant"]')]
    .map((el)=>({role:el.getAttribute('data-message-author-role'),text:(el.innerText||el.textContent||'').trim()}))
    .filter((row)=>row.text)
    .slice(-${bounded})
    .map((row)=>({role:row.role,text:row.text.slice(0,2400)})))()`;
}

function freshSurfaceForHref(href) {
  try {
    const url = new URL(String(href || ""));
    const project = url.pathname.match(/^\/g\/(g-p-[^/]+)(?:\/c\/[^/?#]+)?/);
    if (url.protocol === "https:" && url.hostname === "chatgpt.com" && project) return `https://chatgpt.com/g/${project[1]}?window_style=main_view`;
  } catch {}
  return "https://chatgpt.com/?window_style=main_view";
}

async function waitForCondition(fn, { timeoutMs = 10_000, pollMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await fn();
    if (value) return value;
    await sleep(pollMs);
  }
  return null;
}

async function pairDevspacePlugin(client) {
  const boxReady = await waitForCondition(async () => await evaluate(client, `Boolean(document.querySelector('#prompt-textarea'))`));
  if (!boxReady) throw new Error("Fresh Chat composer did not appear for DevSpace rollover.");
  const typed = await evaluate(client, `(() => { const box=document.querySelector('#prompt-textarea'); if(!box)return false; box.focus(); const sel=getSelection(); sel.selectAllChildren(box); sel.deleteFromDocument(); document.execCommand('insertText',false,'@${DEVSPACE_PLUGIN_NAME}'); box.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'@${DEVSPACE_PLUGIN_NAME}'})); return true; })()`);
  if (!typed) throw new Error("Could not open the DevSpace Ultra Chat plugin picker.");
  const selected = await waitForCondition(async () => await evaluate(client, `(() => { const wrappers=[...document.querySelectorAll('[data-composer-plugin-impression-id]')]; const wrapper=wrappers.find((el)=>{const t=(el.innerText||el.textContent||'').trim();return t.startsWith('${DEVSPACE_PLUGIN_NAME}')&&!/Tailscale/i.test(t)}); const row=wrapper?.querySelector('[tabindex="0"]'); if(!row)return false; row.click(); return true; })()`), { timeoutMs: 7_000, pollMs: 200 });
  if (!selected) throw new Error("DevSpace Ultra was not available in the Chat plugin picker.");
  await sleep(300);
  return true;
}

async function evaluate(client, expression) {
  const result = await client.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Context Guardian CDP evaluate failed.");
  return result.result?.value;
}

function emit(handler, event) {
  if (typeof handler !== "function") return;
  void Promise.resolve(handler(event)).catch(() => {});
}

function nativeConversationUrlMatches(url, conversationId) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.hostname === "chatgpt.com" && parsed.pathname === `/backend-api/conversations/${conversationId}`;
  } catch { return false; }
}

async function captureNativeConversationPayload(client, conversationId, {
  timeoutMs = 20_000,
} = {}) {
  const id = String(conversationId || "").trim();
  if (!id) throw new Error("Native conversation capture requires conversationId.");
  let captured = null;
  const finished = new Set();
  const offResponse = client.on("Network.responseReceived", (params) => {
    if (params?.response?.status === 200 && nativeConversationUrlMatches(params?.response?.url, id)) {
      captured = { requestId: params.requestId, url: params.response.url };
    }
  });
  const offFinished = client.on("Network.loadingFinished", (params) => {
    if (params?.requestId) finished.add(params.requestId);
  });
  try {
    const found = await waitForCondition(async () => captured, { timeoutMs, pollMs: 125 });
    if (!found?.requestId) throw new Error(`Classic native conversation response was not observed for ${id}.`);
    const done = await waitForCondition(async () => finished.has(found.requestId), { timeoutMs, pollMs: 100 });
    if (!done) throw new Error(`Classic native conversation response did not finish for ${id}.`);
    const body = await client.call("Network.getResponseBody", { requestId: found.requestId });
    const text = body?.base64Encoded
      ? Buffer.from(body.body, "base64").toString("utf8")
      : String(body?.body || "");
    return {
      url: found.url,
      payload: JSON.parse(text || "{}"),
    };
  } finally {
    offResponse();
    offFinished();
  }
}

export async function connectClassicContextMetadataPort(port, {
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  onCatalog,
  onTurnRequest,
  onConversationIdentity,
  onUsageEvidence,
  onTurnTransportEvent,
  onSnapshot,
  onUserTurnRollover,
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
  const connectedAt = observedAt();
  let lastTurnRequestObservedAt = null;
  const client = new ClassicCdpClient(page.webSocketDebuggerUrl, { WebSocketImpl });
  await client.open();
  await client.call("Runtime.enable");
  await client.call("Network.enable", { maxTotalBufferSize: 20_000_000, maxResourceBufferSize: 10_000_000, enableDurableMessages: true });

  const modelResponses = new Set();
  const turnIdentityCorrelator = new ClassicTurnIdentityCorrelator();
  const turnUsageRequests = new Map();
  const TURN_USAGE_TTL_MS = 2 * 60_000;
  const TURN_USAGE_MAX_PENDING = 64;
  const TURN_USAGE_MAX_BODY_BYTES = 16 * 1024 * 1024;
  const pruneTurnUsageRequests = () => {
    const cutoff = Date.now() - TURN_USAGE_TTL_MS;
    for (const [requestId, entry] of turnUsageRequests) {
      if (Number(entry?.firstSeenAt || 0) < cutoff) turnUsageRequests.delete(requestId);
    }
    if (turnUsageRequests.size <= TURN_USAGE_MAX_PENDING) return;
    const oldest = [...turnUsageRequests.entries()].sort((a, b) => Number(a[1]?.firstSeenAt || 0) - Number(b[1]?.firstSeenAt || 0));
    for (const [requestId] of oldest) {
      if (turnUsageRequests.size <= TURN_USAGE_MAX_PENDING) break;
      turnUsageRequests.delete(requestId);
    }
  };
  const emitConversationIdentity = (identity) => {
    if (!identity) return;
    emit(onConversationIdentity, { runtimeKey, port, ...identity, observedAt: observedAt() });
  };
  let nativeBaseline = null;
  let userTurnRolloverArm = null;
  let userTurnPausedHandler = null;
  let userTurnFetchEnabled = false;
  const adoptNativePayload = async (conversationId, payload, inspected = null) => {
    const current = inspected || await evaluate(client, inspectExpression());
    const observedTokens = estimateClassicConversationPayloadTokens(payload);
    const messages = conversationPayloadMessages(payload);
    nativeBaseline = {
      conversationId,
      observedTokens,
      domObservedTokens: Number(current?.domObservedTokens || 0),
      messageCount: messages.length,
      recentVisibleMessages: visibleMessagesFromPayload(payload, 12),
      capturedAt: observedAt(),
    };
    const snapshot = {
      runtimeKey,
      port,
      ok: true,
      ...current,
      conversationId,
      observedTokens,
      messageCount: messages.length,
      nativeSnapshot: true,
      observedAt: nativeBaseline.capturedAt,
    };
    emit(onSnapshot, snapshot);
    return snapshot;
  };

  const clearUserTurnRolloverArm = async ({ disableFetch = true } = {}) => {
    userTurnRolloverArm = null;
    try { userTurnPausedHandler?.(); } catch {}
    userTurnPausedHandler = null;
    if (disableFetch && userTurnFetchEnabled) {
      userTurnFetchEnabled = false;
      await client.call("Fetch.disable").catch(() => {});
    }
  };

  const verifyUserTurnRollover = async ({ arm, outcome }) => {
    const oldConversationId = String(outcome?.oldConversationId || arm?.oldConversationId || "").trim();
    try {
      const stable = await waitForCondition(async () => {
        const state = await evaluate(client, inspectExpression());
        if (state?.mode === "work") throw new Error("User-turn rollover unexpectedly entered Work mode.");
        return state?.conversationId
          && state.conversationId !== oldConversationId
          && state.generating === false
          && Number(state.composerTextChars || 0) === 0
          ? state
          : null;
      }, { timeoutMs: Math.max(30_000, Number(arm?.verifyTimeoutMs) || DEFAULT_ROLLOVER_TIMEOUT_MS), pollMs: 300 });
      if (!stable?.conversationId) throw new Error("User-turn rollover did not reach a stable fresh conversation.");
      const captured = await captureNativeConversationPayload(client, stable.conversationId, { reload: true, timeoutMs: 25_000 });
      const messages = conversationPayloadMessages(captured.payload);
      const visibleUsers = messages.filter((message) => (message?.author?.role || message?.role) === "user" && message?.metadata?.is_visually_hidden_from_conversation !== true).length;
      const visibleAssistants = messages.filter((message) => (message?.author?.role || message?.role) === "assistant" && message?.metadata?.is_visually_hidden_from_conversation !== true && (!message?.recipient || message.recipient === "all")).length;
      const hiddenMessages = messages.filter((message) => message?.metadata?.is_visually_hidden_from_conversation === true).length;
      const expectedVisibleUsers = Math.max(1, Number(outcome?.visibleUserMessages || 1));
      if (visibleUsers < expectedVisibleUsers || visibleAssistants < 1 || hiddenMessages < 1) {
        throw new Error(`User-turn rollover verification failed: ${JSON.stringify({ visibleUsers, visibleAssistants, hiddenMessages, expectedVisibleUsers })}`);
      }
      const after = await evaluate(client, inspectExpression());
      const snapshot = await adoptNativePayload(stable.conversationId, captured.payload, after);
      emit(onUserTurnRollover, {
        ok: true,
        runtimeKey,
        port,
        goalId: arm?.goalId || null,
        oldConversationId,
        newConversationId: stable.conversationId,
        conversationId: stable.conversationId,
        visibleUsers,
        visibleAssistants,
        hiddenMessages,
        observedTokens: snapshot?.observedTokens ?? null,
        observedAt: observedAt(),
      });
    } catch (error) {
      emit(onUserTurnRollover, {
        ok: false,
        runtimeKey,
        port,
        goalId: arm?.goalId || null,
        oldConversationId,
        error: error instanceof Error ? error.message : String(error),
        observedAt: observedAt(),
      });
    }
  };

  const armUserTurnRollover = async ({
    capsulePrompt,
    oldConversationId,
    goalId = null,
    ttlMs = 60_000,
    verifyTimeoutMs = DEFAULT_ROLLOVER_TIMEOUT_MS,
  } = {}) => {
    const prompt = String(capsulePrompt ?? "").trim();
    const oldId = String(oldConversationId ?? "").trim();
    if (!prompt || !oldId) return { armed: false, reason: "missing-input" };
    const current = await evaluate(client, inspectExpression());
    if (current?.mode === "work") return { armed: false, reason: "work-mode" };
    if (current?.generating) return { armed: false, reason: "generating" };
    if (current?.conversationId !== oldId) return { armed: false, reason: "conversation-changed" };
    if (current?.devspacePluginPaired !== true) return { armed: false, reason: "devspace-plugin-not-paired" };
    const expiresAt = Date.now() + Math.max(5_000, Math.min(300_000, Number(ttlMs) || 60_000));
    if (userTurnRolloverArm?.oldConversationId === oldId) {
      userTurnRolloverArm = { ...userTurnRolloverArm, capsulePrompt: prompt, goalId, expiresAt, verifyTimeoutMs };
      return { armed: true, reused: true, oldConversationId: oldId };
    }
    await clearUserTurnRolloverArm();
    await client.call("Fetch.enable", {
      patterns: [{ urlPattern: "*backend-api/f/conversation*", requestStage: "Request" }],
    });
    userTurnFetchEnabled = true;
    userTurnRolloverArm = { capsulePrompt: prompt, oldConversationId: oldId, goalId, expiresAt, verifyTimeoutMs, consuming: false };
    userTurnPausedHandler = client.on("Fetch.requestPaused", (params) => {
      void (async () => {
        const arm = userTurnRolloverArm;
        const requestId = params?.requestId;
        if (!requestId) return;
        if (!arm || Date.now() > arm.expiresAt) {
          await client.call("Fetch.continueRequest", { requestId }).catch(() => {});
          await clearUserTurnRolloverArm();
          return;
        }
        if (arm.consuming) {
          await client.call("Fetch.continueRequest", { requestId }).catch(() => {});
          return;
        }
        let requestConversationId = null;
        try {
          const body = JSON.parse(String(params?.request?.postData || "{}"));
          requestConversationId = typeof body?.conversation_id === "string" ? body.conversation_id.trim() : null;
        } catch {}
        if (requestConversationId !== arm.oldConversationId) {
          await client.call("Fetch.continueRequest", { requestId }).catch(() => {});
          return;
        }
        arm.consuming = true;
        const outcome = await rewriteUserTurnRolloverPausedRequest(client, params, {
          capsulePrompt: arm.capsulePrompt,
          attribution: "devspace-ultra",
          toolName: "devspace_context_guardian",
        });
        if (!outcome.handled) {
          arm.consuming = false;
          await client.call("Fetch.continueRequest", { requestId }).catch(() => {});
          return;
        }
        const consumedArm = { ...arm };
        await clearUserTurnRolloverArm();
        if (!outcome.modified) {
          emit(onUserTurnRollover, {
            ok: false,
            runtimeKey,
            port,
            goalId: consumedArm.goalId || null,
            oldConversationId: consumedArm.oldConversationId,
            error: outcome.error || "User-turn rollover request rewrite failed closed.",
            observedAt: observedAt(),
          });
          return;
        }
        void verifyUserTurnRollover({ arm: consumedArm, outcome });
      })().catch(async (error) => {
        const requestId = params?.requestId;
        if (requestId) await client.call("Fetch.failRequest", { requestId, errorReason: "Aborted" }).catch(() => {});
        const arm = userTurnRolloverArm;
        await clearUserTurnRolloverArm();
        emit(onUserTurnRollover, {
          ok: false,
          runtimeKey,
          port,
          goalId: arm?.goalId || null,
          oldConversationId: arm?.oldConversationId || null,
          error: error instanceof Error ? error.message : String(error),
          observedAt: observedAt(),
        });
      });
    });
    return { armed: true, reused: false, oldConversationId: oldId };
  };

  const disposers = [];
  disposers.push(client.on("Network.requestWillBeSent", (params) => {
    const metadata = parseClassicTurnRequest(params?.request);
    if (!metadata) return;
    const at = observedAt();
    lastTurnRequestObservedAt = at;
    const requestId = String(params?.requestId || "").trim();
    if (requestId && metadata.conversationId) {
      pruneTurnUsageRequests();
      turnUsageRequests.set(requestId, {
        conversationId: metadata.conversationId,
        requestHeaders: params?.request?.headers || {},
        responseHeaders: {},
        firstSeenAt: Date.now(),
      });
      pruneTurnUsageRequests();
      emit(onTurnTransportEvent, {
        runtimeKey,
        port,
        conversationId: metadata.conversationId,
        kind: "request",
        observedAt: at,
      });
    }
    emit(onTurnRequest, { runtimeKey, port, ...metadata, observedAt: at });
    emitConversationIdentity(turnIdentityCorrelator.noteRequest(params));
  }));
  disposers.push(client.on("Network.requestWillBeSentExtraInfo", (params) => {
    const requestId = String(params?.requestId || "").trim();
    const pendingUsage = requestId ? turnUsageRequests.get(requestId) : null;
    if (pendingUsage) pendingUsage.requestHeaders = params?.headers || pendingUsage.requestHeaders || {};
    emitConversationIdentity(turnIdentityCorrelator.noteExtraInfo(params));
  }));
  disposers.push(client.on("Network.responseReceived", (params) => {
    const requestId = String(params?.requestId || "").trim();
    const pendingUsage = requestId ? turnUsageRequests.get(requestId) : null;
    if (pendingUsage && isTurnUrl(params?.response?.url)) {
      pendingUsage.responseHeaders = params?.response?.headers || pendingUsage.responseHeaders || {};
      emit(onTurnTransportEvent, {
        runtimeKey,
        port,
        conversationId: pendingUsage.conversationId,
        kind: "response",
        status: Number(params?.response?.status || 0) || null,
        observedAt: observedAt(),
      });
    }
    if (requestId && params?.response?.status === 200 && isNativeModelsUrl(params?.response?.url)) {
      modelResponses.add(requestId);
    }
  }));
  disposers.push(client.on("Network.responseReceivedExtraInfo", (params) => {
    const requestId = String(params?.requestId || "").trim();
    const pendingUsage = requestId ? turnUsageRequests.get(requestId) : null;
    if (pendingUsage) pendingUsage.responseHeaders = params?.headers || pendingUsage.responseHeaders || {};
  }));
  disposers.push(client.on("Network.loadingFailed", (params) => {
    if (params?.requestId) {
      const pendingUsage = turnUsageRequests.get(String(params.requestId));
      if (pendingUsage?.conversationId) {
        emit(onTurnTransportEvent, {
          runtimeKey,
          port,
          conversationId: pendingUsage.conversationId,
          kind: "failed",
          errorText: String(params?.errorText || ""),
          canceled: params?.canceled === true,
          blockedReason: params?.blockedReason || null,
          observedAt: observedAt(),
        });
      }
      modelResponses.delete(params.requestId);
      turnUsageRequests.delete(params.requestId);
      turnIdentityCorrelator.forget(params.requestId);
    }
  }));
  disposers.push(client.on("Network.loadingFinished", (params) => {
    const requestId = String(params?.requestId || "").trim();
    if (requestId) turnIdentityCorrelator.forget(requestId);
    const usageRequest = requestId ? turnUsageRequests.get(requestId) : null;
    if (usageRequest) {
      emit(onTurnTransportEvent, {
        runtimeKey,
        port,
        conversationId: usageRequest.conversationId,
        kind: "finished",
        observedAt: observedAt(),
      });
      turnUsageRequests.delete(requestId);
      void (async () => {
        let responseBody = "";
        if (Number(params?.encodedDataLength || 0) <= TURN_USAGE_MAX_BODY_BYTES) {
          try {
            const body = await client.call("Network.getResponseBody", { requestId });
            responseBody = body?.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : String(body?.body || "");
          } catch {}
        }
        const evidence = extractClassicNativeUsageEvidence({
          conversationId: usageRequest.conversationId,
          requestHeaders: usageRequest.requestHeaders,
          responseHeaders: usageRequest.responseHeaders,
          responseBody,
          observedAt: observedAt(),
        });
        emit(onUsageEvidence, { runtimeKey, port, ...evidence });
      })().catch(() => {});
    }
    if (!requestId || !modelResponses.delete(requestId)) return;
    void (async () => {
      const body = await client.call("Network.getResponseBody", { requestId });
      const text = body?.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : String(body?.body || "");
      const models = parseNativeClassicModelResponse(text);
      if (models.length) emit(onCatalog, { runtimeKey, port, models, observedAt: observedAt() });
    })().catch(() => {});
  }));

  let initial = null;
  try { initial = await evaluate(client, inspectExpression()); } catch {}
  if (initial) emit(onSnapshot, { runtimeKey, port, ...initial, observedAt: observedAt() });

  const closeListener = () => { try { onDisconnected?.({ runtimeKey, port }); } catch {} };
  client.ws.addEventListener?.("close", closeListener, { once: true });

  return {
    runtimeKey,
    port,
    async inspect() { return await evaluate(client, inspectExpression()); },
    async evaluateExpression(expression) {
      const text = String(expression ?? "").trim();
      if (!text) throw new Error("Context Guardian runtime evaluation requires an expression.");
      return await evaluate(client, text);
    },
    async refreshSnapshot() {
      const current = await evaluate(client, inspectExpression());
      if (userTurnRolloverArm && (
        current?.mode === "work"
        || (current?.conversationId && current.conversationId !== userTurnRolloverArm.oldConversationId)
      )) {
        await clearUserTurnRolloverArm();
      }
      const sameNative = Boolean(current?.conversationId && nativeBaseline?.conversationId === current.conversationId);
      const domDelta = sameNative
        ? Math.max(0, Number(current?.domObservedTokens || 0) - Number(nativeBaseline?.domObservedTokens || 0))
        : 0;
      const observedTokens = sameNative
        ? Number(nativeBaseline.observedTokens || 0) + domDelta
        : undefined;
      const snapshot = {
        runtimeKey,
        port,
        ok: Boolean(current?.conversationId),
        ...current,
        ...(Number.isFinite(observedTokens) ? { observedTokens } : {}),
        messageCount: sameNative ? nativeBaseline.messageCount : current?.visibleMessageCount ?? 0,
        nativeSnapshot: sameNative,
      };
      emit(onSnapshot, { ...snapshot, observedAt: observedAt() });
      return snapshot;
    },
    async captureNativeSnapshot() {
      throw new Error("Context Guardian native snapshot reload is forbidden; wait for passively observed Classic-native metadata.");
    },
    async armUserTurnRollover() {
      return { armed: false, reason: "legacy-fresh-conversation-rollover-disabled" };
    },
    async cancelUserTurnRollover() {
      const wasArmed = Boolean(userTurnRolloverArm);
      await clearUserTurnRolloverArm();
      return { cancelled: wasArmed };
    },
    get userTurnRolloverArmed() { return Boolean(userTurnRolloverArm); },
    async recentVisibleMessages({ limit = 8 } = {}) {
      const current = await evaluate(client, inspectExpression());
      if (current?.conversationId && nativeBaseline?.conversationId === current.conversationId && nativeBaseline.recentVisibleMessages?.length) {
        return nativeBaseline.recentVisibleMessages.slice(-Math.max(1, Math.min(20, Number(limit) || 8)));
      }
      const rows = await evaluate(client, recentVisibleMessagesExpression(limit));
      return Array.isArray(rows) ? rows : [];
    },
    async startHiddenRollover() {
      throw new Error("Legacy fresh-conversation rollover is disabled; true Auto Compact must remain in the same conversation.");
    },
    get connectedAt() { return connectedAt; },
    get lastTurnRequestObservedAt() { return lastTurnRequestObservedAt; },
    get pendingCdpCalls() { return client.pendingSize; },
    get pendingUsageRequests() { return turnUsageRequests.size; },
    get pendingIdentityCorrelations() { return turnIdentityCorrelator.pendingSize; },
    async close() {
      await clearUserTurnRolloverArm();
      for (const dispose of disposers) dispose();
      client.close();
      await sleep(0);
    },
  };
}

export class ClassicContextMetadataCdpAdapter {
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
    this.connectPort = connectPort || ((port, handlers) => connectClassicContextMetadataPort(port, { ...this.options, ...handlers }));
    this.sessions = new Map();
    this.handlers = {};
    this.timer = null;
    this.polling = null;
    this.closed = false;
  }

  setHandlers({ onCatalog, onTurnRequest, onConversationIdentity, onUsageEvidence, onTurnTransportEvent, onSnapshot, onUserTurnRollover } = {}) {
    this.handlers = { onCatalog, onTurnRequest, onConversationIdentity, onUsageEvidence, onTurnTransportEvent, onSnapshot, onUserTurnRollover };
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
  }

  #session(runtimeKey) {
    const session = this.sessions.get(runtimeKey);
    if (!session) throw new Error(`Context Guardian runtime ${runtimeKey} is not connected.`);
    return session;
  }

  async refreshSnapshot(runtimeKey) {
    return await this.#session(runtimeKey).refreshSnapshot();
  }

  async evaluateRuntime(runtimeKey, expression) {
    return await this.#session(runtimeKey).evaluateExpression(expression);
  }

  async captureNativeSnapshot(runtimeKey) {
    return await this.#session(runtimeKey).captureNativeSnapshot();
  }

  async recentVisibleMessages(runtimeKey, options = {}) {
    return await this.#session(runtimeKey).recentVisibleMessages(options);
  }

  async armUserTurnRollover(runtimeKey, input) {
    return await this.#session(runtimeKey).armUserTurnRollover(input);
  }

  async cancelUserTurnRollover(runtimeKey) {
    return await this.#session(runtimeKey).cancelUserTurnRollover();
  }

  async startHiddenRollover(runtimeKey, input) {
    return await this.#session(runtimeKey).startHiddenRollover(input);
  }

  status() {
    return {
      connected: this.sessions.size,
      runtimes: [...this.sessions.values()].map((session) => ({
        runtimeKey: session.runtimeKey,
        port: session.port,
        connectedAt: session.connectedAt ?? null,
        lastTurnRequestObservedAt: session.lastTurnRequestObservedAt ?? null,
        userTurnRolloverArmed: session.userTurnRolloverArmed === true,
        pendingCdpCalls: Number(session.pendingCdpCalls || 0),
        pendingUsageRequests: Number(session.pendingUsageRequests || 0),
        pendingIdentityCorrelations: Number(session.pendingIdentityCorrelations || 0),
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
