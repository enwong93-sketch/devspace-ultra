import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClassicConversationAuthorityRegistry, sessionFingerprintFromClassicRequest } from "./classic-conversation-authority.js";
import { ClassicActiveTurnRegistry } from "./classic-mcp-call-correlation.js";
import { ClassicTurnTransportTracker } from "./classic-turn-transport-observer.js";
import { McpConversationRequestContext } from "./mcp-conversation-request-context.js";
import { requestTraceCorrelationFingerprints } from "./request-trace-correlation.js";

const temp = await mkdtemp(join(tmpdir(), "devspace-direct-tool-correlation-"));
const authorityPath = join(temp, "authority.json");
let now = 10_000;
const activeTurns = new ClassicActiveTurnRegistry({
  now: () => now,
  activeTtlMs: 60 * 60_000,
  postTurnGraceMs: 1_000,
  waitTimeoutMs: 25,
});
const authority = new ClassicConversationAuthorityRegistry({ statePath: authorityPath });
await authority.load();
const requestContext = new McpConversationRequestContext();

function browserTurn({ requestId, runtimeKey, conversationId, session, traceId, datadogTraceId }) {
  const tracker = new ClassicTurnTransportTracker({
    now: () => now,
    onActiveTurn: (event) => activeTurns.noteTurn({ runtimeKey, ...event }),
  });
  tracker.noteRequest({
    requestId,
    request: {
      url: "https://chatgpt.com/backend-api/f/conversation",
      method: "POST",
      postData: JSON.stringify({
        conversation_id: conversationId,
        model: "gpt-test",
        local_function_names: ["local.continue_in_work"],
        messages: [],
      }),
      headers: {
        "x-openai-session": session,
        traceparent: `00-${traceId}-1111111111111111-01`,
      },
    },
  });
  tracker.noteExtraInfo({
    requestId,
    headers: {
      "x-openai-session": session,
      "x-datadog-trace-id": datadogTraceId,
    },
  });
  tracker.noteResponse({
    requestId,
    response: { url: "https://chatgpt.com/backend-api/f/conversation", status: 200 },
  });
  tracker.noteFinished({ requestId });
  return tracker;
}

const traceA = "0123456789abcdef0000000000000065";
const traceB = "0123456789abcdef0000000000000066";
const browserSessionA = "browser-statsig-session-a";
const browserSessionB = "browser-statsig-session-b";
const directSessionA = "server-side-openai-session-a";
const directSessionB = "server-side-openai-session-b";

browserTurn({
  requestId: "turn-a",
  runtimeKey: "main-01",
  conversationId: "conversation-direct-a",
  session: browserSessionA,
  traceId: traceA,
  datadogTraceId: "101",
});
now += 5;
browserTurn({
  requestId: "turn-b",
  runtimeKey: "main-02",
  conversationId: "conversation-direct-b",
  session: browserSessionB,
  traceId: traceB,
  datadogTraceId: "102",
});

const directHeadersA = {
  "x-openai-session": directSessionA,
  traceparent: `00-${traceA}-2222222222222222-01`,
  "x-datadog-trace-id": "101",
};
const directHeadersB = {
  "x-openai-session": directSessionB,
  traceparent: `00-${traceB}-3333333333333333-01`,
  "x-datadog-trace-id": "102",
};
const directFingerprintA = sessionFingerprintFromClassicRequest({ headers: directHeadersA });
const directFingerprintB = sessionFingerprintFromClassicRequest({ headers: directHeadersB });
const traceKeysA = requestTraceCorrelationFingerprints(directHeadersA);
const traceKeysB = requestTraceCorrelationFingerprints(directHeadersB);

for (const toolName of ["blender_runtime", "blender_mcp", "devspace_progress_report"]) {
  const identity = activeTurns.resolveGatewayCall({
    toolName,
    traceCorrelationFingerprints: traceKeysA,
    sessionFingerprintHint: directFingerprintA,
  });
  assert.equal(identity?.conversationId, "conversation-direct-a", `${toolName} must resolve through the exact request trace`);
  assert.equal(identity?.runtimeKey, "main-01");
  assert.match(identity?.source || "", /request-trace-correlation$/);
}

const exactA = activeTurns.resolveGatewayCall({
  toolName: "blender_runtime",
  traceCorrelationFingerprints: traceKeysA,
  sessionFingerprintHint: directFingerprintA,
});
await authority.observeNativeTurn({
  sessionFingerprint: directFingerprintA,
  conversationId: exactA.conversationId,
  runtimeKey: exactA.runtimeKey,
  observedAt: new Date(now).toISOString(),
  authoritativeCurrent: true,
});
const exactB = activeTurns.resolveGatewayCall({
  toolName: "blender_runtime",
  traceCorrelationFingerprints: traceKeysB,
  sessionFingerprintHint: directFingerprintB,
});
await authority.observeNativeTurn({
  sessionFingerprint: directFingerprintB,
  conversationId: exactB.conversationId,
  runtimeKey: exactB.runtimeKey,
  observedAt: new Date(now).toISOString(),
  authoritativeCurrent: true,
});
assert.equal(authority.resolveFingerprint(directFingerprintA)?.conversationId, "conversation-direct-a");
assert.equal(authority.resolveFingerprint(directFingerprintB)?.conversationId, "conversation-direct-b");

await requestContext.run({
  capabilityAuthority: authority.resolveFingerprint(directFingerprintA),
  sessionFingerprint: directFingerprintA,
  mcpSessionId: "backend-session-a",
}, async () => {
  await Promise.resolve();
  assert.equal(requestContext.current()?.capabilityAuthority?.conversationId, "conversation-direct-a");
  assert.equal(requestContext.current()?.progressAuthority, null);
});
await requestContext.run({
  progressAuthority: {
    conversationId: "conversation-direct-a",
    sessionFingerprint: directFingerprintA,
    authorityDomain: "progress",
    ephemeral: true,
  },
  sessionFingerprint: directFingerprintA,
}, async () => {
  assert.equal(requestContext.current()?.progressAuthority?.conversationId, "conversation-direct-a");
  assert.equal(requestContext.current()?.capabilityAuthority, null, "progress authority must not become Blender/capability authority");
});
assert.equal(requestContext.current(), null, "request authority must not leak after the MCP request completes");

assert.equal(
  activeTurns.resolveGatewayCall({
    toolName: "blender_runtime",
    traceCorrelationFingerprints: traceKeysA,
    sessionFingerprintHint: directFingerprintB,
  })?.conversationId,
  "conversation-direct-a",
  "the exact request trace, not a reused/mismatched session hint, owns the direct call",
);
assert.equal(
  activeTurns.resolveGatewayCall({
    toolName: "blender_runtime",
    traceCorrelationFingerprints: traceKeysB,
    sessionFingerprintHint: directFingerprintA,
  })?.conversationId,
  "conversation-direct-b",
);

const ambiguous = new ClassicActiveTurnRegistry({ now: () => now });
for (const [runtimeKey, conversationId, requestId] of [
  ["main-01", "conversation-ambiguous-a", "ambiguous-a"],
  ["main-02", "conversation-ambiguous-b", "ambiguous-b"],
]) {
  ambiguous.noteTurn({
    kind: "started",
    runtimeKey,
    conversationId,
    requestId,
    traceCorrelationFingerprints: traceKeysA,
    localFunctionNames: ["local.continue_in_work"],
    observedAtMs: now,
  });
}
assert.equal(ambiguous.resolveGatewayCall({
  toolName: "devspace_progress_report",
  traceCorrelationFingerprints: traceKeysA,
}), null, "a trace observed in two conversations must fail closed");
assert.equal(ambiguous.diagnostics().ambiguousMatches > 0, true);

const unmatched = await activeTurns.waitForIdentity({
  toolName: "devspace_progress_report",
  traceCorrelationFingerprints: ["f".repeat(64)],
  sessionFingerprintHint: directFingerprintA,
  timeoutMs: 25,
});
assert.equal(unmatched, null);
assert.equal(activeTurns.diagnostics().waiters, 0, "an unresolved direct call must leave no zombie waiter");
assert.equal(activeTurns.diagnostics().timedOutWaiters > 0, true);

assert.equal(activeTurns.completeConversation("conversation-direct-a"), 1);
assert.equal(activeTurns.resolveGatewayCall({
  toolName: "blender_runtime",
  traceCorrelationFingerprints: traceKeysA,
}), null);
assert.equal(activeTurns.resolveGatewayCall({
  toolName: "blender_runtime",
  traceCorrelationFingerprints: traceKeysB,
})?.conversationId, "conversation-direct-b", "completion cleanup must stay conversation-scoped");

const persisted = await readFile(authorityPath, "utf8");
for (const rawSecret of [traceA, traceB, "101", "102", browserSessionA, browserSessionB, directSessionA, directSessionB]) {
  assert.equal(persisted.includes(rawSecret), false, `authority state must not persist raw correlation secret ${rawSecret}`);
}

await rm(temp, { recursive: true, force: true });
console.log(JSON.stringify({
  ok: true,
  gate: "direct-tool-conversation-correlation",
  directTools: ["blender_runtime", "blender_mcp", "devspace_progress_report"],
  exactDistributedTraceAuthority: true,
  browserAndDirectSessionsMayDiffer: true,
  requestContextIsolation: true,
  progressCapabilityDomainsSeparated: true,
  twoConversationIsolation: true,
  ambiguityFailsClosed: true,
  boundedWaiterCleanup: true,
  normalCompletionCleanup: true,
  rawCorrelationSecretsPersisted: false,
}));
