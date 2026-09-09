import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const config = loadConfig();
const authorization = `Bearer ${config.oauth.ownerToken}`;
const home = process.env.USERPROFILE || process.env.HOME || "";
const logDir = join(home, ".devspace-tailscale-bootstrap", "logs", "stable-gateway");

function parsePayload(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5).trim();
    if (!value || value === "[DONE]") continue;
    try { return JSON.parse(value); } catch {}
  }
  return null;
}

async function activeCore() {
  const candidates = [config.port, 7688, 7689].map(Number).filter((value, index, all) => Number.isInteger(value) && all.indexOf(value) === index);
  for (const port of candidates) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/__devspace/memory/status`, { cache: "no-store" });
      if (!response.ok) continue;
      const status = await response.json();
      if (status?.ok === true && status?.features?.passiveCore !== true) return { port, baseUrl: `http://127.0.0.1:${port}`, status };
    } catch {}
  }
  throw new Error("No active Local Gateway Core memory endpoint was found.");
}

async function oomCount() {
  let count = 0;
  for (const name of ["core-a.err.log", "core-b.err.log"]) {
    try {
      const text = await readFile(join(logDir, name), "utf8");
      count += (text.match(/JavaScript heap out of memory/gi) || []).length;
    } catch {}
  }
  return count;
}

async function mcpRequest(baseUrl, body, sessionId, method = "POST") {
  const response = await fetch(`${baseUrl}/mcp`, {
    method,
    headers: {
      authorization,
      accept: "application/json, text/event-stream",
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
      ...(sessionId ? { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-11-25" } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { response, payload: parsePayload(text) };
}

async function oneSession(baseUrl, index) {
  let sessionId = null;
  try {
    const initialized = await mcpRequest(baseUrl, {
      jsonrpc: "2.0",
      id: `init-${index}`,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "devspace-memory-soak", version: "1.0" },
      },
    });
    assert.equal(initialized.response.ok, true, `initialize ${index} returned HTTP ${initialized.response.status}`);
    sessionId = initialized.response.headers.get("mcp-session-id");
    assert.ok(sessionId, `initialize ${index} returned no session id`);
    await mcpRequest(baseUrl, { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, sessionId);
    const listed = await mcpRequest(baseUrl, { jsonrpc: "2.0", id: `list-${index}`, method: "tools/list", params: {} }, sessionId);
    assert.equal(listed.response.ok, true);
    assert.ok(Array.isArray(listed.payload?.result?.tools));
    return listed.payload.result.tools.length;
  } finally {
    if (sessionId) {
      await fetch(`${baseUrl}/mcp`, {
        method: "DELETE",
        headers: {
          authorization,
          "mcp-session-id": sessionId,
          "mcp-protocol-version": "2025-11-25",
        },
      }).catch(() => {});
    }
  }
}

const beforeCore = await activeCore();
const before = beforeCore.status;
const beforeOom = await oomCount();
const sessionTotal = Math.max(32, Number(process.env.DEVSPACE_SOAK_SESSIONS || 96));
const concurrency = 8;
const toolCounts = [];

for (let start = 0; start < sessionTotal; start += concurrency) {
  const batch = [];
  for (let index = start; index < Math.min(sessionTotal, start + concurrency); index += 1) {
    batch.push(oneSession(beforeCore.baseUrl, index));
  }
  toolCounts.push(...await Promise.all(batch));
}

await sleep(8_000);
const afterCore = await activeCore();
const after = afterCore.status;
const afterOom = await oomCount();

const mb = (bytes) => Number(bytes || 0) / (1024 * 1024);
const heapGrowthMb = mb(after.memory.heapUsed) - mb(before.memory.heapUsed);
const rssGrowthMb = mb(after.memory.rss) - mb(before.memory.rss);
const sessionGrowth = Number(after.registries.mcpSessions || 0) - Number(before.registries.mcpSessions || 0);

assert.equal(after.pid, before.pid, "Core PID changed during session soak");
assert.equal(afterOom, beforeOom, "a new V8 heap OOM signature appeared during session soak");
assert.ok(mb(after.memory.heapSizeLimit) > 2_000, "production Core is still running under an artificial sub-2GB heap cap");
assert.ok(new Set(toolCounts).size === 1 && toolCounts[0] >= 100, "all sessions must observe one stable shared tool catalog");
assert.ok(heapGrowthMb < 256, `heap grew ${heapGrowthMb.toFixed(1)}MB after ${sessionTotal} closed sessions`);
assert.ok(rssGrowthMb < 512, `RSS grew ${rssGrowthMb.toFixed(1)}MB after ${sessionTotal} closed sessions`);
assert.ok(sessionGrowth <= 2, `Core retained ${sessionGrowth} extra MCP sessions after explicit DELETE cleanup`);

console.log(JSON.stringify({
  ok: true,
  gate: "core-memory-session-soak",
  corePid: after.pid,
  sessionsCreatedAndClosed: sessionTotal,
  toolCount: toolCounts[0],
  heapLimitMb: Number(mb(after.memory.heapSizeLimit).toFixed(1)),
  heapBeforeMb: Number(mb(before.memory.heapUsed).toFixed(1)),
  heapAfterMb: Number(mb(after.memory.heapUsed).toFixed(1)),
  heapGrowthMb: Number(heapGrowthMb.toFixed(1)),
  rssGrowthMb: Number(rssGrowthMb.toFixed(1)),
  sessionGrowth,
  oomCountBefore: beforeOom,
  oomCountAfter: afterOom,
  pidStable: true,
  noNewOom: true,
  noArtificialHeapCap: true,
}));
