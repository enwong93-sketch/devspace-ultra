#!/usr/bin/env node
import { createHash } from "node:crypto";
import { ClassicCdpClient } from "../dist/classic-cdp-client.js";

const port = Number(process.argv[2] || 9732);
const maxScripts = Math.max(20, Math.min(800, Number(process.argv[3] || 500)));
const maxMatches = Math.max(20, Math.min(1000, Number(process.argv[4] || 300)));
const minScore = Math.max(-100, Math.min(200, Number(process.argv[5] || -100)));
const maxBytes = 24 * 1024 * 1024;

const patterns = [
  { name: "exact-input-tokens", regex: /input[_-]?tokens?|inputTokens?|prompt[_-]?tokens?|promptTokens?|total[_-]?input[_-]?tokens?|totalInputTokens?/ig, weight: 100 },
  { name: "exact-total-tokens", regex: /total[_-]?tokens?|totalTokens?|tokens?[_-]?used|tokensUsed|used[_-]?tokens?|usedTokens?|token[_-]?count|tokenCount|num[_-]?tokens?|numTokens?/ig, weight: 90 },
  { name: "remaining-tokens", regex: /remaining[_-]?(?:context[_-]?)?tokens?|remainingTokens?|tokens?[_-]?remaining|tokensRemaining|available[_-]?tokens?|availableTokens?/ig, weight: 85 },
  { name: "usage-object", regex: /(?:^|[^A-Za-z0-9])usage(?:[^A-Za-z0-9]|$)|usageMetadata|tokenUsage|contextUsage/ig, weight: 45 },
  { name: "context-window", regex: /context[_-]?(?:window|length|limit|size|tokens?|used)|contextWindow|contextLength|contextLimit|contextSize|contextTokens?|contextUsed/ig, weight: 55 },
  { name: "compact", regex: /auto[_-]?compact|autoCompact|compaction|compact[_-]?(?:conversation|context)|compactConversation|compactContext|conversation[_-]?compact|conversationCompact|context[_-]?truncation[_-]?continuation|contextTruncationContinuation|truncation[_-]?continuation|continuationBranch|boundary[_-]?message[_-]?id|visible[_-]?from[_-]?message[_-]?id|source[_-]?conversation[_-]?id|input[_-]?too[_-]?large/ig, weight: 95 },
  { name: "token-endpoint", regex: /\/(?:backend-api|api|v1|v2)\/[^"'`\s]{0,220}(?:usage|tokens?|context|compact)[^"'`\s]{0,220}/ig, weight: 85 },
];
const noise = /(?:analytics|telemetry|billing|subscription|rate[_-]?limit|image[_-]?tokens?|audio[_-]?tokens?|credits?|pricing|quota|usage[_-]?limit|daily|weekly)/i;
const secret = /authorization|cookie|bearer|access[_-]?token|refresh[_-]?token|password|credential/i;

function hash(value) { return createHash("sha256").update(String(value)).digest("hex"); }
function publicUrl(value) { try { const u = new URL(String(value)); return { host: u.hostname, path: u.pathname.slice(0, 500) }; } catch { return { host: null, path: null }; } }
function cleanSnippet(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/(?:authorization|cookie|bearer|access[_-]?token|refresh[_-]?token|password|credential)\s*[:=]\s*["'][^"']+["']/ig, "$1:[redacted]")
    .slice(0, 900);
}

const list = await fetch(`http://127.0.0.1:${port}/json/list`, { cache: "no-store", signal: AbortSignal.timeout(3000) }).then((response) => response.json());
const page = Array.isArray(list) ? list.find((item) => item?.type === "page" && /chatgpt\.com/i.test(item.url || "") && item.webSocketDebuggerUrl) : null;
if (!page) throw new Error(`No ChatGPT page target on ${port}.`);
const client = new ClassicCdpClient(page.webSocketDebuggerUrl, { callTimeoutMs: 20000, maxPendingCalls: 8 });
try {
  await client.open();
  await client.call("Page.enable").catch(() => {});
  const [response, resourceTree] = await Promise.all([
    client.call("Runtime.evaluate", {
      expression: `(() => Array.from(new Set([
        ...performance.getEntriesByType('resource').map((entry) => String(entry.name || '')),
        ...Array.from(document.scripts || []).map((node) => String(node.src || '')),
        ...Array.from(document.querySelectorAll('link[href]')).map((node) => String(node.href || '')),
      ].filter((url) => url && /(?:chatgpt\\.com|oaistatic\\.com)/i.test(url) && /(?:\\.js(?:\\?|$)|\\/_next\\/static\\/|\\/assets\\/)/i.test(url)))).slice(0, ${maxScripts}))()`,
      returnByValue: true,
      awaitPromise: false,
    }),
    client.call("Page.getResourceTree").catch(() => null),
  ]);
  const runtimeUrls = Array.isArray(response?.result?.value) ? response.result.value : [];
  const treeUrls = [];
  const visitFrame = (frame) => {
    for (const resource of frame?.resources || []) {
      const url = String(resource?.url || "");
      if ((resource?.type === "Script" || /(?:\.js(?:\?|$)|\/_next\/static\/|\/assets\/)/i.test(url))
        && /(?:chatgpt\.com|oaistatic\.com)/i.test(url)) treeUrls.push(url);
    }
    for (const child of frame?.childFrames || []) visitFrame(child);
  };
  visitFrame(resourceTree?.frameTree);
  const urls = [...new Set([...runtimeUrls, ...treeUrls])].slice(0, maxScripts);
  const matches = [];
  let fetched = 0;
  let totalBytes = 0;
  for (const url of urls) {
    if (matches.length >= maxMatches) break;
    let source;
    try {
      const result = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(20000), headers: { "user-agent": "DevSpace-Ultra-Native-Usage-Research/0.5" } });
      if (!result.ok) continue;
      const declared = Number(result.headers.get("content-length") || 0);
      if (declared > maxBytes) continue;
      const buffer = Buffer.from(await result.arrayBuffer());
      if (buffer.length > maxBytes) continue;
      source = buffer.toString("utf8");
      fetched += 1;
      totalBytes += buffer.length;
    } catch { continue; }
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      let match;
      let perPattern = 0;
      while ((match = pattern.regex.exec(source)) && perPattern < 20 && matches.length < maxMatches) {
        const start = Math.max(0, match.index - 280);
        const end = Math.min(source.length, match.index + match[0].length + 480);
        const snippet = cleanSnippet(source.slice(start, end));
        if (secret.test(snippet)) continue;
        let score = pattern.weight;
        if (/conversation|thread|message|model|reasoning/i.test(snippet)) score += 20;
        if (/backend-api|fetch\(|method|response|request|metadata/i.test(snippet)) score += 15;
        if (/input[_-]?tokens?|prompt[_-]?tokens?|total[_-]?tokens?/i.test(snippet)) score += 20;
        if (noise.test(snippet)) score -= 35;
        const pub = publicUrl(url);
        matches.push({
          pattern: pattern.name,
          score,
          scriptPath: pub.path,
          scriptHash: hash(url).slice(0, 16),
          index: match.index,
          match: String(match[0]).slice(0, 300),
          snippet,
        });
        perPattern += 1;
        if (match[0].length === 0) pattern.regex.lastIndex += 1;
      }
    }
  }
  const deduped = [];
  const seen = new Set();
  for (const row of matches.sort((a, b) => b.score - a.score || a.scriptPath.localeCompare(b.scriptPath) || a.index - b.index)) {
    if (row.score < minScore) continue;
    const key = `${row.pattern}\0${row.match}\0${row.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
    if (deduped.length >= maxMatches) break;
  }
  console.log(JSON.stringify({
    ok: true,
    gate: "classic-native-usage-bundle-research",
    port,
    pagePath: publicUrl(page.url).path,
    discoveredScripts: urls.length,
    fetchedScripts: fetched,
    totalFetchedBytes: totalBytes,
    minimumScore: minScore,
    matchCount: deduped.length,
    matches: deduped,
    rawCredentialsReturned: false,
    pageMutationCount: 0,
  }, null, 2));
} finally {
  client.close();
}
