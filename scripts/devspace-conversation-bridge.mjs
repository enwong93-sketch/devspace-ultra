#!/usr/bin/env node
import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";
import { CapabilityRuntime } from "../dist/capability-runtime.js";
import { loadDevspaceFiles } from "../dist/user-config.js";

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const [command = "status", ...rest] = argv;
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) fail(`Unexpected argument: ${item}`);
    const key = item.slice(2);
    const next = rest[index + 1];
    if (next == null || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    index += 1;
  }
  return { command, flags };
}

function stripBom(text) {
  return String(text).replace(/^\uFEFF/, "");
}

async function readJson(path) {
  return JSON.parse(stripBom(await readFile(path, "utf8")));
}

function walkObjects(value, visit, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, visit, seen);
    return;
  }
  for (const item of Object.values(value)) walkObjects(item, visit, seen);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function resolveConversationId(authorityState, runtimeKey) {
  const requestedKey = runtimeKey.toLowerCase();
  const sessions = Array.isArray(authorityState?.sessions) ? authorityState.sessions : [];
  const candidates = sessions
    .filter((entry) => entry?.ambiguous !== true)
    .filter((entry) => {
      const runtimeKeys = Array.isArray(entry?.runtimeKeys)
        ? entry.runtimeKeys
        : entry?.runtimeKey != null
          ? [entry.runtimeKey]
          : [];
      return runtimeKeys.some((value) => String(value || "").toLowerCase() === requestedKey);
    })
    .map((entry) => ({
      conversationIds: unique((Array.isArray(entry?.conversationIds)
        ? entry.conversationIds
        : entry?.conversationId != null
          ? [entry.conversationId]
          : []).map((value) => String(value || "").trim())),
      updatedAtMs: Date.parse(entry?.updatedAt || "") || 0,
    }))
    .filter((entry) => entry.conversationIds.length === 1)
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  if (candidates.length) return candidates[0].conversationIds[0];

  const fallbackMatches = [];
  walkObjects(authorityState, (entry) => {
    const runtimeKeys = Array.isArray(entry.runtimeKeys)
      ? entry.runtimeKeys
      : entry.runtimeKey != null
        ? [entry.runtimeKey]
        : [];
    if (!runtimeKeys.some((value) => String(value || "").toLowerCase() === requestedKey)) return;
    const conversationIds = Array.isArray(entry.conversationIds)
      ? entry.conversationIds
      : entry.conversationId != null
        ? [entry.conversationId]
        : [];
    for (const value of conversationIds) {
      const conversationId = String(value || "").trim();
      if (conversationId) fallbackMatches.push(conversationId);
    }
  });
  const ids = unique(fallbackMatches);
  if (ids.length !== 1) {
    fail(`Expected exactly one authoritative conversation for ${runtimeKey}; observed ${ids.length}.`);
  }
  return ids[0];
}

function resolveRuntime(runtimeState, runtimeId) {
  const matches = [];
  walkObjects(runtimeState, (entry) => {
    if (String(entry.runtimeId || "") === runtimeId) matches.push(entry);
  });
  if (matches.length !== 1) {
    fail(`Expected exactly one Blender runtime ${runtimeId}; observed ${matches.length}.`);
  }
  return matches[0];
}

function processAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    // Signal 0 probes liveness only. It never terminates the Blender process.
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function portOnline(port) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: "127.0.0.1", port: Number(port) });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function capabilityOptions(config) {
  return {
    enabled: config.pluginsEnabled,
    pluginsDir: config.pluginsDir,
    registryPath: config.capabilityRegistryPath,
    pluginPaths: config.pluginPaths || [],
  };
}

async function connectBlenderRuntime(runtime, ownerConversationId) {
  const config = loadConfig();
  const capabilityRuntime = new CapabilityRuntime(capabilityOptions(config));
  await capabilityRuntime.ready;
  const claimed = await capabilityRuntime.claimInstance({
    pluginId: "blender-local",
    serverId: "blender",
    instanceId: runtime.runtimeId,
    runtimeId: runtime.runtimeId,
    ownerLabel: runtime.ownerLabel || "DevSpace conversation bridge",
    ownerConversationId,
    env: {
      // Blender Lab's official MCP server uses the BLENDER_MCP_* names.
      BLENDER_MCP_HOST: "127.0.0.1",
      BLENDER_MCP_PORT: String(runtime.port),
      // Retain the community-server aliases for compatibility.
      BLENDER_HOST: "127.0.0.1",
      BLENDER_PORT: String(runtime.port),
    },
  });
  return { capabilityRuntime, instanceToken: claimed.instanceToken };
}

function publicRuntime(runtime, online) {
  return {
    runtimeId: String(runtime.runtimeId),
    ownerConversationId: String(runtime.ownerConversationId),
    ownerLabel: runtime.ownerLabel == null ? null : String(runtime.ownerLabel),
    port: Number(runtime.port),
    processId: Number(runtime.processId),
    managedProcess: runtime.managedProcess === true,
    defaultForOwner: runtime.defaultForOwner === true,
    blendFile: runtime.blendFile == null ? null : String(runtime.blendFile),
    processAlive: processAlive(runtime.processId),
    portOnline: online,
  };
}

function mcpToolFailed(result) {
  return result?.result?.isError === true || result?.isError === true;
}

function progressPayload({ conversationId, runtimeKey, kind, message }) {
  return {
    conversationId,
    runtimeKey,
    kind,
    message,
    source: "agent-progress-tool",
    dedupeKey: `${conversationId}:${runtimeKey}:${Date.now()}:${message.slice(0, 80)}`,
  };
}

async function postProgress(files, payload) {
  const gatewayPort = Number(files.config?.stableGatewayPort ?? files.config?.edgeBackendPort ?? 7678);
  if (!Number.isInteger(gatewayPort) || gatewayPort < 1024 || gatewayPort > 65535) {
    fail("Stable Gateway progress endpoint port is invalid.");
  }
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/__devspace/progress`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const snapshot = await response.json().catch(() => null);
  if (!response.ok) {
    fail(`Progress narration endpoint returned HTTP ${response.status}${snapshot?.error ? ` (${snapshot.error})` : ""}.`);
  }
  return snapshot;
}

const { command, flags } = parseArgs(process.argv.slice(2));
const runtimeKey = String(flags["runtime-key"] || "").trim();
const runtimeId = String(flags["runtime-id"] || "").trim();
if (!runtimeKey) fail("--runtime-key is required so the bridge can bind to the current ChatGPT Main runtime.");

const files = loadDevspaceFiles();
const stateDir = String(files.config?.stableGatewayStateDir || files.config?.stateDir || "").trim();
if (!stateDir) fail("DevSpace state directory is unavailable.");
const authorityState = await readJson(join(stateDir, "classic-conversation-authority.json"));
const conversationId = resolveConversationId(authorityState, runtimeKey);

if (command === "progress") {
  const message = flags["message-file"]
    ? await readFile(String(flags["message-file"]), "utf8")
    : String(flags.message || "");
  const cleanMessage = stripBom(message).trim();
  if (!cleanMessage) fail("progress requires --message or --message-file.");
  const snapshot = await postProgress(files, progressPayload({
    conversationId,
    runtimeKey,
    kind: String(flags.kind || "milestone"),
    message: cleanMessage,
  }));
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  const accepted = messages.at(-1);
  if (accepted?.conversationId !== conversationId || accepted?.text !== cleanMessage) {
    fail("Progress write did not become the current conversation's latest narration message.");
  }
  console.log(JSON.stringify({
    ok: true,
    action: "progress",
    runtimeKey,
    conversationId,
    message: cleanMessage,
    messageCount: messages.filter((item) => item?.conversationId === conversationId).length,
    updatedAt: snapshot.updatedAt || accepted?.at || null,
  }));
  process.exit(0);
}

if (!runtimeId) fail(`${command} requires --runtime-id.`);
const runtimeState = await readJson(join(stateDir, "blender-runtimes.json"));
const runtime = resolveRuntime(runtimeState, runtimeId);
if (String(runtime.ownerConversationId || "") !== conversationId) {
  fail(`Blender runtime ${runtimeId} belongs to a different ChatGPT conversation.`);
}
const online = await portOnline(runtime.port);
if (command === "status") {
  const alive = processAlive(runtime.processId);
  console.log(JSON.stringify({
    ok: online && alive,
    action: "status",
    runtimeKey,
    conversationId,
    runtime: publicRuntime(runtime, online),
  }));
  process.exit(online && alive ? 0 : 2);
}
if (!online) fail(`Blender runtime ${runtimeId} is not listening on 127.0.0.1:${runtime.port}.`);

const connection = await connectBlenderRuntime(runtime, conversationId);
try {
  const listed = await connection.capabilityRuntime.listMcpTools(
    "blender-local",
    "blender",
    connection.instanceToken,
    conversationId,
  );
  const tools = Array.isArray(listed?.tools) ? listed.tools : [];
  if (command === "list") {
    console.log(JSON.stringify({
      ok: true,
      action: "list",
      runtimeKey,
      conversationId,
      runtime: publicRuntime(runtime, true),
      executionBoundary: "DevSpace CapabilityRuntime",
      toolCount: tools.length,
      tools,
    }));
  }
  else {
    if (command !== "call") fail(`Unsupported command: ${command}`);
    const toolName = String(flags.tool || "").trim();
    if (!toolName) fail("call requires --tool.");
    if (!tools.some((tool) => tool?.name === toolName)) {
      fail(`Blender MCP tool ${toolName} is not present in the live ${tools.length}-tool catalog.`);
    }
    let toolArguments = {};
    if (flags["args-file"]) toolArguments = await readJson(String(flags["args-file"]));
    else if (flags["args-json"]) toolArguments = JSON.parse(String(flags["args-json"]));
    const result = await connection.capabilityRuntime.call({
      pluginId: "blender-local",
      kind: "mcp",
      serverId: "blender",
      toolName,
      arguments: toolArguments,
      instanceToken: connection.instanceToken,
    }, { ownerConversationId: conversationId });
    if (mcpToolFailed(result)) {
      const content = Array.isArray(result?.result?.content) ? result.result.content : [];
      const detail = content.map((item) => item?.text).filter(Boolean).join("\n").slice(0, 4000);
      fail(`Blender MCP tool ${toolName} returned an error.${detail ? ` ${detail}` : ""}`);
    }
    console.log(JSON.stringify({
      ok: true,
      action: "call",
      runtimeKey,
      conversationId,
      runtime: publicRuntime(runtime, true),
      toolName,
      result,
    }));
  }
} finally {
  await connection.capabilityRuntime.close().catch(() => {});
}
