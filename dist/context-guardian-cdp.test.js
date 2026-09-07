import assert from "node:assert/strict";
import {
  ClassicContextMetadataCdpAdapter,
  ClassicTurnIdentityCorrelator,
  parseNativeClassicModelResponse,
  parseClassicTurnRequest,
  estimateClassicConversationPayloadTokens,
  summarizeClassicConversationPayload,
  buildClassicHiddenRolloverBody,
  buildClassicUserTurnRolloverBody,
  rewriteHiddenRolloverPausedRequest,
  rewriteUserTurnRolloverPausedRequest,
} from "./context-guardian-cdp.js";
import { fingerprintClassicSession } from "./classic-conversation-authority.js";

{
  const parsed = parseClassicTurnRequest({
    url: "https://chatgpt.com/backend-api/f/conversation",
    method: "POST",
    headers: { authorization: "Bearer SECRET", cookie: "SECRET", "x-openai-session": "native-session-value" },
    postData: JSON.stringify({
      model: "gpt-5-6-thinking",
      thinking_effort: "max",
      conversation_id: "conv-12345678",
      parent_message_id: "parent-secret-ish-id",
      messages: [{ author: { role: "user" }, content: { content_type: "text", parts: ["private prompt body"] } }],
    }),
  });
  assert.equal(parsed.modelSlug, "gpt-5-6-thinking");
  assert.equal(parsed.thinkingEffort, "max");
  assert.equal(parsed.conversationId, "conv-12345678");
  assert.equal(parsed.sessionFingerprint, fingerprintClassicSession("native-session-value"));
  assert.ok(Number.isInteger(parsed.estimatedInputTokens));
  assert.ok(parsed.estimatedInputTokens > 0);
  assert.equal(JSON.stringify(parsed).includes("private prompt body"), false);
  assert.equal(JSON.stringify(parsed).includes("SECRET"), false);
  assert.equal(parseClassicTurnRequest({ url: "https://chatgpt.com/backend-api/other", method: "POST", postData: "{}" }), null);
}

{
  const correlator = new ClassicTurnIdentityCorrelator();
  assert.equal(correlator.noteExtraInfo({
    requestId: "request-extra-first",
    headers: { "x-openai-session": "session-extra-first" },
  }), null, "extra headers alone cannot establish conversation identity");
  const correlatedExtraFirst = correlator.noteRequest({
    requestId: "request-extra-first",
    request: {
      url: "https://chatgpt.com/backend-api/f/conversation",
      method: "POST",
      headers: {},
      postData: JSON.stringify({ model: "gpt-5-6-thinking", conversation_id: "conv-extra-first", messages: [] }),
    },
  });
  assert.deepEqual(correlatedExtraFirst, {
    requestId: "request-extra-first",
    conversationId: "conv-extra-first",
    sessionFingerprint: fingerprintClassicSession("session-extra-first"),
  });

  const correlatorRequestFirst = new ClassicTurnIdentityCorrelator();
  assert.equal(correlatorRequestFirst.noteRequest({
    requestId: "request-main-first",
    request: {
      url: "https://chatgpt.com/backend-api/f/conversation",
      method: "POST",
      headers: {},
      postData: JSON.stringify({ model: "gpt-5-6-thinking", conversation_id: "conv-main-first", messages: [] }),
    },
  }), null, "main event without final session headers must wait for ExtraInfo");
  const correlatedMainFirst = correlatorRequestFirst.noteExtraInfo({
    requestId: "request-main-first",
    headers: { "X-OpenAI-Session": "session-main-first" },
  });
  assert.deepEqual(correlatedMainFirst, {
    requestId: "request-main-first",
    conversationId: "conv-main-first",
    sessionFingerprint: fingerprintClassicSession("session-main-first"),
  });

  const direct = new ClassicTurnIdentityCorrelator().noteRequest({
    requestId: "request-direct",
    request: {
      url: "https://chatgpt.com/backend-api/f/conversation",
      method: "POST",
      headers: { "x-openai-session": "session-direct" },
      postData: JSON.stringify({ model: "gpt-5-6-thinking", conversation_id: "conv-direct", messages: [] }),
    },
  });
  assert.equal(direct.sessionFingerprint, fingerprintClassicSession("session-direct"));
  assert.equal(JSON.stringify(direct).includes("session-direct"), false, "correlator must never surface raw OpenAI session values");
}

{
  let now = 1_000;
  const correlator = new ClassicTurnIdentityCorrelator({ now: () => now, pendingTtlMs: 1_000, maxPending: 2 });
  correlator.noteRequest({
    requestId: "stale-one",
    request: {
      url: "https://chatgpt.com/backend-api/f/conversation",
      method: "POST",
      headers: {},
      postData: JSON.stringify({ model: "gpt-5-6-thinking", conversation_id: "conv-stale-one", messages: [] }),
    },
  });
  now += 100;
  correlator.noteRequest({
    requestId: "stale-two",
    request: {
      url: "https://chatgpt.com/backend-api/f/conversation",
      method: "POST",
      headers: {},
      postData: JSON.stringify({ model: "gpt-5-6-thinking", conversation_id: "conv-stale-two", messages: [] }),
    },
  });
  now += 100;
  correlator.noteRequest({
    requestId: "newest-three",
    request: {
      url: "https://chatgpt.com/backend-api/f/conversation",
      method: "POST",
      headers: {},
      postData: JSON.stringify({ model: "gpt-5-6-thinking", conversation_id: "conv-newest-three", messages: [] }),
    },
  });
  assert.equal(correlator.pendingSize, 2, "pending native request correlation must have a hard cap");
  assert.equal(correlator.forget("stale-one"), false, "oldest unmatched request must be evicted when the cap is exceeded");
  now += 1_500;
  correlator.prune();
  assert.equal(correlator.pendingSize, 0, "unmatched request ids must expire by TTL instead of accumulating forever");

  const complete = new ClassicTurnIdentityCorrelator({ now: () => now, pendingTtlMs: 1_000, maxPending: 2 });
  complete.noteRequest({
    requestId: "complete-after-bounds",
    request: {
      url: "https://chatgpt.com/backend-api/f/conversation",
      method: "POST",
      headers: {},
      postData: JSON.stringify({ model: "gpt-5-6-thinking", conversation_id: "conv-complete-after-bounds", messages: [] }),
    },
  });
  const resolved = complete.noteExtraInfo({ requestId: "complete-after-bounds", headers: { "x-openai-session": "session-complete-after-bounds" } });
  assert.equal(resolved.conversationId, "conv-complete-after-bounds");
  assert.equal(complete.pendingSize, 0, "successful native correlation must remove the pending entry immediately");
}

{
  const models = parseNativeClassicModelResponse(JSON.stringify({
    models: [
      { slug: "gpt-5-6-thinking", max_tokens: 262144, title: "GPT-5.6 Sol", reasoning_type: "reasoning", is_work_mode_model: false, enabled_tools: ["tools"] },
      { slug: "gpt-5-6-pro", max_tokens: 410000, title: "GPT-5.6 Pro", reasoning_type: "pro", is_work_mode_model: false, secret_internal_field: "do-not-persist" },
    ],
    account: { token: "secret" },
  }));
  assert.deepEqual(models, [
    { slug: "gpt-5-6-thinking", max_tokens: 262144, title: "GPT-5.6 Sol", reasoning_type: "reasoning", is_work_mode_model: false },
    { slug: "gpt-5-6-pro", max_tokens: 410000, title: "GPT-5.6 Pro", reasoning_type: "pro", is_work_mode_model: false },
  ]);
  assert.equal(JSON.stringify(models).includes("secret"), false);
}

{
  const estimated = estimateClassicConversationPayloadTokens({
    messages: [
      { author: { role: "user" }, content: { content_type: "text", parts: ["你好世界，呢段係中文 context。"] } },
      { author: { role: "assistant" }, content: { content_type: "text", parts: ["Use the current Goal and Plan state without repeating completed work."] } },
      { author: { role: "tool" }, content: { content_type: "text", parts: ["tool result 12345"] } },
    ],
  });
  assert.ok(Number.isInteger(estimated));
  assert.ok(estimated >= 30, "conversation snapshot estimator must remain conservative across CJK/tool content");

  const summarized = summarizeClassicConversationPayload({
    conversation_id: "conversation-summary",
    current_node: "node-assistant",
    title: "Selective continuation",
    default_model_slug: "gpt-5-6-pro",
    mapping: {
      root: { id: "root", parent: null, message: { author: { role: "system" }, content: { parts: [""] } } },
      "node-user": { id: "node-user", parent: "root", message: { author: { role: "user" }, content: { parts: ["Keep the active Goal and Plan frontier."] } } },
      "node-hidden": { id: "node-hidden", parent: "node-user", message: {
        author: { role: "tool" },
        content: { parts: ["bounded compact capsule"] },
        metadata: {
          is_visually_hidden_from_conversation: true,
          devspace_source_conversation_id: "conversation-source",
          devspace_source_boundary_message_id: "source-boundary",
          devspace_ui_continuity_key: "goal:goal-a",
          devspace_capsule_fingerprint: "a".repeat(64),
        },
      } },
      "node-assistant": { id: "node-assistant", parent: "node-hidden", message: { author: { role: "assistant" }, recipient: "all", content: { parts: ["Continue verified work only."] } } },
      orphan: { id: "orphan", parent: null, message: { author: { role: "user" }, content: { parts: ["ORPHAN MUST NOT ENTER CURRENT BRANCH"] } } },
    },
    context_truncation_continuation: {
      source_conversation_id: "conversation-source",
      boundary_message_id: "source-boundary",
      visible_from_message_id: "node-user",
    },
  });
  assert.equal(summarized.conversationId, "conversation-summary");
  assert.equal(summarized.branchMessageCount, 4);
  assert.equal(summarized.mappingCount, 5);
  assert.equal(summarized.visibleUsers, 1);
  assert.equal(summarized.visibleAssistants, 1);
  assert.equal(summarized.hiddenMessages, 1);
  assert.ok(summarized.estimatedTokens > 0);
  assert.deepEqual(summarized.recentVisibleMessages.map((item) => item.role), ["user", "assistant"]);
  assert.equal(JSON.stringify(summarized).includes("ORPHAN MUST NOT ENTER CURRENT BRANCH"), false);
  assert.equal(summarized.devspaceContinuity.uiContinuityKey, "goal:goal-a");
  assert.equal(summarized.contextTruncationContinuation.sourceConversationId, "conversation-source");

  const hidden = buildClassicHiddenRolloverBody({
    action: "next",
    model: "gpt-6-pro",
    conversation_id: "old-conversation",
    parent_message_id: "parent-1",
    messages: [{ author: { role: "user" }, content: { content_type: "text", parts: ["VISIBLE-ORIGINAL-SHOULD-DISAPPEAR"] }, metadata: { foo: "bar" } }],
    timezone: "Asia/Hong_Kong",
  }, {
    prompt: "DEVSPACE_COMPACT_CAPSULE hidden continuation",
    attribution: "devspace-ultra",
    messageId: "hidden-message-1",
  });
  assert.equal(hidden.conversation_id, undefined);
  assert.equal(hidden.model, "gpt-6-pro");
  assert.equal(hidden.timezone, "Asia/Hong_Kong");
  assert.equal(hidden.messages.length, 1);
  assert.equal(hidden.messages[0].author.role, "tool");
  assert.equal(hidden.messages[0].recipient, "all");
  assert.equal(hidden.messages[0].metadata.chatgpt_sdk_followup_prompt, true);
  assert.equal(hidden.messages[0].metadata.is_visually_hidden_from_conversation, true);
  assert.equal(JSON.stringify(hidden).includes("VISIBLE-ORIGINAL-SHOULD-DISAPPEAR"), false);
  assert.match(hidden.messages[0].content.parts[0], /DEVSPACE_COMPACT_CAPSULE/);

  const originalVisibleMessage = {
    id: "user-message-1",
    author: { role: "user" },
    content: { content_type: "text", parts: ["KEEP THIS EXACT VISIBLE USER MESSAGE"] },
    metadata: { user_context_message_data: { time_since_loaded: 2 } },
  };
  const userTurn = buildClassicUserTurnRolloverBody({
    action: "next",
    model: "gpt-5-6-thinking",
    conversation_id: "old-conversation",
    parent_message_id: "old-parent-message",
    messages: [originalVisibleMessage],
    timezone: "Asia/Hong_Kong",
  }, {
    capsulePrompt: "DEVSPACE_COMPACT_CAPSULE ordinary user turn",
    hiddenMessageId: "hidden-capsule-message",
    parentMessageId: "fresh-parent-message",
  });
  assert.equal(userTurn.conversation_id, undefined, "ordinary rollover must create a fresh conversation from the same user Send");
  assert.equal(userTurn.parent_message_id, "fresh-parent-message", "old conversation parent must never leak into the fresh conversation");
  assert.equal(userTurn.messages.length, 2);
  assert.equal(userTurn.messages[0].author.role, "tool");
  assert.equal(userTurn.messages[0].metadata.is_visually_hidden_from_conversation, true);
  assert.match(userTurn.messages[0].content.parts[0], /DEVSPACE_COMPACT_CAPSULE/);
  assert.deepEqual(userTurn.messages[1], originalVisibleMessage, "the actual user-submitted visible message must remain byte-structure equivalent after rollover rewrite");
  assert.equal(userTurn.messages[1].metadata?.is_visually_hidden_from_conversation, undefined);
  assert.equal(userTurn.timezone, "Asia/Hong_Kong");
}

{
  const calls = [];
  const client = {
    async call(method, params) {
      calls.push({ method, params });
      return {};
    },
  };
  const failed = await rewriteHiddenRolloverPausedRequest(client, {
    requestId: "request-bad",
    request: {
      url: "https://chatgpt.com/backend-api/f/conversation",
      method: "POST",
      postData: "{broken-json",
    },
  }, { prompt: "hidden capsule" });
  assert.equal(failed.handled, true);
  assert.equal(failed.modified, false);
  assert.match(failed.error, /JSON|Unexpected|position|property/i);
  assert.ok(calls.some((call) => call.method === "Fetch.failRequest" && call.params.requestId === "request-bad"));
  assert.equal(calls.some((call) => call.method === "Fetch.continueRequest" && call.params.requestId === "request-bad"), false, "hidden transform failure must never continue the visible original request");

  calls.length = 0;
  const rewritten = await rewriteHiddenRolloverPausedRequest(client, {
    requestId: "request-good",
    request: {
      url: "https://chatgpt.com/backend-api/f/conversation",
      method: "POST",
      postData: JSON.stringify({
        model: "gpt-6-pro",
        conversation_id: "visible-old",
        messages: [{ author: { role: "user" }, content: { content_type: "text", parts: ["VISIBLE-SHOULD-NOT-SEND"] } }],
      }),
    },
  }, { prompt: "hidden capsule" });
  assert.equal(rewritten.handled, true);
  assert.equal(rewritten.modified, true);
  const continued = calls.find((call) => call.method === "Fetch.continueRequest");
  assert.ok(continued?.params?.postData);
  const body = JSON.parse(Buffer.from(continued.params.postData, "base64").toString("utf8"));
  assert.equal(body.messages[0].author.role, "tool");
  assert.equal(body.messages[0].metadata.is_visually_hidden_from_conversation, true);
  assert.equal(JSON.stringify(body).includes("VISIBLE-SHOULD-NOT-SEND"), false);

  calls.length = 0;
  const userRewritten = await rewriteUserTurnRolloverPausedRequest(client, {
    requestId: "request-user-rollover",
    request: {
      url: "https://chatgpt.com/backend-api/f/conversation",
      method: "POST",
      postData: JSON.stringify({
        model: "gpt-5-6-thinking",
        conversation_id: "conversation-old-user",
        parent_message_id: "old-parent-user",
        messages: [{ id: "visible-user-1", author: { role: "user" }, content: { content_type: "text", parts: ["VISIBLE USER INTENT MUST SURVIVE"] } }],
      }),
    },
  }, {
    capsulePrompt: "DEVSPACE_COMPACT_CAPSULE safe user turn",
    hiddenMessageId: "hidden-user-rollover",
    parentMessageId: "fresh-parent-user",
  });
  assert.equal(userRewritten.handled, true);
  assert.equal(userRewritten.modified, true);
  assert.equal(userRewritten.oldConversationId, "conversation-old-user");
  const userContinued = calls.find((call) => call.method === "Fetch.continueRequest");
  const userBody = JSON.parse(Buffer.from(userContinued.params.postData, "base64").toString("utf8"));
  assert.equal(userBody.conversation_id, undefined);
  assert.equal(userBody.parent_message_id, "fresh-parent-user");
  assert.equal(userBody.messages[0].author.role, "tool");
  assert.equal(userBody.messages[1].author.role, "user");
  assert.equal(userBody.messages[1].content.parts[0], "VISIBLE USER INTENT MUST SURVIVE");

  calls.length = 0;
  const notExistingConversation = await rewriteUserTurnRolloverPausedRequest(client, {
    requestId: "request-new-chat",
    request: {
      url: "https://chatgpt.com/backend-api/f/conversation",
      method: "POST",
      postData: JSON.stringify({ model: "gpt-5-6-thinking", messages: [{ author: { role: "user" }, content: { parts: ["new chat"] } }] }),
    },
  }, { capsulePrompt: "capsule" });
  assert.equal(notExistingConversation.handled, false, "a user request already creating a new conversation must never be rewritten again");
}

{
  const events = { catalogs: [], turns: [], snapshots: [], userRollovers: [], arms: [], cancels: [], closed: [] };
  const sessionByPort = new Map();
  const adapter = new ClassicContextMetadataCdpAdapter({
    ports: [9721, 9732],
    connectionPollMs: 0,
    connectPort: async (port, handlers) => {
      const session = {
        runtimeKey: port === 9721 ? "main-01" : "main-02",
        port,
        connectedAt: "2026-09-05T03:00:00.000Z",
        lastTurnRequestObservedAt: port === 9721 ? "2026-09-05T03:01:00.000Z" : null,
        async refreshSnapshot() { return { runtimeKey: this.runtimeKey, observedTokens: port === 9721 ? 123456 : 234567, messageCount: 42 }; },
        async captureNativeSnapshot() { throw new Error("Context Guardian native snapshot reload is forbidden"); },
        async recentVisibleMessages() { return [{ role: "assistant", text: `recent-${port}` }]; },
        async armUserTurnRollover(input) { events.arms.push({ port, input }); return { armed: false, reason: "legacy-fresh-conversation-rollover-disabled" }; },
        async cancelUserTurnRollover() { events.cancels.push(port); return { cancelled: true }; },
        get userTurnRolloverArmed() { return events.arms.some((item) => item.port === port) && !events.cancels.includes(port); },
        async startHiddenRollover() { throw new Error("Legacy fresh-conversation rollover is disabled"); },
        async close() { events.closed.push(port); },
        emitCatalog(models) { return handlers.onCatalog?.({ runtimeKey: this.runtimeKey, port, models, observedAt: "2026-09-05T03:00:00.000Z" }); },
        emitTurn(modelSlug) { return handlers.onTurnRequest?.({ runtimeKey: this.runtimeKey, port, modelSlug, thinkingEffort: "max", conversationId: `conv-${port}`, observedAt: "2026-09-05T03:01:00.000Z" }); },
        emitSnapshot(modelSlug) { return handlers.onSnapshot?.({ runtimeKey: this.runtimeKey, port, modelSlug, conversationId: `conv-${port}`, mode: "chat", observedAt: "2026-09-05T03:02:00.000Z" }); },
      };
      sessionByPort.set(port, session);
      return session;
    },
  });
  adapter.setHandlers({
    onCatalog: (event) => events.catalogs.push(event),
    onTurnRequest: (event) => events.turns.push(event),
    onSnapshot: (event) => events.snapshots.push(event),
    onUserTurnRollover: (event) => events.userRollovers.push(event),
  });
  const status = await adapter.start({ schedule: false });
  assert.equal(status.connected, 2);
  const main01Status = status.runtimes.find((item) => item.runtimeKey === "main-01");
  const main02Status = status.runtimes.find((item) => item.runtimeKey === "main-02");
  assert.equal(main01Status.connectedAt, "2026-09-05T03:00:00.000Z");
  assert.equal(main01Status.lastTurnRequestObservedAt, "2026-09-05T03:01:00.000Z");
  assert.equal(main02Status.lastTurnRequestObservedAt, null);
  await sessionByPort.get(9721).emitCatalog([{ slug: "gpt-5-6-thinking", max_tokens: 262144 }]);
  await sessionByPort.get(9721).emitTurn("gpt-5-6-thinking");
  await sessionByPort.get(9732).emitSnapshot("gpt-5-6-pro");
  assert.equal(events.catalogs.length, 1);
  assert.equal(events.turns[0].modelSlug, "gpt-5-6-thinking");
  assert.equal(events.snapshots[0].runtimeKey, "main-02");
  assert.equal((await adapter.refreshSnapshot("main-01")).observedTokens, 123456);
  await assert.rejects(() => adapter.captureNativeSnapshot("main-01"), /reload is forbidden/i);
  assert.deepEqual(await adapter.recentVisibleMessages("main-02"), [{ role: "assistant", text: "recent-9732" }]);
  const armed = await adapter.armUserTurnRollover("main-01", { capsulePrompt: "capsule", oldConversationId: "conv-9721" });
  assert.equal(armed.armed, false);
  assert.equal(armed.reason, "legacy-fresh-conversation-rollover-disabled");
  await adapter.cancelUserTurnRollover("main-01");
  assert.equal(events.cancels.length, 1);
  await assert.rejects(() => adapter.startHiddenRollover("main-01", { prompt: "capsule" }), /fresh-conversation rollover is disabled/i);
  await adapter.close();
  assert.deepEqual(events.closed.sort((a, b) => a - b), [9721, 9732]);
}

const { estimateClassicInputTokens } = await import("./context-guardian-cdp.js");
assert.ok(estimateClassicInputTokens("你好世界，這是一段中文測試。abc 123") >= 12, "CJK estimator must remain conservative");
assert.ok(estimateClassicInputTokens("hello world this is an ascii test with several words") >= 8);

console.log(JSON.stringify({ ok: true, gate: "context-guardian-cdp", safeMetadataOnly: true, chatMainPorts: true, cjkAwareEstimator: true }));
