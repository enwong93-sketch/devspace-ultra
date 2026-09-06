#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const devspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function argument(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? String(process.argv[index + 1]) : fallback;
}

async function collectText(root, extensions) {
  const chunks = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if ([".git", "node_modules", "target", "vendor"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) {
        chunks.push(await readFile(path, "utf8"));
      }
    }
  };
  await visit(root);
  return chunks.join("\n");
}

async function gitValue(root, args) {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

function allPresent(text, patterns) {
  return patterns.every((pattern) => text.includes(pattern));
}

function anyPresent(text, patterns) {
  return patterns.some((pattern) => text.includes(pattern));
}

export function evaluateParity({ codexText, devspaceText }) {
  const rows = [
    {
      id: "workspace-files-search",
      priority: "P0",
      codex: ["exec_command", "apply_patch"],
      devspaceAll: ["open_workspace", "read", "write", "edit", "grep", "glob", "ls", "apply_patch"],
      target: "complete",
      note: "Confined workspace open/read/write/edit/search plus patch mutation.",
    },
    {
      id: "persistent-process-control",
      priority: "P0",
      codex: ["exec_command", "write_stdin"],
      devspaceAll: ["exec_command", "write_stdin"],
      target: "complete",
      note: "Long-running command sessions, polling and interactive stdin.",
    },
    {
      id: "native-image-inspection",
      priority: "P0",
      codex: ["view_image"],
      devspaceAll: ["view_image", "loadImageForMcp", "image/png", "image/jpeg"],
      target: "complete",
      note: "Bounded signature-checked PNG/JPEG/WebP/GIF native MCP image output.",
    },
    {
      id: "turn-plan-state",
      priority: "P0",
      codex: ["update_plan"],
      devspaceAll: ["devspace_update_plan", "devspace_plan_status", "devspace_plan_start"],
      target: "complete",
      note: "DevSpace adds durable, conversation-bound Plan state and UI projection.",
    },
    {
      id: "mcp-resource-compatibility",
      priority: "P0",
      codex: ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"],
      devspaceAll: ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"],
      target: "complete",
      note: "Exact top-level Codex resource aliases over the unified Capability Runtime.",
    },
    {
      id: "dynamic-mcp-tools-prompts-instances",
      priority: "P0",
      codex: ["list_mcp_resources"],
      devspaceAll: ["capability_list", "capability_search", "capability_inspect", "capability_call", "capability_instance"],
      target: "complete",
      note: "DevSpace additionally exposes trusted tools, prompts, resources and isolated stateful instances.",
    },
    {
      id: "codex-mcp-catalog-import",
      priority: "P0",
      codex: ["mcp_servers"],
      devspaceAll: ["capability_import_codex", "codex-mcp-stdio-bridge", "expected-fingerprint"],
      target: "complete",
      note: "Secret-free audited bridge from the existing Codex MCP catalogue, with executable-drift fail-closed behavior.",
    },
    {
      id: "developer-toolchain-doctor",
      priority: "P0",
      codexAny: ["exec_command", "shell_command", "shell"],
      devspaceAll: ["toolchain_status", "toolchain_install", "winget.exe"],
      target: "complete",
      note: "Detects and allowlist-installs the local executables that agent workflows depend on.",
    },
    {
      id: "multi-agent-control",
      priority: "P1",
      codex: ["spawn_agent", "send_input", "wait", "resume_agent", "close_agent"],
      devspaceAll: ["chat_swarm_join", "chat_swarm_next", "chat_swarm_submit", "chat_swarm_elastic_scale"],
      target: "complete",
      note: "Different surface, equivalent persistent orchestration plus runtime protection.",
    },
    {
      id: "structured-user-input",
      priority: "P1",
      codex: ["request_user_input"],
      devspaceAny: ["request_user_input", "devspace_goal_control"],
      target: "host-native",
      note: "ChatGPT can ask directly in the native conversation; Goal pause/resume covers durable waits. Exact structured form UI remains optional.",
    },
    {
      id: "web-research",
      priority: "P1",
      codex: ["web_search"],
      devspaceAny: ["web_search", "browser_control_claim"],
      target: "host-native",
      note: "ChatGPT supplies current-source web search; DevSpace supplies signed-in browser control.",
    },
    {
      id: "javascript-repl",
      priority: "P1",
      codex: ["js_repl"],
      devspaceAny: ["js_repl", "node_repl", "capability_import_codex"],
      target: "bridged",
      note: "Provided through the audited Codex MCP catalogue bridge when node_repl is enabled.",
    },
    {
      id: "review-and-diff",
      priority: "P1",
      codex: ["apply_patch"],
      devspaceAll: ["show_changes", "reviewCheckpoints"],
      target: "complete",
      note: "Aggregate diff review and per-workspace checkpoints supplement patch output.",
    },
    {
      id: "artifact-intake",
      priority: "P1",
      codexAny: ["view_image", "exec_command"],
      devspaceAll: ["download_artifact", "registerArtifactTools"],
      target: "complete",
      note: "Host-native attachment download into confined workspaces.",
    },
    {
      id: "skills-and-reusable-workflows",
      priority: "P1",
      codexAny: ["skills", "SKILL.md"],
      devspaceAll: ["installedCapabilitySkillPaths", "devspaceSkillsDir"],
      target: "complete",
      note: "Workspace, user and trusted plugin Skills are discovered together.",
    },
    {
      id: "browser-and-computer-use",
      priority: "P2",
      codexAny: ["computer", "screenshot", "browser"],
      devspaceAll: ["browser_control_status", "browser_control_claim", "browser_control_inspect", "browser_control_act"],
      target: "partial",
      note: "Signed-in Chrome semantic control is present; arbitrary desktop Computer Use remains a post-foundation gap.",
    },
    {
      id: "sandbox-and-action-approval",
      priority: "P2",
      codexAny: ["sandbox", "approval"],
      devspaceAll: ["CodexSandboxRuntime", "request_permissions", "exec_sandboxed", "allowedRoots", "trusted"],
      target: "partial",
      note: "Official Codex sandbox execution and single-use command-bound permission grants are present. Windows does not yet claim global read-deny isolation, so full OS-policy equivalence remains partial.",
    },
    {
      id: "durable-memory",
      priority: "P2",
      codexAny: ["memory", "compact"],
      devspaceAll: ["powermem-shared", "search_memories_with_profile"],
      target: "extra",
      note: "Shared PowerMem is a DevSpace product capability beyond the basic Codex workspace tool set.",
    },
    {
      id: "same-conversation-auto-compact",
      priority: "P2",
      codexAny: ["compact", "compaction"],
      devspaceAny: ["hostNativeCompaction", "sameConversationId"],
      target: "missing",
      note: "Continuity capsules exist, but true same-conversation native compaction remains unimplemented and must not be relabelled.",
    },
  ];

  const evaluated = rows.map((row) => {
    const codexObserved = row.codex
      ? allPresent(codexText, row.codex)
      : anyPresent(codexText, row.codexAny || []);
    const devspaceObserved = row.devspaceAll
      ? allPresent(devspaceText, row.devspaceAll)
      : anyPresent(devspaceText, row.devspaceAny || []);
    const hardBlocker = row.priority === "P0" && (!codexObserved || !devspaceObserved);
    return {
      id: row.id,
      priority: row.priority,
      target: row.target,
      codexObserved,
      devspaceObserved,
      hardBlocker,
      note: row.note,
    };
  });
  return {
    rows: evaluated,
    summary: {
      total: evaluated.length,
      p0: evaluated.filter((row) => row.priority === "P0").length,
      p0Passed: evaluated.filter((row) => row.priority === "P0" && !row.hardBlocker).length,
      hardBlockers: evaluated.filter((row) => row.hardBlocker).map((row) => row.id),
      complete: evaluated.filter((row) => row.target === "complete" && row.devspaceObserved).length,
      hostNativeOrBridged: evaluated.filter((row) => ["host-native", "bridged", "extra"].includes(row.target) && row.devspaceObserved).length,
      partial: evaluated.filter((row) => row.target === "partial").map((row) => row.id),
      missing: evaluated.filter((row) => row.target === "missing").map((row) => row.id),
    },
  };
}

async function main() {
  const codexRoot = resolve(argument("codex-root", join(homedir(), ".devspace", "research", "openai-codex-20260907")));
  const codexToolsRoot = join(codexRoot, "codex-rs", "core", "src", "tools");
  const codexText = await collectText(codexToolsRoot, [".rs"]);
  const devspaceText = await collectText(devspaceRoot, [".js", ".mjs", ".md", ".json"]);
  const audit = evaluateParity({ codexText, devspaceText });
  const [commit, commitDate, remote] = await Promise.all([
    gitValue(codexRoot, ["rev-parse", "HEAD"]),
    gitValue(codexRoot, ["log", "-1", "--format=%cI"]),
    gitValue(codexRoot, ["remote", "get-url", "origin"]),
  ]);
  const result = {
    ok: audit.summary.hardBlockers.length === 0,
    gate: "codex-harness-parity",
    officialCodex: {
      repository: remote,
      commit,
      commitDate,
      sourceRoot: codexToolsRoot,
    },
    devspace: {
      root: devspaceRoot,
      branch: await gitValue(devspaceRoot, ["branch", "--show-current"]),
      commit: await gitValue(devspaceRoot, ["rev-parse", "HEAD"]),
    },
    ...audit,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
