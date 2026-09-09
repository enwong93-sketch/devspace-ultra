import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod/v4";
import { installGoalToolProgress } from "./goal-tool-progress.js";

async function setup(t, observer = null) {
  const server = new McpServer({ name: "progress-test", version: "1" });
  const client = new Client({ name: "test-client", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const installed = installGoalToolProgress(server, {
    supervisor: observer,
    resolveConversation: async () => ({ conversationId: "conv-a", runtimeKey: "main-01" }),
  });
  const duplicate = installGoalToolProgress(server, {
    supervisor: observer,
    resolveConversation: async () => ({ conversationId: "conv-a", runtimeKey: "main-01" }),
  });
  assert.equal(installed, true);
  assert.equal(duplicate, false, "the compatibility boundary must install at most once per MCP server");
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  });
  return {
    server,
    client,
    async connect() {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
    },
  };
}

test("raw tool traffic never invokes visible-progress observers", async (t) => {
  const starts = [];
  const boundaries = [];
  const observer = {
    async noteToolStart(event) { starts.push(event); },
    async noteToolBoundary(event) { boundaries.push(event); },
  };
  const { server, client, connect } = await setup(t, observer);
  server.registerTool("real_work", { inputSchema: {} }, async () => ({
    content: [{ type: "text", text: "original result" }],
  }));
  await connect();
  const result = await client.callTool({ name: "real_work", arguments: {} });
  assert.equal(result.content[0].text, "original result");
  assert.equal(starts.length, 0);
  assert.equal(boundaries.length, 0);
});

test("MCP failure semantics remain owned by the SDK and handler", async (t) => {
  const observer = {
    async noteToolStart() { throw new Error("must not run"); },
    async noteToolBoundary() { throw new Error("must not run"); },
  };
  const { server, client, connect } = await setup(t, observer);
  server.registerTool("failed_result", { inputSchema: {} }, async () => ({
    isError: true,
    content: [{ type: "text", text: "expected test failure" }],
  }));
  server.registerTool("failed_throw", { inputSchema: {} }, async () => {
    throw new Error("expected test exception");
  });
  await connect();
  assert.equal((await client.callTool({ name: "failed_result", arguments: {} })).isError, true);
  assert.equal((await client.callTool({ name: "failed_throw", arguments: {} })).isError, true);
});

test("SDK output validation still rejects invalid structured results", async (t) => {
  const { server, client, connect } = await setup(t);
  server.registerTool("invalid_output", {
    inputSchema: {},
    outputSchema: { count: z.number() },
  }, async () => ({
    content: [{ type: "text", text: "invalid typed result" }],
    structuredContent: { count: "not-a-number" },
  }));
  await connect();
  const result = await client.callTool({ name: "invalid_output", arguments: {} });
  assert.equal(result.isError, true);
});

test("polling and runtime-scoped tools remain invisible to narration", async (t) => {
  const starts = [];
  const boundaries = [];
  const observer = {
    async noteToolStart(event) { starts.push(event); },
    async noteToolBoundary(event) { boundaries.push(event); },
  };
  const { server, client, connect } = await setup(t, observer);
  for (const name of ["devspace_goal_status", "devspace_plan_status", "runtime_scoped_work"]) {
    server.registerTool(name, { inputSchema: {} }, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
  }
  await connect();
  for (const name of ["devspace_goal_status", "devspace_plan_status", "runtime_scoped_work"]) {
    await client.callTool({ name, arguments: {} });
  }
  assert.equal(starts.length, 0);
  assert.equal(boundaries.length, 0);
});

console.log(JSON.stringify({
  ok: true,
  gate: "goal-tool-progress",
  compatibilityBoundaryOnly: true,
  automaticToolNarration: false,
  timerOrPollingNarration: false,
  sdkResultSemanticsPreserved: true,
}));
