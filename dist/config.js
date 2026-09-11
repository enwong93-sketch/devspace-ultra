import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";
import { normalizeToolMode } from "./tool-mode.js";
import { devspaceAgentsDir, devspaceCapabilityRegistryPath, devspacePluginsDir, devspaceSkillsDir, loadDevspaceFiles } from "./user-config.js";
const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_ARTIFACT_MAX_FILE_BYTES = 100 * 1024 * 1024;
function parsePort(value) {
    if (value === undefined || value === "")
        return 7676;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid PORT: ${value}`);
    }
    return port;
}
function parseAllowedRoots(value) {
    if (Array.isArray(value)) {
        const roots = value.map((entry) => entry.trim()).filter(Boolean);
        return (roots.length > 0 ? roots : [process.cwd()]).map((root) => resolve(expandHomePath(root)));
    }
    const rawRoots = value
        ?.split(",")
        .map((entry) => entry.trim())
        .filter(Boolean) ?? [];
    const roots = rawRoots.length > 0 ? rawRoots : [process.cwd()];
    return roots.map((root) => resolve(expandHomePath(root)));
}
function parseAllowedHosts(value, derivedHosts) {
    if (Array.isArray(value)) {
        return normalizeAllowedHosts(value, derivedHosts);
    }
    const rawHosts = value
        ?.split(",")
        .map((entry) => entry.trim())
        .filter(Boolean) ?? [];
    return normalizeAllowedHosts(rawHosts, derivedHosts);
}
function normalizeAllowedHosts(rawHosts, derivedHosts) {
    const hosts = rawHosts.length > 0 ? rawHosts : derivedHosts;
    if (hosts.includes("*"))
        return ["*"];
    return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}
function parseBoolean(value) {
    return ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");
}
function parseToolMode(env, persistedMode) {
    const mode = env.DEVSPACE_TOOL_MODE ?? persistedMode;
    const legacyMinimalTools = env.DEVSPACE_TOOL_MODE === undefined && persistedMode === undefined && env.DEVSPACE_MINIMAL_TOOLS !== undefined
        ? parseBoolean(env.DEVSPACE_MINIMAL_TOOLS)
        : undefined;
    return normalizeToolMode(mode, { legacyMinimalTools });
}
function parseLogLevel(value) {
    if (!value || value === "info")
        return "info";
    if (["silent", "error", "warn", "debug"].includes(value))
        return value;
    throw new Error(`Invalid DEVSPACE_LOG_LEVEL: ${value}`);
}
function parseLogFormat(value) {
    if (!value || value === "json")
        return "json";
    if (value === "pretty")
        return "pretty";
    throw new Error(`Invalid DEVSPACE_LOG_FORMAT: ${value}`);
}
function parsePathList(value) {
    return (value
        ?.split(",")
        .map((entry) => entry.trim())
        .filter(Boolean) ?? []);
}
function parsePortList(value, name) {
    if (value === undefined || value === null || value === "")
        return undefined;
    const entries = Array.isArray(value) ? value : String(value).split(",");
    const ports = [];
    const seen = new Set();
    for (const entry of entries) {
        const port = Number(String(entry).trim());
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`Invalid ${name}: ${entry}`);
        }
        if (!seen.has(port)) {
            seen.add(port);
            ports.push(port);
        }
    }
    return ports;
}
function parseStringList(value, fallback) {
    const entries = value
        ?.split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    return entries && entries.length > 0 ? entries : fallback;
}
function parsePositiveInteger(value, fallback, name, max = Number.MAX_SAFE_INTEGER) {
    if (!value)
        return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    return parsed;
}
function parseNonNegativeInteger(value, fallback, name, max = Number.MAX_SAFE_INTEGER) {
    if (value === undefined || value === null || value === "")
        return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    return parsed;
}
function parseFraction(value, fallback, name, min = 0, max = 1) {
    if (value === undefined || value === null || value === "")
        return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    return parsed;
}
function parseLoggingConfig(env) {
    return {
        level: parseLogLevel(env.DEVSPACE_LOG_LEVEL),
        format: parseLogFormat(env.DEVSPACE_LOG_FORMAT),
        requests: env.DEVSPACE_LOG_REQUESTS === undefined ? false : parseBoolean(env.DEVSPACE_LOG_REQUESTS),
        assets: parseBoolean(env.DEVSPACE_LOG_ASSETS),
        toolCalls: env.DEVSPACE_LOG_TOOL_CALLS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_TOOL_CALLS),
        shellCommands: parseBoolean(env.DEVSPACE_LOG_SHELL_COMMANDS),
        trustProxy: parseBoolean(env.DEVSPACE_TRUST_PROXY),
    };
}
function parseWidgetMode(value) {
    if (!value || value === "off")
        return "off";
    if (value === "full" || value === "changes")
        return value;
    throw new Error(`Invalid DEVSPACE_WIDGETS: ${value}`);
}
function parseRequiredSecret(value, name) {
    const secret = value?.trim();
    if (!secret) {
        throw new Error(`${name} is required for DevSpace OAuth. Run: devspace init`);
    }
    if (secret.length < 16) {
        throw new Error(`${name} must be at least 16 characters long.`);
    }
    return secret;
}
function parseOAuthConfig(env, ownerToken) {
    return {
        ownerToken: parseRequiredSecret(env.DEVSPACE_OAUTH_OWNER_TOKEN ?? ownerToken, "DEVSPACE_OAUTH_OWNER_TOKEN"),
        accessTokenTtlSeconds: parsePositiveInteger(env.DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS, DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS, "DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS"),
        refreshTokenTtlSeconds: parsePositiveInteger(env.DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS, DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS, "DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS"),
        scopes: parseStringList(env.DEVSPACE_OAUTH_SCOPES, ["devspace", "offline_access"]),
        allowedRedirectHosts: parseStringList(env.DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS, [
            "chatgpt.com",
            "localhost",
            "127.0.0.1",
        ]),
    };
}
function defaultStateDir() {
    return join(homedir(), ".local", "share", "devspace");
}
function defaultWorktreeRoot() {
    return join(homedir(), ".devspace", "worktrees");
}
function defaultAgentDir() {
    return join(homedir(), ".codex");
}
export function loadConfig(env = process.env) {
    const files = loadDevspaceFiles(env);
    const host = env.HOST ?? files.config.host ?? "127.0.0.1";
    const port = parsePort(env.PORT ?? files.config.port);
    const publicBaseUrl = parsePublicBaseUrl(env.DEVSPACE_PUBLIC_BASE_URL ?? files.config.publicBaseUrl ?? localPublicBaseUrl(host, port));
    const derivedAllowedHosts = [
        "localhost",
        "127.0.0.1",
        "::1",
        host,
        new URL(publicBaseUrl).hostname,
        ...(files.config.allowedHosts ?? []),
    ];
    return {
        host,
        port,
        oauth: parseOAuthConfig(env, files.auth.ownerToken),
        allowedRoots: parseAllowedRoots(env.DEVSPACE_ALLOWED_ROOTS ?? files.config.allowedRoots),
        allowedHosts: parseAllowedHosts(env.DEVSPACE_ALLOWED_HOSTS, derivedAllowedHosts),
        publicBaseUrl,
        toolMode: parseToolMode(env, files.config.toolMode),
        widgets: parseWidgetMode(env.DEVSPACE_WIDGETS),
        stateDir: resolve(expandHomePath(env.DEVSPACE_STATE_DIR ?? files.config.stateDir ?? defaultStateDir())),
        worktreeRoot: resolve(expandHomePath(env.DEVSPACE_WORKTREE_ROOT ?? files.config.worktreeRoot ?? defaultWorktreeRoot())),
        artifactsEnabled: env.DEVSPACE_ARTIFACTS === undefined
            ? files.config.artifactsEnabled === true
            : parseBoolean(env.DEVSPACE_ARTIFACTS),
        artifactMaxFileBytes: parsePositiveInteger(env.DEVSPACE_ARTIFACT_MAX_FILE_BYTES ?? numberConfigValue(files.config.artifactMaxFileBytes), DEFAULT_ARTIFACT_MAX_FILE_BYTES, "DEVSPACE_ARTIFACT_MAX_FILE_BYTES"),
        skillsEnabled: env.DEVSPACE_SKILLS === undefined
            ? files.config.skillsEnabled !== false
            : parseBoolean(env.DEVSPACE_SKILLS),
        skillPaths: parsePathList(env.DEVSPACE_SKILL_PATHS),
        devspaceSkillsDir: devspaceSkillsDir(env),
        devspaceAgentsDir: devspaceAgentsDir(env),
        pluginsEnabled: env.DEVSPACE_PLUGINS === undefined
            ? files.config.pluginsEnabled !== false
            : parseBoolean(env.DEVSPACE_PLUGINS),
        pluginPaths: parsePathList(env.DEVSPACE_PLUGIN_PATHS ?? (Array.isArray(files.config.pluginPaths) ? files.config.pluginPaths.join(",") : files.config.pluginPaths)),
        pluginsDir: resolve(expandHomePath(env.DEVSPACE_PLUGINS_DIR ?? files.config.pluginsDir ?? devspacePluginsDir(env))),
        capabilityRegistryPath: resolve(expandHomePath(env.DEVSPACE_CAPABILITY_REGISTRY ?? files.config.capabilityRegistryPath ?? devspaceCapabilityRegistryPath(env))),
        passiveCore: env.DEVSPACE_PASSIVE_CORE === undefined
            ? false
            : parseBoolean(env.DEVSPACE_PASSIVE_CORE),
        goalRoundRecoveryEnabled: env.DEVSPACE_GOAL_ROUND_RECOVERY === undefined
            ? files.config.goalRoundRecoveryEnabled !== false
            : parseBoolean(env.DEVSPACE_GOAL_ROUND_RECOVERY),
        classicMainDebugPorts: parsePortList(env.DEVSPACE_CLASSIC_MAIN_DEBUG_PORTS ?? files.config.classicMainDebugPorts, "DEVSPACE_CLASSIC_MAIN_DEBUG_PORTS"),
        classicStreamRecoveryEnabled: env.DEVSPACE_CLASSIC_STREAM_RECOVERY === undefined
            ? files.config.classicStreamRecoveryEnabled !== false
            : parseBoolean(env.DEVSPACE_CLASSIC_STREAM_RECOVERY),
        classicHostOverlayEnabled: env.DEVSPACE_CLASSIC_HOST_OVERLAY === undefined
            ? files.config.classicHostOverlayEnabled !== false
            : parseBoolean(env.DEVSPACE_CLASSIC_HOST_OVERLAY),
        conversationProgressLivenessEnabled: env.DEVSPACE_PROGRESS_LIVENESS === undefined
            ? files.config.conversationProgressLivenessEnabled !== false
            : parseBoolean(env.DEVSPACE_PROGRESS_LIVENESS),
        conversationProgressReminderSeconds: parsePositiveInteger(
            env.DEVSPACE_PROGRESS_REMINDER_SECONDS ?? numberConfigValue(files.config.conversationProgressReminderSeconds),
            10 * 60,
            "DEVSPACE_PROGRESS_REMINDER_SECONDS",
            24 * 60 * 60,
        ),
        conversationProgressContinueSeconds: parsePositiveInteger(
            env.DEVSPACE_PROGRESS_CONTINUE_SECONDS ?? numberConfigValue(files.config.conversationProgressContinueSeconds),
            20 * 60,
            "DEVSPACE_PROGRESS_CONTINUE_SECONDS",
            24 * 60 * 60,
        ),
        conversationProgressPollSeconds: parsePositiveInteger(
            env.DEVSPACE_PROGRESS_POLL_SECONDS ?? numberConfigValue(files.config.conversationProgressPollSeconds),
            15,
            "DEVSPACE_PROGRESS_POLL_SECONDS",
            60 * 60,
        ),
        contextGuardianEnabled: env.DEVSPACE_CONTEXT_GUARDIAN === undefined
            ? files.config.contextGuardianEnabled !== false
            : parseBoolean(env.DEVSPACE_CONTEXT_GUARDIAN),
        autoCompactEnabled: env.DEVSPACE_AUTO_COMPACT === undefined
            ? files.config.autoCompactEnabled === true
            : parseBoolean(env.DEVSPACE_AUTO_COMPACT),
        autoCompactThreshold: parseFraction(env.DEVSPACE_AUTO_COMPACT_THRESHOLD ?? numberConfigValue(files.config.autoCompactThreshold), 0.90, "DEVSPACE_AUTO_COMPACT_THRESHOLD", 0.50, 0.98),
        autoCompactContextWindowTokens: parsePositiveInteger(env.DEVSPACE_AUTO_COMPACT_CONTEXT_TOKENS ?? numberConfigValue(files.config.autoCompactContextWindowTokens), 1_050_000, "DEVSPACE_AUTO_COMPACT_CONTEXT_TOKENS", 10_000_000),
        autoCompactReserveTokens: parseNonNegativeInteger(env.DEVSPACE_AUTO_COMPACT_RESERVE_TOKENS ?? numberConfigValue(files.config.autoCompactReserveTokens), 32_000, "DEVSPACE_AUTO_COMPACT_RESERVE_TOKENS", 5_000_000),
        autoCompactPollSeconds: parsePositiveInteger(env.DEVSPACE_AUTO_COMPACT_POLL_SECONDS ?? numberConfigValue(files.config.autoCompactPollSeconds), 15, "DEVSPACE_AUTO_COMPACT_POLL_SECONDS", 3_600),
        autoCompactResumeTimeoutSeconds: parsePositiveInteger(env.DEVSPACE_AUTO_COMPACT_RESUME_TIMEOUT_SECONDS ?? numberConfigValue(files.config.autoCompactResumeTimeoutSeconds), 150, "DEVSPACE_AUTO_COMPACT_RESUME_TIMEOUT_SECONDS", 900),
        subagents: env.DEVSPACE_SUBAGENTS === undefined
            ? files.config.subagents === true
            : parseBoolean(env.DEVSPACE_SUBAGENTS),
        agentDir: resolve(expandHomePath(env.DEVSPACE_AGENT_DIR ?? files.config.agentDir ?? defaultAgentDir())),
        logging: parseLoggingConfig(env),
    };
}
function numberConfigValue(value) {
    return value === undefined ? undefined : String(value);
}
function parsePublicBaseUrl(value) {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
}
function localPublicBaseUrl(host, port) {
    const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    const formattedHost = publicHost.includes(":") && !publicHost.startsWith("[")
        ? `[${publicHost}]`
        : publicHost;
    return `http://${formattedHost}:${port}`;
}
