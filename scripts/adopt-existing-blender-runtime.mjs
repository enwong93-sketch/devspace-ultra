#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, normalize, resolve } from "node:path";
import { atomicWriteJson } from "../dist/atomic-file.js";
import { loadDevspaceFiles } from "../dist/user-config.js";

const execFileAsync = promisify(execFile);

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : fallback;
}

function requireText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function safeRuntimeId(value) {
  const text = requireText(value, "runtime-id");
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(text)) throw new Error("runtime-id may contain only letters, numbers, dot, underscore, and hyphen.");
  return text;
}

function samePath(left, right) {
  return normalize(resolve(left)).toLowerCase() === normalize(resolve(right)).toLowerCase();
}

async function portAccepting(port) {
  return await new Promise((resolvePromise) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolvePromise(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function windowsProcess(pid) {
  if (process.platform !== "win32") throw new Error("Existing Blender runtime adoption currently requires Windows process ownership evidence.");
  const script = [
    `$p=Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\"`,
    "if(-not $p){exit 3}",
    "$p | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
  ].join("; ");
  const result = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(String(result.stdout || "{}").trim());
}

async function listenerOwner(port) {
  const script = [
    `$p=Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1`,
    "if(-not $p){exit 4}",
    "$p | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress",
  ].join("; ");
  const result = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(String(result.stdout || "{}").trim());
}

const bindingPath = resolve(requireText(argument("binding"), "binding"));
const conversationId = requireText(argument("conversation-id"), "conversation-id");
const runtimeId = safeRuntimeId(argument("runtime-id"));
const ownerLabel = String(argument("owner-label", "adopted Blender agent") || "adopted Blender agent").slice(0, 120);
const files = loadDevspaceFiles();
const stateDir = resolve(argument("state-dir", files.config?.stateDir || files.config?.stableGatewayStateDir));
const authorityPath = join(stateDir, "classic-conversation-authority.json");
const runtimesPath = join(stateDir, "blender-runtimes.json");

assert.ok(existsSync(bindingPath), `Binding evidence does not exist: ${bindingPath}`);
const binding = JSON.parse((await readFile(bindingPath, "utf8")).replace(/^\uFEFF/, ""));
const pid = Number(binding.pid);
const port = Number(binding.port);
const blendFile = resolve(requireText(binding.file, "binding.file"));
if (!Number.isInteger(pid) || pid <= 0) throw new Error("Binding evidence has an invalid Blender PID.");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Binding evidence has an invalid MCP port.");
if (!new Set(["127.0.0.1", "localhost", "::1"]).has(String(binding.host || "").toLowerCase())) {
  throw new Error("Only a loopback Blender MCP endpoint may be adopted.");
}
if (!existsSync(blendFile)) throw new Error(`Bound Blender file does not exist: ${blendFile}`);
if (!(await portAccepting(port))) throw new Error(`Blender MCP endpoint is not accepting connections on 127.0.0.1:${port}.`);

const authority = JSON.parse((await readFile(authorityPath, "utf8")).replace(/^\uFEFF/, ""));
const authorityMatches = (authority.sessions || []).filter((entry) =>
  entry?.ambiguous !== true && Array.isArray(entry?.conversationIds) && entry.conversationIds.includes(conversationId));
if (authorityMatches.length !== 1) {
  throw new Error(`Conversation ${conversationId} must have exactly one unambiguous native authority entry; observed ${authorityMatches.length}.`);
}
const runtimeKeys = Array.isArray(authorityMatches[0].runtimeKeys) ? authorityMatches[0].runtimeKeys : [];
if (runtimeKeys.length !== 1) throw new Error(`Conversation ${conversationId} must map to exactly one ChatGPT runtime before Blender adoption.`);

const processInfo = await windowsProcess(pid);
if (String(processInfo.Name || "").toLowerCase() !== "blender.exe") throw new Error(`PID ${pid} is not blender.exe.`);
const commandLine = String(processInfo.CommandLine || "");
if (!commandLine.toLowerCase().includes(basename(blendFile).toLowerCase())) {
  throw new Error(`PID ${pid} command line does not identify the expected blend file ${basename(blendFile)}.`);
}
const listener = await listenerOwner(port);
if (Number(listener.OwningProcess) !== pid) {
  throw new Error(`Port ${port} belongs to PID ${listener.OwningProcess}, not the verified Blender PID ${pid}.`);
}
if (!new Set(["127.0.0.1", "::1"]).has(String(listener.LocalAddress || ""))) {
  throw new Error(`Port ${port} is not bound strictly to loopback.`);
}

let state = { version: 2, runtimes: [] };
try { state = JSON.parse((await readFile(runtimesPath, "utf8")).replace(/^\uFEFF/, "")); } catch {}
const runtimes = Array.isArray(state.runtimes) ? state.runtimes : [];
for (const row of runtimes) {
  if (row.runtimeId === runtimeId && row.ownerConversationId !== conversationId) {
    throw new Error(`Runtime id ${runtimeId} already belongs to another conversation.`);
  }
  if ((Number(row.port) === port || Number(row.processId) === pid) && row.ownerConversationId !== conversationId) {
    throw new Error(`The existing Blender process/port is already assigned to another conversation.`);
  }
}
const now = new Date().toISOString();
const retained = runtimes.filter((row) => row.runtimeId !== runtimeId && Number(row.port) !== port && Number(row.processId) !== pid);
for (const row of retained) {
  if (row.ownerConversationId === conversationId) row.defaultForOwner = false;
}
retained.push({
  runtimeId,
  ownerConversationId: conversationId,
  ownerLabel,
  port,
  processId: pid,
  managedProcess: false,
  defaultForOwner: true,
  blendFile,
  executable: processInfo.ExecutablePath || null,
  createdAt: now,
  connectedAt: now,
  adoptedFromBinding: bindingPath,
  authorityRuntimeKey: runtimeKeys[0],
});
await atomicWriteJson(runtimesPath, {
  version: 2,
  updatedAt: now,
  runtimes: retained,
});

console.log(JSON.stringify({
  ok: true,
  state: "existing-blender-runtime-adopted",
  runtimeId,
  ownerConversationId: conversationId,
  ownerRuntimeKey: runtimeKeys[0],
  processId: pid,
  port,
  blendFile,
  managedProcess: false,
  processRestarted: false,
  endpointRestarted: false,
  previousWorkPreserved: true,
  secretValuesLogged: false,
}));
