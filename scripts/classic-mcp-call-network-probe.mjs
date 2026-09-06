#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

const port = Number(process.argv[2] || 9732);
const outputPath = String(process.argv[3] || "").trim();
const timeoutMs = Number(process.argv[4] || 30_000);
const targetFingerprint = String(process.argv[5] || "").trim().toLowerCase();
if (!outputPath) throw new Error("Output path is required.");

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = targets.find((item) => item?.type === "page" && /chatgpt\.com/i.test(item.url || "") && item.webSocketDebuggerUrl);
if (!page) throw new Error(`No ChatGPT page found on CDP port ${port}.`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();

function call(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function sha16(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 16);
}

function safePrimitive(path, key, value, output) {
  const lower = String(key || "").toLowerCase();
  if (value === null || value === undefined || typeof value === "object") return;
  if (/argument|input|content|text|prompt|token|authorization|cookie|secret|credential/.test(lower)) return;
  if (/conversation/.test(lower)) {
    output.values[path] = typeof value === "string" ? value.slice(0, 220) : value;
    return;
  }
  if (/session/.test(lower)) {
    output.values[path] = { sha256_16: sha16(value), type: typeof value };
    return;
  }
  if (/^(?:name|tool|tool_name|server|server_id|mcp|mcp_server_id|connector|connector_id|method|request_id|message_id)$/.test(lower)) {
    output.values[path] = typeof value === "string" ? value.slice(0, 220) : value;
  }
}

function inspectShape(value, path = "$", depth = 0, output = { paths: [], values: {} }) {
  if (depth > 7 || output.paths.length > 600) return output;
  if (Array.isArray(value)) {
    output.paths.push(`${path}[]`);
    for (let i = 0; i < Math.min(value.length, 8); i += 1) inspectShape(value[i], `${path}[${i}]`, depth + 1, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    output.paths.push(childPath);
    safePrimitive(childPath, key, child, output);
    if (child && typeof child === "object") inspectShape(child, childPath, depth + 1, output);
  }
  return output;
}

let finished = false;
let capturedRequest = null;
let capturedRequestId = null;
let capturedRequestExtra = null;
let capturedResponse = null;
const requestExtraById = new Map();

async function matchingHashPaths(value, target, path = "$", output = []) {
  if (!target || output.length > 40) return output;
  if (typeof value === "string") {
    if (sha16(value) === target) output.push(path);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length && output.length <= 40; index += 1) {
      await matchingHashPaths(value[index], target, `${path}[${index}]`, output);
    }
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    if (output.length > 40) break;
    await matchingHashPaths(child, target, `${path}.${key}`, output);
  }
  return output;
}

async function finish(payload) {
  if (finished) return;
  finished = true;
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  try { ws.close(); } catch {}
  setTimeout(() => process.exit(0), 10).unref?.();
}

const timer = setTimeout(() => {
  void finish({ ok: false, state: "timeout", port, at: new Date().toISOString() });
}, timeoutMs);
timer.unref?.();

ws.addEventListener("open", async () => {
  await call("Network.enable", { maxTotalBufferSize: 20_000_000, maxResourceBufferSize: 10_000_000 });
});

ws.addEventListener("message", (event) => {
  void (async () => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.id) {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else item.resolve(message.result);
      return;
    }
    if (message.method === "Network.requestWillBeSentExtraInfo") {
      const requestId = message.params?.requestId;
      if (!requestId) return;
      const headers = Object.fromEntries(
        Object.entries(message.params?.headers || {}).map(([key, value]) => [String(key).toLowerCase(), value]),
      );
      const safeTraceHeaders = Object.fromEntries(
        Object.entries(headers)
          .filter(([key, value]) => (key === "traceparent" || key === "tracestate" || key.startsWith("x-datadog-")) && typeof value === "string")
          .map(([key, value]) => [key, { sha256_16: sha16(value) }]),
      );
      requestExtraById.set(requestId, {
        headerNames: Object.keys(headers).sort(),
        traceHeaders: safeTraceHeaders,
      });
      if (capturedRequestId === requestId) capturedRequestExtra = requestExtraById.get(requestId);
      return;
    }

    if (message.method === "Network.requestWillBeSent") {
      const request = message.params?.request;
      let parsedUrl;
      try { parsedUrl = new URL(String(request?.url || "")); } catch { return; }
      if (parsedUrl.hostname !== "chatgpt.com" || parsedUrl.pathname !== "/backend-api/ecosystem/call_mcp") return;
      let postData = String(request?.postData || "");
      if (!postData && message.params?.requestId) {
        try { postData = String((await call("Network.getRequestPostData", { requestId: message.params.requestId }))?.postData || ""); } catch {}
      }
      let body = null;
      try { body = JSON.parse(postData); } catch {}
      const inspected = body ? inspectShape(body) : { paths: [], values: {} };
      const normalizedHeaders = Object.fromEntries(
        Object.entries(request?.headers || {}).map(([key, value]) => [String(key).toLowerCase(), value]),
      );
      const oaiSessionId = typeof normalizedHeaders["oai-session-id"] === "string"
        ? normalizedHeaders["oai-session-id"]
        : "";
      capturedRequestId = message.params?.requestId || null;
      capturedRequestExtra = capturedRequestId ? requestExtraById.get(capturedRequestId) || null : null;
      capturedRequest = {
        method: request?.method || null,
        urlPath: parsedUrl.pathname,
        topLevelKeys: body && typeof body === "object" ? Object.keys(body).sort() : [],
        paths: inspected.paths,
        safeValues: inspected.values,
        oaiSessionFingerprint: oaiSessionId ? sha16(oaiSessionId) : null,
        headerNames: Object.keys(normalizedHeaders).sort(),
      };
      return;
    }

    if (message.method === "Network.responseReceived" && capturedRequestId && message.params?.requestId === capturedRequestId) {
      const responseHeaders = Object.fromEntries(
        Object.entries(message.params?.response?.headers || {}).map(([key, value]) => [String(key).toLowerCase(), value]),
      );
      capturedResponse = {
        status: message.params?.response?.status ?? null,
        headerNames: Object.keys(responseHeaders).sort(),
        sessionHeaderFingerprints: Object.fromEntries(
          Object.entries(responseHeaders)
            .filter(([key, value]) => key.includes("session") && typeof value === "string")
            .map(([key, value]) => [key, sha16(value)]),
        ),
      };
      return;
    }

    if (message.method === "Network.loadingFinished" && capturedRequestId && message.params?.requestId === capturedRequestId) {
      let text = "";
      try {
        const body = await call("Network.getResponseBody", { requestId: capturedRequestId });
        text = body?.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : String(body?.body || "");
      } catch {}
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {}
      const matches = parsed ? await matchingHashPaths(parsed, targetFingerprint) : [];
      clearTimeout(timer);
      await finish({
        ok: true,
        state: "captured-response",
        port,
        request: {
          ...capturedRequest,
          extraInfo: capturedRequestExtra,
        },
        response: {
          ...(capturedResponse || {}),
          topLevelKeys: parsed && typeof parsed === "object" ? Object.keys(parsed).sort() : [],
          targetFingerprint: targetFingerprint || null,
          matchingHashPaths: matches,
        },
        at: new Date().toISOString(),
      });
    }
  })().catch(async (error) => {
    clearTimeout(timer);
    await finish({ ok: false, state: "error", error: error instanceof Error ? error.message : String(error), port, at: new Date().toISOString() });
  });
});
