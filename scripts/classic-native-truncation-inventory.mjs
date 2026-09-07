#!/usr/bin/env node
import assert from "node:assert/strict";
import { ClassicCdpClient } from "../dist/classic-cdp-client.js";

const port = Math.max(1, Math.min(65535, Number(process.argv[2] || 9732)));
const limit = Math.max(1, Math.min(200, Number(process.argv[3] || 100)));

const targets = await fetch(`http://127.0.0.1:${port}/json/list`, {
  cache: "no-store",
  signal: AbortSignal.timeout(3_000),
}).then((response) => response.json());
const page = Array.isArray(targets)
  ? targets.find((item) => item?.type === "page" && /chatgpt\.com/i.test(item.url || "") && item.webSocketDebuggerUrl)
  : null;
assert.ok(page, `ChatGPT page target was not found on CDP port ${port}.`);

const client = new ClassicCdpClient(page.webSocketDebuggerUrl, { callTimeoutMs: 120_000, maxPendingCalls: 4 });
try {
  await client.open();
  const expression = `(${async function inventory(limit) {
    const authResponse = await fetch('/api/auth/session', { credentials:'include', cache:'no-store' });
    if (!authResponse.ok) return { ok:false, stage:'auth', status:authResponse.status };
    const session = await authResponse.json();
    const accessToken = typeof session?.accessToken === 'string' ? session.accessToken
      : typeof session?.access_token === 'string' ? session.access_token
        : null;
    if (!accessToken) return { ok:false, stage:'auth-token-missing', status:authResponse.status };
    const headers = { authorization:'Bearer ' + accessToken };
    const listPaths = [
      '/backend-api/conversations?offset=0&limit=' + limit + '&order=updated',
      '/backend-api/conversations?offset=0&limit=' + limit,
    ];
    let listPayload = null;
    let listPath = null;
    let listStatus = null;
    for (const path of listPaths) {
      const response = await fetch(path, { credentials:'include', cache:'no-store', headers });
      listStatus = response.status;
      if (!response.ok) continue;
      const payload = await response.json();
      if (Array.isArray(payload?.items) || Array.isArray(payload)) {
        listPayload = payload;
        listPath = path;
        break;
      }
    }
    if (!listPayload) return { ok:false, stage:'list', status:listStatus };
    const items = Array.isArray(listPayload) ? listPayload : listPayload.items;
    const ids = [];
    for (const item of items || []) {
      const id = typeof item?.id === 'string' ? item.id
        : typeof item?.conversation_id === 'string' ? item.conversation_id
          : null;
      if (id && !ids.includes(id)) ids.push(id);
      if (ids.length >= limit) break;
    }
    const results = [];
    const fetchOne = async (id) => {
      const paths = ['/backend-api/conversations/' + encodeURIComponent(id), '/backend-api/conversation/' + encodeURIComponent(id)];
      for (const path of paths) {
        try {
          const response = await fetch(path, { credentials:'include', cache:'no-store', headers });
          if (!response.ok) continue;
          const payload = await response.json();
          const continuation = payload?.context_truncation_continuation;
          const fields = continuation && typeof continuation === 'object' ? {
            sourceConversationId: typeof continuation.source_conversation_id === 'string' ? continuation.source_conversation_id : null,
            boundaryMessageId: typeof continuation.boundary_message_id === 'string' ? continuation.boundary_message_id : null,
            visibleFromMessageId: typeof continuation.visible_from_message_id === 'string' ? continuation.visible_from_message_id : null,
            sourceConversationGizmoId: typeof continuation.source_conversation_gizmo_id === 'string' ? continuation.source_conversation_gizmo_id : null,
            sourceConversationOwnerIdPresent: Boolean(continuation.source_conversation_owner_id),
            keys: Object.keys(continuation).sort().slice(0, 40),
          } : null;
          return {
            conversationId:id,
            createTime:Number(payload?.create_time || 0) || null,
            updateTime:Number(payload?.update_time || 0) || null,
            defaultModelSlug:typeof payload?.default_model_slug === 'string' ? payload.default_model_slug : null,
            currentNodePresent:Boolean(payload?.current_node),
            mappingCount:payload?.mapping && typeof payload.mapping === 'object' ? Object.keys(payload.mapping).length : null,
            hasContextTruncationContinuation:Boolean(fields),
            contextTruncationContinuation:fields,
          };
        } catch {}
      }
      return { conversationId:id, fetchFailed:true };
    };
    for (let index = 0; index < ids.length; index += 5) {
      const batch = await Promise.all(ids.slice(index, index + 5).map(fetchOne));
      results.push(...batch);
    }
    const continuations = results.filter((item) => item.hasContextTruncationContinuation);
    return {
      ok:true,
      listPath,
      listStatus:200,
      listed:ids.length,
      fetched:results.filter((item) => !item.fetchFailed).length,
      continuationCount:continuations.length,
      continuations,
      recent:results.slice(0, 20),
      rawMessageContentReturned:false,
      rawCredentialsReturned:false,
      pageMutationCount:0,
    };
  }.toString()})(${limit})`;
  const response = await client.call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response?.exceptionDetails) throw new Error(response.exceptionDetails.text || "Native truncation inventory failed.");
  const result = response?.result?.value;
  assert.equal(result?.ok, true, `Native truncation inventory failed at ${result?.stage || "unknown"} (HTTP ${result?.status ?? "unknown"}).`);
  console.log(JSON.stringify({
    ok:true,
    gate:"classic-native-truncation-inventory",
    port,
    pagePath:new URL(page.url).pathname,
    ...result,
  }, null, 2));
} finally {
  client.close();
}
