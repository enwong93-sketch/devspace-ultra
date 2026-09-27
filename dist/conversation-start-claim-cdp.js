import { ClassicCdpClient } from "./classic-cdp-client.js";
import { defaultMainDebugPorts } from "./goal-host-bridge.js";
import { runtimeKeyForPort } from "./classic-stream-recovery-cdp.js";

const DEFAULT_PROBE_TIMEOUT_MS = 800;
const DEFAULT_EVALUATE_TIMEOUT_MS = 900;
const DEFAULT_CONTEXT_SETTLE_MS = 60;
const DEFAULT_MAX_IFRAMES = 128;
const DEFAULT_BATCH_SIZE = 8;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chooseAppContext(client, targetId) {
  // MCP Apps run window.openai inside the iframe's inner/default execution
  // context rather than the DevTools target's outer default world. Evaluating
  // without an explicit contextId therefore sees globalThis.openai as absent
  // even though the app is mounted and has the pending claim.
  return [...client.contexts].reverse().find((context) => (
    context.auxData?.isDefault
    && context.auxData?.frameId
    && context.auxData.frameId !== targetId
  )) || [...client.contexts].reverse().find((context) => context.auxData?.isDefault) || null;
}

class ClaimCdpClient extends ClassicCdpClient {
  constructor(url, options = {}) {
    super(url, options);
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

function cleanClaimId(value) {
  const text = String(value ?? "").trim();
  return text && /^[A-Za-z0-9_-]{16,200}$/.test(text) ? text : null;
}

function conversationIdFromUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'chatgpt.com') return null;
    return parsed.pathname.match(/\/c\/([^/?#]+)/)?.[1] || null;
  }
  catch { return null; }
}

function appSandboxOriginFromTarget(target) {
  for (const value of [target?.url, target?.title]) {
    try {
      const parsed = new URL(String(value || ""));
      if (parsed.protocol !== "https:") continue;
      if (!/^asdk_app_[a-z0-9]+\.web-sandbox\.oaiusercontent\.com$/i.test(parsed.hostname)) continue;
      return parsed.origin;
    } catch {}
  }
  return null;
}

function boundedEdgeCandidates(items, limit) {
  const rows = Array.isArray(items) ? items : [];
  const cap = Math.max(8, Number(limit) || DEFAULT_MAX_IFRAMES);
  if (rows.length <= cap) return rows;
  // Chromium target ordering has varied between Desktop builds. A newly
  // mounted one-time relay appears at one edge, so inspect both edges instead
  // of rejecting the entire conversation after historical iframes exceed a
  // fixed cap. Middle targets remain untrusted and are never guessed.
  const firstCount = Math.floor(cap / 2);
  const selected = [...rows.slice(0, firstCount), ...rows.slice(-(cap - firstCount))];
  const seen = new Set();
  return selected.filter((row, index) => {
    const key = String(row?.id || row?.webSocketDebuggerUrl || `candidate-${index}`);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchTargets(port, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const value = await response.json();
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function claimProbeExpression(claimId, claimType = "conversation-start") {
  const expected = JSON.stringify(claimId);
  const normalizedType = claimType === "progress" ? "progress" : "conversation-start";
  const type = JSON.stringify(normalizedType);
  return `(() => {
    const expected=${expected};
    const claimType=${type};
    const values=[
      globalThis.openai?.toolOutput,
      globalThis.openai?.toolResponseMetadata,
      globalThis.openai?.toolResult,
    ];
    const readStart=(value)=>value?.structuredContent?.conversationStartClaim?.claimId
      ?? value?.structured_content?.conversationStartClaim?.claimId
      ?? value?.toolResult?.structuredContent?.conversationStartClaim?.claimId
      ?? value?.["devspace/conversationStartClaim"]?.claimId
      ?? value?._meta?.["devspace/conversationStartClaim"]?.claimId
      ?? value?.conversationStartClaim?.claimId
      ?? null;
    const readProgress=(value)=>value?.structuredContent?.progressClaim?.claimId
      ?? value?.structured_content?.progressClaim?.claimId
      ?? value?.toolResult?.structuredContent?.progressClaim?.claimId
      ?? value?.["devspace/progressClaim"]?.claimId
      ?? value?._meta?.["devspace/progressClaim"]?.claimId
      ?? value?.progressClaim?.claimId
      ?? null;
    const read=claimType==='progress'?readProgress:readStart;
    return values.some((value)=>read(value)===expected);
  })()`;
}

async function evaluateClaimTarget(target, claimId, claimType, {
  WebSocketImpl = globalThis.WebSocket,
  timeoutMs = DEFAULT_EVALUATE_TIMEOUT_MS,
  contextSettleMs = DEFAULT_CONTEXT_SETTLE_MS,
} = {}) {
  if (!target?.webSocketDebuggerUrl) return false;
  const client = new ClaimCdpClient(target.webSocketDebuggerUrl, {
    WebSocketImpl,
    callTimeoutMs: timeoutMs,
    maxPendingCalls: 4,
  });
  try {
    await client.open();
    await client.call("Runtime.enable");
    await sleep(Math.max(0, Number(contextSettleMs) || 0));
    const context = chooseAppContext(client, target.id);
    if (!context) return false;
    const result = await client.call("Runtime.evaluate", {
      contextId: context.id,
      expression: claimProbeExpression(claimId, claimType),
      returnByValue: true,
      awaitPromise: false,
    });
    return result?.result?.value === true;
  } catch {
    return false;
  } finally {
    client.close();
  }
}

/**
 * Resolve one pending Goal/Plan start claim by proving which exact hidden MCP
 * App iframe received the original tool result. The iframe target's parentId is
 * mapped back to the current ChatGPT page URL, so no Runtime-only/window-only
 * ownership guess is ever accepted.
 */
export class ConversationStartClaimCdpResolver {
  constructor({
    ports = defaultMainDebugPorts(),
    listTargets = (port) => fetchTargets(port),
    evaluateTarget = (target, claimId, claimType) => evaluateClaimTarget(target, claimId, claimType),
    maxIframes = DEFAULT_MAX_IFRAMES,
    batchSize = DEFAULT_BATCH_SIZE,
    now = () => Date.now(),
  } = {}) {
    this.ports = [...new Set((Array.isArray(ports) ? ports : []).map(Number).filter((port) => Number.isInteger(port)))];
    this.listTargets = listTargets;
    this.evaluateTarget = evaluateTarget;
    this.maxIframes = Math.max(8, Math.min(512, Number(maxIframes) || DEFAULT_MAX_IFRAMES));
    this.batchSize = Math.max(1, Math.min(32, Number(batchSize) || DEFAULT_BATCH_SIZE));
    this.now = now;
  }

  async find({ claimId, claimType = "conversation-start" } = {}) {
    const expected = cleanClaimId(claimId);
    if (!expected) return null;
    const normalizedType = claimType === "progress" ? "progress" : "conversation-start";
    const owners = new Map();
    const displays = new Map();
    let inspected = 0;
    let inventoryIframes = 0;
    // Probe offline loopback ports concurrently, not 32 sequential deadlines.
    // No ownership is cached between requests.
    const inventories = await Promise.all(this.ports.map(async (port) => ({
      port, targets: await this.listTargets(port).catch(() => []),
    })));
    for (const { port, targets } of inventories) {
      if (!Array.isArray(targets) || !targets.length) continue;
      const pages = new Map(
        targets
          .filter((target) => target?.type === "page" && conversationIdFromUrl(target?.url))
          .map((target) => [String(target.id || ""), target]),
      );
      if (!pages.size) continue;
      const iframes = targets
        .filter((target) => target?.type === "iframe" && pages.has(String(target?.parentId || "")) && target?.webSocketDebuggerUrl);
      inventoryIframes += iframes.length;
      const candidates = boundedEdgeCandidates(iframes, this.maxIframes);

      for (let index = 0; index < candidates.length; index += this.batchSize) {
        const batch = candidates.slice(index, index + this.batchSize);
        const results = await Promise.all(batch.map(async (target) => ({
          target,
          matched: await this.evaluateTarget(target, expected, normalizedType).catch(() => false),
        })));
        inspected += batch.length;
        for (const row of results) {
          if (!row.matched) continue;
          const page = pages.get(String(row.target.parentId || ""));
          const conversationId = conversationIdFromUrl(page?.url);
          const runtimeKey = runtimeKeyForPort(port);
          const appSandboxOrigin = appSandboxOriginFromTarget(row.target);
          if (!conversationId || !runtimeKey) continue;
          const existingOwner = owners.get(conversationId);
          if (existingOwner?.appSandboxOrigin && appSandboxOrigin && existingOwner.appSandboxOrigin !== appSandboxOrigin) return null;
          if (!existingOwner) owners.set(conversationId, { runtimeKey, conversationId, appSandboxOrigin });
          else if (!existingOwner.appSandboxOrigin && appSandboxOrigin) existingOwner.appSandboxOrigin = appSandboxOrigin;
          displays.set(`${port}:${page.id}`, { port, pageId: page.id, conversationId });
        }
        if (owners.size > 1) return null;
        // Do not stop at the first match: a later batch may prove a conflict.
      }
    }

    if (owners.size !== 1) return null;
    const owner = [...owners.values()][0];
    for (const display of displays.values()) {
      const current = await this.listTargets(display.port).catch(() => []);
      const page = current.find((target) => target?.type === 'page' && target.id === display.pageId);
      if (conversationIdFromUrl(page?.url) !== owner.conversationId) return null;
    }
    return {
      ...owner,
      claimId: expected,
      source: normalizedType === "progress"
        ? "classic-exact-page-progress-claim-cdp-page-verified"
        : "classic-exact-page-start-claim-cdp-page-verified",
      pageVerified: true,
      observedAt: new Date(Number(this.now())).toISOString(),
      inspectedIframes: inspected,
      inventoryIframes,
      truncatedIframes: Math.max(0, inventoryIframes - inspected),
      matchingDisplays: displays.size,
    };
  }
}

export const conversationStartClaimCdpInternals = {
  claimProbeExpression,
  cleanClaimId,
  conversationIdFromUrl,
  appSandboxOriginFromTarget,
  boundedEdgeCandidates,
  chooseAppContext,
};
