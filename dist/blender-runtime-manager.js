import { createHash, randomUUID } from "node:crypto";
import { createConnection, createServer as createNetServer } from "node:net";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { atomicWriteJson } from "./atomic-file.js";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LOOPBACK = "127.0.0.1";
const DEFAULT_PORT_START = 9876;
const DEFAULT_PORT_END = 9976;

function clean(value, max = 1000) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function normalizeRuntimeId(value) {
  const text = clean(value, 120) || `blender-${randomUUID().slice(0, 8)}`;
  if (!/^[A-Za-z0-9._-]+$/.test(text)) throw new Error("runtimeId may contain only letters, numbers, dot, underscore, and hyphen.");
  return text;
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Blender runtime port must be an integer from 1024 to 65535.");
  return port;
}

function processAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function portAccepting(port, host = LOOPBACK) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
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

async function waitForPort({ port, pid = null, signal = null }) {
  while (true) {
    if (signal?.aborted) throw new Error("Blender runtime startup was cancelled.");
    if (await portAccepting(port)) return true;
    if (pid && !processAlive(pid)) throw new Error(`Blender process ${pid} exited before MCP port ${port} became ready.`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
}

async function reserveFreePort(start = DEFAULT_PORT_START, end = DEFAULT_PORT_END, excluded = new Set()) {
  for (let port = start; port <= end; port += 1) {
    if (excluded.has(port) || await portAccepting(port)) continue;
    const available = await new Promise((resolvePromise) => {
      const server = createNetServer();
      server.once("error", () => resolvePromise(false));
      server.listen(port, LOOPBACK, () => server.close(() => resolvePromise(true)));
    });
    if (available) return port;
  }
  throw new Error(`No free loopback port was found between ${start} and ${end}.`);
}

async function discoverWindowsBlenderExecutable() {
  if (process.platform !== "win32") return null;
  try {
    const result = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "$p=Get-CimInstance Win32_Process -Filter \"Name='blender.exe'\" | Select-Object -First 1 -ExpandProperty ExecutablePath; if($p){[Console]::Write($p)}",
    ], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const path = clean(result.stdout, 4000);
    if (path && existsSync(path)) return path;
  } catch {}
  try {
    const result = await execFileAsync("where.exe", ["blender.exe"], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const path = clean(String(result.stdout || "").split(/\r?\n/)[0], 4000);
    if (path && existsSync(path)) return path;
  } catch {}
  return null;
}

async function discoverBlenderProcesses() {
  if (process.platform !== "win32") return [];
  try {
    const processScript = [
      "$rows=Get-CimInstance Win32_Process -Filter \"Name='blender.exe'\" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine",
      "$rows | ConvertTo-Json -Depth 3 -Compress",
    ].join("; ");
    const [processResult, netstatResult] = await Promise.all([
      execFileAsync("powershell.exe", ["-NoProfile", "-Command", processScript], {
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      }),
      execFileAsync("netstat.exe", ["-ano", "-p", "tcp"], {
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      }),
    ]);
    const raw = String(processResult.stdout || "").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const portsByPid = new Map();
    for (const line of String(netstatResult.stdout || "").split(/\r?\n/)) {
      const match = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (!match) continue;
      const address = match[1].replace(/^\[|\]$/g, "").toLowerCase();
      if (!["127.0.0.1", "0.0.0.0", "::1", "::"].includes(address)) continue;
      const port = Number(match[2]);
      const pid = Number(match[3]);
      if (!Number.isInteger(port) || !Number.isInteger(pid)) continue;
      const ports = portsByPid.get(pid) || new Set();
      ports.add(port);
      portsByPid.set(pid, ports);
    }
    return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => {
      const processId = Number(row.ProcessId ?? row.processId);
      return {
        processId,
        parentProcessId: Number(row.ParentProcessId ?? row.parentProcessId) || null,
        executable: clean(row.ExecutablePath ?? row.executable, 4000),
        commandLine: clean(row.CommandLine ?? row.commandLine, 8000),
        ports: [...(portsByPid.get(processId) || [])].sort((a, b) => a - b),
      };
    });
  } catch {
    return [];
  }
}

async function discoverBlenderExecutable(explicit) {
  const candidates = [explicit, process.env.BLENDER_EXECUTABLE].map((value) => clean(value, 4000)).filter(Boolean);
  for (const candidate of candidates) {
    const absolute = resolve(candidate);
    if (existsSync(absolute)) return absolute;
  }
  const windows = await discoverWindowsBlenderExecutable();
  if (windows) return windows;
  throw new Error("Blender executable was not found. Start Blender once, set BLENDER_EXECUTABLE, or pass executable explicitly.");
}

function publicRuntime(runtime) {
  return {
    runtimeId: runtime.runtimeId,
    ownerConversationId: runtime.ownerConversationId,
    ownerLabel: runtime.ownerLabel,
    state: runtime.state,
    host: LOOPBACK,
    port: runtime.port,
    processId: runtime.processId,
    processAlive: processAlive(runtime.processId),
    portOnline: runtime.portOnline === true,
    managedProcess: runtime.managedProcess === true,
    defaultForOwner: runtime.defaultForOwner === true,
    blendFile: runtime.blendFile || null,
    executable: runtime.executable || null,
    createdAt: runtime.createdAt,
    connectedAt: runtime.connectedAt || null,
    lastError: runtime.lastError || null,
  };
}

function normalizeObservedBlendFile(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || !isAbsolute(text) || !text.toLowerCase().endsWith(".blend")) return null;
  return resolve(text);
}

function observedBlendFile(value, seen = new Set(), depth = 0) {
  if (depth > 12 || value == null) return null;
  if (typeof value === "string") {
    const direct = normalizeObservedBlendFile(value);
    if (direct) return direct;
    const text = value.trim();
    if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
      try { return observedBlendFile(JSON.parse(text), seen, depth + 1); } catch {}
    }
    return null;
  }
  if (typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = observedBlendFile(item, seen, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const key of ["filepath", "blendFile", "blend_file"]) {
    const found = observedBlendFile(value[key], seen, depth + 1);
    if (found) return found;
  }
  for (const [key, item] of Object.entries(value)) {
    if (["filepath", "blendFile", "blend_file", "backups"].includes(key)) continue;
    const found = observedBlendFile(item, seen, depth + 1);
    if (found) return found;
  }
  return null;
}

export class BlenderRuntimeManager {
  constructor({ stateDir, capabilityRuntime, bootstrapScript, defaultPort = DEFAULT_PORT_START } = {}) {
    if (!stateDir) throw new Error("stateDir is required.");
    if (!capabilityRuntime) throw new Error("capabilityRuntime is required.");
    this.statePath = join(stateDir, "blender-runtimes.json");
    this.logDir = join(stateDir, "blender-runtime-logs");
    this.bootstrapScript = resolve(bootstrapScript || fileURLToPath(new URL("../scripts/blender-runtime-bootstrap.py", import.meta.url)));
    this.defaultPort = normalizePort(defaultPort);
    this.capabilityRuntime = capabilityRuntime;
    this.runtimes = new Map();
    this.persistQueue = Promise.resolve();
    this.ready = this.load();
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8"));
      for (const source of Array.isArray(parsed?.runtimes) ? parsed.runtimes : []) {
        const runtimeId = normalizeRuntimeId(source.runtimeId);
        const port = normalizePort(source.port);
        const runtime = {
          runtimeId,
          ownerConversationId: clean(source.ownerConversationId, 200),
          ownerLabel: clean(source.ownerLabel, 120) || "agent",
          port,
          processId: Number.isInteger(Number(source.processId)) ? Number(source.processId) : null,
          managedProcess: source.managedProcess === true,
          defaultForOwner: source.defaultForOwner === true,
          blendFile: clean(source.blendFile, 4000),
          executable: clean(source.executable, 4000),
          createdAt: clean(source.createdAt, 80) || new Date().toISOString(),
          connectedAt: clean(source.connectedAt, 80),
          state: "disconnected",
          portOnline: false,
          lastError: null,
          instanceToken: null,
        };
        runtime.portOnline = await portAccepting(port);
        runtime.state = runtime.portOnline ? "online" : processAlive(runtime.processId) ? "starting" : "offline";
        this.runtimes.set(runtimeId, runtime);
      }
    } catch {}
    await this.persist();
    return [...this.runtimes.values()].map(publicRuntime);
  }

  async persist() {
    const payload = {
      version: 2,
      updatedAt: new Date().toISOString(),
      runtimes: [...this.runtimes.values()].map((runtime) => ({
        runtimeId: runtime.runtimeId,
        ownerConversationId: runtime.ownerConversationId,
        ownerLabel: runtime.ownerLabel,
        port: runtime.port,
        processId: runtime.processId,
        managedProcess: runtime.managedProcess,
        defaultForOwner: runtime.defaultForOwner === true,
        blendFile: runtime.blendFile,
        executable: runtime.executable,
        createdAt: runtime.createdAt,
        connectedAt: runtime.connectedAt,
      })),
    };
    this.persistQueue = this.persistQueue.then(() => atomicWriteJson(this.statePath, payload));
    return await this.persistQueue;
  }

  assertOwner(runtime, ownerConversationId) {
    const owner = clean(ownerConversationId, 200);
    if (!owner) throw new Error("A ChatGPT conversation identity is required for Blender runtime ownership.");
    if (runtime.ownerConversationId && runtime.ownerConversationId !== owner) {
      throw new Error(`Blender runtime ${runtime.runtimeId} belongs to another ChatGPT conversation.`);
    }
    return owner;
  }

  ownedRuntimes(ownerConversationId) {
    const owner = clean(ownerConversationId, 200);
    if (!owner) throw new Error("A ChatGPT conversation identity is required for Blender runtime ownership.");
    return [...this.runtimes.values()].filter((runtime) => runtime.ownerConversationId === owner);
  }

  selectDefaultRuntime(ownerConversationId) {
    const owned = this.ownedRuntimes(ownerConversationId);
    const explicit = owned.filter((runtime) => runtime.defaultForOwner === true);
    if (explicit.length === 1) return explicit[0];
    if (explicit.length > 1) {
      throw new Error("Multiple Blender runtimes are marked as the default for this conversation; pass runtimeId explicitly.");
    }
    if (owned.length === 1) return owned[0];
    if (!owned.length) {
      throw new Error("This conversation has no assigned Blender runtime. Start or attach one before using Blender MCP.");
    }
    throw new Error("This conversation owns multiple Blender runtimes; pass runtimeId explicitly.");
  }

  async ensureInstance(runtime) {
    if (runtime.instanceToken) return runtime.instanceToken;
    const claimed = await this.capabilityRuntime.claimInstance({
      pluginId: "blender-local",
      serverId: "blender",
      instanceId: runtime.runtimeId,
      runtimeId: runtime.runtimeId,
      ownerLabel: runtime.ownerLabel,
      ownerConversationId: runtime.ownerConversationId,
      env: {
        BLENDER_MCP_HOST: LOOPBACK,
        BLENDER_MCP_PORT: String(runtime.port),
        // Keep the legacy aliases for older/community Blender MCP servers.
        BLENDER_HOST: LOOPBACK,
        BLENDER_PORT: String(runtime.port),
      },
      processId: runtime.processId,
      port: runtime.port,
      metadata: {
        blendFile: runtime.blendFile,
        managedProcess: runtime.managedProcess,
      },
    });
    runtime.instanceToken = claimed.instanceToken;
    try {
      const instance = this.capabilityRuntime.findInstanceByToken(runtime.instanceToken);
      await this.capabilityRuntime.connectionManager.adoptLegacySharedConnection({
        pluginId: "blender-local",
        serverId: "blender",
        instance,
      });
      await this.capabilityRuntime.getMcpClient(
        "blender-local",
        "blender",
        runtime.instanceToken,
        runtime.ownerConversationId,
      );
      runtime.state = "online";
      runtime.connectedAt ||= new Date().toISOString();
      runtime.lastError = null;
      return runtime.instanceToken;
    } catch (error) {
      await this.capabilityRuntime.releaseInstance(runtime.instanceToken, runtime.ownerConversationId).catch(() => {});
      runtime.instanceToken = null;
      runtime.state = "failed";
      runtime.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async discover(ownerConversationId = null) {
    await this.ready;
    const owner = clean(ownerConversationId, 200);
    const managedByPort = new Map([...this.runtimes.values()].map((runtime) => [runtime.port, runtime]));
    const processes = await discoverBlenderProcesses();
    return processes.map((processInfo) => ({
      ...processInfo,
      ports: processInfo.ports.map((port) => ({
        port,
        accepting: true,
        runtimeId: managedByPort.get(port)?.runtimeId || null,
        ownerConversationId: managedByPort.get(port)?.ownerConversationId || null,
        ownedByCurrentConversation: Boolean(owner && managedByPort.get(port)?.ownerConversationId === owner),
      })),
    }));
  }

  async resolveOrAdoptExisting({ ownerConversationId, ownerLabel = "agent" } = {}) {
    await this.ready;
    const owner = clean(ownerConversationId, 200);
    if (!owner) throw new Error("ownerConversationId is required.");

    const owned = [];
    for (const runtime of this.runtimes.values()) {
      if (runtime.ownerConversationId !== owner) continue;
      runtime.portOnline = await portAccepting(runtime.port);
      runtime.state = runtime.portOnline ? "online" : processAlive(runtime.processId) ? "starting" : "offline";
      if (runtime.portOnline) owned.push(runtime);
    }
    if (owned.length === 1) {
      await this.ensureInstance(owned[0]);
      await this.persist();
      return {
        ok: true,
        adopted: false,
        runtime: publicRuntime(owned[0]),
        instanceToken: owned[0].instanceToken,
      };
    }
    if (owned.length > 1) {
      throw new Error("This conversation already owns more than one online Blender runtime; pass runtimeId explicitly so DevSpace never guesses between projects.");
    }

    const claimedPorts = new Map([...this.runtimes.values()].map((runtime) => [runtime.port, runtime]));
    const processes = await discoverBlenderProcesses();
    const candidates = [];
    for (const processInfo of processes) {
      for (const port of processInfo.ports) {
        if (port < DEFAULT_PORT_START || port > DEFAULT_PORT_END) continue;
        const claimed = claimedPorts.get(port);
        if (claimed) continue;
        candidates.push({
          port,
          processId: processInfo.processId,
          executable: processInfo.executable,
          commandLine: processInfo.commandLine,
        });
      }
    }

    if (!candidates.some((candidate) => candidate.port === DEFAULT_PORT_START)
        && !claimedPorts.has(DEFAULT_PORT_START)
        && await portAccepting(DEFAULT_PORT_START)) {
      candidates.push({ port: DEFAULT_PORT_START, processId: null, executable: null, commandLine: null });
    }

    const uniqueByPort = [...new Map(candidates.map((candidate) => [candidate.port, candidate])).values()]
      .sort((a, b) => a.port - b.port);
    const preferred = uniqueByPort.find((candidate) => candidate.port === DEFAULT_PORT_START);
    const selected = preferred || (uniqueByPort.length === 1 ? uniqueByPort[0] : null);
    if (!selected) {
      if (uniqueByPort.length > 1) {
        throw new Error(`More than one unclaimed Blender MCP runtime is online (${uniqueByPort.map((item) => item.port).join(", ")}); pass runtimeId or use blender_runtime(action=attach) so DevSpace never steals another Agent's work.`);
      }
      throw new Error("No unclaimed existing Blender MCP runtime is online. Start or attach a conversation-owned runtime before calling Blender.");
    }

    const runtimeId = `adopted-${selected.processId || "external"}-${selected.port}`;
    const attached = await this.attach({
      runtimeId,
      ownerConversationId: owner,
      ownerLabel,
      port: selected.port,
      processId: selected.processId,
    });
    const runtime = this.runtimes.get(runtimeId);
    if (runtime && selected.executable) runtime.executable = selected.executable;
    await this.persist();
    return {
      ...attached,
      adopted: true,
      preservedExistingProcess: true,
    };
  }

  async attach({ runtimeId, ownerConversationId, ownerLabel = "agent", port, processId = null, blendFile = null, defaultForOwner = null } = {}) {
    await this.ready;
    const id = normalizeRuntimeId(runtimeId);
    const owner = clean(ownerConversationId, 200);
    if (!owner) throw new Error("ownerConversationId is required.");
    if (this.runtimes.has(id)) {
      const existing = this.runtimes.get(id);
      this.assertOwner(existing, owner);
      return await this.status(id, owner);
    }
    const normalizedPort = normalizePort(port);
    const portOwner = [...this.runtimes.values()].find((runtime) => runtime.port === normalizedPort);
    if (portOwner) {
      if (portOwner.ownerConversationId !== owner) {
        throw new Error(`Blender MCP port ${normalizedPort} belongs to another conversation runtime.`);
      }
      return await this.status(portOwner.runtimeId, owner);
    }
    if (!(await portAccepting(normalizedPort))) throw new Error(`No Blender MCP endpoint is accepting connections on ${LOOPBACK}:${normalizedPort}.`);
    const ownerHasRuntime = this.ownedRuntimes(owner).length > 0;
    const runtime = {
      runtimeId: id,
      ownerConversationId: owner,
      ownerLabel: clean(ownerLabel, 120) || "agent",
      port: normalizedPort,
      processId: Number.isInteger(Number(processId)) ? Number(processId) : null,
      managedProcess: false,
      defaultForOwner: defaultForOwner == null ? !ownerHasRuntime : defaultForOwner === true,
      blendFile: clean(blendFile, 4000),
      executable: null,
      createdAt: new Date().toISOString(),
      connectedAt: new Date().toISOString(),
      state: "online",
      portOnline: true,
      lastError: null,
      instanceToken: null,
    };
    this.runtimes.set(id, runtime);
    try {
      await this.ensureInstance(runtime);
      await this.persist();
      return { ok: true, runtime: publicRuntime(runtime), instanceToken: runtime.instanceToken };
    } catch (error) {
      this.runtimes.delete(id);
      throw error;
    }
  }

  async adoptExisting(options = {}) {
    return await this.attach({ ...options, defaultForOwner: options.defaultForOwner !== false });
  }

  async adoptDefaultEndpoint({
    ownerConversationId,
    ownerLabel = "agent",
    port = this.defaultPort,
  } = {}) {
    await this.ready;
    const owner = clean(ownerConversationId, 200);
    if (!owner) throw new Error("ownerConversationId is required.");
    const owned = this.ownedRuntimes(owner);
    if (owned.length) return await this.defaultRuntime(owner);
    const normalizedPort = normalizePort(port);
    const existing = [...this.runtimes.values()].find((runtime) => runtime.port === normalizedPort);
    if (existing) {
      if (existing.ownerConversationId !== owner) {
        throw new Error(`The default Blender MCP endpoint on ${LOOPBACK}:${normalizedPort} is already assigned to another conversation.`);
      }
      return await this.status(existing.runtimeId, owner);
    }
    if (!(await portAccepting(normalizedPort))) {
      throw new Error(`This conversation has no assigned Blender runtime and no user-opened Blender MCP endpoint is accepting connections on ${LOOPBACK}:${normalizedPort}. Start or attach a runtime before using Blender MCP.`);
    }
    const suffix = createHash("sha256").update(owner).digest("hex").slice(0, 12);
    return await this.adoptExisting({
      runtimeId: `adopted-default-${suffix}`,
      ownerConversationId: owner,
      ownerLabel,
      port: normalizedPort,
      defaultForOwner: true,
    });
  }

  async start({ runtimeId, ownerConversationId, ownerLabel = "agent", executable, blendFile = null, port = null, signal = null, defaultForOwner = null } = {}) {
    await this.ready;
    const id = normalizeRuntimeId(runtimeId);
    const owner = clean(ownerConversationId, 200);
    if (!owner) throw new Error("ownerConversationId is required.");
    if (this.runtimes.has(id)) {
      const existing = this.runtimes.get(id);
      this.assertOwner(existing, owner);
      return await this.status(id, owner);
    }
    const usedPorts = new Set([...this.runtimes.values()].map((runtime) => runtime.port));
    const selectedPort = port == null ? await reserveFreePort(DEFAULT_PORT_START, DEFAULT_PORT_END, usedPorts) : normalizePort(port);
    if (usedPorts.has(selectedPort) || await portAccepting(selectedPort)) throw new Error(`Port ${selectedPort} is already in use.`);
    const blenderExecutable = await discoverBlenderExecutable(executable);
    const normalizedBlendFile = blendFile ? resolve(String(blendFile)) : null;
    const ownerHasRuntime = this.ownedRuntimes(owner).length > 0;
    if (normalizedBlendFile && !existsSync(normalizedBlendFile)) {
      throw new Error(`Blend file does not exist: ${blendFile}`);
    }
    if (!existsSync(this.bootstrapScript)) throw new Error(`Blender runtime bootstrap script is missing: ${this.bootstrapScript}`);
    await mkdir(this.logDir, { recursive: true });
    const stdoutPath = join(this.logDir, `${id}.out.log`);
    const stderrPath = join(this.logDir, `${id}.err.log`);
    const stdout = openSync(stdoutPath, "a");
    const stderr = openSync(stderrPath, "a");
    const args = [
      ...(normalizedBlendFile ? [normalizedBlendFile] : []),
      "--python",
      this.bootstrapScript,
    ];
    let child;
    try {
      child = spawn(blenderExecutable, args, {
        detached: true,
        windowsHide: false,
        stdio: ["ignore", stdout, stderr],
        env: {
          ...process.env,
          DEVSPACE_BLENDER_HOST: LOOPBACK,
          DEVSPACE_BLENDER_PORT: String(selectedPort),
          DEVSPACE_BLENDER_RUNTIME_ID: id,
        },
      });
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
    child.unref();
    const runtime = {
      runtimeId: id,
      ownerConversationId: owner,
      ownerLabel: clean(ownerLabel, 120) || "agent",
      port: selectedPort,
      processId: child.pid,
      managedProcess: true,
      defaultForOwner: defaultForOwner == null ? !ownerHasRuntime : defaultForOwner === true,
      blendFile: normalizedBlendFile,
      executable: blenderExecutable,
      createdAt: new Date().toISOString(),
      connectedAt: null,
      state: "starting",
      portOnline: false,
      lastError: null,
      instanceToken: null,
    };
    this.runtimes.set(id, runtime);
    await this.persist();
    try {
      await waitForPort({ port: selectedPort, pid: child.pid, signal });
      runtime.portOnline = true;
      runtime.state = "online";
      runtime.connectedAt = new Date().toISOString();
      await this.ensureInstance(runtime);
      await this.persist();
      return { ok: true, runtime: publicRuntime(runtime), instanceToken: runtime.instanceToken };
    } catch (error) {
      runtime.state = "failed";
      runtime.lastError = error instanceof Error ? error.message : String(error);
      await this.persist();
      throw error;
    }
  }

  async observeMcpResult(runtimeId, ownerConversationId, value) {
    await this.ready;
    const runtime = this.runtimes.get(normalizeRuntimeId(runtimeId));
    if (!runtime) throw new Error(`Unknown Blender runtime: ${runtimeId}`);
    this.assertOwner(runtime, ownerConversationId);
    const blendFile = observedBlendFile(value);
    if (!blendFile) {
      return { ok: true, runtimeId: runtime.runtimeId, updated: false, blendFile: runtime.blendFile || null };
    }
    const previousBlendFile = runtime.blendFile || null;
    if (previousBlendFile === blendFile) {
      return { ok: true, runtimeId: runtime.runtimeId, updated: false, blendFile };
    }
    runtime.blendFile = blendFile;
    await this.persist();
    return { ok: true, runtimeId: runtime.runtimeId, updated: true, previousBlendFile, blendFile };
  }

  async refreshLiveBlendFile(runtime) {
    if (!runtime?.instanceToken || typeof this.capabilityRuntime.call !== "function") return null;
    const response = await this.capabilityRuntime.call({
      pluginId: "blender-local",
      kind: "mcp",
      serverId: "blender",
      toolName: "get_blendfile_summary_path_info",
      arguments: {},
      instanceToken: runtime.instanceToken,
    }, { ownerConversationId: runtime.ownerConversationId });
    return await this.observeMcpResult(runtime.runtimeId, runtime.ownerConversationId, response);
  }

  async access(runtimeId, ownerConversationId) {
    await this.ready;
    const runtime = this.runtimes.get(normalizeRuntimeId(runtimeId));
    if (!runtime) throw new Error(`Unknown Blender runtime: ${runtimeId}`);
    this.assertOwner(runtime, ownerConversationId);
    runtime.portOnline = await portAccepting(runtime.port);
    runtime.state = runtime.portOnline ? "online" : processAlive(runtime.processId) ? "starting" : "offline";
    if (!runtime.portOnline) throw new Error(`Blender runtime ${runtime.runtimeId} is not accepting MCP connections on ${LOOPBACK}:${runtime.port}.`);
    await this.ensureInstance(runtime);
    return { runtime, instanceToken: runtime.instanceToken };
  }

  async instanceToken(runtimeId, ownerConversationId) {
    const access = await this.access(runtimeId, ownerConversationId);
    return access.instanceToken;
  }

  async defaultInstanceToken(ownerConversationId) {
    let runtime;
    try {
      runtime = this.selectDefaultRuntime(ownerConversationId);
    } catch (error) {
      if (!/no assigned Blender runtime/i.test(error instanceof Error ? error.message : String(error))) throw error;
      await this.adoptDefaultEndpoint({ ownerConversationId, ownerLabel: "adopted user-opened Blender", port: this.defaultPort });
      runtime = this.selectDefaultRuntime(ownerConversationId);
    }
    const access = await this.access(runtime.runtimeId, ownerConversationId);
    return access.instanceToken;
  }

  async defaultRuntime(ownerConversationId) {
    const runtime = this.selectDefaultRuntime(ownerConversationId);
    return await this.status(runtime.runtimeId, ownerConversationId);
  }

  async status(runtimeId, ownerConversationId) {
    await this.ready;
    const runtime = this.runtimes.get(normalizeRuntimeId(runtimeId));
    if (!runtime) throw new Error(`Unknown Blender runtime: ${runtimeId}`);
    this.assertOwner(runtime, ownerConversationId);
    runtime.portOnline = await portAccepting(runtime.port);
    runtime.state = runtime.portOnline ? "online" : processAlive(runtime.processId) ? "starting" : "offline";
    if (runtime.portOnline) {
      await this.ensureInstance(runtime);
      await this.refreshLiveBlendFile(runtime).catch(() => null);
    }
    await this.persist();
    return { ok: true, runtime: publicRuntime(runtime), instanceToken: runtime.instanceToken };
  }

  async list(ownerConversationId = null) {
    await this.ready;
    const owner = clean(ownerConversationId, 200);
    const rows = [];
    for (const runtime of this.runtimes.values()) {
      if (owner && runtime.ownerConversationId !== owner) continue;
      runtime.portOnline = await portAccepting(runtime.port);
      runtime.state = runtime.portOnline ? "online" : processAlive(runtime.processId) ? "starting" : "offline";
      rows.push(publicRuntime(runtime));
    }
    return rows.sort((a, b) => a.runtimeId.localeCompare(b.runtimeId));
  }

  async stop({ runtimeId, ownerConversationId, terminateProcess = false } = {}) {
    await this.ready;
    const id = normalizeRuntimeId(runtimeId);
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error(`Unknown Blender runtime: ${id}`);
    this.assertOwner(runtime, ownerConversationId);
    if (runtime.instanceToken) {
      await this.capabilityRuntime.releaseInstance(runtime.instanceToken, runtime.ownerConversationId).catch(() => {});
      runtime.instanceToken = null;
    }
    if (terminateProcess && runtime.processId && processAlive(runtime.processId)) {
      try { process.kill(runtime.processId, "SIGTERM"); } catch {}
      while (processAlive(runtime.processId)) await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    this.runtimes.delete(id);
    await this.persist();
    return {
      ok: true,
      runtimeId: id,
      released: true,
      processTerminated: Boolean(terminateProcess && runtime.processId),
    };
  }

  diagnostics() {
    const runtimes = [...this.runtimes.values()];
    return {
      runtimes: runtimes.length,
      online: runtimes.filter((runtime) => runtime.state === "online").length,
      managedProcesses: runtimes.filter((runtime) => runtime.managedProcess).length,
      defaultRuntimes: runtimes.filter((runtime) => runtime.defaultForOwner).length,
      ports: runtimes.map((runtime) => runtime.port),
    };
  }

  async close() {
    await this.ready;
    for (const runtime of this.runtimes.values()) {
      if (runtime.instanceToken) {
        await this.capabilityRuntime.releaseInstance(
          runtime.instanceToken,
          runtime.ownerConversationId,
        ).catch(() => {});
        runtime.instanceToken = null;
      }
      runtime.state = "disconnected";
      runtime.portOnline = false;
    }
    await this.persist();
  }
}
