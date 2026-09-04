function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

const sourcePort = Number(arg("source-port", "0"));
const targetPort = Number(arg("target-port", "0"));
const verifySeconds = Math.max(3, Math.min(30, Number(arg("verify-seconds", "12")) || 12));
const settleSeconds = Math.max(2, Math.min(15, Number(arg("settle-seconds", "6")) || 6));

if (!Number.isInteger(sourcePort) || sourcePort < 1024 || !Number.isInteger(targetPort) || targetPort < 1024 || sourcePort === targetPort) {
  console.error("Distinct valid --source-port and --target-port values are required.");
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const allowedCookieDomain = (domain = "") => /(^|\.)((chatgpt\.com)|(openai\.com))$/i.test(String(domain).replace(/^\./, ""));

async function json(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`CDP ${port}${path} HTTP ${response.status}`);
  return await response.json();
}

async function findPage(port) {
  const list = await json(port, "/json/list");
  const pages = list.filter((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
  return pages.find((entry) => /chatgpt\.com/i.test(entry.url || "")) || pages[0];
}

class CdpClient {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", (event) => reject(event?.error || new Error("CDP WebSocket failed")), { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }
  call(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

function toCookieParam(cookie) {
  const out = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
  };
  if (cookie.sameSite && ["Strict", "Lax", "None"].includes(cookie.sameSite)) out.sameSite = cookie.sameSite;
  if (Number.isFinite(cookie.expires) && cookie.expires > 0) out.expires = cookie.expires;
  if (cookie.priority && ["Low", "Medium", "High"].includes(cookie.priority)) out.priority = cookie.priority;
  if (cookie.sourceScheme && ["Unset", "NonSecure", "Secure"].includes(cookie.sourceScheme)) out.sourceScheme = cookie.sourceScheme;
  if (Number.isInteger(cookie.sourcePort)) out.sourcePort = cookie.sourcePort;
  if (cookie.partitionKey && typeof cookie.partitionKey === "object") out.partitionKey = cookie.partitionKey;
  return out;
}

async function clearAllowlistedTargetCookies(client) {
  const all = await client.call("Network.getAllCookies");
  const stale = (all.cookies || []).filter((cookie) => allowedCookieDomain(cookie.domain));
  for (const cookie of stale) {
    const params = {
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path || "/",
    };
    if (cookie.partitionKey && typeof cookie.partitionKey === "object") params.partitionKey = cookie.partitionKey;
    await client.call("Network.deleteCookies", params);
  }
  return stale.length;
}

async function loginProbe(client) {
  const result = await client.call("Runtime.evaluate", {
    expression: `(() => {
      const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
      const composer = document.querySelector('#prompt-textarea') || document.querySelector('[data-testid="composer-input"]') || [...document.querySelectorAll('[contenteditable="true"]')].find(visible);
      const loginVisible = [...document.querySelectorAll('button,a')].some((el) => /^(log in|登入)$/i.test(String(el.innerText || el.textContent || '').trim()));
      const body = String(document.body?.innerText || '');
      const accountExpired = /工作階段已過期|session has expired|session expired/i.test(body);
      return { href: location.href, composer: !!composer, loginVisible, accountExpired };
    })()`,
    returnByValue: true,
  });
  return result.result?.value;
}

const sourcePage = await findPage(sourcePort);
const targetPage = await findPage(targetPort);
if (!sourcePage || !targetPage) throw new Error("Source or target ChatGPT CDP page is unavailable.");

const source = new CdpClient(sourcePage.webSocketDebuggerUrl);
const target = new CdpClient(targetPage.webSocketDebuggerUrl);
try {
  await Promise.all([source.open(), target.open()]);
  await Promise.all([
    source.call("Network.enable"), target.call("Network.enable"),
    source.call("Runtime.enable"), target.call("Runtime.enable"),
    target.call("Page.enable"),
  ]);
  const sourceState = await loginProbe(source);
  if (!sourceState?.composer || sourceState.loginVisible || sourceState.accountExpired) {
    throw new Error("Source runtime is not a verified signed-in ChatGPT session.");
  }
  const all = await source.call("Network.getAllCookies");
  const cookies = (all.cookies || []).filter((cookie) => allowedCookieDomain(cookie.domain)).map(toCookieParam);
  if (cookies.length === 0) throw new Error("Source runtime has no allowlisted ChatGPT/OpenAI cookies to seed.");

  const clearedTargetCookies = await clearAllowlistedTargetCookies(target);
  await target.call("Network.setCookies", { cookies });
  await target.call("Page.reload", { ignoreCache: true });

  const deadline = Date.now() + verifySeconds * 1000;
  let targetState;
  do {
    await sleep(500);
    targetState = await loginProbe(target);
    if (targetState?.composer && !targetState.loginVisible && !targetState.accountExpired) break;
  } while (Date.now() < deadline);

  const verified = Boolean(targetState?.composer && !targetState.loginVisible && !targetState.accountExpired);
  let persistenceSettled = false;
  if (verified) {
    // Chromium can acknowledge Network.setCookies before the profile store has
    // durably flushed the new session. Keep the target alive for a bounded
    // settle interval, then re-verify before any caller is allowed to run an
    // immediate restart-persistence gate.
    await sleep(settleSeconds * 1000);
    targetState = await loginProbe(target);
    persistenceSettled = Boolean(targetState?.composer && !targetState.loginVisible && !targetState.accountExpired);
  }
  const complete = verified && persistenceSettled;
  console.log(JSON.stringify({
    ok: complete,
    sourceVerified: true,
    targetVerified: complete,
    persistenceSettled,
    settleSeconds,
    transferredCookies: cookies.length,
    clearedTargetCookies,
    allowlistedDomainsOnly: true,
    secretValuesLogged: false,
  }));
  if (!complete) process.exitCode = 4;
} finally {
  source.close();
  target.close();
}
