import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GoalRunProgressSupervisor } from "./goal-run-progress-supervisor.js";
import { z } from "zod/v4";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function setup(t, customSupervisor) {
  const module = await import("./goal-tool-progress.js").catch(() => ({}));
  assert.equal(typeof module.installGoalToolProgress, "function", "actual tool-handler instrumentation must exist");
  const root = await mkdtemp(join(tmpdir(), "devspace-tool-progress-"));
  const goal = { id: "goal_a", conversationId: "conv-a", status: "active", objective: "Test actual results", round: 1, revision: 1 };
  const supervisor = customSupervisor || new GoalRunProgressSupervisor({ statePath: join(root, "progress.json"), goalRuntime: { async activeGoals() { return [goal]; } } });
  const server = new McpServer({ name: "progress-test", version: "1" });
  module.installGoalToolProgress(server, { supervisor, resolveConversation: async () => ({ conversationId: "conv-a" }) });
  const client = new Client({ name: "test-client", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); await supervisor.close?.(); await rm(root, { recursive: true, force: true }); });
  return { supervisor, server, client, async connect() { await server.connect(a); await client.connect(b); } };
}

test("actual pending handler is not recorded as completed until it returns", { timeout: 5000 }, async (t) => {
  const { supervisor, server, client, connect } = await setup(t);
  let release;
  let entered;
  const began = new Promise((r) => { entered = r; });
  const wait = new Promise((r) => { release = r; });
  server.registerTool("slow_work", { inputSchema: {} }, async () => { entered(); await wait; return { content: [{ type: "text", text: "done" }] }; });
  await connect();
  const pending = client.callTool({ name: "slow_work", arguments: {} });
  await began;
  try {
    assert.equal(supervisor.snapshot().active.stepCount, 0);
    assert.equal(supervisor.snapshot().active.inFlightCount, 1);
    assert.equal(supervisor.snapshot().active.inFlightToolName, "slow_work");
  } finally { release(); }
  await pending;
  assert.equal(supervisor.snapshot().active.stepCount, 1);
  assert.equal(supervisor.snapshot().active.inFlightCount, 0);
  assert.equal(supervisor.snapshot().active.lastSuccess, true);
});

test("MCP isError results and handler exceptions are recorded as failures", async (t) => {
  const { supervisor, server, client, connect } = await setup(t);
  server.registerTool("failed_result", { inputSchema: {} }, async () => ({ isError: true, content: [{ type: "text", text: "expected test failure" }] }));
  server.registerTool("failed_throw", { inputSchema: {} }, async () => { throw new Error("expected test exception"); });
  await connect();
  assert.equal((await client.callTool({ name: "failed_result", arguments: {} })).isError, true);
  assert.equal(supervisor.snapshot().active.lastSuccess, false);
  assert.equal((await client.callTool({ name: "failed_throw", arguments: {} })).isError, true);
  assert.equal(supervisor.snapshot().active.failedSteps, 2);
  assert.equal(supervisor.snapshot().active.successfulSteps, 0);
});

test("SDK output validation failure must not be reported as tool success", async (t) => {
  const { supervisor, server, client, connect } = await setup(t);
  server.registerTool("invalid_output", { inputSchema: {}, outputSchema: { count: z.number() } }, async () => ({ content: [{ type: "text", text: "invalid typed result" }], structuredContent: { count: "not-a-number" } }));
  await connect();
  const result = await client.callTool({ name: "invalid_output", arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(supervisor.snapshot().active.lastSuccess, false);
});

test("Goal/Plan polling does not generate fake work boundaries", async (t) => {
  const { supervisor, server, client, connect } = await setup(t);
  for (const name of ["devspace_goal_status", "devspace_plan_status"])
    server.registerTool(name, { inputSchema: {} }, async () => ({ content: [{ type: "text", text: "active" }] }));
  await supervisor.start();
  await connect();
  for (let i = 0; i < 20; i++) await client.callTool({ name: i % 2 ? "devspace_goal_status" : "devspace_plan_status", arguments: {} });
  assert.equal(supervisor.snapshot().active.stepCount, 0);
  assert.equal(supervisor.snapshot().active.lastBoundaryAt, null);
});

test("late identity lookup cannot resurrect a tool after the observation deadline", { timeout: 5000 }, async (t) => {
  const { supervisor, server, client, connect } = await setup(t);
  let release;
  const delayed = new Promise((r) => { release = r; });
  const originalGoals = supervisor.goalRuntime.activeGoals;
  supervisor.goalRuntime.activeGoals = async () => { await delayed; return originalGoals(); };
  let startPromise;
  const originalStart = supervisor.noteToolStart.bind(supervisor);
  supervisor.noteToolStart = (event) => { startPromise = originalStart(event); return startPromise; };
  server.registerTool("bounded_work", { inputSchema: {} }, async () => ({ content: [{ type: "text", text: "not blocked by progress" }] }));
  await connect();
  const result = await client.callTool({ name: "bounded_work", arguments: {} });
  assert.equal(result.content[0].text, "not blocked by progress");
  release();
  await startPromise;
  assert.equal(supervisor.snapshot().active?.inFlightCount || 0, 0, "a timed-out start observer must not create a ghost in-flight operation");
});

test("observer errors cannot replace a successful tool result or replay the tool", async (t) => {
  const failingObserver = { async noteToolStart() { throw new Error("observer unavailable"); }, async noteToolBoundary() { throw new Error("observer unavailable"); } };
  const { server, client, connect } = await setup(t, failingObserver);
  let calls = 0;
  server.registerTool("real_work", { inputSchema: {} }, async () => { calls++; return { content: [{ type: "text", text: "original result" }] }; });
  await connect();
  const result = await client.callTool({ name: "real_work", arguments: {} });
  assert.equal(result.content[0].text, "original result");
  assert.equal(calls, 1);
});
