#!/usr/bin/env node
import { ClassicCdpClient } from "../dist/classic-cdp-client.js";

const port = Number(process.argv[2] || 9732);
const expectedConversationId = String(process.argv[3] || "").trim();
const maxCandidates = Math.max(50, Math.min(2000, Number(process.argv[4] || 800)));

function publicPath(value) {
  try { return new URL(String(value)).pathname; }
  catch { return null; }
}

const listResponse = await fetch(`http://127.0.0.1:${port}/json/list`, {
  cache: "no-store",
  signal: AbortSignal.timeout(3000),
});
if (!listResponse.ok) throw new Error(`CDP target list failed on ${port}: HTTP ${listResponse.status}`);
const targets = await listResponse.json();
const page = Array.isArray(targets)
  ? targets.find((item) => item?.type === "page" && /chatgpt\.com/i.test(item.url || "") && item.webSocketDebuggerUrl)
  : null;
if (!page) throw new Error(`No ChatGPT page target on ${port}.`);
const actualConversationId = (() => {
  try { return new URL(page.url).pathname.match(/\/c\/([^/?#]+)/)?.[1] || null; }
  catch { return null; }
})();
if (expectedConversationId && actualConversationId !== expectedConversationId) {
  throw new Error(`Main-${port} is on ${actualConversationId || "no conversation"}, expected ${expectedConversationId}.`);
}
const conversationId = expectedConversationId || actualConversationId;
if (!conversationId) throw new Error("Conversation identity is unavailable.");

const client = new ClassicCdpClient(page.webSocketDebuggerUrl, { callTimeoutMs: 30000, maxPendingCalls: 8 });
try {
  await client.open();
  const expression = `(${async function probe(conversationId, maxCandidates) {
    const interesting = /(?:^|[._/-])(?:usage|tokens?|context|remaining|limit|input|output|cached|prompt|completion|capacity|budget|compact|summary)(?:$|[._/-])/i;
    const secret = /authorization|cookie|session|credential|password|secret|bearer|access[_-]?token|refresh[_-]?token/i;
    const content = /(?:^|[._/-])(?:content|text|message|messages|prompt|title|body|parts|attachments?|image|audio|video)(?:$|[._/-])/i;
    const endpointPaths = [
      "/backend-api/conversations/" + encodeURIComponent(conversationId),
      "/backend-api/conversation/" + encodeURIComponent(conversationId),
      "/backend-api/conversation/" + encodeURIComponent(conversationId) + "/stream_status",
      "/backend-api/conversation/" + encodeURIComponent(conversationId) + "/usage",
      "/backend-api/conversation/" + encodeURIComponent(conversationId) + "/context",
      "/backend-api/conversation/" + encodeURIComponent(conversationId) + "/compact",
    ];
    let accessToken = null;
    let authSessionStatus = null;
    try {
      const authResponse = await fetch('/api/auth/session', { credentials:'include', cache:'no-store' });
      authSessionStatus = authResponse.status;
      if (authResponse.ok) {
        const session = await authResponse.json();
        accessToken = typeof session?.accessToken === 'string' ? session.accessToken
          : typeof session?.access_token === 'string' ? session.access_token
            : null;
      }
    } catch {}
    const candidates = [];
    const interestingKeys = [];
    const payloadShapes = [];
    const messageMetadataSummaries = [];
    const endpoints = [];
    const seen = new WeakSet();
    const summarizeMessageMetadata = (payload, path) => {
      const tokenPathCounts = new Map();
      const tokenValues = new Map();
      const scanMetadata = (value, prefix = 'metadata', depth = 0) => {
        if (depth > 8 || value == null) return;
        if (Array.isArray(value)) {
          for (let index = 0; index < Math.min(value.length, 200); index += 1) scanMetadata(value[index], prefix + '[' + index + ']', depth + 1);
          return;
        }
        if (typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
          if (secret.test(key)) continue;
          const childPath = prefix + '.' + key;
          if (typeof child === 'number' && Number.isFinite(child) && /token|context|usage|count|limit|remaining/i.test(key)
            && !/time|timestamp|latency|width|height|size|index|weight/i.test(key)) {
            tokenPathCounts.set(childPath, (tokenPathCounts.get(childPath) || 0) + 1);
            if (!tokenValues.has(childPath)) tokenValues.set(childPath, []);
            const values = tokenValues.get(childPath);
            if (values.length < 12) values.push(child);
          } else if (child && typeof child === 'object') {
            scanMetadata(child, childPath, depth + 1);
          }
        }
      };
      const summarizeMessage = (message) => {
        if (!message || typeof message !== 'object') return null;
        scanMetadata(message.metadata || {}, 'metadata');
        const contentTokenCount = Number(message?.metadata?.message_content_token_count);
        return {
          role:typeof message?.author?.role === 'string' ? message.author.role : typeof message?.role === 'string' ? message.role : null,
          contentTokenCount:Number.isFinite(contentTokenCount) && contentTokenCount >= 0 ? contentTokenCount : null,
          metadataKeys:message.metadata && typeof message.metadata === 'object' ? Object.keys(message.metadata).sort().filter((key) => /token|context|usage|count|limit|remaining/i.test(key)).slice(0, 40) : [],
        };
      };
      const all = [];
      if (Array.isArray(payload?.messages)) {
        for (const item of payload.messages.slice(0, 10_000)) {
          const message = item?.message && typeof item.message === 'object' ? item.message : item;
          const summary = summarizeMessage(message);
          if (summary) all.push(summary);
        }
      } else if (payload?.mapping && typeof payload.mapping === 'object') {
        for (const node of Object.values(payload.mapping)) {
          const summary = summarizeMessage(node?.message);
          if (summary) all.push(summary);
        }
      }
      const branch = [];
      if (payload?.mapping && typeof payload.mapping === 'object' && typeof payload.current_node === 'string') {
        const visited = new Set();
        let nodeId = payload.current_node;
        while (nodeId && !visited.has(nodeId) && branch.length < 10_000) {
          visited.add(nodeId);
          const node = payload.mapping[nodeId];
          if (!node) break;
          const summary = summarizeMessage(node.message);
          if (summary) branch.push(summary);
          nodeId = typeof node.parent === 'string' ? node.parent : null;
        }
        branch.reverse();
      }
      const withCounts = (rows) => rows.filter((item) => Number.isFinite(item.contentTokenCount));
      const allWithCounts = withCounts(all);
      const branchWithCounts = withCounts(branch);
      return {
        path,
        allMessageCount:all.length,
        allWithContentTokenCount:allWithCounts.length,
        allContentTokenSum:allWithCounts.reduce((sum, item) => sum + item.contentTokenCount, 0),
        currentBranchMessageCount:branch.length,
        currentBranchWithContentTokenCount:branchWithCounts.length,
        currentBranchContentTokenSum:branchWithCounts.reduce((sum, item) => sum + item.contentTokenCount, 0),
        currentBranchRoleCounts:branch.reduce((result, item) => { const key = item.role || 'unknown'; result[key] = (result[key] || 0) + 1; return result; }, {}),
        tokenMetadataPaths:[...tokenPathCounts.entries()].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 80).map(([metadataPath, count]) => ({ metadataPath, count, sampleValues:tokenValues.get(metadataPath) || [] })),
      };
    };
    const collect = (value, path = "root", depth = 0) => {
      if (candidates.length >= maxCandidates || depth > 20 || value == null) return;
      if (typeof value !== "object") {
        if (!interesting.test(path) || secret.test(path) || content.test(path)) return;
        if (typeof value === "number" && Number.isFinite(value)) {
          candidates.push({ path: path.slice(0, 600), value, valueType: "number" });
        } else if (typeof value === "boolean") {
          candidates.push({ path: path.slice(0, 600), value, valueType: "boolean" });
        } else if (typeof value === "string" && value.length <= 160 && /^[A-Za-z0-9_.:/-]+$/.test(value)) {
          candidates.push({ path: path.slice(0, 600), value, valueType: "enum-string" });
        }
        return;
      }
      if (seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        for (let index = 0; index < Math.min(value.length, 500) && candidates.length < maxCandidates; index += 1) {
          collect(value[index], path + "[" + index + "]", depth + 1);
        }
        return;
      }
      for (const key of Object.keys(value).sort()) {
        if (secret.test(key)) continue;
        const childPath = path + "." + key;
        if (interesting.test(key) || /compact|summary|finish|metadata|model_slug|system_hints/i.test(key)) {
          const child = value[key];
          interestingKeys.push({
            path: childPath.slice(0, 600),
            valueType: Array.isArray(child) ? 'array' : child === null ? 'null' : typeof child,
            ...(typeof child === 'number' && Number.isFinite(child) ? { numericValue: child } : {}),
            ...(typeof child === 'boolean' ? { booleanValue: child } : {}),
            ...(typeof child === 'string' && child.length <= 120 && /^[A-Za-z0-9_.:/ -]+$/.test(child) ? { enumValue: child } : {}),
          });
        }
        if (content.test(key) && !interesting.test(key)) continue;
        collect(value[key], childPath, depth + 1);
        if (candidates.length >= maxCandidates) break;
      }
    };
    for (const path of endpointPaths) {
      try {
        const response = await fetch(path, {
          credentials: "include",
          cache: "no-store",
          headers: accessToken ? { authorization: 'Bearer ' + accessToken } : undefined,
        });
        const contentType = String(response.headers.get("content-type") || "");
        const row = {
          path,
          status: response.status,
          ok: response.ok,
          contentType: contentType.slice(0, 160),
          contentLength: Number(response.headers.get("content-length") || 0) || null,
          relevantHeaders: {},
        };
        for (const [key, value] of response.headers.entries()) {
          if (interesting.test(key) && !secret.test(key)) row.relevantHeaders[key] = String(value).slice(0, 160);
        }
        let payload = null;
        if (/json/i.test(contentType)) {
          try { payload = await response.json(); } catch {}
        } else {
          const text = await response.text();
          if (text.length <= 5_000_000) {
            try { payload = JSON.parse(text); } catch {
              const events = [];
              for (const line of text.split(/\r?\n/)) {
                const match = line.match(/^data:\s*(.*)$/);
                if (!match || !match[1] || match[1] === "[DONE]") continue;
                try { events.push(JSON.parse(match[1])); } catch {}
                if (events.length >= 500) break;
              }
              if (events.length) payload = events;
            }
          }
        }
        row.payloadParsed = payload != null;
        endpoints.push(row);
        if (payload != null) {
          payloadShapes.push({
            path,
            valueType:Array.isArray(payload) ? 'array' : payload === null ? 'null' : typeof payload,
            topLevelKeys:payload && typeof payload === 'object' && !Array.isArray(payload) ? Object.keys(payload).sort().slice(0, 120) : [],
            topLevelArrayLength:Array.isArray(payload) ? payload.length : null,
            mappingType:Array.isArray(payload?.mapping) ? 'array' : payload?.mapping && typeof payload.mapping === 'object' ? 'object' : payload?.mapping === null ? 'null' : typeof payload?.mapping,
            mappingCount:payload?.mapping && typeof payload.mapping === 'object' ? Object.keys(payload.mapping).length : null,
            currentNodePresent:Boolean(payload?.current_node),
          });
          messageMetadataSummaries.push(summarizeMessageMetadata(payload, path));
          collect(payload, "endpoint:" + path, 0);
        }
      } catch (error) {
        endpoints.push({ path, status: null, ok: false, errorName: error?.name || "Error" });
      }
    }
    const resourceCandidates = Array.from(new Set(performance.getEntriesByType("resource")
      .map((entry) => String(entry.name || ""))
      .filter((url) => /(?:usage|token|context|compact|conversation)/i.test(url))))
      .slice(0, 300)
      .map((url) => {
        try {
          const parsed = new URL(url);
          return { origin: parsed.origin === location.origin ? "same-origin" : "other", path: parsed.pathname.slice(0, 500), queryKeys: Array.from(parsed.searchParams.keys()).filter((key) => !secret.test(key)).slice(0, 30) };
        } catch { return null; }
      }).filter(Boolean);
    return {
      conversationId,
      locationPath: location.pathname,
      endpointCount: endpoints.length,
      endpoints,
      payloadShapes,
      messageMetadataSummaries,
      authSessionStatus,
      authenticatedBackendFetch: Boolean(accessToken),
      candidateCount: candidates.length,
      candidates,
      interestingKeyCount: interestingKeys.length,
      interestingKeys: interestingKeys.slice(0, maxCandidates),
      resourceCandidates,
      rawConversationContentReturned: false,
      credentialsReturned: false,
      pageMutationCount: 0,
    };
  }.toString()})(${JSON.stringify(conversationId)}, ${maxCandidates})`;
  const response = await client.call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response?.exceptionDetails) throw new Error(response.exceptionDetails.text || "Native exact-usage probe failed.");
  const result = response?.result?.value;
  if (!result || result.conversationId !== conversationId) throw new Error("Exact-usage probe returned no authoritative conversation result.");
  console.log(JSON.stringify({
    ok: true,
    gate: "classic-exact-usage-probe",
    port,
    targetPath: publicPath(page.url),
    ...result,
  }, null, 2));
} finally {
  client.close();
}
