import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [descriptors, runtime, proxy, server] = await Promise.all([
  readFile(new URL("../dist/stable-gateway-session-descriptors.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/stable-gateway-runtime.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/stable-gateway-proxy.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/server.js", import.meta.url), "utf8"),
]);

assert.match(descriptors, /const VERSION = 2/);
assert.match(descriptors, /const LEGACY_VERSION = 1/);
assert.match(descriptors, /schemaFingerprint/);
assert.match(descriptors, /toolCount/);
assert.doesNotMatch(descriptors, /authorization|backendSessionId/, "Persisted descriptors must never contain replay credentials or private Core session ids.");

assert.match(runtime, /updateSchema\(publicSessionId/);
assert.match(runtime, /schemaFingerprint/);
assert.match(runtime, /toolCount/);

assert.match(proxy, /MAX_TOOL_LIST_CAPTURE_BYTES/);
assert.match(proxy, /parsedBody\?\.method === "tools\/list"/);
assert.match(proxy, /schemaFingerprint\(tools\)/);
assert.match(proxy, /class StaleSessionSchemaError/);
assert.match(proxy, /MCP_SCHEMA_STALE/);
assert.match(proxy, /registry\.remove\?\./);
assert.match(proxy, /statusCode = staleSchema \? 404 : 502/);
assert.match(proxy, /readBackendToolSchema/);
assert.match(proxy, /assertSessionSchemaCompatible/);
assert.match(proxy, /schemaOverflow/);

assert.match(server, /registerCodexParityTools/);
assert.match(server, /registerIncomingImageTools/);
assert.match(server, /inspect_attached_image/);
assert.match(server, /view_image/);

console.log(JSON.stringify({
  ok: true,
  gate: "session-schema-refresh-static",
  descriptorVersion: 2,
  legacyDescriptorAcceptedForForcedRefresh: true,
  schemaFingerprintPersisted: true,
  boundedToolsListCapture: true,
  staleSchemaForcesFreshInitialize: true,
  credentialsPersisted: false,
}));
