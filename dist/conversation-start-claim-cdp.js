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
  try { return new URL(String(url || "")).pathname.match(/\/c\/([^/?#]+)/)?.[1] || null; }
  catch { return null; }
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
    let inspected = 0;

    for (const port of this.ports) {
      const targets = await this.listTargets(port).catch(() => []);
      if (!Array.isArray(targets) || !targets.length) continue;
      const pages = new Map(
        targets
          .filter((target) => target?.type === "page" && /chatgpt\.com/i.test(String(target?.url || "")))
          .map((target) => [String(target.id || ""), target]),
      );
      if (!pages.size) continue;
      const iframes = targets
        .filter((target) => target?.type === "iframe" && pages.has(String(target?.parentId || "")) && target?.webSocketDebuggerUrl)
        .slice(0, this.maxIframes);

      for (let index = 0; index < iframes.length; index += this.batchSize) {
        const batch = iframes.slice(index, index + this.batchSize);
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
          if (!conversationId || !runtimeKey) continue;
          owners.set(`${runtimeKey}:${conversationId}`, { runtimeKey, conversationId });
        }
        if (owners.size > 1) return null;
        if (owners.size === 1) break;
      }
    }

    if (owners.size !== 1) return null;
    const owner = [...owners.values()][0];
    return {
      ...owner,
      claimId: expected,
      source: normalizedType === "progress"
        ? "classic-exact-page-progress-claim-cdp-page-verified"
        : "classic-exact-page-start-claim-cdp-page-verified",
      pageVerified: true,
      observedAt: new Date(Number(this.now())).toISOString(),
      inspectedIframes: inspected,
    };
  }
}

export const conversationStartClaimCdpInternals = {
  claimProbeExpression,
  cleanClaimId,
  conversationIdFromUrl,
  chooseAppContext,
};
