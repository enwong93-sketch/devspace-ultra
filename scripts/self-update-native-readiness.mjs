import { pathToFileURL } from 'node:url';
import { inspectGoalContinuationPages } from '../dist/goal-host-bridge.js';
import { nativeApiFinalFromPages } from '../dist/classic-native-final-ingress.js';
import { runtimeKeyForClassicPort } from '../dist/classic-main-debug-ports.js';

// Read-only maintenance input, not a Goal dispatch or a client acceptance test.
// The operator supplies the complete set of local Classic ports using this
// Gateway. Omitted/unknown ownership must defer a live update, not infer idle.
export async function inspectNativeMaintenance(ports, {
  listTargets = async port => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error('native-target-inventory-unavailable');
    return response.json();
  },
  inspect = inspectGoalContinuationPages,
  now = Date.now,
} = {}) {
  const fail = reason => ({ ok: false, ready: false, reason });
  if (!Array.isArray(ports) || !ports.length || ports.length > 32
    || new Set(ports).size !== ports.length
    || ports.some(port => !Number.isInteger(port) || !/^main-\d{2}$/.test(runtimeKeyForClassicPort(port)))) {
    return fail('native-maintenance-scope-unavailable');
  }
  try {
    const inventory = async () => {
      const scopes = [];
      for (const port of ports) {
        const targets = await listTargets(port);
        if (!Array.isArray(targets)) throw new Error('native-target-inventory-unavailable');
        const pages = targets.filter(target => target?.type === 'page' && /^https:\/\/chatgpt\.com(?:\/|$)/i.test(target.url || ''));
        if (!pages.length || pages.length > 4) throw new Error('native-page-ownership-unavailable');
        for (const page of pages) {
          const url = new URL(page.url);
          const conversationId = url.pathname.match(/\/c\/([A-Za-z0-9_-]{8,200})(?:\/|$)/)?.[1];
          if (!conversationId || url.searchParams.get('surface') === 'work' || !page.id || !page.webSocketDebuggerUrl) {
            throw new Error('native-page-ownership-unavailable');
          }
          scopes.push({ port, runtimeKey: runtimeKeyForClassicPort(port), pageTargetId: page.id, conversationId });
        }
      }
      return scopes.sort((a,b) => `${a.port}:${a.pageTargetId}`.localeCompare(`${b.port}:${b.pageTargetId}`));
    };
    const scopes = await inventory();
    const sample = async scope => {
      const readStartedAtMs = now();
      const goal = { conversationId: scope.conversationId };
      const pages = await inspect(goal, { ports: [scope.port], runtimeKey: scope.runtimeKey,
        pageTargetId: scope.pageTargetId, skipNativeStatus: true, includeNativeBranch: true,
        nativeFinalApiOnly: true, nativeConversationTimeoutMs: 5_000 });
      const receipt = nativeApiFinalFromPages(goal, pages, { readStartedAtMs, observedAtMs: now() });
      if (!receipt) throw new Error('native-current-turn-not-completed');
      return receipt;
    };
    const first = [];
    for (const scope of scopes) first.push(await sample(scope));
    if (JSON.stringify(scopes) !== JSON.stringify(await inventory())) return fail('native-page-owner-changed');
    const finalReceipts = [];
    for (let index=0; index<scopes.length; index++) {
      const receipt = await sample(scopes[index]);
      const old = first[index];
      if (receipt.assistantMessageId !== old.assistantMessageId
        || receipt.sourceUserMessageId !== old.sourceUserMessageId
        || receipt.assistantTextHash !== old.assistantTextHash) return fail('native-current-turn-changed');
      finalReceipts.push(receipt);
    }
    if (JSON.stringify(scopes) !== JSON.stringify(await inventory())) return fail('native-page-owner-changed');
    return { ok: true, ready: true, scope: 'operator-declared-Gateway-Classic-owners',
      atomicAdmissionBarrier: false, observedAtMs: now(), finalReceipts };
  } catch {
    // Do not print native response text, auth errors, cookies or final prose.
    return fail('native-maintenance-proof-unavailable');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ports = String(process.argv[2] || '').split(',').filter(Boolean).map(Number);
  console.log(JSON.stringify(await inspectNativeMaintenance(ports)));
}
