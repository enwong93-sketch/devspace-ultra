import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [server, runtime, router, adapter, pluginText, skill, packageText, canary, replCompat] = await Promise.all([
  readFile("dist/server.js", "utf8"),
  readFile("dist/capability-runtime.js", "utf8"),
  readFile("dist/codex-computer-use-router.js", "utf8"),
  readFile("dist/codex-computer-use.js", "utf8"),
  readFile("capabilities/codex-computer-use/devspace-plugin.json", "utf8"),
  readFile("capabilities/codex-computer-use/skills/computer-use/SKILL.md", "utf8"),
  readFile("package.json", "utf8"),
  readFile("scripts/stable-gateway-real-core-canary.mjs", "utf8"),
  readFile("dist/js-repl-compat.js", "utf8"),
]);
const packageJson = JSON.parse(packageText);
const plugin = JSON.parse(pluginText);

assert.match(server, /BUILTIN_CODEX_COMPUTER_USE_PLUGIN/);
assert.match(server, /registerCodexComputerUseRouter\(server, \{ capabilityRuntime, codexMcpBridge, resolveConversation: resolveConversationAuthority \}\)/);
assert.doesNotMatch(server, /BrowserControlCoordinator|registerBrowserControlTools/);
assert.match(server, /ordinary Chrome, Edge, and browser-window automation[\s\S]*codex_computer_use/);
assert.doesNotMatch(server, /CodexSandboxRuntime|registerCodexSandboxTools|request_permissions|exec_sandboxed/);
assert.match(router, /server\.registerTool\("codex_computer_use"/);
assert.match(router, /callCodexComputerUse/);
assert.match(router, /persistent Codex node_repl imports @oai\/sky/i);
assert.match(router, /ordinary Chrome and Edge browser-window automation/i);
assert.match(router, /former browser_control_\* Chrome-extension path is retired/i);
assert.match(adapter, /callJsReplCompatibility/);
assert.match(adapter, /CODEX_COMPUTER_USE_RUNTIME = "@oai\/sky"/);
assert.match(adapter, /CODEX_COMPUTER_USE_PLUGIN_ID = "computer-use@openai-bundled"/);
assert.match(adapter, /sky\.list_apps/);
assert.match(adapter, /sky\.get_window_state/);
assert.match(adapter, /"click",/);
assert.match(adapter, /"type_text",/);
assert.match(adapter, /"scroll",/);
assert.match(adapter, /"drag",/);
assert.match(adapter, /if \(!ACTIONS\.has\(normalized\)\) throw new Error/);
assert.match(adapter, /sky\.\$\{method\}/);
assert.match(adapter, /devspaceGuiDriver:\s*false/);
assert.doesNotMatch(adapter, /spawn\(|Selenium|Playwright|UIAutomation|SendInput|powershell/i);
assert.match(replCompat, /linked Codex runtime is used directly/i);
assert.equal(plugin.id, "codex-computer-use");
assert.equal(Object.hasOwn(plugin, "tools"), false);
assert.deepEqual(plugin.skills, ["skills"]);
assert.match(plugin.description, /@oai\/sky/);
assert.match(skill, /Use `codex_computer_use` automatically/);
assert.match(skill, /shared persistent Codex `node_repl` importing `@oai\/sky`/);
assert.match(skill, /ordinary Chrome or Edge browser window/);
assert.match(skill, /former `browser_control_\*` Chrome-extension driver is retired/);
assert.equal(packageJson.files.includes("capabilities"), true);
assert.equal(packageJson.files.includes("browser-control-bridge"), false);
assert.equal(Object.hasOwn(packageJson.scripts, "verify:codex-sandbox"), false);
assert.match(packageJson.scripts["verify:ultra"], /verify:computer-use/);
assert.doesNotMatch(runtime, /MAX_TOOL_TIMEOUT_MS|Promise\.race\(|setTimeout\(/,
  "capability execution must not impose an artificial wall-clock termination deadline");
assert.match(canary, /"codex_computer_use_status"/);
assert.match(canary, /"codex_computer_use"/);
assert.match(canary, /for \(const removedTool of \["codex_sandbox_status", "request_permissions", "exec_sandboxed"\]\)/);

console.log(JSON.stringify({
  ok: true,
  gate: "codex-computer-use-static",
  bundledPluginLayer: true,
  automaticRouteTool: true,
  persistentCodexNodeRepl: true,
  officialSkyRuntime: true,
  ordinaryBrowserWindowAutomation: true,
  customChromeExtensionRetired: true,
  structuredActionsOnly: true,
  fullAccessOnly: true,
  sandboxToolSurfaceRemoved: true,
  devspaceGuiDriverImplemented: false,
}));
