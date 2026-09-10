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
import { atomicWriteJson } from "./atomic-file.js";
import { importCodexMcpCatalog } from "./codex-mcp-import.js";
import {
  ROUTING_CONTRACT_VERSION,
  capabilityRoutingFingerprint,
  normalizeRoutingPolicy,
  rankCapabilityRoutes,
} from "./capability-routing.js";
import { CapabilityConnectionManager } from "./capability-connection-manager.js";

const REGISTRY_VERSION = 1;
const MAX_PLUGIN_FILES = 5000;
const MAX_PLUGIN_DEPTH = 8;
const MAX_TEXT_RESOURCE_BYTES = 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_MCP_PROBE_SERVERS = 16;
const MCP_PROBE_CONCURRENCY = 4;
const MAX_MCP_RESOURCE_SERVERS = 32;
const MAX_MCP_RESOURCE_ITEMS = 200;
const INTERNAL_CAPABILITY_OWNER = "__devspace_internal_capability__";
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
function shouldInvalidateMcpClient(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /connection closed|transport|socket|econn(?:reset|refused)|broken pipe|websocket.*closed/i.test(message);
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
function publicMcpServerKey(pluginId, serverId) {
  return `${pluginId}/${serverId}`;
}
function boundedPublicText(value, max = 2000) {
  return String(value ?? "").slice(0, max);
}
function sanitizeListedResource(resource) {
  return {
    uri: boundedPublicText(resource?.uri, 4096),
    name: boundedPublicText(resource?.name, 500),
    description: resource?.description == null ? undefined : boundedPublicText(resource.description, 2000),
    mimeType: resource?.mimeType == null ? undefined : boundedPublicText(resource.mimeType, 240),
    size: Number.isFinite(Number(resource?.size)) ? Number(resource.size) : undefined,
  };
}
function sanitizeListedResourceTemplate(resource) {
  return {
    uriTemplate: boundedPublicText(resource?.uriTemplate, 4096),
    name: boundedPublicText(resource?.name, 500),
    description: resource?.description == null ? undefined : boundedPublicText(resource.description, 2000),
    mimeType: resource?.mimeType == null ? undefined : boundedPublicText(resource.mimeType, 240),
  };
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
async function readYamlIfExists(filePath) {
  try {
    const parsed = YAML.parse(await readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  }
  catch (error) {
    if (error?.code === "ENOENT") return undefined;
    return undefined;
  }
}
function normalizeDefaultPrompts(value) {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  return normalizeStringArray(value).map((item) => item.trim()).filter(Boolean).slice(0, 20);
}
function routingDependencies(value) {
  const tools = Array.isArray(value?.tools) ? value.tools : [];
  return tools.slice(0, 32).map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return "";
    return [item.type, item.value, item.description]
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .join(" ")
      .slice(0, 800);
  }).filter(Boolean);
}
async function skillRoutingMetadata(root, relativeFiles, file, frontmatter = {}) {
  const base = dirname(file);
  const baseRel = relativePortable(root, base);
  const candidatePaths = [
    join(base, "agents", "openai.yaml"),
    join(base, "agents", "openai.yml"),
    join(base, "agents", "openai.json"),
    join(base, "SKILL.json"),
  ];
  let metadata = {};
  for (const candidate of candidatePaths) {
    const relativePath = relativePortable(root, candidate);
    if (!relativeFiles.has(relativePath)) continue;
    const parsed = candidate.toLowerCase().endsWith(".json")
      ? await readJsonIfExists(candidate)
      : await readYamlIfExists(candidate);
    if (parsed && typeof parsed === "object") {
      metadata = { ...metadata, ...parsed };
      break;
    }
  }
  const interfaceMetadata = metadata.interface && typeof metadata.interface === "object"
    ? metadata.interface
    : {};
  const frontRouting = frontmatter.routing && typeof frontmatter.routing === "object"
    ? frontmatter.routing
    : {};
  const metadataRouting = metadata.routing && typeof metadata.routing === "object"
    ? metadata.routing
    : {};
  const frontPolicy = frontmatter.policy && typeof frontmatter.policy === "object"
    ? frontmatter.policy
    : {};
  const metadataPolicy = metadata.policy && typeof metadata.policy === "object"
    ? metadata.policy
    : {};
  const routing = normalizeRoutingPolicy({
    ...frontRouting,
    ...frontPolicy,
    ...metadataRouting,
    ...metadataPolicy,
    aliases: [
      ...normalizeStringArray(frontmatter.aliases),
      ...normalizeStringArray(frontmatter.routingAliases),
      ...normalizeStringArray(frontmatter.routing_aliases),
      ...normalizeStringArray(frontRouting.aliases),
      ...normalizeStringArray(metadataRouting.aliases),
    ],
    negativeTriggers: [
      ...normalizeStringArray(frontmatter.negativeTriggers),
      ...normalizeStringArray(frontmatter.negative_triggers),
      ...normalizeStringArray(frontRouting.negativeTriggers),
      ...normalizeStringArray(frontRouting.exclude),
      ...normalizeStringArray(metadataRouting.negativeTriggers),
      ...normalizeStringArray(metadataRouting.exclude),
    ],
  });
  return {
    displayName: String(interfaceMetadata.display_name || interfaceMetadata.displayName || frontmatter.display_name || frontmatter.displayName || "").slice(0, 240),
    shortDescription: String(interfaceMetadata.short_description || interfaceMetadata.shortDescription || frontmatter.short_description || frontmatter.shortDescription || "").slice(0, 800),
    defaultPrompts: normalizeDefaultPrompts(
      interfaceMetadata.default_prompt
      ?? interfaceMetadata.defaultPrompt
      ?? interfaceMetadata.default_prompts
      ?? interfaceMetadata.defaultPrompts
      ?? frontmatter.default_prompt
      ?? frontmatter.defaultPrompt,
    ),
    dependencies: routingDependencies(metadata.dependencies || frontmatter.dependencies),
    routing,
    routingMetadataPath: Object.keys(metadata).length
      ? relativePortable(root, candidatePaths.find((candidate) => relativeFiles.has(relativePortable(root, candidate))) || join(base, "agents", "openai.yaml"))
      : null,
    baseDir: baseRel,
  };
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
    stateful: raw.stateful === true,
    statelessShareable: raw.statelessShareable === true || raw.stateless_shareable === true,
    connectionMode: String(raw.connectionMode || raw.connection_mode || "conversation-isolated").trim().toLowerCase(),
    instancePolicy: String(raw.instancePolicy || raw.instance_policy || "automatic-conversation").trim().toLowerCase(),
    multiInstance: raw.multiInstance === true || raw.multi_instance === true,
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
  const keywords = normalizeStringArray(rootMetadata.keywords).slice(0, 100);
  const computerUseAliases = id === "computer-use"
    ? [
        "windows desktop application app automation",
        "open launch control click type scroll drag screenshot accessibility",
        "notepad calculator paint file explorer visual studio vscode",
        "word excel powerpoint outlook teams discord whatsapp",
        "blender unreal engine native windows ui",
      ]
    : [];
  const declaredRouting = rootMetadata.routing && typeof rootMetadata.routing === "object"
    ? rootMetadata.routing
    : {};
  const declaredPolicy = rootMetadata.policy && typeof rootMetadata.policy === "object"
    ? rootMetadata.policy
    : {};
  const routing = normalizeRoutingPolicy({
    ...declaredRouting,
    ...declaredPolicy,
    aliases: [
      ...keywords,
      ...normalizeStringArray(rootMetadata.routingAliases),
      ...normalizeStringArray(rootMetadata.routing_aliases),
      ...normalizeStringArray(declaredRouting.aliases),
      ...computerUseAliases,
    ],
    negativeTriggers: [
      ...normalizeStringArray(rootMetadata.negativeTriggers),
      ...normalizeStringArray(rootMetadata.negative_triggers),
      ...normalizeStringArray(declaredRouting.negativeTriggers),
      ...normalizeStringArray(declaredRouting.exclude),
    ],
  });
  const routingAliases = routing.aliases;

  const skills = [];
  for (const [rel, file] of relativeFiles) {
    if (basename(file).toLowerCase() !== "skill.md") continue;
    let text = "";
    try { text = await readFile(file, "utf8"); } catch {}
    const fm = frontmatterFromSkill(text);
    const routeMetadata = await skillRoutingMetadata(root, relativeFiles, file, fm);
    skills.push({
      name: String(fm.name || basename(dirname(file))).slice(0, 160),
      displayName: routeMetadata.displayName,
      description: String(fm.description || "Reusable agent skill").slice(0, 1200),
      shortDescription: routeMetadata.shortDescription,
      defaultPrompts: routeMetadata.defaultPrompts,
      dependencies: routeMetadata.dependencies,
      routing: routeMetadata.routing,
      routingMetadataPath: routeMetadata.routingMetadataPath,
      filePath: rel,
      baseDir: routeMetadata.baseDir,
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
  const codexExecutionRequirements = [];
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
    if (entry.manifest?.requires_local_executor !== undefined) {
      codexExecutionRequirements.push({
        pluginRoot: entry.pluginRootPath,
        requiresLocalExecutor: entry.manifest.requires_local_executor === true,
        declaredValueValid: typeof entry.manifest.requires_local_executor === "boolean",
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
    keywords,
    routingAliases,
    routing,
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
      codexExecutionRequirements.length ? "codex-execution-requirements-metadata" : undefined,
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
    codexExecutionRequirements,
    mcpServers: [...mcpMap.values()],
    tools,
    fileCount: files.length,
    fingerprint: sha256(JSON.stringify({
      id,
      name,
      description,
      version,
      keywords,
      routingAliases,
      routing,
      skills: skills.map((skill) => ({
        name: skill.name,
        displayName: skill.displayName,
        description: skill.description,
        shortDescription: skill.shortDescription,
        defaultPrompts: skill.defaultPrompts,
        dependencies: skill.dependencies,
        routing: skill.routing,
        filePath: skill.filePath,
        routingMetadataPath: skill.routingMetadataPath,
      })),
      instructions: instructions.map((item) => item.path),
      claudeCommands: claudeCommands.map((item) => item.path),
      claudeAgents: claudeAgents.map((item) => item.path),
      pluginHooks: pluginHooks.map((item) => `${item.host}:${item.path}`),
      codexApps: codexApps.map((item) => `${item.name}:${item.id}:${item.path}`),
      codexInterfaces: codexInterfaces.map((item) => `${item.pluginRoot}:${item.displayName}:${item.category}`),
      bundledContentVariants: bundledContentVariants.map((item) => `${item.pluginRoot}:${item.value}`),
      codexExecutionRequirements: codexExecutionRequirements.map((item) => `${item.pluginRoot}:${item.requiresLocalExecutor}:${item.declaredValueValid}`),
      mcp: [...mcpMap.values()].map((item) => ({
        id: item.id,
        type: item.type,
        description: item.description,
        sourcePath: item.sourcePath,
        connectionMode: item.connectionMode,
        stateful: item.stateful === true,
        statelessShareable: item.statelessShareable === true,
        instancePolicy: item.instancePolicy,
        multiInstance: item.multiInstance === true,
      })),
      tools: tools.map((item) => ({ name: item.name, description: item.description, inputSchema: item.inputSchema })),
    })),
  };
}

function safePluginSummary(discovered, registryEntry, probe) {
  return {
    id: discovered.id,
    name: discovered.name,
    description: discovered.description,
    version: discovered.version,
    keywords: discovered.keywords || [],
    routingAliases: discovered.routingAliases || [],
    routing: discovered.routing || normalizeRoutingPolicy(),
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
    codexExecutionRequirements: discovered.codexExecutionRequirements || [],
    mcpServers: discovered.mcpServers.map((server) => ({
      id: server.id,
      type: server.type,
      description: server.description,
      sourcePath: server.sourcePath,
      connectionMode: server.connectionMode,
      stateful: server.stateful === true,
      statelessShareable: server.statelessShareable === true,
      instancePolicy: server.instancePolicy,
      multiInstance: server.multiInstance === true,
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
    keywords: discovered.keywords || [],
    routingAliases: discovered.routingAliases || [],
    routing: discovered.routing || normalizeRoutingPolicy(),
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
      codexExecutionRequirements: discovered.codexExecutionRequirements?.length || 0,
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

function pluginRoutingInterface(plugin) {
  const interfaces = Array.isArray(plugin?.codexInterfaces) ? plugin.codexInterfaces : [];
  const preferred = interfaces.find((item) => item?.pluginRoot === "") || interfaces[0] || {};
  return {
    displayName: String(preferred.displayName || plugin?.name || plugin?.id || "").slice(0, 240),
    shortDescription: String(preferred.shortDescription || "").slice(0, 800),
    defaultPrompts: normalizeDefaultPrompts(preferred.defaultPrompt),
    capabilities: normalizeStringArray(preferred.capabilities).slice(0, 50),
  };
}

function routeAvailability(entry, { trusted = false } = {}) {
  if (!entry?.enabled) return { available: false, availabilityReason: "plugin-disabled" };
  if (trusted && !entry?.trusted) return { available: false, availabilityReason: "plugin-not-trusted" };
  return { available: true, availabilityReason: null };
}

function mcpServerRequiresIsolatedRuntime(plugin, server) {
  return (plugin?.id === "blender-local" && server?.id === "blender")
    || server?.stateful === true
    || server?.connectionMode === "isolated"
    || server?.connectionMode === "runtime-isolated"
    || server?.instancePolicy === "required"
    || server?.runtime?.isolated === true
    || server?.multiInstance === true;
}

function mcpToolNextAction(plugin, server, tool) {
  if (plugin?.id === "blender-local" && server?.id === "blender") {
    return {
      tool: "blender_mcp",
      arguments: { action: "call", toolName: tool.name, arguments: {} },
      runtimeRoute: {
        kind: "runtime",
        managerTool: "blender_runtime",
        owner: "current-conversation",
        strategy: "reuse-owned-runtime-or-start-isolated",
        discovery: { tool: "blender_runtime", arguments: { action: "list" } },
        start: { tool: "blender_runtime", arguments: { action: "start", runtimeId: "<conversation-project-runtime>" } },
        bindArgument: "runtimeId",
      },
      then: "Execute the selected Blender MCP tool against the owned runtimeId and verify through Blender readback.",
    };
  }
  const nextAction = {
    tool: "capability_call",
    arguments: { pluginId: plugin.id, kind: "mcp", serverId: server.id, toolName: tool.name, arguments: {} },
  };
  if (mcpServerRequiresIsolatedRuntime(plugin, server)) {
    nextAction.runtimeRoute = {
      kind: "runtime",
      managerTool: "capability_connection",
      owner: "current-conversation",
      strategy: "claim-conversation-owned-isolated-runtime",
      discovery: {
        tool: "capability_connection",
        arguments: { action: "list", pluginId: plugin.id, serverId: server.id },
      },
      start: {
        tool: "capability_connection",
        arguments: {
          action: "claim",
          pluginId: plugin.id,
          serverId: server.id,
          runtimeId: "<conversation-project-runtime>",
          env: {},
        },
      },
      bindArgument: "instanceToken",
    };
    nextAction.then = "Pass the returned private instanceToken to capability_call and verify the result through the same owned runtime.";
  }
  return nextAction;
}

function builtinCapabilityRouteCandidates() {
  return [
    {
      routeId: "workflow:agent-progress-report",
      kind: "workflow",
      name: "agent-progress-report",
      title: "Agent-authored progress narration",
      description: "Write a useful conversation-bound progress update only after a meaningful medium-sized step, important verification result, material direction change, or genuine blocker. There is no fixed time or tool-count cadence, and program telemetry must not become visible prose.",
      aliases: [
        "progress narration",
        "progress card",
        "keep me updated",
        "report current progress",
        "旁白卡",
        "進度旁白",
        "匯報工作內容",
      ],
      negativeTriggers: [
        "report every tool call",
        "periodic heartbeat",
        "定期匯報",
        "每個工具匯報",
      ],
      routing: {
        exposure: "direct",
        priority: 70,
        allowImplicitInvocation: true,
      },
      requires: ["agent-authored-natural-language", "current-conversation-authority"],
      nextAction: {
        tool: "devspace_progress_report",
        arguments: { message: "<agent-authored useful progress update>", kind: "milestone" },
        then: "Use only when the Agent judges that the update is useful; do not invoke on a fixed cadence.",
      },
    },
    {
      routeId: "runtime:blender-isolated",
      kind: "runtime",
      name: "blender-runtime",
      title: "Conversation-owned Blender runtime",
      description: "Start or attach an isolated Blender application runtime for one conversation and project. Use this before Blender MCP when multiple agents, projects, Blender processes, or loopback ports must run concurrently without crossing files or connection state.",
      aliases: [
        "multiple blender runtime",
        "two blender instances",
        "two agents blender",
        "separate blender port",
        "parallel blender",
        "雙 blender",
        "兩個 agent blender",
        "不同 port",
        "獨立 blender runtime",
      ],
      negativeTriggers: ["conceptual blender advice without live execution"],
      routing: {
        exposure: "direct",
        priority: 105,
        allowImplicitInvocation: true,
      },
      pluginId: "blender-local",
      serverId: "blender",
      requires: ["one-runtime-per-concurrent-project", "conversation-owner", "loopback-port"],
      nextAction: {
        tool: "blender_runtime",
        arguments: { action: "list" },
        then: "Preserve work already in progress: reuse the matching conversation-owned runtime, otherwise adopt the one unclaimed existing Blender runtime without restarting it. Start a new runtime only for a future project, then call blender_mcp through that conversation-isolated runtime.",
      },
    },
    {
      routeId: "workflow:capability-connection",
      kind: "workflow",
      name: "capability-connection",
      title: "Capability MCP connection management",
      description: "Inspect or create the conversation-isolated connection binding for a capability MCP. Every conversation receives a separate client/session by default; stateful application services additionally bind by plugin/server/instance/runtime/current conversation. Backend-wide pooling is disabled unless the operator and a manifest both explicitly declare a service stateless and shareable.",
      aliases: [
        "mcp connection manager",
        "plugin connection",
        "separate mcp port",
        "stateful mcp instance",
        "多 agent mcp",
        "插件連線管理",
        "mcp 連線管理",
      ],
      routing: {
        exposure: "direct",
        priority: 74,
        allowImplicitInvocation: true,
      },
      requires: ["current-conversation-owner", "default-conversation-isolation", "runtime-owner-for-stateful-apps"],
      nextAction: {
        tool: "capability_connection",
        arguments: { action: "list" },
        then: "Reuse only this conversation's connection. For a stateful app endpoint, adopt or claim the conversation-owned runtime before the first mutation.",
      },
    },
  ];
}

function capabilityRouteCandidates(plugin, entry, probe = {}, { includeProbedTools = true } = {}) {
  const candidates = [];
  const pluginPolicy = plugin.routing || normalizeRoutingPolicy({ aliases: plugin.routingAliases || [] });
  const childToolPolicy = { ...pluginPolicy, aliases: [] };
  const pluginInterface = pluginRoutingInterface(plugin);
  const pluginAvailability = routeAvailability(entry);
  const executableAvailability = routeAvailability(entry, { trusted: true });
  candidates.push({
    routeId: `plugin:${plugin.id}`,
    kind: "plugin",
    name: plugin.id,
    title: pluginInterface.displayName || plugin.name,
    description: plugin.description,
    shortDescription: pluginInterface.shortDescription,
    aliases: [...(plugin.routingAliases || []), ...(plugin.keywords || [])],
    defaultPrompts: pluginInterface.defaultPrompts,
    dependencies: pluginInterface.capabilities,
    routing: pluginPolicy,
    pluginId: plugin.id,
    ...pluginAvailability,
    requires: ["inspect-selected-plugin", "load-only-selected-skill-or-tool-schema"],
    nextAction: {
      tool: "capability_inspect",
      arguments: { pluginId: plugin.id, probeMcp: false },
    },
  });

  for (const skill of plugin.skills || []) {
    const skillPolicy = normalizeRoutingPolicy(skill.routing, pluginPolicy);
    candidates.push({
      routeId: `skill:${plugin.id}:${skill.name}`,
      kind: "skill",
      name: skill.name,
      title: skill.displayName || skill.name,
      description: skill.description,
      shortDescription: skill.shortDescription,
      aliases: skillPolicy.aliases,
      negativeTriggers: skillPolicy.negativeTriggers,
      defaultPrompts: skill.defaultPrompts,
      dependencies: skill.dependencies,
      allowImplicitInvocation: skillPolicy.allowImplicitInvocation,
      exposure: skillPolicy.exposure,
      priority: skillPolicy.priority,
      pluginId: plugin.id,
      path: skill.filePath,
      ...executableAvailability,
      requires: ["read-full-skill-before-substantive-work", ...(skill.dependencies?.length ? ["resolve-declared-tool-dependencies"] : [])],
      nextAction: {
        tool: "capability_read",
        arguments: { pluginId: plugin.id, path: skill.filePath },
        then: "Follow the selected SKILL.md and resolve only its declared tool dependencies.",
      },
    });
  }

  for (const tool of plugin.tools || []) {
    candidates.push({
      routeId: `command-tool:${plugin.id}:${tool.name}`,
      kind: "command-tool",
      name: tool.name,
      title: tool.name,
      description: tool.description,
      aliases: [],
      negativeTriggers: childToolPolicy.negativeTriggers,
      pluginId: plugin.id,
      toolName: tool.name,
      routing: childToolPolicy,
      ...executableAvailability,
      requires: tool.requiredEnv?.length ? tool.requiredEnv.map((name) => `environment:${name}`) : [],
      nextAction: {
        tool: "capability_call",
        arguments: { pluginId: plugin.id, kind: "tool", toolName: tool.name, arguments: {} },
      },
    });
  }

  for (const server of plugin.mcpServers || []) {
    const serverProbe = probe?.[server.id] || null;
    const unsupported = Boolean(server.unsupportedReason || serverProbe?.status === "unsupported");
    const serverAvailability = unsupported
      ? { available: false, availabilityReason: server.unsupportedReason || serverProbe?.error || "mcp-server-unsupported" }
      : executableAvailability;
    candidates.push({
      routeId: `mcp-server:${plugin.id}:${server.id}`,
      kind: "mcp-server",
      name: server.id,
      title: server.id,
      description: server.description,
      aliases: [],
      negativeTriggers: childToolPolicy.negativeTriggers,
      pluginId: plugin.id,
      serverId: server.id,
      routing: childToolPolicy,
      ...serverAvailability,
      requires: [serverProbe?.status === "online" ? "mcp-schema-ready" : "probe-selected-mcp-server"],
      nextAction: plugin.id === "blender-local" && server.id === "blender"
        ? {
            tool: "blender_mcp",
            arguments: { action: "list", arguments: {} },
            then: "Immediately call blender_mcp(action=call) with one returned tool and schema-valid arguments; this is the live Blender execution entry point.",
          }
        : {
            tool: "capability_inspect",
            arguments: { pluginId: plugin.id, probeMcp: true },
            then: `Select one discovered tool, prompt, or resource from MCP server ${server.id}.`,
          },
    });
    for (const tool of includeProbedTools ? serverProbe?.tools || [] : []) {
      candidates.push({
        routeId: `mcp-tool:${plugin.id}:${server.id}:${tool.name}`,
        kind: "mcp-tool",
        name: tool.name,
        title: tool.title || tool.name,
        description: tool.description || server.description,
        aliases: [],
        negativeTriggers: childToolPolicy.negativeTriggers,
        pluginId: plugin.id,
        serverId: server.id,
        toolName: tool.name,
        routing: childToolPolicy,
        ...serverAvailability,
        requires: ["use-returned-mcp-input-schema", ...(server.requiredEnv?.length ? server.requiredEnv.map((name) => `environment:${name}`) : [])],
        nextAction: mcpToolNextAction(plugin, server, tool),
      });
    }
    for (const prompt of includeProbedTools ? serverProbe?.prompts || [] : []) {
      candidates.push({
        routeId: `mcp-prompt:${plugin.id}:${server.id}:${prompt.name}`,
        kind: "mcp-prompt",
        name: prompt.name,
        title: prompt.title || prompt.name,
        description: prompt.description || server.description,
        aliases: [],
        negativeTriggers: childToolPolicy.negativeTriggers,
        pluginId: plugin.id,
        serverId: server.id,
        promptName: prompt.name,
        routing: childToolPolicy,
        ...serverAvailability,
        requires: ["retrieve-prompt-before-following-it"],
        nextAction: {
          tool: "capability_call",
          arguments: { pluginId: plugin.id, kind: "mcp-prompt", serverId: server.id, promptName: prompt.name, arguments: {} },
        },
      });
    }
    for (const resource of includeProbedTools ? serverProbe?.resources || [] : []) {
      candidates.push({
        routeId: `mcp-resource:${plugin.id}:${server.id}:${resource.uri}`,
        kind: "mcp-resource",
        name: resource.name || resource.uri,
        title: resource.name || resource.uri,
        description: resource.description || server.description,
        aliases: [],
        negativeTriggers: childToolPolicy.negativeTriggers,
        pluginId: plugin.id,
        serverId: server.id,
        resourceUri: resource.uri,
        routing: { ...childToolPolicy, priority: Number(pluginPolicy.priority || 0) - 10 },
        ...serverAvailability,
        requires: ["read-resource-only-when-selected"],
        nextAction: {
          tool: "capability_call",
          arguments: { pluginId: plugin.id, kind: "mcp-resource", serverId: server.id, resourceUri: resource.uri, arguments: {} },
        },
      });
    }
  }

  for (const app of plugin.codexApps || []) {
    candidates.push({
      routeId: `host-app:${plugin.id}:${app.name}`,
      kind: "host-app",
      name: app.name,
      title: app.name,
      description: `Host-managed connector dependency ${app.id || app.name}.`,
      aliases: [],
      pluginId: plugin.id,
      routing: { ...childToolPolicy, priority: Number(pluginPolicy.priority || 0) - 20 },
      available: false,
      availabilityReason: "host-managed-connector-required",
      requires: ["matching-host-connector"],
      nextAction: {
        tool: "capability_inspect",
        arguments: { pluginId: plugin.id, probeMcp: false },
        then: "Use the corresponding host connector only when it is actually available.",
      },
    });
  }
  return candidates;
}

async function runProcess(command, args, options = {}) {
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
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    const push = (current, chunk, markTruncated) => {
      const next = Buffer.concat([current, Buffer.from(chunk)]);
      if (next.length <= MAX_PROCESS_OUTPUT_BYTES) return next;
      markTruncated();
      return next.subarray(next.length - MAX_PROCESS_OUTPUT_BYTES);
    };
    child.stdout.on("data", (chunk) => { stdout = push(stdout, chunk, () => { stdoutTruncated = true; }); });
    child.stderr.on("data", (chunk) => { stderr = push(stderr, chunk, () => { stderrTruncated = true; }); });
    child.once("error", fail);
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      const result = {
        code,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        stdoutTruncated,
        stderrTruncated,
      };
      if (code !== 0) {
        rejectPromise(new Error(`Process exited ${code ?? signal}: ${result.stderr || result.stdout}`.trim()));
      }
      else resolvePromise(result);
    });
    if (options.stdin !== undefined) child.stdin.end(String(options.stdin));
    else child.stdin.end();
  });
}

async function git(args, options = {}) {
  const command = process.platform === "win32" ? "git.exe" : "git";
  return await runProcess(command, args, options);
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
    // MCP client/session objects are never shared across ChatGPT conversations.
    // A provider may reuse its own stateless backend process internally, but
    // DevSpace always creates a conversation-scoped transport boundary.
    this.state = { version: REGISTRY_VERSION, plugins: {} };
    this.discovered = new Map();
    this.probes = new Map();
    this.connectionManager = options.connectionManager || new CapabilityConnectionManager();
    // Compatibility aliases retained for existing diagnostics and tests. The
    // connection manager is the sole lifecycle authority for these maps.
    this.mcpClients = this.connectionManager.clients;
    this.mcpConnecting = this.connectionManager.connecting;
    this.mcpStartupTails = this.connectionManager.startupTails;
    this.mcpInstances = this.connectionManager.instances;
    this.mutationTail = Promise.resolve();
    this.routingListeners = new Set();
    this.routingRevision = 0;
    this.lastStaticRoutingFingerprint = capabilityRoutingFingerprint([]);
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

  onRoutingChanged(handler) {
    if (typeof handler !== "function") return () => {};
    this.routingListeners.add(handler);
    return () => this.routingListeners.delete(handler);
  }

  notifyRoutingChanged(reason = "catalog-refresh") {
    const fingerprint = this.routingFingerprint({ includeDisabled: true });
    if (fingerprint === this.lastStaticRoutingFingerprint) return false;
    this.lastStaticRoutingFingerprint = fingerprint;
    this.routingRevision += 1;
    const event = {
      version: ROUTING_CONTRACT_VERSION,
      revision: this.routingRevision,
      fingerprint,
      reason: String(reason || "catalog-refresh").slice(0, 120),
      observedAt: nowIso(),
    };
    for (const handler of [...this.routingListeners]) {
      queueMicrotask(() => {
        try { void Promise.resolve(handler(event)).catch(() => {}); } catch {}
      });
    }
    return true;
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
    await atomicWriteJson(this.registryPath, publicState);
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
    this.notifyRoutingChanged(pluginId ? `plugin-refresh:${pluginId}` : "catalog-refresh");
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

  routingCandidates({ includeDisabled = false, includeProbedTools = true } = {}) {
    const candidates = builtinCapabilityRouteCandidates();
    for (const [id, plugin] of this.discovered) {
      const entry = this.registryEntry(id);
      if (!entry) continue;
      if (!includeDisabled && !entry.enabled) continue;
      candidates.push(...capabilityRouteCandidates(plugin, entry, this.probes.get(id), { includeProbedTools }));
      if (candidates.length >= 1_000) break;
    }
    return candidates.slice(0, 1_000);
  }

  routingFingerprint({ includeDisabled = true } = {}) {
    // Session compatibility must be stable across restarts and independent of
    // whether a deferred MCP server happened to be probed in this process.
    return capabilityRoutingFingerprint(this.routingCandidates({ includeDisabled, includeProbedTools: false }));
  }

  async route(query, { includeDisabled = false, limit = 8, probeMcp = false } = {}) {
    await this.ready;
    if (probeMcp) {
      const preliminary = rankCapabilityRoutes(query, this.routingCandidates({ includeDisabled: false }), { limit: 12 });
      const likelyPluginIds = [...new Set(preliminary.candidates.map((candidate) => candidate.pluginId).filter(Boolean))].slice(0, 5);
      for (const pluginId of likelyPluginIds) {
        const entry = this.registryEntry(pluginId);
        if (!entry?.enabled || !entry?.trusted) continue;
        await this.probePluginMcp(pluginId).catch(() => {});
      }
    }
    const candidates = this.routingCandidates({ includeDisabled });
    return {
      ok: true,
      contract: "devspace-capability-routing",
      routingFingerprint: capabilityRoutingFingerprint(candidates),
      ...rankCapabilityRoutes(query, candidates, { limit }),
    };
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
        keywords: (plugin.keywords || []).join(" ").toLowerCase(),
        routing: (plugin.routingAliases || []).join(" ").toLowerCase(),
        skills: plugin.skills.map((item) => `${item.name} ${item.description}`).join(" ").toLowerCase(),
        mcp: plugin.mcpServers.map((item) => `${item.id} ${item.description}`).join(" ").toLowerCase(),
        tools: plugin.tools.map((item) => `${item.name} ${item.description}`).join(" ").toLowerCase(),
        apps: (plugin.codexApps || []).map((item) => `${item.name} ${item.id}`).join(" ").toLowerCase(),
        interface: (plugin.codexInterfaces || []).map((item) => `${item.displayName} ${item.shortDescription} ${item.longDescription} ${item.developerName} ${item.category} ${(item.capabilities || []).join(" ")} ${(item.defaultPrompt || []).join(" ")}`).join(" ").toLowerCase(),
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
        if (fields.routing.includes(term)) termScore = Math.max(termScore, 9);
        if (fields.tools.includes(term) || fields.probed.includes(term)) termScore = Math.max(termScore, 8);
        if (fields.skills.includes(term) || fields.mcp.includes(term) || fields.apps.includes(term) || fields.keywords.includes(term)) termScore = Math.max(termScore, 6);
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
        await git(args, { cwd: this.pluginsDir });
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
    this.notifyRoutingChanged(`${entry.enabled ? "plugin-enabled" : "plugin-disabled"}:${id}`);
    return { ok: true, plugin: await this.inspect(id) };
  }

  async update(id, { ref } = {}) {
    await this.ready;
    const { entry } = this.requirePlugin(id);
    if (!entry.managed) throw new Error(`External-path capability ${id} cannot be updated by DevSpace.`);
    if (entry.sourceType !== "git") throw new Error(`Capability ${id} was not installed from Git; reinstall it to update.`);
    await this.closePluginClients(id);
    if (ref) {
      await git(["fetch", "--depth", "1", "origin", String(ref)], { cwd: entry.dir });
      await git(["checkout", "--detach", "FETCH_HEAD"], { cwd: entry.dir });
      entry.ref = String(ref);
    }
    else {
      await git(["pull", "--ff-only"], { cwd: entry.dir });
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
    this.notifyRoutingChanged(`plugin-uninstalled:${id}`);
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
    return this.connectionManager.instanceKey(pluginId, serverId, instanceId);
  }

  publicInstance(instance) {
    return this.connectionManager.publicInstance(instance);
  }

  async cleanupExpiredInstances() {
    return 0;
  }

  findInstanceByToken(instanceToken) {
    return this.connectionManager.findInstanceByToken(instanceToken);
  }

  findInstanceByRuntime(runtimeId, options = {}) {
    return this.connectionManager.findInstanceByRuntime(runtimeId, options);
  }

  async claimInstance({
    pluginId,
    serverId,
    instanceId,
    runtimeId = null,
    ownerLabel = "agent",
    ownerConversationId = null,
    env = {},
  }) {
    await this.ready;
    const owner = String(ownerConversationId || "").trim();
    if (!owner) {
      throw new Error("ownerConversationId is required for a stateful capability runtime.");
    }
    const { plugin } = this.requirePlugin(pluginId, { enabled: true, trusted: true });
    const definition = plugin.mcpServers.find((server) => server.id === serverId);
    if (!definition) throw new Error(`Unknown MCP server ${serverId} in plugin ${pluginId}.`);
    if (["metadata-only", "package-metadata"].includes(definition.type)) {
      throw new Error(definition.unsupportedReason || `MCP server ${serverId} cannot be connected.`);
    }
    const result = this.connectionManager.claimInstance({
      pluginId,
      serverId,
      instanceId,
      runtimeId,
      ownerLabel,
      ownerConversationId: owner,
      envOverrides: this.sanitizeInstanceEnv(env),
    });
    return {
      ...result,
      instruction: "Keep instanceToken private. Pass it to capability_call, or use runtimeId with a runtime-aware entry point such as blender_mcp. The connection remains active until explicit release or Local Gateway shutdown.",
    };
  }

  async touchInstance(instanceToken, pluginId, serverId, ownerConversationId = null) {
    await this.ready;
    return this.connectionManager.resolveInstance(instanceToken, { pluginId, serverId, ownerConversationId });
  }

  async listInstances({ pluginId, serverId, ownerConversationId } = {}) {
    await this.ready;
    return this.connectionManager.listInstances({ pluginId, serverId, ownerConversationId });
  }

  async releaseInstance(instanceToken, ownerConversationId = null) {
    await this.ready;
    this.connectionManager.resolveInstance(instanceToken, { ownerConversationId });
    return await this.connectionManager.releaseInstance(instanceToken, {
      closeHolder: (holder) => this.closeMcpHolder(holder),
    });
  }

  clientKey(pluginId, serverId, instanceId, options = {}) {
    return this.connectionManager.connectionKey(pluginId, serverId, instanceId, options);
  }

  async closeMcpHolder(holder) {
    if (!holder) return;
    try { await holder.client?.close?.(); } catch {}
    try { await holder.transport?.close?.(); } catch {}
  }

  async closeClientKey(key) {
    const state = this.connectionManager.connectionStates.get(key);
    if (!state) {
      const pending = this.mcpConnecting.get(key);
      if (pending) {
        try { await this.closeMcpHolder(await pending); } catch {}
      }
      const holder = this.mcpClients.get(key);
      this.mcpClients.delete(key);
      await this.closeMcpHolder(holder);
      return;
    }
    await this.connectionManager.invalidate({
      pluginId: state.pluginId,
      serverId: state.serverId,
      instanceId: state.instanceId,
      ownerConversationId: state.ownerConversationId,
      closeHolder: (holder) => this.closeMcpHolder(holder),
      reason: "runtime-invalidation",
    });
  }

  async closePluginClients(pluginId) {
    await this.connectionManager.closePlugin(pluginId, {
      closeHolder: (holder) => this.closeMcpHolder(holder),
    });
  }

  async createMcpClient(pluginId, definition, instance) {
    const { plugin } = this.requirePlugin(pluginId, { enabled: true, trusted: true });
    if (["metadata-only", "package-metadata"].includes(definition.type)) {
      throw new Error(definition.unsupportedReason || `MCP server ${definition.id} cannot be launched.`);
    }
    const runtimeEnvironment = { ...process.env, ...(instance?.envOverrides || {}) };
    assertRequiredEnv(definition, runtimeEnvironment);
    const client = new Client({ name: `devspace-ultra-capability-${slugify(pluginId)}`, version: "0.3.1" });
    let transport;
    if (definition.type === "stdio") {
      const componentRoot = definition.baseDir && isPathInside(definition.baseDir, plugin.root)
        ? definition.baseDir
        : plugin.root;
      const templateEnv = {
        ...runtimeEnvironment,
        CLAUDE_PLUGIN_ROOT: componentRoot,
        DEVSPACE_PLUGIN_ROOT: plugin.root,
      };
      const declaredEnvironment = {};
      for (const name of normalizeStringArray(definition.requiredEnv)) {
        if (runtimeEnvironment[name] !== undefined) declaredEnvironment[name] = String(runtimeEnvironment[name]);
      }
      for (const item of Array.isArray(definition.environmentVariables) ? definition.environmentVariables : []) {
        if (!item?.name) continue;
        const value = runtimeEnvironment[item.name] ?? item.default;
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
      const remote = resolveRemoteConnection(pluginId, definition, runtimeEnvironment);
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
      const remote = resolveRemoteConnection(pluginId, definition, runtimeEnvironment);
      transport = new StreamableHTTPClientTransport(new URL(remote.url), {
        requestInit: { headers: remote.headers },
      });
    }
    let stderrTail = "";
    if (transport instanceof StdioClientTransport && transport.stderr) {
      transport.stderr.on("data", (chunk) => { stderrTail = (stderrTail + String(chunk)).slice(-8192); });
    }
    try {
      await client.connect(transport);
    }
    catch (error) {
      try { await transport.close(); } catch {}
      const base = error instanceof Error ? error.message : String(error);
      throw new Error(stderrTail.trim() ? `${base}\nMCP stderr:\n${stderrTail.trim()}` : base);
    }
    return { client, transport, definition };
  }

  async serializeMcpStartup(pluginId, serverId, operation) {
    return await this.connectionManager.serializeStartup(pluginId, serverId, operation);
  }

  mcpConnectionPolicy(definition, ownerConversationId = null, instance = null) {
    if (instance) {
      return {
        ownerConversationId: instance.ownerConversationId,
        scope: "runtime-isolated",
      };
    }
    const owner = String(ownerConversationId || "").trim() || INTERNAL_CAPABILITY_OWNER;
    return {
      ownerConversationId: owner,
      scope: owner === INTERNAL_CAPABILITY_OWNER ? "internal-isolated" : "conversation-isolated",
    };
  }

  async getMcpClient(pluginId, serverId, instanceToken, ownerConversationId = null) {
    const { plugin } = this.requirePlugin(pluginId, { enabled: true, trusted: true });
    const definition = plugin.mcpServers.find((server) => server.id === serverId);
    if (!definition) throw new Error(`Unknown MCP server ${serverId} in plugin ${pluginId}.`);
    const instance = instanceToken
      ? await this.touchInstance(instanceToken, pluginId, serverId, ownerConversationId)
      : undefined;
    const policy = this.mcpConnectionPolicy(definition, ownerConversationId, instance);
    return await this.connectionManager.getOrConnect({
      pluginId,
      serverId,
      instance,
      ownerConversationId: policy.ownerConversationId,
      connect: () => this.createMcpClient(pluginId, definition, instance),
    });
  }

  async executeMcpRequest(pluginId, serverId, instanceToken, operation, ownerConversationId = null) {
    const instance = instanceToken
      ? this.connectionManager.resolveInstance(instanceToken, { pluginId, serverId, ownerConversationId })
      : undefined;
    const { plugin } = this.requirePlugin(pluginId, { enabled: true, trusted: true });
    const definition = plugin.mcpServers.find((server) => server.id === serverId);
    if (!definition) throw new Error(`Unknown MCP server ${serverId} in plugin ${pluginId}.`);
    const policy = this.mcpConnectionPolicy(definition, ownerConversationId, instance);
    const holder = await this.getMcpClient(pluginId, serverId, instanceToken, ownerConversationId);
    const key = this.clientKey(pluginId, serverId, instance?.instanceId, policy);
    try {
      return {
        result: await operation(holder.client),
        instance,
      };
    }
    catch (error) {
      if (shouldInvalidateMcpClient(error)) {
        await this.connectionManager.invalidate({
          pluginId,
          serverId,
          instanceId: instance?.instanceId,
          ownerConversationId: policy.ownerConversationId,
          closeHolder: (value) => this.closeMcpHolder(value),
          reason: error instanceof Error ? error.message : String(error),
        }).catch(() => {});
      }
      throw error;
    }
  }

  mcpServerCatalog() {
    const rows = [];
    for (const [pluginId, plugin] of this.discovered) {
      const entry = this.registryEntry(pluginId);
      if (!entry?.enabled || !entry?.trusted) continue;
      for (const definition of plugin.mcpServers || []) {
        if (["metadata-only", "package-metadata"].includes(definition.type)) continue;
        rows.push({
          server: publicMcpServerKey(pluginId, definition.id),
          pluginId,
          serverId: definition.id,
          description: boundedPublicText(definition.description, 1000),
          type: definition.type,
        });
      }
    }
    return rows.sort((a, b) => a.server.localeCompare(b.server));
  }

  resolveMcpServer(serverValue) {
    const requested = String(serverValue ?? "").trim();
    if (!requested) throw new Error("MCP server is required. Call list_mcp_resources or capability_list first.");
    const catalog = this.mcpServerCatalog();
    const exact = catalog.find((row) => row.server === requested);
    if (exact) return exact;
    const normalizedAlias = requested.replace(/^mcp__/, "").replace(/__/g, "/");
    const alias = catalog.find((row) => row.server === normalizedAlias);
    if (alias) return alias;
    const byServerId = catalog.filter((row) => row.serverId === requested);
    if (byServerId.length === 1) return byServerId[0];
    const available = catalog.slice(0, 20).map((row) => row.server).join(", ");
    throw new Error(`Unknown or ambiguous MCP server '${requested}'. Available server keys: ${available || "none"}.`);
  }

  async listMcpResources({ server, cursor, limit = MAX_MCP_RESOURCE_ITEMS } = {}, ownerConversationId = null) {
    await this.ready;
    const itemLimit = clampInteger(limit, MAX_MCP_RESOURCE_ITEMS, 1, MAX_MCP_RESOURCE_ITEMS);
    if (cursor && !server) throw new Error("cursor requires an explicit server key so pagination cannot cross MCP servers ambiguously.");
    const targets = server
      ? [this.resolveMcpServer(server)]
      : this.mcpServerCatalog().slice(0, MAX_MCP_RESOURCE_SERVERS);
    const results = [];
    let total = 0;
    for (const target of targets) {
      if (total >= itemLimit) break;
      try {
        const holder = await this.getMcpClient(target.pluginId, target.serverId, undefined, ownerConversationId);
        const capabilities = holder.client.getServerCapabilities() || {};
        if (!capabilities.resources) {
          results.push({ ...target, supported: false, resources: [], nextCursor: null });
          continue;
        }
        const { result } = await this.executeMcpRequest(
          target.pluginId,
          target.serverId,
          undefined,
          (client, options) => client.listResources(cursor ? { cursor } : undefined, options),
          ownerConversationId,
        );
        const remaining = itemLimit - total;
        const resources = (result?.resources || []).slice(0, remaining).map(sanitizeListedResource);
        total += resources.length;
        results.push({
          ...target,
          supported: true,
          resources,
          nextCursor: result?.nextCursor ? boundedPublicText(result.nextCursor, 4096) : null,
          truncated: (result?.resources || []).length > resources.length,
        });
      }
      catch (error) {
        results.push({
          ...target,
          supported: null,
          resources: [],
          nextCursor: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      ok: true,
      server: server || null,
      resources: results,
      totalResources: total,
      serverCount: results.length,
      serverLimitReached: !server && this.mcpServerCatalog().length > MAX_MCP_RESOURCE_SERVERS,
    };
  }

  async listMcpResourceTemplates({ server, cursor, limit = MAX_MCP_RESOURCE_ITEMS } = {}, ownerConversationId = null) {
    await this.ready;
    const itemLimit = clampInteger(limit, MAX_MCP_RESOURCE_ITEMS, 1, MAX_MCP_RESOURCE_ITEMS);
    if (cursor && !server) throw new Error("cursor requires an explicit server key so pagination cannot cross MCP servers ambiguously.");
    const targets = server
      ? [this.resolveMcpServer(server)]
      : this.mcpServerCatalog().slice(0, MAX_MCP_RESOURCE_SERVERS);
    const results = [];
    let total = 0;
    for (const target of targets) {
      if (total >= itemLimit) break;
      try {
        const holder = await this.getMcpClient(target.pluginId, target.serverId, undefined, ownerConversationId);
        const capabilities = holder.client.getServerCapabilities() || {};
        if (!capabilities.resources) {
          results.push({ ...target, supported: false, resourceTemplates: [], nextCursor: null });
          continue;
        }
        const { result } = await this.executeMcpRequest(
          target.pluginId,
          target.serverId,
          undefined,
          (client, options) => client.listResourceTemplates(cursor ? { cursor } : undefined, options),
          ownerConversationId,
        );
        const remaining = itemLimit - total;
        const resourceTemplates = (result?.resourceTemplates || []).slice(0, remaining).map(sanitizeListedResourceTemplate);
        total += resourceTemplates.length;
        results.push({
          ...target,
          supported: true,
          resourceTemplates,
          nextCursor: result?.nextCursor ? boundedPublicText(result.nextCursor, 4096) : null,
          truncated: (result?.resourceTemplates || []).length > resourceTemplates.length,
        });
      }
      catch (error) {
        results.push({
          ...target,
          supported: null,
          resourceTemplates: [],
          nextCursor: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      ok: true,
      server: server || null,
      resourceTemplates: results,
      totalResourceTemplates: total,
      serverCount: results.length,
      serverLimitReached: !server && this.mcpServerCatalog().length > MAX_MCP_RESOURCE_SERVERS,
    };
  }

  async readMcpResourceByServer({ server, uri, instanceToken } = {}, ownerConversationId = null) {
    const target = this.resolveMcpServer(server);
    const resourceUri = String(uri ?? "").trim();
    if (!resourceUri) throw new Error("MCP resource uri is required.");
    return await this.readMcpResource(target.pluginId, target.serverId, resourceUri, instanceToken, ownerConversationId);
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

  async listMcpTools(pluginId, serverId, instanceToken, ownerConversationId = null) {
    await this.ready;
    const { result, instance } = await this.executeMcpRequest(
      pluginId,
      serverId,
      instanceToken,
      (client) => client.listTools(),
      ownerConversationId,
    );
    return {
      ok: true,
      pluginId,
      serverId,
      instanceId: instance?.instanceId,
      runtimeId: instance?.runtimeId ?? null,
      tools: Array.isArray(result?.tools) ? result.tools : [],
    };
  }

  async callMcp(pluginId, serverId, toolName, args = {}, instanceToken, ownerConversationId = null) {
    await this.ready;
    if (!toolName) throw new Error("toolName is required for MCP tool calls.");
    const { result, instance } = await this.executeMcpRequest(
      pluginId,
      serverId,
      instanceToken,
      (client) => client.callTool({ name: toolName, arguments: args || {} }),
      ownerConversationId,
    );
    return { ok: true, pluginId, kind: "mcp", serverId, instanceId: instance?.instanceId, runtimeId: instance?.runtimeId ?? null, toolName, result };
  }

  async readMcpResource(pluginId, serverId, resourceUri, instanceToken, ownerConversationId = null) {
    await this.ready;
    if (!resourceUri) throw new Error("resourceUri is required for MCP resource reads.");
    const { result, instance } = await this.executeMcpRequest(
      pluginId,
      serverId,
      instanceToken,
      (client) => client.readResource({ uri: resourceUri }),
      ownerConversationId,
    );
    return { ok: true, pluginId, kind: "mcp-resource", serverId, instanceId: instance?.instanceId, runtimeId: instance?.runtimeId ?? null, resourceUri, result };
  }

  async getMcpPrompt(pluginId, serverId, promptName, args = {}, instanceToken, ownerConversationId = null) {
    await this.ready;
    if (!promptName) throw new Error("promptName is required for MCP prompt retrieval.");
    const { result, instance } = await this.executeMcpRequest(
      pluginId,
      serverId,
      instanceToken,
      (client) => client.getPrompt({ name: promptName, arguments: args || {} }),
      ownerConversationId,
    );
    return { ok: true, pluginId, kind: "mcp-prompt", serverId, instanceId: instance?.instanceId, runtimeId: instance?.runtimeId ?? null, promptName, result };
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

  async call(input, { ownerConversationId = null } = {}) {
    if (["mcp", "mcp-resource", "mcp-prompt"].includes(input.kind) && !input.serverId) {
      throw new Error("serverId is required for MCP capability calls.");
    }
    if (input.kind === "mcp") {
      return await this.callMcp(input.pluginId, input.serverId, input.toolName, input.arguments, input.instanceToken, ownerConversationId);
    }
    if (input.kind === "mcp-resource") {
      return await this.readMcpResource(input.pluginId, input.serverId, input.resourceUri, input.instanceToken, ownerConversationId);
    }
    if (input.kind === "mcp-prompt") {
      return await this.getMcpPrompt(input.pluginId, input.serverId, input.promptName, input.arguments, input.instanceToken, ownerConversationId);
    }
    if (input.kind === "tool") {
      return await this.callCommandTool(input.pluginId, input.toolName, input.arguments);
    }
    throw new Error(`Unsupported capability kind: ${input.kind}`);
  }

  listConnections(input = {}) {
    return this.connectionManager.listConnections(input);
  }

  async reconnectConnection({ pluginId, serverId, instanceToken, ownerConversationId = null } = {}) {
    const { plugin } = this.requirePlugin(pluginId, { enabled: true, trusted: true });
    const definition = plugin.mcpServers.find((server) => server.id === serverId);
    if (!definition) throw new Error(`Unknown MCP server ${serverId} in plugin ${pluginId}.`);
    const instance = instanceToken
      ? await this.touchInstance(instanceToken, pluginId, serverId, ownerConversationId)
      : undefined;
    const policy = this.mcpConnectionPolicy(definition, ownerConversationId, instance);
    const key = this.clientKey(pluginId, serverId, instance?.instanceId, policy);
    await this.closeClientKey(key);
    if (instance) {
      instance.connectionState = "disconnected";
      instance.connectedAt = null;
      instance.lastError = null;
    }
    await this.getMcpClient(pluginId, serverId, instanceToken, ownerConversationId);
    return {
      ok: true,
      pluginId,
      serverId,
      mode: policy.scope,
      runtime: instance ? this.publicInstance(instance) : null,
      connectionState: "online",
    };
  }

  diagnostics() {
    const connections = this.connectionManager.diagnostics();
    return {
      enabled: this.enabled === true,
      discoveredPlugins: this.discovered.size,
      mcpClients: connections.clients,
      mcpConnecting: connections.connecting,
      mcpStartupTails: connections.startupQueues,
      mcpInstances: connections.instances,
      sharedConnections: connections.sharedConnections,
      isolatedConnections: connections.isolatedConnections,
      conversationIsolatedConnections: connections.conversationIsolatedConnections,
      runtimeIsolatedConnections: connections.runtimeIsolatedConnections,
      readyConnections: connections.readyConnections,
      failedConnections: connections.failedConnections,
      disconnectedConnections: connections.disconnectedConnections,
    };
  }

  async close() {
    this.routingListeners.clear();
    await this.connectionManager.closeAll({
      closeHolder: (holder) => this.closeMcpHolder(holder),
    });
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

function capabilityRoutingToolMeta(runtime, modelInstructionsFingerprint = null) {
  const routingFingerprint = typeof runtime?.routingFingerprint === "function"
    ? runtime.routingFingerprint({ includeDisabled: true })
    : capabilityRoutingFingerprint([]);
  return {
    _meta: {
      devspace: {
        routingContractVersion: ROUTING_CONTRACT_VERSION,
        routingFingerprint,
        ...(modelInstructionsFingerprint ? { modelInstructionsFingerprint: String(modelInstructionsFingerprint) } : {}),
      },
    },
  };
}

export function registerCapabilityTools(server, runtime, {
  modelInstructionsFingerprint = null,
  resolveConversation = null,
  blenderRuntimeManager = null,
  codexMcpBridge = null,
} = {}) {
  const routingMeta = capabilityRoutingToolMeta(runtime, modelInstructionsFingerprint);
  const currentConversation = async (extra) => {
    if (typeof resolveConversation !== "function") return null;
    const resolved = await resolveConversation(extra);
    return String(resolved?.conversationId || "").trim() || null;
  };
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
      const probeDeferred = input.probeMcp === true;
      const plugins = await runtime.list({ ...input, probeMcp: false });
      return textResult({
        ok: true,
        plugins,
        probeDeferred,
        connectionPolicy: "conversation-isolated",
        instruction: probeDeferred
          ? "Catalogue discovery never opens a shared MCP client. Use the selected runtime-aware entry point or capability_call so the live schema is fetched through the current conversation's isolated connection."
          : undefined,
      });
    }
    catch (error) { return errorResult(error); }
  });

  const capabilityRouteRegistration = server.registerTool("capability_route", {
    title: "Route Task to Skill, Plugin, or Tool",
    description: "Use this proactively before generic file, shell, browser, or app work whenever the user's requested outcome may match an installed reusable skill, capability plugin, command adapter, or MCP tool. It performs bounded deterministic routing over names, aliases, descriptions, Codex-style interface metadata, default prompts, declared dependencies, negative gates, trust state, and implicit-invocation policy without loading every skill body. Follow primary.nextAction exactly: read a selected SKILL.md before substantive work, inspect only the selected plugin/server when schemas are still deferred, or call the returned exact tool. Explicit-only skills remain blocked unless the user names them.",
    inputSchema: {
      query: z.string().min(1).max(2_000),
      includeDisabled: z.boolean().default(false),
      probeMcp: z.boolean().default(false),
      limit: z.number().int().min(1).max(50).default(8),
    },
    annotations: READ_ONLY,
    ...routingMeta,
  }, async (input) => {
    try {
      const result = await runtime.route(input.query, { ...input, probeMcp: false });
      return textResult({
        ...result,
        connectionPolicy: "conversation-isolated",
      });
    }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("capability_search", {
    title: "Search Agent Capabilities",
    description: "Search plugin-level capability summaries by name, description, skill, MCP server/tool, or declared command tool. For task-level routing with an exact skill/plugin/tool next action, prefer capability_route; use capability_search for broad catalog exploration only.",
    inputSchema: {
      query: z.string().min(1).max(500),
      includeDisabled: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(20),
    },
    annotations: READ_ONLY,
    ...routingMeta,
  }, async (input) => {
    try {
      const plugins = await runtime.search(input.query, input);
      return textResult({ ok: true, query: input.query, plugins });
    }
    catch (error) { return errorResult(error); }
  });

  let disposeRoutingChange = () => {};
  if (typeof runtime?.onRoutingChanged === "function" && typeof capabilityRouteRegistration?.update === "function") {
    disposeRoutingChange = runtime.onRoutingChanged(() => {
      const nextMeta = capabilityRoutingToolMeta(runtime, modelInstructionsFingerprint);
      // MCP SDK RegisteredTool.update emits notifications/tools/list_changed
      // for connected clients, so active agents refresh the routing surface.
      capabilityRouteRegistration.update({ _meta: nextMeta._meta });
    });
    const protocol = server?.server;
    if (protocol && "onclose" in protocol) {
      const previousOnClose = protocol.onclose;
      protocol.onclose = () => {
        disposeRoutingChange();
        try { previousOnClose?.call(protocol); } catch {}
      };
    }
  }

  server.registerTool("capability_import_codex", {
    title: "Import Codex MCP Catalog",
    description: "Audit or import local Codex MCP servers into DevSpace as separately reviewable managed capability plugins. Dry-run is the default. Secret values are never copied into plugin manifests or the registry; executable-surface drift fails closed. Standard-risk entries may be bulk-enabled with enableSafe, high-impact/stateful entries require explicit names, and privileged entries additionally require allowPrivileged=true.",
    inputSchema: {
      configPath: z.string().min(1).max(4096).optional(),
      serverIds: z.array(z.string().min(1).max(180)).max(100).default([]),
      excludeServerIds: z.array(z.string().min(1).max(180)).max(100).default([]),
      apply: z.boolean().default(false),
      enableSafe: z.boolean().default(false),
      enableServerIds: z.array(z.string().min(1).max(180)).max(100).default([]),
      allowPrivileged: z.boolean().default(false),
    },
    annotations: MUTATING,
  }, async (input) => {
    try {
      const operation = () => importCodexMcpCatalog({
        runtime,
        ...(input.configPath ? { codexConfigPath: input.configPath } : {}),
        serverIds: input.serverIds,
        excludeServerIds: input.excludeServerIds,
        apply: input.apply,
        enableSafe: input.enableSafe,
        enableServerIds: input.enableServerIds,
        allowPrivileged: input.allowPrivileged,
      });
      return textResult(input.apply
        ? await runtime.serializeMutation(operation)
        : await operation());
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

  const capabilityConnectionDefinition = {
    title: "Manage Plugin and MCP Connections",
    description: "Single connection authority for DevSpace capability and linked Codex MCP transports. Every ChatGPT conversation receives its own MCP client/session boundary; no transport is shared across conversations. Stateful application services are additionally bound by plugin/server/instance/runtime/current conversation and may carry a private loopback port. Use claim for a stateful runtime, list/status to inspect only the current conversation, reconnect after a real transport failure, and release to close exactly one isolated connection. There is no lease timeout, arbitrary connection-count ceiling, or background reconnect loop; the next real call reconnects on demand.",
    inputSchema: {
      action: z.enum(["claim", "list", "status", "reconnect", "release"]).default("list"),
      source: z.enum(["all", "capability", "codex"]).default("all"),
      pluginId: z.string().min(1).max(180).optional(),
      serverId: z.string().min(1).max(220).optional(),
      instanceId: z.string().min(1).max(180).optional(),
      runtimeId: z.string().min(1).max(180).optional(),
      instanceToken: z.string().min(16).optional(),
      env: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
      ownerLabel: z.string().min(1).max(120).optional(),
    },
    annotations: MUTATING,
    ...routingMeta,
  };
  const capabilityConnectionHandler = async (input, extra) => {
    try {
      const ownerConversationId = await currentConversation(extra);
      if (input.action === "list" || input.action === "status") {
        const capabilityConnections = input.source === "codex" ? [] : runtime.listConnections({
          pluginId: input.pluginId,
          serverId: input.serverId,
          ownerConversationId,
        });
        const codexConnections = input.source === "capability" || !codexMcpBridge?.listConnections
          ? []
          : codexMcpBridge.listConnections({ serverId: input.serverId, ownerConversationId });
        return textResult({
          ok: true,
          ownerConversationId,
          source: input.source,
          connections: [...capabilityConnections, ...codexConnections],
          instances: await runtime.listInstances({
            pluginId: input.pluginId,
            serverId: input.serverId,
            ownerConversationId,
          }),
          diagnostics: runtime.diagnostics(),
        });
      }
      if (input.action === "release") {
        if (input.source === "codex") throw new Error("Linked Codex MCP connections are automatically conversation-isolated; use action=reconnect to reset the current conversation's transport.");
        if (!input.instanceToken) throw new Error("instanceToken is required for action=release.");
        return textResult(await runtime.releaseInstance(input.instanceToken, ownerConversationId));
      }
      if (input.action === "reconnect") {
        if (!input.serverId) throw new Error("serverId is required for action=reconnect.");
        if (input.source === "codex") {
          if (!codexMcpBridge?.resetConnection) throw new Error("Codex MCP connection manager is unavailable.");
          return textResult(await codexMcpBridge.resetConnection(input.serverId, ownerConversationId));
        }
        if (!input.pluginId) throw new Error("pluginId is required for capability action=reconnect.");
        return textResult(await runtime.reconnectConnection({
          pluginId: input.pluginId,
          serverId: input.serverId,
          instanceToken: input.instanceToken,
          ownerConversationId,
        }));
      }
      if (input.source === "codex") throw new Error("Linked Codex MCP transports are automatically isolated by conversation; action=claim is reserved for stateful application runtimes.");
      if (!input.pluginId || !input.serverId || !input.instanceId) {
        throw new Error("pluginId, serverId, and instanceId are required for action=claim.");
      }
      const ownerLabel = input.ownerLabel || (extra?.sessionId ? `mcp:${String(extra.sessionId).slice(0, 12)}` : "agent");
      return textResult(await runtime.claimInstance({
        pluginId: input.pluginId,
        serverId: input.serverId,
        instanceId: input.instanceId,
        runtimeId: input.runtimeId,
        ownerLabel,
        ownerConversationId,
        env: input.env,
      }));
    }
    catch (error) { return errorResult(error); }
  };
  server.registerTool("capability_connection", capabilityConnectionDefinition, capabilityConnectionHandler);

  server.registerTool("capability_instance", {
    ...capabilityConnectionDefinition,
    title: "Manage Capability MCP Instance (compatibility alias)",
    description: `${capabilityConnectionDefinition.description} capability_instance remains as a compatibility alias; new routing should prefer capability_connection.`,
  }, capabilityConnectionHandler);

  server.registerTool("devspace_connection_isolation_status", {
    title: "Inspect Conversation Connection Isolation",
    description: "Verify that the current ChatGPT conversation owns only its isolated Plugin/MCP connections and Blender runtimes. Reports legacy shared entries as retired diagnostics; they are never returned as executable routes. Use this after tool-schema refresh, runtime adoption, reconnect, or Core restart.",
    inputSchema: {},
    annotations: READ_ONLY,
    ...routingMeta,
  }, async (_input, extra) => {
    try {
      const ownerConversationId = await currentConversation(extra);
      if (!ownerConversationId) throw new Error("A verified ChatGPT conversation identity is required.");
      const allConnections = runtime.listConnections({ ownerConversationId });
      const isolatedConnections = allConnections.filter((connection) => connection.scope !== "shared" && connection.mode !== "shared");
      const legacySharedConnections = allConnections.filter((connection) => connection.scope === "shared" || connection.mode === "shared");
      const blenderRuntimes = blenderRuntimeManager
        ? await blenderRuntimeManager.list(ownerConversationId)
        : [];
      return textResult({
        ok: legacySharedConnections.length === 0,
        policy: "conversation-isolated",
        ownerConversationId,
        isolatedConnections,
        legacySharedConnections: legacySharedConnections.map((connection) => ({
          pluginId: connection.pluginId,
          serverId: connection.serverId,
          state: connection.state,
          executable: false,
        })),
        blenderRuntimes,
        instruction: legacySharedConnections.length
          ? "Restart/reconcile the Core to retire pre-policy shared clients; do not route Agent work through them."
          : "All currently visible Agent connections are conversation-isolated.",
      });
    }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("list_mcp_resources", {
    title: "List MCP resources",
    description: "List resources provided by enabled trusted DevSpace capability MCP servers. Omit server for a bounded first-page summary across all servers, then pass the exact returned server key for pagination. An empty resource list never means the server has no callable tools.",
    inputSchema: {
      server: z.string().min(1).max(400).optional(),
      cursor: z.string().min(1).max(4096).optional(),
      limit: z.number().int().min(1).max(MAX_MCP_RESOURCE_ITEMS).default(MAX_MCP_RESOURCE_ITEMS),
    },
    annotations: READ_ONLY,
  }, async (input, extra) => {
    try { return textResult(await runtime.listMcpResources(input, await currentConversation(extra))); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("list_mcp_resource_templates", {
    title: "List MCP resource templates",
    description: "List parameterized resource templates from enabled trusted DevSpace capability MCP servers. Omit server for a bounded first-page summary, or pass an exact server key and cursor for server-local pagination.",
    inputSchema: {
      server: z.string().min(1).max(400).optional(),
      cursor: z.string().min(1).max(4096).optional(),
      limit: z.number().int().min(1).max(MAX_MCP_RESOURCE_ITEMS).default(MAX_MCP_RESOURCE_ITEMS),
    },
    annotations: READ_ONLY,
  }, async (input, extra) => {
    try { return textResult(await runtime.listMcpResourceTemplates(input, await currentConversation(extra))); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("read_mcp_resource", {
    title: "Read MCP resource",
    description: "Read one resource from an enabled trusted DevSpace capability MCP server. Pass the exact server key returned by list_mcp_resources and one listed URI; arbitrary web URLs are not MCP resources unless the server explicitly listed or templated them.",
    inputSchema: {
      server: z.string().min(1).max(400),
      uri: z.string().min(1).max(16_384),
      instanceToken: z.string().min(16).optional(),
    },
    annotations: READ_ONLY,
  }, async (input, extra) => {
    try {
      const result = await runtime.readMcpResourceByServer(input, await currentConversation(extra));
      const contents = Array.isArray(result?.result?.contents) ? result.result.contents : [];
      const content = contents.map((resource) => ({
        type: "resource",
        resource: {
          uri: String(resource?.uri || input.uri),
          ...(resource?.mimeType ? { mimeType: String(resource.mimeType) } : {}),
          ...(typeof resource?.text === "string" ? { text: resource.text } : { blob: String(resource?.blob || "") }),
        },
      }));
      if (!content.length) content.push({ type: "text", text: `MCP resource ${input.uri} returned no contents.` });
      return {
        content,
        structuredContent: {
          ok: true,
          server: input.server,
          uri: input.uri,
          contentCount: contents.length,
          contentTypes: contents.map((item) => typeof item?.text === "string" ? "text" : "blob"),
        },
      };
    }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("blender_runtime", {
    title: "Manage Isolated Blender Runtimes",
    description: "Start, adopt, attach, inspect, release, or stop a conversation-owned Blender application runtime. Each runtime receives its own runtimeId, loopback MCP port, Blender process binding and isolated blender-local MCP connection, allowing multiple agents to operate different Blender projects concurrently without cross-routing. discover finds running Blender processes and listener ports; start launches a new visible Blender process; adopt/attach binds an already-running addon endpoint without reopening Blender or replacing its current file; release removes only DevSpace's connection while leaving Blender open; stop gracefully closes only a DevSpace-managed Blender process. No lease or wall-clock timeout is applied.",
    inputSchema: {
      action: z.enum(["discover", "list", "status", "start", "adopt", "attach", "release", "stop"]).default("list"),
      runtimeId: z.string().min(1).max(120).optional(),
      ownerLabel: z.string().min(1).max(120).optional(),
      executable: z.string().min(1).max(4000).optional(),
      blendFile: z.string().min(1).max(4000).optional(),
      port: z.number().int().min(1024).max(65535).optional(),
      processId: z.number().int().positive().optional(),
    },
    annotations: CALLING,
    ...routingMeta,
  }, async (input, extra) => {
    try {
      if (!blenderRuntimeManager) throw new Error("Blender Runtime Manager is unavailable.");
      const ownerConversationId = await currentConversation(extra);
      if (!ownerConversationId) throw new Error("Blender Runtime Manager requires the current ChatGPT conversation identity.");
      if (input.action === "discover") {
        return textResult({ ok: true, ownerConversationId, processes: await blenderRuntimeManager.discover(ownerConversationId) });
      }
      if (input.action === "list") {
        return textResult({ ok: true, ownerConversationId, runtimes: await blenderRuntimeManager.list(ownerConversationId) });
      }
      if (!input.runtimeId) throw new Error(`runtimeId is required for action=${input.action}.`);
      if (input.action === "status") return textResult(await blenderRuntimeManager.status(input.runtimeId, ownerConversationId));
      if (input.action === "attach" || input.action === "adopt") {
        if (!input.port) throw new Error(`port is required for action=${input.action}.`);
        const operation = input.action === "adopt"
          ? blenderRuntimeManager.adoptExisting.bind(blenderRuntimeManager)
          : blenderRuntimeManager.attach.bind(blenderRuntimeManager);
        return textResult(await operation({
          runtimeId: input.runtimeId,
          ownerConversationId,
          ownerLabel: input.ownerLabel,
          port: input.port,
          processId: input.processId,
          blendFile: input.blendFile,
        }));
      }
      if (input.action === "start") {
        return textResult(await blenderRuntimeManager.start({
          runtimeId: input.runtimeId,
          ownerConversationId,
          ownerLabel: input.ownerLabel,
          executable: input.executable,
          blendFile: input.blendFile,
          port: input.port,
          signal: extra?.signal,
        }));
      }
      return textResult(await blenderRuntimeManager.stop({
        runtimeId: input.runtimeId,
        ownerConversationId,
        terminateProcess: input.action === "stop",
      }));
    }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("blender_mcp", {
    title: "Operate Live Blender via MCP",
    description: "Actual execution entry point for Blender. Omitting runtimeId resolves only the current conversation's unique/default assigned runtime, including an adopted user-opened Blender that is already mid-work; it never falls back to a backend-wide shared Blender connection. When a conversation owns multiple runtimes, pass runtimeId explicitly. Do not stop after capability discovery: action=list reads the selected runtime's live schema and action=call invokes one returned tool. Use execute_blender_code for mutations and screenshot/summary tools for readback.",
    inputSchema: {
      action: z.enum(["list", "call"]).default("list"),
      toolName: z.string().min(1).max(220).optional(),
      arguments: z.record(z.string(), z.unknown()).default({}),
      instanceToken: z.string().min(16).optional(),
      runtimeId: z.string().min(1).max(180).optional(),
    },
    annotations: CALLING,
    ...routingMeta,
  }, async (input, extra) => {
    try {
      const ownerConversationId = await currentConversation(extra);
      if (input.instanceToken && input.runtimeId) throw new Error("Pass either runtimeId or instanceToken, not both.");
      if (!ownerConversationId) throw new Error("Blender MCP requires the current ChatGPT conversation identity.");
      if (!blenderRuntimeManager) throw new Error("Blender Runtime Manager is unavailable.");
      const instanceToken = input.runtimeId
        ? await blenderRuntimeManager.instanceToken(input.runtimeId, ownerConversationId)
        : input.instanceToken || await blenderRuntimeManager.defaultInstanceToken(ownerConversationId);
      if (input.action === "list") {
        const listed = await runtime.listMcpTools("blender-local", "blender", instanceToken, ownerConversationId);
        return textResult({
          ...listed,
          executionTool: "blender_mcp",
          instruction: "Select one returned tool and immediately call blender_mcp with action=call, the same runtimeId when visible in your schema, that toolName, and schema-valid arguments. Cached clients may omit runtimeId only because the backend has already bound this conversation to its unique default runtime.",
        });
      }
      if (!input.toolName) throw new Error("toolName is required when action=call.");
      const called = await runtime.call({
        pluginId: "blender-local",
        kind: "mcp",
        serverId: "blender",
        toolName: input.toolName,
        arguments: input.arguments,
        instanceToken,
      }, { ownerConversationId });
      const resolvedRuntimeId = input.runtimeId
        || runtime.findInstanceByToken(instanceToken)?.runtimeId
        || null;
      if (resolvedRuntimeId && typeof blenderRuntimeManager.observeMcpResult === "function") {
        await blenderRuntimeManager.observeMcpResult(resolvedRuntimeId, ownerConversationId, called).catch(() => null);
      }
      return textResult(called);
    }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("capability_call", {
    title: "Call Agent Capability Tool",
    description: "Invoke a capability through the DevSpace backend. Every MCP call/resource/prompt is conversation-isolated by default: when runtimeId or instanceToken is omitted, DevSpace creates or reuses an implicit connection owned only by the current ChatGPT conversation. Stateful application MCPs should still use their dedicated runtime manager so each project also receives its own process/port; Blender must use blender_runtime/blender_mcp. kind=tool invokes an explicitly declared command adapter with JSON on stdin. Use capability_search/inspect first to discover names, URIs, and schemas.",
    inputSchema: {
      pluginId: z.string().min(1).max(180),
      kind: z.enum(["mcp", "mcp-resource", "mcp-prompt", "tool"]),
      serverId: z.string().min(1).max(220).optional(),
      toolName: z.string().min(1).max(220).optional(),
      resourceUri: z.string().min(1).max(16_384).optional(),
      promptName: z.string().min(1).max(220).optional(),
      instanceToken: z.string().min(16).optional(),
      runtimeId: z.string().min(1).max(180).optional(),
      arguments: z.record(z.string(), z.unknown()).default({}),
    },
    annotations: CALLING,
  }, async (input, extra) => {
    try {
      const ownerConversationId = await currentConversation(extra);
      if (input.instanceToken && input.runtimeId) throw new Error("Pass either runtimeId or instanceToken, not both.");
      let instanceToken = input.runtimeId
        ? runtime.connectionManager.tokenForRuntime(input.runtimeId, {
            pluginId: input.pluginId,
            serverId: input.serverId,
            ownerConversationId,
          })
        : input.instanceToken;
      if (!instanceToken && input.kind !== "tool") {
        if (!input.serverId) throw new Error("serverId is required for MCP connection isolation.");
        const isolated = await runtime.ensureConversationInstance({
          pluginId: input.pluginId,
          serverId: input.serverId,
          ownerConversationId,
          ownerLabel: "Capability Agent",
        });
        instanceToken = isolated.instanceToken;
      }
      return textResult(await runtime.call({ ...input, instanceToken }, { ownerConversationId }));
    }
    catch (error) { return errorResult(error); }
  });

  return { disposeRoutingChange };
}
