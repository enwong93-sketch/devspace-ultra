import { readFile } from "node:fs/promises";
import { atomicWriteJson } from "./atomic-file.js";

const DEFAULT_LIMIT = 8;
const MAX_LEGACY_TEXT = 400;
const MAX_MESSAGE_TEXT = 1600;
const SENSITIVE = /(Bearer\s+\S+|(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[=:]\s*\S+)/i;

function cleanText(value, label, maxLength) {
  if (value == null || value === "") return null;
  const text = String(value).replace(/\r\n?/g, "\n").replace(/\t+/g, " ").trim();
  if (!text) return null;
  if (text.length > maxLength) throw new Error(`${label} must be ${maxLength} characters or fewer.`);
  if (SENSITIVE.test(text)) throw new Error(`${label} contains sensitive-looking data.`);
  return text;
}

async function readState(path) {
  try {
    const parsed = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function writeAtomic(path, value) {
  await atomicWriteJson(path, value);
}

function isLoopback(value) {
  const address = String(value || "").toLowerCase();
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

async function readBody(req, maxBytes = 16 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("request-too-large");
    chunks.push(Buffer.from(chunk));
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(body.length));
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(body);
}

function normalizePersistedMessage(item) {
  const text = typeof item?.text === "string" ? item.text.trim() : "";
  if (!text || text.length > MAX_MESSAGE_TEXT || SENSITIVE.test(text)) return null;
  return { text, at: item?.at || null };
}

export async function createStableGatewayHumanProgress({ statePath, limit = DEFAULT_LIMIT, now = Date.now } = {}) {
  const path = String(statePath || "").trim();
  if (!path) throw new Error("statePath is required.");
  const maxItems = Math.max(1, Math.min(20, Number(limit) || DEFAULT_LIMIT));
  const persisted = await readState(path);
  const persistedMessages = (Array.isArray(persisted?.messages) ? persisted.messages : [])
    .map(normalizePersistedMessage)
    .filter(Boolean)
    .slice(-maxItems);
  let state = {
    version: 2,
    messages: persistedMessages,
    // Legacy fields remain for older writers/readers during migration only.
    current: persisted?.current?.text ? persisted.current : null,
    completed: Array.isArray(persisted?.completed) ? persisted.completed.slice(0, maxItems) : [],
    updatedAt: persisted?.updatedAt || null,
  };

  const persist = async () => {
    await writeAtomic(path, state);
  };

  const update = async ({ message, doing, completed, clearCurrent = false } = {}) => {
    const messageText = cleanText(message, "message", MAX_MESSAGE_TEXT);
    const doingText = cleanText(doing, "doing", MAX_LEGACY_TEXT);
    const completedText = cleanText(completed, "completed", MAX_LEGACY_TEXT);
    const at = new Date(Number(now())).toISOString();

    if (messageText) {
      state.messages.push({ text: messageText, at });
      if (state.messages.length > maxItems) state.messages.splice(0, state.messages.length - maxItems);
    }
    if (completedText) {
      state.completed.unshift({ text: completedText, at });
      if (state.completed.length > maxItems) state.completed.length = maxItems;
    }
    if (clearCurrent) state.current = null;
    if (doingText) state.current = { text: doingText, at };
    state.updatedAt = at;
    await persist();
    return snapshot();
  };

  const snapshot = () => structuredClone(state);
  return { update, snapshot, statePath: path };
}

export async function handleStableGatewayHumanProgressRequest(req, res, { progress } = {}) {
  let pathname;
  try { pathname = new URL(req.url || "/", "http://127.0.0.1").pathname; } catch { return false; }
  if (pathname !== "/__devspace/progress") return false;
  if (!isLoopback(req.socket?.remoteAddress)) {
    sendJson(res, 403, { ok: false, error: "loopback-only" });
    return true;
  }
  if (!progress || typeof progress.snapshot !== "function" || typeof progress.update !== "function") {
    sendJson(res, 503, { ok: false, error: "progress-unavailable" });
    return true;
  }
  if (req.method === "GET") {
    sendJson(res, 200, progress.snapshot());
    return true;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "method-not-allowed" });
    return true;
  }
  try {
    const body = await readBody(req);
    const snapshot = await progress.update({
      message: body?.message,
      doing: body?.doing,
      completed: body?.completed,
      clearCurrent: body?.clearCurrent === true,
    });
    sendJson(res, 200, snapshot);
  } catch (error) {
    const message = error instanceof SyntaxError ? "invalid-json" : error?.message === "request-too-large" ? "request-too-large" : "invalid-progress";
    sendJson(res, 400, { ok: false, error: message });
  }
  return true;
}
