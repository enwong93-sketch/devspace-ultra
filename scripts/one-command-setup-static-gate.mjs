import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [cli, installer, publicSetup, ingress, skillInstaller, skill, packageJson, workflow] = await Promise.all([
  readFile(new URL("../dist/cli.js", import.meta.url), "utf8"),
  readFile(new URL("../install.ps1", import.meta.url), "utf8"),
  readFile(new URL("./devspace-public-setup.ps1", import.meta.url), "utf8"),
  readFile(new URL("./devspace-local-ingress.ps1", import.meta.url), "utf8"),
  readFile(new URL("../install-skill.ps1", import.meta.url), "utf8"),
  readFile(new URL("../skills/devspace-ultra-setup/SKILL.md", import.meta.url), "utf8"),
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
]);

// Existing CLI setup remains a supported local entry point.
assert.match(cli, /case "setup"[\s\S]*runSetupCommand\(args\)/, "CLI must retain the integrated setup command");
assert.match(cli, /DuckDNS \+ Caddy \(recommended\)/, "DuckDNS/Caddy must remain the recommended route");
assert.match(cli, /Cloudflare Worker \+ Tunnel fallback/, "Cloudflare must remain an explicit fallback");
assert.match(cli, /--edge <duckdns\|cloudflare\|local>/, "CLI automation needs an explicit deterministic edge selector");
assert.match(cli, /existing configuration and generated owner token were preserved for repair\/retry/i, "failed setup must preserve recoverable state");
assert.match(cli, /goalRoundRecoveryEnabled:\s*files\.config\.goalRoundRecoveryEnabled !== false/,
  "fresh CLI setup must enable accepted exact-page Goal Recovery while preserving an explicit false hold");

// Root one-command bootstrap.
assert.match(installer, /\[ValidateSet\("DuckDNS", "Cloudflare", "Local"\)\]/);
assert.match(installer, /\$Network = "DuckDNS"/, "DuckDNS must be the bootstrap default");
assert.match(installer, /& npm install --global \$source --ignore-scripts --no-audit --no-fund/, "bootstrap installer must install the selected tagged GitHub package globally");
assert.match(installer, /OpenJS\.NodeJS\.LTS/, "missing Node.js should be bootstrapped through winget");
assert.match(installer, /Git\.Git/, "missing Git should be bootstrapped through winget");
assert.match(installer, /install-skill\.ps1/, "the bootstrap must install the guided setup Agent Skill");
assert.match(installer, /devspace-public-setup\.ps1/, "the bootstrap must continue into the authoritative public setup script");
assert.match(installer, /Start-Process powershell\.exe -Verb RunAs -Wait/, "machine-level setup must request one explicit elevation boundary");
assert.doesNotMatch(installer, /Invoke-Expression|\biex\b/i, "remote installer text must not be piped into code execution");

// Elevated setup and safe defaults.
assert.match(publicSetup, /DevSpace-Stable-Gateway/, "public setup must register the authoritative Stable Gateway task");
assert.match(publicSetup, /CaddyServer\.Caddy/, "DuckDNS setup must provision Caddy when missing");
assert.match(publicSetup, /Cloudflare\.cloudflared/, "Cloudflare fallback must provision cloudflared when missing");
assert.match(publicSetup, /stableGatewayCoreHeapProfile" "system"/, "public setup must use system-managed Core heap");
assert.match(publicSetup, /autoCompactEnabled" \$false/, "unaccepted Auto Compact must remain disabled by default");
assert.match(publicSetup, /goalRoundRecoveryEnabled" \$true/,
  "accepted exact-page Goal Recovery must be enabled by default while retaining the explicit operator hold");
assert.match(publicSetup, /ConvertFrom-SecureString/, "provider credentials must be DPAPI protected");
assert.match(publicSetup, /Read-Host \$Prompt -AsSecureString/, "interactive secrets must be entered through a masked local prompt");
assert.match(publicSetup, /Wait-ForGateway/, "setup must wait for real Gateway readiness");
assert.match(publicSetup, /__devspace\/memory\/status/, "setup must verify a real Core rather than only Gateway health");
assert.doesNotMatch(publicSetup, /Write-(?:Host|Output)[^\r\n]*(?:token|Password)/i, "setup must never print secret values");

// Direct ingress support remains generic rather than router-specific.
assert.match(ingress, /Find-UpnpDescriptionLocations/, "direct ingress must discover router IGD descriptors");
assert.match(ingress, /239\.255\.255\.250/, "generic SSDP discovery must remain available");
assert.match(ingress, /Get-DefaultInterfaceAlias/, "the physical interface should be auto-detected");
assert.match(ingress, /private\/CGNAT\/reserved/, "direct ingress must fail clearly without public IPv4");
assert.match(ingress, /ConvertFrom-SecureString/, "direct ingress credentials must remain DPAPI protected");

// Guided Agent Skill is part of the package and has the required human-in-the-loop boundaries.
assert.match(skillInstaller, /skills\\devspace-ultra-setup/);
assert.match(skillInstaller, /Write-AtomicFile/);
assert.match(skill, /DuckDNS\/DDNS \+ Caddy direct ingress/);
assert.match(skill, /stable Cloudflare named tunnel/);
assert.match(skill, /user must personally complete account actions/i);
assert.match(skill, /router-administration actions/i);
assert.match(skill, /Use `devspace_progress_report` before substantive work on a multi-step setup and after each meaningful medium-sized setup step/);
assert.match(skill, /devspace_progress_preflight_required/);
assert.match(skill, /do not repeatedly reconnect ChatGPT/i);

const parsedPackage = JSON.parse(packageJson);
for (const required of ["scripts", "skills", "install.ps1", "install-skill.ps1"]) {
  assert.ok(parsedPackage.files.includes(required), `published package must include ${required}`);
}
assert.match(workflow, /Validate PowerShell scripts/, "CI must parse PowerShell distribution scripts");

console.log(JSON.stringify({
  ok: true,
  gate: "one-command-setup-static",
  primaryIngress: "duckdns-caddy",
  fallbackIngress: "cloudflare-named-tunnel",
  stableGatewayAutostart: true,
  agentSkillInstalled: true,
  exactPageGoalRecoveryDefault: true,
  secretArgumentsRejected: true,
  recoverableFailure: true,
}));
