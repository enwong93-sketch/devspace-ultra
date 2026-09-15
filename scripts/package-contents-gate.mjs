import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const releaseNotes = `docs/releases/V${packageJson.version}.md`;
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "npm_execpath is required; run this gate through npm run verify:public-release.");
const { stdout } = await execFileAsync(process.execPath, [npmCli, "pack", "--dry-run", "--json"], {
  cwd: root,
  windowsHide: true,
  maxBuffer: 32 * 1024 * 1024,
});
const report = JSON.parse(stdout);
const files = new Set((report?.[0]?.files || []).map((entry) => String(entry.path).replaceAll("\\", "/")));
for (const required of [
  "install.ps1",
  "install-skill.ps1",
  "update.ps1",
  "scripts/self-update-static-gate.mjs",
  "scripts/self-update-sandbox-test.ps1",
  "skills/devspace-ultra-setup/SKILL.md",
  "skills/devspace-ultra-setup/agents/openai.yaml",
  "scripts/devspace-public-setup.ps1",
  "scripts/devspace-duckdns-update.ps1",
  "scripts/devspace-cloudflare-run.ps1",
  "scripts/devspace-stable-gateway.mjs",
  "dist/server.js",
  "docs/ONE_COMMAND_SETUP.md",
  "docs/NETWORK_INGRESS.md",
  releaseNotes,
]) {
  assert.ok(files.has(required), `npm package is missing required public setup file: ${required}`);
}
for (const retired of [
  "dist/browser-control.js",
  "dist/browser-control.test.js",
  "scripts/browser-control-live-gate.mjs",
  "browser-control-bridge/manifest.json",
  "browser-control-bridge/background.js",
]) {
  assert.equal(files.has(retired), false, `npm package still contains retired Browser Control artifact: ${retired}`);
}
for (const removed of [
  "dist/browser-control.js",
  "dist/browser-control.test.js",
  "scripts/browser-control-live-gate.mjs",
  "browser-control-bridge",
]) {
  assert.equal(existsSync(resolve(root, removed)), false,
    `repository still contains removed Browser Control source: ${removed}`);
}
for (const path of files) {
  assert.doesNotMatch(path, /(?:^|\/)\.?[^/]*(?:\.before-|\.bak(?:-|$)|oauthdiag)/i,
    `npm package contains a local backup or diagnostic artifact: ${path}`);
}
console.log(JSON.stringify({
  ok: true,
  gate: "package-contents",
  fileCount: files.size,
  publicInstallerIncluded: true,
  networkRunnersIncluded: true,
  documentationIncluded: true,
  releaseNotes,
  retiredBrowserControlExcluded: true,
  retiredBrowserControlSourceRemoved: true,
  localBackupArtifactsExcluded: true,
}));
