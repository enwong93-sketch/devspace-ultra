import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [coreSlot, gateway, heap, path] = await Promise.all([
  readFile(new URL("./devspace-core-slot.mjs", import.meta.url), "utf8"),
  readFile(new URL("./devspace-stable-gateway.mjs", import.meta.url), "utf8"),
  readFile(new URL("../dist/core-node-options.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/windows-process-path.js", import.meta.url), "utf8"),
]);

assert.match(coreSlot, /validateCoreNodeArgs/);
assert.match(coreSlot, /resolveFreshWindowsProcessEnvironment/);
assert.match(coreSlot, /NODE_OPTIONS/);
assert.match(coreSlot, /\.\.\.safeNodeArgs, "dist\/cli\.js", "serve"/);
assert.match(coreSlot, /pathSource:\s*preparedEnvironment\.pathSource/);
assert.match(gateway, /DEVSPACE_STABLE_GATEWAY_CORE_HEAP_PROFILE/);
assert.match(gateway, /stableGatewayCoreHeapProfile/);
assert.match(gateway, /nodeArgsForCoreHeapProfile/);
assert.match(gateway, /startCoreSlot:\s*\(options\)\s*=>\s*startCoreSlot\(\{\s*\.\.\.options,\s*nodeArgs:\s*coreNodeArgs\s*\}\)/s);
assert.match(heap, /"bounded-512"/);
assert.match(heap, /--max-old-space-size=464/);
assert.match(heap, /--max-semi-space-size=16/);
assert.doesNotMatch(heap, /--require|--eval|--inspect/);
assert.match(path, /GetEnvironmentVariable\('Path','Machine'\)/);
assert.match(path, /GetEnvironmentVariable\('Path','User'\)/);
assert.match(path, /inherited-fallback/);

console.log(JSON.stringify({
  ok: true,
  gate: "stable-gateway-core-runtime-static",
  verifiedHeapProfileWired: true,
  arbitraryNodeOptionsStripped: true,
  freshWindowsPathWired: true,
  fallbackPreserved: true,
}));
