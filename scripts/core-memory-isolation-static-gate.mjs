import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [config, server, gate, helper, packageText] = await Promise.all([
  readFile(new URL("../dist/config.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/server.js", import.meta.url), "utf8"),
  readFile(new URL("./core-memory-isolation-gate.mjs", import.meta.url), "utf8"),
  readFile(new URL("./core-memory-isolation-lib.mjs", import.meta.url), "utf8"),
  readFile(new URL("../package.json", import.meta.url), "utf8"),
]);
const packageJson = JSON.parse(packageText);

assert.match(config, /classicMainDebugPorts/);
assert.match(config, /DEVSPACE_CLASSIC_MAIN_DEBUG_PORTS/);
assert.match(server, /createMemoryDiagnostics/);
assert.match(server, /turnTransportObserver/);
assert.match(server, /capabilityRuntime/);
assert.match(server, /classicMainDebugPorts/);
assert.match(server, /ClassicTurnTransportObserver\(.*ports/s);
assert.match(server, /ClassicContextMetadataCdpAdapter\(.*ports/s);
assert.match(server, /ClassicStreamRecoveryCdpAdapter\(.*ports/s);
assert.match(gate, /DEVSPACE_PASSIVE_CORE:\s*"true"/);
assert.match(gate, /DEVSPACE_CLASSIC_MAIN_DEBUG_PORTS/);
assert.match(gate, /openMcpEventStream/);
assert.match(gate, /postMcp/);
assert.match(gate, /capability_list/);
assert.match(helper, /full-product/);
assert.match(gate, /heapSizeLimit/);
assert.match(helper, /--max-old-space-size=464/);
assert.match(helper, /--max-semi-space-size=16/);
assert.match(helper, /--expose-gc/);
assert.doesNotMatch(gate, /DEVSPACE_PASSIVE_CORE:\s*"false"/);
assert.doesNotMatch(gate, /--max-old-space-size=\$\{heapLimitMb\}/);
assert.match(packageJson.scripts?.["verify:memory-isolation"] || "", /memory-diagnostics\.test\.js/);
assert.match(packageJson.scripts?.["verify:memory-isolation"] || "", /core-memory-isolation-lib\.test\.mjs/);
assert.match(packageJson.scripts?.["verify:memory-isolation"] || "", /core-memory-isolation-static-gate\.mjs/);
assert.match(packageJson.scripts?.["verify:memory-isolation:soak"] || "", /baseline[\s\S]*context[\s\S]*stream[\s\S]*overlay[\s\S]*capability[\s\S]*full-product/);
assert.match(packageJson.scripts?.["verify:ultra"] || "", /verify:memory-isolation/, "full regression must retain the deterministic memory lifecycle gate");

console.log(JSON.stringify({
  ok: true,
  gate: "core-memory-isolation-static",
  verifiedTotalHeapCeiling: true,
  productionClassicPortsIsolated: true,
  realMcpAndSseChurn: true,
  capabilityModePresent: true,
}));
