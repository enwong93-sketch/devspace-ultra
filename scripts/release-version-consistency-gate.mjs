import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");
const packageJson = JSON.parse(await read("package.json"));
const version = String(packageJson.version || "").trim();
assert.match(version, /^\d+\.\d+\.\d+$/);
const tag = `v${version}`;
const releaseNotesPath = `docs/releases/V${version}.md`;

const [
  packageLock,
  server,
  installer,
  skillInstaller,
  setupSkill,
  networkSkill,
  networkPlugin,
  setupDoc,
  readme,
  workflow,
  changelog,
  releaseNotes,
] = await Promise.all([
  read("package-lock.json"),
  read("dist/server.js"),
  read("install.ps1"),
  read("install-skill.ps1"),
  read("skills/devspace-ultra-setup/SKILL.md"),
  read("capabilities/devspace-network-setup/skills/devspace-network-setup/SKILL.md"),
  read("capabilities/devspace-network-setup/devspace-plugin.json"),
  read("docs/ONE_COMMAND_SETUP.md"),
  read("README.md"),
  read(".github/workflows/release.yml"),
  read("CHANGELOG.md"),
  read(releaseNotesPath),
]);

const lock = JSON.parse(packageLock);
assert.equal(lock.version, version);
assert.equal(lock.packages?.[""]?.version, version);
assert.match(server, new RegExp(`version:\\s*["']${version.replaceAll(".", "\\.")}["']`));
assert.ok(installer.includes(`[string] $Ref = "${tag}"`));
assert.ok(skillInstaller.includes(`[string] $Ref = "${tag}"`));
assert.equal(JSON.parse(networkPlugin).version, version);
for (const [path, source] of [
  ["skills/devspace-ultra-setup/SKILL.md", setupSkill],
  ["capabilities/devspace-network-setup/skills/devspace-network-setup/SKILL.md", networkSkill],
  ["docs/ONE_COMMAND_SETUP.md", setupDoc],
  ["README.md", readme],
]) {
  assert.ok(source.includes(`/devspace-ultra/${tag}/`), `${path} does not reference ${tag}.`);
}
assert.ok(workflow.includes(`body_path: ${releaseNotesPath}`));
assert.ok(changelog.includes(`## ${version} —`));
assert.ok(releaseNotes.startsWith(`# DevSpace Ultra ${tag} `));

console.log(JSON.stringify({
  ok: true,
  gate: "release-version-consistency",
  version,
  tag,
  releaseNotesPath,
  packageLockAligned: true,
  installersAligned: true,
  documentationAligned: true,
  workflowAligned: true,
  serverAligned: true,
}));
