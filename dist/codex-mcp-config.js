import { createHash } from "node:crypto";

const SELF_MANAGED_SERVER_NAMES = new Set(["devspace", "powermem", "powermem-shared"]);
const SENSITIVE_ARGUMENT = /(?:^|[-_])(api[-_]?key|token|secret|password|passwd|authorization|bearer|cookie|credential)(?:$|[=:_-])/i;
const PRIVILEGED_NAME = /(?:^|[-_.])(elevated|admin|administrator|root)(?:$|[-_.])/i;
const HIGH_IMPACT_NAME = /(?:^|[-_.])(elevated|admin|administrator|root|windows|docker|bash|shell|terminal|exec|computer|cua|repl)(?:$|[-_.])/i;
const STATEFUL_APP_NAME = /(?:^|[-_.])(blender|comfyui|unreal|gaea|eagle|minimax|h3)(?:$|[-_.])/i;

function stripComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") return line.slice(0, index);
  }
  return line;
}

function splitTopLevel(text, delimiter = ",") {
  const parts = [];
  let quote = null;
  let escaped = false;
  let square = 0;
  let curly = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "[") square += 1;
    else if (character === "]") square -= 1;
    else if (character === "{") curly += 1;
    else if (character === "}") curly -= 1;
    else if (character === delimiter && square === 0 && curly === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

function findTopLevelEquals(text) {
  let quote = null;
  let escaped = false;
  let square = 0;
  let curly = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "[") square += 1;
    else if (character === "]") square -= 1;
    else if (character === "{") curly += 1;
    else if (character === "}") curly -= 1;
    else if (character === "=" && square === 0 && curly === 0) return index;
  }
  return -1;
}

function valueComplete(text) {
  let quote = null;
  let escaped = false;
  let square = 0;
  let curly = 0;
  for (const character of text) {
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "[") square += 1;
    else if (character === "]") square -= 1;
    else if (character === "{") curly += 1;
    else if (character === "}") curly -= 1;
  }
  return quote === null && square === 0 && curly === 0;
}

function parseKeyPart(value) {
  const text = value.trim();
  if (text.startsWith('"')) return JSON.parse(text);
  if (text.startsWith("'")) {
    if (!text.endsWith("'")) throw new Error(`Invalid TOML literal key: ${value}`);
    return text.slice(1, -1);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error(`Unsupported TOML key: ${value}`);
  return text;
}

function parseDottedKey(value) {
  return splitTopLevel(value, ".").map(parseKeyPart);
}

function parseTomlValue(value) {
  const text = value.trim();
  if (!text) throw new Error("TOML value is empty.");
  if (text.startsWith('"')) return JSON.parse(text);
  if (text.startsWith("'")) {
    if (!text.endsWith("'")) throw new Error("Unterminated TOML literal string.");
    return text.slice(1, -1);
  }
  if (text.startsWith("[")) {
    if (!text.endsWith("]")) throw new Error("Unterminated TOML array.");
    return splitTopLevel(text.slice(1, -1)).map(parseTomlValue);
  }
  if (text.startsWith("{")) {
    if (!text.endsWith("}")) throw new Error("Unterminated TOML inline table.");
    const result = {};
    for (const entry of splitTopLevel(text.slice(1, -1))) {
      const equals = findTopLevelEquals(entry);
      if (equals < 1) throw new Error(`Invalid TOML inline-table entry: ${entry}`);
      const path = parseDottedKey(entry.slice(0, equals));
      setPath(result, path, parseTomlValue(entry.slice(equals + 1)));
    }
    return result;
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^[+-]?\d(?:[\d_]*\d)?$/.test(text)) return Number(text.replaceAll("_", ""));
  if (/^[+-]?(?:\d[\d_]*)?\.\d[\d_]*(?:[eE][+-]?\d+)?$/.test(text)) return Number(text.replaceAll("_", ""));
  throw new Error(`Unsupported TOML value: ${text.slice(0, 80)}`);
}

function setPath(root, path, value) {
  let current = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (!current[key] || typeof current[key] !== "object" || Array.isArray(current[key])) current[key] = {};
    current = current[key];
  }
  current[path.at(-1)] = value;
}

export function parseCodexMcpConfig(text) {
  const root = {};
  let tablePath = [];
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    let line = stripComment(lines[lineIndex]).trim();
    if (!line) continue;
    if (line.startsWith("[[")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      tablePath = parseDottedKey(line.slice(1, -1));
      continue;
    }
    let equals = findTopLevelEquals(line);
    if (equals < 1) continue;
    let valueText = line.slice(equals + 1).trim();
    while (!valueComplete(valueText) && lineIndex + 1 < lines.length) {
      lineIndex += 1;
      valueText += `\n${stripComment(lines[lineIndex]).trim()}`;
    }
    if (!valueComplete(valueText)) throw new Error(`Unterminated TOML value near line ${lineIndex + 1}.`);
    const keyPath = parseDottedKey(line.slice(0, equals));
    setPath(root, [...tablePath, ...keyPath], parseTomlValue(valueText));
  }
  const servers = root.mcp_servers;
  return servers && typeof servers === "object" && !Array.isArray(servers) ? servers : {};
}

function stringArray(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  return value.map(String);
}

function secretArgumentReason(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = String(args[index]);
    if (SENSITIVE_ARGUMENT.test(argument)) return `sensitive command-line argument at index ${index}`;
    try {
      const url = new URL(argument);
      if (url.username || url.password || url.search || url.hash) return `credential-bearing or mutable URL argument at index ${index}`;
    } catch {}
  }
  return null;
}

function safePluginId(name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  if (!slug) throw new Error(`Cannot derive a safe plugin id from Codex MCP server ${name}.`);
  return `codex-mcp-${slug}`;
}

export function codexMcpExecutionFingerprint(server) {
  const payload = {
    name: server.name,
    command: server.command,
    args: server.args,
    cwd: server.cwd || null,
    envKeys: [...server.envKeys].sort(),
    envVars: [...server.envVars].sort(),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function sanitizeCodexMcpServer(name, rawValue) {
  const raw = rawValue && typeof rawValue === "object" && !Array.isArray(rawValue) ? rawValue : {};
  const normalizedName = String(name);
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  const args = stringArray(raw.args);
  const cwd = typeof raw.cwd === "string" && raw.cwd.trim() ? raw.cwd.trim() : null;
  const url = typeof raw.url === "string" && raw.url.trim() ? raw.url.trim() : null;
  const env = raw.env && typeof raw.env === "object" && !Array.isArray(raw.env) ? raw.env : {};
  const envKeys = Object.keys(env).sort();
  const configuredEnvVars = stringArray(raw.env_vars ?? raw.envVars) ?? [];
  const bearerEnv = typeof raw.bearer_token_env_var === "string" ? raw.bearer_token_env_var.trim() : "";
  const envVars = [...new Set([...configuredEnvVars, ...(bearerEnv ? [bearerEnv] : [])])].sort();
  const headerTable = raw.http_headers && typeof raw.http_headers === "object" ? raw.http_headers : {};
  const envHeaderTable = raw.env_http_headers && typeof raw.env_http_headers === "object" ? raw.env_http_headers : {};
  const headerNames = [...new Set([...Object.keys(headerTable), ...Object.keys(envHeaderTable)])].sort();
  const enabled = raw.enabled !== false && raw.disabled !== true;
  const privileged = PRIVILEGED_NAME.test(normalizedName);
  const highRisk = HIGH_IMPACT_NAME.test(normalizedName);
  const statefulApp = STATEFUL_APP_NAME.test(normalizedName);
  const riskClass = privileged || highRisk ? "high-impact" : statefulApp ? "stateful-app" : "standard";
  const autoEnableEligible = riskClass === "standard";

  let status = "importable-stdio";
  let reason = null;
  if (SELF_MANAGED_SERVER_NAMES.has(normalizedName.toLowerCase())) {
    status = "skipped-existing-native";
    reason = `${normalizedName} is already provided by DevSpace or the shared PowerMem adapter.`;
  } else if (!enabled) {
    status = "skipped-disabled";
    reason = "The Codex MCP entry is disabled.";
  } else if (url) {
    status = "remote-review-required";
    reason = "Remote MCP entries require an explicit DevSpace remote-auth mapping and are not imported by the stdio bridge.";
  } else if (!command) {
    status = "blocked-invalid";
    reason = "No stdio command or supported remote URL is configured.";
  } else if (args === null) {
    status = "blocked-invalid";
    reason = "args must be an array of strings.";
  } else {
    reason = secretArgumentReason(args);
    if (reason) status = "blocked-command-line-secret";
  }

  const result = {
    name: normalizedName,
    pluginId: safePluginId(normalizedName),
    status,
    reason,
    transport: url ? "remote" : "stdio",
    command,
    args: args ?? [],
    cwd,
    envKeys,
    envVars,
    headerNames,
    privileged,
    highRisk,
    statefulApp,
    riskClass,
    autoEnableEligible,
    enabledInCodex: enabled,
  };
  result.executionFingerprint = codexMcpExecutionFingerprint(result);
  return result;
}

export function discoverCodexMcpCatalog(text) {
  const rawServers = parseCodexMcpConfig(text);
  return Object.entries(rawServers)
    .map(([name, raw]) => sanitizeCodexMcpServer(name, raw))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function createCodexMcpBridgeManifest(server, {
  nodePath,
  bridgeScriptPath,
  configPath,
} = {}) {
  if (server?.status !== "importable-stdio") throw new Error(`Codex MCP server ${server?.name || "unknown"} is not safely importable.`);
  if (!nodePath || !bridgeScriptPath) throw new Error("nodePath and bridgeScriptPath are required.");
  return {
    id: server.pluginId,
    name: `Codex MCP: ${server.name}`,
    version: "1.0.0-imported",
    description: `Sanitized, explicitly trusted bridge to the existing Codex MCP server ${server.name}. Secret values remain in the live Codex configuration and are never copied into this manifest or the DevSpace registry.`,
    mcpServers: {
      [server.name]: {
        command: nodePath,
        args: [
          bridgeScriptPath,
          "--server",
          server.name,
          "--expected-fingerprint",
          server.executionFingerprint,
          ...(configPath ? ["--config", configPath] : []),
        ],
        cwd: ".",
      },
    },
  };
}

export function publicCodexMcpCatalog(catalog) {
  return catalog.map((server) => ({
    name: server.name,
    pluginId: server.pluginId,
    status: server.status,
    reason: server.reason,
    transport: server.transport,
    commandBasename: server.command ? server.command.replaceAll("\\", "/").split("/").at(-1) : null,
    argumentCount: server.args.length,
    hasCwd: Boolean(server.cwd),
    envKeys: server.envKeys,
    envVars: server.envVars,
    headerNames: server.headerNames,
    privileged: server.privileged,
    highRisk: server.highRisk,
    statefulApp: server.statefulApp,
    riskClass: server.riskClass,
    autoEnableEligible: server.autoEnableEligible,
    enabledInCodex: server.enabledInCodex,
    executionFingerprint: server.executionFingerprint,
  }));
}
