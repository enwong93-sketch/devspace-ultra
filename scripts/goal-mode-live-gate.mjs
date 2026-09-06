import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { GoalRuntime } from "../dist/goal-runtime.js";
import { registerGoalTools } from "../dist/goal-tools.js";

const GOAL_DOCK_URI = "ui://devspace/goal-dock.html";
const GOAL_RELAY_URI = "ui://devspace/goal-continuation-relay.html";
const dockHtml = await readFile(new URL("../dist/ui/goal-dock.html", import.meta.url), "utf8");
const relayHtml = await readFile(new URL("../dist/ui/goal-continuation-relay.html", import.meta.url), "utf8");

async function connectStack(stateDir, label) {
  const runtime = new GoalRuntime({ stateDir });
  await runtime.ready;
  const hostDispatches = [];
  const hostBridge = {
    async dispatch(request) {
      hostDispatches.push(request);
      return {
        ok: true,
        transport: "classic-raw-host-rpc",
        runtimeLabel: "Main-02",
        runtimePort: 9732,
        targetId: `goal-widget-${hostDispatches.length}`,
      };
    },
  };
  const server = new McpServer({
    name: `devspace-goal-live-${label}`,
    version: "0.5.0-dev",
  });
  registerAppResource(server, "DevSpace Goal Dock", GOAL_DOCK_URI, {
    description: "Persistent Goal Mode control and continuation dock.",
  }, async () => ({
    contents: [{
      uri: GOAL_DOCK_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: dockHtml,
    }],
  }));
  registerAppResource(server, "DevSpace Goal Continuation Relay", GOAL_RELAY_URI, {
    description: "Per-round hidden Goal continuation relay for Chat mode.",
  }, async () => ({
    contents: [{
      uri: GOAL_RELAY_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: relayHtml,
    }],
  }));
  registerGoalTools(server, runtime, {
    resourceUri: GOAL_DOCK_URI,
    relayResourceUri: GOAL_RELAY_URI,
    hostBridge,
  });

  const client = new Client({
    name: `devspace-goal-live-client-${label}`,
    version: "0.5.0-dev",
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { runtime, server, client, hostDispatches };
}

async function closeStack(stack) {
  await stack.client.close().catch(() => {});
  await stack.server.close().catch(() => {});
  await stack.runtime.close();
}

function goalFrom(result) {
  assert.equal(result.isError, undefined, result.content?.[0]?.text || "Goal tool failed");
  return result.structuredContent.goal;
}

const root = await mkdtemp(join(tmpdir(), "devspace-goal-live-"));
let first;
let second;
try {
  first = await connectStack(root, "first");

  const listed = await first.client.listTools();
  const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));
  assert.deepEqual([...tools.keys()].sort(), [
    "devspace_goal_blocked",
    "devspace_goal_complete",
    "devspace_goal_continuation",
    "devspace_goal_control",
    "devspace_goal_mount",
    "devspace_goal_round_begin",
    "devspace_goal_start",
    "devspace_goal_status",
    "devspace_goal_turn_report",
  ]);
  assert.deepEqual(tools.get("devspace_goal_continuation")._meta.ui.visibility, ["app"]);
  assert.equal(tools.get("devspace_goal_start")._meta.ui.resourceUri, GOAL_DOCK_URI);
  assert.equal(tools.get("devspace_goal_mount")._meta.ui.resourceUri, GOAL_DOCK_URI);
  assert.equal(tools.get("devspace_goal_turn_report")._meta.ui.resourceUri, GOAL_RELAY_URI);

  const resource = await first.client.readResource({ uri: GOAL_DOCK_URI });
  assert.equal(resource.contents[0].mimeType, RESOURCE_MIME_TYPE);
  assert.doesNotMatch(resource.contents[0].text, /sendFollowUpMessage/);
  assert.match(resource.contents[0].text, /devspace_goal_continuation/);
  assert.match(resource.contents[0].text, /action:\s*["']dispatch["']/);
  const relayResource = await first.client.readResource({ uri: GOAL_RELAY_URI });
  assert.equal(relayResource.contents[0].mimeType, RESOURCE_MIME_TYPE);
  assert.doesNotMatch(relayResource.contents[0].text, /sendFollowUpMessage/);
  assert.match(relayResource.contents[0].text, /dispatchStarted/);
  assert.match(relayResource.contents[0].text, /action:\s*["']dispatch["']/);

  const startedResult = await first.client.callTool({
    name: "devspace_goal_start",
    arguments: {
      objective: "Verify Goal Mode MCP protocol",
      successCriteria: [
        "Automatic continuation advances exactly one round",
        "Completion stops further continuation",
      ],
    },
  });
  const goal1 = goalFrom(startedResult);
  assert.equal(goal1.round, 1);
  assert.equal(goal1.roundState, "working");

  const report1Result = await first.client.callTool({
    name: "devspace_goal_turn_report",
    arguments: {
      goalId: goal1.id,
      summary: "Round one report is visible before continuation.",
      meaningfulProgress: true,
    },
  });
  const reported1 = goalFrom(report1Result);
  assert.equal(reported1.roundState, "reported");
  assert.equal(reported1.continuation.state, "pending");

  const dispatch1Result = await first.client.callTool({
    name: "devspace_goal_continuation",
    arguments: { goalId: goal1.id, action: "dispatch" },
  });
  assert.equal(dispatch1Result.isError, undefined);
  const dispatched1 = goalFrom(dispatch1Result);
  assert.equal(dispatched1.continuation.state, "dispatched");
  assert.equal(dispatch1Result.structuredContent.acknowledged, true);
  assert.equal(dispatch1Result.structuredContent.hostDispatch.transport, "classic-raw-host-rpc");
  assert.equal(first.hostDispatches.length, 1);
  const continuation1 = dispatched1.continuation.continuationId;
  assert.match(continuation1, /^continuation_/);
  assert.match(first.hostDispatches[0].prompt, /devspace_goal_round_begin/);

  const round2Result = await first.client.callTool({
    name: "devspace_goal_round_begin",
    arguments: { goalId: goal1.id, continuationId: continuation1 },
  });
  const round2 = goalFrom(round2Result);
  assert.equal(round2.round, 2);
  assert.equal(round2.roundState, "working");

  const duplicateRound2Result = await first.client.callTool({
    name: "devspace_goal_round_begin",
    arguments: { goalId: goal1.id, continuationId: continuation1 },
  });
  const duplicateRound2 = goalFrom(duplicateRound2Result);
  assert.equal(duplicateRound2.round, 2);
  assert.equal(duplicateRound2.revision, round2.revision);

  const report2Result = await first.client.callTool({
    name: "devspace_goal_turn_report",
    arguments: {
      goalId: goal1.id,
      summary: "Round two is ready, then pause Goal Mode.",
      meaningfulProgress: true,
    },
  });
  const reported2 = goalFrom(report2Result);
  const continuationBeforePause = reported2.continuation.continuationId;
  assert.equal(reported2.continuation.state, "pending");

  const pausedResult = await first.client.callTool({
    name: "devspace_goal_control",
    arguments: { goalId: goal1.id, action: "pause" },
  });
  const paused = goalFrom(pausedResult);
  assert.equal(paused.status, "paused");
  assert.equal(paused.continuation.state, "idle");

  const claimWhilePaused = await first.client.callTool({
    name: "devspace_goal_continuation",
    arguments: { goalId: goal1.id, action: "claim" },
  });
  assert.equal(claimWhilePaused.isError, true);

  const resumedResult = await first.client.callTool({
    name: "devspace_goal_control",
    arguments: { goalId: goal1.id, action: "resume" },
  });
  const resumed = goalFrom(resumedResult);
  assert.equal(resumed.status, "active");
  assert.equal(resumed.roundState, "reported");
  assert.equal(resumed.continuation.state, "pending");
  assert.notEqual(resumed.continuation.continuationId, continuationBeforePause);

  const dispatch2Result = await first.client.callTool({
    name: "devspace_goal_continuation",
    arguments: { goalId: goal1.id, action: "dispatch" },
  });
  assert.equal(dispatch2Result.isError, undefined);
  const dispatched2 = goalFrom(dispatch2Result);
  assert.equal(dispatched2.continuation.state, "dispatched");
  assert.equal(first.hostDispatches.length, 2);
  const continuation2 = dispatched2.continuation.continuationId;
  const round3Result = await first.client.callTool({
    name: "devspace_goal_round_begin",
    arguments: { goalId: goal1.id, continuationId: continuation2 },
  });
  const round3 = goalFrom(round3Result);
  assert.equal(round3.round, 3);
  assert.equal(round3.roundState, "working");

  const completionEvidence = round3.successCriteria.map((criterion) => ({
    criterionId: criterion.id,
    evidence: `Verified current MCP state for: ${criterion.text}`,
  }));
  const completeResult = await first.client.callTool({
    name: "devspace_goal_complete",
    arguments: { goalId: goal1.id, evidence: completionEvidence },
  });
  const completedWorking = goalFrom(completeResult);
  assert.equal(completedWorking.status, "completed");
  assert.equal(completedWorking.roundState, "working");

  const finalReportResult = await first.client.callTool({
    name: "devspace_goal_turn_report",
    arguments: {
      goalId: goal1.id,
      summary: "Final Goal report is visible and both criteria are verified.",
      meaningfulProgress: true,
    },
  });
  const terminal = goalFrom(finalReportResult);
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.roundState, "reported");
  assert.equal(terminal.continuation.state, "idle");
  assert.equal(terminal.round, 3);

  const noContinuation = await first.client.callTool({
    name: "devspace_goal_continuation",
    arguments: { goalId: goal1.id, action: "claim" },
  });
  assert.equal(noContinuation.isError, true);

  const mountedResult = await first.client.callTool({
    name: "devspace_goal_mount",
    arguments: { goalId: goal1.id },
  });
  assert.deepEqual(goalFrom(mountedResult), terminal);

  await closeStack(first);
  first = null;

  second = await connectStack(root, "restart");
  const restoredResult = await second.client.callTool({
    name: "devspace_goal_status",
    arguments: { goalId: goal1.id },
  });
  const restored = goalFrom(restoredResult);
  assert.deepEqual(restored, terminal);

  console.log(JSON.stringify({
    ok: true,
    gate: "goal-mode-live",
    tools: tools.size,
    resourceMimeType: RESOURCE_MIME_TYPE,
    relayResource: true,
    finalRound: restored.round,
    finalStatus: restored.status,
    restartRecoveredRevision: restored.revision,
    duplicateRoundBeginBlocked: true,
    pauseResumeContinuation: true,
  }));
} finally {
  if (first) await closeStack(first);
  if (second) await closeStack(second);
  await rm(root, { recursive: true, force: true });
}
