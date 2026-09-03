import { readFile } from "node:fs/promises";

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

const port = Number(arg("port", "0"));
const probeOnly = process.argv.includes("--probe");
const startContinuation = process.argv.includes("--start-continuation");
const promptFile = String(arg("prompt-file", "")).trim();
const projectUrl = String(arg("project-url", "")).trim();
const conversationUrl = String(arg("conversation-url", "")).trim();
const waitSeconds = Math.max(10, Math.min(240, Number(arg("wait-seconds", "120")) || 120));

if (!Number.isInteger(port) || port <= 0) {
  console.error("A valid --port is required.");
  process.exit(2);
}
if (!probeOnly && !startContinuation) {
  console.error("Use --probe or --start-continuation.");
  process.exit(2);
}
if (startContinuation && !promptFile) {
  console.error("--prompt-file is required for --start-continuation.");
  process.exit(2);
}

const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(path) {
  const response = await fetch(`${base}${path}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
  return await response.json();
}

async function findPage(deadlineMs = 25_000) {
  const deadline = Date.now() + deadlineMs;
  let last = [];
  while (Date.now() < deadline) {
    last = await json("/json/list");
    const pages = last.filter((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
    const preferred = pages.find((entry) => /chatgpt\.com/i.test(entry.url || "")) || pages[0];
    if (preferred) return preferred;
    await sleep(400);
  }
  throw new Error(`No inspectable ChatGPT page found on CDP port ${port}.`);
}

class CdpClient {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
  }
  async open() {
    await new Promise((resolve, reject) => {
      const onOpen = () => { this.ws.removeEventListener("error", onError); resolve(); };
      const onError = (event) => { this.ws.removeEventListener("open", onOpen); reject(event?.error || new Error("WebSocket connection failed")); };
      this.ws.addEventListener("open", onOpen, { once: true });
      this.ws.addEventListener("error", onError, { once: true });
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
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  async close() {
    try { this.ws.close(); } catch {}
  }
}

async function evaluate(client, expression) {
  const result = await client.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  return result.result?.value;
}

function expressionForContextProbe() {
  return String.raw`(() => {
    const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
    let nodes = [...document.querySelectorAll('[data-message-author-role]')]
      .filter((el) => !el.parentElement?.closest?.('[data-message-author-role]'));
    if (!nodes.length) nodes = [...document.querySelectorAll('main article')].filter(visible);
    const messages = [];
    const seen = new Set();
    for (const node of nodes) {
      const text = String(node.innerText || node.textContent || '').trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      const role = node.getAttribute('data-message-author-role') ||
        node.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role') ||
        (messages.length % 2 === 0 ? 'user' : 'assistant');
      messages.push({ role, text });
    }
    const joined = messages.map((m) => m.text).join('\n');
    let cjkChars = 0, asciiChars = 0, otherNonAsciiChars = 0, whitespaceChars = 0;
    for (const ch of joined) {
      const cp = ch.codePointAt(0);
      if (/\s/u.test(ch)) whitespaceChars += 1;
      else if (cp <= 0x7f) asciiChars += 1;
      else if ((cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0xac00 && cp <= 0xd7af)) cjkChars += 1;
      else otherNonAsciiChars += 1;
    }
    const composer = document.querySelector('#prompt-textarea') || document.querySelector('[data-testid="composer-input"]') || [...document.querySelectorAll('[contenteditable="true"]')].find(visible);
    const loginVisible = [...document.querySelectorAll('button,a')].some((el) => /^(log in|登入)$/i.test(String(el.innerText || el.textContent || '').trim()));
    const generating = !!document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="停止"]');
    return {
      href: location.href,
      title: document.title,
      readyState: document.readyState,
      composer: !!composer,
      loginVisible,
      generating,
      messageCount: messages.length,
      userMessages: messages.filter((m) => m.role === 'user').length,
      assistantMessages: messages.filter((m) => m.role === 'assistant').length,
      charCount: joined.length,
      cjkChars,
      asciiChars,
      otherNonAsciiChars,
      whitespaceChars,
      latestRole: messages.at(-1)?.role || null,
      latestTextPreview: (messages.at(-1)?.text || '').slice(-600),
      firstTextPreview: (messages[0]?.text || '').slice(0,300),
      // Bounded transcript excerpts are used only to build an automatic compact
      // capsule. Never return the full long conversation through CDP.
      recentMessages: messages.slice(-12).map((m) => ({ role: m.role, text: m.text.slice(0, 2500) }))
    };
  })()`;
}

function expressionForNewChat() {
  return String.raw`(() => {
    const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
    const candidates = [
      document.querySelector('[data-testid="create-new-chat-button"]'),
      document.querySelector('a[href="/"]'),
      ...[...document.querySelectorAll('button,a')].filter((el) => /new chat|新對話|新增對話|新聊天/i.test(String(el.innerText || el.textContent || '').trim()))
    ].filter(visible);
    if (!candidates.length) return { ok:false, reason:'new-chat-control-not-found', href:location.href };
    candidates[0].click();
    return { ok:true };
  })()`;
}

function expressionForInsert(prompt) {
  const serialized = JSON.stringify(prompt);
  return `(() => {
    const text = ${serialized};
    const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
    const composer = document.querySelector('#prompt-textarea') || document.querySelector('[data-testid="composer-input"]') || document.querySelector('textarea[placeholder]') || [...document.querySelectorAll('[contenteditable="true"]')].find(visible);
    if (!composer) return {ok:false, reason:'composer-not-found'};
    if (composer.disabled || composer.getAttribute('aria-disabled') === 'true') return {ok:false, reason:'composer-disabled'};
    composer.focus();
    if ('value' in composer) {
      const proto = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(composer, text); else composer.value = text;
      composer.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
      composer.dispatchEvent(new Event('change',{bubbles:true}));
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      selection.removeAllRanges(); selection.addRange(range);
      let inserted = false;
      try { inserted = document.execCommand('insertText', false, text); } catch {}
      if (!inserted) {
        composer.replaceChildren(document.createTextNode(text));
        composer.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
      }
    }
    return {ok:true,textLength:text.length};
  })()`;
}

function expressionForSend() {
  return String.raw`(() => {
    const send = document.querySelector('button[data-testid="send-button"]') || document.querySelector('button[aria-label="Send prompt"]') || [...document.querySelectorAll('button')].find((el) => /send|傳送|发送/i.test(el.getAttribute('aria-label') || ''));
    if (!send) return {ok:false,reason:'send-button-not-found'};
    if (send.disabled) return {ok:false,reason:'send-button-disabled'};
    send.click(); return {ok:true};
  })()`;
}

async function waitForComposer(client, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(client, expressionForContextProbe());
    if (last?.composer && !last?.loginVisible) return last;
    await sleep(500);
  }
  throw new Error(`Composer did not become ready: ${JSON.stringify(last)}`);
}

async function waitForFreshComposer(client, previousHref, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  let last;
  let stable = 0;
  let stableHref = "";
  while (Date.now() < deadline) {
    last = await evaluate(client, expressionForContextProbe());
    const href = String(last?.href || "");
    const routeChanged = href && href !== previousHref;
    const leftConversation = !/^https:\/\/chatgpt\.com\/(?:c\/|g\/g-p-[^/]+\/c\/)/.test(href);
    const emptyConversation = Number(last?.messageCount ?? 0) === 0;
    const ready = Date.now() - started >= 900 && last?.composer && !last?.loginVisible && (routeChanged || leftConversation || emptyConversation);
    if (ready) {
      if (href === stableHref) stable += 1;
      else { stableHref = href; stable = 1; }
      if (stable >= 2) return last;
    } else {
      stable = 0;
      stableHref = "";
    }
    await sleep(450);
  }
  throw new Error(`Fresh continuation composer did not become ready after leaving ${previousHref}: ${JSON.stringify(last)}`);
}

function stableConversationUrl(raw) {
  try {
    const target = new URL(String(raw || ""));
    if (target.protocol !== "https:" || target.hostname !== "chatgpt.com") return "";
    const match = target.pathname.match(/^\/(?:c|g\/g-p-[^/]+\/c)\/([A-Za-z0-9_-]{16,})\/?$/);
    if (!match || /^(?:WEB|TEMP|LOCAL)[_:.-]/i.test(match[1]) || match[1].includes(":")) return "";
    return `${target.protocol}//${target.hostname}${target.pathname.replace(/\/$/, "")}`;
  } catch { return ""; }
}

function validateChatGptUrl(raw, kind) {
  if (!raw) return undefined;
  const target = new URL(raw);
  if (target.protocol !== "https:" || target.hostname !== "chatgpt.com") throw new Error(`Unsafe ${kind} URL.`);
  if (kind === "conversation" && !stableConversationUrl(target.toString())) throw new Error("Unsafe or transient conversation URL.");
  if (kind === "project" && !/^\/g\/g-p-[^/]+\/project\/?$/.test(target.pathname)) throw new Error("Unsafe project URL.");
  return target.toString();
}

async function waitForStableConversation(client, timeoutMs = 45_000, expectedProjectUrl = "") {
  const deadline = Date.now() + timeoutMs;
  let last;
  let stable = 0;
  let stableUrl = "";
  const expectedProjectPrefix = expectedProjectUrl
    ? new URL(expectedProjectUrl).pathname.replace(/\/project\/?$/, "/c/")
    : "";
  while (Date.now() < deadline) {
    last = await evaluate(client, expressionForContextProbe());
    const url = stableConversationUrl(last?.href);
    let projectOk = true;
    if (url && expectedProjectPrefix) {
      try { projectOk = new URL(url).pathname.startsWith(expectedProjectPrefix); }
      catch { projectOk = false; }
    }
    if (url && projectOk) {
      if (url === stableUrl) stable += 1;
      else { stableUrl = url; stable = 1; }
      if (stable >= 2) return { probe: last, conversationUrl: url };
    } else {
      stable = 0;
      stableUrl = "";
    }
    await sleep(500);
  }
  throw new Error(`Stable server conversation URL did not appear before timeout: ${JSON.stringify(last)}`);
}

const page = await findPage();
const client = new CdpClient(page.webSocketDebuggerUrl);
try {
  await client.open();
  await client.call("Runtime.enable");
  await client.call("Page.enable");

  if (probeOnly) {
    if (conversationUrl) {
      const target = new URL(validateChatGptUrl(conversationUrl, "conversation"));
      const current = await evaluate(client, "location.href");
      let sameConversation = false;
      try {
        const here = new URL(String(current || ""));
        sameConversation = here.protocol === target.protocol && here.hostname === target.hostname && here.pathname === target.pathname;
      } catch {}
      if (!sameConversation) {
        await client.call("Page.navigate", { url: target.toString() });
        await sleep(1200);
      }
    }
    console.log(JSON.stringify({ ok:true, port, probe:await evaluate(client, expressionForContextProbe()) }));
    process.exitCode = 0;
  } else if (startContinuation) {
    const prompt = await readFile(promptFile, "utf8");
    const before = await evaluate(client, expressionForContextProbe());
    if (before.loginVisible) throw new Error("ChatGPT runtime is logged out.");
    // A managed compact handoff is itself initiated from an active MCP tool call,
    // so the ChatGPT UI will normally report `generating` here. Safety is enforced
    // by the backend worker/task boundary before this helper is invoked; do not
    // mistake the checkpoint tool call for unrelated in-flight task execution.

    if (projectUrl) {
      // The project landing page itself is the project-scoped fresh-chat
      // surface. Clicking the global New Chat control here escapes the project
      // and can drop project-bound tools/apps from the fresh conversation.
      await client.call("Page.navigate", { url: validateChatGptUrl(projectUrl, "project") });
      await sleep(1500);
      await waitForComposer(client);
    } else {
      if (conversationUrl) {
        await client.call("Page.navigate", { url: validateChatGptUrl(conversationUrl, "conversation") });
        await sleep(1000);
      }
      const beforeNewChat = await evaluate(client, expressionForContextProbe());
      const clicked = await evaluate(client, expressionForNewChat());
      if (!clicked?.ok) throw new Error(`Could not create new ChatGPT conversation: ${JSON.stringify(clicked)}`);
      await waitForFreshComposer(client, String(beforeNewChat?.href || ""));
    }
    const inserted = await evaluate(client, expressionForInsert(prompt));
    if (!inserted?.ok) throw new Error(`Could not insert continuation prompt: ${JSON.stringify(inserted)}`);
    await sleep(250);
    const sent = await evaluate(client, expressionForSend());
    if (!sent?.ok) {
      await client.call("Input.dispatchKeyEvent", { type:"keyDown", key:"Enter", code:"Enter", windowsVirtualKeyCode:13, nativeVirtualKeyCode:13 });
      await client.call("Input.dispatchKeyEvent", { type:"keyUp", key:"Enter", code:"Enter", windowsVirtualKeyCode:13, nativeVirtualKeyCode:13 });
    }

    const stable = await waitForStableConversation(client, waitSeconds * 1000, projectUrl);
    console.log(JSON.stringify({ ok:true, port, oldConversationUrl:before.href, newConversationUrl:stable.conversationUrl, generating:stable.probe.generating, projectScoped:Boolean(projectUrl) }));
  }
} finally {
  await client.close();
}
