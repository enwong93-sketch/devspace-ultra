import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [skill, metadata, installer, rootInstaller, docs] = await Promise.all([
  readFile(new URL("../skills/devspace-ultra-setup/SKILL.md", import.meta.url), "utf8"),
  readFile(new URL("../skills/devspace-ultra-setup/agents/openai.yaml", import.meta.url), "utf8"),
  readFile(new URL("../install-skill.ps1", import.meta.url), "utf8"),
  readFile(new URL("../install.ps1", import.meta.url), "utf8"),
  readFile(new URL("../docs/ONE_COMMAND_SETUP.md", import.meta.url), "utf8"),
]);

assert.match(skill, /^---[\s\S]*name:\s*devspace-ultra-setup/m);
assert.match(skill, /DuckDNS\/DDNS \+ Caddy direct ingress/);
assert.match(skill, /Cloudflare named tunnel/);
assert.match(skill, /CGNAT/);
assert.match(skill, /Never ask the user to paste[\s\S]*token/i);
assert.match(skill, /devspace_progress_report/);
assert.match(skill, /execute every safe local command/i);
assert.match(skill, /router|port forwarding/i);
assert.match(metadata, /allow_implicit_invocation:\s*true/);
assert.match(installer, /\.codex\\skills\\devspace-ultra-setup/);
assert.match(installer, /Write-AtomicFile/);
assert.doesNotMatch(installer, /Invoke-Expression|\biex\b/i);
assert.match(rootInstaller, /install-skill\.ps1/);
assert.match(rootInstaller, /-SourceRoot \$packageRoot/);
assert.match(docs, /Install the guided Agent Skill first/);
assert.match(docs, /use `devspace-ultra-setup`/);

for (const source of [skill, metadata, installer, rootInstaller]) {
  assert.doesNotMatch(source, /(?:token|secret|api[_-]?key)\s*[:=]\s*["'][A-Za-z0-9_.-]{20,}["']/i);
}

console.log(JSON.stringify({
  ok: true,
  gate: "setup-skill-static",
  codexSkillInstall: true,
  guidedExternalSteps: true,
  duckDnsPrimary: true,
  cloudflareFallback: true,
  secretsInChat: false,
  rootInstallerInstallsSkill: true,
}));
