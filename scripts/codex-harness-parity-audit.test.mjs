import assert from "node:assert/strict";
import { evaluateParity } from "./codex-harness-parity-audit.mjs";

const codexText = [
  "exec_command", "apply_patch", "write_stdin", "view_image", "update_plan",
  "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
  "mcp_servers", "spawn_agent", "send_input", "wait", "resume_agent", "close_agent",
  "request_user_input", "web_search", "js_repl", "skills", "SKILL.md", "search_info", "ToolSearchInfo",
  "computer", "screenshot", "browser", "sandbox", "danger-full-access", "memory", "compact", "compaction",
].join("\n");
const devspaceText = [
  "open_workspace", "read", "write", "edit", "grep", "glob", "ls", "apply_patch",
  "exec_command", "write_stdin", "view_image", "loadImageForMcp", "image/png", "image/jpeg",
  "devspace_update_plan", "devspace_plan_status", "devspace_plan_start",
  "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
  "capability_list", "capability_route", "capability_search", "capability_inspect", "capability_call", "capability_instance",
  "ROUTING_CONTRACT_VERSION", "allowImplicitInvocation", "routingFingerprint",
  "capability_import_codex", "codex-mcp-stdio-bridge", "expected-fingerprint",
  "toolchain_status", "toolchain_install", "winget.exe",
  "chat_swarm_join", "chat_swarm_next", "chat_swarm_submit", "chat_swarm_elastic_scale",
  "devspace_goal_control", "codex_computer_use", "node_repl", "show_changes", "reviewCheckpoints",
  "download_artifact", "registerArtifactTools", "installedCapabilitySkillPaths", "devspaceSkillsDir",
  "codex_computer_use_status", "codex_computer_use",
  "computer-use", "@oai/sky", "linked-codex-node-repl",
  "executionPolicy", "full-access",
  "allowedRoots", "trusted", "readOnlyHint", "destructiveHint",
  "powermem-shared", "search_memories_with_profile",
].join("\n");

const audit = evaluateParity({ codexText, devspaceText });
assert.equal(audit.summary.p0, 9);
assert.equal(audit.summary.p0Passed, 9);
assert.deepEqual(audit.summary.hardBlockers, []);
assert.deepEqual(audit.summary.partial, []);
assert.equal(audit.rows.find((row) => row.id === "browser-and-computer-use").target, "bridged");
assert.equal(audit.rows.find((row) => row.id === "full-access-execution-policy").target, "complete");
assert.deepEqual(audit.summary.missing, ["same-conversation-auto-compact"]);
assert.equal(audit.rows.find((row) => row.id === "javascript-repl").devspaceObserved, true);

const broken = evaluateParity({
  codexText,
  devspaceText: devspaceText.replace("view_image", "missing-image-tool"),
});
assert.deepEqual(broken.summary.hardBlockers, ["native-image-inspection"]);
assert.equal(broken.rows.find((row) => row.id === "native-image-inspection").hardBlocker, true);

console.log(JSON.stringify({
  ok: true,
  gate: "codex-harness-parity-audit",
  p0FailureIsFatal: true,
  partialAndMissingRemainExplicit: true,
  semanticEquivalenceSupported: true,
}));
