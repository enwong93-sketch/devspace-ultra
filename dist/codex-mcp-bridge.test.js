import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexMcpBridge, registerCodexMcpBridgeTools } from "./codex-mcp-bridge.js";

function toml(value) {
  return JSON.stringify(String(value));
}

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, definition, handler) {
      tools.set(name, { definition, handler });
    },
  };
}

const root = await mkdtemp(join(tmpdir(), "devspace-codex-mcp-bridge-"));
const codexHome = join(root, ".codex");
await mkdir(codexHome, { recursive: true });
const serverPath = join(root, "fixture-server.mjs");
const configPath = join(codexHome, "config.toml");
const mcpServerModule = import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js");
const stdioServerModule = import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js");
const zodModule = import.meta.resolve("zod/v4");

await writeFile(serverPath, `
import { McpServer, ResourceTemplate } from ${JSON.stringify(mcpServerModule)};
import { StdioServerTransport } from ${JSON.stringify(stdioServerModule)};
import * as z from ${JSON.stringify(zodModule)};
const server = new McpServer({name:'codex-bridge-fixture', version:'1.0.0'});
server.registerTool('read_fixture', {
  description:'Read fixture state',
  inputSchema:{value:z.string().optional()},
  annotations:{readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false}
}, async ({value}) => ({content:[{type:'text', text:JSON.stringify({kind:'read', value:value||null, secretPresent:Boolean(process.env.BRIDGE_SECRET)})}]}));
server.registerTool('write_fixture', {
  description:'Write fixture state',
  inputSchema:{value:z.string()},
  annotations:{readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:false}
}, async ({value}) => ({content:[{type:'text', text:JSON.stringify({kind:'write', value})}]}));
server.registerTool('blocked_fixture', {inputSchema:{}}, async () => ({content:[{type:'text', text:'blocked'}]}));
server.registerResource('status', 'fixture://status', {description:'Fixture status', mimeType:'text/plain'}, async (uri) => ({contents:[{uri:String(uri), mimeType:'text/plain', text:'status-ok'}]}));
server.registerResource('item', new ResourceTemplate('fixture://item/{id}', {list: undefined}), {mimeType:'application/json'}, async (uri, variables) => ({contents:[{uri:String(uri), mimeType:'application/json', text:JSON.stringify({id:variables.id})}]}));
server.registerPrompt('review', {description:'Review fixture', argsSchema:{topic:z.string()}}, async ({topic}) => ({messages:[{role:'user', content:{type:'text', text:'review:'+topic}}]}));
await server.connect(new StdioServerTransport());
`);

await writeFile(configPath, `
[mcp_servers.fixture]
command = ${toml(process.execPath)}
args = [${toml(serverPath)}]
env = { BRIDGE_SECRET = "super-secret-value" }
env_vars = ["INHERITED_FIXTURE"]
startup_timeout_sec = 20
tool_timeout_sec = 20
default_tools_approval_mode = "writes"
enabled_tools = ["read_fixture", "write_fixture", "blocked_fixture"]
disabled_tools = ["blocked_fixture"]

[mcp_servers.fixture.tools.write_fixture]
approval_mode = "prompt"

[mcp_servers.disabled]
command = ${toml(process.execPath)}
args = [${toml(serverPath)}]
enabled = false

[mcp_servers.devspace]
command = ${toml(process.execPath)}
args = [${toml(serverPath)}]

[mcp_servers.powermem]
url = "http://127.0.0.1:8848/mcp"

[mcp_servers.windows-mcp-elevated]
command = ${toml(process.execPath)}
args = [${toml(serverPath)}]
default_tools_approval_mode = "approve"

[mcp_servers.inline-token]
url = "https://user:pass@example.invalid/mcp?token=must-not-leak"
bearer_token = "inline-secret-must-not-run"
http_headers = { "X-Secret" = "literal-header-secret" }
`, "utf8");

const bridge = new CodexMcpBridge({
  codexHome,
  env: { ...process.env, INHERITED_FIXTURE: "inherited-value" },
});
try {
  await bridge.ready;
  const catalog = await bridge.catalog({ includeDisabled: true });
  assert.equal(catalog.ok, true);
  assert.equal(catalog.executionPolicy, "full-access");
  assert.equal(catalog.servers.length, 6);
  const serializedCatalog = JSON.stringify(catalog);
  for (const secret of [
    "super-secret-value",
    "inherited-value",
    "inline-secret-must-not-run",
    "literal-header-secret",
    "must-not-leak",
    "user:pass",
  ]) {
    assert.equal(serializedCatalog.includes(secret), false, `catalog leaked ${secret}`);
  }
  const fixtureSummary = catalog.servers.find((server) => server.id === "fixture");
  assert.equal(fixtureSummary.runnable, true);
  assert.equal(fixtureSummary.commandName.toLowerCase().includes("node"), true);
  assert.equal(fixtureSummary.argumentCount, 1);
  assert.deepEqual(fixtureSummary.environmentNames.sort(), ["BRIDGE_SECRET", "INHERITED_FIXTURE"]);
  assert.equal(catalog.servers.find((server) => server.id === "disabled").runnable, false);
  assert.match(catalog.servers.find((server) => server.id === "devspace").skipReason, /recursion/);
  assert.match(catalog.servers.find((server) => server.id === "powermem").skipReason, /duplicate shared PowerMem/);
  const inline = catalog.servers.find((server) => server.id === "inline-token");
  assert.equal(inline.inlineBearerTokenRejected, true);
  assert.equal(inline.url, "https://example.invalid/mcp");

  const inspected = await bridge.probe("fixture");
  assert.equal(inspected.status, "online");
  assert.equal(inspected.capabilities.tools, true);
  assert.deepEqual(inspected.tools.map((tool) => tool.name), ["read_fixture", "write_fixture"]);
  assert.equal(inspected.tools[0].canonicalName, "mcp__fixture__read_fixture");
  assert.equal(inspected.resources.some((resource) => resource.uri === "fixture://status"), true);
  assert.equal(inspected.resourceTemplates.some((resource) => resource.uriTemplate === "fixture://item/{id}"), true);
  assert.equal(inspected.prompts.some((prompt) => prompt.name === "review"), true);

  const readCall = await bridge.callTool({
    serverId: "fixture",
    toolName: "read_fixture",
    arguments: { value: "hello" },
  });
  assert.equal(readCall.ok, true, "readOnlyHint=true must pass writes mode without a prompt");
  const readText = JSON.parse(readCall.result.content[0].text);
  assert.equal(readText.kind, "read");
  assert.equal(readText.value, "hello");
  assert.equal(readText.secretPresent, true);
  assert.equal(readCall.result.content[0].text.includes("super-secret-value"), false);

  const writeCall = await bridge.callTool({
    serverId: "fixture",
    toolName: "write_fixture",
    arguments: { value: "change" },
  });
  assert.equal(writeCall.ok, true);
  assert.equal(writeCall.approvalRequired, false);
  assert.equal(writeCall.approvalMode, "full-access");
  assert.equal(writeCall.configuredApprovalMode, "prompt");
  assert.equal(typeof writeCall.requestKey, "string");
  assert.equal(JSON.parse(writeCall.result.content[0].text).kind, "write");
  await assert.rejects(
    () => bridge.callTool({ serverId: "fixture", toolName: "blocked_fixture" }),
    /disabled by enabled_tools or disabled_tools/,
  );

  const elevatedCall = await bridge.callTool({
    serverId: "windows-mcp-elevated",
    toolName: "read_fixture",
    arguments: {},
  });
  assert.equal(elevatedCall.ok, true);
  assert.equal(elevatedCall.approvalRequired, false, "full-access policy must not add a local elevated-server approval barrier");

  const resources = await bridge.listResources("fixture");
  assert.equal(resources.resources[0].uri, "fixture://status");
  const templates = await bridge.listResourceTemplates("fixture");
  assert.equal(templates.resourceTemplates[0].uriTemplate, "fixture://item/{id}");
  const readResource = await bridge.readResource("fixture", "fixture://status");
  assert.equal(readResource.result.contents[0].text, "status-ok");

  const search = await bridge.search("read fixture", { limit: 10 });
  assert.equal(search[0].id, "fixture");
  assert.equal(bridge.diagnostics().clients >= 2, true);
  assert.equal(bridge.diagnostics().executionPolicy, "full-access");

  const registered = fakeServer();
  registerCodexMcpBridgeTools(registered, bridge);
  for (const name of [
    "codex_mcp_catalog",
    "codex_mcp_refresh",
    "codex_mcp_inspect",
    "codex_mcp_call",
    "codex_mcp_list_resources",
    "codex_mcp_list_resource_templates",
    "codex_mcp_read_resource",
  ]) {
    assert.ok(registered.tools.has(name), `missing ${name}`);
  }
  const resourceTool = await registered.tools.get("codex_mcp_read_resource").handler({
    serverId: "fixture",
    uri: "fixture://status",
  });
  assert.equal(resourceTool.content[0].type, "resource");
  assert.equal(resourceTool.content[0].resource.text, "status-ok");

  await writeFile(configPath, "[mcp_servers.broken\ncommand = 'x'", "utf8");
  const refreshed = await bridge.refresh({ failOpen: true });
  assert.equal(refreshed.ok, false);
  const failedCatalog = await bridge.catalog();
  assert.equal(failedCatalog.servers.length, 0);
  assert.equal(typeof failedCatalog.configError, "string");

  console.log(JSON.stringify({
    ok: true,
    gate: "codex-mcp-bridge",
    secretsNeverReturned: true,
    sameConfigNotCopied: true,
    fullAccessOnly: true,
    configuredApprovalMetadataPreserved: true,
    toolFiltersEnforced: true,
    resourcesAndPrompts: true,
    invalidTomlFailsOpen: true,
  }));
} finally {
  await bridge.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
