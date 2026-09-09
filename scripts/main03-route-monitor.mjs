import { ClassicCdpClient } from "../dist/classic-cdp-client.js";

const port = Number(process.argv[2] || 9733);
const durationMs = Math.max(5_000, Number(process.argv[3] || 60_000));
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { cache: "no-store" })).json();
const page = Array.isArray(targets)
  ? targets.find((target) => target?.type === "page" && /chatgpt\.com/i.test(target?.url || "") && target?.webSocketDebuggerUrl)
  : null;
if (!page) throw new Error(`No ChatGPT page target on port ${port}.`);

const client = new ClassicCdpClient(page.webSocketDebuggerUrl, { callTimeoutMs: 15_000, maxPendingCalls: 128 });
await client.open();
await client.call("Runtime.enable");
await client.call("Page.enable");
await client.call("Network.enable", { maxTotalBufferSize: 8_000_000, maxResourceBufferSize: 2_000_000 });

const startedAt = Date.now();
const events = [];
const requests = new Map();
const add = (type, data = {}) => {
  events.push({ t: Date.now() - startedAt, type, ...data });
  if (events.length > 2_000) events.shift();
};
const cleanUrl = (value) => {
  try {
    const url = new URL(String(value || ""));
    return `${url.origin}${url.pathname}`.slice(0, 1_000);
  } catch {
    return String(value || "").slice(0, 1_000);
  }
};
const relevant = (url) => /chatgpt\.com\/(?:backend-api|g\/|c\/|$)/i.test(String(url || ""));

const disposers = [];
disposers.push(client.on("Page.frameNavigated", (params) => {
  if (!params?.frame?.parentId) add("frameNavigated", { url: cleanUrl(params?.frame?.url) });
}));
disposers.push(client.on("Page.navigatedWithinDocument", (params) => {
  add("navigatedWithinDocument", { url: cleanUrl(params?.url) });
}));
disposers.push(client.on("Network.requestWillBeSent", (params) => {
  const url = String(params?.request?.url || "");
  if (!relevant(url)) return;
  requests.set(params.requestId, { url, method: params?.request?.method || null });
  const path = cleanUrl(url);
  if (/\/backend-api\/(?:conversation|conversations|f\/conversation|project|projects)/i.test(path)) {
    add("request", {
      requestId: params.requestId,
      method: params?.request?.method || null,
      url: path,
      resourceType: params?.type || null,
      initiatorType: params?.initiator?.type || null,
    });
  }
}));
disposers.push(client.on("Network.responseReceived", (params) => {
  const url = String(params?.response?.url || requests.get(params?.requestId)?.url || "");
  if (!relevant(url)) return;
  const status = Number(params?.response?.status || 0);
  const path = cleanUrl(url);
  if (status >= 400 || /\/backend-api\/(?:conversation|conversations|f\/conversation|project|projects)/i.test(path)) {
    add("response", {
      requestId: params.requestId,
      status,
      statusText: String(params?.response?.statusText || "").slice(0, 120),
      url: path,
      mimeType: params?.response?.mimeType || null,
    });
  }
}));
disposers.push(client.on("Network.loadingFailed", (params) => {
  const request = requests.get(params?.requestId);
  add("loadingFailed", {
    requestId: params?.requestId || null,
    url: cleanUrl(request?.url),
    errorText: String(params?.errorText || "").slice(0, 300),
    canceled: params?.canceled === true,
    blockedReason: params?.blockedReason || null,
  });
  requests.delete(params?.requestId);
}));
disposers.push(client.on("Network.loadingFinished", (params) => requests.delete(params?.requestId)));

let priorSignature = null;
const snapshots = [];
const inspect = async () => {
  try {
    const result = await client.call("Runtime.evaluate", {
      expression: `(() => {
        const text = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
        const alerts = [...document.querySelectorAll('[role="alert"],[role="status"],[data-sonner-toast]')]
          .map((node) => (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim())
          .filter(Boolean)
          .slice(-12);
        const match = location.pathname.match(/\\/c\\/([^/?#]+)/);
        const visibleNode = (node) => {
          if (!node) return false;
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
        };
        const templateErrors = [...document.querySelectorAll('body *')]
          .filter((node) => /Failed to fetch template|載入應用程式時發生錯誤/i.test((node.innerText || node.textContent || '').trim()))
          .filter((node) => ![...node.children].some((child) => /Failed to fetch template|載入應用程式時發生錯誤/i.test((child.innerText || child.textContent || '').trim())))
          .slice(0, 12)
          .map((node) => {
            const ancestors = [];
            let current = node;
            for (let depth = 0; depth < 7 && current; depth += 1, current = current.parentElement) {
              ancestors.push({
                tag: current.tagName || null,
                className: String(current.className || '').slice(0, 220),
                text: (current.innerText || current.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 260),
              });
            }
            const shell = node.closest?.('[data-devspace-legacy-inline-error-retired="true"]') || node;
            return { tag: node.tagName || null, className: String(node.className || '').slice(0, 220), text: (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 260), visible: visibleNode(shell), ancestors };
          });
        const embeds = [...document.querySelectorAll('iframe')].map((frame, index) => {
          const ancestors = [];
          let node = frame;
          for (let depth = 0; depth < 7 && node; depth += 1, node = node.parentElement) {
            ancestors.push({
              tag: node.tagName || null,
              id: node.id || null,
              role: node.getAttribute?.('role') || null,
              testId: node.getAttribute?.('data-testid') || null,
              ariaLabel: node.getAttribute?.('aria-label') || null,
              className: String(node.className || '').slice(0, 220),
              text: (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 260),
            });
          }
          const retiredShell = frame.closest?.('[data-devspace-legacy-inline-retired="true"]');
          return {
            index,
            src: String(frame.src || '').slice(0, 500),
            title: frame.title || null,
            name: frame.name || null,
            ariaLabel: frame.getAttribute('aria-label') || null,
            retired: Boolean(retiredShell),
            visible: visibleNode(retiredShell || frame),
            ancestors,
          };
        });
        const progressRoot = document.getElementById('devspace-progress-narration-root');
        const progressNarration = progressRoot ? {
          mounted:true,
          visible:progressRoot.dataset.visible === 'true' && visibleNode(progressRoot),
          conversationId:progressRoot.dataset.conversationId || null,
          goalId:progressRoot.dataset.goalId || null,
          progressKind:progressRoot.dataset.progressKind || null,
          uiVersion:progressRoot.dataset.uiVersion || null,
          messageCount:Array.isArray(progressRoot.__devspaceProgressMessages) ? progressRoot.__devspaceProgressMessages.length : 0,
          retiredLegacyInlineApps:Number(progressRoot.dataset.retiredLegacyInlineApps || 0),
          retiredLegacyInlineErrors:Number(progressRoot.dataset.retiredLegacyInlineErrors || 0),
          text:(progressRoot.innerText || progressRoot.textContent || '').replace(/\\s+/g,' ').trim().slice(0,800),
        } : { mounted:false, visible:false };
        return {
          href: location.href,
          path: location.pathname,
          conversationId: match?.[1] || null,
          readyState: document.readyState,
          composerReady: Boolean(document.querySelector('#prompt-textarea')),
          visibleMessages: document.querySelectorAll('[data-message-author-role="user"],[data-message-author-role="assistant"]').length,
          generating: Boolean(document.querySelector('button[data-testid="stop-button"]')),
          tooManyRequests: /too many requests|請求過多|请求过多/i.test(text),
          alerts,
          progressNarration,
          templateErrors,
          visibleTemplateErrors:templateErrors.filter((item)=>item.visible).length,
          embeds,
          visibleLegacyInlineApps:embeds.filter((item)=>['ui://devspace/goal-dock.html','ui://devspace/plan-card.html'].includes(item.title || '') && item.visible).length,
        };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result?.exceptionDetails) {
      add("inspectException", {
        text: result.exceptionDetails.text || null,
        description: result.exceptionDetails.exception?.description || null,
      });
      return;
    }
    const value = result?.result?.value || null;
    if (!value) {
      add("inspectEmpty", { resultType: result?.result?.type || null, description: result?.result?.description || null });
      return;
    }
    const signature = JSON.stringify(value);
    if (signature !== priorSignature) {
      priorSignature = signature;
      snapshots.push({ t: Date.now() - startedAt, ...value, href: cleanUrl(value.href) });
      if (snapshots.length > 500) snapshots.shift();
    }
  } catch (error) {
    add("inspectError", { error: error instanceof Error ? error.message : String(error) });
  }
};

await inspect();
const timer = setInterval(() => { void inspect(); }, 500);
timer.unref?.();
await new Promise((resolve) => setTimeout(resolve, durationMs));
clearInterval(timer);
await inspect();
for (const dispose of disposers) dispose();
client.close();

const summary = {
  ok: true,
  port,
  durationMs,
  initialTargetUrl: cleanUrl(page.url),
  snapshots,
  events,
  counts: {
    snapshots: snapshots.length,
    navigations: events.filter((event) => /Navigated|navigated/.test(event.type)).length,
    requests: events.filter((event) => event.type === "request").length,
    responses: events.filter((event) => event.type === "response").length,
    http429: events.filter((event) => event.type === "response" && event.status === 429).length,
    failedLoads: events.filter((event) => event.type === "loadingFailed").length,
    tooManyRequestSnapshots: snapshots.filter((snapshot) => snapshot.tooManyRequests).length,
  },
};
console.log(JSON.stringify(summary));
