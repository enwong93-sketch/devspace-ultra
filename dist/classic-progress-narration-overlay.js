import { readFile } from "node:fs/promises";
import { runtimeKeyForPort } from "./classic-stream-recovery-cdp.js";
import { activeProgressRows } from "./goal-progress-narrator.js";

const ROOT_ID = "devspace-progress-narration-root";
const STYLE_ID = "devspace-progress-narration-style";
const LEASE_KEY = "__devspaceProgressNarrationLeaseV1";
const LEASE_MS = 15_000;
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_MAX_MESSAGES = 12;
const DEFAULT_MAX_AGE_MS = 30 * 60_000;

function clean(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function readJson(path) {
  try {
    return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function normalizeMessage(item) {
  const text = clean(item?.text, 1_600);
  const conversationId = clean(item?.conversationId, 200);
  const goalId = clean(item?.goalId, 200);
  const at = clean(item?.at, 80);
  if (!text || !conversationId || !goalId || !at || !Number.isFinite(Date.parse(at))) return null;
  return {
    text,
    at,
    conversationId,
    goalId,
    round: Math.max(1, Math.floor(number(item?.round, 1))),
    kind: clean(item?.kind, 80) || "progress",
    source: clean(item?.source, 80) || "unknown",
    dedupeKey: clean(item?.dedupeKey, 500),
  };
}

function contextActivity(row, fallback = 0) {
  for (const value of [row?.lastBoundaryAt, row?.inFlightStartedAt, row?.heartbeatAt]) {
    const parsed = Date.parse(value || "");
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function uniqueMessages(items) {
  const seenText = new Set();
  const seenKeys = new Set();
  const result = [];
  for (const item of [...items].reverse()) {
    const textKey = String(item.text || "").replace(/\s+/g, " ").trim().toLowerCase();
    const dedupeKey = item.dedupeKey || null;
    if ((dedupeKey && seenKeys.has(dedupeKey)) || (textKey && seenText.has(textKey))) continue;
    if (dedupeKey) seenKeys.add(dedupeKey);
    if (textKey) seenText.add(textKey);
    result.push(item);
  }
  return result.reverse();
}

export function conversationProgressNarrationMap({
  humanProgress,
  goalProgress,
  planState = null,
  goalState = null,
  nowMs = Date.now(),
  maxMessages = DEFAULT_MAX_MESSAGES,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  const rows = activeProgressRows({
    progressState: goalProgress,
    planState,
    goalState,
    nowMs,
    maxConversationAgeMs: maxAgeMs,
  });
  const activeKey = `${goalProgress?.active?.goalId || ""}:${Math.max(1, Math.floor(number(goalProgress?.active?.round, 1)))}`;
  const fallbackActivity = Date.parse(goalProgress?.updatedAt || "") || 0;
  const selectedByConversation = new Map();
  for (const row of rows) {
    const conversationId = clean(row?.conversationId, 200);
    const goalId = clean(row?.goalId, 200);
    const round = Math.max(1, Math.floor(number(row?.round, 1)));
    if (!conversationId || !goalId) continue;
    const key = `${goalId}:${round}`;
    const priority = key === activeKey ? Number.MAX_SAFE_INTEGER : contextActivity(row, fallbackActivity);
    const previous = selectedByConversation.get(conversationId);
    if (!previous || priority >= previous.priority) selectedByConversation.set(conversationId, { row, goalId, round, priority });
  }

  const normalized = (Array.isArray(humanProgress?.messages) ? humanProgress.messages : [])
    .map(normalizeMessage)
    .filter(Boolean)
    .filter((item) => nowMs - Date.parse(item.at) >= -60_000 && nowMs - Date.parse(item.at) <= maxAgeMs)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const result = {};
  for (const [conversationId, context] of selectedByConversation) {
    const messages = uniqueMessages(normalized.filter((item) => (
      item.conversationId === conversationId
      && item.goalId === context.goalId
      && item.round === context.round
    ))).slice(-Math.max(1, Math.min(20, number(maxMessages, DEFAULT_MAX_MESSAGES))));
    if (!messages.length) continue;
    result[conversationId] = {
      conversationId,
      goalId: context.goalId,
      round: context.round,
      progressKind: clean(context.row?.progressKind, 80) || "goal",
      messages,
      updatedAt: messages.at(-1).at,
    };
  }
  return result;
}

function serializeInline(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function buildProgressNarrationScript(map) {
  const serialized = serializeInline(map && typeof map === "object" ? map : {});
  return `(() => {
    const ROOT_ID = ${JSON.stringify(ROOT_ID)};
    const STYLE_ID = ${JSON.stringify(STYLE_ID)};
    const LEASE_KEY = ${JSON.stringify(LEASE_KEY)};
    const LEASE_MS = ${LEASE_MS};
    const conversationId = location.pathname.match(/\\/c\\/([^/?#]+)/)?.[1] || null;
    const state = (${serialized})[conversationId] || null;
    const radios = [...document.querySelectorAll('[role="radio"]')];
    const work = radios.find((el) => /^(工作|Work)$/i.test((el.innerText || el.textContent || '').trim()));
    const mode = work?.getAttribute('aria-checked') === 'true' || /[?&]surface=work(?:&|$)/i.test(location.search) ? 'work' : 'chat';
    const ensureStyle = () => {
      let style = document.getElementById(STYLE_ID);
      if (style) return style;
      style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = \`
#${ROOT_ID}{position:fixed;z-index:44;box-sizing:border-box;pointer-events:auto;overflow:hidden;padding:0;border:1px solid rgba(0,0,0,.10);border-radius:14px;background:rgba(255,255,255,.97);box-shadow:0 8px 26px rgba(0,0,0,.10);font-family:"Söhne",Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#0d0d0d;opacity:1;visibility:visible;transform:translateY(0);transition:opacity 160ms ease,transform 160ms ease,width 160ms ease,max-height 160ms ease}
#${ROOT_ID}[data-visible="false"]{opacity:0;visibility:hidden;pointer-events:none;transform:translateY(4px)}
#${ROOT_ID} .devspace-progress-header{display:flex;align-items:center;gap:8px;min-height:34px;padding:6px 8px 5px 11px;border-bottom:1px solid rgba(0,0,0,.07);user-select:none}
#${ROOT_ID} .devspace-progress-label{min-width:0;flex:1;font-size:10px;line-height:1.35;font-weight:650;letter-spacing:.07em;text-transform:uppercase;color:#6e6e6e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#${ROOT_ID} .devspace-progress-count{font-size:10px;line-height:1;color:#8b8b8b;white-space:nowrap}
#${ROOT_ID} .devspace-progress-actions{display:flex;align-items:center;gap:4px}
#${ROOT_ID} .devspace-progress-button{appearance:none;border:1px solid rgba(0,0,0,.12);border-radius:8px;background:rgba(255,255,255,.74);color:inherit;padding:3px 7px;font:inherit;font-size:11px;line-height:1.2;cursor:pointer;pointer-events:auto}
#${ROOT_ID} .devspace-progress-button:hover{background:rgba(0,0,0,.055)}
#${ROOT_ID} .devspace-progress-button:focus-visible{outline:2px solid #0d6efd;outline-offset:1px}
#${ROOT_ID} .devspace-progress-scroll{box-sizing:border-box;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:0 11px 10px;scroll-behavior:smooth}
#${ROOT_ID} .devspace-progress-message{margin-top:7px;font-size:13px;line-height:1.48;font-weight:400;color:inherit;white-space:normal;overflow-wrap:anywhere}
#${ROOT_ID} .devspace-progress-message+ .devspace-progress-message{padding-top:7px;border-top:1px solid rgba(0,0,0,.07)}
#${ROOT_ID}[data-size="compact"]{border-radius:12px}
#${ROOT_ID}[data-size="compact"] .devspace-progress-header{border-bottom:0;min-height:31px;padding-top:4px;padding-bottom:2px}
#${ROOT_ID}[data-size="compact"] .devspace-progress-scroll{max-height:42px;padding-top:0;padding-bottom:7px;overflow:hidden}
#${ROOT_ID}[data-size="compact"] .devspace-progress-message{margin-top:0;font-size:12px;line-height:1.35;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
#${ROOT_ID}[data-size="normal"] .devspace-progress-scroll{max-height:132px}
#${ROOT_ID}[data-size="expanded"] .devspace-progress-scroll{max-height:min(52vh,520px);padding-bottom:12px}
#${ROOT_ID}[data-size="expanded"] .devspace-progress-message{font-size:13px;line-height:1.55}
html.dark #${ROOT_ID}{color:#f0f0f0;background:rgba(33,33,33,.97);border-color:rgba(255,255,255,.12);box-shadow:0 8px 26px rgba(0,0,0,.28)}
html.dark #${ROOT_ID} .devspace-progress-header,html.dark #${ROOT_ID} .devspace-progress-message+ .devspace-progress-message{border-color:rgba(255,255,255,.09)}
html.dark #${ROOT_ID} .devspace-progress-label{color:#b4b4b4}
html.dark #${ROOT_ID} .devspace-progress-count{color:#969696}
html.dark #${ROOT_ID} .devspace-progress-button{border-color:rgba(255,255,255,.14);background:rgba(255,255,255,.06)}
html.dark #${ROOT_ID} .devspace-progress-button:hover{background:rgba(255,255,255,.12)}
@media (prefers-color-scheme:dark){html:not(.light) #${ROOT_ID}{color:#f0f0f0;background:rgba(33,33,33,.97);border-color:rgba(255,255,255,.12)}html:not(.light) #${ROOT_ID} .devspace-progress-label{color:#b4b4b4}}
@media (max-width:760px){#${ROOT_ID}{left:12px!important;right:12px!important;width:auto!important}#${ROOT_ID}[data-size="normal"] .devspace-progress-scroll{max-height:112px}#${ROOT_ID}[data-size="expanded"] .devspace-progress-scroll{max-height:42vh}#${ROOT_ID} .devspace-progress-message{font-size:12px}}
@media (prefers-reduced-motion:reduce){#${ROOT_ID},#${ROOT_ID} .devspace-progress-scroll{transition:none!important;scroll-behavior:auto!important}}
      \`;
      document.head.appendChild(style);
      return style;
    };
    ensureStyle();
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement('section');
      root.id = ROOT_ID;
      root.setAttribute('role','status');
      root.setAttribute('aria-live','polite');
      root.setAttribute('aria-label','DevSpace progress narration');
      document.body.appendChild(root);
    }
    const messages = Array.isArray(state?.messages) ? state.messages : [];
    const visible = Boolean(conversationId && messages.length);
    root.dataset.visible = visible ? 'true' : 'false';
    root.dataset.conversationId = conversationId || '';
    root.dataset.goalId = state?.goalId || '';
    root.dataset.round = String(state?.round || '');
    root.dataset.mode = mode;
    root.dataset.progressKind = state?.progressKind || '';
    const storageKey = '__devspaceProgressNarrationUiV2:' + (conversationId || 'none');
    const readUiState = () => {
      try {
        const parsed = JSON.parse(localStorage.getItem(storageKey) || '{}');
        const size = ['compact','normal','expanded'].includes(parsed?.size) ? parsed.size : 'normal';
        const previousSize = ['normal','expanded'].includes(parsed?.previousSize) ? parsed.previousSize : 'normal';
        return { size, previousSize };
      } catch { return { size:'normal', previousSize:'normal' }; }
    };
    const saveUiState = (value) => {
      try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch {}
    };
    let uiState = readUiState();
    const position = () => {
      const current = document.getElementById(ROOT_ID);
      if (!current || current.dataset.visible !== 'true') return;
      const composer = document.querySelector('#prompt-textarea');
      const form = composer?.closest('form') || document.querySelector('#thread-bottom-container form');
      const goalStrip = document.querySelector('#devspace-host-overlay-root .devspace-goal-strip[data-visible="true"]');
      const formRect = form?.getBoundingClientRect();
      const goalRect = goalStrip?.getBoundingClientRect();
      const size = current.dataset.size || 'normal';
      const cap = size === 'expanded' ? 720 : size === 'compact' ? 480 : 560;
      if (formRect?.width > 0) {
        const width = Math.max(260, Math.min(Math.round(formRect.width), cap));
        current.style.left = Math.max(12, Math.round(formRect.right - width)) + 'px';
        current.style.width = width + 'px';
        const anchorTop = goalRect?.height > 0 ? goalRect.top : formRect.top;
        current.style.bottom = Math.max(12, Math.round(innerHeight - anchorTop + 8)) + 'px';
      } else {
        current.style.left = size === 'expanded' ? 'max(12px,calc(50vw - 360px))' : 'max(12px,calc(50vw - 280px))';
        current.style.width = size === 'expanded' ? 'min(720px,calc(100vw - 24px))' : 'min(560px,calc(100vw - 24px))';
        current.style.bottom = '72px';
      }
    };
    const ensureStructure = () => {
      let header = root.querySelector('.devspace-progress-header');
      if (header) return;
      root.replaceChildren();
      header = document.createElement('div');
      header.className = 'devspace-progress-header';
      const label = document.createElement('div');
      label.className = 'devspace-progress-label';
      label.textContent = 'DevSpace 進度旁白';
      const count = document.createElement('div');
      count.className = 'devspace-progress-count';
      const actions = document.createElement('div');
      actions.className = 'devspace-progress-actions';
      const expand = document.createElement('button');
      expand.type = 'button';
      expand.className = 'devspace-progress-button';
      expand.dataset.action = 'expand';
      const compact = document.createElement('button');
      compact.type = 'button';
      compact.className = 'devspace-progress-button';
      compact.dataset.action = 'compact';
      actions.append(expand, compact);
      header.append(label, count, actions);
      const scroll = document.createElement('div');
      scroll.className = 'devspace-progress-scroll';
      scroll.setAttribute('tabindex','0');
      scroll.setAttribute('aria-label','進度旁白記錄；可向上捲動查看較早內容');
      root.append(header, scroll);
    };
    const renderMessages = ({ preserveScroll = false } = {}) => {
      ensureStructure();
      const scroll = root.querySelector('.devspace-progress-scroll');
      const previousTop = scroll?.scrollTop || 0;
      const nearBottom = !scroll || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 24;
      const source = Array.isArray(root.__devspaceProgressMessages) ? root.__devspaceProgressMessages : [];
      const selected = root.dataset.size === 'compact' ? source.slice(-1) : source;
      scroll.replaceChildren();
      for (const item of selected) {
        const paragraph = document.createElement('div');
        paragraph.className = 'devspace-progress-message';
        paragraph.textContent = String(item.text || '');
        scroll.appendChild(paragraph);
      }
      const count = root.querySelector('.devspace-progress-count');
      if (count) count.textContent = source.length + ' 段';
      const expand = root.querySelector('[data-action="expand"]');
      const compact = root.querySelector('[data-action="compact"]');
      if (expand) {
        expand.textContent = root.dataset.size === 'expanded' ? '收起' : '展開';
        expand.setAttribute('aria-label', root.dataset.size === 'expanded' ? '收起進度旁白' : '展開更多進度旁白');
      }
      if (compact) {
        compact.textContent = root.dataset.size === 'compact' ? '還原' : '縮小';
        compact.setAttribute('aria-label', root.dataset.size === 'compact' ? '還原進度旁白大小' : '將進度旁白縮成細條');
      }
      requestAnimationFrame(() => {
        if (!scroll) return;
        if (!preserveScroll || nearBottom || root.dataset.size === 'compact') scroll.scrollTop = scroll.scrollHeight;
        else scroll.scrollTop = Math.min(previousTop, Math.max(0, scroll.scrollHeight - scroll.clientHeight));
      });
    };
    const applySize = (size, { persist = true, preserveScroll = false } = {}) => {
      const next = ['compact','normal','expanded'].includes(size) ? size : 'normal';
      root.dataset.size = next;
      root.dataset.appliedSize = next;
      uiState.size = next;
      if (next !== 'compact') uiState.previousSize = next;
      if (persist) saveUiState(uiState);
      renderMessages({ preserveScroll });
      position();
    };
    root.onclick = (event) => {
      const button = event.target?.closest?.('.devspace-progress-button');
      if (!button || !root.contains(button)) return;
      event.preventDefault();
      event.stopPropagation();
      if (button.dataset.action === 'expand') {
        applySize(root.dataset.size === 'expanded' ? 'normal' : 'expanded');
      } else if (button.dataset.action === 'compact') {
        if (root.dataset.size === 'compact') applySize(uiState.previousSize || 'normal');
        else {
          uiState.previousSize = root.dataset.size === 'expanded' ? 'expanded' : 'normal';
          applySize('compact');
        }
      }
    };
    const renderKey = visible ? JSON.stringify(messages.map((item) => [item.dedupeKey || item.at, item.text])) : 'empty';
    root.__devspaceProgressMessages = messages;
    if (root.dataset.renderKey !== renderKey || root.dataset.appliedSize !== uiState.size) {
      applySize(uiState.size, { persist:false, preserveScroll:root.dataset.renderKey === renderKey });
      root.dataset.renderKey = renderKey;
    } else {
      position();
    }
    const previous = globalThis[LEASE_KEY];
    if (previous?.timer) clearTimeout(previous.timer);
    if (visible) {
      const nonce = String(Date.now()) + ':' + Math.random().toString(36).slice(2);
      root.dataset.leaseNonce = nonce;
      const timer = setTimeout(() => {
        const current = document.getElementById(ROOT_ID);
        if (current?.dataset.leaseNonce === nonce) current.dataset.visible = 'false';
      }, LEASE_MS);
      globalThis[LEASE_KEY] = { nonce, timer };
    } else {
      delete globalThis[LEASE_KEY];
    }
    return {
      mounted:Boolean(root),
      visible:root.dataset.visible === 'true',
      conversationId,
      goalId:state?.goalId || null,
      round:state?.round || null,
      mode,
      size:root.dataset.size || 'normal',
      messageCount:messages.length,
      renderedMessageCount:root.querySelectorAll('.devspace-progress-message').length,
      scrollable:Boolean(root.querySelector('.devspace-progress-scroll')),
      controls:root.querySelectorAll('.devspace-progress-button').length,
      text:(root.innerText || root.textContent || '').trim(),
      rootCount:document.querySelectorAll('#' + ROOT_ID).length,
      pageMutationCount:visible ? 1 : 0,
      syntheticUserMessages:0,
    };
  })()`;
}

export function inspectProgressNarrationExpression() {
  return `(() => {
    const root = document.getElementById(${JSON.stringify(ROOT_ID)});
    const rect = root?.getBoundingClientRect();
    const radios = [...document.querySelectorAll('[role="radio"]')];
    const work = radios.find((el) => /^(工作|Work)$/i.test((el.innerText || el.textContent || '').trim()));
    return {
      mounted:Boolean(root),
      visible:Boolean(root && root.dataset.visible === 'true' && getComputedStyle(root).visibility !== 'hidden' && rect?.width > 0 && rect?.height > 0),
      conversationId:location.pathname.match(/\\/c\\/([^/?#]+)/)?.[1] || null,
      goalId:root?.dataset.goalId || null,
      round:root?.dataset.round ? Number(root.dataset.round) : null,
      mode:work?.getAttribute('aria-checked') === 'true' || /[?&]surface=work(?:&|$)/i.test(location.search) ? 'work' : 'chat',
      size:root?.dataset.size || null,
      messageCount:Array.isArray(root?.__devspaceProgressMessages) ? root.__devspaceProgressMessages.length : 0,
      renderedMessageCount:root?.querySelectorAll('.devspace-progress-message').length || 0,
      controls:root?.querySelectorAll('.devspace-progress-button').length || 0,
      scrollable:Boolean(root?.querySelector('.devspace-progress-scroll')),
      scrollTop:root?.querySelector('.devspace-progress-scroll')?.scrollTop || 0,
      scrollHeight:root?.querySelector('.devspace-progress-scroll')?.scrollHeight || 0,
      clientHeight:root?.querySelector('.devspace-progress-scroll')?.clientHeight || 0,
      text:(root?.innerText || root?.textContent || '').trim(),
      rootCount:document.querySelectorAll('#' + ${JSON.stringify(ROOT_ID)}).length,
    };
  })()`;
}

export class ClassicProgressNarrationOverlay {
  constructor({
    contextAdapter,
    humanProgressStatePath,
    goalProgressStatePath,
    planStatePath = null,
    goalStatePath = null,
    pollMs = DEFAULT_POLL_MS,
    now = () => Date.now(),
  } = {}) {
    if (!contextAdapter || typeof contextAdapter.status !== "function" || typeof contextAdapter.evaluateRuntime !== "function") {
      throw new Error("ClassicProgressNarrationOverlay requires the shared Context Guardian CDP adapter.");
    }
    if (!humanProgressStatePath || !goalProgressStatePath) throw new Error("ClassicProgressNarrationOverlay requires both progress state paths.");
    this.contextAdapter = contextAdapter;
    this.humanProgressStatePath = humanProgressStatePath;
    this.goalProgressStatePath = goalProgressStatePath;
    this.planStatePath = planStatePath || null;
    this.goalStatePath = goalStatePath || null;
    this.pollMs = Math.max(250, number(pollMs, DEFAULT_POLL_MS));
    this.now = now;
    this.timer = null;
    this.syncing = null;
    this.closed = false;
    this.last = null;
  }

  async start({ schedule = true } = {}) {
    const result = await this.syncOnce();
    if (schedule && !this.closed && !this.timer) {
      this.timer = setInterval(() => { void this.syncOnce(); }, this.pollMs);
      this.timer.unref?.();
    }
    return result;
  }

  async syncOnce() {
    if (this.closed) return this.last;
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      const [humanProgress, goalProgress, planState, goalState] = await Promise.all([
        readJson(this.humanProgressStatePath),
        readJson(this.goalProgressStatePath),
        this.planStatePath ? readJson(this.planStatePath) : Promise.resolve(null),
        this.goalStatePath ? readJson(this.goalStatePath) : Promise.resolve(null),
      ]);
      const map = conversationProgressNarrationMap({ humanProgress, goalProgress, planState, goalState, nowMs: this.now() });
      const script = buildProgressNarrationScript(map);
      const runtimes = this.contextAdapter.status()?.runtimes || [];
      const settled = await Promise.allSettled(runtimes.map(async (runtime) => ({
        runtimeKey: runtime.runtimeKey,
        port: runtime.port,
        result: await this.contextAdapter.evaluateRuntime(runtime.runtimeKey, script),
      })));
      const results = settled.map((entry, index) => entry.status === "fulfilled"
        ? { ok: true, ...entry.value }
        : {
            ok: false,
            runtimeKey: runtimes[index]?.runtimeKey || null,
            port: runtimes[index]?.port || null,
            error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
          });
      this.last = {
        ok: results.every((item) => item.ok),
        conversations: Object.keys(map).length,
        connected: runtimes.length,
        synced: results.filter((item) => item.ok).length,
        results,
      };
      return this.last;
    })().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  async inspect(runtimeKey) {
    return await this.contextAdapter.evaluateRuntime(runtimeKey, inspectProgressNarrationExpression());
  }

  status() {
    return {
      running: Boolean(this.timer),
      pollInProgress: Boolean(this.syncing),
      pollMs: this.pollMs,
      last: this.last,
      runtimes: (this.contextAdapter.status()?.runtimes || []).map((runtime) => ({
        runtimeKey: runtime.runtimeKey || runtimeKeyForPort(runtime.port),
        port: runtime.port,
      })),
    };
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.syncing?.catch?.(() => {});
    const script = buildProgressNarrationScript({});
    const runtimes = this.contextAdapter.status()?.runtimes || [];
    await Promise.allSettled(runtimes.map((runtime) => this.contextAdapter.evaluateRuntime(runtime.runtimeKey, script)));
  }
}

export { ROOT_ID as PROGRESS_NARRATION_ROOT_ID };
