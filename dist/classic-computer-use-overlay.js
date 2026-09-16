import { randomUUID } from "node:crypto";

const ROOT_ID = "devspace-computer-use-overlay-root";
const STYLE_ID = "devspace-computer-use-overlay-style";
const LEASE_KEY = "__devspaceComputerUseOverlayLeaseV1";
const CONTROLLER_KEY = "__devspaceComputerUseOverlayControllerV1";
const UI_VERSION = "1";
const LEASE_MS = 15_000;
const DEFAULT_IDLE_GRACE_MS = 10_000;
const DEFAULT_MAX_SESSION_MS = 130_000;

function clean(value, max = 500) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function cleanConversationId(value) {
  const text = clean(value, 200);
  return text && /^[A-Za-z0-9_-]{8,200}$/.test(text) ? text : null;
}

function cleanRuntimeKey(value) {
  const text = clean(value, 80)?.toLowerCase();
  return text && /^main-\d{2}$/.test(text) ? text : null;
}

function appLabel(value) {
  const text = clean(value, 4096);
  if (!text) return "Windows";
  if (/^process:/i.test(text)) {
    const path = text.slice(text.indexOf(":") + 1).replaceAll("/", "\\");
    const filename = path.split("\\").filter(Boolean).at(-1) || text;
    return filename.replace(/\.exe$/i, "") || "Windows app";
  }
  if (text.includes("!") && text.includes("_")) {
    const packageName = text.split("!")[0].split("_")[0].split(".").at(-1);
    return clean(packageName, 80) || "Windows app";
  }
  return clean(text, 80) || "Windows app";
}

function actionLabel(action) {
  switch (String(action || "")) {
    case "list_apps":
    case "list_windows":
      return "正在讀取可用視窗";
    case "get_window":
    case "get_window_state":
      return "正在查看視窗";
    case "launch_app":
      return "正在開啟應用程式";
    case "activate_window":
      return "正在切換視窗";
    case "click":
      return "正在點擊";
    case "press_key":
    case "type_text":
    case "set_value":
      return "正在輸入";
    case "scroll":
      return "正在捲動";
    case "drag":
      return "正在拖曳";
    case "perform_secondary_action":
      return "正在執行視窗操作";
    default:
      return "正在使用視窗";
  }
}

function serializeInline(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function publicRecord(record, extra = {}) {
  return {
    conversationId: record.conversationId,
    runtimeKey: record.runtimeKey || null,
    operationId: record.operationId,
    app: record.app,
    appLabel: record.appLabel,
    action: record.action,
    activeCount: record.activeCount,
    startedAt: new Date(record.startedAtMs).toISOString(),
    updatedAt: new Date(record.updatedAtMs).toISOString(),
    expiresAt: new Date(record.expiresAtMs).toISOString(),
    ...extra,
  };
}

export function buildComputerUseOverlayScript(record, {
  producerId = "devspace-computer-use",
  producerPriority = 0,
} = {}) {
  const state = {
    conversationId: cleanConversationId(record?.conversationId),
    operationId: clean(record?.operationId, 200),
    app: clean(record?.app, 4096) || "Windows",
    appLabel: clean(record?.appLabel, 120) || appLabel(record?.app),
    action: clean(record?.action, 80) || "computer-use",
    actionLabel: actionLabel(record?.action),
    startedAt: clean(record?.startedAt, 80) || new Date().toISOString(),
    expiresAt: clean(record?.expiresAt, 80) || new Date(Date.now() + DEFAULT_MAX_SESSION_MS).toISOString(),
  };
  const serialized = serializeInline(state);
  return `(() => {
    const state = ${serialized};
    const ROOT_ID = ${JSON.stringify(ROOT_ID)};
    const STYLE_ID = ${JSON.stringify(STYLE_ID)};
    const LEASE_KEY = ${JSON.stringify(LEASE_KEY)};
    const CONTROLLER_KEY = ${JSON.stringify(CONTROLLER_KEY)};
    const UI_VERSION = ${JSON.stringify(UI_VERSION)};
    const LEASE_MS = ${LEASE_MS};
    const PRODUCER_ID = ${JSON.stringify(String(producerId || "devspace-computer-use"))};
    const PRODUCER_PRIORITY = ${Math.max(0, Number(producerPriority) || 0)};
    const actual = location.pathname.match(/\\/c\\/([^/?#]+)/)?.[1] || null;
    if (!state.conversationId || actual !== state.conversationId) {
      return { ok:false, state:'route-changed', conversationId:actual };
    }
    const now = Date.now();
    const prior = globalThis[LEASE_KEY];
    const competingProducerWins = prior
      && prior.ownerId !== PRODUCER_ID
      && now - Number(prior.lastSeenAt || 0) < LEASE_MS
      && Number(prior.priority || 0) > PRODUCER_PRIORITY;
    if (competingProducerWins) {
      return {
        ok:false,
        state:'suppressed-by-producer-lease',
        conversationId:actual,
        ownerProducerPriority:Number(prior.priority || 0),
        pageMutationCount:0,
      };
    }
    globalThis[LEASE_KEY] = {
      ownerId:PRODUCER_ID,
      priority:PRODUCER_PRIORITY,
      lastSeenAt:now,
    };
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = \`
#${ROOT_ID}{position:fixed;inset:0;z-index:41;pointer-events:none;box-sizing:border-box;background:rgba(37,99,235,.16);font-family:"Söhne",Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#0f172a}
#${ROOT_ID} .devspace-computer-use-banner{position:absolute;top:14px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;max-width:min(720px,calc(100vw - 28px));padding:10px 14px;border:1px solid rgba(37,99,235,.40);border-radius:14px;background:rgba(239,246,255,.98);box-shadow:0 12px 36px rgba(30,64,175,.20);white-space:nowrap;overflow:hidden}
#${ROOT_ID} .devspace-computer-use-dot{width:10px;height:10px;flex:0 0 auto;border-radius:999px;background:#2563eb;box-shadow:0 0 0 4px rgba(37,99,235,.14)}
#${ROOT_ID} .devspace-computer-use-copy{min-width:0;display:flex;flex-direction:column;gap:1px}
#${ROOT_ID} .devspace-computer-use-title{overflow:hidden;text-overflow:ellipsis;font-size:13px;line-height:1.35;font-weight:650;color:#0f172a}
#${ROOT_ID} .devspace-computer-use-meta{overflow:hidden;text-overflow:ellipsis;font-size:11px;line-height:1.35;font-weight:500;color:#1d4ed8}
#${ROOT_ID} .devspace-computer-use-boundary{margin-left:4px;flex:0 0 auto;padding-left:10px;border-left:1px solid rgba(37,99,235,.22);font-size:10px;line-height:1.35;font-weight:550;color:#475569}
@media (max-width:680px){#${ROOT_ID} .devspace-computer-use-banner{top:8px;padding:9px 11px}.devspace-computer-use-boundary{display:none}}
@media (prefers-contrast:more){#${ROOT_ID}{background:rgba(37,99,235,.22)}#${ROOT_ID} .devspace-computer-use-banner{border-color:#1d4ed8}}
\`;
      document.head.appendChild(style);
    }
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;
      root.setAttribute('aria-live','polite');
      root.setAttribute('role','status');
      root.innerHTML = '<div class="devspace-computer-use-banner"><span class="devspace-computer-use-dot" aria-hidden="true"></span><span class="devspace-computer-use-copy"><span class="devspace-computer-use-title"></span><span class="devspace-computer-use-meta"></span></span><span class="devspace-computer-use-boundary">只限目前對話</span></div>';
      document.body.appendChild(root);
    }
    root.dataset.uiVersion = UI_VERSION;
    root.dataset.conversationId = state.conversationId;
    root.dataset.operationId = state.operationId;
    root.dataset.app = state.app;
    root.dataset.action = state.action;
    root.dataset.visible = 'true';
    root.querySelector('.devspace-computer-use-title').textContent = 'Computer Use 正在使用你的電腦';
    root.querySelector('.devspace-computer-use-meta').textContent = state.actionLabel + ' · ' + state.appLabel + ' · OpenAI @oai/sky';
    const priorController = globalThis[CONTROLLER_KEY];
    if (priorController?.timer) clearTimeout(priorController.timer);
    const expiresAtMs = Date.parse(state.expiresAt);
    const timer = setTimeout(() => {
      const current = document.getElementById(ROOT_ID);
      if (current?.dataset?.operationId === state.operationId) current.remove();
      const lease = globalThis[LEASE_KEY];
      if (lease?.ownerId === PRODUCER_ID) delete globalThis[LEASE_KEY];
      if (globalThis[CONTROLLER_KEY]?.operationId === state.operationId) delete globalThis[CONTROLLER_KEY];
    }, Math.max(1_000, Number.isFinite(expiresAtMs) ? expiresAtMs - Date.now() : ${DEFAULT_MAX_SESSION_MS}));
    globalThis[CONTROLLER_KEY] = { operationId:state.operationId, timer };
    return {
      ok:true,
      mounted:true,
      visible:true,
      conversationId:actual,
      operationId:state.operationId,
      app:state.app,
      appLabel:state.appLabel,
      action:state.action,
      rootCount:document.querySelectorAll('#' + ROOT_ID).length,
      producerId:PRODUCER_ID,
      producerPriority:PRODUCER_PRIORITY,
      pageMutationCount:1,
    };
  })()`;
}

export function clearComputerUseOverlayScript(record, {
  producerId = "devspace-computer-use",
} = {}) {
  const conversationId = cleanConversationId(record?.conversationId);
  const operationId = clean(record?.operationId, 200);
  return `(() => {
    const ROOT_ID = ${JSON.stringify(ROOT_ID)};
    const LEASE_KEY = ${JSON.stringify(LEASE_KEY)};
    const CONTROLLER_KEY = ${JSON.stringify(CONTROLLER_KEY)};
    const PRODUCER_ID = ${JSON.stringify(String(producerId || "devspace-computer-use"))};
    const expected = ${JSON.stringify(conversationId)};
    const operationId = ${JSON.stringify(operationId)};
    const actual = location.pathname.match(/\\/c\\/([^/?#]+)/)?.[1] || null;
    if (!expected || actual !== expected) return { ok:false, state:'route-changed', conversationId:actual };
    const root = document.getElementById(ROOT_ID);
    if (root && (!operationId || root.dataset.operationId === operationId)) root.remove();
    const controller = globalThis[CONTROLLER_KEY];
    if (controller?.operationId === operationId) {
      if (controller.timer) clearTimeout(controller.timer);
      delete globalThis[CONTROLLER_KEY];
    }
    const lease = globalThis[LEASE_KEY];
    if (lease?.ownerId === PRODUCER_ID) delete globalThis[LEASE_KEY];
    return {
      ok:true,
      cleared:true,
      conversationId:actual,
      operationId,
      rootCount:document.querySelectorAll('#' + ROOT_ID).length,
    };
  })()`;
}

export function inspectComputerUseOverlayExpression() {
  return `(() => {
    const root = document.getElementById(${JSON.stringify(ROOT_ID)});
    const rect = root?.getBoundingClientRect();
    return {
      mounted:Boolean(root),
      visible:Boolean(root && root.dataset.visible === 'true' && rect?.width > 0 && rect?.height > 0),
      conversationId:root?.dataset?.conversationId || null,
      operationId:root?.dataset?.operationId || null,
      app:root?.dataset?.app || null,
      action:root?.dataset?.action || null,
      uiVersion:root?.dataset?.uiVersion || null,
      rootCount:document.querySelectorAll('#' + ${JSON.stringify(ROOT_ID)}).length,
      text:(root?.innerText || root?.textContent || '').trim(),
    };
  })()`;
}

export class ClassicComputerUseOverlay {
  constructor({
    adapter,
    producerId = randomUUID(),
    producerPriority = 0,
    idleGraceMs = DEFAULT_IDLE_GRACE_MS,
    maxSessionMs = DEFAULT_MAX_SESSION_MS,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    if (!adapter || typeof adapter.find !== "function" || typeof adapter.connect !== "function") {
      throw new Error("ClassicComputerUseOverlay requires the exact-conversation CDP adapter.");
    }
    this.adapter = adapter;
    this.producerId = String(producerId || randomUUID());
    this.producerPriority = Math.max(0, Math.floor(Number(producerPriority) || 0));
    this.idleGraceMs = Math.max(1_000, Number(idleGraceMs) || DEFAULT_IDLE_GRACE_MS);
    this.maxSessionMs = Math.max(this.idleGraceMs + 1_000, Number(maxSessionMs) || DEFAULT_MAX_SESSION_MS);
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.records = new Map();
    this.closed = false;
  }

  async begin({ conversationId, runtimeKey = null, app = null, action = "computer-use", timeoutMs = 30_000 } = {}) {
    if (this.closed) return { ok: false, state: "overlay-closed" };
    const id = cleanConversationId(conversationId);
    if (!id) return { ok: false, state: "invalid-conversation" };
    const nowMs = Number(this.now());
    let record = this.records.get(id) || null;
    if (!record || nowMs >= record.expiresAtMs) {
      if (record) await this.#dispose(record).catch(() => {});
      record = {
        conversationId: id,
        runtimeKey: cleanRuntimeKey(runtimeKey),
        operationId: randomUUID(),
        app: clean(app, 4096) || "Windows",
        appLabel: appLabel(app),
        action: clean(action, 80) || "computer-use",
        activeCount: 0,
        startedAtMs: nowMs,
        updatedAtMs: nowMs,
        expiresAtMs: nowMs + this.maxSessionMs,
        idleTimer: null,
        expiryTimer: null,
      };
      this.records.set(id, record);
    }
    if (record.idleTimer) this.clearTimer(record.idleTimer);
    record.idleTimer = null;
    record.runtimeKey = cleanRuntimeKey(runtimeKey) || record.runtimeKey;
    record.app = clean(app, 4096) || record.app || "Windows";
    record.appLabel = appLabel(record.app);
    record.action = clean(action, 80) || record.action || "computer-use";
    record.activeCount += 1;
    record.updatedAtMs = nowMs;
    const requestedLifetime = Math.max(5_000, Math.min(this.maxSessionMs, Number(timeoutMs) + this.idleGraceMs));
    record.expiresAtMs = Math.min(record.startedAtMs + this.maxSessionMs, Math.max(record.expiresAtMs, nowMs + requestedLifetime));
    this.#scheduleExpiry(record);
    const projected = await this.#project(record).catch((error) => ({
      ok: false,
      state: "overlay-projection-failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    return publicRecord(record, { overlay: projected });
  }

  async end({ conversationId, operationId, state = "completed" } = {}) {
    const id = cleanConversationId(conversationId);
    const record = id ? this.records.get(id) : null;
    if (!record || (operationId && record.operationId !== operationId)) {
      return { ok: false, state: "overlay-session-not-found" };
    }
    record.activeCount = Math.max(0, record.activeCount - 1);
    record.updatedAtMs = Number(this.now());
    record.lastState = clean(state, 80) || "completed";
    if (record.activeCount > 0) return publicRecord(record, { ok: true, state: "still-active" });
    if (record.idleTimer) this.clearTimer(record.idleTimer);
    record.idleTimer = this.setTimer(() => {
      void this.#dispose(record).catch(() => {});
    }, this.idleGraceMs);
    record.idleTimer?.unref?.();
    return publicRecord(record, {
      ok: true,
      state: "idle-clear-scheduled",
      clearAfterMs: this.idleGraceMs,
    });
  }

  async inspect({ conversationId } = {}) {
    const id = cleanConversationId(conversationId);
    if (!id) return { ok: false, state: "invalid-conversation" };
    const located = await this.adapter.find({ conversationId: id });
    if (!located?.exact || located?.ambiguous || !located?.target?.webSocketDebuggerUrl) {
      return { ok: false, state: located?.state || "conversation-page-not-open" };
    }
    const page = await this.adapter.connect(located.target);
    try {
      return await page.evaluate(inspectComputerUseOverlayExpression());
    } finally {
      page.close();
    }
  }

  status() {
    return {
      ok: true,
      activeConversations: [...this.records.values()].map((record) => publicRecord(record)),
      producerId: this.producerId,
      producerPriority: this.producerPriority,
      idleGraceMs: this.idleGraceMs,
      maxSessionMs: this.maxSessionMs,
      crossConversationSharing: false,
    };
  }

  async close() {
    this.closed = true;
    const records = [...this.records.values()];
    await Promise.all(records.map((record) => this.#dispose(record).catch(() => null)));
    this.records.clear();
  }

  #scheduleExpiry(record) {
    if (record.expiryTimer) this.clearTimer(record.expiryTimer);
    const delay = Math.max(1_000, record.expiresAtMs - Number(this.now()));
    record.expiryTimer = this.setTimer(() => {
      void this.#dispose(record).catch(() => {});
    }, delay);
    record.expiryTimer?.unref?.();
  }

  async #project(record) {
    const located = await this.adapter.find({ conversationId: record.conversationId });
    if (!located?.exact || located?.ambiguous || located.conversationId !== record.conversationId || !located?.target?.webSocketDebuggerUrl) {
      return { ok: false, state: located?.state || "conversation-page-not-open" };
    }
    if (record.runtimeKey && located.runtimeKey !== record.runtimeKey) {
      return { ok: false, state: "runtime-locator-changed" };
    }
    const page = await this.adapter.connect(located.target);
    try {
      return await page.evaluate(buildComputerUseOverlayScript({
        ...record,
        startedAt: new Date(record.startedAtMs).toISOString(),
        expiresAt: new Date(record.expiresAtMs).toISOString(),
      }, {
        producerId: this.producerId,
        producerPriority: this.producerPriority,
      }));
    } finally {
      page.close();
    }
  }

  async #dispose(record) {
    if (!record) return;
    if (record.idleTimer) this.clearTimer(record.idleTimer);
    if (record.expiryTimer) this.clearTimer(record.expiryTimer);
    record.idleTimer = null;
    record.expiryTimer = null;
    if (this.records.get(record.conversationId) === record) this.records.delete(record.conversationId);
    const located = await this.adapter.find({ conversationId: record.conversationId });
    if (!located?.exact || located?.ambiguous || !located?.target?.webSocketDebuggerUrl) return;
    const page = await this.adapter.connect(located.target);
    try {
      await page.evaluate(clearComputerUseOverlayScript(record, { producerId: this.producerId }));
    } finally {
      page.close();
    }
  }
}

export const classicComputerUseOverlayInternals = {
  ROOT_ID,
  STYLE_ID,
  LEASE_KEY,
  CONTROLLER_KEY,
  UI_VERSION,
  appLabel,
  actionLabel,
  cleanConversationId,
  cleanRuntimeKey,
};
