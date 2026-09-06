import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import * as YAML from "yaml";
import * as z from "zod/v4";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";

const REGISTRY_VERSION = 1;
const MAX_PLUGIN_FILES = 5000;
const MAX_PLUGIN_DEPTH = 8;
const MAX_TEXT_RESOURCE_BYTES = 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const MAX_TOOL_TIMEOUT_MS = 5 * 60_000;
const MCP_CONNECT_TIMEOUT_MS = 20_000;
const MCP_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_INSTANCE_LEASE_MS = 30 * 60_000;
const MAX_INSTANCE_LEASE_MS = 2 * 60 * 60_000;
const MAX_MCP_PROBE_SERVERS = 16;
const MCP_PROBE_CONCURRENCY = 4;
const MANIFEST_NAMES = [
  "devspace-plugin.json",
  join(".devspace", "plugin.json"),
  join(".claude-plugin", "plugin.json"),
  join(".codex-plugin", "plugin.json"),
];
const MCP_CONFIG_NAMES = [
  ".mcp.json",
  "mcp.json",
  join(".vscode", "mcp.json"),
  "server.json",
];
const INSTRUCTION_NAMES = new Set([
  "AGENTS.md",
  "AGENTS.override.md",
  "CLAUDE.md",
  "GEMINI.md",
]);

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const MUTATING = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};
const CALLING = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

function nowIso() {
  return new Date().toISOString();
}
function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}
function textResult(structuredContent, text = JSON.stringify(structuredContent, null, 2)) {
  return { content: [{ type: "text", text }], structuredContent };
}
function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { ok: false, error: message },
  };
}
function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}
async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms.`)), timeoutMs);
      }),
    ]);
  }
  finally {
    if (timer) clearTimeout(timer);
  }
}
function mcpRequestOptions(timeoutMs = MCP_CALL_TIMEOUT_MS) {
  return { timeout: timeoutMs, maxTotalTimeout: timeoutMs };
}
function shouldInvalidateMcpClient(error) {
  const code = Number(error?.code);
  if (code === Number(ErrorCode.RequestTimeout)) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /request timed out|maximum total timeout|connection closed|transport|socket|econn(?:reset|refused)|broken pipe|websocket.*closed/i.test(message);
}
function isPathInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
function slugify(value) {
  const slug = String(value || "plugin")
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return slug || `plugin-${randomBytes(4).toString("hex")}`;
}
function normalizeId(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .slice(0, 180);
}
function normalizePathList(value) {
  const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return values.map((entry) => String(entry || "").trim()).filter(Boolean);
}
function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry)).filter(Boolean);
}
function parseJsonSafe(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}
async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  }
  catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error(`Unable to read JSON ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function readPyprojectMetadata(filePath) {
  let text;
  try { text = await readFile(filePath, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return undefined;
    return undefined;
  }
  const result = {};
  let inProject = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^\[[^\]]+\]$/.test(line)) {
      inProject = line === "[project]";
      continue;
    }
    if (!inProject || !line || line.startsWith("#")) continue;
    const match = line.match(/^(name|version|description)\s*=\s*(["'])(.*?)\2\s*(?:#.*)?$/);
    if (match) result[match[1]] = match[3];
  }
  return Object.keys(result).length ? result : undefined;
}
function readJsonSyncIfExists(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  }
  catch {
    return undefined;
  }
}
async function isDirectory(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}
function expandHome(value) {
  const raw = String(value || "");
  if (raw === "~") return homedir();
  if (raw.startsWith(`~${sep}`) || raw.startsWith("~/") || raw.startsWith("~\\")) {
    return join(homedir(), raw.slice(2));
  }
  return raw;
}
function resolveWithin(root, candidate = ".") {
  const absolute = resolve(root, expandHome(candidate));
  if (!isPathInside(absolute, root)) throw new Error(`Path escapes plugin root: ${candidate}`);
  return absolute;
}
async function resolveExistingWithin(root, candidate = ".") {
  const lexical = resolveWithin(root, candidate);
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(lexical)]);
  if (!isPathInside(realCandidate, realRoot)) throw new Error(`Path escapes plugin root through a symbolic link: ${candidate}`);
  return realCandidate;
}
function replaceEnvTemplates(value, env = process.env) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name, fallback) => {
    const resolved = env[name];
    if (resolved !== undefined) return resolved;
    if (fallback !== undefined) return fallback;
    return "";
  });
}
function resolveEnvObject(value = {}, env = process.env) {
  const result = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || raw === null) continue;
    result[String(key)] = replaceEnvTemplates(String(raw), env);
  }
  return result;
}
function requiredEnvNames(definition) {
  const names = new Set();
  for (const item of Array.isArray(definition?.requiredEnv) ? definition.requiredEnv : []) {
    if (item) names.add(String(item));
  }
  for (const item of Array.isArray(definition?.environmentVariables) ? definition.environmentVariables : []) {
    if (item?.isRequired && item?.name) names.add(String(item.name));
  }
  return [...names];
}
function envSegment(value) {
  return String(value || "VALUE").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "VALUE";
}
function remoteSettingEnvName(pluginId, serverId, kind, name) {
  return `DEVSPACE_CAP_${envSegment(pluginId)}_${envSegment(serverId)}_${envSegment(kind)}_${envSegment(name)}`;
}
function derivedRemoteEnvNames(pluginId, definition) {
  const names = [];
  for (const [name, descriptor] of Object.entries(definition?.variables || {})) {
    if (descriptor?.isRequired && descriptor?.default === undefined) names.push(remoteSettingEnvName(pluginId, definition.id, "VAR", name));
  }
  for (const descriptor of Array.isArray(definition?.headerDescriptors) ? definition.headerDescriptors : []) {
    if (descriptor?.isRequired && descriptor?.name) names.push(remoteSettingEnvName(pluginId, definition.id, "HEADER", descriptor.name));
  }
  return names;
}
function capabilityProcessEnvironment() {
  const env = { ...getDefaultEnvironment() };
  if (process.platform === "win32") {
    for (const name of ["COMSPEC", "PATHEXT", "WINDIR"]) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
  }
  return env;
}
function capabilityRequiredEnvNames(pluginId, definition) {
  return [...new Set([...requiredEnvNames(definition), ...derivedRemoteEnvNames(pluginId, definition)])];
}
function assertRequiredEnv(definition, env = process.env) {
  const missing = requiredEnvNames(definition).filter((name) => !String(env[name] ?? "").trim());
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
}
function resolveRemoteConnection(pluginId, definition, env = process.env) {
  let url = replaceEnvTemplates(String(definition.url || ""), env);
  for (const [name, descriptor] of Object.entries(definition.variables || {})) {
    const envName = remoteSettingEnvName(pluginId, definition.id, "VAR", name);
    const value = env[envName] ?? descriptor?.default;
    if ((value === undefined || value === "") && descriptor?.isRequired) throw new Error(`Missing required remote MCP variable ${name}. Set ${envName}.`);
    if (value !== undefined && value !== "") url = url.split(`{${name}}`).join(encodeURIComponent(String(value)));
  }
  if (/\{[^}]+\}/.test(url)) throw new Error(`Remote MCP URL still contains unresolved template variables: ${url}`);
  const parsedUrl = new URL(url);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error(`Remote MCP URL must use http or https: ${parsedUrl.protocol}`);
  const headers = resolveEnvObject(definition.headers, env);
  for (const descriptor of Array.isArray(definition.headerDescriptors) ? definition.headerDescriptors : []) {
    if (!descriptor?.name) continue;
    const envName = remoteSettingEnvName(pluginId, definition.id, "HEADER", descriptor.name);
    const value = env[envName];
    if ((!value || !String(value).trim()) && descriptor.isRequired) throw new Error(`Missing required remote MCP header ${descriptor.name}. Set ${envName}.`);
    if (value !== undefined && String(value).trim()) headers[descriptor.name] = String(value);
  }
  return { url: parsedUrl.toString(), headers };
}
function frontmatterFromSkill(text) {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  try {
    const parsed = YAML.parse(text.slice(3, end));
    return parsed && typeof parsed === "object" ? parsed : {};
  }
  catch { return {}; }
}
async function walkFiles(root, options = {}) {
  const maxFiles = options.maxFiles ?? MAX_PLUGIN_FILES;
  const maxDepth = options.maxDepth ?? MAX_PLUGIN_DEPTH;
  const results = [];
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length && results.length < maxFiles) {
    const { dir, depth } = queue.shift();
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if ([".git", "node_modules", ".venv", "venv", "__pycache__", "dist-cache"].includes(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isFile()) {
        results.push(full);
        if (results.length >= maxFiles) break;
      }
      else if (entry.isDirectory() && depth < maxDepth) {
        queue.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return results;
}
function relativePortable(root, filePath) {
  return relative(root, filePath).split(sep).join("/");
}
function sourceFromPackageJson(pkg = {}) {
  const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  return repository ? String(repository) : undefined;
}
function normalizeCommandTool(raw, index) {
  if (!raw || typeof raw !== "object") return undefined;
  const name = String(raw.name || raw.id || `tool-${index + 1}`).trim();
  const command = String(raw.command || "").trim();
  if (!name || !command) return undefined;
  return {
    name,
    description: String(raw.description || "Plugin command tool").slice(0, 1000),
    command,
    args: normalizeStringArray(raw.args),
    cwd: String(raw.cwd || "."),
    env: raw.env && typeof raw.env === "object" ? raw.env : {},
    requiredEnv: normalizeStringArray(raw.requiredEnv),
    timeoutMs: clampInteger(raw.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS, 1000, MAX_TOOL_TIMEOUT_MS),
    input: ["json-stdin", "none"].includes(raw.input) ? raw.input : "json-stdin",
    inputSchema: raw.inputSchema && typeof raw.inputSchema === "object" ? raw.inputSchema : undefined,
  };
}
function normalizeMcpDefinition(id, raw, pluginDir, sourcePath) {
  if (!raw || typeof raw !== "object") return undefined;
  const typeRaw = String(raw.type || raw.transport?.type || "").toLowerCase();
  const url = raw.url || raw.transport?.url;
  const command = raw.command;
  const definition = {
    id: String(id),
    description: String(raw.description || "MCP server").slice(0, 1000),
    sourcePath,
    baseDir: resolve(pluginDir),
    requiredEnv: normalizeStringArray(raw.requiredEnv),
    environmentVariables: Array.isArray(raw.environmentVariables) ? raw.environmentVariables.map((item) => ({
      name: String(item?.name || ""),
      isRequired: Boolean(item?.isRequired),
      isSecret: Boolean(item?.isSecret),
      default: item?.default === undefined ? undefined : String(item.default),
      description: String(item?.description || "").slice(0, 500),
    })).filter((item) => item.name) : [],
    connectTimeoutMs: clampInteger(
      raw.connectTimeoutMs ?? (Number.isFinite(Number(raw.startup_timeout_sec)) ? Math.round(Number(raw.startup_timeout_sec) * 1000) : undefined),
      MCP_CONNECT_TIMEOUT_MS,
      1_000,
      MAX_TOOL_TIMEOUT_MS,
    ),
  };
  if (command) {
    definition.type = "stdio";
    definition.command = String(command);
    definition.args = normalizeStringArray(raw.args);
    definition.cwd = String(raw.cwd || ".");
    definition.env = raw.env && typeof raw.env === "object" ? raw.env : {};
    return definition;
  }
  if (url) {
    definition.type = typeRaw === "sse" ? "sse" : "streamable-http";
    definition.url = String(url);
    definition.headers = raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers) ? raw.headers : {};
    definition.headerDescriptors = Array.isArray(raw.headers) ? raw.headers.map((item) => ({
      name: String(item?.name || ""),
      description: String(item?.description || "").slice(0, 500),
      isRequired: Boolean(item?.isRequired),
      isSecret: Boolean(item?.isSecret),
    })).filter((item) => item.name) : [];
    definition.variables = raw.variables && typeof raw.variables === "object" && !Array.isArray(raw.variables) ? raw.variables : {};
    return definition;
  }
  if (raw.registryType && raw.identifier && String(raw.transport?.type || "stdio") === "stdio") {
    const registryType = String(raw.registryType).toLowerCase();
    const identifier = String(raw.identifier);
    const version = raw.version ? String(raw.version) : undefined;
    definition.type = "stdio";
    definition.package = { registryType, identifier, version };
    definition.environmentVariables = Array.isArray(raw.environmentVariables) ? raw.environmentVariables : [];
    if (registryType === "npm") {
      definition.command = process.platform === "win32" ? "npx.cmd" : "npx";
      definition.args = ["-y", version ? `${identifier}@${version}` : identifier];
    }
    else if (registryType === "pypi") {
      definition.command = process.platform === "win32" ? "uvx.exe" : "uvx";
      definition.args = [version ? `${identifier}==${version}` : identifier];
    }
    else if (registryType === "docker" || registryType === "oci") {
      definition.command = process.platform === "win32" ? "docker.exe" : "docker";
      definition.args = ["run", "--rm", "-i", version ? `${identifier}:${version}` : identifier];
    }
    else {
      return { ...definition, type: "package-metadata", unsupportedReason: `Unsupported MCP package registry type: ${registryType}` };
    }
    definition.cwd = ".";
    definition.env = {};
    return definition;
  }
  return { ...definition, type: "metadata-only", unsupportedReason: "MCP definition has no executable command or remote URL." };
}
function collectMcpFromObject(target, raw, pluginDir, sourcePath) {
  if (!raw || typeof raw !== "object") return;
  const collections = [raw.mcpServers, raw.mcp_servers];
  if (raw.servers && typeof raw.servers === "object") collections.push(raw.servers);
  for (const servers of collections) {
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) continue;
    for (const [id, value] of Object.entries(servers)) {
      const normalized = normalizeMcpDefinition(id, value, pluginDir, sourcePath);
      if (normalized) target.set(String(id), normalized);
    }
  }
  if (Array.isArray(raw.remotes)) {
    raw.remotes.forEach((remote, index) => {
      const normalized = normalizeMcpDefinition(`remote-${index + 1}`, remote, pluginDir, sourcePath);
      if (normalized) target.set(normalized.id, normalized);
    });
  }
  if (Array.isArray(raw.packages)) {
    raw.packages.forEach((pkg, index) => {
      const normalized = normalizeMcpDefinition(`package-${index + 1}`, pkg, pluginDir, sourcePath);
      if (normalized) target.set(normalized.id, normalized);
    });
  }
}
function manifestPaths(value, defaults = []) {
  const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : defaults;
  return values.map((entry) => String(entry || "").trim()).filter(Boolean);
}
function markdownComponents(relativeFiles, packageRoot, componentRoot, configuredPaths, defaultDir) {
  const results = [];
  const seen = new Set();
  const paths = manifestPaths(configuredPaths, [defaultDir]);
  for (const configured of paths) {
    let absolute;
    try { absolute = resolveWithin(componentRoot, configured); }
    catch { continue; }
    for (const [rel, file] of relativeFiles) {
      const matchesFile = resolve(file) === resolve(absolute);
      const matchesDir = isPathInside(file, absolute) && resolve(file) !== resolve(absolute);
      if ((!matchesFile && !matchesDir) || !file.toLowerCase().endsWith(".md")) continue;
      if (seen.has(rel)) continue;
      seen.add(rel);
      results.push({ name: basename(file, ".md"), path: relativePortable(packageRoot, file) });
    }
  }
  return results;
}
async function collectMcpConfigFile(target, packageRoot, componentRoot, relativeFiles, relName, idPrefix = "") {
  const path = relativeFiles.get(relName);
  if (!path) return;
  const raw = await readJsonIfExists(path);
  if (!raw) return;
  const local = new Map();
  collectMcpFromObject(local, raw, componentRoot || packageRoot, relName);
  for (const [id, definition] of local) {
    const finalId = idPrefix ? `${idPrefix}${id}` : id;
    target.set(finalId, { ...definition, id: finalId });
  }
}
async function scanPluginDirectory(pluginDir, options = {}) {
  const root = resolve(pluginDir);
  if (!await isDirectory(root)) throw new Error(`Plugin directory does not exist: ${root}`);
  const files = await walkFiles(root);
  const relativeFiles = new Map(files.map((file) => [relativePortable(root, file), file]));

  let primaryManifest;
  let manifestPath;
  for (const name of MANIFEST_NAMES) {
    if (relativeFiles.has(name)) {
      primaryManifest = await readJsonIfExists(relativeFiles.get(name));
      manifestPath = name;
      break;
    }
  }
  const primaryManifestIsDevspace = manifestPath === "devspace-plugin.json" || manifestPath === ".devspace/plugin.json";
  const packageJson = relativeFiles.has("package.json") ? await readJsonIfExists(relativeFiles.get("package.json")) : undefined;
  const pyproject = relativeFiles.has("pyproject.toml") ? await readPyprojectMetadata(relativeFiles.get("pyproject.toml")) : undefined;
  const claudeManifestEntries = [];
  for (const [rel, file] of relativeFiles) {
    const isClaude = rel === ".claude-plugin/plugin.json" || rel.endsWith("/.claude-plugin/plugin.json");
    const isCodex = rel === ".codex-plugin/plugin.json" || rel.endsWith("/.codex-plugin/plugin.json");
    if (!isClaude && !isCodex) continue;
    const manifest = await readJsonIfExists(file);
    if (!manifest) continue;
    claudeManifestEntries.push({
      manifest,
      manifestPath: rel,
      pluginKind: isCodex ? "codex" : "claude",
      pluginRoot: dirname(dirname(file)),
      pluginRootPath: relativePortable(root, dirname(dirname(file))),
    });
  }
  claudeManifestEntries.sort((a, b) => a.manifestPath.length - b.manifestPath.length || a.manifestPath.localeCompare(b.manifestPath));
  const rootClaudeEntry = claudeManifestEntries.find((entry) => entry.manifestPath === ".claude-plugin/plugin.json")
    || claudeManifestEntries.find((entry) => entry.manifestPath === ".codex-plugin/plugin.json");
  const claudeManifest = rootClaudeEntry?.manifest;
  const rootMetadata = primaryManifestIsDevspace
    ? primaryManifest
    : claudeManifest || {};
  const id = normalizeId(options.idOverride || rootMetadata.id || rootMetadata.name || options.fallbackId || packageJson?.name || pyproject?.name || basename(root));
  if (!id) throw new Error(`Unable to derive plugin id for ${root}`);
  const name = String(rootMetadata.title || rootMetadata.displayName || rootMetadata.name || packageJson?.displayName || packageJson?.name || pyproject?.name || id).slice(0, 180);
  const description = String(rootMetadata.description || packageJson?.description || pyproject?.description || "Installed DevSpace capability package").slice(0, 2000);
  const version = String(rootMetadata.version || packageJson?.version || pyproject?.version || "0.0.0").slice(0, 80);

  const skills = [];
  for (const [rel, file] of relativeFiles) {
    if (basename(file).toLowerCase() !== "skill.md") continue;
    let text = "";
    try { text = await readFile(file, "utf8"); } catch {}
    const fm = frontmatterFromSkill(text);
    skills.push({
      name: String(fm.name || basename(dirname(file))).slice(0, 160),
      description: String(fm.description || "Reusable agent skill").slice(0, 1200),
      filePath: rel,
      baseDir: relativePortable(root, dirname(file)),
    });
  }

  const instructions = [];
  const instructionPaths = new Set();
  for (const [rel, file] of relativeFiles) {
    if (!INSTRUCTION_NAMES.has(basename(file))) continue;
    instructions.push({ name: basename(file), path: rel });
    instructionPaths.add(rel);
  }
  const addDeclaredInstructions = (componentRoot, declarations) => {
    for (const declared of normalizePathList(declarations)) {
      let absolute;
      try { absolute = resolveWithin(componentRoot, declared); }
      catch { continue; }
      const rel = relativePortable(root, absolute);
      if (!relativeFiles.has(rel) || instructionPaths.has(rel)) continue;
      instructions.push({ name: basename(absolute), path: rel });
      instructionPaths.add(rel);
    }
  };
  if (primaryManifestIsDevspace) addDeclaredInstructions(root, primaryManifest?.instructions);
  for (const entry of claudeManifestEntries) addDeclaredInstructions(entry.pluginRoot, entry.manifest?.instructions);

  const componentRootForFile = (file) => {
    const candidates = claudeManifestEntries
      .filter((entry) => isPathInside(file, entry.pluginRoot))
      .sort((a, b) => b.pluginRoot.length - a.pluginRoot.length);
    return candidates[0]?.pluginRoot || root;
  };
  const mcpMap = new Map();
  if (primaryManifestIsDevspace) collectMcpFromObject(mcpMap, primaryManifest, root, manifestPath || "devspace-plugin.json");
  for (const entry of claudeManifestEntries) {
    if (typeof entry.manifest?.mcpServers !== "string") {
      collectMcpFromObject(mcpMap, entry.manifest, entry.pluginRoot, entry.manifestPath);
    }
  }
  if (packageJson) collectMcpFromObject(mcpMap, packageJson, root, "package.json");
  for (const configName of MCP_CONFIG_NAMES) {
    const relName = configName.split(sep).join("/");
    const path = relativeFiles.get(relName);
    if (!path) continue;
    const raw = await readJsonIfExists(path);
    if (!raw) continue;
    if (configName === "server.json") {
      const serverId = raw.name || raw.title || "server";
      if (Array.isArray(raw.remotes)) {
        raw.remotes.forEach((remote, index) => {
          const normalized = normalizeMcpDefinition(`${serverId}:remote-${index + 1}`, remote, root, relName);
          if (normalized) mcpMap.set(normalized.id, normalized);
        });
      }
      if (Array.isArray(raw.packages)) {
        raw.packages.forEach((pkg, index) => {
          const normalized = normalizeMcpDefinition(`${serverId}:package-${index + 1}`, pkg, root, relName);
          if (normalized) mcpMap.set(normalized.id, normalized);
        });
      }
    }
    else {
      collectMcpFromObject(mcpMap, raw, root, relName);
    }
  }
  for (const entry of claudeManifestEntries) {
    if (typeof entry.manifest?.mcpServers !== "string") continue;
    try {
      const customAbsolute = resolveWithin(entry.pluginRoot, entry.manifest.mcpServers);
      const customRel = relativePortable(root, customAbsolute);
      await collectMcpConfigFile(mcpMap, root, entry.pluginRoot, relativeFiles, customRel);
    }
    catch {}
  }
  let nestedMcpProfiles = 0;
  for (const [rel, file] of relativeFiles) {
    if (!rel.toLowerCase().endsWith(".mcp.json") || rel === ".mcp.json") continue;
    if (nestedMcpProfiles >= 100) break;
    const prefix = `profile:${rel.replace(/\.mcp\.json$/i, "")}::`;
    await collectMcpConfigFile(mcpMap, root, componentRootForFile(file), relativeFiles, rel, prefix);
    nestedMcpProfiles += 1;
  }

  const dedupeComponents = (items) => [...new Map(items.map((item) => [item.path, item])).values()];
  const claudeCommands = dedupeComponents(claudeManifestEntries.flatMap((entry) =>
    markdownComponents(relativeFiles, root, entry.pluginRoot, entry.manifest?.commands, "./commands")));
  const claudeAgents = dedupeComponents(claudeManifestEntries.flatMap((entry) =>
    markdownComponents(relativeFiles, root, entry.pluginRoot, entry.manifest?.agents, "./agents")));
  const pluginHooks = [];
  for (const entry of claudeManifestEntries) {
    const declaredHooks = normalizePathList(entry.manifest?.hooks);
    if (declaredHooks.length) {
      for (const declared of declaredHooks) {
        try {
          const hookRel = relativePortable(root, resolveWithin(entry.pluginRoot, declared));
          if (relativeFiles.has(hookRel)) {
            pluginHooks.push({ path: hookRel, portable: false, host: entry.pluginKind, pluginRoot: entry.pluginRootPath });
          }
        }
        catch {}
      }
    }
    else if (entry.manifest?.hooks && typeof entry.manifest.hooks === "object") {
      pluginHooks.push({ path: `inline:${entry.manifestPath}#hooks`, portable: false, host: entry.pluginKind, pluginRoot: entry.pluginRootPath });
    }
    else {
      const defaultHook = relativePortable(root, join(entry.pluginRoot, "hooks", "hooks.json"));
      if (relativeFiles.has(defaultHook)) {
        pluginHooks.push({ path: defaultHook, portable: false, host: entry.pluginKind, pluginRoot: entry.pluginRootPath });
      }
    }
  }
  const claudeHooks = pluginHooks.filter((item) => item.host === "claude");
  const codexHooks = pluginHooks.filter((item) => item.host === "codex");

  const codexApps = [];
  const codexInterfaces = [];
  const bundledContentVariants = [];
  for (const entry of claudeManifestEntries.filter((item) => item.pluginKind === "codex")) {
    for (const declared of normalizePathList(entry.manifest?.apps)) {
      try {
        const appAbsolute = resolveWithin(entry.pluginRoot, declared);
        const appRel = relativePortable(root, appAbsolute);
        const appConfig = relativeFiles.has(appRel) ? await readJsonIfExists(appAbsolute) : undefined;
        const apps = appConfig?.apps && typeof appConfig.apps === "object" && !Array.isArray(appConfig.apps)
          ? appConfig.apps
          : {};
        for (const [name, descriptor] of Object.entries(apps)) {
          codexApps.push({
            name: String(name).slice(0, 160),
            id: String(descriptor?.id || "").slice(0, 300),
            path: appRel,
            pluginRoot: entry.pluginRootPath,
            platformManaged: true,
            executableByDevSpace: false,
          });
        }
      }
      catch {}
    }
    if (entry.manifest?.interface && typeof entry.manifest.interface === "object" && !Array.isArray(entry.manifest.interface)) {
      const value = entry.manifest.interface;
      codexInterfaces.push({
        pluginRoot: entry.pluginRootPath,
        displayName: String(value.displayName || entry.manifest.name || "").slice(0, 180),
        shortDescription: String(value.shortDescription || "").slice(0, 1000),
        longDescription: String(value.longDescription || "").slice(0, 3000),
        developerName: String(value.developerName || "").slice(0, 180),
        category: String(value.category || "").slice(0, 120),
        capabilities: normalizeStringArray(value.capabilities).slice(0, 50),
        websiteURL: value.websiteURL ? String(value.websiteURL).slice(0, 2048) : undefined,
        defaultPrompt: normalizeStringArray(value.defaultPrompt).slice(0, 20),
        brandColor: value.brandColor ? String(value.brandColor).slice(0, 64) : undefined,
      });
    }
    if (entry.manifest?.bundledContentVariant !== undefined) {
      bundledContentVariants.push({
        pluginRoot: entry.pluginRootPath,
        value: String(entry.manifest.bundledContentVariant).slice(0, 200),
      });
    }
  }

  const rawTools = Array.isArray(primaryManifest?.tools)
    ? primaryManifest.tools
    : primaryManifest?.tools && typeof primaryManifest.tools === "object"
      ? Object.entries(primaryManifest.tools).map(([name, value]) => ({ name, ...value }))
      : [];
  const tools = rawTools.map(normalizeCommandTool).filter(Boolean);

  const skillRoots = new Set(skills.map((skill) => skill.baseDir));
  const addDeclaredSkillRoots = async (componentRoot, declarations) => {
    for (const declared of normalizePathList(declarations)) {
      let absolute;
      try { absolute = resolveWithin(componentRoot, declared); }
      catch { continue; }
      if (await isDirectory(absolute)) skillRoots.add(relativePortable(root, absolute));
    }
  };
  if (primaryManifestIsDevspace) await addDeclaredSkillRoots(root, primaryManifest?.skills);
  for (const entry of claudeManifestEntries) await addDeclaredSkillRoots(entry.pluginRoot, entry.manifest?.skills);

  return {
    id,
    name,
    description,
    version,
    root,
    manifestPath,
    source: options.source || rootMetadata.source || sourceFromPackageJson(packageJson),
    detectedFormats: [
      primaryManifestIsDevspace ? "devspace-plugin" : undefined,
      claudeManifestEntries.some((entry) => entry.pluginKind === "claude") ? "claude-plugin" : undefined,
      claudeManifestEntries.some((entry) => entry.pluginKind === "codex") ? "codex-plugin" : undefined,
      skills.length ? "agent-skills" : undefined,
      instructions.length ? "agent-instructions" : undefined,
      mcpMap.size ? "mcp" : undefined,
      tools.length ? "command-tools" : undefined,
      claudeCommands.length ? "claude-commands" : undefined,
      claudeAgents.length ? "claude-agents" : undefined,
      claudeHooks.length ? "claude-hooks-metadata" : undefined,
      codexHooks.length ? "codex-hooks-metadata" : undefined,
      codexApps.length ? "codex-app-dependencies" : undefined,
      codexInterfaces.length ? "codex-interface-metadata" : undefined,
      bundledContentVariants.length ? "codex-bundled-content-metadata" : undefined,
      nestedMcpProfiles ? "nested-mcp-profiles" : undefined,
      relativeFiles.has("server.json") ? "mcp-registry-server-json" : undefined,
      pyproject ? "python-project-metadata" : undefined,
    ].filter(Boolean),
    skills,
    skillRoots: [...skillRoots],
    instructions,
    claudePluginRoots: claudeManifestEntries.filter((entry) => entry.pluginKind === "claude").map((entry) => ({
      name: String(entry.manifest?.name || basename(entry.pluginRoot)).slice(0, 160),
      version: String(entry.manifest?.version || "0.0.0").slice(0, 80),
      root: entry.pluginRootPath,
      manifestPath: entry.manifestPath,
    })),
    codexPluginRoots: claudeManifestEntries.filter((entry) => entry.pluginKind === "codex").map((entry) => ({
      name: String(entry.manifest?.name || basename(entry.pluginRoot)).slice(0, 160),
      version: String(entry.manifest?.version || "0.0.0").slice(0, 80),
      root: entry.pluginRootPath,
      manifestPath: entry.manifestPath,
    })),
    claudeCommands,
    claudeAgents,
    pluginHooks,
    claudeHooks,
    codexHooks,
    codexApps,
    codexInterfaces,
    bundledContentVariants,
    mcpServers: [...mcpMap.values()],
    tools,
    fileCount: files.length,
    fingerprint: sha256(JSON.stringify({
      id,
      version,
      skills: skills.map((skill) => skill.filePath),
      instructions: instructions.map((item) => item.path),
      claudeCommands: claudeCommands.map((item) => item.path),
      claudeAgents: claudeAgents.map((item) => item.path),
      pluginHooks: pluginHooks.map((item) => `${item.host}:${item.path}`),
      codexApps: codexApps.map((item) => `${item.name}:${item.id}:${item.path}`),
      codexInterfaces: codexInterfaces.map((item) => `${item.pluginRoot}:${item.displayName}:${item.category}`),
      bundledContentVariants: bundledContentVariants.map((item) => `${item.pluginRoot}:${item.value}`),
      mcp: [...mcpMap.values()].map((item) => ({ id: item.id, type: item.type, sourcePath: item.sourcePath })),
      tools: tools.map((item) => item.name),
    })),
  };
}

function safePluginSummary(discovered, registryEntry, probe) {
  return {
    id: discovered.id,
    name: discovered.name,
    description: discovered.description,
    version: discovered.version,
    enabled: Boolean(registryEntry?.enabled),
    trusted: Boolean(registryEntry?.trusted),
    managed: Boolean(registryEntry?.managed),
    source: registryEntry?.source || discovered.source,
    installDir: registryEntry?.managed ? discovered.root : undefined,
    detectedFormats: discovered.detectedFormats,
    skills: discovered.skills,
    instructions: discovered.instructions,
    claudePluginRoots: discovered.claudePluginRoots || [],
    codexPluginRoots: discovered.codexPluginRoots || [],
    claudeCommands: discovered.claudeCommands || [],
    claudeAgents: discovered.claudeAgents || [],
    pluginHooks: discovered.pluginHooks || [],
    claudeHooks: discovered.claudeHooks || [],
    codexHooks: discovered.codexHooks || [],
    codexApps: discovered.codexApps || [],
    codexInterfaces: discovered.codexInterfaces || [],
    bundledContentVariants: discovered.bundledContentVariants || [],
    mcpServers: discovered.mcpServers.map((server) => ({
      id: server.id,
      type: server.type,
      description: server.description,
      sourcePath: server.sourcePath,
      requiredEnv: capabilityRequiredEnvNames(discovered.id, server),
      package: server.package,
      unsupportedReason: server.unsupportedReason,
      capabilities: probe?.[server.id]?.capabilities,
      tools: probe?.[server.id]?.tools || [],
      prompts: probe?.[server.id]?.prompts || [],
      resources: probe?.[server.id]?.resources || [],
      probeErrors: probe?.[server.id]?.probeErrors,
      status: probe?.[server.id]?.status || "not-probed",
      error: probe?.[server.id]?.error,
    })),
    tools: discovered.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      requiredEnv: tool.requiredEnv,
      timeoutMs: tool.timeoutMs,
      inputSchema: tool.inputSchema,
    })),
    fingerprint: discovered.fingerprint,
  };
}
function compactPluginSummary(discovered, registryEntry, probe) {
  const probedToolNames = [];
  const probedPromptNames = [];
  const probedResourceUris = [];
  for (const server of discovered.mcpServers) {
    for (const tool of probe?.[server.id]?.tools || []) {
      if (tool?.name && !probedToolNames.includes(tool.name)) probedToolNames.push(tool.name);
      if (probedToolNames.length >= 30) break;
    }
    for (const prompt of probe?.[server.id]?.prompts || []) {
      if (prompt?.name && !probedPromptNames.includes(prompt.name)) probedPromptNames.push(prompt.name);
      if (probedPromptNames.length >= 30) break;
    }
    for (const resource of probe?.[server.id]?.resources || []) {
      if (resource?.uri && !probedResourceUris.includes(resource.uri)) probedResourceUris.push(resource.uri);
      if (probedResourceUris.length >= 30) break;
    }
  }
  return {
    id: discovered.id,
    name: discovered.name,
    description: discovered.description,
    version: discovered.version,
    enabled: Boolean(registryEntry?.enabled),
    trusted: Boolean(registryEntry?.trusted),
    managed: Boolean(registryEntry?.managed),
    source: registryEntry?.source || discovered.source,
    detectedFormats: discovered.detectedFormats,
    counts: {
      skills: discovered.skills.length,
      instructions: discovered.instructions.length,
      claudePluginRoots: discovered.claudePluginRoots?.length || 0,
      codexPluginRoots: discovered.codexPluginRoots?.length || 0,
      claudeCommands: discovered.claudeCommands?.length || 0,
      claudeAgents: discovered.claudeAgents?.length || 0,
      pluginHooks: discovered.pluginHooks?.length || 0,
      codexHooks: discovered.codexHooks?.length || 0,
      codexApps: discovered.codexApps?.length || 0,
      codexInterfaces: discovered.codexInterfaces?.length || 0,
      bundledContentVariants: discovered.bundledContentVariants?.length || 0,
      mcpServers: discovered.mcpServers.length,
      commandTools: discovered.tools.length,
    },
    skillNames: discovered.skills.slice(0, 20).map((skill) => skill.name),
    mcpServerIds: discovered.mcpServers.slice(0, 20).map((server) => server.id),
    commandToolNames: discovered.tools.slice(0, 20).map((tool) => tool.name),
    codexAppNames: (discovered.codexApps || []).slice(0, 20).map((app) => app.name),
    codexHookPaths: (discovered.codexHooks || []).slice(0, 20).map((hook) => hook.path),
    probedMcpToolNames: probedToolNames,
    probedMcpPromptNames: probedPromptNames,
    probedMcpResourceUris: probedResourceUris,
  };
}

async function runProcess(command, args, options = {}) {
  const timeoutMs = clampInteger(options.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS, 1000, MAX_TOOL_TIMEOUT_MS);
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch {}
      rejectPromise(error);
    };
    const push = (current, chunk, label) => {
      const next = Buffer.concat([current, Buffer.from(chunk)]);
      if (next.length > MAX_PROCESS_OUTPUT_BYTES) {
        fail(new Error(`${label} exceeded ${MAX_PROCESS_OUTPUT_BYTES} bytes.`));
        return current;
      }
      return next;
    };
    child.stdout.on("data", (chunk) => { stdout = push(stdout, chunk, "stdout"); });
    child.stderr.on("data", (chunk) => { stderr = push(stderr, chunk, "stderr"); });
    child.once("error", fail);
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        code,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      };
      if (code !== 0) {
        rejectPromise(new Error(`Process exited ${code ?? signal}: ${result.stderr || result.stdout}`.trim()));
      }
      else resolvePromise(result);
    });
    const timer = setTimeout(() => fail(new Error(`Process timed out after ${timeoutMs} ms.`)), timeoutMs);
    if (options.stdin !== undefined) child.stdin.end(String(options.stdin));
    else child.stdin.end();
  });
}

async function git(args, options = {}) {
  const command = process.platform === "win32" ? "git.exe" : "git";
  return await runProcess(command, args, { ...options, timeoutMs: options.timeoutMs ?? 120_000 });
}
function validateInstallSource(source) {
  const raw = String(source || "").trim();
  if (!raw) throw new Error("source is required.");
  if (/^(https?:\/\/|ssh:\/\/)/i.test(raw)) {
    const parsed = new URL(raw);
    if (parsed.password || (parsed.protocol.startsWith("http") && parsed.username)) {
      throw new Error("Capability source URLs must not contain embedded credentials. Use normal Git credential helpers instead.");
    }
    if (parsed.search || parsed.hash) {
      throw new Error("Capability source URLs must not contain query strings or fragments. Use the separate ref field for a branch/tag/ref.");
    }
  }
  return raw;
}
function looksLikeGitSource(source) {
  const raw = String(source || "").trim();
  return /^(https?:\/\/|ssh:\/\/|git@)/i.test(raw) || /\.git$/i.test(raw);
}
function sourceBasename(source) {
  const clean = String(source || "").replace(/[?#].*$/, "").replace(/\.git$/, "").replace(/[\\/]+$/, "");
  return basename(clean) || "plugin";
}

export class CapabilityRuntime {
  constructor(options) {
    this.pluginsDir = resolve(options.pluginsDir);
    this.packagesDir = join(this.pluginsDir, "packages");
    this.registryPath = resolve(options.registryPath);
    this.externalPluginPaths = (options.pluginPaths || []).map((path) => resolve(expandHome(path)));
    this.enabled = options.enabled !== false;
    this.state = { version: REGISTRY_VERSION, plugins: {} };
    this.discovered = new Map();
    this.probes = new Map();
    this.mcpClients = new Map();
    this.mcpConnecting = new Map();
    this.mcpStartupTails = new Map();
    this.mcpInstances = new Map();
    this.mutationTail = Promise.resolve();
    this.ready = this.initialize();
  }

  async initialize() {
    await mkdir(this.packagesDir, { recursive: true });
    await mkdir(dirname(this.registryPath), { recursive: true });
    const persisted = await readJsonIfExists(this.registryPath);
    if (persisted?.version === REGISTRY_VERSION && persisted.plugins && typeof persisted.plugins === "object") {
      this.state = persisted;
    }
    await this.refresh({ probeMcp: false });
  }

  async serializeMutation(operation) {
    const previous = this.mutationTail;
    let release;
    this.mutationTail = new Promise((resolveRelease) => { release = resolveRelease; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }

  async save() {
    const temp = `${this.registryPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const publicState = {
      version: REGISTRY_VERSION,
      plugins: Object.fromEntries(Object.entries(this.state.plugins).map(([id, entry]) => [id, {
        id,
        dir: entry.dir,
        source: entry.source,
        sourceType: entry.sourceType,
        ref: entry.ref,
        enabled: Boolean(entry.enabled),
        trusted: Boolean(entry.trusted),
        managed: Boolean(entry.managed),
        installedAt: entry.installedAt,
        updatedAt: entry.updatedAt,
      }])),
    };
    await writeFile(temp, JSON.stringify(publicState, null, 2) + "\n", { mode: 0o600 });
    await rename(temp, this.registryPath);
  }

  registryEntry(id) {
    return this.state.plugins[id];
  }

  requirePlugin(id, { enabled = false, trusted = false } = {}) {
    const plugin = this.discovered.get(id);
    const entry = this.registryEntry(id);
    if (!plugin || !entry) throw new Error(`Unknown capability plugin: ${id}`);
    if (enabled && !entry.enabled) throw new Error(`Capability plugin ${id} is disabled.`);
    if (trusted && !entry.trusted) throw new Error(`Capability plugin ${id} is not trusted for code execution.`);
    return { plugin, entry };
  }

  async discoverExternal() {
    const results = [];
    for (const configured of this.externalPluginPaths) {
      if (!await isDirectory(configured)) continue;
      const directSignals = [...MANIFEST_NAMES, ...MCP_CONFIG_NAMES, "package.json", "SKILL.md"].some((name) => existsSync(join(configured, name)));
      if (directSignals) {
        results.push(configured);
        continue;
      }
      let entries = [];
      try { entries = await readdir(configured, { withFileTypes: true }); } catch {}
      for (const entry of entries) if (entry.isDirectory()) results.push(join(configured, entry.name));
    }
    return results;
  }

  async refresh({ pluginId, probeMcp = false } = {}) {
    if (!this.enabled) return { ok: true, enabled: false, plugins: [] };
    const refreshTargets = pluginId ? [pluginId] : [...this.discovered.keys()];
    for (const id of refreshTargets) await this.closePluginClients(id);
    const next = new Map();
    for (const [id, entry] of Object.entries(this.state.plugins)) {
      if (entry.sourceType === "external-path") continue;
      if (pluginId && id !== pluginId) continue;
      const dir = resolve(entry.dir);
      if (!await isDirectory(dir)) continue;
      const discovered = await scanPluginDirectory(dir, { idOverride: id, source: entry.source });
      next.set(id, discovered);
    }
    const externalSeen = new Set();
    for (const dir of await this.discoverExternal()) {
      try {
        const discovered = await scanPluginDirectory(dir);
        if (pluginId && discovered.id !== pluginId) continue;
        const existing = this.state.plugins[discovered.id];
        if (existing && existing.sourceType !== "external-path") continue;
        externalSeen.add(discovered.id);
        this.state.plugins[discovered.id] = {
          id: discovered.id,
          dir,
          source: dir,
          sourceType: "external-path",
          enabled: existing?.sourceType === "external-path" ? existing.enabled !== false : true,
          trusted: existing?.sourceType === "external-path" ? existing.trusted !== false : true,
          managed: false,
          installedAt: existing?.installedAt || nowIso(),
          updatedAt: nowIso(),
        };
        next.set(discovered.id, discovered);
      }
      catch {}
    }
    if (!pluginId) {
      for (const [id, entry] of Object.entries(this.state.plugins)) {
        if (entry.sourceType === "external-path" && !externalSeen.has(id)) delete this.state.plugins[id];
      }
    }
    if (pluginId) {
      if (next.has(pluginId)) this.discovered.set(pluginId, next.get(pluginId));
      else this.discovered.delete(pluginId);
    }
    else {
      this.discovered = next;
    }
    await this.save();
    if (probeMcp) {
      const ids = pluginId ? [pluginId] : [...this.discovered.keys()];
      for (const id of ids) {
        const entry = this.registryEntry(id);
        if (!entry?.enabled || !entry?.trusted) continue;
        await this.probePluginMcp(id).catch(() => {});
      }
    }
    return {
      ok: true,
      enabled: true,
      plugins: this.currentSummaries(true, true),
    };
  }

  currentSummaries(includeDisabled = false, compact = false) {
    const rows = [];
    for (const [id, discovered] of this.discovered) {
      const entry = this.registryEntry(id);
      if (!includeDisabled && !entry?.enabled) continue;
      rows.push(compact
        ? compactPluginSummary(discovered, entry, this.probes.get(id))
        : safePluginSummary(discovered, entry, this.probes.get(id)));
    }
    rows.sort((a, b) => a.id.localeCompare(b.id));
    return rows;
  }

  async list({ includeDisabled = false, probeMcp = false } = {}) {
    await this.ready;
    if (probeMcp) {
      for (const id of this.discovered.keys()) {
        const entry = this.registryEntry(id);
        if (!entry?.enabled || !entry?.trusted) continue;
        await this.probePluginMcp(id).catch(() => {});
      }
    }
    return this.currentSummaries(includeDisabled, true);
  }

  async search(query, { includeDisabled = false, limit = 20 } = {}) {
    await this.ready;
    const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return this.currentSummaries(includeDisabled, true).slice(0, clampInteger(limit, 20, 1, 100));
    const scored = [];
    for (const [id, plugin] of this.discovered) {
      const entry = this.registryEntry(id);
      if (!includeDisabled && !entry?.enabled) continue;
      const fields = {
        id: plugin.id.toLowerCase(),
        name: plugin.name.toLowerCase(),
        description: plugin.description.toLowerCase(),
        skills: plugin.skills.map((item) => `${item.name} ${item.description}`).join(" ").toLowerCase(),
        mcp: plugin.mcpServers.map((item) => `${item.id} ${item.description}`).join(" ").toLowerCase(),
        tools: plugin.tools.map((item) => `${item.name} ${item.description}`).join(" ").toLowerCase(),
        apps: (plugin.codexApps || []).map((item) => `${item.name} ${item.id}`).join(" ").toLowerCase(),
        interface: (plugin.codexInterfaces || []).map((item) => `${item.displayName} ${item.shortDescription} ${item.longDescription} ${item.developerName} ${item.category} ${(item.capabilities || []).join(" ")}`).join(" ").toLowerCase(),
        probed: Object.values(this.probes.get(id) || {}).flatMap((item) => [
          ...(item.tools || []).map((tool) => `${tool.name} ${tool.description || ""}`),
          ...(item.prompts || []).map((prompt) => `${prompt.name} ${prompt.description || ""}`),
          ...(item.resources || []).map((resource) => `${resource.name || ""} ${resource.uri || ""} ${resource.description || ""}`),
        ]).join(" ").toLowerCase(),
      };
      let score = 0;
      let matched = true;
      for (const term of terms) {
        let termScore = 0;
        if (fields.id.includes(term)) termScore = Math.max(termScore, 12);
        if (fields.name.includes(term)) termScore = Math.max(termScore, 10);
        if (fields.tools.includes(term) || fields.probed.includes(term)) termScore = Math.max(termScore, 8);
        if (fields.skills.includes(term) || fields.mcp.includes(term) || fields.apps.includes(term)) termScore = Math.max(termScore, 6);
        if (fields.description.includes(term) || fields.interface.includes(term)) termScore = Math.max(termScore, 3);
        if (!termScore) { matched = false; break; }
        score += termScore;
      }
      if (matched) scored.push({ score, plugin: compactPluginSummary(plugin, entry, this.probes.get(id)) });
    }
    scored.sort((a, b) => b.score - a.score || a.plugin.id.localeCompare(b.plugin.id));
    return scored.slice(0, clampInteger(limit, 20, 1, 100)).map((row) => ({ score: row.score, ...row.plugin }));
  }

  async inspect(id, { probeMcp = false } = {}) {
    await this.ready;
    const { plugin, entry } = this.requirePlugin(id);
    if (probeMcp && entry.enabled && entry.trusted) await this.probePluginMcp(id).catch(() => {});
    return safePluginSummary(plugin, entry, this.probes.get(id));
  }

  async install({ source, id, ref, enable = false, trust = false }) {
    await this.ready;
    if (!this.enabled) throw new Error("Capability plugins are disabled in DevSpace configuration.");
    const rawSource = validateInstallSource(source);
    const staging = join(this.pluginsDir, `.staging-${randomBytes(8).toString("hex")}`);
    await rm(staging, { recursive: true, force: true });
    let sourceType;
    let sourceFallbackId;
    try {
      if (looksLikeGitSource(rawSource)) {
        sourceType = "git";
        sourceFallbackId = sourceBasename(rawSource);
        const args = ["clone", "--depth", "1"];
        if (ref) args.push("--branch", String(ref));
        args.push(rawSource, staging);
        await git(args, { cwd: this.pluginsDir, timeoutMs: 180_000 });
      }
      else {
        sourceType = "local-copy";
        const localSource = resolve(expandHome(rawSource));
        sourceFallbackId = basename(localSource);
        if (!await isDirectory(localSource)) throw new Error(`Local capability source is not a directory: ${localSource}`);
        await cp(localSource, staging, {
          recursive: true,
          force: false,
          filter: (path) => !path.split(/[\\/]/).includes(".git"),
        });
      }
      const discovered = await scanPluginDirectory(staging, { idOverride: id, fallbackId: sourceFallbackId, source: rawSource });
      if (this.state.plugins[discovered.id]) throw new Error(`Capability plugin already installed: ${discovered.id}`);
      const target = join(this.packagesDir, slugify(discovered.id || sourceBasename(rawSource)));
      if (existsSync(target)) throw new Error(`Capability install target already exists: ${target}`);
      await rename(staging, target);
      const timestamp = nowIso();
      this.state.plugins[discovered.id] = {
        id: discovered.id,
        dir: target,
        source: rawSource,
        sourceType,
        ref: ref ? String(ref) : undefined,
        enabled: Boolean(enable),
        trusted: Boolean(trust),
        managed: true,
        installedAt: timestamp,
        updatedAt: timestamp,
      };
      if (enable && !trust) {
        this.state.plugins[discovered.id].enabled = false;
      }
      await this.save();
      await this.refresh({ pluginId: discovered.id, probeMcp: false });
      return {
        ok: true,
        plugin: await this.inspect(discovered.id),
        note: enable && !trust
          ? "Installed but kept disabled because code execution was not trusted. Enable with trust=true after review."
          : undefined,
      };
    }
    catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async setEnabled(id, enabled, { trust } = {}) {
    await this.ready;
    const { entry } = this.requirePlugin(id);
    if (trust !== undefined) entry.trusted = Boolean(trust);
    if (enabled && !entry.trusted) {
      throw new Error(`Capability plugin ${id} must be explicitly trusted before it can be enabled.`);
    }
    entry.enabled = Boolean(enabled);
    entry.updatedAt = nowIso();
    if (!entry.enabled) await this.closePluginClients(id);
    await this.save();
    return { ok: true, plugin: await this.inspect(id) };
  }

  async update(id, { ref } = {}) {
    await this.ready;
    const { entry } = this.requirePlugin(id);
    if (!entry.managed) throw new Error(`External-path capability ${id} cannot be updated by DevSpace.`);
    if (entry.sourceType !== "git") throw new Error(`Capability ${id} was not installed from Git; reinstall it to update.`);
    await this.closePluginClients(id);
    if (ref) {
      await git(["fetch", "--depth", "1", "origin", String(ref)], { cwd: entry.dir, timeoutMs: 180_000 });
      await git(["checkout", "--detach", "FETCH_HEAD"], { cwd: entry.dir, timeoutMs: 60_000 });
      entry.ref = String(ref);
    }
    else {
      await git(["pull", "--ff-only"], { cwd: entry.dir, timeoutMs: 180_000 });
    }
    entry.updatedAt = nowIso();
    await this.save();
    await this.refresh({ pluginId: id, probeMcp: false });
    return { ok: true, plugin: await this.inspect(id) };
  }

  async uninstall(id) {
    await this.ready;
    const { entry } = this.requirePlugin(id);
    if (!entry.managed) throw new Error(`External-path capability ${id} is configuration-owned and cannot be uninstalled.`);
    if (!isPathInside(entry.dir, this.packagesDir)) throw new Error("Refusing to remove a capability outside the managed plugin package directory.");
    await this.closePluginClients(id);
    await rm(entry.dir, { recursive: true, force: true });
    delete this.state.plugins[id];
    this.discovered.delete(id);
    this.probes.delete(id);
    await this.save();
    return { ok: true, id, removed: true };
  }

  async readResource(id, resourcePath) {
    await this.ready;
    const { plugin, entry } = this.requirePlugin(id, { enabled: true });
    if (!entry.trusted) throw new Error(`Capability plugin ${id} is not trusted for instruction/resource use.`);
    const absolute = await resolveExistingWithin(plugin.root, resourcePath);
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error("Capability resource is not a file.");
    if (info.size > MAX_TEXT_RESOURCE_BYTES) throw new Error(`Capability resource exceeds ${MAX_TEXT_RESOURCE_BYTES} bytes.`);
    const content = await readFile(absolute, "utf8");
    return {
      ok: true,
      pluginId: id,
      path: relativePortable(plugin.root, absolute),
      content,
    };
  }

  sanitizeInstanceEnv(value = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("instance env must be an object.");
    const entries = Object.entries(value);
    if (entries.length > 64) throw new Error("instance env supports at most 64 variables.");
    const result = {};
    for (const [name, raw] of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) throw new Error(`Invalid instance environment variable name: ${name}`);
      const text = String(raw ?? "");
      if (text.length > 8192) throw new Error(`Instance environment variable ${name} is too large.`);
      result[name] = text;
    }
    return result;
  }

  instanceKey(pluginId, serverId, instanceId) {
    return `${pluginId}::${serverId}::${instanceId}`;
  }

  publicInstance(instance) {
    return {
      pluginId: instance.pluginId,
      serverId: instance.serverId,
      instanceId: instance.instanceId,
      ownerLabel: instance.ownerLabel,
      createdAt: instance.createdAt,
      lastUsedAt: instance.lastUsedAt,
      expiresAt: instance.expiresAt,
      envNames: Object.keys(instance.envOverrides || {}).sort(),
    };
  }

  async cleanupExpiredInstances() {
    const now = Date.now();
    const expired = [];
    for (const [key, instance] of this.mcpInstances) {
      if (Date.parse(instance.expiresAt) > now) continue;
      expired.push([key, instance]);
    }
    for (const [key, instance] of expired) {
      this.mcpInstances.delete(key);
      await this.closeClientKey(this.clientKey(instance.pluginId, instance.serverId, instance.instanceId));
    }
    return expired.length;
  }

  findInstanceByToken(instanceToken) {
    const tokenHash = sha256(instanceToken || "");
    for (const instance of this.mcpInstances.values()) {
      if (instance.tokenHash === tokenHash) return instance;
    }
    throw new Error("Invalid or expired capability instance token.");
  }

  async claimInstance({ pluginId, serverId, instanceId, ownerLabel = "agent", env = {}, leaseSeconds }) {
    await this.ready;
    await this.cleanupExpiredInstances();
    const { plugin } = this.requirePlugin(pluginId, { enabled: true, trusted: true });
    const definition = plugin.mcpServers.find((server) => server.id === serverId);
    if (!definition) throw new Error(`Unknown MCP server ${serverId} in plugin ${pluginId}.`);
    if (definition.type !== "stdio") throw new Error("Capability instances currently support stdio MCP servers; remote MCP servers should expose their own independent endpoint URL.");
    const normalizedInstanceId = normalizeId(instanceId);
    if (!normalizedInstanceId) throw new Error("instanceId is required.");
    const key = this.instanceKey(pluginId, serverId, normalizedInstanceId);
    if (this.mcpInstances.has(key)) throw new Error(`Capability MCP instance ${normalizedInstanceId} is already claimed.`);
    const leaseMs = clampInteger(leaseSeconds, Math.round(DEFAULT_INSTANCE_LEASE_MS / 1000), 60, Math.round(MAX_INSTANCE_LEASE_MS / 1000)) * 1000;
    const timestamp = nowIso();
    const instanceToken = randomBytes(32).toString("base64url");
    const instance = {
      pluginId,
      serverId,
      instanceId: normalizedInstanceId,
      tokenHash: sha256(instanceToken),
      ownerLabel: String(ownerLabel || "agent").slice(0, 120),
      envOverrides: this.sanitizeInstanceEnv(env),
      leaseMs,
      createdAt: timestamp,
      lastUsedAt: timestamp,
      expiresAt: new Date(Date.now() + leaseMs).toISOString(),
    };
    this.mcpInstances.set(key, instance);
    return {
      ok: true,
      instanceToken,
      instance: this.publicInstance(instance),
      instruction: "Keep instanceToken private. Pass it to capability_call for this stateful MCP instance, then release it with capability_instance(action=release).",
    };
  }

  async touchInstance(instanceToken, pluginId, serverId) {
    await this.ready;
    await this.cleanupExpiredInstances();
    const instance = this.findInstanceByToken(instanceToken);
    if (pluginId && instance.pluginId !== pluginId) throw new Error("Capability instance token belongs to a different plugin.");
    if (serverId && instance.serverId !== serverId) throw new Error("Capability instance token belongs to a different MCP server.");
    const timestamp = nowIso();
    instance.lastUsedAt = timestamp;
    instance.expiresAt = new Date(Date.now() + instance.leaseMs).toISOString();
    return instance;
  }

  async listInstances({ pluginId, serverId } = {}) {
    await this.ready;
    await this.cleanupExpiredInstances();
    return [...this.mcpInstances.values()]
      .filter((item) => (!pluginId || item.pluginId === pluginId) && (!serverId || item.serverId === serverId))
      .map((item) => this.publicInstance(item))
      .sort((a, b) => `${a.pluginId}/${a.serverId}/${a.instanceId}`.localeCompare(`${b.pluginId}/${b.serverId}/${b.instanceId}`));
  }

  async releaseInstance(instanceToken) {
    await this.ready;
    const instance = this.findInstanceByToken(instanceToken);
    const key = this.instanceKey(instance.pluginId, instance.serverId, instance.instanceId);
    this.mcpInstances.delete(key);
    await this.closeClientKey(this.clientKey(instance.pluginId, instance.serverId, instance.instanceId));
    return { ok: true, released: true, instance: this.publicInstance(instance) };
  }

  clientKey(pluginId, serverId, instanceId) {
    return instanceId ? `${pluginId}::${serverId}::instance:${instanceId}` : `${pluginId}::${serverId}`;
  }

  async closeClientKey(key) {
    const pending = this.mcpConnecting.get(key);
    if (pending) {
      try {
        const holder = await pending;
        this.mcpClients.delete(key);
        try { await holder.client.close(); } catch {}
        try { await holder.transport.close(); } catch {}
      }
      catch {}
    }
    const holder = this.mcpClients.get(key);
    if (holder) {
      this.mcpClients.delete(key);
      try { await holder.client.close(); } catch {}
      try { await holder.transport.close(); } catch {}
    }
  }

  async closePluginClients(pluginId) {
    const prefix = `${pluginId}::`;
    for (const [key, instance] of [...this.mcpInstances.entries()]) {
      if (instance.pluginId === pluginId) this.mcpInstances.delete(key);
    }
    for (const [key, pending] of [...this.mcpConnecting.entries()]) {
      if (!key.startsWith(prefix)) continue;
      try {
        const holder = await pending;
        this.mcpClients.delete(key);
        try { await holder.client.close(); } catch {}
        try { await holder.transport.close(); } catch {}
      }
      catch {}
    }
    for (const [key, holder] of [...this.mcpClients.entries()]) {
      if (!key.startsWith(prefix)) continue;
      this.mcpClients.delete(key);
      try { await holder.client.close(); } catch {}
      try { await holder.transport.close(); } catch {}
    }
  }

  async createMcpClient(pluginId, definition, instance) {
    const { plugin } = this.requirePlugin(pluginId, { enabled: true, trusted: true });
    if (["metadata-only", "package-metadata"].includes(definition.type)) {
      throw new Error(definition.unsupportedReason || `MCP server ${definition.id} cannot be launched.`);
    }
    assertRequiredEnv(definition);
    const client = new Client({ name: `devspace-ultra-capability-${slugify(pluginId)}`, version: "0.3.1" });
    let transport;
    if (definition.type === "stdio") {
      const componentRoot = definition.baseDir && isPathInside(definition.baseDir, plugin.root)
        ? definition.baseDir
        : plugin.root;
      const templateEnv = {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: componentRoot,
        DEVSPACE_PLUGIN_ROOT: plugin.root,
      };
      const declaredEnvironment = {};
      for (const name of normalizeStringArray(definition.requiredEnv)) {
        if (process.env[name] !== undefined) declaredEnvironment[name] = String(process.env[name]);
      }
      for (const item of Array.isArray(definition.environmentVariables) ? definition.environmentVariables : []) {
        if (!item?.name) continue;
        const value = process.env[item.name] ?? item.default;
        if (value !== undefined) declaredEnvironment[item.name] = String(value);
      }
      transport = new StdioClientTransport({
        command: replaceEnvTemplates(definition.command, templateEnv),
        args: (definition.args || []).map((arg) => replaceEnvTemplates(arg, templateEnv)),
        cwd: await resolveExistingWithin(componentRoot, definition.cwd || "."),
        env: {
          ...capabilityProcessEnvironment(),
          CLAUDE_PLUGIN_ROOT: componentRoot,
          DEVSPACE_PLUGIN_ROOT: plugin.root,
          ...declaredEnvironment,
          ...resolveEnvObject(definition.env, templateEnv),
          ...(instance?.envOverrides || {}),
        },
        stderr: "pipe",
      });
    }
    else if (definition.type === "sse") {
      const remote = resolveRemoteConnection(pluginId, definition);
      transport = new SSEClientTransport(new URL(remote.url), {
        eventSourceInit: {
          fetch: (url, init) => fetch(url, {
            ...init,
            headers: { ...Object.fromEntries(new Headers(init?.headers || {}).entries()), ...remote.headers },
          }),
        },
        requestInit: { headers: remote.headers },
      });
    }
    else {
      const remote = resolveRemoteConnection(pluginId, definition);
      transport = new StreamableHTTPClientTransport(new URL(remote.url), {
        requestInit: { headers: remote.headers },
      });
    }
    let stderrTail = "";
    if (transport instanceof StdioClientTransport && transport.stderr) {
      transport.stderr.on("data", (chunk) => { stderrTail = (stderrTail + String(chunk)).slice(-8192); });
    }
    try {
      await withTimeout(client.connect(transport), definition.connectTimeoutMs || MCP_CONNECT_TIMEOUT_MS, `MCP connect ${pluginId}/${definition.id}${instance ? `/${instance.instanceId}` : ""}`);
    }
    catch (error) {
      try { await transport.close(); } catch {}
      const base = error instanceof Error ? error.message : String(error);
      throw new Error(stderrTail.trim() ? `${base}\nMCP stderr:\n${stderrTail.trim()}` : base);
    }
    return { client, transport, definition };
  }

  async serializeMcpStartup(pluginId, serverId, operation) {
    const key = `${pluginId}::${serverId}`;
    const previous = this.mcpStartupTails.get(key) || Promise.resolve();
    let release;
    const tail = new Promise((resolveRelease) => { release = resolveRelease; });
    this.mcpStartupTails.set(key, tail);
    await previous.catch(() => {});
    try { return await operation(); }
    finally {
      release();
      if (this.mcpStartupTails.get(key) === tail) this.mcpStartupTails.delete(key);
    }
  }

  async getMcpClient(pluginId, serverId, instanceToken) {
    const { plugin } = this.requirePlugin(pluginId, { enabled: true, trusted: true });
    const definition = plugin.mcpServers.find((server) => server.id === serverId);
    if (!definition) throw new Error(`Unknown MCP server ${serverId} in plugin ${pluginId}.`);
    const instance = instanceToken ? await this.touchInstance(instanceToken, pluginId, serverId) : undefined;
    const key = this.clientKey(pluginId, serverId, instance?.instanceId);
    const existing = this.mcpClients.get(key);
    if (existing) return existing;
    let pending = this.mcpConnecting.get(key);
    if (!pending) {
      pending = this.serializeMcpStartup(pluginId, serverId, () => this.createMcpClient(pluginId, definition, instance))
        .then((holder) => {
          this.mcpClients.set(key, holder);
          return holder;
        })
        .finally(() => this.mcpConnecting.delete(key));
      this.mcpConnecting.set(key, pending);
    }
    return await pending;
  }

  async executeMcpRequest(pluginId, serverId, instanceToken, operation) {
    const holder = await this.getMcpClient(pluginId, serverId, instanceToken);
    const instance = instanceToken ? this.findInstanceByToken(instanceToken) : undefined;
    const key = this.clientKey(pluginId, serverId, instance?.instanceId);
    try {
      return {
        result: await operation(holder.client, mcpRequestOptions()),
        instance,
      };
    }
    catch (error) {
      if (shouldInvalidateMcpClient(error)) await this.closeClientKey(key).catch(() => {});
      throw error;
    }
  }

  async probePluginMcp(pluginId) {
    await this.ready;
    const { plugin } = this.requirePlugin(pluginId, { enabled: true, trusted: true });
    const probe = {};
    const runnable = [];
    for (const definition of plugin.mcpServers) {
      if (["metadata-only", "package-metadata"].includes(definition.type)) {
        probe[definition.id] = { status: "unsupported", tools: [], error: definition.unsupportedReason };
        continue;
      }
      if (runnable.length >= MAX_MCP_PROBE_SERVERS) {
        probe[definition.id] = {
          status: "not-probed-limit",
          tools: [],
          error: `Automatic probe limit is ${MAX_MCP_PROBE_SERVERS} MCP servers per plugin; call the selected server directly when needed.`,
        };
        continue;
      }
      runnable.push(definition);
    }
    let cursor = 0;
    const worker = async () => {
      while (cursor < runnable.length) {
        const definition = runnable[cursor++];
        try {
          const holder = await this.getMcpClient(pluginId, definition.id);
          const capabilities = holder.client.getServerCapabilities() || {};
          const entry = {
            status: "online",
            capabilities: {
              tools: Boolean(capabilities.tools),
              prompts: Boolean(capabilities.prompts),
              resources: Boolean(capabilities.resources),
            },
            tools: [],
            prompts: [],
            resources: [],
            probeErrors: {},
          };
          if (capabilities.tools) {
            try {
              const { result: listed } = await this.executeMcpRequest(
                pluginId,
                definition.id,
                undefined,
                (client, options) => client.listTools(undefined, options),
              );
              entry.tools = (listed.tools || []).map((tool) => ({
                name: tool.name,
                description: tool.description || "",
                inputSchema: tool.inputSchema,
              }));
            }
            catch (error) { entry.probeErrors.tools = error instanceof Error ? error.message : String(error); }
          }
          if (capabilities.prompts) {
            try {
              const { result: listed } = await this.executeMcpRequest(
                pluginId,
                definition.id,
                undefined,
                (client, options) => client.listPrompts(undefined, options),
              );
              entry.prompts = (listed.prompts || []).map((prompt) => ({
                name: prompt.name,
                description: prompt.description || "",
                arguments: prompt.arguments || [],
              }));
            }
            catch (error) { entry.probeErrors.prompts = error instanceof Error ? error.message : String(error); }
          }
          if (capabilities.resources) {
            try {
              const { result: listed } = await this.executeMcpRequest(
                pluginId,
                definition.id,
                undefined,
                (client, options) => client.listResources(undefined, options),
              );
              entry.resources = (listed.resources || []).map((resource) => ({
                uri: resource.uri,
                name: resource.name || "",
                description: resource.description || "",
                mimeType: resource.mimeType,
              }));
            }
            catch (error) { entry.probeErrors.resources = error instanceof Error ? error.message : String(error); }
          }
          probe[definition.id] = entry;
        }
        catch (error) {
          probe[definition.id] = {
            status: "error",
            tools: [],
            prompts: [],
            resources: [],
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    };
    const workerCount = Math.min(MCP_PROBE_CONCURRENCY, runnable.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    this.probes.set(pluginId, probe);
    return probe;
  }

  async callMcp(pluginId, serverId, toolName, args = {}, instanceToken) {
    await this.ready;
    if (!toolName) throw new Error("toolName is required for MCP tool calls.");
    const { result, instance } = await this.executeMcpRequest(
      pluginId,
      serverId,
      instanceToken,
      (client, options) => client.callTool({ name: toolName, arguments: args || {} }, undefined, options),
    );
    return { ok: true, pluginId, kind: "mcp", serverId, instanceId: instance?.instanceId, toolName, result };
  }

  async readMcpResource(pluginId, serverId, resourceUri, instanceToken) {
    await this.ready;
    if (!resourceUri) throw new Error("resourceUri is required for MCP resource reads.");
    const { result, instance } = await this.executeMcpRequest(
      pluginId,
      serverId,
      instanceToken,
      (client, options) => client.readResource({ uri: resourceUri }, options),
    );
    return { ok: true, pluginId, kind: "mcp-resource", serverId, instanceId: instance?.instanceId, resourceUri, result };
  }

  async getMcpPrompt(pluginId, serverId, promptName, args = {}, instanceToken) {
    await this.ready;
    if (!promptName) throw new Error("promptName is required for MCP prompt retrieval.");
    const { result, instance } = await this.executeMcpRequest(
      pluginId,
      serverId,
      instanceToken,
      (client, options) => client.getPrompt({ name: promptName, arguments: args || {} }, options),
    );
    return { ok: true, pluginId, kind: "mcp-prompt", serverId, instanceId: instance?.instanceId, promptName, result };
  }

  async callCommandTool(pluginId, toolName, args = {}) {
    await this.ready;
    const { plugin } = this.requirePlugin(pluginId, { enabled: true, trusted: true });
    const tool = plugin.tools.find((item) => item.name === toolName);
    if (!tool) throw new Error(`Unknown command tool ${toolName} in plugin ${pluginId}.`);
    assertRequiredEnv(tool);
    const templateEnv = { ...process.env, DEVSPACE_PLUGIN_ROOT: plugin.root };
    const cwd = await resolveExistingWithin(plugin.root, tool.cwd || ".");
    const commandArgs = tool.args.map((arg) => replaceEnvTemplates(arg, templateEnv));
    const requiredEnvironment = {};
    for (const name of tool.requiredEnv || []) {
      if (process.env[name] !== undefined) requiredEnvironment[name] = String(process.env[name]);
    }
    const processResult = await runProcess(replaceEnvTemplates(tool.command, templateEnv), commandArgs, {
      cwd,
      env: {
        ...capabilityProcessEnvironment(),
        DEVSPACE_PLUGIN_ROOT: plugin.root,
        ...requiredEnvironment,
        ...resolveEnvObject(tool.env, templateEnv),
      },
      timeoutMs: tool.timeoutMs,
      stdin: tool.input === "none" ? undefined : JSON.stringify(args || {}),
    });
    const parsed = parseJsonSafe(processResult.stdout.trim());
    return {
      ok: true,
      pluginId,
      kind: "tool",
      toolName,
      result: parsed ?? { text: processResult.stdout },
      stderr: processResult.stderr || undefined,
    };
  }

  async call(input) {
    if (["mcp", "mcp-resource", "mcp-prompt"].includes(input.kind) && !input.serverId) {
      throw new Error("serverId is required for MCP capability calls.");
    }
    if (input.kind === "mcp") {
      return await this.callMcp(input.pluginId, input.serverId, input.toolName, input.arguments, input.instanceToken);
    }
    if (input.kind === "mcp-resource") {
      return await this.readMcpResource(input.pluginId, input.serverId, input.resourceUri, input.instanceToken);
    }
    if (input.kind === "mcp-prompt") {
      return await this.getMcpPrompt(input.pluginId, input.serverId, input.promptName, input.arguments, input.instanceToken);
    }
    if (input.kind === "tool") {
      return await this.callCommandTool(input.pluginId, input.toolName, input.arguments);
    }
    throw new Error(`Unsupported capability kind: ${input.kind}`);
  }

  diagnostics() {
    return {
      enabled: this.enabled === true,
      discoveredPlugins: this.discovered.size,
      mcpClients: this.mcpClients.size,
      mcpConnecting: this.mcpConnecting.size,
      mcpStartupTails: this.mcpStartupTails.size,
      mcpInstances: this.mcpInstances.size,
    };
  }

  async close() {
    for (const id of [...this.discovered.keys()]) await this.closePluginClients(id);
  }
}

export function installedCapabilitySkillPaths(config) {
  if (config.pluginsEnabled === false) return [];
  const results = [];
  const seen = new Set();
  const addPluginSkills = (pluginDir) => {
    const root = resolve(pluginDir);
    if (!existsSync(root)) return;
    const queue = [{ dir: root, depth: 0 }];
    let count = 0;
    while (queue.length && count < MAX_PLUGIN_FILES) {
      const current = queue.shift();
      let entries;
      try { entries = requireReaddirSync(current.dir); } catch { continue; }
      for (const entry of entries) {
        count += 1;
        if (entry.isFile() && entry.name.toLowerCase() === "skill.md") {
          const base = current.dir;
          if (!seen.has(base)) {
            seen.add(base);
            results.push(base);
          }
        }
        else if (entry.isDirectory() && current.depth < MAX_PLUGIN_DEPTH && ![".git", "node_modules", ".venv", "venv", "__pycache__"].includes(entry.name)) {
          queue.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 });
        }
      }
    }
  };

  const registry = readJsonSyncIfExists(config.capabilityRegistryPath);
  if (registry?.version === REGISTRY_VERSION && registry.plugins) {
    for (const entry of Object.values(registry.plugins)) {
      if (entry?.sourceType === "external-path") continue;
      if (!entry?.enabled || !entry?.trusted || !entry?.dir) continue;
      addPluginSkills(entry.dir);
    }
  }
  for (const path of config.pluginPaths || []) addPluginSkills(resolve(expandHome(path)));
  return results;
}

function requireReaddirSync(dir) {
  // Kept isolated so the async runtime can stay promise-based while skill discovery remains synchronous.
  return readdirSyncCompat(dir, { withFileTypes: true });
}
import { readdirSync as readdirSyncCompat } from "node:fs";

export function registerCapabilityTools(server, runtime) {
  server.registerTool("capability_list", {
    title: "List Agent Capabilities",
    description: "List installed DevSpace capability plugins and their skills, instruction files, MCP servers, and command tools. This is the progressive-disclosure catalog shared by the main agent and every worker connected to the same DevSpace backend.",
    inputSchema: {
      includeDisabled: z.boolean().default(false),
      probeMcp: z.boolean().default(false),
    },
    annotations: READ_ONLY,
  }, async (input) => {
    try {
      const plugins = await runtime.list(input);
      return textResult({ ok: true, plugins });
    }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("capability_search", {
    title: "Search Agent Capabilities",
    description: "Search the shared capability catalog by plugin name/description, skill name, MCP server/tool, or declared command tool without loading every full schema into context. Inspect the selected plugin for complete details.",
    inputSchema: {
      query: z.string().min(1).max(500),
      includeDisabled: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(20),
    },
    annotations: READ_ONLY,
  }, async (input) => {
    try {
      const plugins = await runtime.search(input.query, input);
      return textResult({ ok: true, query: input.query, plugins });
    }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("capability_inspect", {
    title: "Inspect Agent Capability",
    description: "Inspect one installed capability package, including detected formats, reusable skills/instructions, MCP servers, command tools, trust state, and optional live MCP tool discovery.",
    inputSchema: {
      pluginId: z.string().min(1).max(180),
      probeMcp: z.boolean().default(false),
    },
    annotations: READ_ONLY,
  }, async (input) => {
    try {
      const plugin = await runtime.inspect(input.pluginId, { probeMcp: input.probeMcp });
      return textResult({ ok: true, plugin });
    }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("capability_install", {
    title: "Install Agent Capability",
    description: "Install a capability package from a Git repository URL (for example GitHub) or a local directory into the shared DevSpace plugin store. Installation never runs package install hooks. New code stays disabled unless explicitly enabled and trusted.",
    inputSchema: {
      source: z.string().min(1).max(4096),
      id: z.string().min(1).max(180).optional(),
      ref: z.string().min(1).max(200).optional(),
      enable: z.boolean().default(false),
      trust: z.boolean().default(false),
    },
    annotations: MUTATING,
  }, async (input) => {
    try { return textResult(await runtime.serializeMutation(() => runtime.install(input))); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("capability_enable", {
    title: "Enable Agent Capability",
    description: "Enable an installed capability for all agents on this DevSpace backend. Executable MCP/command capabilities require trust=true; this is an explicit code-trust boundary.",
    inputSchema: {
      pluginId: z.string().min(1).max(180),
      trust: z.boolean().optional(),
    },
    annotations: MUTATING,
  }, async (input) => {
    try { return textResult(await runtime.serializeMutation(() => runtime.setEnabled(input.pluginId, true, { trust: input.trust }))); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("capability_disable", {
    title: "Disable Agent Capability",
    description: "Disable an installed capability for all agents and stop its live MCP clients without deleting files.",
    inputSchema: { pluginId: z.string().min(1).max(180) },
    annotations: MUTATING,
  }, async (input) => {
    try { return textResult(await runtime.serializeMutation(() => runtime.setEnabled(input.pluginId, false))); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("capability_update", {
    title: "Update Agent Capability",
    description: "Fast-forward a managed Git-installed capability, or fetch/checkout a specific ref. External-path/local-copy packages are not modified automatically.",
    inputSchema: {
      pluginId: z.string().min(1).max(180),
      ref: z.string().min(1).max(200).optional(),
    },
    annotations: MUTATING,
  }, async (input) => {
    try { return textResult(await runtime.serializeMutation(() => runtime.update(input.pluginId, { ref: input.ref }))); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("capability_uninstall", {
    title: "Uninstall Agent Capability",
    description: "Remove a managed capability package from the DevSpace plugin store. External configured plugin paths cannot be removed by this tool.",
    inputSchema: { pluginId: z.string().min(1).max(180) },
    annotations: DESTRUCTIVE,
  }, async (input) => {
    try { return textResult(await runtime.serializeMutation(() => runtime.uninstall(input.pluginId))); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("capability_refresh", {
    title: "Refresh Agent Capability Registry",
    description: "Rescan capability folders and optionally connect to enabled trusted MCP servers to discover their current tools. Skills become available to later workspace opens without copying them into the project.",
    inputSchema: {
      pluginId: z.string().min(1).max(180).optional(),
      probeMcp: z.boolean().default(false),
    },
    annotations: MUTATING,
  }, async (input) => {
    try { return textResult(await runtime.serializeMutation(() => runtime.refresh(input))); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("capability_read", {
    title: "Read Agent Capability Resource",
    description: "Read a text resource inside an enabled trusted capability package, such as AGENTS.md, CLAUDE.md, SKILL.md references, docs, or templates. Paths cannot escape the capability root.",
    inputSchema: {
      pluginId: z.string().min(1).max(180),
      path: z.string().min(1).max(2048),
    },
    annotations: READ_ONLY,
  }, async (input) => {
    try {
      const result = await runtime.readResource(input.pluginId, input.path);
      return textResult(result, result.content);
    }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("capability_instance", {
    title: "Claim Stateful MCP Instance",
    description: "Manage isolated instances of one stateful stdio MCP server (for example two Blender projects). action=claim creates an exclusive leased instance with ephemeral environment overrides and returns a private instanceToken; action=list shows active instance identities without environment values; action=release closes that instance process. Shared/stateless MCPs do not need an instance and continue using the backend-wide deduplicated connection.",
    inputSchema: {
      action: z.enum(["claim", "list", "release"]),
      pluginId: z.string().min(1).max(180).optional(),
      serverId: z.string().min(1).max(220).optional(),
      instanceId: z.string().min(1).max(180).optional(),
      instanceToken: z.string().min(16).optional(),
      env: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
      leaseSeconds: z.number().int().min(60).max(7200).default(1800),
      ownerLabel: z.string().min(1).max(120).optional(),
    },
    annotations: MUTATING,
  }, async (input, extra) => {
    try {
      if (input.action === "list") {
        return textResult({ ok: true, instances: await runtime.listInstances({ pluginId: input.pluginId, serverId: input.serverId }) });
      }
      if (input.action === "release") {
        if (!input.instanceToken) throw new Error("instanceToken is required for action=release.");
        return textResult(await runtime.releaseInstance(input.instanceToken));
      }
      if (!input.pluginId || !input.serverId || !input.instanceId) throw new Error("pluginId, serverId, and instanceId are required for action=claim.");
      const ownerLabel = input.ownerLabel || (extra?.sessionId ? `mcp:${String(extra.sessionId).slice(0, 12)}` : "agent");
      return textResult(await runtime.claimInstance({
        pluginId: input.pluginId,
        serverId: input.serverId,
        instanceId: input.instanceId,
        ownerLabel,
        env: input.env,
        leaseSeconds: input.leaseSeconds,
      }));
    }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("capability_call", {
    title: "Call Agent Capability Tool",
    description: "Invoke a capability through the shared DevSpace backend. kind=mcp calls an MCP tool; mcp-resource reads an MCP resource URI; mcp-prompt retrieves a reusable MCP prompt; kind=tool invokes an explicitly declared command adapter with JSON on stdin. For stateful MCPs controlling a specific app/project, claim capability_instance first and pass its private instanceToken so each project gets an isolated MCP process/endpoint. Use capability_search/inspect first to discover names, URIs, and schemas.",
    inputSchema: {
      pluginId: z.string().min(1).max(180),
      kind: z.enum(["mcp", "mcp-resource", "mcp-prompt", "tool"]),
      serverId: z.string().min(1).max(220).optional(),
      toolName: z.string().min(1).max(220).optional(),
      resourceUri: z.string().min(1).max(16_384).optional(),
      promptName: z.string().min(1).max(220).optional(),
      instanceToken: z.string().min(16).optional(),
      arguments: z.record(z.string(), z.unknown()).default({}),
    },
    annotations: CALLING,
  }, async (input) => {
    try { return textResult(await runtime.call(input)); }
    catch (error) { return errorResult(error); }
  });
}
