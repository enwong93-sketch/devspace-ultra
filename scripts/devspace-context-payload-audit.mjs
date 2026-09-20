import { ClassicCdpClient } from '../dist/classic-cdp-client.js';
import { summarizeContextPayload } from '../dist/context-payload-audit.js';
const [portText, id] = process.argv.slice(2);
const port = Number(portText);
if (![9721, ...Array.from({ length: 31 }, (_, i) => 9732 + i)].includes(port)
  || !/^[A-Za-z0-9_-]{8,200}$/.test(id || '')) throw new Error('Requires exact managed port and conversation ID');
const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) }).then(r => r.json());
const matches = targets.filter(t => {
  try { const u = new URL(t.url); return t.type === 'page' && u.hostname === 'chatgpt.com' && u.pathname.match(/\/c\/([^/?#]+)/)?.[1] === id; }
  catch { return false; }
});
if (matches.length !== 1) throw new Error('Exact page not uniquely found; no navigation permitted');
const client = new ClassicCdpClient(matches[0].webSocketDebuggerUrl, { callTimeoutMs: 15000, maxPendingCalls: 2 });
try {
  await client.open();
  const expression = `(${async function audit(id, summarize) {
    if (location.hostname !== 'chatgpt.com' || location.pathname.match(/\/c\/([^/?#]+)/)?.[1] !== id) return { ok: false, reason: 'page-changed' };
    const sessionResponse = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(4000) });
    const session = sessionResponse.ok ? await sessionResponse.json() : null;
    const access = session?.accessToken || session?.access_token;
    const response = await fetch('/backend-api/conversation/' + encodeURIComponent(id), {
      credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(8000),
      headers: access ? { authorization: 'Bearer ' + access } : undefined,
    });
    if (!response.ok) return { ok: false, status: response.status, rawContentReturned: false };
    const payload = await response.json();
    return summarize(payload);
  }.toString()})(${JSON.stringify(id)}, (${summarizeContextPayload.toString()}))`;
  const result = await client.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  const value = result?.result?.value;
  console.log(JSON.stringify({ observedAt: new Date().toISOString(), conversationId: id, port, ...(value || { ok: false, reason: 'evaluation-failed' }) }, null, 2));
  if (value?.ok !== true) process.exitCode = 1;
} finally { client.close(); }
