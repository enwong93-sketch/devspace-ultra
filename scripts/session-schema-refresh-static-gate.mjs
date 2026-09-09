import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [descriptors, runtime, proxy, server] = await Promise.all([
  readFile(new URL("../dist/stable-gateway-session-descriptors.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/stable-gateway-runtime.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/stable-gateway-proxy.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/server.js", import.meta.url), "utf8"),
]);

assert.match(descriptors, /const VERSION = 3/);
assert.match(descriptors, /const LEGACY_VERSIONS = new Set\(\[1, 2\]\)/);
assert.match(descriptors, /clientSessionFingerprint/);
assert.match(descriptors, /schemaFingerprint/);
assert.match(descriptors, /toolCount/);
assert.match(descriptors, /item\?\.initialized === true[\s\S]*!fingerprint[\s\S]*return null/);
assert.doesNotMatch(descriptors, /authorization|backendSessionId/, "Persisted descriptors must never contain replay credentials or private Core session ids.");

assert.match(runtime, /updateSchema\(publicSessionId/);
assert.match(runtime, /schemaFingerprint/);
assert.match(runtime, /toolCount/);

assert.match(proxy, /MAX_TOOL_LIST_CAPTURE_BYTES/);
assert.match(proxy, /parsedBody\?\.method === "tools\/list"/);
assert.match(proxy, /schemaFingerprint\(tools\)/);
assert.match((await readFile(new URL("../dist/stable-gateway-candidate.js", import.meta.url), "utf8")), /description:\s*String\(tool\?\.description/);
assert.match((await readFile(new URL("../dist/stable-gateway-candidate.js", import.meta.url), "utf8")), /outputSchema:\s*tool\?\.outputSchema/);
assert.match((await readFile(new URL("../dist/stable-gateway-candidate.js", import.meta.url), "utf8")), /_meta:\s*tool\?\._meta/);
assert.match(proxy, /class StaleSessionSchemaError/);
assert.match(proxy, /MCP_SCHEMA_STALE/);
assert.match(proxy, /registry\.remove\?\./);
assert.match(proxy, /statusCode = staleSchema \? 404 : 502/);
assert.match(proxy, /readBackendToolSchema/);
assert.match(proxy, /assertSessionSchemaCompatible/);
assert.match(proxy, /stampInitializedSessionSchema/);
assert.match(proxy, /initializeRequest[\s\S]*stampInitializedSessionSchema/);
assert.match(proxy, /schemaOverflow/);

assert.match(server, /registerCodexParityTools/);
assert.match(server, /registerIncomingImageTools/);
assert.match(server, /inspect_attached_image/);
assert.match(server, /view_image/);
assert.ok(server.includes("sendToolListChanged"),
  "every fresh/replayed Core transport must notify the host that the complete tool list is available");
assert.ok(server.includes('notifyToolSurfaceRefresh(transport, "event-stream-open")'),
  "a replayed public session must refresh the ChatGPT tool list as soon as its real SSE stream reconnects");
assert.ok(server.includes('notifyToolSurfaceRefresh(transport, "client-initialized")'),
  "a fresh host initialization must also receive one explicit tool-list refresh notification");

console.log(JSON.stringify({
  ok: true,
  gate: "session-schema-refresh-static",
  descriptorVersion: 3,
  clientSessionFingerprintPersisted: true,
  unknownSchemaDroppedAtStartup: true,
  schemaFingerprintPersisted: true,
  descriptionsAndOutputSchemaFingerprint: true,
  routingAndUiMetadataFingerprint: true,
  proactiveInitializeSchemaStamp: true,
  boundedToolsListCapture: true,
  staleSchemaForcesFreshInitialize: true,
  activeHostToolListRefresh: true,
  credentialsPersisted: false,
}));
