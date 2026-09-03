const SETTINGS_KEY = "devspaceBrowserControlSettings";
const SHARED_TABS_KEY = "devspaceBrowserControlSharedTabs";
const MANAGED_TABS_KEY = "devspaceBrowserControlManagedTabs";
const BROWSER_SESSION_KEY = "devspaceBrowserControlSessionId";
const TAB_INSTANCE_KEYS = "devspaceBrowserControlTabInstanceKeys";
const LOOP_WAIT_MS = 20_000;
const MAX_RING = 400;

const attachedTabs = new Set();
const claimedTabUi = new Map();
const consoleEvents = new Map();
const networkEvents = new Map();
const downloadEvents = new Map();
let loopGeneration = 0;
let syncTimer;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();

function ringPush(map, key, value) {
  let items = map.get(key);
  if (!items) {
    items = [];
    map.set(key, items);
  }
  items.push(value);
  if (items.length > MAX_RING) items.splice(0, items.length - MAX_RING);
}

async function getSettings() {
  const data = await chrome.storage.local.get([SETTINGS_KEY, SHARED_TABS_KEY, MANAGED_TABS_KEY]);
  return {
    settings: data[SETTINGS_KEY] || {},
    sharedTabs: new Set(Array.isArray(data[SHARED_TABS_KEY]) ? data[SHARED_TABS_KEY].map(Number) : []),
    managedTabs: new Set(Array.isArray(data[MANAGED_TABS_KEY]) ? data[MANAGED_TABS_KEY].map(Number) : []),
  };
}

async function setSettings(settings) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

async function getBrowserSessionId() {
  const data = await chrome.storage.session.get([BROWSER_SESSION_KEY]);
  let id = data[BROWSER_SESSION_KEY];
  if (!id) {
    id = crypto.randomUUID();
    await chrome.storage.session.set({ [BROWSER_SESSION_KEY]: id });
  }
  return id;
}

async function getTabInstanceKey(tabId) {
  const data = await chrome.storage.session.get([TAB_INSTANCE_KEYS]);
  const keys = data[TAB_INSTANCE_KEYS] && typeof data[TAB_INSTANCE_KEYS] === "object" ? data[TAB_INSTANCE_KEYS] : {};
  const id = String(tabId);
  if (!keys[id]) {
    keys[id] = crypto.randomUUID();
    await chrome.storage.session.set({ [TAB_INSTANCE_KEYS]: keys });
  }
  return keys[id];
}

async function forgetTabInstanceKey(tabId) {
  const data = await chrome.storage.session.get([TAB_INSTANCE_KEYS]);
  const keys = data[TAB_INSTANCE_KEYS] && typeof data[TAB_INSTANCE_KEYS] === "object" ? data[TAB_INSTANCE_KEYS] : {};
  delete keys[String(tabId)];
  await chrome.storage.session.set({ [TAB_INSTANCE_KEYS]: keys });
}

async function persistTabSets(sharedTabs, managedTabs) {
  await chrome.storage.local.set({
    [SHARED_TABS_KEY]: [...sharedTabs].filter(Number.isInteger),
    [MANAGED_TABS_KEY]: [...managedTabs].filter(Number.isInteger),
  });
}

function normalizeEndpoint(value) {
  const candidate = String(value || "http://127.0.0.1:7676").trim().replace(/\/+$/, "");
  const parsed = new URL(candidate);
  const localHosts = new Set(["127.0.0.1", "[::1]", "::1"]);
  const allowedPorts = new Set(["7676", ""]);
  if (!["http:", "https:"].includes(parsed.protocol) || !localHosts.has(parsed.hostname) || !allowedPorts.has(parsed.port)) {
    throw new Error("Bridge endpoint must use localhost/127.0.0.1. DevSpace Browser Control is local-first.");
  }
  return parsed.toString().replace(/\/$/, "");
}

function controllableUrl(url) {
  const value = String(url || "");
  return value === "about:blank" || /^https?:/i.test(value);
}

async function capabilities(settings) {
  let browserVersion;
  let platform;
  try {
    browserVersion = navigator.userAgent.match(/(?:Chrome|Chromium)\/([0-9.]+)/)?.[1];
    platform = navigator.platform || navigator.userAgentData?.platform;
  } catch {}
  return {
    debugger: true,
    accessibility: true,
    screenshots: true,
    network: true,
    console: true,
    downloads: true,
    developerMode: Boolean(settings.developerMode),
    accessMode: settings.accessMode === "all" ? "all" : "selected",
    browserName: "Chrome/Chromium",
    browserVersion,
    platform,
  };
}

async function apiFetch(path, options = {}, auth = true) {
  const { settings } = await getSettings();
  if (!settings.endpoint) throw new Error("DevSpace Browser Control is not configured.");
  const headers = new Headers(options.headers || {});
  if (auth) {
    if (!settings.bridgeToken) throw new Error("Browser Control Bridge is not paired.");
    headers.set("X-DevSpace-Browser-Token", settings.bridgeToken);
  }
  const response = await fetch(`${settings.endpoint}${path}`, {
    ...options,
    headers,
    cache: "no-store",
  });
  let body;
  try { body = await response.json(); }
  catch { body = {}; }
  if (!response.ok) {
    const error = new Error(body?.error || `${path} HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function serializeTab(tab, sharedTabs, managedTabs, accessMode) {
  const shared = accessMode === "all" ? controllableUrl(tab.url) : sharedTabs.has(tab.id) || managedTabs.has(tab.id);
  const tabInstanceKey = Number.isInteger(tab.id) ? await getTabInstanceKey(tab.id) : undefined;
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url || "",
    title: tab.title || "",
    active: Boolean(tab.active),
    pinned: Boolean(tab.pinned),
    audible: Boolean(tab.audible),
    discarded: Boolean(tab.discarded),
    status: tab.status,
    shared,
    managed: managedTabs.has(tab.id),
    controllable: shared && controllableUrl(tab.url),
    debuggerAttached: attachedTabs.has(tab.id),
    tabInstanceKey,
  };
}

async function sharedTabSnapshot() {
  const { settings, sharedTabs, managedTabs } = await getSettings();
  const accessMode = settings.accessMode === "all" ? "all" : "selected";
  const tabs = await chrome.tabs.query({});
  const serialized = [];
  const liveIds = new Set(tabs.map((tab) => tab.id).filter(Number.isInteger));
  let setsChanged = false;
  for (const id of [...sharedTabs]) {
    if (!liveIds.has(id)) { sharedTabs.delete(id); setsChanged = true; }
  }
  for (const id of [...managedTabs]) {
    if (!liveIds.has(id)) { managedTabs.delete(id); setsChanged = true; }
  }
  if (setsChanged) await persistTabSets(sharedTabs, managedTabs);
  for (const tab of tabs) {
    const item = await serializeTab(tab, sharedTabs, managedTabs, accessMode);
    if (item.shared && item.controllable) serialized.push(item);
  }
  return serialized;
}

async function syncTabs() {
  const { settings } = await getSettings();
  if (!settings.bridgeToken) return;
  const tabs = await sharedTabSnapshot();
  await apiFetch("/browser-control/bridge/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      label: settings.label || "Chrome",
      capabilities: await capabilities(settings),
      browserSessionId: await getBrowserSessionId(),
      tabs,
    }),
  });
}

function scheduleSync(delay = 120) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void syncTabs().catch(() => {}), delay);
}

async function pairBridge({ endpoint, pairCode, label, accessMode, developerMode }) {
  const normalizedEndpoint = normalizeEndpoint(endpoint);
  const current = (await chrome.storage.local.get([SETTINGS_KEY]))[SETTINGS_KEY] || {};
  if (current.bridgeToken && current.endpoint) {
    try {
      await fetch(`${String(current.endpoint).replace(/\/+$/, "")}/browser-control/bridge/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-DevSpace-Browser-Token": current.bridgeToken,
        },
        body: JSON.stringify({ label: current.label || "Chrome", tabs: [] }),
        cache: "no-store",
      });
    } catch {}
  }
  for (const tabId of [...attachedTabs]) {
    try { await chrome.debugger.detach({ tabId }); } catch {}
  }
  attachedTabs.clear();
  const instanceKey = current.instanceKey || crypto.randomUUID();
  const provisional = {
    ...current,
    endpoint: normalizedEndpoint,
    label: String(label || "Chrome").trim().slice(0, 80) || "Chrome",
    accessMode: accessMode === "all" ? "all" : "selected",
    developerMode: Boolean(developerMode),
    instanceKey,
  };
  await setSettings(provisional);
  const response = await apiFetch("/browser-control/bridge/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: String(pairCode || "").trim().toUpperCase(),
      instanceKey,
      label: provisional.label,
      capabilities: await capabilities(provisional),
      browserSessionId: await getBrowserSessionId(),
    }),
  }, false);
  const settings = {
    ...provisional,
    bridgeId: response.bridgeId,
    bridgeToken: response.bridgeToken,
    pairedAt: nowIso(),
  };
  await setSettings(settings);
  startBridgeLoop();
  await syncTabs();
  return { ok: true, bridgeId: settings.bridgeId, label: settings.label, endpoint: settings.endpoint };
}

async function disconnectBridge() {
  loopGeneration += 1;
  const { settings } = await getSettings();
  if (settings.bridgeToken) {
    try {
      await apiFetch("/browser-control/bridge/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: settings.label || "Chrome", tabs: [] }),
      });
    } catch {}
  }
  for (const tabId of [...attachedTabs]) {
    try { await chrome.debugger.detach({ tabId }); } catch {}
  }
  attachedTabs.clear();
  await setSettings({
    endpoint: settings.endpoint || "http://127.0.0.1:7676",
    label: settings.label || "Chrome",
    accessMode: settings.accessMode || "selected",
    developerMode: Boolean(settings.developerMode),
    instanceKey: settings.instanceKey || crypto.randomUUID(),
  });
  return { ok: true };
}

async function shareCurrentTab(shared = true) {
  const { settings, sharedTabs, managedTabs } = await getSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active Chrome tab.");
  if (!controllableUrl(tab.url)) throw new Error("This Chrome page cannot be controlled. Open an http(s) or about:blank page.");
  if (shared) {
    sharedTabs.add(tab.id);
  } else {
    sharedTabs.delete(tab.id);
    managedTabs.delete(tab.id);
  }
  await persistTabSets(sharedTabs, managedTabs);
  if (settings.bridgeToken) await syncTabs();
  return { ok: true, tabId: tab.id, shared };
}

async function updatePreferences({ accessMode, developerMode, label }) {
  const { settings } = await getSettings();
  const next = {
    ...settings,
    accessMode: accessMode === "all" ? "all" : "selected",
    developerMode: Boolean(developerMode),
    label: String(label || settings.label || "Chrome").trim().slice(0, 80) || "Chrome",
  };
  await setSettings(next);
  if (next.bridgeToken) await syncTabs();
  return { ok: true };
}

async function attachTab(tabId) {
  if (attachedTabs.has(tabId)) return { attached: true, duplicate: true };
  let attachedVersion;
  let lastError;
  for (const version of ["1.3", "1.2", "0.1"]) {
    try {
      await chrome.debugger.attach({ tabId }, version);
      attachedVersion = version;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!attachedVersion) throw lastError || new Error("Chrome debugger attach failed.");
  attachedTabs.add(tabId);
  const commands = [
    ["Page.enable", {}],
    ["Runtime.enable", {}],
    ["Log.enable", {}],
    ["Network.enable", { maxTotalBufferSize: 5_000_000, maxResourceBufferSize: 1_000_000 }],
    ["Accessibility.enable", {}],
    ["DOM.enable", { includeWhitespace: "none" }],
  ];
  for (const [method, params] of commands) {
    try { await chrome.debugger.sendCommand({ tabId }, method, params); } catch {}
  }
  scheduleSync();
  return { attached: true, duplicate: false, protocolVersion: attachedVersion };
}

async function detachTab(tabId) {
  await removeAgentControlUi(tabId);
  if (!attachedTabs.has(tabId)) return { detached: true, duplicate: true };
  try { await chrome.debugger.detach({ tabId }); } catch {}
  attachedTabs.delete(tabId);
  scheduleSync();
  return { detached: true, duplicate: false };
}

async function tabMetadata(tabId) {
  const { settings, sharedTabs, managedTabs } = await getSettings();
  const tab = await chrome.tabs.get(tabId);
  return await serializeTab(tab, sharedTabs, managedTabs, settings.accessMode === "all" ? "all" : "selected");
}

function cdp(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function ensureAgentControlUi(tabId, ownerLabel = "agent", actionLabel = "READY") {
  claimedTabUi.set(tabId, { ownerLabel: String(ownerLabel || "agent").slice(0, 120), actionLabel: String(actionLabel || "READY").slice(0, 80) });
  const expression = `(() => {
    const ROOT = '__devspace_ultra_agent_control__';
    let root = document.getElementById(ROOT);
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT;
      root.setAttribute('aria-hidden', 'true');
      root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:Segoe UI,Arial,sans-serif;color:#fff;';

      const banner = document.createElement('div');
      banner.id = ROOT + '_banner';
      banner.style.cssText = 'position:absolute;right:18px;bottom:18px;height:38px;max-width:min(460px,calc(100vw - 36px));display:flex;align-items:center;gap:9px;padding:0 11px;border-radius:11px;background:rgba(17,17,17,.92);border:1px solid rgba(255,255,255,.16);box-shadow:0 8px 22px rgba(0,0,0,.16);backdrop-filter:blur(8px);white-space:nowrap;';
      banner.innerHTML = '<span style="width:7px;height:7px;border-radius:50%;background:#38bdf8;box-shadow:0 0 0 3px rgba(56,189,248,.14)"></span><span id="' + ROOT + '_claim" style="font-size:11px;font-weight:800;letter-spacing:.035em">AGENT CLAIMED THIS TAB</span><span style="width:1px;height:16px;background:rgba(255,255,255,.18)"></span><span id="' + ROOT + '_owner" style="max-width:150px;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:#d6d6d6"></span><span id="' + ROOT + '_action" style="margin-left:auto;padding:3px 6px;border-radius:6px;background:rgba(255,255,255,.09);font-size:10px;font-weight:750;color:#a5dcff;letter-spacing:.035em"></span>';

      const cursor = document.createElement('div');
      cursor.id = ROOT + '_cursor';
      cursor.dataset.x = '24';
      cursor.dataset.y = '84';
      cursor.style.cssText = 'position:absolute;left:0;top:0;width:30px;height:38px;transform:translate3d(24px,84px,0);filter:drop-shadow(0 1px 1px rgba(255,255,255,.95)) drop-shadow(0 3px 7px rgba(0,0,0,.32));will-change:transform;';
      cursor.innerHTML = '<svg viewBox="0 0 30 38" width="30" height="38" xmlns="http://www.w3.org/2000/svg"><path d="M3 2 L26.5 21.5 L16.7 23.5 L22.1 34.8 L16.7 37 L11.4 25.5 L4.2 31.5 Z" fill="#050505" stroke="#ffffff" stroke-width="1.9" stroke-linejoin="round"/></svg>';

      const pulse = document.createElement('div');
      pulse.id = ROOT + '_pulse';
      pulse.style.cssText = 'position:absolute;width:34px;height:34px;border:2px solid rgba(17,17,17,.86);box-shadow:0 0 0 2px rgba(255,255,255,.7);border-radius:50%;opacity:0;transform:translate(-50%,-50%) scale(.42);will-change:transform,opacity;';

      root.appendChild(banner);
      root.appendChild(pulse);
      root.appendChild(cursor);
      (document.body || document.documentElement).appendChild(root);
    }
    const owner = ${JSON.stringify(String(ownerLabel || "agent").slice(0,120))};
    const action = ${JSON.stringify(String(actionLabel || "READY").slice(0,80))};
    const ownerEl = document.getElementById(ROOT + '_owner');
    const actionEl = document.getElementById(ROOT + '_action');
    if (ownerEl) ownerEl.textContent = owner;
    if (actionEl) actionEl.textContent = action;
    return true;
  })()`;
  try { await cdp(tabId, "Runtime.evaluate", { expression, returnByValue: true }); } catch {}
}

async function removeAgentControlUi(tabId) {
  claimedTabUi.delete(tabId);
  try {
    await cdp(tabId, "Runtime.evaluate", {
      expression: `document.getElementById('__devspace_ultra_agent_control__')?.remove(); true`,
      returnByValue: true,
    });
  } catch {}
}

async function moveAgentCursor(tabId, x, y, actionLabel = "MOVE", durationMs = 180) {
  const meta = claimedTabUi.get(tabId) || { ownerLabel: "agent" };
  await ensureAgentControlUi(tabId, meta.ownerLabel, actionLabel);
  const safeX = Number.isFinite(Number(x)) ? Number(x) : 0;
  const safeY = Number.isFinite(Number(y)) ? Number(y) : 0;
  const duration = Math.max(90, Math.min(900, Number(durationMs) || 180));
  try {
    await cdp(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const c=document.getElementById('__devspace_ultra_agent_control___cursor');
        if(!c) return false;
        const fromX=Number(c.dataset.x||24), fromY=Number(c.dataset.y||84);
        const toX=${JSON.stringify(safeX)}, toY=${JSON.stringify(safeY)};
        c.getAnimations().forEach(a=>a.cancel());
        c.animate([
          {transform:'translate3d('+fromX+'px,'+fromY+'px,0)'},
          {transform:'translate3d('+toX+'px,'+toY+'px,0)'}
        ], {duration:${JSON.stringify(duration)}, easing:'cubic-bezier(.22,.78,.28,1)', fill:'forwards'});
        c.style.transform='translate3d('+toX+'px,'+toY+'px,0)';
        c.dataset.x=String(toX); c.dataset.y=String(toY);
        return {fromX,fromY,toX,toY};
      })()`,
      returnByValue: true,
    });
  } catch {}
  await sleep(duration + 24);
}

async function pulseAgentCursor(tabId, x, y) {
  try {
    await cdp(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const p=document.getElementById('__devspace_ultra_agent_control___pulse');
        if(!p) return false;
        p.getAnimations().forEach(a=>a.cancel());
        p.style.left=${JSON.stringify(Number(x)||0)}+'px';
        p.style.top=${JSON.stringify(Number(y)||0)}+'px';
        p.animate([
          {opacity:0,transform:'translate(-50%,-50%) scale(.45)'},
          {opacity:.92,transform:'translate(-50%,-50%) scale(.82)',offset:.28},
          {opacity:0,transform:'translate(-50%,-50%) scale(1.22)'}
        ], {duration:360,easing:'ease-out'});
        return true;
      })()`,
      returnByValue: true,
    });
  } catch {}
  await sleep(120);
}

function axValue(value) {
  const raw = value?.value;
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return "";
}

function axProperty(node, name) {
  const item = Array.isArray(node?.properties) ? node.properties.find((property) => property?.name === name) : undefined;
  return item?.value?.value;
}

function snapshotDepths(nodes) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const cache = new Map();
  const depthOf = (node) => {
    if (!node?.parentId) return 0;
    if (cache.has(node.nodeId)) return cache.get(node.nodeId);
    let depth = 0;
    let current = node;
    const seen = new Set();
    while (current?.parentId && !seen.has(current.nodeId) && depth < 60) {
      seen.add(current.nodeId);
      current = byId.get(current.parentId);
      depth += 1;
    }
    cache.set(node.nodeId, depth);
    return depth;
  };
  return nodes.map(depthOf);
}

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox",
  "option", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider",
  "spinbutton", "treeitem", "gridcell", "row", "cell", "progressbar",
]);
const INFORMATION_ROLES = new Set([
  "heading", "StaticText", "paragraph", "img", "listitem", "table", "dialog", "alert",
  "main", "navigation", "banner", "contentinfo", "form", "region", "article",
]);

async function semanticSnapshot(tabId, maxNodes) {
  await attachTab(tabId);
  const [ax, metrics, tab] = await Promise.all([
    cdp(tabId, "Accessibility.getFullAXTree", {}),
    cdp(tabId, "Page.getLayoutMetrics", {}).catch(() => ({})),
    chrome.tabs.get(tabId),
  ]);
  const all = Array.isArray(ax?.nodes) ? ax.nodes : [];
  const depths = snapshotDepths(all);
  const nodes = [];
  for (let i = 0; i < all.length && nodes.length < Math.max(20, Math.min(800, Number(maxNodes) || 300)); i += 1) {
    const node = all[i];
    if (node?.ignored) continue;
    const role = axValue(node.role);
    const name = axValue(node.name).replace(/\s+/g, " ").trim();
    const value = axValue(node.value).replace(/\s+/g, " ").trim();
    const description = axValue(node.description).replace(/\s+/g, " ").trim();
    const interactive = INTERACTIVE_ROLES.has(role);
    const informative = INFORMATION_ROLES.has(role) && (name || value || description);
    if (!interactive && !informative) continue;
    nodes.push({
      axNodeId: node.nodeId,
      backendDOMNodeId: Number.isInteger(node.backendDOMNodeId) ? node.backendDOMNodeId : undefined,
      frameId: node.frameId,
      depth: depths[i] || 0,
      role,
      name: name.slice(0, 1000),
      value: value.slice(0, 1000),
      description: description.slice(0, 1000),
      disabled: axProperty(node, "disabled") === true,
      focused: axProperty(node, "focused") === true,
      checked: axProperty(node, "checked"),
      selected: axProperty(node, "selected"),
      expanded: axProperty(node, "expanded"),
      sensitive: false,
    });
  }
  for (const node of nodes) {
    if (!node.backendDOMNodeId || !["textbox", "searchbox"].includes(node.role)) continue;
    try {
      const described = await cdp(tabId, "DOM.describeNode", { backendNodeId: node.backendDOMNodeId, depth: 0, pierce: false });
      const domNode = described?.node;
      if (String(domNode?.nodeName || "").toLowerCase() !== "input") continue;
      const attributes = Array.isArray(domNode?.attributes) ? domNode.attributes : [];
      let inputType = "";
      for (let i = 0; i + 1 < attributes.length; i += 2) {
        if (String(attributes[i]).toLowerCase() === "type") {
          inputType = String(attributes[i + 1] || "").toLowerCase();
          break;
        }
      }
      if (inputType === "password") {
        node.sensitive = true;
        node.value = "";
      }
    } catch {}
  }
  const viewport = metrics?.cssVisualViewport || metrics?.visualViewport || undefined;
  return {
    title: tab.title || "",
    url: tab.url || "",
    viewport: viewport ? {
      width: viewport.clientWidth || viewport.width,
      height: viewport.clientHeight || viewport.height,
      pageX: viewport.pageX,
      pageY: viewport.pageY,
      scale: viewport.scale,
    } : undefined,
    nodes,
  };
}

async function screenshot(tabId, { fullPage, format, quality }) {
  await attachTab(tabId);
  const tab = await chrome.tabs.get(tabId);
  const params = {
    format: ["png", "jpeg", "webp"].includes(format) ? format : "png",
    fromSurface: true,
    captureBeyondViewport: Boolean(fullPage),
    optimizeForSpeed: true,
  };
  if (params.format !== "png") params.quality = Math.max(20, Math.min(100, Number(quality) || 85));
  let width;
  let height;
  if (fullPage) {
    const metrics = await cdp(tabId, "Page.getLayoutMetrics", {});
    const size = metrics?.cssContentSize || metrics?.contentSize;
    if (size?.width && size?.height) {
      width = Math.max(1, Math.min(16384, Math.ceil(size.width)));
      height = Math.max(1, Math.min(16384, Math.ceil(size.height)));
      params.clip = { x: 0, y: 0, width, height, scale: 1 };
    }
  } else {
    const metrics = await cdp(tabId, "Page.getLayoutMetrics", {}).catch(() => ({}));
    const viewport = metrics?.cssVisualViewport || metrics?.visualViewport;
    width = viewport?.clientWidth || viewport?.width;
    height = viewport?.clientHeight || viewport?.height;
  }
  const captured = await cdp(tabId, "Page.captureScreenshot", params);
  return { data: captured?.data, title: tab.title || "", url: tab.url || "", width, height };
}

async function elementPoint(tabId, target) {
  if (!target?.backendDOMNodeId) throw new Error("Element ref has no DOM node target.");
  try { await cdp(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId: target.backendDOMNodeId }); } catch {}
  const box = await cdp(tabId, "DOM.getBoxModel", { backendNodeId: target.backendDOMNodeId });
  const quad = box?.model?.border || box?.model?.content;
  if (!Array.isArray(quad) || quad.length < 8) throw new Error("Element has no visible box model.");
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return { x: xs.reduce((a,b) => a+b,0)/4, y: ys.reduce((a,b) => a+b,0)/4 };
}

function modifierBits(modifiers) {
  let bits = 0;
  for (const modifier of Array.isArray(modifiers) ? modifiers : []) {
    if (modifier === "Alt") bits |= 1;
    else if (modifier === "Control") bits |= 2;
    else if (modifier === "Meta") bits |= 4;
    else if (modifier === "Shift") bits |= 8;
  }
  return bits;
}

async function focusTarget(tabId, target) {
  if (!target?.backendDOMNodeId) throw new Error("This action requires a semantic element ref.");
  await cdp(tabId, "DOM.focus", { backendNodeId: target.backendDOMNodeId });
}

async function resolveObject(tabId, target) {
  if (!target?.backendDOMNodeId) throw new Error("This action requires a semantic element ref.");
  const resolved = await cdp(tabId, "DOM.resolveNode", { backendNodeId: target.backendDOMNodeId });
  const objectId = resolved?.object?.objectId;
  if (!objectId) throw new Error("Could not resolve the DOM element.");
  return objectId;
}

async function fillElement(tabId, target, text, append = false, typeDelayMs = 0) {
  const objectId = await resolveObject(tabId, target);
  const metaResponse = await cdp(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `(function(){
      const tag=String(this?.tagName||'').toLowerCase();
      const type=String(this?.type||'').toLowerCase();
      return {tag,type,contentEditable:Boolean(this?.isContentEditable),editable:Boolean(this?.isContentEditable || ('value' in this))};
    })`,
    returnByValue: true,
  });
  const meta = metaResponse?.result?.value || {};
  if (meta.tag === "input" && meta.type === "password") {
    throw new Error("Programmatic password entry is blocked. Let the user enter credentials directly in Chrome, then continue.");
  }
  if (!meta.editable) throw new Error("Element cannot be filled (not-editable).");

  await focusTarget(tabId, target);
  if (!append) {
    await cdp(tabId, "Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
    });
    await cdp(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
    });
    await cdp(tabId, "Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
    });
    await cdp(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
    });
  }

  const delay = Math.max(0, Math.min(120, Number(typeDelayMs) || 0));
  for (const character of String(text ?? "")) {
    await cdp(tabId, "Input.insertText", { text: character });
    if (delay) await sleep(delay);
  }

  const valueResponse = await cdp(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `(function(){
      const value=this?.isContentEditable ? String(this.textContent||'') : String(this?.value ?? '');
      try { this.dispatchEvent(new Event('change',{bubbles:true})); } catch {}
      return {blocked:false,value};
    })`,
    returnByValue: true,
  });
  return valueResponse?.result?.value || { blocked: false, value: "" };
}

async function selectElement(tabId, target, values) {
  const objectId = await resolveObject(tabId, target);
  const declaration = function(selectedValues) {
    const el = this;
    if (!(el instanceof HTMLSelectElement)) return { ok: false, reason: "not-select" };
    const wanted = new Set(selectedValues.map(String));
    const selected = [];
    for (const option of el.options) {
      const hit = wanted.has(option.value) || wanted.has(option.label) || wanted.has(option.textContent || "");
      option.selected = hit;
      if (hit) selected.push(option.value);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, selected };
  };
  const response = await cdp(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `(${declaration.toString()})`,
    arguments: [{ value: Array.isArray(values) ? values.map(String) : [] }],
    returnByValue: true,
  });
  const result = response?.result?.value;
  if (!result?.ok) throw new Error("Element is not a select control.");
  return result;
}

async function clickElement(tabId, target, count = 1) {
  const objectId = await resolveObject(tabId, target);
  const declaration = function(clickCount) {
    const el = this;
    if (!(el instanceof Element)) return { ok: false, reason: "not-element" };
    try { el.focus?.({ preventScroll: true }); } catch { try { el.focus?.(); } catch {} }
    const n = Math.max(1, Math.min(2, Number(clickCount) || 1));
    if (n === 1 && typeof el.click === "function") {
      el.click();
      return { ok: true, count: 1 };
    }
    if (typeof el.click === "function") {
      el.click();
      el.click();
    }
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window, detail: 2 }));
    return { ok: true, count: 2 };
  };
  const response = await cdp(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `(${declaration.toString()})`,
    arguments: [{ value: count }],
    returnByValue: true,
  });
  const result = response?.result?.value;
  if (!result?.ok) throw new Error(`Element click failed (${result?.reason || "unknown"}).`);
  return result;
}

async function checkElement(tabId, target, checked) {
  const objectId = await resolveObject(tabId, target);
  const declaration = function(nextChecked) {
    const el = this;
    const type = String(el?.type || "").toLowerCase();
    if (!(el instanceof HTMLInputElement) || !["checkbox", "radio"].includes(type)) return { ok: false };
    el.focus();
    el.checked = Boolean(nextChecked);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, checked: el.checked };
  };
  const response = await cdp(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `(${declaration.toString()})`,
    arguments: [{ value: checked !== false }],
    returnByValue: true,
  });
  const result = response?.result?.value;
  if (!result?.ok) throw new Error("Element is not a checkbox/radio control.");
  return result;
}

async function dragElement(tabId, target, endX, endY) {
  const objectId = await resolveObject(tabId, target);
  const declaration = async function(targetX, targetY) {
    const el = this;
    if (!(el instanceof Element)) return { ok: false, reason: "not-element" };
    const rect = el.getBoundingClientRect();
    const startX = rect.left + rect.width / 2;
    const startY = rect.top + rect.height / 2;
    const cursor = document.getElementById('__devspace_ultra_agent_control___cursor');
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const eventInit = (x, y, buttons) => ({ bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons });
    el.dispatchEvent(new MouseEvent('mousedown', eventInit(startX, startY, 1)));
    for (let i = 1; i <= 10; i += 1) {
      const t = i / 10;
      const x = startX + (targetX - startX) * t;
      const y = startY + (targetY - startY) * t;
      if (cursor) cursor.style.transform = `translate3d(${x}px,${y}px,0)`;
      document.dispatchEvent(new MouseEvent('mousemove', eventInit(x, y, 1)));
      await pause(55);
    }
    document.dispatchEvent(new MouseEvent('mouseup', eventInit(targetX, targetY, 0)));
    return { ok: true, startX, startY, endX: targetX, endY: targetY };
  };
  const response = await cdp(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `(${declaration.toString()})`,
    arguments: [{ value: Number(endX) }, { value: Number(endY) }],
    returnByValue: true,
    awaitPromise: true,
  });
  const result = response?.result?.value;
  if (!result?.ok) throw new Error(`Element drag failed (${result?.reason || "unknown"}).`);
  return result;
}

const KEY_CODES = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34,
};

async function pressKey(tabId, key, modifiers, target) {
  if (target) await focusTarget(tabId, target);
  const value = String(key || "");
  if (!value) throw new Error("press action requires key.");
  const mod = modifierBits(modifiers);
  const virtual = KEY_CODES[value] || (value.length === 1 ? value.toUpperCase().charCodeAt(0) : 0);
  const text = value.length === 1 && mod === 0 ? value : value === "Space" && mod === 0 ? " " : "";
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: "rawKeyDown", key: value === "Space" ? " " : value, code: value, windowsVirtualKeyCode: virtual,
    nativeVirtualKeyCode: virtual, modifiers: mod, text,
  });
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp", key: value === "Space" ? " " : value, code: value, windowsVirtualKeyCode: virtual,
    nativeVirtualKeyCode: virtual, modifiers: mod,
  });
  if (target) {
    try {
      const objectId = await resolveObject(tabId, target);
      const declaration = function(keyValue, modifierNames) {
        const init = {
          key: keyValue === "Space" ? " " : keyValue,
          code: keyValue,
          bubbles: true,
          cancelable: true,
          altKey: modifierNames.includes("Alt"),
          ctrlKey: modifierNames.includes("Control"),
          metaKey: modifierNames.includes("Meta"),
          shiftKey: modifierNames.includes("Shift"),
        };
        this.dispatchEvent(new KeyboardEvent("keydown", init));
        this.dispatchEvent(new KeyboardEvent("keyup", init));
        return true;
      };
      await cdp(tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `(${declaration.toString()})`,
        arguments: [{ value }, { value: Array.isArray(modifiers) ? modifiers : [] }],
        returnByValue: true,
      });
    } catch {}
  }
}

async function pageAct(tabId, params) {
  await attachTab(tabId);
  const action = params.action;
  const target = params.target;
  if (params.ownerLabel) await ensureAgentControlUi(tabId, params.ownerLabel, String(action || "ACTION").toUpperCase());
  let point;
  if (target && ["click", "doubleClick", "hover", "drag", "fill", "type", "select", "check", "focus", "press"].includes(action)) point = await elementPoint(tabId, target);
  if (!point && Number.isFinite(params.x) && Number.isFinite(params.y)) point = { x: params.x, y: params.y };
  if (point && action !== "scroll") await moveAgentCursor(tabId, point.x, point.y, String(action || "MOVE").toUpperCase(), params.uiMotionMs);

  if (action === "focus") {
    await focusTarget(tabId, target);
    return { message: "Element focused." };
  }
  if (action === "fill") {
    const value = await fillElement(tabId, target, params.text, false, params.uiTypeDelayMs);
    return { message: "Element filled.", value: value.value };
  }
  if (action === "type") {
    const value = await fillElement(tabId, target, params.text, true, params.uiTypeDelayMs);
    return { message: "Text appended.", value: value.value };
  }
  if (action === "select") {
    const value = await selectElement(tabId, target, params.values);
    return { message: "Selection updated.", selected: value.selected };
  }
  if (action === "check") {
    const value = await checkElement(tabId, target, params.checked);
    return { message: "Check state updated.", checked: value.checked };
  }
  if (action === "press") {
    await pressKey(tabId, params.key, params.modifiers, target);
    return { message: `Pressed ${params.key}.` };
  }
  if (action === "hover") {
    if (!point) throw new Error("hover requires a ref or x/y coordinates.");
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    return { message: "Pointer moved.", x: point.x, y: point.y };
  }
  if (action === "scroll") {
    const metrics = await cdp(tabId, "Page.getLayoutMetrics", {}).catch(() => ({}));
    const viewport = metrics?.cssVisualViewport || metrics?.visualViewport || {};
    const x = Number.isFinite(params.x) ? params.x : Math.max(1, (viewport.clientWidth || viewport.width || 1000) / 2);
    const y = Number.isFinite(params.y) ? params.y : Math.max(1, (viewport.clientHeight || viewport.height || 700) / 2);
    const deltaX = Number(params.deltaX) || 0;
    const deltaY = Number(params.deltaY) || 0;
    await moveAgentCursor(tabId, x, y, "SCROLL", params.uiMotionMs);
    const smooth = Number(params.uiMotionMs) >= 300;
    await cdp(tabId, "Runtime.evaluate", {
      expression: `(() => { window.scrollBy({left:${JSON.stringify(deltaX)},top:${JSON.stringify(deltaY)},behavior:${JSON.stringify(smooth ? "smooth" : "auto")}}); return true; })()`,
      returnByValue: true,
    });
    if (smooth) await sleep(Math.max(320, Math.min(900, Number(params.uiMotionMs) || 420)));
    const scrolled = await cdp(tabId, "Runtime.evaluate", {
      expression: `({scrollX:window.scrollX,scrollY:window.scrollY})`,
      returnByValue: true,
    });
    return { message: "Scrolled page.", x, y, deltaX, deltaY, ...(scrolled?.result?.value || {}) };
  }
  if (action === "drag") {
    if (!point || !Number.isFinite(params.endX) || !Number.isFinite(params.endY)) throw new Error("drag requires a ref/start x-y and endX/endY.");
    if (target) {
      const dragged = await dragElement(tabId, target, params.endX, params.endY);
      await pulseAgentCursor(tabId, params.endX, params.endY);
      return { message: "Drag completed on semantic element.", semantic: true, ...dragged };
    }
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 8; i += 1) {
      const t = i / 8;
      const x = point.x + (params.endX - point.x) * t;
      const y = point.y + (params.endY - point.y) * t;
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
      await sleep(35);
    }
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: params.endX, y: params.endY, button: "left", buttons: 0, clickCount: 1 });
    await pulseAgentCursor(tabId, params.endX, params.endY);
    return { message: "Drag completed at viewport coordinates.", semantic: false };
  }
  if (["click", "doubleClick"].includes(action)) {
    const button = ["left", "right", "middle"].includes(params.button) ? params.button : "left";
    const count = action === "doubleClick" ? 2 : 1;
    if (target && button === "left") {
      if (!point) throw new Error(`${action} requires a visible semantic target.`);
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
      for (let clickIndex = 1; clickIndex <= count; clickIndex += 1) {
        await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: clickIndex });
        await pulseAgentCursor(tabId, point.x, point.y);
        await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: clickIndex });
        if (clickIndex < count) await sleep(90);
      }
      return { message: `${action} completed on semantic element.`, semantic: true, clickCount: count, x: point.x, y: point.y };
    }
    if (!point) throw new Error(`${action} requires a ref or x/y coordinates.`);
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button, buttons: button === "left" ? 1 : button === "right" ? 2 : 4, clickCount: count });
    await pulseAgentCursor(tabId, point.x, point.y);
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button, buttons: 0, clickCount: count });
    return { message: `${action} completed at viewport coordinates.`, semantic: false, x: point.x, y: point.y };
  }
  throw new Error(`Unsupported page action: ${action}`);
}

async function pageNavigate(tabId, params) {
  await attachTab(tabId);
  const action = params.action;
  if (action === "goto") {
    await cdp(tabId, "Page.navigate", { url: String(params.url || "about:blank") });
  } else if (action === "reload") {
    await cdp(tabId, "Page.reload", { ignoreCache: false });
  } else if (action === "stop") {
    await cdp(tabId, "Page.stopLoading", {});
  } else if (["back", "forward"].includes(action)) {
    const history = await cdp(tabId, "Page.getNavigationHistory", {});
    const index = Number(history?.currentIndex) + (action === "back" ? -1 : 1);
    const entry = Array.isArray(history?.entries) ? history.entries[index] : undefined;
    if (!entry) throw new Error(`No ${action} history entry is available.`);
    await cdp(tabId, "Page.navigateToHistoryEntry", { entryId: entry.id });
  } else if (action === "activate") {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  } else if (action === "close") {
    await chrome.tabs.remove(tabId);
    attachedTabs.delete(tabId);
    scheduleSync();
    return { message: "Chrome tab closed." };
  } else {
    throw new Error(`Unsupported navigation action: ${action}`);
  }
  await sleep(50);
  return { message: `${action} requested.`, tab: await tabMetadata(tabId) };
}

async function pageWait(tabId, params) {
  await attachTab(tabId);
  const condition = params.condition || "load";
  const value = String(params.value || "");
  const timeoutMs = Math.max(100, Math.min(60_000, Number(params.timeoutMs) || 10_000));
  if (condition === "delay") {
    await sleep(timeoutMs);
    return { matched: true, condition, waitedMs: timeoutMs, message: `Waited ${timeoutMs} ms.` };
  }
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (condition === "load") {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") return { matched: true, condition, waitedMs: Date.now() - started, url: tab.url };
    } else if (condition === "url") {
      const tab = await chrome.tabs.get(tabId);
      if (String(tab.url || "").includes(value)) return { matched: true, condition, waitedMs: Date.now() - started, url: tab.url };
    } else if (condition === "text") {
      const check = await cdp(tabId, "Runtime.evaluate", {
        expression: `(document.body?.innerText || '').includes(${JSON.stringify(value)})`,
        returnByValue: true,
      });
      if (check?.result?.value === true) return { matched: true, condition, waitedMs: Date.now() - started };
    } else if (condition === "selector") {
      const check = await cdp(tabId, "Runtime.evaluate", {
        expression: `Boolean(document.querySelector(${JSON.stringify(value)}))`,
        returnByValue: true,
      });
      if (check?.result?.value === true) return { matched: true, condition, waitedMs: Date.now() - started };
    } else {
      throw new Error(`Unsupported wait condition: ${condition}`);
    }
    await sleep(200);
  }
  throw new Error(`Browser wait timed out after ${timeoutMs} ms (${condition}${value ? `: ${value}` : ""}).`);
}

async function inspectEvents(tabId, kind, limit) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  if (kind === "console") return { items: (consoleEvents.get(tabId) || []).slice(-n) };
  if (kind === "network") return { items: (networkEvents.get(tabId) || []).slice(-n) };
  if (kind === "downloads") return { items: (downloadEvents.get(tabId) || []).slice(-n) };
  throw new Error(`Unsupported event kind: ${kind}`);
}

function commandUiLabel(kind, params = {}) {
  if (kind === "tab.attach") return "CLAIMED";
  if (kind === "inspect.snapshot") return "SEMANTIC SNAPSHOT";
  if (kind === "inspect.screenshot") return "SCREENSHOT";
  if (kind === "inspect.events") return `INSPECT ${String(params.kind || "EVENTS").toUpperCase()}`;
  if (kind === "page.navigate") return `NAVIGATE ${String(params.action || "").toUpperCase()}`.trim();
  if (kind === "page.wait") return `WAIT ${String(params.condition || "").toUpperCase()}`.trim();
  if (kind === "cdp.command") return "DEVELOPER CDP";
  return "AGENT ACTIVE";
}

async function executeCommand(command) {
  const kind = command?.kind;
  const params = command?.params || {};
  const tabId = Number(params.tabId);
  if (kind === "tab.create") {
    const { sharedTabs, managedTabs } = await getSettings();
    const tab = await chrome.tabs.create({ url: String(params.url || "about:blank"), active: params.active !== false });
    if (!Number.isInteger(tab.id)) throw new Error("Chrome did not return a tab id.");
    sharedTabs.add(tab.id);
    managedTabs.add(tab.id);
    await persistTabSets(sharedTabs, managedTabs);
    scheduleSync(0);
    return { tab: await tabMetadata(tab.id) };
  }
  if (!Number.isInteger(tabId)) throw new Error(`${kind} requires tabId.`);
  if (params.ownerLabel && kind !== "tab.detach") {
    await attachTab(tabId);
    await ensureAgentControlUi(tabId, params.ownerLabel, commandUiLabel(kind, params));
  }
  if (kind === "tab.activate") {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return { tab: await tabMetadata(tabId) };
  }
  if (kind === "tab.attach") return await attachTab(tabId);
  if (kind === "tab.detach") return await detachTab(tabId);
  if (kind === "inspect.snapshot") return await semanticSnapshot(tabId, params.maxNodes);
  if (kind === "inspect.screenshot") return await screenshot(tabId, params);
  if (kind === "inspect.events") return await inspectEvents(tabId, params.kind, params.limit);
  if (kind === "page.act") {
    const result = await pageAct(tabId, params);
    return { ...result, tab: await tabMetadata(tabId).catch(() => undefined) };
  }
  if (kind === "page.navigate") return await pageNavigate(tabId, params);
  if (kind === "page.wait") return await pageWait(tabId, params);
  if (kind === "cdp.command") {
    const { settings } = await getSettings();
    if (!settings.developerMode) throw new Error("Developer mode is disabled in the DevSpace Browser Control Bridge.");
    await attachTab(tabId);
    const result = await cdp(tabId, String(params.method || ""), params.params || {});
    return { result };
  }
  throw new Error(`Unknown browser-control command: ${kind}`);
}

async function submitCommandResult(commandId, ok, result, error) {
  await apiFetch("/browser-control/bridge/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commandId, ok, result, error }),
  });
}

async function commandLoop(generation) {
  let backoff = 500;
  while (generation === loopGeneration) {
    const { settings } = await getSettings();
    if (!settings.bridgeToken) return;
    try {
      await syncTabs();
      const next = await apiFetch(`/browser-control/bridge/next?waitMs=${LOOP_WAIT_MS}`, { method: "GET" });
      backoff = 500;
      if (!next?.command) continue;
      const command = next.command;
      try {
        const result = await executeCommand(command);
        await submitCommandResult(command.commandId, true, result, undefined);
      } catch (error) {
        await submitCommandResult(command.commandId, false, undefined, error?.message || String(error)).catch(() => {});
      }
      scheduleSync(0);
    } catch (error) {
      if (generation !== loopGeneration) return;
      if (error?.status === 401 || error?.status === 403) {
        const current = (await getSettings()).settings;
        await setSettings({
          endpoint: current.endpoint || "http://127.0.0.1:7676",
          label: current.label || "Chrome",
          accessMode: current.accessMode || "selected",
          developerMode: Boolean(current.developerMode),
          instanceKey: current.instanceKey || crypto.randomUUID(),
        });
        return;
      }
      await sleep(backoff + Math.floor(Math.random() * 250));
      backoff = Math.min(10_000, backoff * 2);
    }
  }
}

function startBridgeLoop() {
  loopGeneration += 1;
  const generation = loopGeneration;
  void commandLoop(generation);
}

chrome.debugger.onDetach.addListener((source) => {
  if (Number.isInteger(source?.tabId)) {
    attachedTabs.delete(source.tabId);
    claimedTabUi.delete(source.tabId);
    scheduleSync();
  }
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source?.tabId;
  if (!Number.isInteger(tabId)) return;
  if (method === "Runtime.consoleAPICalled") {
    ringPush(consoleEvents, tabId, {
      at: nowIso(), source: "console", type: params?.type,
      text: Array.isArray(params?.args) ? params.args.map((arg) => arg?.value ?? arg?.description ?? arg?.type).join(" ").slice(0, 8000) : "",
      stackTrace: params?.stackTrace,
    });
  } else if (method === "Log.entryAdded") {
    const entry = params?.entry || {};
    ringPush(consoleEvents, tabId, {
      at: nowIso(), source: "log", level: entry.level, text: String(entry.text || "").slice(0, 8000),
      url: entry.url, lineNumber: entry.lineNumber,
    });
  } else if (method === "Network.requestWillBeSent") {
    ringPush(networkEvents, tabId, {
      at: nowIso(), type: "request", requestId: params?.requestId, method: params?.request?.method,
      url: params?.request?.url, resourceType: params?.type, initiator: params?.initiator?.type,
    });
  } else if (method === "Network.responseReceived") {
    ringPush(networkEvents, tabId, {
      at: nowIso(), type: "response", requestId: params?.requestId, status: params?.response?.status,
      mimeType: params?.response?.mimeType, url: params?.response?.url, resourceType: params?.type,
    });
  } else if (method === "Network.loadingFailed") {
    ringPush(networkEvents, tabId, {
      at: nowIso(), type: "failed", requestId: params?.requestId, errorText: params?.errorText,
      canceled: params?.canceled, blockedReason: params?.blockedReason,
    });
  } else if (method === "Page.downloadWillBegin") {
    ringPush(downloadEvents, tabId, {
      at: nowIso(), type: "willBegin", guid: params?.guid, url: params?.url,
      suggestedFilename: params?.suggestedFilename, frameId: params?.frameId,
    });
  } else if (method === "Page.downloadProgress") {
    ringPush(downloadEvents, tabId, {
      at: nowIso(), type: "progress", guid: params?.guid, state: params?.state,
      receivedBytes: params?.receivedBytes, totalBytes: params?.totalBytes,
    });
  }
});

chrome.tabs.onCreated.addListener(() => scheduleSync());
chrome.tabs.onUpdated.addListener(() => scheduleSync());
chrome.tabs.onActivated.addListener(() => scheduleSync());
chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  claimedTabUi.delete(tabId);
  void forgetTabInstanceKey(tabId).catch(() => {});
  scheduleSync(0);
});
chrome.windows.onFocusChanged.addListener(() => scheduleSync());

chrome.alarms.create("devspace-browser-control-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "devspace-browser-control-keepalive") {
    void syncTabs().catch(() => {});
    void getSettings().then(({ settings }) => {
      if (settings.bridgeToken) startBridgeLoop();
    });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  void getSettings().then(async ({ settings }) => {
    if (!settings.instanceKey) {
      await setSettings({
        endpoint: "http://127.0.0.1:7676",
        label: "Chrome",
        accessMode: "selected",
        developerMode: false,
        instanceKey: crypto.randomUUID(),
      });
    }
  });
});

chrome.runtime.onStartup.addListener(() => {
  void getSettings().then(({ settings }) => { if (settings.bridgeToken) startBridgeLoop(); });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const run = async () => {
    if (message?.type === "pair") return await pairBridge(message.payload || {});
    if (message?.type === "disconnect") return await disconnectBridge();
    if (message?.type === "share-current") return await shareCurrentTab(message.shared !== false);
    if (message?.type === "preferences") return await updatePreferences(message.payload || {});
    if (message?.type === "status") {
      const { settings, sharedTabs, managedTabs } = await getSettings();
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return {
        ok: true,
        paired: Boolean(settings.bridgeToken),
        bridgeId: settings.bridgeId,
        endpoint: settings.endpoint || "http://127.0.0.1:7676",
        label: settings.label || "Chrome",
        accessMode: settings.accessMode || "selected",
        developerMode: Boolean(settings.developerMode),
        currentTabId: tab?.id,
        currentTabUrl: tab?.url,
        currentTabShared: Boolean(tab?.id && (settings.accessMode === "all" ? controllableUrl(tab.url) : sharedTabs.has(tab.id) || managedTabs.has(tab.id))),
        attachedTabs: [...attachedTabs],
      };
    }
    throw new Error("Unknown DevSpace Browser Control message.");
  };
  void run().then((result) => sendResponse(result)).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

void getSettings().then(({ settings }) => {
  if (settings.bridgeToken) startBridgeLoop();
});
