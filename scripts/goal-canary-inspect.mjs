// Read-only inspection of the previously reserved Main-06 canary, never other chats.
import { ClassicCdpClient } from '../dist/classic-cdp-client.js';
const expected = '6aacc828-96f0-83e8-b368-a550e2c8ae27';
const targets = await fetch('http://127.0.0.1:9736/json/list', {signal:AbortSignal.timeout(2000)}).then(r=>r.json());
const target = targets.find(t => t.type === 'page' && new URL(t.url).hostname === 'chatgpt.com'
  && new URL(t.url).pathname.match(/\/c\/([^/?#]+)/)?.[1] === expected);
if (!target) throw new Error('Reserved canary page not present');
const c = new ClassicCdpClient(target.webSocketDebuggerUrl,{callTimeoutMs:3000,maxPendingCalls:4});
await c.open();
try {
  const result = await c.call('Runtime.evaluate',{returnByValue:true, expression:`(() => {
    const nodes=Array.from(document.querySelectorAll('[data-message-author-role]'));
    return {conversationId:location.pathname.match(/\\/c\\/([^/?#]+)/)?.[1],
      generating:!!document.querySelector('[data-testid="stop-button"]'),
      composer:String(document.querySelector('#prompt-textarea')?.textContent || '').slice(0,100),
      editorMarkup:String(document.querySelector('#prompt-textarea')?.innerHTML || '').slice(0,5000),
      latest:nodes.slice(-4).map(n=>({role:n.getAttribute('data-message-author-role'),id:n.getAttribute('data-message-id'),text:(n.innerText||'').slice(0,1500)}))};
  })()`});
  console.log(JSON.stringify(result.result?.value,null,2));
} finally { c.close(); }
