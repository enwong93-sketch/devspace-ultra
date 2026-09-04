const LEVEL_WEIGHT = {
    silent: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
};
export function shouldLog(config, level) {
    return LEVEL_WEIGHT[config.level] >= LEVEL_WEIGHT[level];
}
export function logEvent(config, level, event, fields = {}) {
    if (!shouldLog(config, level))
        return;
    const entry = {
        ts: new Date().toISOString(),
        level,
        event,
        ...fields,
    };
    const line = config.format === "pretty" ? formatPretty(entry) : JSON.stringify(entry);
    if (level === "error") {
        console.error(line);
    }
    else if (level === "warn") {
        console.warn(line);
    }
    else {
        console.log(line);
    }
}
export function requestIp(req, trustProxy) {
    if (trustProxy) {
        const cfConnectingIp = firstHeaderValue(req.header("cf-connecting-ip"));
        if (cfConnectingIp)
            return cfConnectingIp;
        const forwardedFor = firstHeaderValue(req.header("x-forwarded-for"));
        if (forwardedFor)
            return forwardedFor;
    }
    return req.ip ?? req.socket.remoteAddress;
}
export function requestPath(req) {
    const original = typeof req.originalUrl === "string" ? req.originalUrl.split("?")[0] : "";
    return original || req.path || req.url.split("?")[0] || req.url;
}
export function sessionIdPrefix(sessionId) {
    return sessionId ? sessionId.slice(0, 8) : undefined;
}
export function commandPreview(command) {
    const normalized = command.replace(/\s+/g, " ").trim();
    return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}
function firstHeaderValue(value) {
    return value?.split(",")[0]?.trim() || undefined;
}
function formatPretty(entry) {
    const ts = String(entry.ts);
    const level = String(entry.level).toUpperCase();
    const event = String(entry.event);
    const rest = Object.entries(entry)
        .filter(([key, value]) => !["ts", "level", "event"].includes(key) && value !== undefined)
        .map(([key, value]) => `${key}=${formatPrettyValue(value)}`)
        .join(" ");
    return rest ? `${ts} ${level} ${event} ${rest}` : `${ts} ${level} ${event}`;
}
function formatPrettyValue(value) {
    if (typeof value === "string")
        return JSON.stringify(value);
    return JSON.stringify(value);
}
