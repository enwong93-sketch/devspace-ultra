import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityRuntime, registerCapabilityTools } from "./capability-runtime.js";

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, definition, handler) {
      tools.set(name, { definition, handler });
    },
  };
}

const root = await mkdtemp(join(tmpdir(), "devspace-capability-resources-"));
const pluginRoot = join(root, "resource-plugin");
await mkdir(pluginRoot, { recursive: true });
const mcpServerModule = import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js");
const stdioServerModule = import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js");
const zodModule = import.meta.resolve("zod/v4");

await writeFile(join(pluginRoot, "devspace-plugin.json"), JSON.stringify({
  id: "resource-fixture",
  name: "Resource Fixture",
  version: "1.0.0",
  mcpServers: {
    full: { command: process.execPath, args: ["full-server.mjs"], cwd: "." },
    "tool-only": { command: process.execPath, args: ["tool-only-server.mjs"], cwd: "." },
  },
}, null, 2));

await writeFile(join(pluginRoot, "full-server.mjs"), `
import { McpServer, ResourceTemplate } from ${JSON.stringify(mcpServerModule)};
import { StdioServerTransport } from ${JSON.stringify(stdioServerModule)};
import * as z from ${JSON.stringify(zodModule)};
const server = new McpServer({name:'resource-fixture-full', version:'1.0.0'});
server.registerTool('ping', {inputSchema:{value:z.string().optional()}}, async ({value}) => ({content:[{type:'text', text:'pong:'+String(value||'')}]}));
server.registerResource('status', 'memory://status', {description:'Fixture status', mimeType:'text/plain'}, async (uri) => ({contents:[{uri:String(uri), mimeType:'text/plain', text:'resource-ok'}]}));
server.registerResource('item', new ResourceTemplate('memory://item/{id}', {list: undefined}), {description:'Fixture item template', mimeType:'application/json'}, async (uri, variables) => ({contents:[{uri:String(uri), mimeType:'application/json', text:JSON.stringify({id:variables.id})}]}));
await server.connect(new StdioServerTransport());
`);
await writeFile(join(pluginRoot, "tool-only-server.mjs"), `
import { McpServer } from ${JSON.stringify(mcpServerModule)};
import { StdioServerTransport } from ${JSON.stringify(stdioServerModule)};
import * as z from ${JSON.stringify(zodModule)};
const server = new McpServer({name:'resource-fixture-tool-only', version:'1.0.0'});
server.registerTool('fetch_url', {inputSchema:{url:z.string()}}, async ({url}) => ({content:[{type:'text', text:'fetched:'+url}]}));
await server.connect(new StdioServerTransport());
`);

const runtime = new CapabilityRuntime({
  enabled: true,
  pluginsDir: join(root, "plugins"),
  registryPath: join(root, "plugins", "registry.json"),
  pluginPaths: [pluginRoot],
});
try {
  await runtime.ready;
  const catalog = runtime.mcpServerCatalog();
  assert.deepEqual(catalog.map((row) => row.server), [
    "resource-fixture/full",
    "resource-fixture/tool-only",
  ]);

  const listed = await runtime.listMcpResources({ limit: 20 });
  assert.equal(listed.ok, true);
  const full = listed.resources.find((row) => row.server === "resource-fixture/full");
  const toolOnly = listed.resources.find((row) => row.server === "resource-fixture/tool-only");
  assert.equal(full.supported, true);
  assert.equal(full.resources.some((resource) => resource.uri === "memory://status"), true);
  assert.equal(toolOnly.supported, false, "tool-only MCP must remain online even with no resource capability");
  assert.deepEqual(toolOnly.resources, []);

  const templates = await runtime.listMcpResourceTemplates({ server: "resource-fixture/full" });
  assert.equal(templates.resourceTemplates[0].resourceTemplates[0].uriTemplate, "memory://item/{id}");
  await assert.rejects(
    () => runtime.listMcpResources({ cursor: "opaque-without-server" }),
    /cursor requires an explicit server/,
  );

  const read = await runtime.readMcpResourceByServer({
    server: "resource-fixture/full",
    uri: "memory://status",
  });
  assert.equal(read.result.contents[0].text, "resource-ok");
  const aliasRead = await runtime.readMcpResourceByServer({ server: "full", uri: "memory://status" });
  assert.equal(aliasRead.result.contents[0].text, "resource-ok");
  assert.throws(() => runtime.resolveMcpServer("missing"), /Available server keys/);

  const server = fakeServer();
  registerCapabilityTools(server, runtime);
  for (const required of ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]) {
    assert.ok(server.tools.has(required), `missing generic MCP resource tool ${required}`);
  }
  const toolResult = await server.tools.get("read_mcp_resource").handler({
    server: "resource-fixture/full",
    uri: "memory://status",
  });
  assert.equal(toolResult.structuredContent.ok, true);
  assert.equal(toolResult.content[0].type, "resource");
  assert.equal(toolResult.content[0].resource.text, "resource-ok");

  console.log(JSON.stringify({
    ok: true,
    gate: "capability-mcp-resources",
    genericResourceTools: true,
    toolOnlyServerNotMisclassified: true,
    serverKeysExplicit: true,
  }));
} finally {
  await runtime.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
