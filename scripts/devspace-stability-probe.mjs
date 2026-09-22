#!/usr/bin/env node
// Read-only operational evidence. No restart, navigation, input or credential read.
import { ClassicCdpClient } from '../dist/classic-cdp-client.js';
import { defaultMainDebugPorts } from '../dist/goal-host-bridge.js';

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const conversationId = args.includes('--conversation-id') ? option('--conversation-id') : null;
const needle = args.includes('--needle') ? option('--needle') : null;
if (!conversationId || !/^[A-Za-z0-9_-]{8,200}$/.test(conversationId)) {
  throw new Error('--conversation-id is required; this probe never guesses the current chat');
}
const base = 'http://127.0.0.1:7678';
async function get(url) {
  const began = performance.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4_000), cache: 'no-store' });
    return { ok: response.ok, status: response.status, elapsedMs: Math.round(performance.now() - began), value: await response.json() };
  } catch (error) {
    return { ok: false, elapsedMs: Math.round(performance.now() - began), error: error.name };
  }
}
const [health, memory, progress, live] = await Promise.all([
  get(base + '/healthz'), get(base + '/__devspace/memory/status'),
  get(base + '/__devspace/progress'), get(base + '/__devspace/live/snapshot'),
]);
const rows = (progress.value?.messages || []).filter((x) => x.conversationId === conversationId);
const pages = [];
for (const port of defaultMainDebugPorts({ includeObserved: true, refresh: true })) {
  const targets = await get(`http://127.0.0.1:${port}/json/list`);
  if (!targets.ok || !Array.isArray(targets.value)) continue;
  for (const target of targets.value) {
    if (target.type !== 'page' || !target.webSocketDebuggerUrl) continue;
    let url;
    try { url = new URL(target.url); } catch { continue; }
    if (url.hostname !== 'chatgpt.com' || url.pathname.match(/\/c\/([^/?#]+)/)?.[1] !== conversationId) continue;
    const client = new ClassicCdpClient(target.webSocketDebuggerUrl, { callTimeoutMs: 2_000, maxPendingCalls: 2 });
    try {
      await client.open();
      const expression = `(() => {
        const root = document.getElementById('devspace-progress-narration-root');
        const rect = root?.getBoundingClientRect();
        const messages = Array.from(root?.querySelectorAll('.devspace-progress-message-text') || []).map(x => x.textContent || '');
        const needle = ${JSON.stringify(needle)};
        return { mounted: !!root, visible: !!root && root.dataset.visible === 'true' && rect?.width > 0 && rect?.height > 0,
          owner: root?.dataset.conversationId || null, renderedMessages: messages.length,
          latestRenderedText: messages.at(-1) || null,
          latestBufferedText: root?.__devspaceProgressMessages?.at(-1)?.text || null,
          lastProjectionAt: root?.__devspaceProgressLastProjectionAt || null,
          producer: globalThis.__devspaceProgressNarrationLeaseV1 || null,
          needleVisible: needle ? messages.some(x => x.includes(needle)) : null };
      })()`;
      const result = await client.call('Runtime.evaluate', { expression, returnByValue: true });
      pages.push({ port, ...(result?.result?.value || { error: 'unavailable-dom-result' }) });
    } catch (error) { pages.push({ port, error: error.name }); }
    finally { client.close(); }
  }
}
const m = memory.value || {};
const r = m.registries || {};
const endpoint = ({ ok, status, elapsedMs, error }) => ({ ok, status, elapsedMs, error });
console.log(JSON.stringify({
  observedAt: new Date().toISOString(), conversationId,
  endpoints: { health: endpoint(health), memory: endpoint(memory), progress: endpoint(progress), live: endpoint(live) },
  core: { pid: m.pid, uptimeSeconds: m.uptimeSeconds },
  gateway: { activePid: live.value?.gateway?.activePid, fatal: live.value?.gateway?.fatal, admissionClosed: live.value?.gateway?.admission?.closed },
  features: m.features,
  claims: { pending: r.progressClaimsPending, completed: r.progressClaimsCompleted, rejected: r.progressClaimsRejected },
  nativeCorrelation: { observedToolInvocations: r.classicToolInvocationsObserved, resolvedCalls: r.mcpCallCorrelationsResolved },
  progressProjection: m.progressProjection,
  latestReport: rows.length ? { at: rows.at(-1).at, source: rows.at(-1).ownershipSource, text: rows.at(-1).text } : null,
  needlePersisted: needle ? rows.some(x => x.text?.includes(needle)) : null,
  pages, duplicateDisplays: pages.length > 1,
  cardAcceptancePassed: needle ? rows.some(x => x.text?.includes(needle)) && pages.length > 0 && pages.every(x => x.visible && x.needleVisible) : null,
  allFeaturesValidated: false,
}, null, 2));
process.exitCode = ![health, memory, progress, live].every(x => x.ok) ? 1
  : needle && (!rows.some(x => x.text?.includes(needle)) || !pages.length || !pages.every(x => x.visible && x.needleVisible)) ? 2 : 0;
