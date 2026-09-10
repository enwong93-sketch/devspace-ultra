#!/usr/bin/env node
import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";
import { CapabilityRuntime } from "../dist/capability-runtime.js";
import { loadDevspaceFiles } from "../dist/user-config.js";
import { createStableGatewayHumanProgress } from "../dist/stable-gateway-human-progress.js";

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

function clean(value) {
  return String(value ?? "").trim();
}

function resolveConversationId(authorityState, runtimeKey) {
  const requestedKey = runtimeKey.toLowerCase();
  const candidates = [];
  walkObjects(authorityState, (entry) => {
    if (entry?.ambiguous === true) return;
    const runtimeKeys = Array.isArray(entry?.runtimeKeys)
      ? entry.runtimeKeys
      : entry?.runtimeKey != null
        ? [entry.runtimeKey]
        : [];
    if (!runtimeKeys.some((value) => clean(value).toLowerCase() === requestedKey)) return;
    const conversationIds = Array.isArray(entry?.conversationIds)
      ? entry.conversationIds
      : entry?.conversationId != null
        ? [entry.conversationId]
        : [];
    const ids = [...new Set(conversationIds.map(clean).filter(Boolean))];
    if (ids.length !== 1) return;
    const updatedAt = Date.parse(clean(entry?.updatedAt));
    candidates.push({ conversationId: ids[0], updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0 });
  });
  candidates.sort((left, right) => right.updatedAt - left.updatedAt);
  if (!candidates.length) fail(`No non-ambiguous authoritative conversation is available for ${runtimeKey}.`);
  const latestAt = candidates[0].updatedAt;
  const latestIds = [...new Set(candidates.filter((row) => row.updatedAt === latestAt).map((row) => row.conversationId))];
  if (latestIds.length !== 1) fail(`Latest authority for ${runtimeKey} is ambiguous.`);
  return latestIds[0];
}

function resolveRuntime(runtimeState, runtimeId) {
  const matches = [];
  walkObjects(runtimeState, (entry) => {
    if (clean(entry?.runtimeId) === runtimeId) matches.push(entry);
  });
  if (matches.length !== 1) fail(`Expected exactly one Blender runtime ${runtimeId}; observed ${matches.length}.`);
  return matches[0];
}

function processAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
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

function publicRuntime(runtime, online) {
  return {
    runtimeId: clean(runtime.runtimeId),
    ownerConversationId: clean(runtime.ownerConversationId),
    ownerLabel: clean(runtime.ownerLabel) || null,
    port: Number(runtime.port),
    processId: Number(runtime.processId),
    managedProcess: runtime.managedProcess === true,
    defaultForOwner: runtime.defaultForOwner === true,
    blendFile: clean(runtime.blendFile) || null,
    processAlive: processAlive(runtime.processId),
    portOnline: online,
  };
}

async function connectBlenderRuntime(runtime, ownerConversationId) {
  const config = loadConfig();
  const capabilityRuntime = new CapabilityRuntime({
    enabled: config.pluginsEnabled,
    pluginsDir: config.pluginsDir,
    registryPath: config.capabilityRegistryPath,
    pluginPaths: config.pluginPaths || [],
  });
  await capabilityRuntime.ready;
  const claimed = await capabilityRuntime.claimInstance({
    pluginId: "blender-local",
    serverId: "blender",
    instanceId: clean(runtime.runtimeId),
    runtimeId: clean(runtime.runtimeId),
    ownerLabel: clean(runtime.ownerLabel) || "DevSpace conversation bridge",
    ownerConversationId,
    env: {
      BLENDER_MCP_HOST: "127.0.0.1",
      BLENDER_MCP_PORT: String(runtime.port),
      BLENDER_HOST: "127.0.0.1",
      BLENDER_PORT: String(runtime.port),
    },
  });
  return { capabilityRuntime, instanceToken: claimed.instanceToken };
}

function nestedMcpError(result) {
  const call = result?.result;
  if (call?.isError === true) {
    const text = Array.isArray(call.content)
      ? call.content.map((item) => clean(item?.text)).filter(Boolean).join("\n")
      : "";
    return text || "The Blender MCP tool returned isError=true.";
  }
  return null;
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const runtimeKey = clean(flags["runtime-key"]);
  const runtimeId = clean(flags["runtime-id"]);
  if (!runtimeKey) fail("--runtime-key is required.");

  const files = loadDevspaceFiles();
  const stateDir = clean(files.config?.stableGatewayStateDir || files.config?.stateDir);
  if (!stateDir) fail("DevSpace state directory is unavailable.");
  const authorityState = await readJson(join(stateDir, "classic-conversation-authority.json"));
  const conversationId = resolveConversationId(authorityState, runtimeKey);

  if (command === "progress") {
    const message = flags["message-file"]
      ? await readFile(clean(flags["message-file"]), "utf8")
      : clean(flags.message);
    const cleanMessage = stripBom(message).trim();
    if (!cleanMessage) fail("progress requires --message or --message-file.");
    const progress = await createStableGatewayHumanProgress({
      statePath: join(stateDir, "devspace-live-progress.json"),
    });
    const now = Date.now();
    const result = await progress.update({
      conversationId,
      message: cleanMessage,
      source: "agent-progress-tool",
      kind: clean(flags.kind) || "progress",
      dedupeKey: `${conversationId}:${runtimeKey}:${now}:${cleanMessage.slice(0, 96)}`,
    });
    console.log(JSON.stringify({
      ok: true,
      action: "progress",
      runtimeKey,
      conversationId,
      message: cleanMessage,
      messageCount: Array.isArray(result?.messages) ? result.messages.filter((row) => row?.conversationId === conversationId).length : null,
      updatedAt: result?.updatedAt || null,
    }));
    return;
  }

  if (!runtimeId) fail(`${command} requires --runtime-id.`);
  const runtimeState = await readJson(join(stateDir, "blender-runtimes.json"));
  const runtime = resolveRuntime(runtimeState, runtimeId);
  if (clean(runtime.ownerConversationId) !== conversationId) {
    fail(`Blender runtime ${runtimeId} belongs to a different ChatGPT conversation.`);
  }
  const online = await portOnline(runtime.port);
  const alive = processAlive(runtime.processId);

  if (command === "status") {
    console.log(JSON.stringify({
      ok: online && alive,
      action: "status",
      runtimeKey,
      conversationId,
      runtime: publicRuntime(runtime, online),
    }));
    if (!online || !alive) process.exitCode = 2;
    return;
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
      return;
    }

    if (command !== "call") fail(`Unsupported command: ${command}`);
    const toolName = clean(flags.tool);
    if (!toolName) fail("call requires --tool.");
    if (!tools.some((tool) => tool?.name === toolName)) {
      fail(`Blender MCP tool ${toolName} is not present in the live ${tools.length}-tool catalog.`);
    }
    let toolArguments = {};
    if (flags["args-file"]) toolArguments = await readJson(clean(flags["args-file"]));
    else if (flags["args-json"]) toolArguments = JSON.parse(clean(flags["args-json"]));
    const result = await connection.capabilityRuntime.call({
      pluginId: "blender-local",
      kind: "mcp",
      serverId: "blender",
      toolName,
      arguments: toolArguments,
      instanceToken: connection.instanceToken,
    }, { ownerConversationId: conversationId });
    const error = nestedMcpError(result);
    if (error) fail(error);
    console.log(JSON.stringify({
      ok: true,
      action: "call",
      runtimeKey,
      conversationId,
      runtime: publicRuntime(runtime, true),
      toolName,
      result,
    }));
  } finally {
    await connection.capabilityRuntime.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
