import assert from "node:assert/strict";
import { ClassicStreamRecoveryGuard } from "./classic-stream-recovery-guard.js";

function snapshot({
  mode = "chat",
  conversationId = "conv-1",
  progressSignature = "partial:10",
  generating = true,
  composerTextChars = 0,
} = {}) {
  return { ok: true, mode, conversationId, progressSignature, generating, composerTextChars };
}

function harness({ initialNow = 10_000, streamStatus = "COMPLETE", discover = false } = {}) {
  let now = initialNow;
  let current = snapshot();
  let currentStreamStatus = streamStatus;
  const guard = new ClassicStreamRecoveryGuard({
    inspect: async () => current,
    checkStreamStatus: async () => ({ ok: true, status: currentStreamStatus }),
    listRuntimes: discover ? () => [{ runtimeKey: "main-03" }] : undefined,
    now: () => now,
    graceMs: 5_000,
    stalledGeneratingMs: 15_000,
    pollMs: 0,
  });
  return {
    guard,
    advance(ms) { now += ms; },
    setSnapshot(value) { current = snapshot(value); },
    setStreamStatus(value) { currentStreamStatus = value; },
  };
}

{
  const h = harness();
  const state = await h.guard.pollOnce();
  assert.equal(state.state, "idle", "no transport failure and no discovery must remain idle");
}

{
  const h = harness({ discover: true });
  let state = await h.guard.pollOnce();
  assert.equal(state.state, "watching-generating");
  h.advance(15_000);
  state = await h.guard.pollOnce();
  assert.equal(state.state, "renderer-stale-after-complete-stream");
  assert.equal(state.recoveryAction, "none");
  assert.equal(state.reason, "automatic-page-refresh-forbidden");
  state = await h.guard.pollOnce();
  assert.equal(state.state, "renderer-stale-latched", "same stale renderer must remain latched without any page action or retry loop");
}

{
  const h = harness({ discover: true });
  await h.guard.pollOnce();
  h.advance(10_000);
  h.setSnapshot({ progressSignature: "partial:11" });
  let state = await h.guard.pollOnce();
  assert.equal(state.state, "renderer-progressed");
  h.advance(15_000);
  state = await h.guard.pollOnce();
  assert.equal(state.state, "renderer-stale-after-complete-stream");
}

{
  const h = harness({ discover: true, streamStatus: "RUNNING" });
  await h.guard.pollOnce();
  h.advance(30_000);
  const state = await h.guard.pollOnce();
  assert.equal(state.state, "watching-server-running", "server RUNNING must never be reclassified as a stale COMPLETE renderer");
}

{
  const h = harness({ discover: true });
  await h.guard.pollOnce();
  h.advance(20_000);
  h.setSnapshot({ generating: false });
  const state = await h.guard.pollOnce();
  assert.equal(state.state, "renderer-idle");
}

{
  const h = harness({ discover: true });
  await h.guard.pollOnce();
  h.advance(20_000);
  h.setSnapshot({ composerTextChars: 12 });
  const state = await h.guard.pollOnce();
  assert.equal(state.state, "unsent-composer-protected");
}

{
  const h = harness();
  h.guard.noteTransportFailure({
    runtimeKey: "main-03",
    url: "https://chatgpt.com/backend-api/sentinel/ping",
    conversationId: "conv-1",
    progressSignature: "partial:10",
  });
  h.advance(10_000);
  const state = await h.guard.pollOnce();
  assert.equal(state.state, "idle", "unrelated network failures must not arm stream reconciliation");
}

{
  const h = harness();
  h.guard.noteTransportFailure({
    runtimeKey: "main-03",
    url: "https://chatgpt.com/backend-api/conversation/conv-1/stream_status",
    conversationId: "conv-1",
    progressSignature: "partial:10",
  });
  h.setSnapshot({ progressSignature: "partial:240" });
  h.advance(10_000);
  const state = await h.guard.pollOnce();
  assert.equal(state.state, "renderer-recovered");
}

{
  const h = harness();
  h.guard.noteTransportFailure({
    runtimeKey: "main-03",
    url: "https://chatgpt.com/backend-api/conversation/conv-1/stream_status",
    conversationId: "conv-1",
    progressSignature: "partial:10",
  });
  h.advance(5_000);
  let state = await h.guard.pollOnce();
  assert.equal(state.state, "renderer-stale-after-complete-stream");
  assert.equal(state.source, "transport-failure");
  assert.equal(state.recoveryAction, "none");
  state = await h.guard.pollOnce();
  assert.equal(state.state, "renderer-stale-latched");
}

{
  const h = harness({ streamStatus: "RUNNING" });
  h.guard.noteTransportFailure({
    runtimeKey: "main-03",
    url: "https://chatgpt.com/backend-api/conversation/conv-1/stream_status",
    conversationId: "conv-1",
    progressSignature: "partial:10",
  });
  h.advance(30_000);
  const state = await h.guard.pollOnce();
  assert.equal(state.state, "waiting-server");
}

{
  const h = harness();
  h.guard.noteTransportFailure({
    runtimeKey: "main-03",
    url: "https://chatgpt.com/backend-api/conversation/conv-1/stream_status",
    conversationId: "conv-1",
    progressSignature: "partial:10",
  });
  h.setSnapshot({ mode: "work" });
  h.advance(10_000);
  const state = await h.guard.pollOnce();
  assert.equal(state.state, "unsupported-mode");
}

{
  const h = harness();
  h.guard.noteTransportFailure({
    runtimeKey: "main-03",
    url: "https://chatgpt.com/backend-api/conversation/conv-1/stream_status",
    conversationId: "conv-1",
    progressSignature: "partial:10",
  });
  h.setSnapshot({ conversationId: "conv-2" });
  h.advance(10_000);
  const state = await h.guard.pollOnce();
  assert.equal(state.state, "conversation-changed");
}

console.log(JSON.stringify({
  ok: true,
  gate: "classic-stream-recovery-guard",
  protocolObservationOnly: true,
  chatModeOnly: true,
  serverCompleteRequired: true,
  automaticPageActionCount: 0,
}));
