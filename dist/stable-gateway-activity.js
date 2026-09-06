const DEFAULT_LIMIT = 160;
const MAX_SUMMARY_CHARS = 280;

function clip(value, max = MAX_SUMMARY_CHARS) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

export function redactStableGatewayActivityText(value) {
  let text = String(value ?? "");
  text = text.replace(/(Bearer\s+)[^\s'"`]+/gi, "$1[REDACTED]");
  text = text.replace(/((?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[=:]\s*)[^\s'"`,;&]+/gi, "$1[REDACTED]");
  text = text.replace(/(["'](?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|client[_-]?secret)["']\s*:\s*["'])[^"']+(["'])/gi, "$1[REDACTED]$2");
  text = text.replace(/(--(?:password|passwd|pwd|token|secret|api-key|access-key|client-secret)\s+)[^\s'"`]+/gi, "$1[REDACTED]");
  text = text.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
  return clip(text);
}

function safePath(value) {
  return clip(String(value ?? "").replace(/[\r\n]/g, " "), 180);
}

export function summarizeStableGatewayToolCall(toolName, args = {}) {
  const name = clip(toolName || "tool", 100) || "tool";
  if (name === "open_workspace") return `open_workspace · ${safePath(args?.path) || "workspace"}`;
  if (["read", "edit", "write"].includes(name)) return `${name} · ${safePath(args?.path) || "file"}`;
  if (name === "bash") {
    const cwd = safePath(args?.workingDirectory || ".");
    const command = redactStableGatewayActivityText(args?.command || "shell command");
    return `bash · ${cwd} · ${command}`;
  }
  if (name === "capability_call") {
    const parts = [args?.pluginId, args?.serverId, args?.toolName].filter(Boolean).map((item) => clip(item, 90));
    return `capability_call${parts.length ? ` · ${parts.join(" / ")}` : ""}`;
  }
  if (/^devspace_goal_/.test(name)) {
    const id = safePath(args?.goalId);
    const action = safePath(args?.action);
    return `${name}${id ? ` · ${id}` : ""}${action ? ` · ${action}` : ""}`;
  }
  if (/^devspace_(?:update_)?plan/.test(name) || name === "devspace_plan_start") {
    const id = safePath(args?.planId);
    const title = safePath(args?.title);
    return `${name}${id ? ` · ${id}` : ""}${title ? ` · ${title}` : ""}`;
  }
  if (/^chat_(?:main|swarm)_/.test(name)) {
    const runtime = args?.mainNumber ?? args?.worker ?? args?.workers ?? null;
    return `${name}${runtime != null ? ` · runtime ${clip(JSON.stringify(runtime), 80)}` : ""}`;
  }
  return name;
}

export function createStableGatewayActivityJournal({ limit = DEFAULT_LIMIT, now = Date.now } = {}) {
  const maxItems = Math.max(1, Math.min(1000, Number(limit) || DEFAULT_LIMIT));
  const events = [];
  let sequence = 0;

  const push = (event) => {
    events.unshift(event);
    if (events.length > maxItems) events.length = maxItems;
    return event;
  };

  const startToolCall = ({ toolName, arguments: args } = {}) => {
    const startedAtMs = Number(now());
    const event = {
      id: `activity_${++sequence}`,
      kind: "tool",
      toolName: clip(toolName || "tool", 100),
      title: summarizeStableGatewayToolCall(toolName, args),
      state: "running",
      startedAt: new Date(startedAtMs).toISOString(),
      startedAtMs,
      finishedAt: null,
      durationMs: null,
      statusCode: null,
      error: null,
    };
    return push(event);
  };

  const finishToolCall = (id, { ok = true, statusCode = null, error = null } = {}) => {
    const event = events.find((item) => item.id === id);
    if (!event) return null;
    const finishedAtMs = Number(now());
    event.state = ok ? "completed" : "failed";
    event.finishedAt = new Date(finishedAtMs).toISOString();
    event.durationMs = Math.max(0, finishedAtMs - Number(event.startedAtMs || finishedAtMs));
    event.statusCode = Number.isFinite(Number(statusCode)) ? Number(statusCode) : null;
    event.error = error ? redactStableGatewayActivityText(error) : null;
    return { ...event };
  };

  const noteSystem = ({ title, detail = "", state = "completed" } = {}) => {
    const atMs = Number(now());
    return push({
      id: `activity_${++sequence}`,
      kind: "system",
      toolName: null,
      title: clip(title || "System event", 160),
      detail: redactStableGatewayActivityText(detail),
      state: ["running", "completed", "failed"].includes(state) ? state : "completed",
      startedAt: new Date(atMs).toISOString(),
      startedAtMs: atMs,
      finishedAt: new Date(atMs).toISOString(),
      durationMs: 0,
      statusCode: null,
      error: null,
    });
  };

  const snapshot = () => ({
    activities: events.map(({ startedAtMs, ...event }) => ({ ...event })),
    running: events.filter((event) => event.state === "running").length,
  });

  return { startToolCall, finishToolCall, noteSystem, snapshot };
}
