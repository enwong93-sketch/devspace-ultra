import assert from "node:assert/strict";
import {
  buildVpcWorkerConfig,
  buildWranglerDeployArgs,
  classifyEdgeConfig,
  extractTunnelId,
  extractVpcServiceId,
  findTunnelIdByName,
  findVpcServiceIdByName,
  extractWorkersDevUrl,
  normalizeHttpsOrigin,
  planDisableEdgeConfig,
  planFixedEdgeCandidateConfig,
  planFixedEdgeConfig,
  resolveNpxInvocation,
} from "./edge-cloudflare.js";

const origin = "https://devspace-origin.example";
const edge = "https://devspace-ultra-mcp-edge.example-subdomain.workers.dev";

function testNormalizeHttpsOrigin() {
  assert.equal(normalizeHttpsOrigin(`${origin}/`), origin);
  assert.throws(() => normalizeHttpsOrigin("http://127.0.0.1:7676"), /https/i);
  assert.throws(() => normalizeHttpsOrigin(`${origin}/mcp`), /origin base/i);
  assert.throws(() => normalizeHttpsOrigin("https://user:pass@example.com"), /credentials/i);
}

function testCandidatePlanPreservesControlIdentity() {
  const existing = {
    host: "127.0.0.1",
    port: 7676,
    publicBaseUrl: "https://control.example",
    allowedHosts: ["control.example"],
    stateDir: "C:\\state\\control",
  };
  const before = structuredClone(existing);
  const planned = planFixedEdgeCandidateConfig(existing, {
    publicBaseUrl: edge,
    workerName: "devspace-ultra-mcp-edge",
    transportMode: "workers-vpc",
    tunnelId: "11111111-2222-4333-8444-555555555555",
    tunnelName: "devspace-ultra-origin",
    vpcServiceId: "01b23456-789a-7bcd-8ef0-123456789abc",
    vpcServiceName: "devspace-ultra-local",
    backendPort: 7677,
    fixedStateDir: "C:\\state\\fixed",
  });
  assert.deepEqual(existing, before, "candidate planning must not mutate input");
  assert.equal(planned.publicBaseUrl, "https://control.example", "candidate setup must not overwrite the live control public identity");
  assert.equal(planned.port, 7676, "candidate setup must not move the control listener");
  assert.equal(planned.stateDir, "C:\\state\\control", "candidate setup must not replace control state");
  assert.equal(planned.edgePublicBaseUrl, edge);
  assert.equal(planned.edgeBackendPort, 7677);
  assert.equal(planned.edgeFixedStateDir, "C:\\state\\fixed");
  assert.ok(planned.allowedHosts.includes("control.example"));
  assert.ok(planned.allowedHosts.includes("devspace-ultra-mcp-edge.example-subdomain.workers.dev"));
}

function testPlanPreservesExistingConfig() {
  const existing = {
    host: "127.0.0.1",
    port: 7676,
    allowedRoots: ["C:\\", "D:\\"],
    publicBaseUrl: origin,
    allowedHosts: ["legacy.example"],
    autoCompactEnabled: true,
    autoCompactThreshold: 0.9,
    pluginPaths: ["C:\\plugins"],
  };
  const before = structuredClone(existing);
  const planned = planFixedEdgeConfig(existing, {
    originBaseUrl: origin,
    publicBaseUrl: edge,
    workerName: "devspace-ultra-mcp-edge",
    transportMode: "workers-vpc",
    tunnelId: "11111111-2222-4333-8444-555555555555",
    tunnelName: "devspace-ultra-origin",
    vpcServiceId: "01b23456-789a-7bcd-8ef0-123456789abc",
    vpcServiceName: "devspace-ultra-local",
  });

  assert.deepEqual(existing, before, "planning must not mutate persisted config input");
  assert.deepEqual(planned.allowedRoots, existing.allowedRoots);
  assert.deepEqual(planned.pluginPaths, existing.pluginPaths);
  assert.equal(planned.autoCompactEnabled, true);
  assert.equal(planned.autoCompactThreshold, 0.9);
  assert.equal(planned.publicBaseUrl, edge);
  assert.equal(planned.edgeProvider, "cloudflare-worker");
  assert.equal(planned.edgeOriginBaseUrl, origin);
  assert.equal(planned.edgePublicBaseUrl, edge);
  assert.equal(planned.edgeWorkerName, "devspace-ultra-mcp-edge");
  assert.equal(planned.edgeTransportMode, "workers-vpc");
  assert.equal(planned.edgeTunnelId, "11111111-2222-4333-8444-555555555555");
  assert.equal(planned.edgeTunnelName, "devspace-ultra-origin");
  assert.equal(planned.edgeVpcServiceId, "01b23456-789a-7bcd-8ef0-123456789abc");
  assert.equal(planned.edgeVpcServiceName, "devspace-ultra-local");
  assert.deepEqual(new Set(planned.allowedHosts), new Set([
    "legacy.example",
    "localhost",
    "127.0.0.1",
    "::1",
    "devspace-origin.example",
    "devspace-ultra-mcp-edge.example-subdomain.workers.dev",
  ]));
}

function testClassifyEdgeConfig() {
  assert.equal(classifyEdgeConfig({ publicBaseUrl: "https://random.trycloudflare.com" }).mode, "temporary");
  assert.equal(classifyEdgeConfig({ publicBaseUrl: origin }).mode, "direct");
  assert.equal(classifyEdgeConfig({
    publicBaseUrl: "https://control.trycloudflare.com",
    edgeProvider: "cloudflare-worker",
    edgeTransportMode: "workers-vpc",
    edgePublicBaseUrl: edge,
    edgeTunnelId: "11111111-2222-4333-8444-555555555555",
    edgeVpcServiceId: "01b23456-789a-7bcd-8ef0-123456789abc",
    edgeBackendPort: 7677,
  }).mode, "fixed", "a fixed isolated edge must remain fixed even while the live control backend keeps a temporary/canary publicBaseUrl");
  assert.equal(classifyEdgeConfig({
    publicBaseUrl: origin,
    edgeProvider: "cloudflare-worker",
    edgeTransportMode: "workers-vpc",
    edgePublicBaseUrl: edge,
    edgeTunnelId: "11111111-2222-4333-8444-555555555555",
  }).mode, "misconfigured", "Workers VPC edge metadata is incomplete without a VPC service id");
}

function testDisablePreservesControlIdentity() {
  const existing = {
    host: "127.0.0.1",
    port: 7676,
    publicBaseUrl: "https://control.trycloudflare.com",
    stateDir: "C:\\state\\control",
    edgeProvider: "cloudflare-worker",
    edgeTransportMode: "workers-vpc",
    edgePublicBaseUrl: edge,
    edgeBackendPort: 7677,
    edgeFixedStateDir: "C:\\state\\fixed",
    edgeTunnelId: "11111111-2222-4333-8444-555555555555",
    edgeVpcServiceId: "01b23456-789a-7bcd-8ef0-123456789abc",
  };
  const disabled = planDisableEdgeConfig(existing);
  assert.equal(disabled.publicBaseUrl, existing.publicBaseUrl);
  assert.equal(disabled.port, 7676);
  assert.equal(disabled.stateDir, existing.stateDir);
  assert.equal(disabled.edgeProvider, undefined);
  assert.equal(disabled.edgeBackendPort, undefined);
  assert.equal(disabled.edgeFixedStateDir, undefined);
}

function testCloudflareResourceListParsing() {
  const tunnelList = `│ 12345678-1234-4234-9234-123456789abc │ devspace-ultra-origin │ healthy │ now │ cfd_tunnel │`;
  const serviceList = `│ 01b23456-789a-7bcd-8ef0-123456789abc │ devspace-ultra-local │ http │ HTTP:7676 │ 127.0.0.1 │ 12345678... │`;
  assert.equal(findTunnelIdByName(tunnelList, "devspace-ultra-origin"), "12345678-1234-4234-9234-123456789abc");
  assert.equal(findVpcServiceIdByName(serviceList, "devspace-ultra-local"), "01b23456-789a-7bcd-8ef0-123456789abc");
  assert.equal(findTunnelIdByName(tunnelList, "missing"), null);
  assert.equal(findVpcServiceIdByName(serviceList, "missing"), null);
}

function testCloudflareResourceIdExtraction() {
  assert.equal(extractTunnelId(`Created tunnel.\nID: 11111111-2222-4333-8444-555555555555\nName: devspace-ultra-origin`), "11111111-2222-4333-8444-555555555555");
  assert.equal(extractVpcServiceId(`Created VPC service: 01b23456-789a-7bcd-8ef0-123456789abc\nName: devspace-ultra-local`), "01b23456-789a-7bcd-8ef0-123456789abc");
  assert.throws(() => extractTunnelId("Created tunnel without id"), /tunnel id/i);
  assert.throws(() => extractVpcServiceId("Created VPC service without id"), /VPC service id/i);
}

function testVpcWorkerConfigUsesPrivateBinding() {
  const config = buildVpcWorkerConfig({
    workerName: "devspace-ultra-mcp-edge",
    mainPath: "src/index.js",
    serviceId: "01b23456-789a-7bcd-8ef0-123456789abc",
  });
  assert.equal(config.name, "devspace-ultra-mcp-edge");
  assert.equal(config.workers_dev, true);
  assert.equal(config.vpc_services[0].binding, "PRIVATE_ORIGIN");
  assert.equal(config.vpc_services[0].service_id, "01b23456-789a-7bcd-8ef0-123456789abc");
  assert.equal(config.vars, undefined, "VPC production config must not require a public origin URL");
}

function testWorkersDevExtraction() {
  const output = `Uploaded devspace-ultra-mcp-edge\nDeployed devspace-ultra-mcp-edge triggers\n  https://devspace-ultra-mcp-edge.example-subdomain.workers.dev\nCurrent Version ID: abc`;
  assert.equal(extractWorkersDevUrl(output), edge);
  assert.throws(() => extractWorkersDevUrl("deployed without route"), /workers\.dev/i);
}

function testWindowsNpxUsesNodeCliInsteadOfCmdShim() {
  const invocation = resolveNpxInvocation(["wrangler@4", "whoami"], {
    platform: "win32",
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    npxCliPath: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js",
  });
  assert.equal(invocation.command, "C:\\Program Files\\nodejs\\node.exe");
  assert.deepEqual(invocation.args, [
    "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js",
    "wrangler@4",
    "whoami",
  ]);
}

function testWranglerArgsAreFixedOriginOnly() {
  const args = buildWranglerDeployArgs({
    originBaseUrl: origin,
    workerName: "devspace-ultra-mcp-edge",
    configPath: "edge/cloudflare-worker/wrangler.jsonc",
  });
  assert.deepEqual(args, [
    "wrangler@4",
    "deploy",
    "--config",
    "edge/cloudflare-worker/wrangler.jsonc",
    "--name",
    "devspace-ultra-mcp-edge",
    "--var",
    `ORIGIN_BASE_URL:${origin}`,
  ]);
  assert.equal(args.some((entry) => /token|password|secret/i.test(entry)), false);
}

testNormalizeHttpsOrigin();
testCandidatePlanPreservesControlIdentity();
testPlanPreservesExistingConfig();
testClassifyEdgeConfig();
testDisablePreservesControlIdentity();
testCloudflareResourceListParsing();
testCloudflareResourceIdExtraction();
testVpcWorkerConfigUsesPrivateBinding();
testWorkersDevExtraction();
testWindowsNpxUsesNodeCliInsteadOfCmdShim();
testWranglerArgsAreFixedOriginOnly();

console.log(JSON.stringify({ ok: true, gate: "edge-cloudflare", tests: 11 }));
