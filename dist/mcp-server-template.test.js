import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { createMcpSessionServerFromTemplate, mcpServerTemplateDiagnostics } from "./mcp-server-template.js";

const template = new McpServer({ name: "template-test", version: "1" }, {
  instructions: "shared instructions",
  capabilities: { logging: {} },
});
let calls = 0;
template.registerTool("shared_tool", {
  description: "One shared schema and handler.",
  inputSchema: { value: z.string() },
}, async ({ value }) => {
  calls += 1;
  return { content: [{ type: "text", text: value }] };
});
template.registerResource("shared_resource", "test://resource", {}, async () => ({
  contents: [{ uri: "test://resource", text: "shared" }],
}));

const diagnostics = mcpServerTemplateDiagnostics(template);
assert.equal(diagnostics.tools, 1);
assert.equal(diagnostics.resources, 1);

const sessions = Array.from({ length: 128 }, () => createMcpSessionServerFromTemplate(template));
for (const session of sessions) {
  assert.equal(session._registeredTools, template._registeredTools, "all transports must reuse one heavyweight tool registry");
  assert.equal(session._registeredResources, template._registeredResources, "all transports must reuse one heavyweight resource registry");
  assert.equal(
    session.server._requestHandlers.get("tools/call"),
    template.server._requestHandlers.get("tools/call"),
    "tool dispatch closure must be shared instead of rebuilt per reconnect",
  );
  assert.notEqual(
    session.server._requestHandlers.get("initialize"),
    template.server._requestHandlers.get("initialize"),
    "initialization remains transport-local",
  );
}

const result = await sessions[0].server._requestHandlers.get("tools/call")({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "shared_tool", arguments: { value: "ok" } },
}, {
  signal: new AbortController().signal,
  requestId: 1,
  sendNotification: async () => {},
  sendRequest: async () => { throw new Error("not expected"); },
});
assert.equal(result.content[0].text, "ok");
assert.equal(calls, 1);

console.log(JSON.stringify({
  ok: true,
  gate: "mcp-server-template",
  sessions: sessions.length,
  sharedToolRegistry: true,
  sharedRequestHandlers: true,
  transportLocalInitialize: true,
}));
