#!/usr/bin/env node
const port = Number(process.argv[2] || 9732);
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { cache: 'no-store' })).json();
const page = Array.isArray(list) ? list.find((item) => item?.type === 'page' && /chatgpt\.com/i.test(item.url || '') && item.webSocketDebuggerUrl) : null;
if (!page) throw new Error(`No ChatGPT page target on ${port}`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', (event) => reject(event?.error || new Error('CDP websocket failed')), { once: true });
});
let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (event) => {
  let message;
  try { message = JSON.parse(String(event.data)); } catch { return; }
  if (!message?.id) return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
  else entry.resolve(message.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
try {
  await call('Runtime.enable');
  const expression = `(() => {
    const needles = [
      '訊息遞送逾時', '訊息遞送超時', 'Message delivery timed out',
      '請再試一次', 'Please try again', '安全檢查', 'safety check',
      'requires additional safety checks', 'additional safety check'
    ];
    const nodes = [...document.querySelectorAll('body *')];
    const hits = nodes.filter((el) => {
      const text = (el.innerText || el.textContent || '').trim();
      if (!text || text.length > 1200) return false;
      return needles.some((needle) => text.toLowerCase().includes(needle.toLowerCase()));
    }).slice(0, 40).map((el) => {
      const pick = (node) => {
        const attrs = {};
        for (const attr of node?.attributes || []) {
          if (['class','role','data-testid','aria-label','data-state','data-status'].includes(attr.name)) attrs[attr.name] = attr.value;
        }
        return attrs;
      };
      const parent = el.parentElement;
      const grand = parent?.parentElement;
      return {
        tag: el.tagName,
        text: (el.innerText || el.textContent || '').trim().slice(0, 500),
        attrs: pick(el),
        parentTag: parent?.tagName || null,
        parentAttrs: pick(parent),
        grandTag: grand?.tagName || null,
        grandAttrs: pick(grand),
      };
    });
    const match = location.pathname.match(/\\/c\\/([^/?#]+)/);
    const conversationId = match?.[1] || null;
    const retryButtons = [...document.querySelectorAll('button')].filter((button) => /^(重試|Retry|再試一次|Try again)$/i.test((button.innerText || button.textContent || '').trim())).map((button) => ({
      text: (button.innerText || button.textContent || '').trim(),
      testid: button.getAttribute('data-testid'),
      aria: button.getAttribute('aria-label'),
      disabled: button.disabled,
      className: String(button.className || '').slice(0, 300),
    }));
    return {
      href: location.href,
      conversationId,
      generating: Boolean(document.querySelector('button[data-testid="stop-button"]')),
      retryButtons,
      hits,
      bodyTextTail: (document.body?.innerText || '').slice(-2500),
    };
  })()`;
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
  const value = result?.result?.value || null;
  if (value?.conversationId) {
    const streamExpression = `(async()=>{try{const response=await fetch('/backend-api/conversation/${value.conversationId}/stream_status',{credentials:'include',cache:'no-store'});return {http:response.status,text:await response.text()}}catch(error){return {error:String(error)}}})()`;
    const stream = await call('Runtime.evaluate', { expression: streamExpression, returnByValue: true, awaitPromise: true });
    value.streamStatus = stream?.result?.value || null;
  }
  console.log(JSON.stringify({ ok: true, port, pageTargetId: page.id, ...value }, null, 2));
} finally {
  try { ws.close(); } catch {}
}
