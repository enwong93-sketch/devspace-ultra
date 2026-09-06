import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityRuntime } from "./capability-runtime.js";

const root = await mkdtemp(join(tmpdir(), "devspace-capability-diagnostics-"));
try {
  const runtime = new CapabilityRuntime({
    enabled: true,
    pluginsDir: join(root, "plugins"),
    registryPath: join(root, "plugins", "registry.json"),
    pluginPaths: [],
  });
  await runtime.ready;
  runtime.mcpClients.set("fixture::shared", { client: {}, transport: {}, definition: {} });
  runtime.mcpConnecting.set("fixture::connecting", Promise.resolve());
  runtime.mcpStartupTails.set("fixture::tail", Promise.resolve());
  runtime.mcpInstances.set("instance-1", { pluginId: "fixture" });
  runtime.discovered.set("fixture", { id: "fixture" });

  assert.deepEqual(runtime.diagnostics(), {
    enabled: true,
    discoveredPlugins: 1,
    mcpClients: 1,
    mcpConnecting: 1,
    mcpStartupTails: 1,
    mcpInstances: 1,
  });

  runtime.mcpClients.clear();
  runtime.mcpConnecting.clear();
  runtime.mcpStartupTails.clear();
  runtime.mcpInstances.clear();
  runtime.discovered.clear();
  await runtime.close();
  assert.deepEqual(runtime.diagnostics(), {
    enabled: true,
    discoveredPlugins: 0,
    mcpClients: 0,
    mcpConnecting: 0,
    mcpStartupTails: 0,
    mcpInstances: 0,
  });

  console.log(JSON.stringify({
    ok: true,
    gate: "capability-runtime-diagnostics",
    boundedConnectionStateVisible: true,
    secretsExcluded: true,
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
