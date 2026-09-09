import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityRuntime } from "./capability-runtime.js";

const root = await mkdtemp(join(tmpdir(), "devspace-network-setup-plugin-"));
const pluginRoot = fileURLToPath(new URL("../capabilities/devspace-network-setup/", import.meta.url));
const runtime = new CapabilityRuntime({
  enabled: true,
  pluginsDir: join(root, "plugins"),
  registryPath: join(root, "plugins", "registry.json"),
  pluginPaths: [pluginRoot],
});
try {
  await runtime.ready;
  const inspected = await runtime.inspect("devspace-network-setup", { probeMcp: false });
  assert.equal(inspected.enabled, true);
  assert.equal(inspected.trusted, true);
  const skill = inspected.skills.find((item) => /devspace-network-setup[\\/]SKILL\.md$/i.test(item.filePath || item.path || item));
  assert.ok(skill, "network setup skill must be discoverable");
  const resourcePath = skill.path || skill.filePath;
  const read = await runtime.readResource("devspace-network-setup", resourcePath);
  assert.match(read.content, /DuckDNS\/DDNS \+ Caddy/);
  assert.match(read.content, /Cloudflare named tunnel/);
  assert.match(read.content, /Never ask the user to paste a DuckDNS token/);
  assert.match(read.content, /execute every safe local inspection and setup command yourself/i);
  assert.match(read.content, /meaningful medium-sized setup phase/i);
  const routed = await runtime.route("install DevSpace with DuckDNS and guide me through router forwarding", { limit: 5 });
  assert.equal(routed.primary?.pluginId, "devspace-network-setup");
  assert.equal(routed.primary?.kind, "skill");
  assert.match(String(routed.primary?.path || ""), /SKILL\.md$/i);

  console.log(JSON.stringify({
    ok: true,
    gate: "network-setup-plugin",
    builtInCapability: true,
    skillDiscovered: true,
    duckDnsPrimary: true,
    cloudflareFallback: true,
    manualAccountRouterGuidance: true,
    secretSafe: true,
  }));
} finally {
  await runtime.close();
  await rm(root, { recursive: true, force: true });
}
