import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { prioritizeMcpTools } from "./mcp-tool-priority.js";

const server = new McpServer({ name: "priority-test", version: "1" });
for (let index = 0; index < 80; index += 1) {
  server.registerTool(`fixture_${String(index).padStart(3, "0")}`, { inputSchema: { value: z.string().optional() } }, async () => ({ content: [{ type: "text", text: "ok" }] }));
}
for (const name of ["blender_mcp", "devspace_progress_report", "blender_runtime", "devspace_route", "tool_search"]) {
  server.registerTool(name, { inputSchema: {} }, async () => ({ content: [{ type: "text", text: "ok" }] }));
}
const result = prioritizeMcpTools(server);
assert.equal(result.ok, true);
assert.equal(result.toolCount, 85);
const expectedFirst = [
  "devspace_progress_report",
  "blender_runtime",
  "blender_mcp",
  "devspace_route",
  "tool_search",
];
assert.deepEqual(result.firstTools.slice(0, 5), expectedFirst);
assert.ok(result.firstTools.indexOf("blender_mcp") < 51);
assert.ok(result.firstTools.indexOf("devspace_progress_report") < 51);

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "priority-client", version: "1" });
await server.connect(serverTransport);
await client.connect(clientTransport);
const listed = await client.listTools();
const liveNames = listed.tools.map((tool) => tool.name);
assert.deepEqual(liveNames.slice(0, 5), expectedFirst);
assert.equal(liveNames.length, 85);
await client.close();
await server.close();

console.log(JSON.stringify({
  ok: true,
  gate: "mcp-tool-priority",
  ...result,
  realMcpToolsListOrder: liveNames.slice(0, 10),
}));
