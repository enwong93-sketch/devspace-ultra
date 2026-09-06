import assert from "node:assert/strict";
import { registerCodexMcpCompatibilityTools } from "./mcp-compat-tools.js";

function makeServer(registrations) {
  return {
    registerTool(name, definition, handler) {
      registrations.push({ name, definition, handler });
    },
  };
}

const calls = [];
const runtime = {
  async list() {
    return [{ id: "alpha" }, { id: "beta" }];
  },
  async inspect(pluginId, { probeMcp }) {
    calls.push({ kind: "inspect", pluginId, probeMcp });
    if (pluginId === "alpha") {
      return {
        id: "alpha",
        mcpServers: [{
          id: "memory",
          status: "online",
          resources: [
            { uri: "memory://one", name: "One", mimeType: "text/plain" },
            { uri: "memory://two", name: "Two", mimeType: "text/plain" },
          ],
          resourceTemplates: [{ uriTemplate: "memory://{id}", name: "Memory" }],
        }],
      };
    }
    return {
      id: "beta",
      mcpServers: [{
        id: "memory",
        status: "online",
        resources: [{ uri: "other://one", name: "Other" }],
        resourceTemplates: [],
      }, {
        id: "browser",
        status: "online",
        resources: [{ uri: "browser://tab", name: "Tab" }],
        resourceTemplates: [{ uriTemplate: "browser://tab/{id}", name: "Tab template" }],
      }],
    };
  },
  async readMcpResource(pluginId, serverId, uri) {
    calls.push({ kind: "read", pluginId, serverId, uri });
    return { ok: true, result: { contents: [{ uri, text: `${pluginId}:${serverId}` }] } };
  },
};

const registrations = [];
registerCodexMcpCompatibilityTools(makeServer(registrations), runtime);
assert.deepEqual(registrations.map((entry) => entry.name), [
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);
for (const registration of registrations) assert.equal(registration.definition.annotations.readOnlyHint, true);

const resources = await registrations[0].handler({});
assert.equal(resources.structuredContent.ok, true);
assert.equal(resources.structuredContent.resources.length, 4);
assert.equal(resources.structuredContent.resources[0].qualifiedServer.includes("/"), true);
const browserResources = await registrations[0].handler({ server: "browser" });
assert.deepEqual(browserResources.structuredContent.resources.map((entry) => entry.uri), ["browser://tab"]);

const templates = await registrations[1].handler({ server: "beta/browser" });
assert.deepEqual(templates.structuredContent.resourceTemplates.map((entry) => entry.uriTemplate), ["browser://tab/{id}"]);

const read = await registrations[2].handler({ server: "browser", uri: "browser://tab" });
assert.equal(read.structuredContent.pluginId, "beta");
assert.equal(read.structuredContent.serverId, "browser");
assert.equal(read.structuredContent.result.contents[0].text, "beta:browser");

const ambiguous = await registrations[2].handler({ server: "memory", uri: "memory://one" });
assert.equal(ambiguous.isError, true);
assert.match(ambiguous.structuredContent.error, /ambiguous/i);
assert.match(ambiguous.structuredContent.error, /alpha\/memory/);
const qualified = await registrations[2].handler({ server: "alpha/memory", uri: "memory://two" });
assert.equal(qualified.isError, undefined);
assert.equal(qualified.structuredContent.pluginId, "alpha");

const invalidCursor = await registrations[0].handler({ cursor: "not-a-number" });
assert.equal(invalidCursor.isError, true);
assert.match(invalidCursor.structuredContent.error, /cursor/i);

console.log(JSON.stringify({
  ok: true,
  gate: "mcp-compat-tools",
  codexAliases: registrations.map((entry) => entry.name),
  ambiguousServersFailClosed: true,
  qualifiedResolution: true,
  boundedPagination: true,
}));
