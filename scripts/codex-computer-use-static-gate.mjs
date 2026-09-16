import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const [server, runtime, router, adapter, overlay, pluginText, skill, packageText, canary, replCompat] = await Promise.all([
  readFile("dist/server.js", "utf8"),
  readFile("dist/capability-runtime.js", "utf8"),
  readFile("dist/codex-computer-use-router.js", "utf8"),
  readFile("dist/codex-computer-use.js", "utf8"),
  readFile("dist/classic-computer-use-overlay.js", "utf8"),
  readFile("capabilities/codex-computer-use/devspace-plugin.json", "utf8"),
  readFile("capabilities/codex-computer-use/skills/computer-use/SKILL.md", "utf8"),
  readFile("package.json", "utf8"),
  readFile("scripts/stable-gateway-real-core-canary.mjs", "utf8"),
  readFile("dist/js-repl-compat.js", "utf8"),
]);
const packageJson = JSON.parse(packageText);
const plugin = JSON.parse(pluginText);

assert.match(server, /BUILTIN_CODEX_COMPUTER_USE_PLUGIN/);
assert.match(server, /registerCodexComputerUseRouter\(server, \{[\s\S]*computerUseOverlay[\s\S]*\}\)/);
assert.match(server, /new ClassicComputerUseOverlay\(/);
assert.match(server, /findUniqueActiveConversation\(\{[\s\S]*requireGenerating:\s*true[\s\S]*requireProgressCard:\s*true/,
  "Computer Use first-call fallback must require one unique actively generating exact page that owns its progress card");
assert.match(server, /computerUseTool && callFingerprint/,
  "the unique-page fallback must be scoped to a real Computer Use tool call fingerprint");
assert.doesNotMatch(server, /computerUseTool[\s\S]{0,1600}conversationAuthority\.observeNativeTurn/,
  "the first-call fallback must remain request-scoped and never create durable session authority");
assert.doesNotMatch(server, /BrowserControlCoordinator|registerBrowserControlTools/);
assert.match(server, /ordinary Chrome, Edge, and browser-window automation[\s\S]*codex_computer_use/);
assert.doesNotMatch(server, /CodexSandboxRuntime|registerCodexSandboxTools|request_permissions|exec_sandboxed/);
assert.match(router, /server\.registerTool\("codex_computer_use"/);
assert.match(router, /callCodexComputerUse/);
assert.match(router, /persistent Codex node_repl imports @oai\/sky/i);
assert.match(router, /ordinary Chrome and Edge browser-window automation/i);
assert.match(router, /legacy custom Chrome-extension path has been removed/i);
assert.match(router, /input\.release_control=true/i);
assert.match(router, /elicitation\/create/);
assert.match(router, /ElicitResultSchema/);
assert.match(router, /computerUseActivity:\s*computerUseOverlay/);
assert.match(router, /releaseHostUnsupportedApproval/);
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
assert.match(adapter, /validateComputerUseElicitation/);
assert.match(adapter, /approvalRelay/);
assert.match(adapter, /release_control/);
assert.match(adapter, /final read-only observation/);
assert.match(adapter, /computerUseActivity\.begin/);
assert.match(adapter, /computerUseActivity\.end/);
assert.match(adapter, /computerUseActivity\.release/);
assert.match(adapter, /releaseHostUnsupportedApproval/);
assert.match(adapter, /PROHIBITED_APP_PATTERN/);
assert.doesNotMatch(adapter, /spawn\(|child_process|Selenium|Playwright|UIAutomation|SendInput/i,
  "the adapter may name prohibited apps, but must not implement a second GUI process or driver");
assert.match(replCompat, /linked Codex runtime is used directly/i);
assert.match(overlay, /Computer Use 正在使用你的電腦/);
assert.match(overlay, /rgba\(37,99,235,\.16\)/);
assert.match(overlay, /pointer-events:none/);
assert.match(overlay, /只限目前對話/);
assert.match(overlay, /suppressed-by-producer-lease/);
assert.match(overlay, /idle-clear-scheduled/);
assert.match(overlay, /async release\(/);
assert.match(overlay, /explicitRelease:\s*true/);
assert.doesNotMatch(overlay, /@keyframes|animation:/,
  "the takeover status should remain a static, reduced-motion-safe control surface");
assert.equal(plugin.id, "codex-computer-use");
assert.equal(Object.hasOwn(plugin, "tools"), false);
assert.deepEqual(plugin.skills, ["skills"]);
assert.match(plugin.description, /@oai\/sky/);
assert.match(skill, /Use `codex_computer_use` automatically/);
assert.match(skill, /shared persistent Codex `node_repl` importing `@oai\/sky`/);
assert.match(skill, /ordinary Chrome or Edge browser window/);
assert.match(skill, /obsolete custom Chrome-extension driver has been removed/);
assert.match(skill, /release_control=true/);
assert.equal(packageJson.files.includes("capabilities"), true);
assert.equal(packageJson.files.includes("browser-control-bridge"), false);
for (const removed of [
  "browser-control-bridge",
  "dist/browser-control.js",
  "dist/browser-control.test.js",
  "scripts/browser-control-live-gate.mjs",
]) assert.equal(existsSync(removed), false, `removed custom browser source still exists: ${removed}`);
assert.equal(Object.hasOwn(packageJson.scripts, "verify:codex-sandbox"), false);
assert.match(packageJson.scripts["verify:ultra"], /verify:computer-use/);
assert.match(packageJson.scripts["verify:computer-use"], /classic-computer-use-overlay\.test\.js/);
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
  officialApprovalRelay: true,
  exactConversationFirstCallFallback: true,
  blueTakeoverOverlay: true,
  overlayAutoClear: true,
  explicitAgentRelease: true,
  errorFailSafeRelease: true,
  ordinaryBrowserWindowAutomation: true,
  customChromeExtensionRemoved: true,
  structuredActionsOnly: true,
  fullAccessOnly: true,
  sandboxToolSurfaceRemoved: true,
  devspaceGuiDriverImplemented: false,
}));
