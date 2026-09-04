import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { PlanRuntime } from "../dist/plan-runtime.js";
import { registerPlanTools } from "../dist/plan-tools.js";

const PLAN_CARD_URI = "ui://devspace/plan-card.html";
const cardHtml = await readFile(new URL("../dist/ui/plan-card.html", import.meta.url), "utf8");

async function connectStack(stateDir, label) {
  const runtime = new PlanRuntime({ stateDir });
  await runtime.ready;
  const server = new McpServer({
    name: `devspace-plan-live-${label}`,
    version: "0.5.0-dev",
  });
  registerAppResource(server, "DevSpace Plan Card", PLAN_CARD_URI, {
    description: "Persistent live progress card for a DevSpace execution plan.",
  }, async () => ({
    contents: [{
      uri: PLAN_CARD_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: cardHtml,
    }],
  }));
  registerPlanTools(server, runtime, { resourceUri: PLAN_CARD_URI });

  const client = new Client({
    name: `devspace-plan-live-client-${label}`,
    version: "0.5.0-dev",
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { runtime, server, client };
}

async function closeStack(stack) {
  await stack.client.close().catch(() => {});
  await stack.server.close().catch(() => {});
  await stack.runtime.close();
}

const root = await mkdtemp(join(tmpdir(), "devspace-plan-live-"));
let first;
let second;
try {
  first = await connectStack(root, "first");
  const listed = await first.client.listTools();
  const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));
  assert.deepEqual([...tools.keys()].sort(), [
    "devspace_plan_mount",
    "devspace_plan_start",
    "devspace_plan_status",
    "devspace_update_plan",
  ]);
  assert.equal(tools.get("devspace_plan_start")._meta.ui.resourceUri, PLAN_CARD_URI);
  assert.equal(tools.get("devspace_update_plan")._meta.ui.resourceUri, undefined);
  assert.equal(tools.get("devspace_plan_status")._meta.ui.resourceUri, undefined);

  const resource = await first.client.readResource({ uri: PLAN_CARD_URI });
  assert.equal(resource.contents[0].mimeType, RESOURCE_MIME_TYPE);
  assert.match(resource.contents[0].text, /devspace_plan_status/);

  const started = await first.client.callTool({
    name: "devspace_plan_start",
    arguments: {
      title: "Plan live gate",
      steps: [
        { text: "Create persistent plan", status: "in_progress" },
        { text: "Advance without remount", status: "pending" },
        { text: "Recover after restart", status: "pending" },
      ],
    },
  });
  assert.equal(started.isError, undefined);
  const plan1 = started.structuredContent.plan;
  assert.equal(plan1.revision, 1);

  const updated = await first.client.callTool({
    name: "devspace_update_plan",
    arguments: {
      planId: plan1.id,
      explanation: "Initial state persisted; advance to protocol update.",
      steps: [
        { ...plan1.steps[0], status: "completed" },
        { ...plan1.steps[1], status: "in_progress" },
        { ...plan1.steps[2], status: "pending" },
      ],
    },
  });
  const plan2 = updated.structuredContent.plan;
  assert.equal(plan2.revision, 2);
  assert.equal(plan2.steps[1].status, "in_progress");

  const status = await first.client.callTool({
    name: "devspace_plan_status",
    arguments: { planId: plan1.id },
  });
  assert.deepEqual(status.structuredContent.plan, plan2);

  await closeStack(first);
  first = null;

  second = await connectStack(root, "restart");
  const restored = await second.client.callTool({
    name: "devspace_plan_status",
    arguments: { planId: plan1.id },
  });
  assert.deepEqual(restored.structuredContent.plan, plan2);

  const mounted = await second.client.callTool({
    name: "devspace_plan_mount",
    arguments: { planId: plan1.id },
  });
  assert.deepEqual(mounted.structuredContent.plan, plan2);

  const completed = await second.client.callTool({
    name: "devspace_update_plan",
    arguments: {
      planId: plan1.id,
      explanation: "Restart recovery succeeded.",
      steps: [
        { ...plan2.steps[0], status: "completed" },
        { ...plan2.steps[1], status: "completed" },
        { ...plan2.steps[2], status: "in_progress" },
      ],
    },
  });
  const plan3 = completed.structuredContent.plan;
  const terminal = await second.client.callTool({
    name: "devspace_update_plan",
    arguments: {
      planId: plan1.id,
      explanation: "All protocol gates passed.",
      steps: plan3.steps.map((step) => ({ ...step, status: "completed" })),
    },
  });
  assert.equal(terminal.structuredContent.plan.status, "completed");
  assert.equal(terminal.structuredContent.plan.revision, 4);

  console.log(JSON.stringify({
    ok: true,
    gate: "plan-progress-live",
    tools: tools.size,
    resourceMimeType: RESOURCE_MIME_TYPE,
    restartRecoveredRevision: restored.structuredContent.plan.revision,
    terminalRevision: terminal.structuredContent.plan.revision,
  }));
} finally {
  if (first) await closeStack(first);
  if (second) await closeStack(second);
  await rm(root, { recursive: true, force: true });
}
