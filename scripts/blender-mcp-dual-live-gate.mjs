import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CapabilityRuntime } from "../dist/capability-runtime.js";
import { BlenderRuntimeManager } from "../dist/blender-runtime-manager.js";

const OFFICIAL_SOURCE = "git+https://projects.blender.org/lab/blender_mcp.git@v1.0.0#subdirectory=mcp";
const EXPECTED_TOOLS = [
  "execute_blender_code",
  "execute_blender_code_for_cli",
  "get_blendfile_summary_datablocks",
  "get_blendfile_summary_datablocks_for_cli",
  "get_blendfile_summary_missing_files",
  "get_blendfile_summary_missing_files_for_cli",
  "get_blendfile_summary_of_linked_libraries",
  "get_blendfile_summary_of_linked_libraries_for_cli",
  "get_blendfile_summary_path_info",
  "get_blendfile_summary_path_info_for_cli",
  "get_blendfile_summary_usage_guess",
  "get_blendfile_summary_usage_guess_for_cli",
  "get_object_detail_summary",
  "get_objects_summary",
  "get_python_api_docs",
  "get_screenshot_of_area_as_image",
  "get_screenshot_of_window_as_image",
  "get_screenshot_of_window_as_json",
  "jump_to_tab_by_name",
  "jump_to_tab_by_space_type",
  "jump_to_view3d_object_by_name",
  "jump_to_view3d_object_data_by_name",
  "render_thumbnail_to_path",
  "render_viewport_to_path",
  "search_api_docs",
  "search_manual_docs",
];

async function isFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function findExecutable({ explicit = [], windowsName, posixName }) {
  for (const candidate of explicit.map((value) => String(value || "").trim()).filter(Boolean)) {
    const absolute = resolve(candidate);
    if (await isFile(absolute)) return absolute;
  }
  const command = process.platform === "win32" ? "where.exe" : "which";
  const name = process.platform === "win32" ? windowsName : posixName;
  const output = await new Promise((resolvePromise) => {
    const child = spawn(command, [name], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout?.on("data", (chunk) => { stdout = (stdout + String(chunk)).slice(-65_536); });
    child.once("error", () => resolvePromise(""));
    child.once("close", (code) => resolvePromise(code === 0 ? stdout : ""));
  });
  for (const line of String(output).split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    if (await isFile(line)) return resolve(line);
  }
  throw new Error(`Unable to find ${name}. Set an explicit environment variable before running the live gate.`);
}

async function installedBlenderLocalHints() {
  const candidates = [
    join(homedir(), ".devspace-tailscale-bootstrap", "plugins", "packages", "blender-local", "devspace-plugin.json"),
    join(homedir(), ".codex", "devspace-local-capabilities", "blender-local", "devspace-plugin.json"),
  ];
  for (const path of candidates) {
    try {
      const manifest = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
      const server = manifest?.mcpServers?.blender;
      if (!server) continue;
      return {
        blenderPath: server?.env?.BLENDER_PATH || null,
        uvPath: server?.command || null,
      };
    } catch {}
  }
  return { blenderPath: null, uvPath: null };
}

function mcpStructured(callResult) {
  const result = callResult?.result;
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  for (const item of result?.content || []) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    try {
      const parsed = JSON.parse(item.text);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return undefined;
}

function blenderValue(callResult) {
  const outer = mcpStructured(callResult);
  if (!outer) throw new Error(`Blender MCP call returned no structured data: ${JSON.stringify(callResult?.result)}`);
  if (outer.status && outer.status !== "ok") throw new Error(`Blender bridge returned ${outer.status}: ${outer.message || "unknown error"}`);
  return outer.result ?? outer;
}

function portable(path) {
  return path.replace(/\\/g, "/");
}

function stage(name, detail = null) {
  console.error(`[blender-dual-live] ${name}${detail ? ` ${JSON.stringify(detail)}` : ""}`);
}

async function main() {
  stage("discover-executables");
  const installedHints = await installedBlenderLocalHints();
  const blenderPath = await findExecutable({
    explicit: [process.env.DEVSPACE_BLENDER_PATH, process.env.BLENDER_PATH, installedHints.blenderPath],
    windowsName: "blender.exe",
    posixName: "blender",
  });
  const uvPath = await findExecutable({
    explicit: [process.env.DEVSPACE_UV_PATH, process.env.UV_PATH, installedHints.uvPath],
    windowsName: "uv.exe",
    posixName: "uv",
  });
  stage("executables-ready", { blenderPath, uvPath });

  const root = await mkdtemp(join(tmpdir(), "devspace-blender-dual-live-"));
  const pluginSource = join(root, "blender-capability");
  const pluginsDir = join(root, "plugins");
  const registryPath = join(pluginsDir, "registry.json");
  const stateDir = join(root, "state");
  const blendA = join(root, "DevSpace-Blender-A.blend");
  const blendB = join(root, "DevSpace-Blender-B.blend");
  await mkdir(pluginSource, { recursive: true });

  await writeFile(join(pluginSource, "devspace-plugin.json"), JSON.stringify({
    id: "blender-local",
    name: "Local Blender MCP (dual-runtime live gate)",
    version: "1.0.0",
    description: "Official Blender Lab MCP used for two-runtime connection isolation verification.",
    routing: {
      aliases: ["Blender runtime", "parallel Blender", "two Blender ports"],
      priority: 120,
      allow_implicit_invocation: true,
      exposure: "deferred",
    },
    mcpServers: {
      blender: {
        command: uvPath,
        args: [
          "tool", "run",
          "--with", "mcp<2",
          "--from", OFFICIAL_SOURCE,
          "blender-mcp",
        ],
        env: {
          BLENDER_HOST: "127.0.0.1",
          BLENDER_PORT: "9876",
          BLENDER_PATH: blenderPath,
          BLENDER_MCP_DISABLE_TELEMETRY: "true",
          ...(process.env.UV_CACHE_DIR ? { UV_CACHE_DIR: process.env.UV_CACHE_DIR } : {}),
          ...(process.env.UV_TOOL_DIR ? { UV_TOOL_DIR: process.env.UV_TOOL_DIR } : {}),
        },
      },
    },
  }, null, 2));

  const capabilityRuntime = new CapabilityRuntime({
    enabled: true,
    pluginsDir,
    registryPath,
    pluginPaths: [],
  });
  const runtimeManager = new BlenderRuntimeManager({ stateDir, capabilityRuntime });
  const ownerA = "dual-live-conversation-a";
  const ownerB = "dual-live-conversation-b";
  let startedA = false;
  let startedB = false;
  try {
    stage("install-plugin");
    await capabilityRuntime.ready;
    await runtimeManager.ready;
    const installed = await capabilityRuntime.install({ source: pluginSource, enable: true, trust: true });
    assert.equal(installed.plugin.id, "blender-local");

    stage("start-runtimes");
    const [launchA, launchB] = await Promise.all([
      runtimeManager.start({
        runtimeId: "dual-agent-a",
        ownerConversationId: ownerA,
        ownerLabel: "Blender Agent A",
        blenderPath,
        background: true,
        visible: false,
      }),
      runtimeManager.start({
        runtimeId: "dual-agent-b",
        ownerConversationId: ownerB,
        ownerLabel: "Blender Agent B",
        blenderPath,
        background: true,
        visible: false,
      }),
    ]);
    startedA = true;
    startedB = true;
    stage("runtimes-ready", {
      runtimeA: { pid: launchA.runtime.pid, port: launchA.runtime.port },
      runtimeB: { pid: launchB.runtime.pid, port: launchB.runtime.port },
    });
    assert.notEqual(launchA.runtime.port, launchB.runtime.port);
    assert.notEqual(launchA.runtime.pid, launchB.runtime.pid);
    assert.equal(launchA.runtime.ownerConversationId, ownerA);
    assert.equal(launchB.runtime.ownerConversationId, ownerB);
    await assert.rejects(
      () => runtimeManager.status("dual-agent-a", { ownerConversationId: ownerB }),
      /another conversation/,
    );

    stage("resolve-runtime-connections");
    const tokenA = await runtimeManager.instanceToken("dual-agent-a", ownerA);
    const tokenB = await runtimeManager.instanceToken("dual-agent-b", ownerB);
    assert.notEqual(tokenA, tokenB);
    const [listedA, listedB] = await Promise.all([
      capabilityRuntime.listMcpTools("blender-local", "blender", tokenA, ownerA),
      capabilityRuntime.listMcpTools("blender-local", "blender", tokenB, ownerB),
    ]);
    const toolsA = listedA.tools.map((tool) => tool.name);
    const toolsB = listedB.tools.map((tool) => tool.name);
    assert.deepEqual(toolsA, EXPECTED_TOOLS);
    assert.deepEqual(toolsB, EXPECTED_TOOLS);
    assert.deepEqual(listedA.tools, listedB.tools);
    stage("tool-catalogs-ready", { tools: toolsA.length });

    const initCode = (label, marker, otherMarker, outputPath) => [
      "import bpy",
      `for n in ${JSON.stringify([marker, otherMarker])}:`,
      "    if bpy.data.objects.get(n):",
      "        bpy.data.objects.remove(bpy.data.objects[n], do_unlink=True)",
      `obj=bpy.data.objects.new(${JSON.stringify(marker)}, None)`,
      "bpy.context.scene.collection.objects.link(obj)",
      `bpy.context.scene['devspace_instance']=${JSON.stringify(label)}`,
      `bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(portable(outputPath))})`,
      `result={'instance':bpy.context.scene.get('devspace_instance'),'file':bpy.data.filepath,'own':bpy.data.objects.get(${JSON.stringify(marker)}) is not None,'other':bpy.data.objects.get(${JSON.stringify(otherMarker)}) is not None}`,
    ].join("\n");

    stage("write-isolated-scenes");
    const [writeA, writeB] = await Promise.all([
      capabilityRuntime.callMcp("blender-local", "blender", "execute_blender_code", {
        code: initCode("A", "DEVSPACE_A_ONLY", "DEVSPACE_B_ONLY", blendA),
      }, tokenA, ownerA),
      capabilityRuntime.callMcp("blender-local", "blender", "execute_blender_code", {
        code: initCode("B", "DEVSPACE_B_ONLY", "DEVSPACE_A_ONLY", blendB),
      }, tokenB, ownerB),
    ]);
    const writeValueA = blenderValue(writeA);
    const writeValueB = blenderValue(writeB);
    assert.deepEqual({ instance: writeValueA.instance, own: writeValueA.own, other: writeValueA.other }, { instance: "A", own: true, other: false });
    assert.deepEqual({ instance: writeValueB.instance, own: writeValueB.own, other: writeValueB.other }, { instance: "B", own: true, other: false });
    stage("isolated-scenes-written", { blendA, blendB });

    const verifyCode = [
      "import bpy",
      "result={'instance':bpy.context.scene.get('devspace_instance'),'file':bpy.data.filepath,'A':bpy.data.objects.get('DEVSPACE_A_ONLY') is not None,'B':bpy.data.objects.get('DEVSPACE_B_ONLY') is not None,'objects':[o.name for o in bpy.context.scene.objects]}",
    ].join("\n");
    stage("verify-isolation");
    const [verifyA, verifyB, summaryA, summaryB, datablocksA, datablocksB] = await Promise.all([
      capabilityRuntime.callMcp("blender-local", "blender", "execute_blender_code", { code: verifyCode }, tokenA, ownerA),
      capabilityRuntime.callMcp("blender-local", "blender", "execute_blender_code", { code: verifyCode }, tokenB, ownerB),
      capabilityRuntime.callMcp("blender-local", "blender", "get_objects_summary", {}, tokenA, ownerA),
      capabilityRuntime.callMcp("blender-local", "blender", "get_objects_summary", {}, tokenB, ownerB),
      capabilityRuntime.callMcp("blender-local", "blender", "get_blendfile_summary_datablocks", {}, tokenA, ownerA),
      capabilityRuntime.callMcp("blender-local", "blender", "get_blendfile_summary_datablocks", {}, tokenB, ownerB),
    ]);

    const valueA = blenderValue(verifyA);
    const valueB = blenderValue(verifyB);
    assert.equal(valueA.instance, "A");
    assert.equal(valueA.A, true);
    assert.equal(valueA.B, false);
    assert.equal(valueB.instance, "B");
    assert.equal(valueB.A, false);
    assert.equal(valueB.B, true);
    assert.equal(resolve(valueA.file), resolve(blendA));
    assert.equal(resolve(valueB.file), resolve(blendB));

    const summaryTextA = JSON.stringify(blenderValue(summaryA));
    const summaryTextB = JSON.stringify(blenderValue(summaryB));
    assert.match(summaryTextA, /DEVSPACE_A_ONLY/);
    assert.doesNotMatch(summaryTextA, /DEVSPACE_B_ONLY/);
    assert.match(summaryTextB, /DEVSPACE_B_ONLY/);
    assert.doesNotMatch(summaryTextB, /DEVSPACE_A_ONLY/);
    assert.ok(blenderValue(datablocksA));
    assert.ok(blenderValue(datablocksB));
    assert.equal((await stat(blendA)).isFile(), true);
    assert.equal((await stat(blendB)).isFile(), true);

    const connections = capabilityRuntime.listConnections({ pluginId: "blender-local", serverId: "blender" });
    assert.equal(connections.filter((row) => row.scope === "isolated" && row.state === "ready").length, 2);
    assert.deepEqual(new Set(connections.map((row) => row.runtimeId)), new Set(["dual-agent-a", "dual-agent-b"]));
    stage("verification-complete");

    console.log(JSON.stringify({
      ok: true,
      gate: "blender-mcp-dual-live",
      source: OFFICIAL_SOURCE,
      blenderExecutable: basenameSafe(blenderPath),
      uvExecutable: basenameSafe(uvPath),
      runtimeA: { runtimeId: launchA.runtime.runtimeId, port: launchA.runtime.port, pid: launchA.runtime.pid, blendFile: blendA },
      runtimeB: { runtimeId: launchB.runtime.runtimeId, port: launchB.runtime.port, pid: launchB.runtime.pid, blendFile: blendB },
      fullToolCatalog: `${toolsA.length}/${EXPECTED_TOOLS.length} PASS`,
      sameToolSchema: true,
      separateProcesses: true,
      separatePorts: true,
      conversationOwnership: true,
      projectIsolation: true,
      persistentOutputs: true,
      forceKillUsed: false,
      workTimeoutUsed: false,
    }));
  } catch (error) {
    stage("main-error", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    });
    throw error;
  } finally {
    stage("cleanup-begin", { startedA, startedB });
    if (startedA) {
      stage("cleanup-runtime-a");
      await runtimeManager.stop("dual-agent-a", { ownerConversationId: ownerA }).catch((error) => stage("cleanup-runtime-a-error", { error: String(error) }));
      stage("cleanup-runtime-a-done");
    }
    if (startedB) {
      stage("cleanup-runtime-b");
      await runtimeManager.stop("dual-agent-b", { ownerConversationId: ownerB }).catch((error) => stage("cleanup-runtime-b-error", { error: String(error) }));
      stage("cleanup-runtime-b-done");
    }
    stage("cleanup-runtime-manager");
    await runtimeManager.close().catch(() => {});
    stage("cleanup-capability-runtime");
    await capabilityRuntime.close().catch(() => {});
    stage("cleanup-temp");
    await rm(root, { recursive: true, force: true }).catch(() => {});
    stage("cleanup-complete");
  }
}

function basenameSafe(path) {
  return path ? path.split(/[\\/]/).at(-1) : null;
}

await main();
