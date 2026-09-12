import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const [server, router, adapter, skill, pluginText, packageText, agents] = await Promise.all([
  readFile(new URL("../dist/server.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/codex-computer-use-router.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/codex-computer-use.js", import.meta.url), "utf8"),
  readFile(new URL("../capabilities/codex-computer-use/skills/computer-use/SKILL.md", import.meta.url), "utf8"),
  readFile(new URL("../capabilities/codex-computer-use/devspace-plugin.json", import.meta.url), "utf8"),
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
]);
const plugin = JSON.parse(pluginText);
const packageJson = JSON.parse(packageText);

assert.doesNotMatch(server, /BrowserControlCoordinator|registerBrowserControlTools/,
  "production must not instantiate or register the retired custom Chrome driver");
assert.doesNotMatch(server, /server\.registerTool\("browser_control_/,
  "retired browser_control tools must not remain on the production MCP surface");
assert.match(server, /app\.use\("\/browser-control\/bridge"[\s\S]{0,500}status\(410\)/,
  "old extensions must receive an explicit retired response rather than a live control transport");
assert.match(server, /ordinary Chrome, Edge, and browser-window automation[\s\S]*codex_computer_use/);
assert.match(server, /obsolete DevSpace Chrome-extension driver has been removed/);
assert.match(router, /ordinary Chrome and Edge browser-window automation/);
assert.match(router, /legacy custom Chrome-extension path has been removed/);
assert.match(adapter, /CODEX_COMPUTER_USE_RUNTIME = "@oai\/sky"/);
assert.match(adapter, /callJsReplCompatibility/);
assert.doesNotMatch(adapter, /chrome\.debugger|Playwright|Selenium|BrowserControlCoordinator|browser-control\/bridge/i,
  "native browser execution must remain entirely inside the bundled Codex Computer Use runtime");
assert.match(skill, /ordinary Chrome or Edge browser window/);
assert.match(skill, /obsolete custom Chrome-extension driver has been removed/);
assert.match(skill, /list_apps` or `list_windows`/);
assert.deepEqual(plugin.routingAliases.includes("browser use"), true);
assert.deepEqual(plugin.routingAliases.includes("chrome automation"), true);
assert.equal(packageJson.files.includes("browser-control-bridge"), false,
  "the retired extension must not ship in new npm packages");
for (const removed of [
  "browser-control-bridge",
  "dist/browser-control.js",
  "dist/browser-control.test.js",
  "scripts/browser-control-live-gate.mjs",
]) assert.equal(existsSync(removed), false, `removed custom browser source still exists: ${removed}`);
for (const staleExclusion of [
  "!dist/browser-control.js",
  "!dist/browser-control.test.js",
  "!scripts/browser-control-live-gate.mjs",
]) assert.equal(packageJson.files.includes(staleExclusion), false,
  `package manifest still carries a stale exclusion for deleted source: ${staleExclusion}`);
assert.match(packageJson.scripts["verify:native-browser-gate"], /codex-native-browser-gate-static/);
assert.doesNotMatch(packageJson.scripts["verify:ultra"], /browser-control\.test|browser-control-bridge|browser-control-live-gate/,
  "the default product gate must exercise the native path, not the retired custom driver");
assert.match(packageJson.scripts["verify:ultra"], /verify:native-browser-gate/);
assert.match(agents, /Codex native browser gate|codex_computer_use/i);
assert.doesNotMatch(agents, /prefer browser_control_\*/i);

console.log(JSON.stringify({
  ok: true,
  gate: "codex-native-browser-gate",
  officialRuntime: "@oai/sky",
  customChromeDriverRegistered: false,
  customExtensionSourcePresent: false,
  retiredRuntimeArtifactsPresent: false,
  ordinaryBrowserRoute: "codex_computer_use",
}));
