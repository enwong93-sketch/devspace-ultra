import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadIncomingImage, registerIncomingImageTools } from "./incoming-image-tools.js";
import { IncomingArtifactAdapterRegistry } from "./incoming-artifacts.js";

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const reference = {
  download_url: "https://files.oaiusercontent.com/file-test",
  file_id: "file-test",
  mime_type: "image/png",
  file_name: "reference.png",
  size: png.length,
};
const adapter = {
  id: "fixture-image",
  canHandle(value) { return value?.file_id === "file-test"; },
  async open() {
    return {
      name: "reference.png",
      mimeType: "image/png",
      size: png.length,
      stream: Readable.from([png.subarray(0, 8), png.subarray(8)]),
    };
  },
};

const registry = new IncomingArtifactAdapterRegistry([adapter]);
const loaded = await loadIncomingImage({ registry, file: reference, maxBytes: 1024 });
assert.equal(loaded.mimeType, "image/png");
assert.equal(loaded.bytes, png.length);
assert.equal(loaded.filename, "reference.png");
assert.deepEqual(loaded.data, png);
await assert.rejects(() => loadIncomingImage({ registry, file: reference, maxBytes: 8 }), /exceeds/i);

const invalidRegistry = new IncomingArtifactAdapterRegistry([{
  id: "invalid-image",
  canHandle() { return true; },
  async open() {
    const data = Buffer.from("not-an-image");
    return { name: "bad.png", mimeType: "image/png", size: data.length, stream: Readable.from([data]) };
  },
}]);
await assert.rejects(() => loadIncomingImage({ registry: invalidRegistry, file: reference }), /not a valid/i);

const mismatchRegistry = new IncomingArtifactAdapterRegistry([{
  id: "mismatch-image",
  canHandle() { return true; },
  async open() {
    return { name: "bad.jpg", mimeType: "image/jpeg", size: png.length, stream: Readable.from([png]) };
  },
}]);
await assert.rejects(() => loadIncomingImage({ registry: mismatchRegistry, file: reference }), /does not match/i);

const server = new McpServer({ name: "incoming-image-test", version: "1" });
registerIncomingImageTools(server, { incomingArtifactAdapters: [adapter], maxImageBytes: 1024 });
const client = new Client({ name: "incoming-image-client", version: "1" });
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = await client.listTools();
  const tool = tools.tools.find((item) => item.name === "inspect_attached_image");
  assert.ok(tool);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.deepEqual(tool._meta?.["openai/fileParams"], ["file"]);

  const result = await client.callTool({
    name: "inspect_attached_image",
    arguments: { file: reference, detail: "original" },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.route, "chatgpt-native-file");
  assert.equal(result.structuredContent.persistedToDisk, false);
  assert.equal(result.structuredContent.detail, "original");
  assert.equal(result.structuredContent.filename, "reference.png");
  assert.equal(result.content.some((item) => item.type === "image" && item.mimeType === "image/png"), true);
  assert.equal(result.content.some((item) => item.type === "text" && /authorized native-file route/i.test(item.text)), true);

  const rejected = await client.callTool({
    name: "inspect_attached_image",
    arguments: {
      file: { ...reference, file_id: "unknown-file", download_url: "https://example.invalid/image.png" },
    },
  });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.errorCode, "unsupported_incoming_artifact");

  console.log(JSON.stringify({
    ok: true,
    gate: "incoming-image-tools",
    nativeFileParam: true,
    readOnly: true,
    boundedBytes: true,
    signatureValidated: true,
    mimeValidated: true,
    arbitraryUrlRejected: true,
    diskWrites: 0,
  }));
} finally {
  await client.close();
  await server.close();
}
