import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const files = Object.fromEntries(await Promise.all([
  "install.ps1",
  "install-skill.ps1",
  "skills/devspace-ultra-setup/SKILL.md",
  "skills/devspace-ultra-setup/agents/openai.yaml",
  "scripts/devspace-public-setup.ps1",
  "scripts/devspace-duckdns-update.ps1",
  "scripts/devspace-cloudflare-run.ps1",
  "docs/ONE_COMMAND_SETUP.md",
  "docs/NETWORK_INGRESS.md",
  "scripts/devspace-stable-gateway.mjs",
].map(async (path) => [path, await readFile(resolve(root, path), "utf8")])));

const setup = files["scripts/devspace-public-setup.ps1"];
assert.match(files["install.ps1"], /\[ValidateSet\("DuckDNS", "Cloudflare", "Local"\)\][\s\S]*\$Network = "DuckDNS"/);
assert.match(files["install.ps1"], /install-skill\.ps1/);
assert.match(files["install-skill.ps1"], /\.codex\\skills\\devspace-ultra-setup/);
assert.match(files["skills/devspace-ultra-setup/SKILL.md"], /DuckDNS\/DDNS \+ Caddy direct ingress/);
assert.match(files["skills/devspace-ultra-setup/SKILL.md"], /Cloudflare named tunnel/);
assert.match(setup, /stableGatewayCoreHeapProfile" "system"/);
assert.match(setup, /autoCompactEnabled" \$false/);
assert.match(setup, /goalRoundRecoveryEnabled" \$false/);
assert.match(setup, /ExecutionTimeLimit \(\[TimeSpan\]::Zero/);
assert.match(setup, /ConvertFrom-SecureString/);
assert.match(setup, /DEVSPACE_DUCKDNS_TOKEN/);
assert.match(setup, /DEVSPACE_CLOUDFLARE_TUNNEL_TOKEN/);
assert.match(files["scripts/devspace-duckdns-update.ps1"], /secretLogged = \$false/);
assert.doesNotMatch(files["scripts/devspace-duckdns-update.ps1"], /Write-(?:Host|Output).*token/i);
assert.match(files["docs/ONE_COMMAND_SETUP.md"], /DuckDNS\/DDNS direct to the local machine/);
assert.match(files["docs/ONE_COMMAND_SETUP.md"], /daily request quota/i);
assert.match(files["docs/NETWORK_INGRESS.md"], /Cloudflare named tunnel/);
assert.match(files["docs/NETWORK_INGRESS.md"], /Workers plan/i);
assert.doesNotMatch(files["scripts/devspace-stable-gateway.mjs"], /C:\\\\Users\\\\enwong/i);

for (const [path, source] of Object.entries(files)) {
  if (path === "install.ps1") continue;
  assert.doesNotMatch(source, /devspace-enwong\.duckdns\.org|devspace-ultra-mcp-edge\.enwong93\.workers\.dev/i, `${path} must not ship a user-specific endpoint`);
  assert.doesNotMatch(source, /(?:api[_-]?key|token|secret)\s*[:=]\s*["'][A-Za-z0-9_\-.]{20,}["']/i, `${path} appears to contain a literal credential`);
}

console.log(JSON.stringify({
  ok: true,
  gate: "public-release-static",
  oneCommandSetup: true,
  duckDnsPrimary: true,
  cloudflareQuotaWarning: true,
  dpapiSecrets: true,
  unrestrictedCoreHeap: true,
  experimentalRecoveryDisabledByDefault: true,
  userSpecificEndpoints: false,
}));
